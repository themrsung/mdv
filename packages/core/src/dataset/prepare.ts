/**
 * Stage 4 (Prepare) for datasets: from declarations to tables (SPEC 6.3, 18).
 *
 * Preparation walks the DAG in dependency order and gives every node one of two
 * fates: a `ready` state with a table, or a non-ready state with a stated
 * reason. Nothing in between — a block that finds its dataset unready renders
 * the placeholder for that state rather than an empty chart (SPEC 6.4).
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { DiagCollector } from '../data/diag.js';
import { emptyTable } from '../data/build.js';
import type { FormatContext } from '../data/format.js';
import type { EffectiveLimits } from '../data/limits.js';
import { readTable, type SectionOptions } from '../data/parse-section.js';
import type { TimeZoneSpec } from '../data/temporal.js';
import { applyPipeline, type TransformContext } from '../transform/index.js';
import type { DataRegistry, DatasetNode, Table } from '../types/data.js';
import { buildGraph, describeCycle } from './graph.js';
import { parseReference } from './reference.js';
import {
  applyProjection,
  createRegistry,
  createTableCache,
  missingProjection,
  tableKey,
  type TableCache,
} from './registry.js';

/** Everything preparation needs that is not on the node itself. */
export interface PrepareOptions {
  /** Document timezone for zone-less temporal values (SPEC 6.6). */
  timezone: TimeZoneSpec;
  /** `now()` in expressions (SPEC 6.8.2). */
  buildTime: Date;
  limits: EffectiveLimits;
  /** Formatting context for `format()` and for pivot column names (SPEC 6.9). */
  format: FormatContext;
  /** The level in force; a Level 2 format below it is still read, with a note. */
  level?: ConformanceLevel | undefined;
  /** `nullValues:` — replaces the SPEC 6.5 default list when present. */
  nullValues?: readonly string[] | undefined;
  /**
   * Reader options that {@link DatasetNode} has no field for — `delimiter:`,
   * `header:` and `columns:` (SPEC 6.2.2, 6.2.3) — keyed by dataset id.
   */
  sectionOptions?: Readonly<Record<string, SectionOptions>> | undefined;
}

/** The result of preparing one document's datasets. */
export interface PreparedDatasets {
  /** The nodes, copied and completed, in declaration order. */
  nodes: readonly DatasetNode[];
  registry: DataRegistry;
  /**
   * The memo every block-level pipeline should run through, pre-seeded with the
   * datasets' own tables (SPEC 6.7).
   */
  cache: TableCache;
}

/**
 * Prepare every dataset.
 *
 * The input nodes are never mutated: each is copied first, so a caller may hold
 * on to the declaration list and resolve the same document twice without the
 * second run seeing the first run's tables (SPEC 17.3 invariant 4).
 */
export function prepareDatasets(
  input: readonly DatasetNode[],
  options: PrepareOptions,
  diag: DiagCollector,
): PreparedDatasets {
  const nodes = input.map((node) => ({ ...node }));
  const byId = new Map<string, DatasetNode>();
  for (const node of nodes) byId.set(node.id, node);

  const graph = buildGraph(nodes);
  const cache = createTableCache();

  for (const cycle of graph.cycles) {
    const head = byId.get(cycle[0] as string);
    const scoped = head?.range === undefined ? diag : diag.withRange(head.range);
    scoped.emit('MDV2141', {
      message: `Dataset cycle: ${describeCycle(cycle)}`,
      detail: 'A dataset may derive from another, but the graph must stay acyclic (SPEC 6.3).',
    });
  }

  /** The table behind `@id`, for `join` and for `from`. */
  const lookup = (reference: string): Table | undefined => {
    const parsed = parseReference(reference);
    if (parsed === undefined) return undefined;
    const node = byId.get(parsed.id);
    if (node === undefined || node.state !== 'ready' || node.table === undefined) return undefined;
    return applyProjection(node.table, parsed.projection);
  };

  for (const id of graph.order) {
    const node = byId.get(id);
    /* c8 ignore next -- `graph.order` only contains ids from `nodes`. */
    if (node === undefined) continue;
    prepareNode(node, { options, diag, lookup, cyclic: graph.cyclic.has(id) }, cache);
  }

  return { nodes, registry: createRegistry(nodes), cache };
}

/**
 * The cache key of a dataset's own table — the same key a block asking for
 * `@id` with no projection and no pipeline computes, so the two share one entry
 * instead of evaluating the dataset twice (SPEC 6.7).
 */
function ownKey(id: string): string {
  return tableKey(id, undefined, undefined);
}

interface NodeContext {
  options: PrepareOptions;
  diag: DiagCollector;
  lookup: (reference: string) => Table | undefined;
  cyclic: boolean;
}

function prepareNode(node: DatasetNode, ctx: NodeContext, cache: TableCache): void {
  const diag = node.range === undefined ? ctx.diag : ctx.diag.withRange(node.range);

  if (ctx.cyclic) {
    // The cycle itself was reported once, for the whole loop; every node on it
    // simply fails, so a chart pointing at any member shows a stated reason.
    node.state = 'failed';
    node.stateReason = 'MDV2141';
    return;
  }

  if (node.from !== undefined) {
    const base = derive(node, ctx, diag);
    if (base === undefined) return;
    node.table = cache.get(ownKey(node.id), () => transform(base, node, ctx, diag));
    node.state = 'ready';
    return;
  }

  if (node.raw !== undefined) {
    const parsed = parseRaw(node, ctx, diag);
    node.table = cache.get(ownKey(node.id), () => transform(parsed, node, ctx, diag));
    node.state = 'ready';
    return;
  }

  if (node.src !== undefined) {
    // An external source with no content is not this stage's failure: the fetch
    // stage either has not run (a synchronous resolve) or has already reported
    // why. Leave the state it set, so the placeholder can name it.
    if (node.state === 'declared') {
      node.state = 'blocked';
      node.stateReason = node.stateReason ?? 'MDV4002';
    }
    return;
  }

  diag.emit('MDV2100', {
    message: `Dataset \`${node.id}\` has no data`,
    detail: 'Declare a data section, a `from:` dataset, or a `src:` (SPEC 6.3).',
  });
  node.table = emptyTable();
  node.state = 'ready';
}

/** The base table of a `from:` dataset, or `undefined` when it cannot be had. */
function derive(node: DatasetNode, ctx: NodeContext, diag: DiagCollector): Table | undefined {
  const reference = node.from as string;
  const parsed = parseReference(reference);
  if (parsed === undefined) {
    diag.emit('MDV2142', {
      message: `\`from: ${reference}\` is not a dataset reference`,
      detail: 'Write `from: "@sales"` (SPEC 6.3).',
    });
    node.state = 'failed';
    node.stateReason = 'MDV2142';
    return undefined;
  }

  // Looked up twice on purpose: the unprojected table is what a missing-field
  // report must be measured against, and `lookup` is a map read, not work.
  const unprojected = ctx.lookup(`@${parsed.id}`);
  const base = ctx.lookup(reference);
  if (base === undefined || unprojected === undefined) {
    diag.emit('MDV2142', {
      message: `Dataset \`${node.id}\` derives from \`@${parsed.id}\`, which is not available`,
      detail: 'The referenced dataset is undeclared, still loading, or failed (SPEC 6.3).',
    });
    node.state = 'failed';
    node.stateReason = 'MDV2142';
    return undefined;
  }

  if (parsed.projection !== undefined) {
    const missing = missingProjection(unprojected as Table, parsed.projection);
    if (missing.length > 0) {
      diag.emit('MDV2111', {
        message: `\`from: ${reference}\` projects unknown field${
          missing.length > 1 ? 's' : ''
        } ${missing.map((name) => `\`${name}\``).join(', ')}`,
        detail: 'The remaining projected fields were used.',
      });
    }
  }

  return base;
}

/** Read an inline data section into a table (SPEC 6.2). */
function parseRaw(node: DatasetNode, ctx: NodeContext, diag: DiagCollector): Table {
  const { options } = ctx;
  const extra = options.sectionOptions?.[node.id] ?? {};
  const section: SectionOptions = {
    ...extra,
    ...(node.format !== undefined ? { format: node.format } : {}),
    ...(options.level !== undefined ? { level: options.level } : {}),
    ...(extra.maxFlattenDepth === undefined
      ? { maxFlattenDepth: options.limits.maxFlattenDepth }
      : {}),
  };

  const { table } = readTable(
    node.raw as string,
    section,
    {
      timezone: options.timezone,
      limits: options.limits,
      ...(node.fields !== undefined ? { fields: node.fields } : {}),
      ...(options.nullValues !== undefined ? { nullValues: options.nullValues } : {}),
    },
    diag,
  );
  return table;
}

/** Apply the dataset's own pipeline, if it has one. */
function transform(table: Table, node: DatasetNode, ctx: NodeContext, diag: DiagCollector): Table {
  if (node.transform === undefined || node.transform.length === 0) return table;
  return applyPipeline(table, node.transform, transformContext(ctx, diag));
}

/** The context a pipeline runs under, wired to this document's datasets. */
export function transformContext(
  ctx: { options: PrepareOptions; lookup: (reference: string) => Table | undefined },
  diag: DiagCollector,
): TransformContext {
  return {
    diag,
    zone: ctx.options.timezone,
    buildTime: ctx.options.buildTime,
    format: ctx.options.format,
    limits: ctx.options.limits,
    lookup: ctx.lookup,
  };
}

/**
 * The dataset layer (SPEC 6.3, 6.4): declarations, the DAG, preparation, and
 * the registry a resolved document carries.
 *
 * The public entry point for a block is {@link resolveTableRef}: give it what
 * the block asked for and it returns a table plus the reference that produced
 * it, memoised, or an empty table plus a stated reason. A block never sees
 * `undefined` — SPEC 14.1 principle 2 is that a failure is visible, not absent.
 */

import type { DiagCollector } from '../data/diag.js';
import { emptyTable } from '../data/build.js';
import { applyPipeline } from '../transform/index.js';
import type {
  DataRegistry,
  DatasetNode,
  DatasetState,
  Table,
  TableRef,
  TransformPipeline,
} from '../types/data.js';
import type { PrepareOptions } from './prepare.js';
import { transformContext } from './prepare.js';
import { parseReference } from './reference.js';
import {
  applyProjection,
  createTableRef,
  missingProjection,
  tableKey,
  type TableCache,
} from './registry.js';

export { buildGraph, describeCycle, dependenciesOf, type DatasetGraph } from './graph.js';
export {
  DATASET_BLOCK,
  declareDatasets,
  readDeclaration,
  readFields,
  readPipeline,
  type DatasetDeclaration,
} from './declare.js';
export { locateDatasets, type DatasetSite } from './locate.js';
export {
  prepareDatasets,
  transformContext,
  type PrepareOptions,
  type PreparedDatasets,
} from './prepare.js';
export {
  DATASET_ID_PATTERN,
  SYNTHETIC_ID_PATTERN,
  formatReference,
  isDatasetId,
  isReference,
  isUsableId,
  parseReference,
  type DatasetReference,
} from './reference.js';
export {
  applyProjection,
  createRegistry,
  createTableCache,
  createTableRef,
  emptyRegistry,
  missingProjection,
  tableKey,
  type TableCache,
} from './registry.js';

/** What a block asked for: a reference, plus its own pipeline. */
export interface TableRequest {
  /** The `data:` value, e.g. `"@sales[date, revenue]"`. */
  reference: string;
  /** The block's own `transform:`, applied on top of the dataset's. */
  transform?: TransformPipeline | undefined;
}

/** The outcome of resolving one block's data. */
export interface ResolvedTable {
  /** Always present and always well-formed, empty in the failure cases. */
  table: Table;
  ref: TableRef;
  /** The dataset's state, or `'failed'` when the reference itself was bad. */
  state: DatasetState;
  /** The Appendix C code behind a non-`ready` state, for the placeholder. */
  reason?: string;
}

/**
 * Resolve a block's `data: "@id[…]"` against a prepared registry.
 *
 * Every pipeline evaluation goes through `cache`, keyed by
 * (dataset identity, projection, pipeline) — that is what makes N charts over
 * one dataset cost one evaluation (SPEC 6.7).
 */
export function resolveTableRef(
  request: TableRequest,
  registry: DataRegistry,
  cache: TableCache,
  options: PrepareOptions,
  diag: DiagCollector,
): ResolvedTable {
  const parsed = parseReference(request.reference);
  if (parsed === undefined) {
    diag.emit('MDV2142', {
      message: `\`${request.reference}\` is not a dataset reference`,
      detail: 'Write `data: "@sales"`, optionally with a projection (SPEC 6.3).',
    });
    return {
      table: emptyTable(),
      ref: { datasetId: request.reference, key: `!${request.reference}` },
      state: 'failed',
      reason: 'MDV2142',
    };
  }

  const ref = createTableRef(parsed, request.transform);
  const node = registry.get(parsed.id);

  if (node === undefined) {
    diag.emit('MDV2142', {
      message: `Unresolved dataset reference \`@${parsed.id}\``,
      detail: describeAvailable(registry),
    });
    return { table: emptyTable(), ref, state: 'failed', reason: 'MDV2142' };
  }

  if (node.state !== 'ready' || node.table === undefined) {
    // Not an error here: the dataset already reported why, and the block's job
    // is to show the placeholder for the state it is in (SPEC 6.4).
    return {
      table: emptyTable(),
      ref,
      state: node.state,
      ...(node.stateReason !== undefined ? { reason: node.stateReason } : {}),
    };
  }

  const missing = missingProjection(node.table, parsed.projection);
  if (missing.length > 0) {
    diag.emit('MDV2111', {
      message: `\`@${parsed.id}\` has no field${missing.length > 1 ? 's' : ''} ${missing
        .map((name) => `\`${name}\``)
        .join(', ')}`,
      detail: `The dataset has ${describeFields(node.table)}. Names are case-sensitive (SPEC 6.1.2).`,
    });
  }

  const source = node.table;
  const table = cache.get(ref.key, () => {
    const projected = applyProjection(source, parsed.projection);
    if (request.transform === undefined || request.transform.length === 0) return projected;
    return applyPipeline(
      projected,
      request.transform,
      transformContext({ options, lookup: lookupIn(registry) }, diag),
    );
  });

  return { table, ref, state: 'ready' };
}

/**
 * Resolve `@id` inside a `join` step against a registry.
 *
 * Exported because a block-level pipeline needs the same lookup the dataset
 * layer uses, and duplicating it is how the two would drift apart.
 */
export function lookupIn(registry: DataRegistry): (reference: string) => Table | undefined {
  return (reference: string): Table | undefined => {
    const parsed = parseReference(reference);
    if (parsed === undefined) return undefined;
    const node = registry.get(parsed.id);
    if (node === undefined || node.state !== 'ready' || node.table === undefined) return undefined;
    return applyProjection(node.table, parsed.projection);
  };
}

/**
 * A `TableRef` for a block that carried its data inline (`"#block-3"`).
 *
 * Inline data is registered as a synthetic dataset so that one code path
 * prepares every table, and so `mdv data` can name where a chart's rows came
 * from even when nobody declared a dataset.
 */
export function inlineDatasetId(blockIndex: number): string {
  return `#block-${blockIndex}`;
}

/** The memo key for a table that is used exactly once, by one block. */
export function inlineTableKey(blockIndex: number, pipeline?: TransformPipeline): string {
  return tableKey(inlineDatasetId(blockIndex), undefined, pipeline);
}

function describeAvailable(registry: DataRegistry): string {
  const ids = registry.list().map((node: DatasetNode) => `\`@${node.id}\``);
  if (ids.length === 0) return 'The document declares no datasets (SPEC 6.3).';
  return `Declared datasets are ${ids.join(', ')}.`;
}

function describeFields(table: Table): string {
  if (table.fields.length === 0) return 'no fields';
  return table.fields.map((field) => `\`${field.name}\``).join(', ');
}

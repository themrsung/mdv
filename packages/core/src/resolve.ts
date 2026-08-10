/**
 * Stage 2 (Resolve) and stage 4 (Prepare) for a document's **data** — SPEC 18.
 *
 * This module turns a parsed AST into the dataset graph a document renders
 * from: it collects every declaration (front matter, `dataset` blocks, inline
 * sections), loads what `src:` points at through the injected capabilities,
 * prepares each table, and hands every visual block a {@link TableRef} plus the
 * table behind it.
 *
 * Two boundaries are deliberate:
 *
 * - **Resolve is the only async stage** (SPEC 18). Everything below it — parsing
 *   a section, running a pipeline, projecting a reference — is synchronous and
 *   pure, so {@link resolveDocumentDataSync} is the same code path minus the
 *   fetch, and a document without `src:` produces identical output either way.
 * - **Core never touches the network or the clock** (SPEC 17.3 invariant 1).
 *   Bytes arrive through `Capabilities.fetch`/`readFile`, and `now()` is the
 *   configured `buildTime`, defaulting to the Unix epoch rather than the host
 *   clock: wrong but reproducible beats plausible but not (SPEC 24.3 rule 2).
 *
 * The attribute cascade, encoding normalisation and theme resolution that
 * complete a `ResolvedBlock` are not here: themes live in `@mdv/themes`, which
 * depends on core and therefore cannot be imported from it, and the encoding
 * layer owns channel normalisation. The facade composes the three.
 */

import type { AttrMap, AttrValue, Diagnostic, MdvBlock, MdvDocument, Range } from '@mdv/parser';
import type { ConformanceLevel } from '@mdv/spec';
import { emptyTable } from './data/build.js';
import { createCollector, rangeOfNode, type DiagCollector } from './data/diag.js';
import type { ConcreteFormat } from './data/detect.js';
import { formatFromMediaType } from './data/detect.js';
import { loadExternal, type FetchSecurity } from './data/fetch.js';
import type { FormatContext } from './data/format.js';
import { effectiveLimits } from './data/limits.js';
import type { SectionOptions } from './data/parse-section.js';
import { parseIso8601, type TimeZoneSpec } from './data/temporal.js';
import {
  DATASET_BLOCK,
  declareDatasets,
  inlineDatasetId,
  isReference,
  prepareDatasets,
  readDeclaration,
  readPipeline,
  resolveTableRef,
  type DatasetDeclaration,
  type PrepareOptions,
  type ResolvedTable,
  type TableCache,
} from './dataset/index.js';
import type { Capabilities, MdvConfig } from './types/config.js';
import type { DataRegistry, DatasetNode, TransformPipeline } from './types/data.js';
import { visualBlocks } from './walk.js';

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

/** Everything data resolution needs from the configuration (SPEC 25). */
export interface ResolveDataOptions extends PrepareOptions {
  security: FetchSecurity;
  capabilities: Capabilities;
  /** The document's base URI; a relative `src:` resolves against it (SPEC 6.4). */
  baseUri?: string | undefined;
}

/** SPEC 25 defaults, in one place so nothing downstream re-derives them. */
const DEFAULTS = {
  level: 2 as ConformanceLevel,
  locale: 'en-US',
  timezone: 'UTC',
  /** Not `Date.now()`: core is forbidden the clock (SPEC 17.3, 24.3 rule 2). */
  buildTime: new Date(0),
} as const;

/**
 * Derive the data-resolution options from a config and a document.
 *
 * Front matter contributes `locale`, `timezone` and — through `date:` — the
 * build time, but only where the embedder left them open: configuration
 * outranks the document, because a document must not be able to change the
 * environment it is rendered in (SPEC 25).
 */
export function dataOptionsFrom(
  config: MdvConfig | undefined,
  doc?: MdvDocument,
): ResolveDataOptions {
  const front = doc?.frontmatter;
  // `locale:` first, then `lang:`, then the default — the order SPEC 25 gives
  // for a document that sets only its language.
  const locale = config?.locale ?? front?.locale ?? front?.lang ?? DEFAULTS.locale;
  const timezone: TimeZoneSpec = config?.timezone ?? front?.timezone ?? DEFAULTS.timezone;
  const buildTime = config?.buildTime ?? buildTimeFrom(front?.date, timezone) ?? DEFAULTS.buildTime;

  const limits = effectiveLimits({
    maxDocumentBytes: config?.security?.maxDocumentBytes,
    maxRowsPerBlock: config?.security?.maxRowsPerBlock,
    fetchTimeoutMs: config?.security?.fetchTimeoutMs,
  });

  const format: FormatContext = { locale, timezone, buildTime };

  return {
    timezone,
    buildTime,
    limits,
    format,
    level: config?.level ?? DEFAULTS.level,
    security: {
      allowExternal: config?.security?.allowExternal ?? false,
      allowedOrigins: config?.security?.allowedOrigins ?? [],
      allowFileUrls: config?.security?.allowFileUrls ?? false,
      fetchTimeoutMs: limits.fetchTimeoutMs,
    },
    capabilities: config?.capabilities ?? {},
  };
}

/** `date: 2026-01-31` in front matter pins `now()` (SPEC 24.3 rule 2). */
function buildTimeFrom(date: string | undefined, zone: TimeZoneSpec): Date | undefined {
  if (date === undefined) return undefined;
  return parseIso8601(date, zone)?.date;
}

// ─────────────────────────────────────────────────────────────────────────────
// Collecting declarations
// ─────────────────────────────────────────────────────────────────────────────

/** One visual block and what it asked for. */
export interface BlockRequest {
  block: MdvBlock;
  /** 0-based position among the document's visual blocks. Drives `mdv-{index}`. */
  index: number;
  /** The dataset reference, synthesised as `@#block-3` for inline data. */
  reference: string;
  /** The block's own `transform:`. */
  transform?: TransformPipeline | undefined;
}

/** What {@link collectDatasets} found in one document. */
export interface CollectedData {
  declarations: DatasetDeclaration[];
  blocks: BlockRequest[];
  /**
   * Reader options `DatasetNode` has no field for — `delimiter:`, `header:` and
   * `columns:` (SPEC 6.2.2, 6.2.3) — keyed by dataset id. They are gathered
   * here, where the header is still in hand, rather than reconstructed later.
   */
  sectionOptions: Record<string, SectionOptions>;
}

/**
 * Walk the AST for everything data-related.
 *
 * Inline data sections become synthetic datasets (`#block-3`) rather than a
 * separate code path: one preparation pipeline for every table means `mdv data`
 * can name where any chart's rows came from, and a block-level `join` can reach
 * an inline table exactly like a declared one.
 */
export function collectDatasets(doc: MdvDocument, diag: DiagCollector): CollectedData {
  const declarations: DatasetDeclaration[] = [];
  const blocks: BlockRequest[] = [];
  const sectionOptions: Record<string, SectionOptions> = {};

  const front = doc.frontmatter;
  if (front?.datasets !== undefined) {
    for (const [id, value] of Object.entries(front.datasets)) {
      declarations.push(frontMatterDataset(id, value, front.range, diag));
      if (isMap(value)) addSectionOptions(sectionOptions, id, value);
    }
  }

  let index = 0;
  for (const block of visualBlocks(doc)) {
    const range = rangeOfNode(block);
    const scoped = diag.withRange(range);

    if (block.blockType === DATASET_BLOCK) {
      const id = block.attrs['id'];
      if (typeof id !== 'string') {
        scoped.emit('MDV1220', {
          message: 'A `dataset` block needs a string `id`',
          detail: 'Write ```` ```mdv dataset id=sales ```` (SPEC 6.3). The block was ignored.',
        });
        continue;
      }
      declarations.push(readDeclaration(id, block.attrs, 'block', scoped, sectionOf(block), range));
      addSectionOptions(sectionOptions, id, block.attrs);
      continue;
    }

    const request = blockRequest(block, index, declarations, scoped, range);
    if (request.reference === `@${inlineDatasetId(index)}`) {
      addSectionOptions(sectionOptions, inlineDatasetId(index), block.attrs);
    }
    blocks.push(request);
    index += 1;
  }

  return { declarations, blocks, sectionOptions };
}

/** Pull `delimiter:`, `header:` and `columns:` off a header (SPEC 6.2.2, 6.2.3). */
function addSectionOptions(into: Record<string, SectionOptions>, id: string, attrs: AttrMap): void {
  const section: SectionOptions = {};
  const delimiter = attrs['delimiter'];
  if (typeof delimiter === 'string') section.delimiter = delimiter;
  const header = attrs['header'];
  if (typeof header === 'boolean') section.header = header;
  const columns = attrs['columns'];
  if (Array.isArray(columns) && columns.every((name) => typeof name === 'string')) {
    section.columns = columns as readonly string[];
  }
  if (Object.keys(section).length > 0) into[id] = section;
}

function isMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A dataset declared in front matter; its data comes from `src:` or `from:`. */
function frontMatterDataset(
  id: string,
  value: AttrValue,
  range: Range | undefined,
  diag: DiagCollector,
): DatasetDeclaration {
  if (typeof value === 'string') {
    // `datasets: {q1: "@sales"}` — the shorthand for a pure alias.
    return { id, origin: 'front-matter', from: value, ...(range !== undefined ? { range } : {}) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    diag.emit('MDV1220', {
      message: `\`datasets.${id}\` must be a mapping or a dataset reference`,
      detail: 'The declaration was kept but has no data (SPEC 6.3).',
    });
    return { id, origin: 'front-matter', ...(range !== undefined ? { range } : {}) };
  }

  const attrs = value as AttrMap;
  const raw = attrs['data'];
  return readDeclaration(
    id,
    attrs,
    'front-matter',
    diag,
    typeof raw === 'string' ? raw : undefined,
    range,
  );
}

/** What one visual block asks for: a reference, or an inline section of its own. */
function blockRequest(
  block: MdvBlock,
  index: number,
  declarations: DatasetDeclaration[],
  diag: DiagCollector,
  range: Range,
): BlockRequest {
  const transform = readPipeline(block.attrs['transform'], diag);
  const data = block.attrs['data'];
  const src = block.attrs['src'];
  const section = sectionOf(block);

  if (typeof data === 'string' && isReference(data)) {
    return {
      block,
      index,
      reference: data.trim(),
      ...(transform !== undefined ? { transform } : {}),
    };
  }

  // Anything else the block carries is its own dataset, registered under a
  // synthetic id so one code path prepares every table.
  const id = inlineDatasetId(index);
  const declaration: DatasetDeclaration = {
    id,
    origin: 'inline',
    range,
    ...(section !== undefined ? { raw: section } : {}),
    ...(typeof src === 'string' ? { src } : {}),
  };
  const inline = readDeclaration(id, block.attrs, 'inline', diag, section, range);
  declarations.push({ ...inline, ...declaration });

  return {
    block,
    index,
    reference: `@${id}`,
    ...(transform !== undefined ? { transform } : {}),
  };
}

/** The block's data section, or `undefined` when it has none. */
function sectionOf(block: MdvBlock): string | undefined {
  const data = block.raw.data;
  return data === '' ? undefined : data;
}

// ─────────────────────────────────────────────────────────────────────────────
// External sources (SPEC 6.4)
// ─────────────────────────────────────────────────────────────────────────────

/** State a refusal maps to, by the code the loader reported. */
const BLOCKING_CODES: readonly string[] = ['MDV4002', 'MDV4003', 'MDV4010', 'MDV4020', 'MDV4022'];

/**
 * Load every `src:` dataset.
 *
 * Requests are issued together but their diagnostics are replayed in
 * declaration order, so a document's diagnostic list does not depend on which
 * server answered first (SPEC 24.3). Nothing here throws: a refusal or a failure
 * leaves the node in a stated non-ready state and the block renders a
 * placeholder (SPEC 6.4).
 */
export async function loadExternalDatasets(
  nodes: readonly DatasetNode[],
  options: ResolveDataOptions,
  diag: DiagCollector,
): Promise<void> {
  const pending = nodes.filter((node) => node.src !== undefined && node.raw === undefined);
  if (pending.length === 0) return;

  const runs = pending.map(async (node) => {
    node.state = 'loading';
    const local = createCollector('data', node.range ?? { start: origin(), end: origin() });
    const payload = await loadExternal(
      {
        src: node.src as string,
        ...(node.integrity !== undefined ? { integrity: node.integrity } : {}),
      },
      {
        security: options.security,
        capabilities: options.capabilities,
        limits: options.limits,
        ...(options.baseUri !== undefined ? { baseUri: options.baseUri } : {}),
      },
      local,
    );
    return { node, payload, diagnostics: local.diagnostics };
  });

  const results = await Promise.all(runs);

  for (const { node, payload, diagnostics } of results) {
    for (const diagnostic of diagnostics) replay(diagnostic, diag);

    if (payload === undefined) {
      const code = worstCode(diagnostics);
      node.state = code !== undefined && BLOCKING_CODES.includes(code) ? 'blocked' : 'failed';
      node.stateReason = code ?? 'MDV4023';
      continue;
    }

    node.raw = payload.text;
    if (node.format === undefined) {
      const format = formatFromMediaType(payload.contentType) ?? formatFromPath(payload.url);
      if (format !== undefined) node.format = format;
    }
    // Back to `declared`: preparation is what makes a node `ready`.
    node.state = 'declared';
  }
}

/** Re-emit a diagnostic produced by a per-source collector into the document's. */
function replay(diagnostic: Diagnostic, diag: DiagCollector): void {
  diag.emit(diagnostic.code, {
    message: diagnostic.message,
    severity: diagnostic.severity,
    range: diagnostic.range,
    ...(diagnostic.detail !== undefined ? { detail: diagnostic.detail } : {}),
  });
}

/** The code that best explains a refusal: the first error, else the first note. */
function worstCode(diagnostics: readonly Diagnostic[]): string | undefined {
  const error = diagnostics.find((diagnostic) => diagnostic.severity === 'error');
  return (error ?? diagnostics[0])?.code;
}

function origin(): { offset: number; line: number; column: number } {
  return { offset: 0, line: 1, column: 1 };
}

/** Format from a URL's extension, when the response did not say (SPEC 6.4). */
export function formatFromPath(url: string): ConcreteFormat | undefined {
  const path = (url.split('?')[0] ?? '').split('#')[0] ?? '';
  const dot = path.lastIndexOf('.');
  if (dot === -1) return undefined;
  switch (path.slice(dot + 1).toLowerCase()) {
    case 'csv':
      return 'csv';
    case 'tsv':
    case 'tab':
      return 'tsv';
    case 'json':
      return 'json';
    case 'ndjson':
    case 'jsonl':
      return 'ndjson';
    case 'md':
    case 'markdown':
      return 'table';
    default:
      return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The data stage
// ─────────────────────────────────────────────────────────────────────────────

/** The data half of a resolved document. */
export interface DocumentData {
  registry: DataRegistry;
  /** Nodes in declaration order, each prepared or carrying a stated reason. */
  nodes: readonly DatasetNode[];
  /** The per-document memo behind "N charts, one evaluation" (SPEC 6.7). */
  cache: TableCache;
  /** One entry per visual block, in document order. */
  blocks: readonly ResolvedBlockData[];
  diagnostics: readonly Diagnostic[];
}

/** What one block ended up with. */
export interface ResolvedBlockData extends ResolvedTable {
  block: MdvBlock;
  index: number;
}

/**
 * Resolve a document's data, fetching `src:` (SPEC 18 stage 2, the async stage).
 *
 * @returns the registry, the prepared nodes and one entry per block. Never
 * rejects for document content: a failure is a diagnostic plus a non-ready
 * state (SPEC 21).
 */
export async function resolveDocumentData(
  doc: MdvDocument,
  options: ResolveDataOptions,
  diag: DiagCollector = createCollector('data'),
): Promise<DocumentData> {
  const collected = collectDatasets(doc, diag);
  const nodes = declareDatasets(collected.declarations, diag);
  await loadExternalDatasets(nodes, options, diag);
  return finish(doc, collected, nodes, options, diag);
}

/**
 * Synchronous data resolution, for server rendering and for `mdv fmt`.
 *
 * Identical except that it cannot fetch: a dataset with `src:` is `MDV4001` and
 * ends `blocked`, so the block shows the placeholder for a source that was never
 * loaded rather than an empty chart.
 */
export function resolveDocumentDataSync(
  doc: MdvDocument,
  options: ResolveDataOptions,
  diag: DiagCollector = createCollector('data'),
): DocumentData {
  const collected = collectDatasets(doc, diag);
  const nodes = declareDatasets(collected.declarations, diag);

  for (const node of nodes) {
    if (node.src === undefined || node.raw !== undefined) continue;
    const scoped = node.range === undefined ? diag : diag.withRange(node.range);
    scoped.emit('MDV4001', {
      message: `\`src: ${node.src}\` cannot be loaded by a synchronous resolve`,
      detail: 'Use the asynchronous `resolve` to fetch external data (SPEC 18).',
    });
    node.state = 'blocked';
    node.stateReason = 'MDV4001';
  }

  return finish(doc, collected, nodes, options, diag);
}

/** Prepare the graph, then give every block its table. Shared by both entries. */
function finish(
  doc: MdvDocument,
  collected: CollectedData,
  nodes: readonly DatasetNode[],
  options: ResolveDataOptions,
  diag: DiagCollector,
): DocumentData {
  const prepared = prepareDatasets(
    nodes,
    { ...options, sectionOptions: collected.sectionOptions },
    diag,
  );

  // `MdvDocument.datasets` is the AST's view of the graph (SPEC 19); populating
  // it here is what makes `parse → resolve → toMarkdown` round-trip with the
  // datasets attached.
  for (const node of prepared.nodes) doc.datasets[node.id] = node;

  const blocks: ResolvedBlockData[] = collected.blocks.map((request) => {
    const scoped = diag.withRange(rangeOfNode(request.block));
    const resolved = resolveTableRef(
      {
        reference: request.reference,
        ...(request.transform !== undefined ? { transform: request.transform } : {}),
      },
      prepared.registry,
      prepared.cache,
      options,
      scoped,
    );
    // The AST carries the ref so a re-render can reuse the memo (SPEC 18).
    request.block.data = resolved.ref;
    return { ...resolved, block: request.block, index: request.index };
  });

  return {
    registry: prepared.registry,
    nodes: prepared.nodes,
    cache: prepared.cache,
    blocks,
    diagnostics: diag.diagnostics,
  };
}

/**
 * An empty result, for a document with nothing in it.
 *
 * Built through {@link prepareDatasets} rather than by hand so that an empty
 * document's registry answers `get`/`list`/`resolve` exactly like a populated
 * one, and a caller never has to special-case it.
 */
export function emptyDocumentData(): DocumentData {
  const prepared = prepareDatasets([], dataOptionsFrom(undefined), createCollector('data'));
  return {
    registry: prepared.registry,
    nodes: prepared.nodes,
    cache: prepared.cache,
    blocks: [],
    diagnostics: [],
  };
}

/** The empty table every failed block falls back to (SPEC 14.1 principle 2). */
export { emptyTable };

/** Re-exported for the deep-import path `@mdv/core/resolve.js` (SPEC 17.2). */
export { visualBlocks };

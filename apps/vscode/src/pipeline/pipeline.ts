/**
 * The MDV pipeline, per document, with per-stage memoisation.
 *
 * SPEC 18 numbers the stages; SPEC 29.3 requires the preview to re-run "only the
 * pipeline stages whose inputs changed". This class is where that promise is
 * kept. One {@link DocumentPipeline} is held per open document and asked to
 * produce a {@link PipelineResult}; between two calls it re-runs the smallest
 * suffix of the pipeline that the changed inputs force.
 *
 * ```text
 *   source ─────────────► [1 parse] ──────► MdvDocument
 *   security/locale ────► [2 resolve data] ► tables + dataset graph
 *   per block: attrs, table, size, theme
 *                       ► [5 encode + 6 layout] ► Scene
 *                       ► [7 render] ──────► SVG string
 * ```
 *
 * Cache keys, from cheapest to most specific:
 *
 * | Stage | Re-runs when |
 * |---|---|
 * | parse | the document text changed at all |
 * | data | the parse changed, or the security/locale/level options changed |
 * | layout+render | that one block's source text, its table identity, the width, the theme, the level, or `strict` changed |
 *
 * The practical consequence, and the reason for the design: typing a character
 * inside one chart's `title:` re-parses (cheap, one pass over the text),
 * re-resolves the data (cheap, the memo in `TableCache` means N charts over one
 * dataset still cost one evaluation), and re-lays-out exactly **one** block. The
 * other blocks hand back the string they produced last time.
 *
 * ## Determinism
 *
 * Nothing here reads the clock, the host locale or the host timezone. The build
 * time is `new Date(0)` unless the document pins one with `date:`, the locale and
 * timezone come from front matter, and layout ids are the
 * `mdv-{blockIndex}-{counter}` scheme seeded from the block index — so the same
 * document produces byte-identical SVG on two machines (SPEC 24.3).
 *
 * ## Why the assembly is here and not one call to `@mdv/core`
 *
 * Not for want of a facade: `resolve()` is implemented, and `pipeline/pdf.ts`
 * calls it — an export wants the whole document once, so the facade is exactly
 * right there. A preview wants the opposite. It re-runs on every keystroke and
 * must reuse the layout of the blocks that did not change, which means driving
 * the stages by hand (`resolveDocumentDataSync`, `makeLayoutContext`,
 * `layoutBlock`) and memoising between them. Core exports those stages for this
 * reason, and they are the same functions `resolve()` calls — one
 * implementation, two schedules. Everything below the {@link PipelineResult}
 * boundary is replaceable in one file.
 */

import type { Diagnostic, MdvBlock, MdvDocument } from '@mdv/parser';
import { parse } from '@mdv/parser';
import type {
  ChartType,
  DatasetNode,
  DocumentData,
  ResolveDataOptions,
  ResolvedBlock,
  Scene,
  Table,
  Theme,
} from '@mdv/core';
import {
  applyStrict,
  compareDiagnostics,
  createDiagnostic,
  dataOptionsFrom,
  layoutBlock,
  makeLayoutContext,
  resolveDocumentData,
  resolveDocumentDataSync,
  visualBlocks,
} from '@mdv/core';

import { toSvgString } from '@mdv/render-svg';

import { capabilitiesFor } from './capabilities.js';
import { cascadeAttrs, encodingFromAttrs } from './cascade.js';
import { chartRegistry } from './registry.js';
import { builtinTheme, themeForBlock } from './theme.js';
import type { BlockData, PipelineInputs, PipelineResult, RenderedBlock } from './types.js';

/** Block types that are data or configuration, not drawings (SPEC 5.2). */
const NON_VISUAL_TYPES: ReadonlySet<string> = new Set([
  'dataset',
  'config',
  'theme',
  'include',
  'raw',
]);

/** Height used when a block declares none and the type has no default. */
const DEFAULT_BLOCK_HEIGHT = 300;

/** Widths outside this range are the host mis-measuring, not an author choice. */
const MIN_WIDTH = 160;
const MAX_WIDTH = 4096;

/** What one memoised block render remembers. */
interface BlockCacheEntry {
  readonly key: string;
  readonly rendered: RenderedBlock;
  readonly diagnostics: readonly Diagnostic[];
  readonly table: Table;
}

/** The memoised data stage. */
interface DataCacheEntry {
  readonly key: string;
  readonly data: DocumentData;
}

/** A stable, order-independent key for the options that feed the data stage. */
function dataKey(inputs: PipelineInputs): string {
  // Origins are sorted: the allowlist is a set, and its spelling order in
  // settings.json must not invalidate a cache entry (SPEC 24.3 rule 5).
  const origins = [...inputs.allowedOrigins].sort();
  return JSON.stringify([inputs.uri, inputs.level, inputs.allowExternal, origins]);
}

/**
 * Content fingerprints of the tables of the current data resolution.
 *
 * Keyed by the `Table` object, so a table shared by five charts is hashed once.
 * A `WeakMap` because an entry must die with the resolution that produced it.
 */
const tableFingerprints = new WeakMap<Table, string>();

/**
 * A content fingerprint of a prepared table.
 *
 * The block memo cannot key a table by identity: every data resolution builds
 * fresh `Table` objects, so identity would never match across an edit. It cannot
 * key it by shape either — a chart that reads a shared `@dataset` keeps its own
 * text and its own row count when a *cell* of that dataset changes, and would
 * then serve a stale SVG. So the cells are hashed.
 *
 * FNV-1a in two lanes: allocation-free per cell and — unlike a JSON round-trip —
 * indifferent to object key order, which SPEC 24.3 rule 5 forbids a cache from
 * depending on. Cost is one pass per table per data resolution, against the
 * per-block layout pass it exists to avoid.
 */
function fingerprintTable(table: Table): string {
  const cached = tableFingerprints.get(table);
  if (cached !== undefined) return cached;

  let a = 0x811c9dc5;
  let b = 0x01000193;
  const mix = (text: string): void => {
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      a = Math.imul(a ^ code, 0x01000193);
      b = Math.imul(b + code, 0x85ebca6b) ^ (b >>> 13);
    }
    // A separator, so ["ab", "c"] and ["a", "bc"] do not hash alike.
    a = Math.imul(a ^ 0x1f, 0x01000193);
    b = Math.imul(b + 0x1f, 0x85ebca6b) ^ (b >>> 13);
  };

  for (const field of table.fields) {
    mix(field.name);
    mix(field.type);
    mix(field.format ?? '');
  }
  for (const row of table.rows) {
    for (const cell of row) {
      // Tagged, so the string "1" and the number 1 cannot collide and a Date
      // hashes by its instant rather than by a locale-dependent rendering.
      if (cell === null) mix('n');
      else if (cell instanceof Date) mix(`d${String(cell.getTime())}`);
      else if (typeof cell === 'number') mix(`#${String(cell)}`);
      else if (typeof cell === 'boolean') mix(cell ? 't' : 'f');
      else mix(`s${cell}`);
    }
  }

  const digest =
    `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}` +
    `.${String(table.rows.length)}x${String(table.fields.length)}`;
  tableFingerprints.set(table, digest);
  return digest;
}

/**
 * A stable key for one block's layout+render.
 *
 * Everything the rendered block depends on is in here, because the memo now
 * survives a re-parse: the block's own text, the data it ended up with, the
 * geometry, the theme and the validation knobs — plus its starting line, since
 * the cached value carries the line span the preview scroll-syncs against and
 * the diagnostics carry ranges into the document.
 */
function blockKey(
  block: MdvBlock,
  source: string,
  table: Table,
  inputs: PipelineInputs,
  width: number,
): string {
  const pos = block.position;
  const text =
    pos?.start.offset !== undefined && pos.end.offset !== undefined
      ? source.slice(pos.start.offset, pos.end.offset)
      : `${block.blockType}\u0000${block.raw.header}\u0000${block.raw.data}`;
  return [
    text,
    fingerprintTable(table),
    pos?.start.line ?? -1,
    width,
    inputs.theme,
    inputs.level,
    inputs.strict ? 1 : 0,
  ].join('\u0001');
}

/** 0-based inclusive line span of a node, for scroll sync. */
function lineSpan(block: MdvBlock): { startLine: number; endLine: number } {
  const pos = block.position;
  const start = pos?.start.line ?? 1;
  const end = pos?.end.line ?? start;
  return { startLine: Math.max(0, start - 1), endLine: Math.max(0, end - 1) };
}

/** `attrs.height` as a number of pixels; a `%` height is meaningless vertically. */
function heightOf(attrs: Record<string, unknown>, fallback: number): number {
  const raw = attrs['height'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === 'string') {
    const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(raw.trim());
    if (match?.[1] !== undefined) {
      const value = Number.parseFloat(match[1]);
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }
  return fallback;
}

/** `attrs.width` in pixels, or the container width for a fluid block. */
function widthOf(attrs: Record<string, unknown>, container: number): number {
  const raw = attrs['width'];
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    const percent = /^(\d+(?:\.\d+)?)%$/.exec(trimmed);
    if (percent?.[1] !== undefined) {
      const fraction = Number.parseFloat(percent[1]) / 100;
      if (Number.isFinite(fraction) && fraction > 0) {
        return Math.max(MIN_WIDTH, Math.round(container * fraction));
      }
    }
    const px = /^(\d+(?:\.\d+)?)(px)?$/.exec(trimmed);
    if (px?.[1] !== undefined) {
      const value = Number.parseFloat(px[1]);
      if (Number.isFinite(value) && value > 0) return Math.round(value);
    }
  }
  return container;
}

/** The origin of a `src:`, or `undefined` for a relative path. */
function originOf(src: string): string | undefined {
  try {
    return new URL(src).origin;
  } catch {
    return undefined;
  }
}

function stringAttr(attrs: Record<string, unknown>, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * One document's pipeline.
 *
 * Not thread-safe and not shared: one instance per URI, disposed with the
 * document. That is SPEC 17.3 invariant 4 at the extension's scale — two
 * previews of two documents share only the frozen chart registry.
 */
export class DocumentPipeline {
  #source: string | undefined;
  #document: MdvDocument | undefined;
  #data: DataCacheEntry | undefined;
  #blocks = new Map<string, BlockCacheEntry>();
  /** The last run's tables, for `mdv.showData` without a re-render. */
  #tables: BlockData[] = [];

  /** Drop every memo. Used when the theme kind changes under us. */
  invalidate(): void {
    this.#source = undefined;
    this.#document = undefined;
    this.#data = undefined;
    this.#blocks.clear();
  }

  /** The prepared tables from the last successful run, in document order. */
  get tables(): readonly BlockData[] {
    return this.#tables;
  }

  /**
   * Run the pipeline.
   *
   * Never throws for document content: a stage that fails for one block becomes
   * that block's error card plus a diagnostic, and the rest of the document
   * still renders (SPEC 14.1 principle 1). A failure of the *pipeline itself* —
   * a bug in this extension or in a package — is caught per block and reported
   * as `MDV5000`, so one broken chart type cannot blank the preview.
   */
  async run(inputs: PipelineInputs): Promise<PipelineResult> {
    // ── Stage 1: parse ──────────────────────────────────────────────────────
    const parsed = this.#parseStage(inputs);
    const document = this.#document as MdvDocument;

    // ── Stage 2: resolve data ───────────────────────────────────────────────
    const key = dataKey(inputs);
    let resolved = false;
    if (this.#data === undefined || this.#data.key !== key) {
      const options = this.#dataOptions(document, inputs);
      // Always the asynchronous resolver, even with `allowExternal` off. It is
      // the one that refuses a `src:` *for the right reason*: `MDV4002`, whose
      // message names the setting to change, rather than the sync resolver's
      // `MDV4001` ("cannot be loaded by a synchronous resolve"), which would
      // blame the reader's plumbing for the reader's policy. It cannot leak a
      // request either — `loadExternal` checks `security.allowExternal` before
      // it classifies the URL, so with the setting off there is no network turn
      // to make (SPEC 25.2).
      this.#data = { key, data: await resolveDocumentData(document, options) };
      resolved = true;
    }

    return this.#renderStage(document, this.#data.data, inputs, parsed, resolved);
  }

  /**
   * Run the pipeline **without ever going to the network**.
   *
   * The Markdown-preview integration (`markdown.markdownItPlugins`, SPEC 29.2)
   * renders inside markdown-it's `fence` rule, which must return a string
   * synchronously — there is no point at which it could await a fetch. So this
   * variant always takes `resolveDocumentDataSync`, and a `src:` in a `.md`
   * file's MDV block degrades to `MDV4001`/`MDV4002` and an error card exactly
   * as it does when `mdv.security.allowExternal` is off.
   *
   * It shares every memo with {@link run}, so a document previewed both ways
   * parses once.
   */
  runSync(inputs: PipelineInputs): PipelineResult {
    const parsed = this.#parseStage(inputs);
    const document = this.#document as MdvDocument;

    // The cache key carries `allowExternal`, so a sync run and an async run of
    // the same document do not overwrite each other's data stage silently.
    const key = `${dataKey(inputs)}|sync`;
    let resolved = false;
    if (this.#data === undefined || this.#data.key !== key) {
      const options = this.#dataOptions(document, inputs);
      this.#data = { key, data: resolveDocumentDataSync(document, options) };
      resolved = true;
    }

    return this.#renderStage(document, this.#data.data, inputs, parsed, resolved);
  }

  /** Stage 1. Returns `true` when the document was re-parsed. */
  #parseStage(inputs: PipelineInputs): boolean {
    if (this.#document !== undefined && this.#source === inputs.source) return false;
    this.#document = parse(inputs.source);
    this.#source = inputs.source;
    // A new AST invalidates the data memo: the block nodes the data stage
    // attached `TableRef`s to no longer exist. The *block* memo survives on
    // purpose — that is what makes editing one chart in a ten-chart document
    // cost one layout instead of ten. It is safe because `blockKey` hashes the
    // block's text, its resolved table's contents and its position, so a block
    // only reuses an SVG that the new document would have produced anyway.
    this.#data = undefined;
    return true;
  }

  /** Stages 5–7 for every block, plus the result assembly. */
  #renderStage(
    document: MdvDocument,
    data: DocumentData,
    inputs: PipelineInputs,
    parsed: boolean,
    resolved: boolean,
  ): PipelineResult {
    // ── Stages 5–7, per block ───────────────────────────────────────────────
    const diagnostics: Diagnostic[] = [...document.diagnostics, ...data.diagnostics];
    const rendered: RenderedBlock[] = [];
    const tables: BlockData[] = [];
    let laidOut = 0;
    let reused = 0;

    const previewTheme = builtinTheme(inputs.theme);
    const blocks = visualBlocks(document);
    const tableFor = new Map<MdvBlock, Table>();
    for (const entry of data.blocks) tableFor.set(entry.block, entry.table);

    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (block === undefined) continue;
      if (NON_VISUAL_TYPES.has(block.blockType)) continue;

      const table = tableFor.get(block) ?? { fields: [], rows: [] };
      const attrs = block.attrs as Record<string, unknown>;
      const container = widthOf(attrs, clampWidth(inputs.width));
      const cacheKey = blockKey(block, inputs.source, table, inputs, container);
      const cacheId = `${index}`;
      const cached = this.#blocks.get(cacheId);

      if (cached !== undefined && cached.key === cacheKey) {
        rendered.push(cached.rendered);
        diagnostics.push(...cached.diagnostics);
        tables.push({
          id: cached.rendered.id,
          index,
          blockType: cached.rendered.blockType,
          table: cached.table,
        });
        reused += 1;
        continue;
      }

      const produced = this.#renderBlock(block, index, table, container, previewTheme, inputs);
      this.#blocks.set(cacheId, { key: cacheKey, ...produced });
      rendered.push(produced.rendered);
      diagnostics.push(...produced.diagnostics);
      tables.push({
        id: produced.rendered.id,
        index,
        blockType: produced.rendered.blockType,
        table,
      });
      laidOut += 1;
    }

    // Drop memos for indices the document no longer has, so deleting the last
    // nine of ten blocks releases nine SVGs rather than holding them for a
    // document that will never ask again.
    for (const id of [...this.#blocks.keys()]) {
      if (Number.parseInt(id, 10) >= blocks.length) this.#blocks.delete(id);
    }

    this.#tables = tables;

    const finalDiagnostics = diagnostics
      .map((d) => applyStrict(d, inputs.strict))
      .sort(compareDiagnostics);

    return {
      diagnostics: finalDiagnostics,
      blocks: rendered,
      blockedOrigins: blockedOrigins(data.nodes, inputs.allowExternal),
      stats: { parsed, resolved, laidOut, reused },
    };
  }

  /** Build the SPEC 25 options for the data stage from the settings. */
  #dataOptions(document: MdvDocument, inputs: PipelineInputs): ResolveDataOptions {
    const base = dataOptionsFrom(
      {
        level: inputs.level,
        security: {
          allowExternal: inputs.allowExternal,
          allowedOrigins: [...inputs.allowedOrigins],
        },
      },
      document,
    );
    return { ...base, capabilities: capabilitiesFor(inputs.allowExternal), baseUri: inputs.uri };
  }

  /**
   * Stages 5–7 for one block.
   *
   * Wrapped in a `try` because a chart type is third-party-shaped code: SPEC 21
   * says `layoutBlock` never throws for document content, and it does catch its
   * own chart types, but a defect *above* it — in the cascade, in the theme, in
   * the serialiser — must still not take the preview down. That case is
   * `MDV5000`, the code Appendix C reserves for an internal render failure.
   */
  #renderBlock(
    block: MdvBlock,
    index: number,
    table: Table,
    width: number,
    previewTheme: Theme,
    inputs: PipelineInputs,
  ): { rendered: RenderedBlock; diagnostics: readonly Diagnostic[]; table: Table } {
    const span = lineSpan(block);
    const range = {
      start: {
        offset: block.position?.start.offset ?? 0,
        line: block.position?.start.line ?? 1,
        column: block.position?.start.column ?? 1,
      },
      end: {
        offset: block.position?.end.offset ?? 0,
        line: block.position?.end.line ?? 1,
        column: block.position?.end.column ?? 1,
      },
    };

    const collected: Diagnostic[] = [];
    try {
      const registry = chartRegistry();
      const chartType: ChartType | undefined = registry.get(block.blockType);

      const attrs = cascadeAttrs(block, {
        typeDefaults: chartType?.defaults,
        documentDefaults: this.#document?.frontmatter?.defaults,
      });
      const attrRecord = attrs as Record<string, unknown>;

      const { theme, unknown } = themeForBlock(previewTheme, stringAttr(attrRecord, 'theme'));
      if (unknown !== undefined) {
        collected.push(
          createDiagnostic('MDV1502', {
            message: `Theme ${JSON.stringify(unknown)} is not a built-in and cannot be loaded in the preview`,
            detail:
              'The preview resolves built-in themes only (default, dark, high-contrast, print). ' +
              'A theme file needs the filesystem capability, which the preview does not grant.',
            range,
            source: 'render',
          }),
        );
      }

      const columns = new Set(table.fields.map((field) => field.name));
      const encoding = encodingFromAttrs(attrs, columns, chartType?.defaultEncoding);

      const id = stringAttr(attrRecord, 'id') ?? `mdv-${index}`;
      const resolvedBlock: ResolvedBlock = {
        id,
        index,
        blockType: block.blockType,
        level: block.level,
        attrs,
        encoding,
        table,
        tableRef: block.data ?? { datasetId: `#block-${index}`, key: `#block-${index}` },
        node: block,
        range,
        theme,
        diagnostics: [],
        failed: false,
      };

      const context = makeLayoutContext({
        theme,
        blockIndex: index,
        level: inputs.level,
        ...localeOptions(this.#document),
        onDiagnostic: (diagnostic) => {
          collected.push(diagnostic);
        },
      });

      const height = heightOf(attrRecord, chartTypeHeight(chartType));
      const scene: Scene = layoutBlock(resolvedBlock, { width, height }, context, registry);
      // `interaction: true` emits the transparent hit-rect overlay the webview's
      // readout is driven from; `inlineStyles` stays off because the preview
      // serves the stylesheet from a nonced <style> (SPEC 13.5, 29.3).
      const svg = toSvgString(scene, { interaction: true });

      const failed = collected.some((d) => d.severity === 'error');
      return {
        rendered: {
          id,
          index,
          blockType: block.blockType,
          title: stringAttr(attrRecord, 'title'),
          startLine: span.startLine,
          endLine: span.endLine,
          svg,
          failed,
          family: chartType?.family ?? 'none',
        },
        diagnostics: collected,
        table,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      collected.push(
        createDiagnostic('MDV5000', {
          message: `Internal render failure in block ${index}`,
          detail: message,
          range,
          source: 'render',
        }),
      );
      return {
        rendered: {
          id: `mdv-${index}`,
          index,
          blockType: block.blockType,
          title: undefined,
          startLine: span.startLine,
          endLine: span.endLine,
          // No SVG: the webview draws its own failure card for an empty string,
          // which is the one place a *host* failure is distinguishable from a
          // document failure (which core already draws as an error card).
          svg: '',
          failed: true,
          family: 'none',
        },
        diagnostics: collected,
        table,
      };
    }
  }
}

function clampWidth(width: number): number {
  if (!Number.isFinite(width)) return 720;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(width)));
}

/** `metric` tiles are short; everything else gets SPEC 8.1's 300 px default. */
function chartTypeHeight(chartType: ChartType | undefined): number {
  const declared = chartType?.defaults?.height;
  if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
    return Math.round(declared);
  }
  return DEFAULT_BLOCK_HEIGHT;
}

/** Locale and timezone come from the document, never from the host (SPEC 25). */
function localeOptions(document: MdvDocument | undefined): {
  locale?: string;
  timezone?: string;
  buildTime?: Date;
} {
  const front = document?.frontmatter;
  const out: { locale?: string; timezone?: string } = {};
  const locale = front?.locale ?? front?.lang;
  if (typeof locale === 'string' && locale.length > 0) out.locale = locale;
  if (typeof front?.timezone === 'string' && front.timezone.length > 0) {
    out.timezone = front.timezone;
  }
  return out;
}

/**
 * The origins a document wanted and did not get (SPEC 29.3's banner).
 *
 * Sorted and de-duplicated: the banner text is part of the preview's output and
 * must not depend on dataset declaration order.
 */
function blockedOrigins(nodes: readonly DatasetNode[], allowExternal: boolean): readonly string[] {
  if (allowExternal) return [];
  const origins = new Set<string>();
  for (const node of nodes) {
    if (node.src === undefined) continue;
    const origin = originOf(node.src);
    if (origin !== undefined) origins.add(origin);
  }
  return [...origins].sort();
}

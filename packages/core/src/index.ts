/**
 * `@mdv/core` — datasets, type inference, transforms, MDVX, scales, ticks,
 * formatting, the theme cascade, validation, encoding, layout to a scene graph,
 * and accessible-text generation.
 *
 * **No DOM.** SPEC 17.3 invariant 1: core never touches the DOM, the filesystem,
 * the network, or the clock. All four arrive through injected
 * {@link Capabilities}. The DOM *types* referenced by the {@link Mdv} facade
 * (`HTMLElement`, `Blob`) are structural only — core hands them to a renderer and
 * never calls a method on them.
 */

import type {
  AttrMap,
  Diagnostic,
  FormatOptions,
  MdvDocument,
  ParseOptions,
  Range,
} from '@mdv/parser';
import type { MdvConfig, ResolvedConfig } from './types/config.js';
import type { ResolvedBlock, ResolvedDocument } from './types/resolved.js';
import type { Scene } from './types/scene.js';
import type { Theme } from './types/theme.js';
import type { ChartType, ChartTypeRegistry } from './registry.js';
import type { DiagCollector } from './data/diag.js';
import type { DocumentData, ResolveDataOptions, ResolvedBlockData } from './resolve.js';
import {
  DOCUMENT_START,
  applyStrict,
  compareDiagnostics,
  createDiagnostic,
} from './types/diagnostics.js';
import { parse, toMarkdown } from '@mdv/parser';
import { MdvConfigError } from './types/config.js';
import { layoutBlock } from './layout/block.js';
import { createCollector, rangeOfNode } from './data/diag.js';
import { cascadeAttrs, encodingFromAttrs } from './cascade.js';
import { pluginThemes, registryFromPlugins, resolveConfig } from './config.js';
import { resolveThemeSetting } from './theme/index.js';
import { dataOptionsFrom, resolveDocumentData, resolveDocumentDataSync } from './resolve.js';
import { makeLayoutContext } from './layout/context.js';
import type { LayoutContextWithRegistry } from './layout/block.js';
import { defaultTableMetrics } from './metrics/table-metrics.js';

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports: the type surface and the chart-type contract
// ─────────────────────────────────────────────────────────────────────────────

export * from './types/index.js';
export * from './registry.js';

/**
 * The stage sub-barrels. Each of these files exists to be the public face of its
 * directory, and every one of them was unreachable from `@mdv/core` until this
 * line — `rerangeScale`, `makeLayoutContext`, `createTableMetrics`, the tick
 * ladder and the a11y-table builder were all written, tested and then hidden.
 *
 * Order matters only in that a later `export *` cannot silently shadow an
 * earlier one: TypeScript drops ambiguous star re-exports rather than picking a
 * winner, so a collision here becomes a *missing* export, not a wrong one. The
 * suite in `test/barrel.test.ts` asserts the names that matter are present.
 */
export * from './scale/index.js';
export * from './encode/index.js';
export * from './layout/index.js';
export * from './a11y/index.js';
export * from './metrics/index.js';
export * from './transform/index.js';
export * from './dataset/index.js';

/**
 * `./expr/index.js` is **deliberately not** star-exported. It exports
 * `asNumber(value: ExprValue)` and `./encode/index.js` exports a different
 * `asNumber(value: Value)`; a star export of both makes the name ambiguous, and
 * an ambiguous star export is *dropped*, so widening here would quietly delete
 * `asNumber` from the public surface rather than produce an error at the call
 * site. Nothing needs it at the root — `MdvPlugin.functions` is typed
 * `readonly unknown[]` for the same cycle-avoidance reason `chartTypes` is — so
 * the MDVX evaluator stays reachable by subpath only. Renaming one of the two is
 * a breaking change to two tested modules and buys nothing today.
 *
 * The locator is the exception, by name rather than by star: an editor asking
 * "which argument is the cursor in" is asking about a document, not evaluating
 * anything, and it should not have to reach past the package's `exports` map to
 * find out. These three names collide with nothing.
 */
export type { CallSite } from './expr/locate.js';
export { callAt, expressionAt } from './expr/locate.js';

/**
 * The stages `resolve()` below is assembled from, exported because the pipeline
 * is not always driven end to end: an editor re-runs stage 2 on every keystroke
 * but stage 6 only on a resize, and a CLI that lints wants the cascade without
 * the layout. These are the same functions {@link resolve} calls; there is no
 * second implementation behind the facade.
 *
 * `apps/vscode` reached them by deep import (`@mdv/core/resolve.js`,
 * `@mdv/core/cascade.js`) because they were unreachable from the root. That
 * worked in-tree through `tsconfig.base.json` `paths` and would have broken for
 * a consumer of the published package, whose `exports` map has no such entry.
 */
export * from './resolve.js';
export * from './cascade.js';
export * from './theme/index.js';
export { pluginThemes, registryFromPlugins, resolveConfig } from './config.js';

/** `parse` is re-exported unchanged so an embedder needs one import (SPEC 21). */
export { parse, toMarkdown } from '@mdv/parser';
export type {
  AttrMap,
  AttrValue,
  FormatOptions,
  FrontMatter,
  MdvBlock,
  MdvDirective,
  MdvDocument,
  MdvError,
  ParseOptions,
} from '@mdv/parser';

/**
 * The conformance level in force (SPEC 16.1), re-exported from `@mdv/spec` so a
 * consumer needs one import.
 */
export type { ConformanceLevel } from '@mdv/spec';
export { SPEC_VERSION, lookupErrorCode, severityOf, summaryOf } from '@mdv/spec';

/** The version stamped into `Scene.meta.version`. */
export const CORE_VERSION = '0.0.0';

// ─────────────────────────────────────────────────────────────────────────────
// resolve (SPEC 18 stage 2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a parsed document: build the dataset DAG, fetch `src:` through the
 * injected capabilities, apply the attribute cascade, resolve themes, and prepare
 * every block's table (SPEC 18 stages 2–4).
 *
 * The **only async stage**. Network results are cached separately from layout, so
 * a resize never refetches.
 *
 * @param doc - a document from `parse`
 * @param config - see {@link MdvConfig}
 * @returns the resolved document. **Rejects only on capability failures** — a
 * filesystem the embedder promised but did not provide. Document-level problems
 * come back as `diagnostics` and failed blocks, never as a rejection (SPEC 21).
 * @throws MdvConfigError synchronously for host programmer error, e.g. a
 * malformed `config`.
 */
export async function resolve(doc: MdvDocument, config?: MdvConfig): Promise<ResolvedDocument> {
  const start = beginResolve(doc, config);
  const data = await resolveDocumentData(doc, start.options, start.diag);
  return assemble(doc, start, data);
}

/**
 * Synchronous {@link resolve}, for server rendering and for `mdv fmt`.
 *
 * Identical in every respect except that it cannot fetch: a document containing
 * `src:` produces `MDV4001` for the offending block, which then renders its error
 * card. Pair with `TableMetrics` for reproducible SSR output (SPEC 22.3).
 *
 * @throws MdvConfigError for host programmer error
 */
export function resolveSync(doc: MdvDocument, config?: MdvConfig): ResolvedDocument {
  const start = beginResolve(doc, config);
  const data = resolveDocumentDataSync(doc, start.options, start.diag);
  return assemble(doc, start, data);
}

/**
 * Everything the two entry points share up to the point where one awaits and the
 * other does not.
 *
 * Splitting here rather than writing `resolveSync` in terms of `resolve` is
 * deliberate: the sync path must never touch a promise, because SPEC 22.3's SSR
 * contract is that it completes within one tick.
 */
interface ResolveStart {
  readonly diag: DiagCollector;
  readonly options: ResolveDataOptions;
  readonly config: ResolvedConfig;
  readonly registry: ChartTypeRegistry;
  readonly rawConfig: MdvConfig | undefined;
}

function beginResolve(doc: MdvDocument, config: MdvConfig | undefined): ResolveStart {
  // One collector for the whole of stages 2–4, mirroring to the embedder's sink
  // as diagnostics are produced rather than in a batch at the end — a long fetch
  // should not hold back the report of a problem found before it started.
  const diag = createCollector(
    'data',
    DOCUMENT_START,
    config?.onDiagnostic !== undefined ? { onEmit: config.onDiagnostic } : undefined,
  );
  // `registryFromPlugins` throws `MdvConfigError` for a malformed plugin, which
  // is why it runs before anything is fetched: host programmer error should fail
  // immediately, not after a network round trip (SPEC 21).
  const registry = registryFromPlugins(config, diag);
  return {
    diag,
    options: dataOptionsFrom(config, doc),
    config: resolveConfig(config, doc, diag),
    registry,
    rawConfig: config,
  };
}

/** Stages 3–4: cascade, encode-normalise and theme every block, then publish. */
function assemble(doc: MdvDocument, start: ResolveStart, data: DocumentData): ResolvedDocument {
  const blocks = data.blocks.map((entry) => resolveOneBlock(entry, doc, start));

  // The collector's array is emission order, which depends on which datasets
  // happened to finish first. Sorting into document order here is what makes
  // `diagnostics` reproducible across an async and a sync resolve of the same
  // document (SPEC 24.3), and `compareDiagnostics` is a total order so the sort
  // is stable regardless of the engine's sort algorithm.
  const all = [...start.diag.diagnostics]
    .map((d) => applyStrict(d, start.config.strict))
    .sort(compareDiagnostics);

  // Second pass: give every block the diagnostics that landed inside it. The
  // data stage emits before a block has an id, so attribution is by source range
  // — the one piece of evidence that exists at every stage.
  for (const block of blocks) {
    const mine = all.filter(
      (d) => d.blockId === block.id || (!isDocumentWide(d.range) && within(d.range, block.range)),
    );
    block.diagnostics = mine;
    block.failed = block.failed || mine.some((d) => d.severity === 'error');
  }

  return {
    ast: doc,
    ...(doc.frontmatter !== undefined ? { frontmatter: doc.frontmatter } : {}),
    blocks,
    datasets: data.registry,
    diagnostics: all,
    theme: start.config.theme,
    config: start.config,
  };
}

/** A mutable view of one block while the two passes of {@link assemble} run. */
type BlockDraft = ResolvedBlock;

function resolveOneBlock(
  entry: ResolvedBlockData,
  doc: MdvDocument,
  start: ResolveStart,
): BlockDraft {
  const block = entry.block;
  const range = rangeOfNode(block);
  const chartType: ChartType | undefined = start.registry.get(block.blockType);

  // SPEC 5.5, levels 1→4 under the block's own attributes. Levels 3 and 4 are
  // passed separately rather than as the pre-merged `config.defaults`, because
  // `cascadeAttrs` already knows their order and a second merge could only get
  // it wrong; the merged form on `ResolvedConfig` exists for consumers that
  // need one map and is built by the same rule.
  const attrs = cascadeAttrs(block, {
    typeDefaults: chartType?.defaults,
    documentDefaults: doc.frontmatter?.defaults,
    configDefaults: start.rawConfig?.defaults as AttrMap | undefined,
  });

  const id = blockId(attrs, entry.index);
  const scoped = start.diag.withBlock(id, range);

  // A per-block `theme:` names a theme a plugin registered; an unknown name is
  // MDV1502 and the document's theme stands (SPEC 15.2 — degrade, never fail).
  let theme = start.config.theme;
  const requested = attrs.theme;
  if (typeof requested === 'string' && requested !== '') {
    const perBlock = resolveThemeSetting(
      requested,
      start.config.colorScheme,
      pluginThemes(start.rawConfig),
    );
    if (perBlock.unknownName === undefined) {
      theme = perBlock.theme;
    } else {
      scoped.emit('MDV1502', {
        message: `Unknown theme \`${perBlock.unknownName}\` — the document’s theme was used`,
        detail: 'Register the theme through a plugin, or resolve it with `@mdv/themes`.',
      });
    }
  }

  const columns = new Set(entry.table.fields.map((field) => field.name));

  return {
    id,
    index: entry.index,
    blockType: block.blockType,
    level: block.level,
    attrs,
    encoding: encodingFromAttrs(attrs, columns, chartType?.defaultEncoding),
    table: entry.table,
    tableRef: entry.ref,
    node: block,
    range,
    theme,
    // Both filled by `assemble`'s second pass, once every diagnostic exists.
    diagnostics: [],
    failed: entry.state === 'failed' || entry.state === 'blocked',
  };
}

/**
 * The author's `id`, or the deterministic fallback `mdv-{index}`.
 *
 * Not `crypto.randomUUID` and not a counter shared with anything else: the id is
 * the element-id prefix (SPEC 24.3 rule 7) and the anchor, so two runs over the
 * same source must produce the same one.
 */
function blockId(attrs: Record<string, unknown>, index: number): string {
  const declared = attrs['id'];
  return typeof declared === 'string' && declared !== '' ? declared : `mdv-${index}`;
}

/** `true` when `inner` sits inside `outer`, by offset. */
function within(inner: Range, outer: Range): boolean {
  return inner.start.offset >= outer.start.offset && inner.end.offset <= outer.end.offset;
}

/**
 * `true` for {@link DOCUMENT_START}, the zero-width range that means "the whole
 * document".
 *
 * Without this, a document-level finding — an unknown `theme:` in configuration,
 * say — is geometrically inside a block that begins at offset 0, and a document
 * with no front matter would blame its first block for it. Under `strict` that
 * is not cosmetic: the warning becomes an error and the block would be marked
 * `failed` for something it did not do.
 */
function isDocumentWide(range: Range): boolean {
  return range.start.offset === 0 && range.end.offset === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// layout (SPEC 18 stage 6)
// ─────────────────────────────────────────────────────────────────────────────

// `layoutBlock` is re-exported from './layout/index.js' above.
//
// ARITY. The stub that used to live here declared three parameters
// `(block, size, ctx)`; the implementation at `layout/block.ts` takes a fourth,
// `registry?: ChartTypeRegistry`. The four-parameter form wins, because:
//
//   - it is a superset — every three-argument call SPEC 21 documents still
//     typechecks and still behaves identically (the implementation falls back to
//     `ctx.registry` and then to the built-in registry when it is omitted); and
//   - the alternative, wrapping it to hide the parameter, would make the one
//     documented way to reach a custom chart type from the public API *worse*
//     than the internal one, which is the exact failure this milestone exists to
//     fix.
//
// The three-argument signature was never load-bearing: it threw.

// ─────────────────────────────────────────────────────────────────────────────
// Renderers (SPEC 21, 23)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A live rendering, returned by {@link Renderer.render}.
 *
 * `update` re-uses the existing host: an SVG backend patches attributes rather
 * than replacing the tree, so focus and text selection survive a resize.
 */
export interface RenderHandle {
  /** Replace the drawn scene in place. */
  update(scene: Scene): void;
  /** Detach listeners and remove anything the renderer added to the host. */
  destroy(): void;
}

/**
 * A render backend (SPEC 21).
 *
 * **Backends are total** (SPEC 17.3 invariant 3): any valid scene graph renders
 * on any backend, or the backend declares the node type unsupported at
 * registration time — never at render time, and never silently.
 *
 * @typeParam T - the host type: an `Element` for SVG, a
 * `CanvasRenderingContext2D` for Canvas, a page handle for PDF, a string sink for
 * text.
 */
export interface Renderer<T> {
  readonly target: 'svg' | 'canvas' | 'pdf' | 'text';
  /** Node kinds this backend cannot draw. Declared once, checked at registration. */
  readonly unsupported?: readonly string[];
  render(scene: Scene, host: T): RenderHandle;
}

// ─────────────────────────────────────────────────────────────────────────────
// The facade (SPEC 21)
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link Mdv.toHTML} (SPEC 23.3). */
export interface HtmlOptions {
  /**
   * Emit a single self-contained file: inlined CSS, fonts as WOFF2 data URLs, no
   * scripts. @defaultValue true
   */
  inline?: boolean;
  /** Include the interaction layer. @defaultValue false — a static file has none. */
  interactive?: boolean;
  /** Render width in px for fluid blocks. @defaultValue 800 */
  width?: number;
  /** Wrap in a full `<html>` document rather than emitting a fragment. @defaultValue true */
  document?: boolean;
  /** Value of the root `lang`; defaults to the document's front-matter `lang`. */
  lang?: string;
}

/** Options for {@link Mdv.toPDF} (SPEC 28.2). */
export interface PdfOptions {
  /** `A0`–`A6`, `Letter`, `Legal`, `Tabloid`, or `[w, h]` with units. @defaultValue 'A4' */
  pageSize?: string | [string, string];
  orientation?: 'portrait' | 'landscape';
  margin?: string | { top?: string; right?: string; bottom?: string; left?: string };
  header?: { left?: string; center?: string; right?: string };
  footer?: { left?: string; center?: string; right?: string };
  headerOnFirstPage?: boolean;
  numbering?: { start?: number; style?: 'decimal' | 'roman' | 'alpha'; restartAt?: string };
  toc?: { depth?: number; title?: string; pageBreakAfter?: boolean };
  bookmarks?: boolean;
  links?: boolean;
  /** Attach the source `.mdv` to the PDF (SPEC 28.9). */
  embedSource?: boolean;
  /** `false` for byte-comparison tests (SPEC 28.10). @defaultValue true */
  compress?: boolean;
  profile?: 'pdf-1.7' | 'pdf-a-3b' | 'pdf-ua-1';
}

/** A handle to one rendered block, from {@link MdvInstance.getBlock}. */
export interface BlockHandle {
  readonly id: string;
  readonly block: ResolvedBlock;
  /** The current scene, or `undefined` while the block is virtualised. */
  readonly scene: Scene | undefined;
  /** Diagnostics attributable to this block. */
  readonly diagnostics: readonly Diagnostic[];
  /** Scroll the block into view and move focus to its container. */
  focus(): void;
}

/** A mounted document (SPEC 21). */
export interface MdvInstance {
  readonly document: ResolvedDocument;
  readonly diagnostics: readonly Diagnostic[];
  /** Re-render from the earliest stage whose inputs changed (SPEC 18). */
  update(source: string): Promise<void>;
  setTheme(theme: string | Theme): void;
  /** Re-run stages 6–7 for every mounted block. */
  resize(): void;
  getBlock(id: string): BlockHandle | undefined;
  exportBlock(id: string, as: 'svg' | 'png' | 'csv'): Promise<Blob>;
  destroy(): void;
}

/**
 * The embedder-facing facade (SPEC 21).
 *
 * One instance owns one configuration, one plugin set and one chart registry;
 * two instances never share mutable state (SPEC 17.3 invariant 4).
 */
export class Mdv {
  readonly #config: MdvConfig;

  /**
   * @param config - see {@link MdvConfig}
   * @throws MdvConfigError for a malformed configuration — host programmer error
   * is an exception, document problems are diagnostics (SPEC 21).
   */
  constructor(config?: MdvConfig) {
    this.#config = config ?? {};
  }

  /** The configuration this instance was constructed with, unmerged. */
  get config(): Readonly<MdvConfig> {
    return this.#config;
  }

  /**
   * Parse, resolve and render a document into `host`.
   *
   * @param host - the container element. Core does not touch it; it is passed
   * through to the configured renderer.
   */
  async render(source: string, host: HTMLElement): Promise<MdvInstance> {
    void source;
    void host;
    // Deliberately still unimplemented, and deliberately explicit about it.
    //
    // `MdvInstance` is a *mounted* document: `update` re-runs the earliest dirty
    // stage, `resize` re-runs 6–7, `getBlock().focus()` moves focus, and
    // `exportBlock` returns a `Blob`. Every one of those touches the DOM, which
    // SPEC 17.3 invariant 1 forbids this package outright. It belongs to the
    // binding that owns a host element.
    return Promise.reject(
      new Error(
        'Mdv#render is not implemented in @mdv/core: mounting a document owns a DOM host, ' +
          'and SPEC 17.3 invariant 1 forbids core from touching the DOM. Use the @mdv/react ' +
          'binding or the editor app. The DOM-free path — resolve() → createLayoutContext() → ' +
          'layoutBlock() → a Renderer — is fully available here.',
      ),
    );
  }

  /**
   * Render every visual block to a standalone SVG string (SPEC 23.3).
   *
   * @returns one string per visual block, in document order
   */
  async toSVG(source: string, opts?: { width?: number }): Promise<string[]> {
    const serialise = this.#config.svg;
    if (serialise === undefined) {
      // SPEC 21's error contract: "an unknown renderer target … throw
      // MdvConfigError". An `async` method cannot throw synchronously, so this
      // rejects; the type and the `path` are the same either way.
      throw new MdvConfigError(
        'Mdv#toSVG needs a scene serialiser: pass `{ svg: toSvgString }` from @mdv/render-svg. ' +
          '@mdv/core cannot import a render backend, because every backend depends on core.',
        'svg',
      );
    }

    const width = opts?.width ?? DEFAULT_EXPORT_WIDTH;
    const resolved = await resolve(parse(source), this.#config);
    const registry = registryFromPlugins(this.#config);

    return resolved.blocks.map((block) => {
      const ctx = createLayoutContext(resolved, block);
      const height = exportHeight(block);
      return serialise(layoutBlock(block, { width, height }, ctx, registry));
    });
  }

  /** Render the whole document to static HTML (SPEC 23.3). */
  async toHTML(source: string, opts?: HtmlOptions): Promise<string> {
    void source;
    void opts;
    // Deliberately still unimplemented.
    //
    // SPEC 23.3's HTML export is a whole *document*: the Markdown prose around
    // the blocks, the directive set of SPEC 9, an inlined stylesheet, fonts as
    // WOFF2 data URLs. Only the block half of that is core's; the prose half is
    // a Markdown-to-HTML pipeline that lives with the exporters.
    return Promise.reject(
      new Error(
        'Mdv#toHTML is not implemented in @mdv/core: a static HTML document is prose plus ' +
          'blocks, and the prose half belongs to the export milestone. The block half is ' +
          'available now through toSVG (pass `{ svg: toSvgString }` from @mdv/render-svg).',
      ),
    );
  }

  /**
   * Export to PDF through the direct exporter (SPEC 28.1) — the same {@link Scene}
   * that draws the screen emits the PDF, so a chart cannot look different.
   */
  async toPDF(source: string, opts?: PdfOptions): Promise<Uint8Array> {
    void source;
    void opts;
    // Legitimately unimplemented: the direct PDF exporter is `@mdv/render-pdf`,
    // which is a separate milestone and a separate package. Core keeps the
    // signature so the facade's shape does not change when it lands.
    return Promise.reject(
      new Error(
        'Mdv#toPDF is not implemented yet: the direct PDF exporter (SPEC 28) lives in ' +
          '@mdv/render-pdf, which is not finished. This is a missing milestone, not a ' +
          'missing capability — no configuration will enable it.',
      ),
    );
  }

  /**
   * Parse, resolve and validate without rendering.
   *
   * @returns every diagnostic, in document order, with `strict` already applied
   */
  async lint(source: string): Promise<Diagnostic[]> {
    const doc = parse(source);
    const resolved = await resolve(doc, this.#config);
    const registry = registryFromPlugins(this.#config);
    const strict = resolved.config.strict;

    // Parse diagnostics are not in `resolved.diagnostics`: `resolve` starts at
    // stage 2 and the parser has already reported by then. A lint that dropped
    // them would call a document with a broken fence clean.
    const found: Diagnostic[] = [
      ...doc.diagnostics.map((d) => applyStrict(d, strict)),
      ...resolved.diagnostics,
    ];

    // Stage 3. `layoutBlock` runs `ChartType.validate` itself, so this is the
    // only place a document that is never laid out gets validated at all.
    for (const block of resolved.blocks) {
      for (const d of validateBlock(block, registry)) found.push(applyStrict(d, strict));
    }

    return dedupe(found).sort(compareDiagnostics);
  }

  /**
   * Canonical formatting (SPEC 27). Idempotent, and MUST NOT change the resolved
   * AST. Synchronous: formatting never fetches.
   */
  format(source: string, opts?: FormatOptions): string {
    // The canonical printer is the parser's, because "MUST NOT change the
    // resolved AST" is only checkable by the half of the system that owns the
    // AST. Core adds nothing here and deliberately does not wrap it: a second
    // formatter would be a second answer to what canonical means.
    return toMarkdown(parse(source), opts);
  }
}

/** Fluid blocks need a width to export at; SPEC 23.3's `toHTML` uses the same one. */
const DEFAULT_EXPORT_WIDTH = 800;

/**
 * The height one block exports at.
 *
 * `height:` is an attribute (SPEC 8.1) and `resolveDimension` is the shared
 * reader, but an export has no container to resolve a percentage against, so a
 * non-numeric height falls back to the same 300 the SPEC's own worked example
 * puts in `defaults:`.
 */
function exportHeight(block: ResolvedBlock): number {
  const declared: unknown = block.attrs.height;
  return typeof declared === 'number' && Number.isFinite(declared) && declared > 0 ? declared : 300;
}

/**
 * Drop diagnostics that two stages both reported.
 *
 * `resolve` and `validateBlock` overlap on nothing today, but `lint` merges
 * three independent lists and a duplicate in a lint report is a bug report from
 * a user. Keyed on the tuple that identifies a finding, not on object identity.
 */
function dedupe(diagnostics: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    const key = `${d.code}\u0000${d.range.start.offset}\u0000${d.range.end.offset}\u0000${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage entry points used by the CLI, the LSP and the React binding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stage 3 (SPEC 18): validate one resolved block.
 *
 * Schema check, channel/type compatibility, security limits. Produces `fixes`
 * for the LSP.
 */
export function validateBlock(block: ResolvedBlock, registry?: ChartTypeRegistry): Diagnostic[] {
  // ARITY, as for `layoutBlock`: SPEC 21 spells this `validateBlock(block)`, but
  // semantic validation *is* `ChartType.validate`, and there is no global
  // registry to find the type in (SPEC 17.3 invariant 4 forbids one). The
  // optional second parameter is a superset — every one-argument call still
  // typechecks — and without it the function can only ever return `[]`.
  //
  // With no registry there is nothing to validate against, and inventing
  // diagnostics from the attribute names alone would duplicate the JSON Schema
  // in `@mdv/spec`. Returning `[]` says "no findings", which is the truth.
  if (registry === undefined) return [];
  const type = registry.get(block.blockType);

  if (type === undefined) {
    // MDV1500 is a warning, never an error: "a document using a Level 3 type
    // must stay readable in a Level 1 reader" (SPEC 15.2). It is emitted here
    // and not in `resolve`, because `layoutBlock` emits its own when it falls
    // back to the table — reporting it in resolve too would double-count it on
    // the render path, and `lint`, which never lays out, would still miss it if
    // it were only in layout.
    return [
      createDiagnostic('MDV1500', {
        range: block.range,
        source: 'render',
        blockId: block.id,
        message: `Unknown block type \`${block.blockType}\` — rendered as a table`,
        detail: `Known types: ${registry
          .list()
          .map((t) => t.name)
          .join(', ')}.`,
      }),
    ];
  }

  // A chart type is third-party code. Validation that throws must not take the
  // document with it (SPEC 14.1 principle 4), so the throw becomes MDV5000 on
  // the block and the rest of the document still lints.
  try {
    return [...type.validate(block, block.table)];
  } catch (error) {
    return [
      createDiagnostic('MDV5000', {
        range: block.range,
        source: 'render',
        blockId: block.id,
        message: `\`${block.blockType}\` validation threw: ${errorText(error)}`,
        detail: 'This is a bug in the chart type, not in the document.',
      }),
    ];
  }
}

/** A thrown value as one line, without assuming it is an `Error`. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build a {@link LayoutContext} from a resolved document and a block.
 *
 * The one supported way to construct a context: it wires the resolved theme, the
 * metrics provider from {@link Capabilities}, the pinned `buildTime`, and a fresh
 * {@link IdFactory} seeded with the block's index, so ids are
 * `mdv-{blockIndex}-{counter}` (SPEC 24.3 rule 7).
 */
export function createLayoutContext(
  doc: ResolvedDocument,
  block: ResolvedBlock,
  onDiagnostic?: (d: Diagnostic) => void,
): LayoutContextWithRegistry {
  const config = doc.config;
  const context = makeLayoutContext({
    // The block's own theme, which resolve already narrowed from the document's
    // by any per-block `theme:` override.
    theme: block.theme,
    // SPEC 24.3 rule 7. `ResolvedBlock.index` is documented as "0-based position
    // among the document's visual blocks. Drives the id scheme", and
    // `makeLayoutContext` turns it into `createIdFactory(blockIndex)`, whose
    // prefix is `'mdv-' + Math.trunc(blockIndex)` and whose `next()` appends
    // `-{counter}`. So the ids really are `mdv-{blockIndex}-{counter}`, and this
    // is a verified delegation rather than an alias.
    blockIndex: block.index,
    metrics: config.capabilities.metrics ?? defaultTableMetrics,
    locale: config.locale,
    timezone: config.timezone,
    level: config.level,
    buildTime: config.buildTime,
    colorScheme: config.colorScheme,
    a11y: config.a11y,
    animate: config.render.animate,
    // `exactOptionalPropertyTypes`: an absent sink and a sink of `undefined` are
    // different types here, so the key is omitted rather than set to undefined.
    ...(onDiagnostic !== undefined ? { onDiagnostic } : {}),
  });

  // The chart types this document was resolved under, carried on the context.
  //
  // This is what makes SPEC 21's three-argument `layoutBlock(block, size, ctx)`
  // work rather than render every block as an unknown-type table: the signature
  // has nowhere to name a registry, there is no global one (SPEC 17.3 invariant
  // 4), and `LayoutContextWithRegistry` is the shim `layout/block.ts` already
  // declared for exactly this. The return type widens to that shim, which is a
  // superset of `LayoutContext`, so nothing that used the old type breaks.
  //
  // Rebuilt per call rather than memoised on the document: a module-level cache
  // is shared mutable state between two `Mdv` instances, which is the one thing
  // invariant 4 forbids outright, and registering a handful of chart types costs
  // a few map writes.
  return { ...context, registry: registryFromPlugins(configOf(doc)) };
}

/**
 * The plugin list a resolved document was built with.
 *
 * `ResolvedConfig` keeps `plugins` verbatim, so the registry `createLayoutContext`
 * builds is the same one `resolve` validated — including the `MdvConfigError` it
 * would have thrown for a malformed entry, which by this point cannot happen.
 */
function configOf(doc: ResolvedDocument): MdvConfig {
  return { plugins: doc.config.plugins };
}

// `createTableMetrics` — the deterministic text-metrics provider of SPEC 21 and
// SPEC 24.3 rule 6 — is re-exported from './metrics/index.js' above. The stub
// that used to stand here shadowed a complete, tested implementation.

/** Parse options accepted by the facade, re-exported for convenience. */
export type { ParseOptions as MdvParseOptions };

/**
 * `MdvDocument` (AST) → `ResolvedDocument` — SPEC 18 stage 2, composed.
 *
 * ### Why this lives here
 *
 * `@mdv/core`'s `resolve` / `resolveSync` are still stubs that throw
 * `not implemented`, and `packages/core/src/resolve.ts` says why:
 *
 * > The attribute cascade, encoding normalisation and theme resolution that
 * > complete a `ResolvedBlock` are not here … **The facade composes the three.**
 *
 * Nothing composes them yet. Rather than render nothing, the React binding does
 * the composition itself, out of the three real pieces:
 *
 * | Piece | Owner |
 * |---|---|
 * | data resolution | `@mdv/core/resolve.js` — `resolveDocumentData(Sync)` |
 * | attribute cascade + encoding split | `./cascade.js` (SPEC 5.5, 7.1) |
 * | theme resolution | `@mdv/themes` — `resolveColorScheme`, `resolveTheme` |
 *
 * This should move into `core`'s facade wholesale; it is deliberately written as
 * a standalone function over public inputs so that move is a cut-and-paste.
 *
 * No DOM, no clock, no network of its own: everything impure arrives through
 * `MdvConfig.capabilities`, exactly as core's would.
 */

import type {
  BlockAttrs,
  Diagnostic,
  MdvConfig,
  Range,
  ResolvedBlock,
  ResolvedConfig,
  ResolvedDocument,
  Theme,
  ThemeOverride,
} from '@mdv/core';
import type { AttrMap, MdvBlock, MdvDocument } from '@mdv/parser';
import {
  dataOptionsFrom,
  resolveDocumentData,
  resolveDocumentDataSync,
} from '@mdv/core/resolve.js';
import type { DocumentData, ResolvedBlockData } from '@mdv/core/resolve.js';
import { createCollector, rangeOfNode } from '@mdv/core/data/diag.js';
import { getBuiltinTheme, isBuiltinThemeName, resolveColorScheme, resolveTheme } from '@mdv/themes';
import type { ColorScheme, ColorSchemePreference } from '@mdv/core';
import { BUILTIN_DEFAULTS, cascade, splitAttrs } from './cascade.js';

/** Everything composition needs beyond the configuration itself. */
export interface ComposeOptions {
  config?: MdvConfig | undefined;
  /**
   * The host's `prefers-color-scheme`, sampled by the caller.
   *
   * Passed in rather than read here for the same reason `@mdv/themes` takes it:
   * a media query inside the pipeline would make the resolved document depend on
   * the machine that rendered it (SPEC 24.3 rule 3).
   */
  prefersDark?: boolean | undefined;
  /** The document's base URI; a relative `src:` resolves against it (SPEC 6.4). */
  baseUri?: string | undefined;
  /**
   * `true` when an asynchronous resolve of the same document is already running.
   *
   * Only meaningful for {@link composeSync}. A synchronous resolve cannot fetch,
   * so a block with `src:` normally ends `blocked` with `MDV4001` and shows its
   * error card. When the caller has *already started* the async pass, that
   * diagnostic is not true — the data is loading, not refused — and SPEC 6.4
   * requires a **placeholder for every non-ready state**, not a failure. So the
   * block is marked pending ({@link isPending}), `MDV4001` is withheld, and the
   * host renders a correctly-sized placeholder until the fetch lands.
   *
   * This is what lets one code path serve the server render and the hydration
   * render: both produce the placeholder, so the markup matches, and only the
   * post-hydration update fills it in (SPEC 22.3).
   */
  externalPending?: boolean | undefined;
}

/**
 * Blocks whose data is still on its way.
 *
 * Per-object metadata rather than a field on `ResolvedBlock`: the type is a
 * shared contract owned by `@mdv/core` and this is a fact about *this* resolve,
 * not about the block. A `WeakSet` holds nothing alive.
 */
const PENDING = new WeakSet<ResolvedBlock>();

/** `true` when this block is waiting on an external fetch (SPEC 6.4). */
export function isPending(block: ResolvedBlock): boolean {
  return PENDING.has(block);
}

// ─────────────────────────────────────────────────────────────────────────────
// Theme
// ─────────────────────────────────────────────────────────────────────────────

/** `true` for an object that is already a fully resolved {@link Theme}. */
function isTheme(value: unknown): value is Theme {
  return (
    typeof value === 'object' &&
    value !== null &&
    'tokens' in value &&
    'categorical' in value &&
    'marks' in value
  );
}

/** The document's own scheme preference, if it stated one. */
function documentSchemePreference(
  front: MdvDocument['frontmatter'],
): ColorSchemePreference | undefined {
  if (front === undefined) return undefined;
  const theme = front.theme;
  if (typeof theme === 'string') {
    if (theme === 'dark') return 'dark';
    if (theme === 'default' || theme === 'print' || theme === 'high-contrast') return 'light';
  } else if (theme !== undefined) {
    const scheme = theme['scheme'];
    if (scheme === 'dark' || scheme === 'light' || scheme === 'auto') return scheme;
  }
  const explicit = front.extra['colorScheme'];
  if (explicit === 'dark' || explicit === 'light' || explicit === 'auto') return explicit;
  return undefined;
}

/** Read a `ThemeOverride` out of a front-matter `theme:` mapping. */
function overrideFromAttrs(map: AttrMap): ThemeOverride {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(map)) {
    if (
      key === 'extends' ||
      key === 'name' ||
      key === 'scheme' ||
      key === 'tokens' ||
      key === 'categorical' ||
      key === 'sequential' ||
      key === 'diverging' ||
      key === 'font' ||
      key === 'metrics'
    ) {
      out[key] = map[key];
    }
  }
  return out as ThemeOverride;
}

/**
 * Resolve the document theme (SPEC 11.6, 11.7).
 *
 * Precedence for the *scheme* is SPEC 11.7's: block, then document, then
 * embedder, then the host. Precedence for the *theme* is the embedder's over the
 * document's, for the same reason configuration outranks `defaults:` — an
 * embedder enforcing a house style must win (SPEC 25).
 *
 * An unknown theme name is host programmer error only when the embedder wrote
 * it; when the *document* wrote it we fall back to the scheme default rather
 * than throwing, because a document must never be able to crash its reader.
 */
function resolveDocumentTheme(
  doc: MdvDocument,
  config: MdvConfig | undefined,
  prefersDark: boolean | undefined,
): { theme: Theme; scheme: ColorScheme } {
  const scheme = resolveColorScheme({
    document: documentSchemePreference(doc.frontmatter),
    embedder: config?.colorScheme,
    prefersDark,
  });

  const configured = config?.theme;
  if (isTheme(configured)) return { theme: configured, scheme: configured.scheme };
  if (typeof configured === 'string') {
    // Embedder-supplied: `resolveTheme` throws `MdvConfigError` for an unknown
    // name, which is right — this is host programmer error (SPEC 21).
    return { theme: resolveTheme({ extends: configured }, scheme), scheme };
  }
  if (configured !== undefined) return { theme: resolveTheme(configured, scheme), scheme };

  const front = doc.frontmatter?.theme;
  if (typeof front === 'string') {
    const theme = isBuiltinThemeName(front) ? getBuiltinTheme(front) : undefined;
    return { theme: theme ?? getBuiltinTheme(scheme === 'dark' ? 'dark' : 'default'), scheme };
  }
  if (front !== undefined) {
    try {
      return { theme: resolveTheme(overrideFromAttrs(front), scheme), scheme };
    } catch {
      // A document's own theme mapping naming an unknown base is a document
      // problem, not host programmer error: fall back and keep rendering.
      return { theme: getBuiltinTheme(scheme === 'dark' ? 'dark' : 'default'), scheme };
    }
  }
  return { theme: getBuiltinTheme(scheme === 'dark' ? 'dark' : 'default'), scheme };
}

/** A per-block `theme:` override (SPEC 5.5 level 6). Falls back to the document's. */
function blockTheme(attrs: BlockAttrs, documentTheme: Theme): Theme {
  const name = attrs.theme;
  if (typeof name !== 'string' || name === '') return documentTheme;
  if (name === documentTheme.name) return documentTheme;
  return isBuiltinThemeName(name) ? getBuiltinTheme(name) : documentTheme;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** SPEC 25 defaults, applied once so nothing downstream re-derives them. */
function resolvedConfig(
  config: MdvConfig | undefined,
  doc: MdvDocument,
  theme: Theme,
  scheme: ColorScheme,
): ResolvedConfig {
  const front = doc.frontmatter;
  const options = dataOptionsFrom(config, doc);
  const defaults: Partial<BlockAttrs> = config?.defaults ?? {};
  return {
    level: config?.level ?? 2,
    strict: config?.strict ?? false,
    theme,
    colorScheme: scheme,
    locale: config?.locale ?? front?.locale ?? front?.lang ?? 'en-US',
    timezone: config?.timezone ?? front?.timezone ?? 'UTC',
    buildTime: options.buildTime,
    defaults,
    security: {
      allowExternal: config?.security?.allowExternal ?? false,
      allowedOrigins: config?.security?.allowedOrigins ?? [],
      allowHtml: config?.security?.allowHtml ?? false,
      allowFileUrls: config?.security?.allowFileUrls ?? false,
      maxDocumentBytes: options.limits.maxDocumentBytes,
      maxRowsPerBlock: options.limits.maxRowsPerBlock,
      fetchTimeoutMs: options.limits.fetchTimeoutMs,
    },
    render: {
      target: config?.render?.target ?? 'auto',
      canvasThreshold: config?.render?.canvasThreshold ?? 5000,
      downsampleThreshold: config?.render?.downsampleThreshold ?? 4000,
      animate: config?.render?.animate ?? true,
      renderPolicy: config?.render?.renderPolicy ?? 'lazy',
      worker: config?.render?.worker ?? false,
    },
    a11y: {
      texture: config?.a11y?.texture ?? false,
      tableView: config?.a11y?.tableView ?? 'details',
      generateDesc: config?.a11y?.generateDesc ?? true,
    },
    plugins: config?.plugins ?? [],
    capabilities: config?.capabilities ?? {},
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks
// ─────────────────────────────────────────────────────────────────────────────

/** `true` when `inner` lies within `outer`, by absolute offset (SPEC 14.4). */
function withinRange(outer: Range, inner: Range): boolean {
  return inner.start.offset >= outer.start.offset && inner.start.offset < outer.end.offset;
}

/**
 * Promote warnings to errors under `strict: true` (SPEC 14.3).
 *
 * A copy, never a mutation: the same diagnostic object may already have been
 * handed to `MdvConfig.onDiagnostic`.
 */
function applyStrictness(
  diagnostics: readonly Diagnostic[],
  strict: boolean,
): readonly Diagnostic[] {
  if (!strict) return diagnostics;
  return diagnostics.map((d) =>
    d.severity === 'warning' ? { ...d, severity: 'error' as const } : d,
  );
}

/** Diagnostics ordered by source position, then by code — a total order. */
function bySourceOrder(a: Diagnostic, b: Diagnostic): number {
  const byOffset = a.range.start.offset - b.range.start.offset;
  if (byOffset !== 0) return byOffset;
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

/** Build one `ResolvedBlock` from its AST node and its resolved data. */
function buildBlock(
  entry: ResolvedBlockData,
  documentDefaults: AttrMap | undefined,
  configDefaults: Partial<BlockAttrs>,
  documentTheme: Theme,
  scheme: ColorScheme,
  diagnostics: readonly Diagnostic[],
  strict: boolean,
  externalPending: boolean,
): ResolvedBlock {
  const node: MdvBlock = entry.block;
  const range = rangeOfNode(node);

  // `MDV4001` says "a synchronous resolve cannot fetch this". When the async
  // pass is already running, that is not what happened, so the diagnostic is
  // withheld and the block is marked pending instead (see `externalPending`).
  const pending = externalPending && entry.state === 'blocked' && entry.reason === 'MDV4001';

  const merged = cascade(
    BUILTIN_DEFAULTS,
    documentDefaults,
    configDefaults as AttrMap,
    // Levels 5 and 6, already merged by the parser with the header winning.
    node.attrs,
  );
  const { attrs, encoding } = splitAttrs(merged);

  const id = typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : `mdv-${entry.index}`;
  const own = applyStrictness(
    diagnostics.filter(
      (d) =>
        !(pending && d.code === 'MDV4001') &&
        (d.blockId === undefined ? withinRange(range, d.range) : d.blockId === id),
    ),
    strict,
  );

  // A dataset that never arrived cannot be drawn: the block shows its error card
  // with the raw source rather than an empty frame (SPEC 14.1 principle 2).
  const dataFailed = !pending && (entry.state === 'failed' || entry.state === 'blocked');

  const block: ResolvedBlock = {
    id,
    index: entry.index,
    blockType: node.blockType,
    level: node.level,
    attrs,
    encoding,
    table: entry.table,
    tableRef: entry.ref,
    node,
    range,
    theme: blockTheme(attrs, documentTheme),
    diagnostics: own,
    failed: dataFailed || own.some((d) => d.severity === 'error'),
  };
  if (pending) PENDING.add(block);
  return block;
}

/** Assemble the document from its data half and its theme half. */
function assemble(doc: MdvDocument, data: DocumentData, options: ComposeOptions): ResolvedDocument {
  const { theme, scheme } = resolveDocumentTheme(doc, options.config, options.prefersDark);
  const config = resolvedConfig(options.config, doc, theme, scheme);

  const externalPending = options.externalPending === true;

  // Parse diagnostics live on the AST; data diagnostics come back from resolve.
  // Both refer to the original document, so one sorted list is meaningful.
  const all = applyStrictness([...doc.diagnostics, ...data.diagnostics], config.strict);
  const ordered = [...all]
    .filter((d) => !(externalPending && d.code === 'MDV4001'))
    .sort(bySourceOrder);

  const blocks = data.blocks.map((entry) =>
    buildBlock(
      entry,
      doc.frontmatter?.defaults,
      config.defaults,
      theme,
      scheme,
      ordered,
      config.strict,
      externalPending,
    ),
  );

  return {
    ast: doc,
    ...(doc.frontmatter !== undefined ? { frontmatter: doc.frontmatter } : {}),
    blocks,
    datasets: data.registry,
    diagnostics: ordered,
    theme,
    config,
  };
}

/**
 * Resolve a parsed document synchronously — for server rendering (SPEC 22.3).
 *
 * Cannot fetch: a block with `src:` gets `MDV4001` and renders its error card,
 * which is exactly what `resolveSync` promises — unless
 * {@link ComposeOptions.externalPending} says an async pass is already running,
 * in which case the block is pending and renders a placeholder instead.
 */
export function composeSync(doc: MdvDocument, options: ComposeOptions = {}): ResolvedDocument {
  const dataOptions = dataOptionsFrom(options.config, doc);
  const collector = createCollector('data', undefined, {
    ...(options.config?.onDiagnostic !== undefined ? { onEmit: options.config.onDiagnostic } : {}),
  });
  const data = resolveDocumentDataSync(
    doc,
    { ...dataOptions, baseUri: options.baseUri },
    collector,
  );
  return assemble(doc, data, options);
}

/** Resolve a parsed document, fetching `src:` through the injected capabilities. */
export async function compose(
  doc: MdvDocument,
  options: ComposeOptions = {},
): Promise<ResolvedDocument> {
  const dataOptions = dataOptionsFrom(options.config, doc);
  const collector = createCollector('data', undefined, {
    ...(options.config?.onDiagnostic !== undefined ? { onEmit: options.config.onDiagnostic } : {}),
  });
  const data = await resolveDocumentData(
    doc,
    { ...dataOptions, baseUri: options.baseUri },
    collector,
  );
  return assemble(doc, data, options);
}

/** `true` when the document needs the async path — i.e. something has a `src:`. */
export function needsFetch(doc: MdvDocument): boolean {
  let found = false;
  const front = doc.frontmatter?.datasets;
  if (front !== undefined) {
    for (const key of Object.keys(front)) {
      const value = front[key];
      if (typeof value === 'string') {
        found = found || !value.startsWith('@');
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        found = found || (value as AttrMap)['src'] !== undefined;
      }
    }
  }
  if (found) return true;

  const walk = (nodes: readonly unknown[] | undefined): void => {
    if (nodes === undefined) return;
    for (const raw of nodes) {
      const node = raw as { type?: string; attrs?: AttrMap; children?: readonly unknown[] };
      if (node.type === 'mdvBlock' && node.attrs?.['src'] !== undefined) found = true;
      walk(node.children);
    }
  };
  walk(doc.children as readonly unknown[]);
  return found;
}

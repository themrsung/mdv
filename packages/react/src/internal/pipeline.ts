/**
 * The memoised pipeline (SPEC 18, SPEC 24.2).
 *
 * > **Memoise by content hash** at every stage boundary; a 64-bit FNV-1a over
 * > the canonical stage input.
 *
 * Three memos, one per stage boundary:
 *
 * | Memo | Key | Invalidated by |
 * |---|---|---|
 * | `parse` | the source text + parse options | an edit |
 * | `resolve` | the parsed document's identity + the config | an edit, a config change |
 * | `scene` | the block's content + the box + the layout context | an edit *to that block*, a resize, a theme change |
 *
 * That layering is what makes the two behaviours the binding is judged on fall
 * out for free:
 *
 * - **A resize re-runs stages 6–7 only.** The size is part of the scene key and
 *   of nothing above it, so a `ResizeObserver` storm cannot reach the parser.
 * - **Editing one block's title does not re-lay-out the others.** The scene key
 *   is derived from *that block's* content, so its siblings hit their memos even
 *   though the whole document was re-parsed.
 *
 * A table's content hash is computed once per `Table` *object* and cached in a
 * `WeakMap`. Hashing ten thousand rows on every animation frame of a window drag
 * would cost more than the layout it is meant to skip; hashing them once per
 * resolve is the same order as the resolve itself.
 *
 * **Nothing here is module-level state** (SPEC 17.3 invariant 4). A `Caches` is
 * created by the provider, or by a lone component, and two documents never share
 * one.
 */

import type {
  ChartTypeRegistry,
  ColorScheme,
  ConformanceLevel,
  Diagnostic,
  LayoutContext,
  ResolvedBlock,
  ResolvedDocument,
  Scene,
  Size,
  Table,
  TextMetrics,
  Theme,
} from '@mdv/core';
import type { MdvDocument, ParseOptions } from '@mdv/parser';
import { parse } from '@mdv/parser';
import { layoutBlock, makeLayoutContext } from '@mdv/core/layout/index.js';
import { contentHash, hashString } from './hash.js';
import { Lru } from './lru.js';
import { compose, composeSync, type ComposeOptions } from './compose.js';

/** Counters, so a test can assert that a resize did not reach the parser. */
export interface PipelineStats {
  parses: number;
  resolves: number;
  layouts: number;
  tableHashes: number;
}

/** Sizing for the three memos. */
export interface CacheOptions {
  /** Parsed documents to retain. @defaultValue 4 */
  maxParsed?: number;
  /** Resolved documents to retain. @defaultValue 4 */
  maxResolved?: number;
  /** Scenes to retain. One document of ~50 blocks at two sizes. @defaultValue 128 */
  maxScenes?: number;
}

/** The memo set for one provider (or one standalone block). */
export interface Caches {
  readonly parsed: Lru<MdvDocument>;
  readonly resolved: Lru<ResolvedDocument>;
  readonly scenes: Lru<Scene>;
  /** Content hash per `Table` object, computed at most once each. */
  readonly tableKeys: WeakMap<Table, string>;
  /** Content hash per `ResolvedBlock` object, computed at most once each. */
  readonly blockKeys: WeakMap<ResolvedBlock, string>;
  readonly stats: PipelineStats;
}

/** Create a fresh, unshared memo set. */
export function createCaches(options: CacheOptions = {}): Caches {
  return {
    parsed: new Lru<MdvDocument>(options.maxParsed ?? 4),
    resolved: new Lru<ResolvedDocument>(options.maxResolved ?? 4),
    scenes: new Lru<Scene>(options.maxScenes ?? 128),
    tableKeys: new WeakMap<Table, string>(),
    blockKeys: new WeakMap<ResolvedBlock, string>(),
    stats: { parses: 0, resolves: 0, layouts: 0, tableHashes: 0 },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 1 — parse
// ─────────────────────────────────────────────────────────────────────────────

/** Parse, memoised on the source text and the options that change its meaning. */
export function parseCached(
  caches: Caches,
  source: string,
  options: ParseOptions = {},
): MdvDocument {
  const key = contentHash('parse', hashString(source), source.length, options);
  const hit = caches.parsed.get(key);
  if (hit !== undefined) return hit;
  caches.stats.parses += 1;
  return caches.parsed.set(key, parse(source, options));
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage 2 — resolve
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The part of a configuration that changes a *resolved document*.
 *
 * Deliberately not the whole config: `onDiagnostic` is a fresh closure on every
 * render and `capabilities` holds functions, so hashing them by value would make
 * the memo never hit. Both are identity-carried instead — a caller that swaps a
 * `fetch` implementation must also change something in this list, and in
 * practice does.
 */
function configKey(options: ComposeOptions): string {
  const c = options.config;
  return contentHash(
    'config',
    c?.level,
    c?.strict,
    typeof c?.theme === 'string'
      ? c.theme
      : c?.theme === undefined
        ? undefined
        : ((c.theme as { name?: string }).name ?? c.theme),
    c?.colorScheme,
    c?.locale,
    c?.timezone,
    c?.buildTime,
    c?.defaults,
    c?.security,
    c?.render,
    c?.a11y,
    options.prefersDark,
    options.baseUri,
    options.externalPending,
  );
}

/** Resolve synchronously, memoised. Used for SSR and for documents with no `src:`. */
export function resolveCachedSync(
  caches: Caches,
  doc: MdvDocument,
  options: ComposeOptions,
  sourceKey: string,
): ResolvedDocument {
  const key = contentHash('resolve', sourceKey, configKey(options));
  const hit = caches.resolved.get(key);
  if (hit !== undefined) return hit;
  caches.stats.resolves += 1;
  return caches.resolved.set(key, composeSync(doc, options));
}

/** Resolve asynchronously, memoised. Fetches `src:` through the capabilities. */
export async function resolveCached(
  caches: Caches,
  doc: MdvDocument,
  options: ComposeOptions,
  sourceKey: string,
): Promise<ResolvedDocument> {
  const key = contentHash('resolve', sourceKey, configKey(options));
  const hit = caches.resolved.get(key);
  if (hit !== undefined) return hit;
  caches.stats.resolves += 1;
  const document = await compose(doc, options);
  return caches.resolved.set(key, document);
}

// ─────────────────────────────────────────────────────────────────────────────
// Content keys
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A table's content hash, computed once per object.
 *
 * Row-major over the declared fields, so two tables with the same numbers in a
 * different column order hash differently — they *are* different, and the
 * encoder will bind them differently.
 */
export function tableKey(caches: Caches, table: Table): string {
  const cached = caches.tableKeys.get(table);
  if (cached !== undefined) return cached;
  caches.stats.tableHashes += 1;
  const key = contentHash('table', table.fields, table.rows);
  caches.tableKeys.set(table, key);
  return key;
}

/**
 * A block's content hash: everything `layoutBlock` can read except the box.
 *
 * The AST node is *not* part of it. Its `position` changes when text above the
 * block changes, which would invalidate a block whose own content is untouched —
 * the exact case the memo exists to serve. The one thing layout reads off the
 * node is the raw source for the error card, and that is only reachable when the
 * block already carries an error, which the diagnostic list covers.
 */
export function blockKey(caches: Caches, block: ResolvedBlock): string {
  const cached = caches.blockKeys.get(block);
  if (cached !== undefined) return cached;
  const key = contentHash(
    'block',
    block.blockType,
    block.level,
    block.attrs,
    block.encoding,
    block.theme.name,
    block.theme.scheme,
    block.failed,
    block.diagnostics.map((d) => [d.code, d.severity, d.message]),
    block.failed ? block.node.raw.header + block.node.raw.data : '',
    tableKey(caches, block.table),
  );
  caches.blockKeys.set(block, key);
  return key;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stages 6–7 — layout
// ─────────────────────────────────────────────────────────────────────────────

/** Everything a layout needs that is not the block or the box. */
export interface LayoutSettings {
  theme: Theme;
  metrics: TextMetrics;
  locale: string;
  timezone: string;
  level: ConformanceLevel;
  buildTime: Date;
  colorScheme: ColorScheme;
  a11y: {
    texture: boolean;
    tableView: 'details' | 'visible' | 'hidden' | 'none';
    generateDesc: boolean;
  };
  animate: boolean;
}

/** A laid-out block: the scene, plus whatever layout had to say about it. */
export interface LayoutOutcome {
  scene: Scene;
  diagnostics: readonly Diagnostic[];
  /** `false` when the scene came out of the memo — useful in tests and in dev tools. */
  computed: boolean;
}

/**
 * Lay one block out, memoised on (block content, box, layout settings).
 *
 * Diagnostics are memoised with the scene. Layout is pure, so re-running it
 * would produce the same list; replaying the stored one keeps `onDiagnostics`
 * stable across a resize instead of re-announcing every `MDV5011`.
 */
export function layoutCached(
  caches: Caches,
  block: ResolvedBlock,
  size: Size,
  settings: LayoutSettings,
  registry: ChartTypeRegistry | undefined,
): LayoutOutcome {
  const key = contentHash(
    'scene',
    blockKey(caches, block),
    block.id,
    block.index,
    size.width,
    size.height,
    settings.theme.name,
    settings.colorScheme,
    settings.locale,
    settings.timezone,
    settings.level,
    settings.buildTime,
    settings.a11y,
    settings.animate,
    registryKey(registry),
  );

  const hit = caches.scenes.get(key);
  if (hit !== undefined) {
    return { scene: hit, diagnostics: diagnosticsOf(hit), computed: false };
  }

  const collected: Diagnostic[] = [];
  const ctx: LayoutContext = makeLayoutContext({
    theme: settings.theme,
    blockIndex: block.index,
    metrics: settings.metrics,
    locale: settings.locale,
    timezone: settings.timezone,
    level: settings.level,
    buildTime: settings.buildTime,
    colorScheme: settings.colorScheme,
    a11y: settings.a11y,
    animate: settings.animate,
    onDiagnostic: (d) => collected.push(d),
  });

  caches.stats.layouts += 1;
  const scene = layoutBlock(block, size, ctx, registry);
  attachDiagnostics(scene, collected);
  caches.scenes.set(key, scene);
  return { scene, diagnostics: collected, computed: true };
}

/**
 * Layout diagnostics ride along with their scene.
 *
 * A `WeakMap` rather than a field on `Scene`: the scene type is a published IR
 * (SPEC 20) and must stay structured-clone-safe and free of anything a backend
 * could be tempted to read.
 */
const SCENE_DIAGNOSTICS = new WeakMap<Scene, readonly Diagnostic[]>();

function attachDiagnostics(scene: Scene, diagnostics: readonly Diagnostic[]): void {
  SCENE_DIAGNOSTICS.set(scene, diagnostics);
}

/** The diagnostics produced when this scene was laid out. */
export function diagnosticsOf(scene: Scene): readonly Diagnostic[] {
  return SCENE_DIAGNOSTICS.get(scene) ?? [];
}

/**
 * A registry's identity, for the scene key.
 *
 * The list of registered names, not the registry object: a provider that rebuilds
 * an identical registry on every render must still hit the memo, and two
 * registries that differ by one plugin must not.
 */
const REGISTRY_KEYS = new WeakMap<ChartTypeRegistry, string>();

function registryKey(registry: ChartTypeRegistry | undefined): string {
  if (registry === undefined) return 'none';
  const cached = REGISTRY_KEYS.get(registry);
  if (cached !== undefined) return cached;
  const key = contentHash(
    'registry',
    registry.list().map((t) => [t.name, t.level]),
  );
  REGISTRY_KEYS.set(registry, key);
  return key;
}

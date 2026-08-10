/**
 * Configuration and capabilities (SPEC 25).
 *
 * Configuration merges: built-in defaults ← embedder config ← front matter (only
 * for keys a document is permitted to set). **`security` is never
 * document-settable.**
 *
 * Everything impure is injected through {@link Capabilities}, which is what keeps
 * `@mdv/core` portable and testable (SPEC 17.3 invariant 1: core never touches
 * the DOM, the filesystem, the network, or the clock). Omitting a capability
 * disables the features that need it, **with a diagnostic rather than a crash**.
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { Diagnostic } from '@mdv/parser';
import type { BlockAttrs } from './attrs.js';
import type { TextMetrics } from './layout.js';
import type { Scene } from './scene.js';
import type { ColorSchemePreference, Theme, ThemeOverride } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities (SPEC 25.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Request options handed to {@link Capabilities.fetch}. */
export interface FetchInit {
  /** Always `'GET'` in v1.0; MDV never mutates a remote resource. */
  method: 'GET';
  headers?: Readonly<Record<string, string>>;
  /** From `security.fetchTimeoutMs`. The capability MUST honour it. */
  timeoutMs?: number;
  /** Maximum redirects the capability may follow (SPEC 13.6). */
  maxRedirects?: number;
  signal?: AbortSignal;
}

/** Response handed back by {@link Capabilities.fetch}. */
export interface FetchResult {
  status: number;
  /** Selects the data format unless `format:` overrides it (SPEC 6.4). */
  contentType?: string;
  /** The final URL after redirects, re-checked against the allowlist. */
  url: string;
  body: Uint8Array;
}

/** A content cache (SPEC 6.4: content is cached by URL for `cacheTtl`). */
export interface KeyValueCache {
  get(key: string): Promise<Uint8Array | undefined> | Uint8Array | undefined;
  set(key: string, value: Uint8Array, ttlSeconds?: number): Promise<void> | void;
  delete(key: string): Promise<void> | void;
}

/** A diagnostic sink for the host. Never used for document diagnostics. */
export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

/**
 * The four doors out of `@mdv/core` (SPEC 25.2).
 *
 * A capability that is absent is not an error: the feature that needs it is
 * disabled and a diagnostic explains why (`MDV4002` for external data with no
 * `fetch`, and so on).
 */
export interface Capabilities {
  /** Network. Absent ⇒ `src:` with an absolute URL is refused. */
  fetch?: (url: string, init: FetchInit) => Promise<FetchResult>;
  /** Filesystem. Absent ⇒ `src:` with a relative path is refused. */
  readFile?: (path: string) => Promise<Uint8Array>;
  /** Text measurement. Absent ⇒ core falls back to the deterministic width table. */
  metrics?: TextMetrics;
  cache?: KeyValueCache;
  logger?: Logger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugins (SPEC 26)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A plugin (SPEC 26.1). A plugin adds *declarative capability*: its chart type is
 * a pure function to a scene graph like any built-in, so it automatically gets
 * PDF export, the table view, keyboard interaction and determinism testing.
 *
 * A plugin that wants to draw its own DOM is out of scope by design.
 *
 * The member types are intentionally structural here to avoid a circular import
 * with `registry.ts`; `registerPlugin` narrows them.
 */
export interface MdvPlugin {
  name: string;
  version: string;
  level?: ConformanceLevel;
  /** `ChartType[]` — see `registry.ts`. */
  chartTypes?: readonly unknown[];
  transforms?: readonly unknown[];
  /** Added to the MDVX whitelist (SPEC 6.8). */
  functions?: readonly unknown[];
  dataFormats?: readonly unknown[];
  themes?: readonly Theme[];
  directives?: readonly unknown[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration (SPEC 25)
// ─────────────────────────────────────────────────────────────────────────────

/** Security and resource limits (SPEC 13). Never settable from a document. */
export interface SecurityConfig {
  /** @defaultValue false */
  allowExternal?: boolean;
  /** Origins `src:` may reach when {@link allowExternal} is on. */
  allowedOrigins?: readonly string[];
  /** @defaultValue false — raw HTML is escaped and `MDV4011` is emitted. */
  allowHtml?: boolean;
  /** @defaultValue false */
  allowFileUrls?: boolean;
  /** Exceeding it is `MDV4000`. */
  maxDocumentBytes?: number;
  /** Exceeding it is `MDV4031`. */
  maxRowsPerBlock?: number;
  fetchTimeoutMs?: number;
}

/** Render-target selection and thresholds (SPEC 23, 24.2). */
export interface RenderConfig {
  /** @defaultValue 'auto' */
  target?: 'svg' | 'canvas' | 'auto';
  /** Marks above which `auto` selects Canvas. @defaultValue 5000 */
  canvasThreshold?: number;
  /** Points above which a series is downsampled for display (`MDV5010`). @defaultValue 4000 */
  downsampleThreshold?: number;
  animate?: boolean;
  /** `'eager'` disables below-the-fold virtualisation, for printing. @defaultValue 'lazy' */
  renderPolicy?: 'lazy' | 'eager';
  /** Run layout in a worker where the host provides one. */
  worker?: boolean;
}

/** Accessibility options (SPEC 12). */
export interface A11yConfig {
  /** The texture backup channel (SPEC 12.6). Never on by default. */
  texture?: boolean;
  /** @defaultValue 'details' */
  tableView?: 'details' | 'visible' | 'hidden' | 'none';
  /** Generate a description when a block has no `desc` (SPEC 12.2). @defaultValue true */
  generateDesc?: boolean;
}

/** Embedder configuration (SPEC 25). Every field is optional. */
export interface MdvConfig {
  /** @defaultValue 2 — the level this build of the reference implementation claims. */
  level?: ConformanceLevel;
  /** Promote every warning to an error (SPEC 14.3). @defaultValue false */
  strict?: boolean;
  /** A built-in name, a resolved {@link Theme}, or an override to apply. */
  theme?: string | Theme | ThemeOverride;
  /** @defaultValue 'auto' */
  colorScheme?: ColorSchemePreference;
  /** @defaultValue 'en-US' */
  locale?: string;
  /** @defaultValue 'UTC' */
  timezone?: string;
  /**
   * Pins `now()` (SPEC 24.3 rule 2). Required for byte-identical output; when
   * omitted, core uses the Unix epoch rather than reading the host clock, so a
   * missing `buildTime` degrades to *wrong but reproducible* instead of
   * *plausible but non-deterministic*.
   */
  buildTime?: Date;
  /** Cascade level 4 (SPEC 5.5) — outranks the document's own `defaults:`. */
  defaults?: Partial<BlockAttrs>;
  security?: SecurityConfig;
  render?: RenderConfig;
  a11y?: A11yConfig;
  plugins?: readonly MdvPlugin[];
  capabilities?: Capabilities;
  /** How `Mdv#toSVG` serialises a laid-out scene. See {@link SceneSerializer}. */
  svg?: SceneSerializer;
  /** Called for every diagnostic as it is produced. Must not throw. */
  onDiagnostic?: (d: Diagnostic) => void;
}

/**
 * A scene → string backend, for the facade's export methods.
 *
 * `Renderer<T>` (SPEC 21) is *handle-based*: it draws into a host object and
 * returns something you can `update` and `destroy`. That is the right shape for
 * a live document and the wrong shape for `Mdv#toSVG`, which has no host and
 * wants a string. The only other way for core to obtain one would be to import
 * `@mdv/render-svg`, and `@mdv/render-svg` depends on core — so this is the door
 * that keeps the dependency pointing one way.
 *
 * `toSvgString` from `@mdv/render-svg` satisfies it as written:
 *
 * ```ts
 * import { toSvgString } from '@mdv/render-svg';
 * const mdv = new Mdv({ svg: toSvgString });
 * ```
 *
 * Omitting it disables `toSVG` **with a stated reason** rather than a crash,
 * which is the same contract every other omitted capability has.
 */
export type SceneSerializer = (scene: Scene) => string;

/**
 * {@link MdvConfig} after defaults have been applied and the front-matter merge
 * has run. Carried on `ResolvedDocument` so nothing downstream re-derives a
 * default and gets a different answer.
 */
export interface ResolvedConfig {
  level: ConformanceLevel;
  strict: boolean;
  theme: Theme;
  colorScheme: 'light' | 'dark';
  locale: string;
  timezone: string;
  buildTime: Date;
  defaults: Partial<BlockAttrs>;
  security: Required<Omit<SecurityConfig, 'allowedOrigins'>> & {
    allowedOrigins: readonly string[];
  };
  render: Required<RenderConfig>;
  a11y: Required<A11yConfig>;
  plugins: readonly MdvPlugin[];
  capabilities: Capabilities;
}

/**
 * Thrown synchronously for **host programmer error** — an unknown renderer
 * target, a malformed config, a capability the embedder promised but did not
 * provide (SPEC 21, "Error contract").
 *
 * Document-level problems are never exceptions; they are diagnostics.
 */
export class MdvConfigError extends Error {
  override readonly name = 'MdvConfigError';
  /** The offending configuration path, e.g. `'render.target'`. */
  readonly path: string | undefined;

  constructor(message: string, path?: string) {
    super(message);
    this.path = path;
  }
}

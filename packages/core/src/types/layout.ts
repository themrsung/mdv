/**
 * Layout inputs (SPEC 18 stage 6, SPEC 21).
 *
 * **Layout is pure** (SPEC 17.3 invariant 2):
 * `(ResolvedBlock, Theme, Size, TextMetrics) → Scene`. Everything else it needs —
 * the locale, the timezone, `now()`, the id counter — arrives in a
 * {@link LayoutContext} so nothing is read from the host.
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { Diagnostic } from '@mdv/parser';
import type { Font } from './scene.js';
import type { ColorScheme, Theme } from './theme.js';

/** A width/height pair in CSS pixels. */
export interface Size {
  width: number;
  height: number;
}

/** A rectangle in scene coordinates: origin top-left, y increasing downward. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Padding or margins, in CSS pixels (SPEC 8.1 `padding`). */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** The result of measuring one run of text in one font. */
export interface GlyphMetrics {
  /** Advance width in px. */
  width: number;
  /** Distance from the alphabetic baseline to the top of the tallest glyph. */
  ascent: number;
  /** Distance from the alphabetic baseline down to the lowest glyph, positive. */
  descent: number;
}

/**
 * Text measurement (SPEC 21).
 *
 * Three implementations ship: `CanvasMetrics` (browser), `FontkitMetrics` (Node
 * and PDF; exact, from the embedded font), and `TableMetrics` (a bundled width
 * table for the default font stack — **the deterministic default**, used whenever
 * output must be reproducible across machines, SPEC 24.3 rule 6).
 *
 * Implementations MUST be pure and total: an unmeasurable string returns a
 * best-effort width, never a throw, or one missing glyph would take out a page.
 */
export interface TextMetrics {
  measure(text: string, font: Font): GlyphMetrics;
}

/**
 * Deterministic element-id allocator (SPEC 24.3 rule 7).
 *
 * Ids are `mdv-{blockIndex}-{counter}`: never content-derived, which would leak
 * document content into markup, and never random, which would break SSR
 * hydration and golden files.
 */
export interface IdFactory {
  /** The next id in sequence. */
  next(): string;
  /** The next id with a readable infix, e.g. `next('axis')` → `mdv-3-axis-7`. */
  next(infix: string): string;
}

/** Accessibility knobs that reach layout (SPEC 25, `a11y`). */
export interface LayoutA11yOptions {
  /**
   * Emit the texture channel (SPEC 12.6). Triggered by config, by print, or by
   * `forced-colors` — never on by default.
   */
  texture: boolean;
  /** How the table view is presented (SPEC 12.3). */
  tableView: 'details' | 'visible' | 'hidden' | 'none';
  /** Generate a description when the block has no `desc` (SPEC 12.2). */
  generateDesc: boolean;
}

/**
 * Everything layout may read (SPEC 21: "theme, metrics, locale, level").
 *
 * This object is the whole of layout's contact with the outside world. If a
 * layout algorithm needs something that is not here, that is a signal it is
 * reaching for the host — add it here rather than importing it.
 */
export interface LayoutContext {
  /** The fully resolved theme for this block. */
  theme: Theme;
  /** The resolved scheme, so a layout can pick the right validated palette. */
  colorScheme: ColorScheme;
  /** The injected metrics provider. Never measure the DOM. */
  metrics: TextMetrics;
  /** BCP 47 locale for number and date formatting. @defaultValue 'en-US' */
  locale: string;
  /** IANA timezone for temporal axes. @defaultValue 'UTC' */
  timezone: string;
  /** The conformance level in force (SPEC 16.1). */
  level: ConformanceLevel;
  /** `now()`, pinned by `config.buildTime` (SPEC 24.3 rule 2). */
  buildTime: Date;
  /** Deterministic ids for this block. */
  ids: IdFactory;
  a11y: LayoutA11yOptions;
  /**
   * Whether animation is permitted. Forced off under `prefers-reduced-motion`
   * and on static targets (SPEC 8.1, 12.5). Layout emits the same geometry
   * either way — this only affects what the backend does with it.
   */
  animate: boolean;
  /**
   * Collect a diagnostic. Layout never throws for document content: it reports
   * `MDV5011` (labels omitted), `MDV5001` (zero-size container), `MDV5010`
   * (downsampled) and friends through here (SPEC 14.1, SPEC 21).
   */
  diagnostic(d: Diagnostic): void;
}

/**
 * The scene graph (SPEC 20) — the IR every backend consumes.
 *
 * Deliberately small, flat, and free of styling abstractions: **all values are
 * resolved absolutes in a single coordinate space** with the origin at the
 * block's top-left, y increasing downward, units in CSS pixels.
 *
 * Four design constraints, all load-bearing:
 *
 * - **Paths are structured commands**, not SVG `d` strings. A PDF backend that
 *   has to re-parse `d` strings is a source of divergence.
 * - **Text nodes carry measured width.** Measurement happens once, in layout,
 *   through the injected metrics provider, so SVG, Canvas and PDF agree on
 *   whether a label fits and PDF pagination never disagrees with the screen.
 * - **No CSS.** Backends do not inherit, cascade, or resolve custom properties.
 * - **`hitIndex` and `a11y` are part of the scene**, computed in layout, so DOM
 *   and Canvas hit-test identically and the PDF exporter emits the same
 *   descriptions as tagged content.
 */

import type { ColorString } from './theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Paint, stroke, font, transform
// ─────────────────────────────────────────────────────────────────────────────

/** A single stop of a gradient def. `offset` is 0…1. */
export interface GradientStop {
  offset: number;
  color: ColorString;
  opacity?: number;
}

/** A flat fill. */
export interface SolidPaint {
  kind: 'solid';
  color: ColorString;
  /** 0…1, multiplied with any node opacity. */
  opacity?: number;
}

/**
 * A gradient fill. The geometry lives in a {@link LinearGradientDef} or
 * {@link RadialGradientDef} in `Scene.defs`, referenced by id, so one gradient
 * can serve many nodes and every backend can hoist it once.
 */
export interface GradientPaint {
  kind: 'gradient';
  /** Id of a gradient {@link Def}. */
  def: string;
  opacity?: number;
}

/**
 * A pattern fill — the texture channel of SPEC 12.6. The tile lives in a
 * {@link PatternDef}. Textures are inked tone-on-tone from the fill's own ramp,
 * so {@link background} carries the underlying series color.
 */
export interface PatternPaint {
  kind: 'pattern';
  /** Id of a {@link PatternDef}. */
  def: string;
  /** Painted beneath the tile. */
  background?: ColorString;
  opacity?: number;
}

/** Any fill (SPEC 20). */
export type Paint = SolidPaint | GradientPaint | PatternPaint;

/** A stroke. Widths are in px; `1` is the theme hairline. */
export interface Stroke {
  paint: Paint;
  width: number;
  /** @defaultValue 'butt' */
  cap?: 'butt' | 'round' | 'square';
  /** @defaultValue 'miter' */
  join?: 'miter' | 'round' | 'bevel';
  /** @defaultValue 4 */
  miterLimit?: number;
  /**
   * Dash pattern in px. **Gridlines and axes are never dashed** (SPEC 11.4);
   * this exists for annotation rules and reference lines only.
   */
  dash?: number[];
  dashOffset?: number;
  opacity?: number;
}

/**
 * A resolved font. There is exactly one family in the default theme, including
 * for large figures (SPEC 11.1) — no display or serif face.
 */
export interface Font {
  family: string;
  /** px */
  size: number;
  /** 100…900. @defaultValue 400 */
  weight?: number;
  /** @defaultValue 'normal' */
  style?: 'normal' | 'italic';
  /** Unitless multiplier of {@link size}. */
  lineHeight?: number;
  /** px, added between glyphs. */
  letterSpacing?: number;
}

/**
 * A transform on a {@link GroupNode}. Compose several by pre-multiplying into a
 * `matrix` — a group carries at most one transform, which keeps the PDF
 * backend's graphics-state stack shallow and predictable.
 *
 * Angles are degrees, clockwise (y grows downward).
 */
export type Transform =
  | { kind: 'translate'; x: number; y: number }
  | { kind: 'scale'; x: number; y: number }
  | { kind: 'rotate'; angle: number; cx?: number; cy?: number }
  | { kind: 'matrix'; a: number; b: number; c: number; d: number; e: number; f: number };

// ─────────────────────────────────────────────────────────────────────────────
// Path commands — structured, never a `d` string (SPEC 20)
// ─────────────────────────────────────────────────────────────────────────────

/** Move the pen. Absolute coordinates. */
export interface MoveCommand {
  c: 'M';
  x: number;
  y: number;
}
/** Straight segment. Absolute coordinates. */
export interface LineCommand {
  c: 'L';
  x: number;
  y: number;
}
/** Cubic Bézier. Absolute coordinates. */
export interface CubicCommand {
  c: 'C';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x: number;
  y: number;
}
/** Quadratic Bézier. Absolute coordinates. */
export interface QuadraticCommand {
  c: 'Q';
  x1: number;
  y1: number;
  x: number;
  y: number;
}
/**
 * Elliptical arc, SVG semantics. Backends without native arcs (PDF) convert to
 * cubics; doing that conversion in the backend rather than in layout keeps arc
 * geometry exact for SVG.
 */
export interface ArcCommand {
  c: 'A';
  rx: number;
  ry: number;
  /** Degrees. */
  rotate: number;
  largeArc: boolean;
  sweep: boolean;
  x: number;
  y: number;
}
/** Close the current subpath. */
export interface ClosePathCommand {
  c: 'Z';
}

/**
 * One structured path command (SPEC 20).
 *
 * **All commands are absolute.** There are no relative variants: relative
 * commands accumulate float error differently in each backend, which is exactly
 * the divergence the structured representation exists to prevent. Coordinates
 * are rounded to a fixed precision by the serialiser (SPEC 24.3 rule 4), not here.
 */
export type PathCommand =
  MoveCommand | LineCommand | CubicCommand | QuadraticCommand | ArcCommand | ClosePathCommand;

// ─────────────────────────────────────────────────────────────────────────────
// Nodes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fields every node may carry.
 *
 * `id` follows the deterministic scheme `mdv-{blockIndex}-{counter}` (SPEC 24.3
 * rule 7) — never content-derived, never random. `cls` carries the stable,
 * namespaced class tokens that SPEC 22.4 makes part of the public API
 * (`mdv-axis`, `mdv-legend-item`); DOM backends emit them, PDF and text ignore
 * them.
 */
export interface SceneNodeBase {
  id?: string;
  /** Space-separated class tokens, e.g. `'mdv-axis mdv-axis-y'`. */
  cls?: string;
}

/** A grouping node; the only node that carries a transform, clip, or a11y role. */
export interface GroupNode extends SceneNodeBase {
  kind: 'group';
  transform?: Transform;
  /** Id of a {@link ClipDef}. */
  clip?: string;
  /** 0…1, multiplied into every descendant. */
  opacity?: number;
  children: SceneNode[];
  role?: A11yRole;
  /** Accessible label for this group, when it is a landmark in the focus order. */
  label?: string;
}

/**
 * An axis-aligned rectangle. `r` is a single radius or per-corner
 * `[topLeft, topRight, bottomRight, bottomLeft]` — bars are **rounded at the
 * data end and square at the baseline** (SPEC 11.4), which is exactly why the
 * per-corner form exists.
 */
export interface RectNode extends SceneNodeBase {
  kind: 'rect';
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number | [number, number, number, number];
  fill?: Paint;
  stroke?: Stroke;
  opacity?: number;
}

/** A straight line. Gridlines, axis baselines, crosshairs, rules. */
export interface LineNode extends SceneNodeBase {
  kind: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: Stroke;
  opacity?: number;
}

/** An arbitrary path built from structured {@link PathCommand}s. */
export interface PathNode extends SceneNodeBase {
  kind: 'path';
  d: PathCommand[];
  fill?: Paint;
  stroke?: Stroke;
  /** @defaultValue 'nonzero' */
  fillRule?: 'nonzero' | 'evenodd';
  opacity?: number;
}

/** A circle. Points, end dots, markers. */
export interface CircleNode extends SceneNodeBase {
  kind: 'circle';
  cx: number;
  cy: number;
  r: number;
  fill?: Paint;
  stroke?: Stroke;
  opacity?: number;
}

/**
 * Real text — never outlines (SPEC 23.1), so it stays selectable, searchable and
 * translatable, and so PDF can embed it as text.
 */
export interface TextNode extends SceneNodeBase {
  kind: 'text';
  x: number;
  y: number;
  text: string;
  font: Font;
  fill: Paint;
  anchor: 'start' | 'middle' | 'end';
  baseline: 'top' | 'middle' | 'alphabetic' | 'bottom';
  /** Degrees, clockwise, about (x, y). */
  rotate?: number;
  /**
   * Measured advance width in px, from the injected metrics provider. Set by
   * layout, consumed by collision resolution and by PDF pagination — this is
   * what keeps the three backends agreeing on whether a label fits.
   */
  width?: number;
  /** Render with tabular figures (SPEC 11.5: y-axis ticks, table values). */
  tabular?: boolean;
  opacity?: number;
}

/** A raster or vector image, e.g. a `fallback:` asset or a map tile. */
export interface ImageNode extends SceneNodeBase {
  kind: 'image';
  x: number;
  y: number;
  w: number;
  h: number;
  /** A URL or a data URL. Backends never fetch: resolve did that. */
  href: string;
  /** @defaultValue 'xMidYMid meet' */
  preserveAspectRatio?: string;
  /** Alternative text; folded into the a11y tree by the backend. */
  alt?: string;
  opacity?: number;
}

/**
 * An instance of a {@link SymbolDef}. Used for repeated marks (scatter points,
 * legend swatches) so a 10 000-point scatter emits one geometry, not 10 000.
 */
export interface UseNode extends SceneNodeBase {
  kind: 'use';
  /** Id of a {@link SymbolDef}. */
  ref: string;
  x?: number;
  y?: number;
  transform?: Transform;
  /** Overrides the symbol's own fill, when the symbol declares none. */
  fill?: Paint;
  stroke?: Stroke;
  opacity?: number;
}

/** Every node type a backend must handle (SPEC 17.3 invariant 3: backends are total). */
export type SceneNode =
  GroupNode | RectNode | LineNode | PathNode | CircleNode | TextNode | ImageNode | UseNode;

/** Discriminant values of {@link SceneNode}. */
export type SceneNodeKind = SceneNode['kind'];

// ─────────────────────────────────────────────────────────────────────────────
// Defs
// ─────────────────────────────────────────────────────────────────────────────

/** Coordinate space for a gradient. */
export type GradientUnits = 'userSpace' | 'objectBoundingBox';

/** A linear gradient. */
export interface LinearGradientDef {
  kind: 'linear-gradient';
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** @defaultValue 'objectBoundingBox' */
  units?: GradientUnits;
  stops: GradientStop[];
}

/** A radial gradient. */
export interface RadialGradientDef {
  kind: 'radial-gradient';
  id: string;
  cx: number;
  cy: number;
  r: number;
  units?: GradientUnits;
  stops: GradientStop[];
}

/**
 * A texture tile (SPEC 12.6). **One directional fill at 45° and its 135° mirror
 * only** — never horizontal or vertical, which read as gridlines or bars. On
 * value scales the texture is *ordered*, so it never misstates the value.
 */
export interface PatternDef {
  kind: 'pattern';
  id: string;
  /** Tile size in px. */
  width: number;
  height: number;
  /** 45 or 135 for the categorical channel; a ramp step for value scales. */
  angle: number;
  /** Tile contents, in tile coordinates. */
  content: SceneNode[];
}

/** A clip region. Rect clips are expressed as a four-command path. */
export interface ClipDef {
  kind: 'clip';
  id: string;
  path: PathCommand[];
}

/** Reusable geometry, instanced by {@link UseNode}. */
export interface SymbolDef {
  kind: 'symbol';
  id: string;
  node: SceneNode;
}

/** Anything hoisted out of the tree and referenced by id (SPEC 20). */
export type Def = LinearGradientDef | RadialGradientDef | PatternDef | ClipDef | SymbolDef;

// ─────────────────────────────────────────────────────────────────────────────
// Accessibility (SPEC 12), part of the scene — not a DOM afterthought
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ARIA roles a scene node may carry. `graphics-*` are the WAI-ARIA Graphics
 * Module roles that map cleanly onto PDF structure elements.
 */
export type A11yRole =
  | 'img'
  | 'figure'
  | 'group'
  | 'list'
  | 'listitem'
  | 'graphics-document'
  | 'graphics-object'
  | 'graphics-symbol'
  | 'presentation'
  | 'none';

/** One column of the table view (SPEC 12.3). */
export interface A11yColumn {
  /** Header text; becomes a `<th scope="col">`. */
  name: string;
  /** The source field's type, so the table can right-align quantities. */
  type: string;
  align: 'left' | 'right' | 'center';
}

/**
 * The table view (SPEC 12.3). **Every visual block MUST make its underlying data
 * reachable as a table.** Cells are already formatted strings: the exporter and
 * the DOM renderer must not re-format, or PDF and screen would disagree.
 */
export interface A11yTable {
  caption: string;
  columns: A11yColumn[];
  /** Formatted cell text, row-major, matching {@link columns}. */
  rows: string[][];
  /** How the table is presented (SPEC 12.3). `none` emits `MDV3090`. */
  presentation: 'details' | 'visible' | 'hidden' | 'none';
}

/**
 * The accessible tree for one block (SPEC 12), computed in layout so the PDF
 * exporter emits the same descriptions as tagged content.
 */
export interface A11yTree {
  /** `figure` when the block has a caption, otherwise `img` (SPEC 12.1). */
  role: 'img' | 'figure';
  /** `title` if present, else `desc`, else a generated summary (SPEC 12.1). */
  name: string;
  /** The long description; becomes `aria-describedby` and the PDF `/Alt` text. */
  desc?: string;
  /**
   * `true` when {@link desc} was generated from the encoding and the data rather
   * than authored (SPEC 12.2), so authoring tools can prompt for a better one.
   * When no description exists and none could be generated: `MDV3091`.
   */
  descGenerated: boolean;
  table: A11yTable;
  /**
   * {@link HitRegion} ids in keyboard traversal order (SPEC 12.4). Arrow keys walk
   * this list; Page Up/Down jump between {@link HitRegion.group} boundaries.
   */
  focusOrder: string[];
  /** BCP 47 tag from the document's `lang`, when it differs from the host. */
  lang?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hit testing (SPEC 7.5, 12.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One row of the readout shown on hover and on keyboard focus — **the same
 * readout for both** (SPEC 12.4).
 *
 * The value is the prominent element and the series name is secondary: the
 * reader already knows which series they are pointing at (SPEC 7.5).
 */
export interface ReadoutRow {
  /** Series or field name. Inserted as a text node, never as markup (SPEC 13.3). */
  label: string;
  /** Already formatted. Tooltips never gate a value (SPEC 7.5). */
  value: string;
  /** Series color for the key swatch; a short line stroke, not a filled box. */
  swatch?: ColorString;
  /** Marks the row the pointer or focus is actually on. */
  emphasis?: boolean;
}

/**
 * A resolved hit target (SPEC 20).
 *
 * Computed once in layout so DOM and Canvas behave identically and the **24 px
 * minimum target** (SPEC 7.5, 12.5) is enforced in exactly one place: an 8 px dot
 * with an 8 px target is unhittable, so the region is grown around the painted
 * mark and may overlap its neighbours.
 */
export interface HitRegion {
  /** Stable id, referenced by {@link A11yTree.focusOrder}. */
  id: string;
  /** Target rectangle in scene coordinates, already grown to ≥ 24 × 24. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Where the tooltip points and where the focus ring centres. */
  anchor: { x: number; y: number };
  /** Identity of the series this belongs to; `undefined` for single-series marks. */
  seriesId?: string;
  /** Row index in the prepared table, for `exportBlock` and for debugging. */
  datumIndex: number;
  /** Regions sharing a `group` are one series for Page Up/Page Down (SPEC 12.4). */
  group?: string;
  /** The readout, identical for hover and focus. */
  readout: ReadoutRow[];
  /**
   * Id of the painted {@link SceneNode} this region targets, so the focus ring can
   * be drawn around the mark rather than around the (larger) hit rectangle.
   */
  markNodeId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The scene
// ─────────────────────────────────────────────────────────────────────────────

/** Provenance stamped onto every scene (SPEC 20). */
export interface SceneMeta {
  /** The block's `id`, or its deterministic fallback `mdv-{blockIndex}`. */
  blockId: string;
  /** The block type, e.g. `'bar'`. */
  type: string;
  /** Resolved theme name. */
  theme: string;
  /** The `@mdv/core` version that produced this scene. */
  version: string;
}

/**
 * The complete IR for one block (SPEC 20). A plain data structure: it can be
 * snapshot-tested without a DOM, cached by content hash, and shipped across a
 * worker boundary unchanged.
 */
export interface Scene {
  width: number;
  height: number;
  background?: Paint;
  /** Gradients, clips, patterns. Referenced by id from paints and groups. */
  defs: Def[];
  root: GroupNode;
  a11y: A11yTree;
  /** Resolved once, shared by DOM and Canvas. */
  hitIndex: HitRegion[];
  meta: SceneMeta;
}

/**
 * The encoding model (SPEC 7) and the mark vocabulary that chart types emit
 * (SPEC 18 stage 5).
 *
 * **Marks carry data-space values, not pixels.** Encode assigns series identity
 * and palette slots, constructs scales and computes domains; layout turns that
 * into geometry. Keeping the split there is what lets one encoder serve a plot,
 * a facet panel and a sparkline at three different sizes.
 */

import type { ColorString } from './theme.js';
import type { Column, DataType, FormatSpec, RowIndex, Table, Value } from './data.js';

// ─────────────────────────────────────────────────────────────────────────────
// Channels (SPEC 7.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The shared channel vocabulary (SPEC 7.1). Which channels a block type accepts
 * is declared per type; the names never vary between types.
 */
export type ChannelName =
  /** Horizontal position. */
  | 'x'
  /** Vertical position. A list creates one series per field ("wide form"). */
  | 'y'
  /** Splits rows into series ("long form"). Exclusive with a list `y` (`MDV3010`). */
  | 'series'
  /** Color encoding, or a fixed color. */
  | 'color'
  /** Mark size / radius. */
  | 'size'
  /** Point shape. */
  | 'shape'
  /** Direct labels on marks. */
  | 'label'
  /** The magnitude for pie, heatmap, treemap, gauge, funnel. */
  | 'value'
  /** The identity for pie, funnel, treemap. */
  | 'category'
  /** Faceting/grouping key where a type defines one. */
  | 'group'
  /** Splits marks without adding a visual channel. */
  | 'detail'
  /** Extra fields in the readout. */
  | 'tooltip'
  /** Small-multiple facets (SPEC 7.6). */
  | 'row'
  | 'column';

/** Aggregation applied at the channel level, e.g. `y: {field: revenue, aggregate: sum}`. */
export type ChannelAggregate =
  'sum' | 'mean' | 'median' | 'min' | 'max' | 'count' | 'first' | 'last' | 'stddev';

/**
 * A resolved channel binding (SPEC 7.1.2).
 *
 * The bare form `y: revenue` is normalised to `{ field: 'revenue' }` before this
 * type is ever constructed, so consumers never handle both shapes.
 */
export interface Channel {
  /** The bound field name. Absent when {@link value} supplies a constant. */
  field?: string;
  /** A constant instead of a binding, e.g. a fixed color or a fixed size. */
  value?: Value;
  /** Axis/legend title. `false` suppresses it; absent means "humanise the field". */
  title?: string | false;
  format?: FormatSpec;
  aggregate?: ChannelAggregate;
  scale?: ScaleSpec;
  axis?: AxisSpec | false;
  /** Field type after inference, copied here so consumers need not re-look-up. */
  type?: DataType;
}

/**
 * The full encoding of a block: channel → binding.
 *
 * `y` may be a list (wide form, one series per field). Both wide and long form
 * are first-class and the reader normalises to long form internally (SPEC 7.1.1).
 */
export type Encoding = {
  [K in ChannelName]?: Channel | Channel[];
};

/** What a chart type declares about a channel it accepts. */
export interface ChannelSpec {
  name: ChannelName;
  /** Missing a required channel is `MDV3000`. */
  required: boolean;
  /** Field types this channel accepts; a mismatch is `MDV3001`. */
  accepts: readonly DataType[];
  /** `true` when the channel may be bound to a list of fields (wide form). */
  list?: boolean;
  /** `true` when a bare constant (a color, a number) is legal instead of a field. */
  constant?: boolean;
  /** Default scale type when the author does not declare one. */
  defaultScale?: ScaleType;
  /** One line, used by the LSP for hover text. */
  doc: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scales (SPEC 7.2)
// ─────────────────────────────────────────────────────────────────────────────

/** Scale types (SPEC 7.2). */
export type ScaleType =
  | 'linear'
  | 'log'
  | 'sqrt'
  | 'pow'
  | 'symlog'
  | 'time'
  | 'band'
  | 'point'
  | 'ordinal'
  | 'quantize'
  | 'quantile'
  | 'threshold';

/**
 * The author's scale request (SPEC 7.2), before domain computation.
 *
 * Domain rules: a quantitative y-domain **includes zero** for area/bar
 * (`zero: true`) and does **not** for line/scatter (`zero: false`), and is
 * extended to nice round bounds. Setting `zero: false` on a bar or an area emits
 * `MDV3021` — truncating a bar chart's axis misstates magnitude.
 */
export interface ScaleSpec {
  type?: ScaleType;
  /** For `log`. @defaultValue 10 */
  base?: number;
  /** For `pow`. */
  exponent?: number;
  /** For `symlog`. @defaultValue 1 */
  constant?: number;
  /** `[min, max]`; a `null` pins only one end. */
  domain?: readonly (number | string | Date | null)[];
  range?: readonly (number | string)[];
  zero?: boolean;
  /** @defaultValue true */
  nice?: boolean;
  /** Clip out-of-domain values instead of extrapolating. @defaultValue false */
  clamp?: boolean;
  /** Band padding. @defaultValue 0.2 */
  padding?: number;
  reverse?: boolean;
}

/** A value a scale can consume. */
export type ScaleInput = number | string | Date;

/**
 * A constructed, executable scale (SPEC 18 stage 5 output, consumed by stage 6).
 *
 * Scales are **built by encode and read by layout**: the axis generator, the
 * gridline generator and the chart's own mark geometry all call the same
 * instance, which is what keeps a tick and a bar edge on the same pixel.
 *
 * Implementations MUST be pure and deterministic for a given construction.
 */
export interface Scale<D extends ScaleInput = ScaleInput, R = number> {
  readonly type: ScaleType;
  /** The computed domain, after `zero`, `nice` and any explicit override. */
  readonly domain: readonly D[];
  /** The output range, in scene units for positional scales. */
  readonly range: readonly R[];
  /** Map a data value into the range. `undefined` for out-of-domain when not clamped. */
  scale(value: D): R | undefined;
  /** Inverse mapping, where the scale type has one (continuous scales). */
  invert?(value: R): D | undefined;
  /**
   * Tick values. `count` is a **hint**: the generator prefers round values and
   * may return a different number (SPEC 7.3).
   */
  ticks(count?: number): readonly D[];
  /** Format a domain value for an axis label or a readout. */
  format(value: D): string;
  /** Band width, for `band` scales. */
  bandwidth?(): number;
  /** Distance between band starts, for `band` and `point` scales. */
  step?(): number;
}

/** Every scale a chart constructed, keyed by channel. */
export type ScaleBundle = {
  [K in ChannelName]?: Scale;
};

// ─────────────────────────────────────────────────────────────────────────────
// Axes and legends — the *model*; core draws them (see registry.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** The author's axis request (SPEC 7.3). */
export interface AxisSpec {
  title?: string | false;
  /** Hairline, solid, never dashed. @defaultValue y: true, x: false */
  grid?: boolean;
  /** A count hint. @defaultValue 'auto' */
  ticks?: 'auto' | number;
  /** Explicit tick positions, overriding {@link ticks}. */
  tickValues?: readonly (number | string | Date)[];
  format?: FormatSpec;
  /**
   * Degrees. Layout auto-rotates to `-45` **only** when labels would collide, and
   * MUST NOT clip (SPEC 11.5). @defaultValue 0
   */
  tickRotate?: number;
  position?: 'left' | 'right' | 'top' | 'bottom';
}

/**
 * What a chart type tells core to draw for an axis. Core owns the geometry — the
 * tick ladder, the collision handling, the title placement — because every chart
 * type must produce identical axes for identical scales.
 */
export interface AxisModel {
  channel: ChannelName;
  /** Which edge of the plot frame. */
  position: 'left' | 'right' | 'top' | 'bottom';
  /** The scale to tick. Must be the same instance the marks used. */
  scale: Scale;
  /** Resolved title, or `false` to suppress. */
  title: string | false;
  grid: boolean;
  ticks: 'auto' | number;
  tickValues?: readonly ScaleInput[];
  tickRotate?: number;
  format?: FormatSpec;
  /**
   * `false` when the axis baseline should not be drawn (e.g. a value axis that is
   * carried by gridlines alone).
   */
  baseline: boolean;
}

/** Legend placement (SPEC 7.4). */
export type LegendPosition = 'top' | 'right' | 'bottom' | 'left' | 'inline';

/** The symbol a legend entry draws — it mirrors the mark (SPEC 7.4). */
export type LegendSymbol = 'rect' | 'line' | 'point' | 'area';

/** One legend entry. */
export interface LegendEntry {
  /** Series identity; matches {@link SeriesDescriptor.id}. */
  seriesId: string;
  label: string;
  color: ColorString;
  symbol: LegendSymbol;
  /** Set on the folded "Other" entry (SPEC 7.4, `MDV3062`). */
  isOther?: boolean;
  /** Texture def id when the texture channel is on (SPEC 12.6). */
  patternDef?: string;
}

/**
 * What a chart type tells core to draw for the legend. Core owns placement,
 * wrapping and the `maxItems` fold.
 *
 * `auto` resolves to: **no legend for a single series** (the title names it, and
 * a one-swatch box is pure overhead); otherwise top for ≤ 6 series, right for
 * more (SPEC 7.4).
 */
export interface LegendModel {
  position: LegendPosition;
  title?: string | false;
  orient?: 'horizontal' | 'vertical';
  columns?: number;
  /** @defaultValue 12 */
  maxItems?: number;
  entries: LegendEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Series identity (SPEC 11.2 rule 1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One series, with its palette slot.
 *
 * **Color follows the entity, not its rank.** {@link id} is the series' identity —
 * its value in the `series` field, or the field name in wide form — and the slot
 * is keyed on it, resolved in first-appearance order over the *unfiltered*
 * domain. A series therefore keeps its color when a filter or a sort removes
 * another (SPEC 11.2 rule 1).
 */
export interface SeriesDescriptor {
  /** Stable identity. Never an array index. */
  id: string;
  /** Display name, as it appears in the legend and the readout. */
  label: string;
  /** 0-based categorical slot (SPEC 11.2). `-1` for the folded "Other" series. */
  slot: number;
  color: ColorString;
  /** Texture def id when the texture channel is on (SPEC 12.6). */
  patternDef?: string;
  /** `true` for the synthetic "Other" series produced by the fold (`MDV3062`). */
  isOther?: boolean;
  /** Source field name in wide form; the `series` field value in long form. */
  source: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marks — the payloads chart types emit (SPEC 18 stage 5)
// ─────────────────────────────────────────────────────────────────────────────

/** Fields every mark carries. */
export interface MarkBase {
  /** Which series this mark belongs to; `''` for an unsplit single series. */
  seriesId: string;
  /** Row index in the prepared table, for readouts, export, and debugging. */
  datum: RowIndex;
  /** Direct label text, already formatted, when the chart requested one. */
  label?: string;
  /** Extra readout rows beyond the encoded channels (`tooltip: [field, …]`). */
  extra?: readonly { label: string; value: string }[];
}

/**
 * A bar or column (SPEC 8.2).
 *
 * `y0`/`y1` are the stack span in data space — `y0` is the baseline for
 * `stack: none`. Orientation is a property of the chart, not of the mark: the
 * layout swaps the axes.
 */
export interface BarMark extends MarkBase {
  mark: 'bar';
  /** Band position (a category, a time bucket). */
  x: ScaleInput;
  y0: number;
  y1: number;
  /** Offset within the band for grouped (unstacked, multi-series) bars. */
  groupIndex?: number;
  groupCount?: number;
}

/** One point of a line or an area (SPEC 8.3, 8.4). */
export interface LinePointMark extends MarkBase {
  mark: 'line-point';
  x: ScaleInput;
  y: number | null;
  /** Stack baseline for stacked areas; `0` for a plain line. */
  y0?: number;
}

/**
 * A whole series polyline (SPEC 8.3). Charts may emit either these or
 * {@link LinePointMark}s; a polyline is cheaper for a 10 000-point series and
 * keeps null handling (gaps) in one place.
 */
export interface LineMark extends MarkBase {
  mark: 'line';
  /** `null` y marks a gap: the line breaks, it does not interpolate (SPEC 6.5). */
  points: readonly { x: ScaleInput; y: number | null; datum: RowIndex }[];
  /** Whether to fill down to {@link baseline} — the area form. */
  fill?: boolean;
  /** Data-space baseline for the fill. */
  baseline?: number;
}

/** A scatter or bubble point (SPEC 8.6). */
export interface PointMark extends MarkBase {
  mark: 'point';
  x: ScaleInput;
  y: number;
  /** Data-space size for bubble; absent for plain scatter. */
  size?: number;
  shape?: 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'star';
}

/** A pie/donut slice or a gauge arc (SPEC 8.5, 8.12). */
export interface ArcMark extends MarkBase {
  mark: 'arc';
  category: string;
  value: number;
  /** Fraction of the whole, 0…1. Pre-computed so layout does no arithmetic on data. */
  fraction: number;
}

/** A heatmap or matrix cell (SPEC 8.9). */
export interface CellMark extends MarkBase {
  mark: 'cell';
  x: ScaleInput;
  y: ScaleInput;
  value: number | null;
}

/** A reference line or an annotation rule (SPEC 8.14). */
export interface RuleMark extends MarkBase {
  mark: 'rule';
  orientation: 'horizontal' | 'vertical';
  /** Data-space position on the perpendicular axis. */
  at: ScaleInput;
  /** Optional data-space extent; absent spans the plot. */
  from?: ScaleInput;
  to?: ScaleInput;
}

/** A free-standing text mark: an annotation, a metric tile figure (SPEC 8.13). */
export interface TextMark extends MarkBase {
  mark: 'text';
  x: ScaleInput;
  y: ScaleInput;
  text: string;
}

/** An OHLC bar or a candlestick body (SPEC 8.10, 8.11). */
export interface OhlcMark extends MarkBase {
  mark: 'ohlc';
  x: ScaleInput;
  open: number;
  high: number;
  low: number;
  close: number;
  /** Present for `ohlcv`/`candlestick` with a volume pane. */
  volume?: number;
  /** Direction, which selects a **status** color, never a series slot (SPEC 11.3.1). */
  direction: 'up' | 'down' | 'flat';
}

/** A box-plot box with its whiskers and outliers (SPEC 8.8). */
export interface BoxMark extends MarkBase {
  mark: 'box';
  x: ScaleInput;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  outliers?: readonly number[];
}

/** A node of a hierarchical or flow diagram: treemap, sankey, network (SPEC 8.12). */
export interface NodeMark extends MarkBase {
  mark: 'node';
  key: string;
  parent?: string;
  value: number;
  depth: number;
}

/** An edge of a flow diagram: sankey, network (SPEC 8.12). */
export interface LinkMark extends MarkBase {
  mark: 'link';
  source: string;
  target: string;
  value: number;
}

/**
 * Any mark a built-in chart type emits.
 *
 * A plugin chart type may widen this with its own payload; the union exists so
 * that shared tooling (the readout builder, the a11y describer, the downsampler)
 * can switch exhaustively over the built-ins.
 */
export type Mark =
  | BarMark
  | LineMark
  | LinePointMark
  | PointMark
  | ArcMark
  | CellMark
  | RuleMark
  | TextMark
  | OhlcMark
  | BoxMark
  | NodeMark
  | LinkMark;

/** Discriminant values of {@link Mark}. */
export type MarkKind = Mark['mark'];

/**
 * The whole of stage 5's output for one block, before geometry.
 *
 * SPEC 26.1 calls this a `MarkSet`; the name is kept for plugin compatibility.
 */
export interface MarkSet<M extends Mark = Mark> {
  marks: readonly M[];
  series: readonly SeriesDescriptor[];
  scales: ScaleBundle;
  /** The prepared table the marks index into. */
  table: Table;
  /** Columns actually bound, in channel order — used to build the table view. */
  boundColumns: readonly Column[];
}

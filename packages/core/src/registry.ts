/**
 * # The chart-type contract
 *
 * This file is the seam between `@mdv/core`'s layout engine and `@mdv/charts`'
 * per-type encoders. Both sides are written against exactly this file. Read the
 * division of responsibility below before writing either side.
 *
 * ## Who owns what
 *
 * **`@mdv/core` owns the frame.** Given a block's outer size it computes the plot
 * frame: it reserves space for the title, subtitle and caption, measures and
 * places the axes (tick ladder, tick labels, collision handling, auto-rotation to
 * −45°, titles), places the legend, applies `padding`, and hands the chart type a
 * bare {@link Rect}. It then draws the surface, the gridlines, the axis baselines,
 * the axis and legend text, the focus ring, the tooltip layer, the error card and
 * the table view. It grows every hit region to the 24 × 24 px minimum, assembles
 * the {@link A11yTree}, allocates every element id, and emits the {@link Scene}.
 *
 * **`@mdv/charts` owns the marks.** A chart type decides which channels it
 * accepts, how rows become series, what the domains are, and what geometry the
 * data draws inside the frame it is given. It emits mark nodes, the hit regions
 * for those marks, any defs its marks reference, and its own direct labels. It
 * does **not** draw axes, gridlines, legends, titles, or the surface, and it does
 * not read anything outside {@link LayoutContext}.
 *
 * The dividing line is: *if two different chart types would have to draw it
 * identically, core draws it.* That is what makes every chart type's axes agree
 * to the pixel, and what makes a plugin chart get PDF export, keyboard
 * interaction and the table view for free (SPEC 26.1).
 *
 * ## The handshake, stage by stage
 *
 * ```text
 *  core                                    chart type
 *  ────                                    ──────────
 *  resolve, cascade, prepare table  ──────▶ validate(block, table) → Diagnostic[]
 *                                   ◀──────
 *  build PaletteAllocator           ──────▶ encode(EncodeInput) → EncodeResult
 *                                   ◀────── marks, series, scales, axes, legend
 *  reserve axis/legend/title space
 *  compute the plot frame           ──────▶ layout(encoded, frame, ctx)
 *                                   ◀────── nodes, hits, defs, labels
 *  draw frame furniture, place labels,
 *  grow hit regions, build a11y tree
 *  → Scene                          ──────▶ describe(...) → string   (optional)
 * ```
 *
 * Three consequences worth stating outright:
 *
 * - **The scales in {@link EncodeResult.scales} are the same instances core ticks
 *   for the axes.** A chart type must not build a second scale for its own
 *   geometry, or a bar edge and a gridline will land on different pixels.
 * - **Marks are in data space; nodes are in scene space.** `encode` never sees a
 *   pixel; `layout` never sees an unscaled value it did not scale itself.
 * - **Neither side throws for document content.** Both report through
 *   {@link EncodeInput.diagnostic} / {@link LayoutContext.diagnostic}. A thrown
 *   error from a chart type is caught by core, becomes `MDV5000`, and the block
 *   renders its error card — the document still renders (SPEC 14.1).
 *
 * ## Determinism obligations on a chart type
 *
 * - No `Math.random()`; a seeded algorithm derives its seed from the block id.
 * - No `Date.now()`; `now()` is {@link LayoutContext.buildTime}.
 * - No locale or timezone from the host; both are on the context.
 * - Any set derived from data is sorted before use; map iteration is insertion
 *   order (SPEC 24.3 rule 5).
 * - Palette slots come from {@link PaletteAllocator}, never from an array index
 *   into the filtered data (SPEC 11.2 rule 1).
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { Diagnostic } from '@mdv/parser';
import type { BlockAttrs } from './types/attrs.js';
import type { Column, Table } from './types/data.js';
import type {
  AxisModel,
  ChannelSpec,
  Encoding,
  LegendModel,
  Mark,
  ScaleBundle,
  SeriesDescriptor,
} from './types/encode.js';
import type { LayoutContext, Rect, ReservedFrames } from './types/layout.js';
import type { ResolvedBlock } from './types/resolved.js';
import type { A11yTable, Def, HitRegion, SceneNode } from './types/scene.js';
import type { ColorString, Theme } from './types/theme.js';

// ─────────────────────────────────────────────────────────────────────────────
// Support types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Interaction family, which selects the hover behaviour core installs (SPEC 7.5).
 *
 * - `crosshair` — line, area, OHLC/OHLCV: a vertical crosshair snaps to the
 *   nearest x and the readout lists **every** series at that x. The reader aims
 *   at a date, never at a 2 px stroke.
 * - `mark` — bar, heatmap, pie, treemap, funnel, waterfall: the mark is the hit
 *   target, no crosshair; the hovered mark lifts.
 * - `nearest` — scatter, bubble: Voronoi nearest-point, so the pointer only has
 *   to be *closest*.
 * - `none` — metric tiles, sparklines and other blocks with no readout.
 */
export type ChartFamily = 'crosshair' | 'mark' | 'nearest' | 'none';

/**
 * Deterministic palette-slot allocation (SPEC 11.2 rule 1).
 *
 * Core constructs one allocator per block over the **unfiltered** series domain
 * in first-appearance order and hands it to `encode`. A chart type must obtain
 * every series color from here: keying on the array index of the filtered data
 * is exactly the bug rule 1 exists to prevent.
 */
export interface PaletteAllocator {
  /** Number of usable slots for this block, after any all-pairs cap. */
  readonly size: number;
  /**
   * 0-based slot for a series identity, stable across filters and sorts.
   * `-1` once the series has folded into "Other".
   */
  slot(seriesId: string): number;
  /** Resolved color for a series identity; the "Other" color past the cap. */
  color(seriesId: string): ColorString;
  /** `true` once this series is beyond the cap — the caller folds it (`MDV3062`). */
  isOverflow(seriesId: string): boolean;
  /**
   * Texture def id for a series, when the texture channel is on (SPEC 12.6);
   * `undefined` otherwise. Core has already put the def in the scene.
   */
  patternDef(seriesId: string): string | undefined;
}

/**
 * A direct label a chart type would like drawn (SPEC 11.5).
 *
 * The chart proposes; **core disposes**. Core measures, resolves collisions, and
 * drops labels it cannot place without clipping, emitting `MDV5011` and pointing
 * at the table view. A label that will not fit is never clipped — cropping the
 * first characters is worse than no label.
 */
export interface DirectLabel {
  /** Preferred anchor in scene coordinates. */
  x: number;
  y: number;
  text: string;
  /** Which side of the anchor the label prefers; core may pick another. */
  placement: 'above' | 'below' | 'start' | 'end' | 'inside' | 'outside';
  /**
   * Priority when labels compete for space, higher wins. Use this to encode
   * "label the endpoint, the extreme, or the one series the story is about" —
   * direct labels work *because* they are sparing (SPEC 11.5).
   */
  priority: number;
  seriesId: string;
  datum: number;
  /**
   * Fill luminance when the label sits inside a colored mark, so core can pick
   * white or ink. Absent means the label sits on the surface and uses a text
   * token — **text never wears the data color** (SPEC 11.5).
   */
  insideFill?: ColorString;
}

/** A hit region as a chart type emits it, before core grows it to 24 × 24. */
export type ChartHitRegion = Omit<HitRegion, 'id'> & {
  /** Core assigns the final id; supply one only to keep a stable focus order. */
  id?: string;
};

// ─────────────────────────────────────────────────────────────────────────────
// encode
// ─────────────────────────────────────────────────────────────────────────────

/** Everything `encode` may read (SPEC 18 stage 5). */
export interface EncodeInput {
  /** The resolved block. Read `attrs` for per-type attributes. */
  block: ResolvedBlock;
  /**
   * The prepared table (stage 4): types coerced, nulls normalised, transforms
   * applied. Never mutate it — it is memoised and shared with other blocks.
   */
  table: Table;
  /** Channel bindings, already normalised to the object form. */
  encoding: Encoding;
  /** Attributes after the cascade. */
  attrs: BlockAttrs;
  theme: Theme;
  level: ConformanceLevel;
  /** The only legitimate source of series colors. */
  palette: PaletteAllocator;
  locale: string;
  timezone: string;
  /** `now()`, pinned (SPEC 24.3 rule 2). */
  buildTime: Date;
  /** Report `MDV3xxx` here. Never throw for document content. */
  diagnostic(d: Diagnostic): void;
}

/**
 * What `encode` returns (SPEC 18 stage 5). Renderer-agnostic: no pixels, no
 * geometry, no DOM.
 */
export interface EncodeResult<M extends Mark = Mark> {
  /** Mark data in **data space**, in paint order. */
  marks: readonly M[];
  /**
   * Series, with palette slots already assigned. Order is first-appearance order
   * over the unfiltered domain, which is also the legend order.
   */
  series: readonly SeriesDescriptor[];
  /**
   * The constructed scales, keyed by channel. Core ticks these for the axes, so
   * they must be the same instances the marks were computed against.
   */
  scales: ScaleBundle;
  /**
   * Axes core should draw. An empty array means the type has no axes (pie,
   * metric, treemap). There is **no second value axis** (SPEC 7.3.1).
   */
  axes: readonly AxisModel[];
  /**
   * The legend, or `undefined` for none. `undefined` is correct for a single
   * series: the title names it, and a one-swatch box is pure overhead (SPEC 7.4).
   */
  legend?: LegendModel;
  /** Rows the encoder dropped (log-scale non-positives, unparseable cells). */
  droppedRows?: number;
  /**
   * A type-specific table view, when the default projection of the prepared table
   * would misrepresent the chart (OHLC, box plots, sankey). Core builds the
   * default from the bound columns when this is absent.
   */
  a11yTable?: A11yTable;
  /**
   * The columns the encoding actually bound, in channel order.
   *
   * Core builds the table view from these (SPEC 12.3). When it is absent core
   * infers them from `series[].source`, which is a good guess and no more: a
   * long-form encoding's `source` is the *series field's value*, not a column
   * name, so the inference silently finds nothing and falls back to projecting
   * the whole table. A type that knows its bindings should say so.
   *
   * `MarkSet` — SPEC 26.1's name for stage 5's output — has always declared this
   * field. `EncodeResult` is what `ChartType.encode` actually returns, and it did
   * not, so the information had nowhere to go.
   */
  boundColumns?: readonly Column[];
  /**
   * Space the type needs *inside* the plot frame that core cannot infer — a
   * volume pane under an OHLCV chart, a color bar for a heatmap. Core subtracts
   * it before computing the frame handed to `layout`.
   */
  reserved?: { top?: number; right?: number; bottom?: number; left?: number };
  /**
   * Where that space ended up. **Core writes this on the way into `layout`;
   * `encode` never sets it** — at encode time the block size is not known.
   *
   * Reserving space without being told where it landed is not enough to draw
   * into it: `layout` is handed the plot rectangle, and the reserved band is
   * separated from the plot by whatever the axes measured out to, which happens
   * after the reservation. So the request goes up in `reserved` and the answer
   * comes back down here, on the same object.
   */
  reservedFrames?: ReservedFrames;
  /**
   * Opaque per-type state, carried from `encode` to `layout` untouched.
   *
   * `layout(encoded, frame, ctx)` receives neither the block, nor its attributes,
   * nor the prepared table, yet every real chart type needs resolved attributes
   * at geometry time — `bar` needs `orientation` and `corner`, `pie` needs
   * `innerRadius`. Core's contract is already that it hands back "this type's own
   * `encode` output" (see {@link ChartType.layout}), so the value survives the
   * round trip; this member is that contract written down.
   *
   * **Core never reads it and never constructs it.** Narrow it in the type's own
   * declaration:
   *
   * ```ts
   * interface BarEncode extends EncodeResult<BarMark> { readonly state: BarPlan }
   * ```
   *
   * Core does preserve it: `layout/block.ts` rebuilds the result as
   * `{ ...encoded, scales, axes }`, and the spread carries `state` across.
   */
  state?: unknown;
}

// ─────────────────────────────────────────────────────────────────────────────
// layout
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What `layout` returns.
 *
 * SPEC 21 describes layout as producing scene nodes; this record is that plus the
 * three things a mark cannot express on its own — its hit targets, the defs it
 * references, and the labels it would like placed.
 */
export interface ChartLayoutResult {
  /**
   * Mark nodes in paint order, in **scene coordinates** (origin at the block's
   * top-left, not at the frame's). Core wraps them in a group and clips to the
   * frame; a chart type does not need its own clip unless it wants one.
   */
  nodes: SceneNode[];
  /** Hit targets for the marks. Core grows each to ≥ 24 × 24 (SPEC 7.5). */
  hits: ChartHitRegion[];
  /** Gradients, patterns and clips the nodes reference by id. */
  defs?: Def[];
  /** Direct labels to place, subject to core's collision resolution (SPEC 11.5). */
  labels?: DirectLabel[];
  /** Geometry-time diagnostics, e.g. `MDV5010` after downsampling. */
  diagnostics?: Diagnostic[];
}

// ─────────────────────────────────────────────────────────────────────────────
// describe
// ─────────────────────────────────────────────────────────────────────────────

/** Input to the optional accessible-description generator (SPEC 12.2). */
export interface DescribeInput<M extends Mark = Mark> {
  block: ResolvedBlock;
  table: Table;
  encoded: EncodeResult<M>;
  locale: string;
  timezone: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The chart type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One registered chart type.
 *
 * A chart type is a **pure function to a scene graph**: same inputs, same nodes,
 * every time. Built-ins and plugin types (SPEC 26.1 `ChartTypeDefinition`) satisfy
 * the same interface, which is why a plugin chart automatically gets PDF export,
 * the table view, keyboard interaction and determinism testing.
 */
export interface ChartType<M extends Mark = Mark> {
  /** The block type token as it appears in the info string, lowercased. */
  readonly name: string;
  /** Alternative spellings that resolve to this type, e.g. `candlestick` → `ohlcv`. */
  readonly aliases?: readonly string[];
  /** The conformance level this type belongs to (SPEC 16.1). */
  readonly level: ConformanceLevel;
  /** Which hover layer core installs (SPEC 7.5). */
  readonly family: ChartFamily;
  /** The channels this type accepts, in documentation order. */
  readonly channels: readonly ChannelSpec[];
  /**
   * Channel bindings applied when the author supplies none — cascade level 1
   * (SPEC 5.5). Merged *under* the author's encoding, never over it.
   */
  readonly defaultEncoding: Encoding;
  /** Per-type attribute defaults, also cascade level 1 (`stack: 'none'`, `corner: 4`). */
  readonly defaults?: Partial<BlockAttrs>;
  /**
   * `$id` of this type's JSON Schema in `@mdv/spec` (SPEC Appendix D), e.g.
   * `"https://mdv.dev/schema/1.0/block/bar.json"`. Core runs schema validation
   * before calling {@link validate}, so `MDV3010` and friends come out of the
   * schema rather than out of hand-written code.
   */
  readonly schemaId?: string;
  /**
   * Minimum useful width in px. Below it, core switches to the type's compact
   * variant — usually: legend below the plot, thinner ticks (SPEC 8.1).
   * @defaultValue 240
   */
  readonly minWidth?: number;

  /**
   * Semantic validation the schema cannot express: channel/field-type
   * compatibility, cross-attribute rules, security limits.
   *
   * Runs after schema validation and before `encode`. Returning at least one
   * `error` means core skips `encode`/`layout` and renders the error card with
   * the data table instead.
   *
   * @returns diagnostics in source order; an empty array when the block is valid
   */
  validate(block: ResolvedBlock, table: Table): Diagnostic[];

  /**
   * Stage 5 (SPEC 18): table + encoding → marks.
   *
   * Assign series identity, allocate palette slots through
   * {@link EncodeInput.palette}, construct scales, compute domains, and produce
   * mark data in data space. No geometry, no pixels, no theme colors other than
   * those the allocator hands out.
   */
  encode(input: EncodeInput): EncodeResult<M>;

  /**
   * Stage 6 (SPEC 18): marks + frame → scene nodes.
   *
   * Pure: the same `(encoded, frame, ctx)` MUST produce byte-identical output.
   *
   * @param encoded - this type's own {@link encode} output
   * @param frame - the plot rectangle core reserved, in scene coordinates. Axes,
   * legend, titles and padding are already outside it.
   * @param ctx - theme, metrics, locale, level, ids, diagnostics
   */
  layout(encoded: EncodeResult<M>, frame: Rect, ctx: LayoutContext): ChartLayoutResult;

  /**
   * Generate the accessible description when the block has no `desc`
   * (SPEC 12.2). Core supplies a generic fallback when this is absent, but a
   * type-specific one is far better:
   *
   * > "Bar chart. Revenue by quarter, 4 categories. Values range from 1,240 in Q1
   * > to 1,893 in Q4. Highest: Q4."
   *
   * The result is marked `descGenerated: true` so authoring tools can prompt for
   * a better one. Returning an empty string means "I cannot describe this" and
   * yields `MDV3091`.
   */
  describe?(input: DescribeInput<M>): string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A set of chart types.
 *
 * **There is no global registry.** SPEC 17.3 invariant 4 forbids global mutable
 * state: two documents must render concurrently without interference, which a
 * module-level `Map` makes impossible — a plugin registered by one document would
 * leak into another, and a VS Code preview would poison the language server.
 *
 * Each `Mdv` instance owns one registry, built by {@link createChartRegistry} and
 * frozen before the first render.
 */
export interface ChartTypeRegistry {
  /**
   * Add a type. A later registration for the same name replaces the earlier one
   * and, when the earlier one was a built-in, the caller emits `MDV1520` (info)
   * — plugins are ordered and later ones win (SPEC 26.2).
   *
   * @throws MdvConfigError if the registry has been frozen
   */
  register(type: ChartType): void;
  /** Look up by name or by alias. `undefined` for an unknown type (`MDV1500`). */
  get(name: string): ChartType | undefined;
  has(name: string): boolean;
  /** Every registered type, sorted by name — deterministic, not insertion order. */
  list(): readonly ChartType[];
  /**
   * A child registry that starts with this one's contents. Registrations on the
   * child are invisible to the parent, which is how a per-document plugin set is
   * layered over the shared built-ins without copying them.
   */
  extend(): ChartTypeRegistry;
  /** Reject further registration. Called once, before the first render. */
  freeze(): void;
  readonly frozen: boolean;
}

/** Internal registry implementation. Not exported — construct via the factory. */
class Registry implements ChartTypeRegistry {
  readonly #parent: Registry | undefined;
  readonly #own = new Map<string, ChartType>();
  readonly #aliases = new Map<string, string>();
  #frozen = false;

  constructor(parent?: Registry) {
    this.#parent = parent;
  }

  get frozen(): boolean {
    return this.#frozen;
  }

  register(type: ChartType): void {
    if (this.#frozen) {
      throw new Error(`Cannot register chart type "${type.name}": the registry is frozen`);
    }
    this.#own.set(type.name, type);
    for (const alias of type.aliases ?? []) this.#aliases.set(alias, type.name);
  }

  get(name: string): ChartType | undefined {
    const canonical = this.#aliases.get(name) ?? name;
    return this.#own.get(canonical) ?? this.#parent?.get(canonical);
  }

  has(name: string): boolean {
    return this.get(name) !== undefined;
  }

  list(): readonly ChartType[] {
    const merged = new Map<string, ChartType>();
    for (const type of this.#parent?.list() ?? []) merged.set(type.name, type);
    for (const [name, type] of this.#own) merged.set(name, type);
    // Sorted by code unit, not by locale: locale-dependent sorting is
    // non-deterministic across hosts (SPEC 24.3 rule 3).
    return [...merged.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  extend(): ChartTypeRegistry {
    return new Registry(this);
  }

  freeze(): void {
    this.#frozen = true;
  }
}

/**
 * Create a chart-type registry.
 *
 * @param seed - types to register immediately, in order. Later entries override
 * earlier ones with the same name (SPEC 26.2).
 *
 * @example
 * ```ts
 * import { createChartRegistry } from '@mdv/core';
 * import { builtinChartTypes } from '@mdv/charts';
 *
 * const registry = createChartRegistry(builtinChartTypes);
 * registry.register(myPluginType);   // overrides a built-in of the same name
 * registry.freeze();
 * ```
 */
export function createChartRegistry(seed?: Iterable<ChartType>): ChartTypeRegistry {
  const registry = new Registry();
  for (const type of seed ?? []) registry.register(type);
  return registry;
}

/**
 * The structural check that turns a plugin's `chartTypes` entry into a
 * {@link ChartType}.
 *
 * `MdvPlugin.chartTypes` is declared `readonly unknown[]` on purpose — typing it
 * as `ChartType[]` would make `types/config.ts` import this module and close a
 * cycle. That door has to be opened *somewhere*, and a cast at each call site
 * would open it silently; this is the one place where `unknown` becomes
 * `ChartType`, and it checks rather than asserts.
 *
 * What it checks is the part core actually calls: the three stage functions, the
 * name it keys the registry by, and the `channels`/`defaultEncoding` the cascade
 * reads. It does not walk `channels` element by element — a plugin that declares
 * a malformed `ChannelSpec` gets a diagnostic from validation, not a rejected
 * registration, because a partly-wrong chart type should still draw.
 */
export function isChartType(value: unknown): value is ChartType {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ChartType>;
  return (
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.level === 'number' &&
    typeof candidate.family === 'string' &&
    Array.isArray(candidate.channels) &&
    typeof candidate.defaultEncoding === 'object' &&
    candidate.defaultEncoding !== null &&
    typeof candidate.validate === 'function' &&
    typeof candidate.encode === 'function' &&
    typeof candidate.layout === 'function'
  );
}

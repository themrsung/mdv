/**
 * `heatmap` — magnitude across two discrete dimensions (SPEC 8.9).
 *
 * ## What the type is
 *
 * A grid of cells: one key along the columns, one down the rows, and a number
 * in each cell mapped to a colour. Two band scales and a colour ramp; there is
 * no value axis, because the value is the fill.
 *
 * ## The three decisions this file makes
 *
 * 1. **Colour is the encoding, so the ramp is the legend.** SPEC 8.9: "the
 *    legend is a continuous ramp with labelled ends and midpoint". Unlike a
 *    swatch legend, it is not overhead for a single series — it is the only
 *    thing on the chart that says what a colour is worth, so `auto` means yes
 *    ({@link buildRampLegend}).
 *
 * 2. **Missing combinations are drawn, not skipped.** A heatmap's grid is the
 *    cross product of the two domains; the data is usually sparse. The slots no
 *    row landed in get `nullFill` (`transparent` by default), painted *before*
 *    the cells so a gap never sits on top of data. Painting one backdrop under
 *    the whole grid instead would be cheaper and wrong: it would also fill the
 *    `cellGap` lines, which belong to the surface.
 *
 * 3. **Row and column order is data order unless the author says otherwise.**
 *    `asc`/`desc` sort the keys; `cluster` runs the seriation in
 *    `internal/seriate.ts` so that similar rows sit adjacent (SPEC 8.9); an
 *    explicit list puts the named keys first, in the order given, and leaves
 *    the rest in data order rather than dropping them.
 *
 * ## Determinism
 *
 * Marks are emitted in **grid order** (row-major over the resolved domains),
 * not table order, so shuffling the rows of the source table cannot change the
 * scene graph. Where two rows land in the same slot they stay in table order
 * and the later one paints last — the visible cell and the single hit region
 * agree about which row won (SPEC 24.3).
 */

import type {
  A11yTable,
  AxisModel,
  CellMark,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  Column,
  DataType,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  LegendModel,
  LegendRamp,
  Rect,
  ResolvedBlock,
  ScaleInput,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import type { ColorRamp, ColorScaleKind } from './internal/ramp.js';
import type { Cell } from './internal/seriate.js';
import { autoNumberAttr, enumAttr, numberAttr, rawAttr, stringAttr } from './internal/attrs.js';
import {
  axisSpecFor,
  isDegenerateFrame,
  makeAxis,
  rangeDownFrame,
  rangeToFrame,
} from './internal/cartesian.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import {
  buildA11yTable,
  composeDescription,
  countPhrase,
  extremesOf,
  presentationOf,
  subjectPhrase,
  viewColumn,
} from './internal/a11y.js';
import { buildRampLegend } from './internal/series.js';
import { px } from './internal/geometry.js';
import {
  bindField,
  cell,
  cellNumber,
  cellScaleInput,
  channelFormat,
  findColumn,
  firstChannel,
  humaniseColumn,
  isQuantitative,
} from './internal/table.js';
import { compareNumbers, compareStrings } from './internal/num.js';
import { createBandScale, discreteKey } from './internal/scale.js';
import { formatNumber, formatValue } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { planOf } from './internal/plan.js';
import { readableOn, solid, tickFont } from './internal/paint.js';
import {
  COLOR_SCALE_KINDS,
  createColorRamp,
  resolveDivergingArms,
  resolveScheme,
  schemeNames,
} from './internal/ramp.js';
import { clusterOrder, transpose } from './internal/seriate.js';
import { extentOf } from './internal/domain.js';

/** The named orderings a heatmap axis accepts (SPEC 8.9 `sort`). */
const SORT_MODES = ['asc', 'desc', 'cluster'] as const;
type SortMode = (typeof SORT_MODES)[number];

/**
 * One axis' ordering request.
 *
 * `undefined` is data order — first appearance, which for a table that arrived
 * from a `GROUP BY` is usually already the order the author meant.
 */
type AxisOrder = SortMode | { readonly list: readonly string[] } | undefined;

/** `auto` measures the cell; the boolean and the format string do not. */
type LabelMode = 'auto' | 'on' | 'off';

/** A cell must be wider than this before `cellLabel: auto` writes in it. */
const AUTO_LABEL_WIDTH = 32;
/** …and taller than this (SPEC 8.9: "cells exceed 32 × 24 px"). */
const AUTO_LABEL_HEIGHT = 24;

/** Keep a cell visible when the gap would otherwise eat the whole band. */
const MIN_CELL_SIDE = 1;

/** The heatmap attributes, resolved (SPEC 8.9). */
interface HeatmapOptions {
  kind: ColorScaleKind;
  midpoint: number;
  domain: readonly [number, number] | undefined;
  /** `bins` — classes to cut the ramp into; `undefined` leaves it continuous. */
  bins: number | undefined;
  thresholds: readonly number[] | undefined;
  label: LabelMode;
  labelFormat: string | undefined;
  cellGap: number;
  cellRadius: number;
  nullFill: ColorString;
  sortX: AxisOrder;
  sortY: AxisOrder;
}

/**
 * What `encode` resolved and `layout` needs.
 *
 * The fills are resolved here rather than in `layout` because the ramp is built
 * from the value domain, which is encode's business; `layout` only places
 * rectangles. See `internal/plan.ts` for why this travels in `state`.
 */
interface HeatmapPlan {
  cellGap: number;
  cellRadius: number;
  nullFill: ColorString;
  label: LabelMode;
  labelFormat: string | undefined;
  /** The fill for each mark, by mark index. `undefined` where the value is not a number. */
  fills: readonly (ColorString | undefined)[];
  /** `column:row` for every slot a mark landed in — the complement gets `nullFill`. */
  filled: readonly string[];
  columns: number;
  rows: number;
  /** What the cells measure, for the generated description. */
  measure: string | undefined;
  /** What the columns are keyed by. */
  columnKey: string | undefined;
  /** What the rows are keyed by. */
  rowKey: string | undefined;
  valueFormat: string | undefined;
}

const DEFAULT_PLAN: HeatmapPlan = {
  cellGap: 2,
  cellRadius: 2,
  nullFill: 'transparent',
  label: 'auto',
  labelFormat: undefined,
  fills: [],
  filled: [],
  columns: 0,
  rows: 0,
  measure: undefined,
  columnKey: undefined,
  rowKey: undefined,
  valueFormat: undefined,
};

type HeatmapEncodeResult = PlannedEncodeResult<CellMark, HeatmapPlan>;

/** Keys can be anything a band scale accepts; the magnitude cannot. */
const KEY_TYPES: readonly DataType[] = [
  'string',
  'category',
  'boolean',
  'date',
  'datetime',
  'time',
  'number',
  'integer',
];
const VALUE_TYPES: readonly DataType[] = ['number', 'integer', 'duration'];

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: KEY_TYPES,
    defaultScale: 'band',
    doc: 'The key along the columns.',
  },
  {
    name: 'y',
    required: true,
    accepts: KEY_TYPES,
    defaultScale: 'band',
    doc: 'The key down the rows.',
  },
  {
    name: 'value',
    required: true,
    accepts: VALUE_TYPES,
    defaultScale: 'linear',
    doc: 'The magnitude each cell colours.',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Read one axis' `sort` entry: a named rule, or an explicit list of keys. */
function readOrder(value: unknown, onUnknown: (text: string) => void): AxisOrder {
  if (value === undefined || value === null || value === false) return undefined;
  if (Array.isArray(value)) {
    const list = value
      .filter((entry): entry is ScaleInput => entry !== null && entry !== undefined)
      .map((entry) => discreteKey(entry));
    return list.length === 0 ? undefined : { list };
  }
  const text = String(value).trim().toLowerCase();
  if (text === '') return undefined;
  for (const mode of SORT_MODES) if (mode === text) return mode;
  onUnknown(text);
  return undefined;
}

/**
 * Read `sort` (SPEC 8.9).
 *
 * The documented form is per-axis — `sort: {x: asc, y: cluster}`. A bare
 * `sort: asc` is taken to mean both axes: an author who writes it on a heatmap
 * is asking for the grid to be in order, and answering "which axis?" with
 * silence would be pedantry.
 */
function readSort(
  value: unknown,
  onUnknown: (text: string) => void,
): { x: AxisOrder; y: AxisOrder } {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return { x: readOrder(record['x'], onUnknown), y: readOrder(record['y'], onUnknown) };
  }
  const both = readOrder(value, onUnknown);
  return { x: both, y: both };
}

/** `cellLabel: true | false | auto | <number format>` (SPEC 8.9). */
function readCellLabel(value: unknown): { label: LabelMode; labelFormat: string | undefined } {
  if (value === undefined || value === null) return { label: 'auto', labelFormat: undefined };
  if (typeof value === 'boolean') {
    return { label: value ? 'on' : 'off', labelFormat: undefined };
  }
  const text = String(value).trim();
  if (text === '' || text.toLowerCase() === 'auto') {
    return { label: 'auto', labelFormat: undefined };
  }
  if (text.toLowerCase() === 'true') return { label: 'on', labelFormat: undefined };
  if (text.toLowerCase() === 'false') return { label: 'off', labelFormat: undefined };
  // Anything else is a number format, and asking for a format is asking for the
  // label (SPEC 8.9: `boolean | format`).
  return { label: 'on', labelFormat: text };
}

/** The author's explicit cuts for `colorScale: threshold`, ascending. */
function readThresholds(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    const numeric = cellNumber(entry as never);
    if (numeric !== null) out.push(numeric);
  }
  return out.length === 0 ? undefined : out.slice().sort(compareNumbers);
}

/** The `domain` pair, when the author pinned the ramp's extent. */
function readDomain(value: unknown): readonly [number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) return undefined;
  const lo = cellNumber(value[0] as never);
  const hi = cellNumber(value[1] as never);
  if (lo === null || hi === null) return undefined;
  return [lo, hi];
}

function readOptions(input: EncodeInput): HeatmapOptions {
  const { attrs, block } = input;
  const requested = enumAttr(attrs, 'colorScale', COLOR_SCALE_KINDS, 'sequential', (text) => {
    input.diagnostic(unknownEnum(block, 'colorScale', text, [...COLOR_SCALE_KINDS], 'sequential'));
  });
  const bins = autoNumberAttr(attrs, 'bins', 2, 32);
  // "Discretises a continuous ramp" (SPEC 8.9). `bins` on a scale that is
  // already classed is its class count; on a sequential ramp it is a request to
  // band it, which is what `quantize` is.
  const kind: ColorScaleKind =
    bins !== undefined && requested === 'sequential' ? 'quantize' : requested;
  const { label, labelFormat } = readCellLabel(rawAttr(attrs, 'cellLabel'));
  return {
    kind,
    midpoint: numberAttr(attrs, 'midpoint', 0),
    domain: readDomain(rawAttr(attrs, 'domain')),
    bins,
    thresholds: readThresholds(rawAttr(attrs, 'thresholds')),
    label,
    labelFormat,
    cellGap: numberAttr(attrs, 'cellGap', 2, 0, 24),
    cellRadius: numberAttr(attrs, 'cellRadius', 2, 0, 24),
    nullFill: (stringAttr(attrs, 'nullFill') ?? 'transparent') as ColorString,
    ...readSortAttr(input),
  };
}

/** Split out so {@link readOptions} stays one expression per attribute. */
function readSortAttr(input: EncodeInput): { sortX: AxisOrder; sortY: AxisOrder } {
  const order = readSort(rawAttr(input.attrs, 'sort'), (text) => {
    input.diagnostic(
      unknownEnum(input.block, 'sort', text, [...SORT_MODES, 'or a list of keys'], 'data order'),
    );
  });
  return { sortX: order.x, sortY: order.y };
}

// ─────────────────────────────────────────────────────────────────────────────
// Ordering
// ─────────────────────────────────────────────────────────────────────────────

/** Compare two keys the way their type wants: numerically, by instant, or by text. */
function compareValues(a: ScaleInput | undefined, b: ScaleInput | undefined): number {
  if (a === undefined || b === undefined) return 0;
  if (typeof a === 'number' && typeof b === 'number') return compareNumbers(a, b);
  if (a instanceof Date && b instanceof Date) return compareNumbers(a.getTime(), b.getTime());
  return compareStrings(String(a), String(b));
}

/**
 * The permutation one axis' `sort` asks for, as indices into the data-order
 * domain.
 *
 * Every branch returns a permutation of exactly the same indices, so the caller
 * can apply it without checking: a `sort` never adds or removes a row.
 */
function permutationFor(
  order: AxisOrder,
  domain: readonly ScaleInput[],
  keys: readonly string[],
  clustered: () => readonly number[],
): readonly number[] {
  const identity = domain.map((_, index) => index);
  if (order === undefined) return identity;
  if (order === 'cluster') {
    const ordered = clustered();
    return ordered.length === identity.length ? ordered : identity;
  }
  if (order === 'asc' || order === 'desc') {
    const sorted = identity.slice().sort((a, b) => compareValues(domain[a], domain[b]));
    return order === 'asc' ? sorted : sorted.reverse();
  }
  // An explicit list. Unnamed keys keep their data order after the named ones —
  // a list is a request to promote, not a filter, and dropping the rest would
  // hide data the author never mentioned.
  const rank = new Map<string, number>();
  for (const [index, key] of order.list.entries()) if (!rank.has(key)) rank.set(key, index);
  const unlisted = order.list.length;
  return identity
    .slice()
    .sort((a, b) =>
      compareNumbers(rank.get(keys[a] ?? '') ?? unlisted, rank.get(keys[b] ?? '') ?? unlisted),
    );
}

/** `[2, 0, 1]` → `[1, 2, 0]`: where each original index ended up. */
function inverseOf(permutation: readonly number[]): readonly number[] {
  const out = permutation.map(() => 0);
  for (const [position, original] of permutation.entries()) out[original] = position;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// encode
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one series a heatmap has.
 *
 * Colour comes from the ramp, not from the palette, but a series still has to
 * exist: it carries the label the readout and the table view use, and core's
 * contract has no shape for "no series".
 */
function singleSeries(input: EncodeInput, column: Column | undefined): SeriesDescriptor {
  const palette = input.palette;
  const patternDef = palette.patternDef('');
  return {
    id: '',
    label: column === undefined ? 'Value' : humaniseColumn(column),
    slot: palette.slot(''),
    color: palette.color(''),
    source: column?.name ?? '',
    ...(patternDef === undefined ? {} : { patternDef }),
  };
}

/** A well-formed empty result, for a block with nothing to draw. */
function emptyResult(input: EncodeInput, series: readonly SeriesDescriptor[]): HeatmapEncodeResult {
  const empty: A11yTable = {
    caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
    columns: [],
    rows: [],
    presentation: presentationOf(input.attrs),
  };
  return {
    marks: [],
    series,
    scales: { x: createBandScale({ domain: [] }), y: createBandScale({ domain: [] }) },
    axes: [],
    a11yTable: empty,
    state: DEFAULT_PLAN,
  };
}

/** The stops and labels the ramp legend draws (SPEC 8.9). */
function rampLegend(ramp: ColorRamp, format: (value: number) => string): LegendRamp {
  return {
    stops: ramp.stops,
    labels: ramp.ticks.map((tick) => ({ at: tick.at, text: format(tick.value) })),
    ...(ramp.discrete ? { discrete: true } : {}),
  };
}

/** Build the ramp the cells are filled from, reporting an unusable `scheme`. */
function buildRamp(
  input: EncodeInput,
  options: HeatmapOptions,
  domain: readonly [number, number],
  values: readonly number[],
): ColorRamp {
  const requested = rawAttr(input.attrs, 'scheme');
  const scheme = resolveScheme(input.theme, requested);
  if (scheme.fallback === 'unknown') {
    input.diagnostic(
      unknownEnum(
        input.block,
        'scheme',
        String(requested),
        schemeNames(input.theme),
        'the theme ramp',
      ),
    );
  }
  if (options.kind !== 'diverging') {
    return createColorRamp({
      kind: options.kind,
      domain,
      steps: scheme.steps,
      ...(options.bins === undefined ? {} : { classes: options.bins }),
      ...(options.kind === 'quantile' ? { values } : {}),
      ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    });
  }
  const diverging = resolveDivergingArms(input.theme, requested);
  if (diverging.fallback === 'single-hue') {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `\`scheme: ${String(requested)}\` names one hue, and a diverging ramp needs two`,
        "Using the theme's diverging arms. Name two ramps, or list the colors low-to-high.",
      ),
    );
  }
  return createColorRamp({
    kind: 'diverging',
    domain,
    steps: scheme.steps,
    arms: diverging.arms,
    midpoint: options.midpoint,
  });
}

/** One row of the source table, reduced to a grid slot. */
interface Entry {
  column: number;
  row: number;
  datum: number;
  value: number | null;
  x: ScaleInput;
  y: ScaleInput;
}

function encode(input: EncodeInput): EncodeResult<CellMark> {
  const { table } = input;
  const xChannel = firstChannel(input.encoding, 'x');
  const yChannel = firstChannel(input.encoding, 'y');
  const valueChannel = firstChannel(input.encoding, 'value');
  const xBound = bindField(table, xChannel);
  const yBound = bindField(table, yChannel);
  const valueBound = bindField(table, valueChannel);
  const series = [singleSeries(input, valueBound?.column)];
  if (xBound === undefined || yBound === undefined || valueBound === undefined) {
    return emptyResult(input, series);
  }

  const options = readOptions(input);

  // ── The two domains, in first-appearance order ─────────────────────────────
  const xDomain: ScaleInput[] = [];
  const xKeys: string[] = [];
  const xIndex = new Map<string, number>();
  const yDomain: ScaleInput[] = [];
  const yKeys: string[] = [];
  const yIndex = new Map<string, number>();
  const entries: Entry[] = [];
  let dropped = 0;

  for (let row = 0; row < table.rows.length; row += 1) {
    const x = cellScaleInput(cell(table, row, xBound.index));
    const y = cellScaleInput(cell(table, row, yBound.index));
    if (x === null || x === undefined || y === null || y === undefined) {
      // A cell with no key has nowhere to sit. It is not a gap in the grid —
      // gaps are combinations that never appeared — it is a row off the grid.
      dropped += 1;
      continue;
    }
    const xKey = discreteKey(x);
    const yKey = discreteKey(y);
    let column = xIndex.get(xKey);
    if (column === undefined) {
      column = xDomain.length;
      xIndex.set(xKey, column);
      xDomain.push(x);
      xKeys.push(xKey);
    }
    let line = yIndex.get(yKey);
    if (line === undefined) {
      line = yDomain.length;
      yIndex.set(yKey, line);
      yDomain.push(y);
      yKeys.push(yKey);
    }
    entries.push({
      column,
      row: line,
      datum: row,
      value: cellNumber(cell(table, row, valueBound.index)),
      x,
      y,
    });
  }

  if (entries.length === 0) return emptyResult(input, series);

  // ── The matrix, for seriation and for the extent ───────────────────────────
  const matrix: Cell[][] = yDomain.map(() => xDomain.map(() => undefined));
  for (const entry of entries) {
    const line = matrix[entry.row];
    if (line !== undefined) line[entry.column] = entry.value;
  }

  const rowOrder = permutationFor(options.sortY, yDomain, yKeys, () => clusterOrder(matrix));
  const columnOrder = permutationFor(options.sortX, xDomain, xKeys, () =>
    clusterOrder(transpose(matrix)),
  );
  const rowAt = inverseOf(rowOrder);
  const columnAt = inverseOf(columnOrder);

  // ── Marks, in grid order ───────────────────────────────────────────────────
  const placed = entries.map((entry) => ({
    ...entry,
    column: columnAt[entry.column] ?? entry.column,
    row: rowAt[entry.row] ?? entry.row,
  }));
  placed.sort(
    (a, b) =>
      compareNumbers(a.row, b.row) ||
      compareNumbers(a.column, b.column) ||
      compareNumbers(a.datum, b.datum),
  );

  const values: number[] = [];
  for (const entry of placed) if (entry.value !== null) values.push(entry.value);
  const extent = options.domain ?? extentOf(values) ?? [0, 1];
  const ramp = buildRamp(input, options, extent, values);

  const marks: CellMark[] = [];
  const fills: (ColorString | undefined)[] = [];
  const filled: string[] = [];
  const valueFormat = channelFormat(valueChannel, valueBound.column);
  for (const entry of placed) {
    marks.push({
      mark: 'cell',
      seriesId: '',
      datum: entry.datum,
      x: entry.x,
      y: entry.y,
      value: entry.value,
    });
    // A missing cell has no place on the ramp: it is painted with `nullFill` at
    // layout time, not with a colour borrowed from one end of the scale.
    fills.push(entry.value === null ? undefined : ramp.color(entry.value));
    filled.push(`${entry.column}:${entry.row}`);
  }

  // ── Scales and axes ────────────────────────────────────────────────────────
  const categoryFormat = channelFormat(xChannel, xBound.column);
  const rowFormat = channelFormat(yChannel, yBound.column);
  const xScale = createBandScale({
    domain: columnOrder.map((index) => xDomain[index] ?? ''),
    padding: 0,
    ...(categoryFormat === undefined ? {} : { format: categoryFormat }),
  });
  const yScale = createBandScale({
    domain: rowOrder.map((index) => yDomain[index] ?? ''),
    padding: 0,
    ...(rowFormat === undefined ? {} : { format: rowFormat }),
  });

  const columnAxis = makeAxis({
    channel: 'x',
    position: 'bottom',
    scale: xScale,
    binding: xChannel,
    column: xBound.column,
    spec: axisSpecFor(input.attrs, 'x', xChannel),
    gridByDefault: false,
    baselineByDefault: false,
  });
  const rowAxis = makeAxis({
    channel: 'y',
    position: 'left',
    scale: yScale,
    binding: yChannel,
    column: yBound.column,
    spec: axisSpecFor(input.attrs, 'y', yChannel),
    gridByDefault: false,
    baselineByDefault: false,
  });
  const axes: AxisModel[] = [columnAxis, rowAxis].filter(
    (axis): axis is AxisModel => axis !== undefined,
  );

  const legend: LegendModel | undefined = buildRampLegend(
    input.attrs,
    rampLegend(ramp, (value) => formatNumber(value, valueFormat)),
  );

  const plan: HeatmapPlan = {
    cellGap: options.cellGap,
    cellRadius: options.cellRadius,
    nullFill: options.nullFill,
    label: options.label,
    labelFormat: options.labelFormat ?? valueFormat,
    fills,
    filled,
    columns: xDomain.length,
    rows: yDomain.length,
    measure: humaniseColumn(valueBound.column),
    columnKey: humaniseColumn(xBound.column),
    rowKey: humaniseColumn(yBound.column),
    valueFormat,
  };

  const result: HeatmapEncodeResult = {
    marks,
    series,
    scales: { x: xScale, y: yScale },
    axes,
    a11yTable: buildA11yTable(
      input.table,
      [viewColumn(xBound), viewColumn(yBound), viewColumn(valueBound)].filter(
        (c): c is NonNullable<typeof c> => c !== undefined,
      ),
      input.attrs.title ?? input.attrs.caption ?? 'Chart data',
      presentationOf(input.attrs),
    ),
    boundColumns: [xBound.column, yBound.column, valueBound.column],
    ...(legend === undefined ? {} : { legend }),
    ...(dropped === 0 ? {} : { droppedRows: dropped }),
    state: plan,
  };
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// layout
// ─────────────────────────────────────────────────────────────────────────────

/** Whether a cell of this size gets its value written in it. */
function labelsFit(plan: HeatmapPlan, width: number, height: number): boolean {
  if (plan.label === 'off') return false;
  if (plan.label === 'on') return true;
  return width > AUTO_LABEL_WIDTH && height > AUTO_LABEL_HEIGHT;
}

function layout(
  encoded: EncodeResult<CellMark>,
  frame: Rect,
  ctx: LayoutContext,
): ChartLayoutResult {
  const plan = planOf<CellMark, HeatmapPlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];
  const xScale = encoded.scales.x;
  const yScale = encoded.scales.y;
  if (xScale === undefined || yScale === undefined) return { nodes, hits };
  if (isDegenerateFrame(frame)) return { nodes, hits };

  rangeToFrame(frame, xScale, undefined);
  // The rows read top to bottom, like the table they came from: the first
  // category sits at the top of the frame, not the bottom (SPEC 8.9).
  rangeDownFrame(frame, yScale);

  const columnBand = xScale.bandwidth === undefined ? 0 : xScale.bandwidth();
  const rowBand = yScale.bandwidth === undefined ? 0 : yScale.bandwidth();
  const gap = Math.min(plan.cellGap, columnBand / 2, rowBand / 2);
  const width = Math.max(MIN_CELL_SIDE, columnBand - gap);
  const height = Math.max(MIN_CELL_SIDE, rowBand - gap);
  const radius = Math.min(plan.cellRadius, width / 2, height / 2);
  const withLabels = labelsFit(plan, width, height);
  const font = tickFont(ctx.theme);

  // ── The gaps first, so no missing combination paints over a cell ───────────
  if (plan.nullFill !== 'transparent' && plan.nullFill !== 'none') {
    const filled = new Set(plan.filled);
    const fill = solid(plan.nullFill);
    for (let row = 0; row < plan.rows; row += 1) {
      const y = yScale.range[0];
      for (let column = 0; column < plan.columns; column += 1) {
        if (filled.has(`${column}:${row}`)) continue;
        const left = xScale.scale(xScale.domain[column] ?? '');
        const top = yScale.scale(yScale.domain[row] ?? '');
        if (left === undefined || top === undefined || y === undefined) continue;
        nodes.push({
          kind: 'rect',
          id: ctx.ids.next('cell'),
          cls: 'mdv-mark mdv-mark-cell mdv-mark-empty',
          x: px(left + gap / 2),
          y: px(top + gap / 2),
          w: px(width),
          h: px(height),
          ...(radius > 0 ? { r: px(radius) } : {}),
          fill,
        });
      }
    }
  }

  // ── The cells ─────────────────────────────────────────────────────────────
  const series = encoded.series[0];
  const seen = new Map<string, number>();
  for (const [index, mark] of encoded.marks.entries()) {
    const left = xScale.scale(mark.x);
    const top = yScale.scale(mark.y);
    if (left === undefined || top === undefined) continue;
    const x = left + gap / 2;
    const y = top + gap / 2;
    // A row that was read but has no number in it is the same hole as a
    // combination that never appeared, and is treated the same way: `nullFill`
    // paints it, or nothing does. The two ways of being empty must produce the
    // same picture, and an invisible rectangle is bytes with no picture in them.
    const missing = plan.fills[index] === undefined;
    const fill = plan.fills[index] ?? plan.nullFill;
    if (fill !== 'transparent' && fill !== 'none') {
      nodes.push({
        kind: 'rect',
        id: ctx.ids.next('cell'),
        cls: missing ? 'mdv-mark mdv-mark-cell mdv-mark-empty' : 'mdv-mark mdv-mark-cell',
        x: px(x),
        y: px(y),
        w: px(width),
        h: px(height),
        ...(radius > 0 ? { r: px(radius) } : {}),
        fill: solid(fill),
      });
    }

    const text = mark.value === null ? '' : formatNumber(mark.value, plan.labelFormat);
    if (withLabels && text !== '') {
      nodes.push({
        kind: 'text',
        id: ctx.ids.next('label'),
        cls: 'mdv-label mdv-cell-label',
        x: px(x + width / 2),
        y: px(y + height / 2),
        text,
        font,
        // The label sits inside a fill the ramp chose, so its ink is chosen
        // against that fill and not against the surface (SPEC 11.5).
        fill: solid(readableOn(ctx.theme, fill)),
        anchor: 'middle',
        baseline: 'middle',
        tabular: true,
      });
    }

    // One region per slot: two readouts on one pixel is a worse answer than
    // one, and the row that answers is the row the reader can see on top.
    const key = `${discreteKey(mark.x)}\u0000${discreteKey(mark.y)}`;
    const previous = seen.get(key);
    const region = hitRegion({
      x,
      y,
      w: width,
      h: height,
      datumIndex: mark.datum,
      readout: [
        readout(plan.columnKey ?? 'Column', formatValue(mark.x)),
        readout(plan.rowKey ?? 'Row', formatValue(mark.y)),
        readout(plan.measure ?? 'Value', text === '' ? '—' : text, series, true),
      ],
    });
    if (previous === undefined) {
      seen.set(key, hits.length);
      hits.push(region);
    } else {
      hits[previous] = region;
    }
  }

  return { nodes, hits };
}

// ─────────────────────────────────────────────────────────────────────────────
// describe
// ─────────────────────────────────────────────────────────────────────────────

function describe(input: DescribeInput<CellMark>): string {
  const plan = planOf<CellMark, HeatmapPlan>(input.encoded, DEFAULT_PLAN);
  const marks = input.encoded.marks;
  if (marks.length === 0) return '';
  const format = (value: number): string => formatNumber(value, plan.valueFormat);
  const labelled: { label: string; value: number }[] = [];
  for (const mark of marks) {
    if (mark.value === null) continue;
    labelled.push({ label: `${formatValue(mark.x)}, ${formatValue(mark.y)}`, value: mark.value });
  }
  const extremes = extremesOf(labelled, format);
  const by =
    plan.columnKey === undefined || plan.rowKey === undefined
      ? undefined
      : `${plan.columnKey} and ${plan.rowKey}`;
  const subject = subjectPhrase(plan.measure, by);
  return composeDescription({
    chartKind: 'Heatmap',
    ...(subject === undefined ? {} : { subject }),
    scope: `${countPhrase(plan.rows, 'row')} × ${countPhrase(plan.columns, 'column')}`,
    ...(extremes === undefined
      ? {}
      : {
          range: `Values range from ${extremes.low.formatted} at ${extremes.low.label} to ${extremes.high.formatted} at ${extremes.high.label}`,
          extreme: `Highest: ${extremes.high.label}`,
        }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The type
// ─────────────────────────────────────────────────────────────────────────────

export const heatmapChart: ChartType<CellMark> = {
  name: 'heatmap',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    colorScale: 'sequential',
    midpoint: 0,
    cellLabel: 'auto',
    cellGap: 2,
    cellRadius: 2,
    nullFill: 'transparent',
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/heatmap.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const named = (channel: 'x' | 'y' | 'value', purpose: string): void => {
      const binding = firstChannel(block.encoding, channel);
      if (binding?.field === undefined) {
        diagnostics.push(missingChannel(block, channel, purpose));
        return;
      }
      if (findColumn(table, binding.field) === undefined && table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`${channel}\` names \`${binding.field}\`, which is not a column`,
          ),
        );
      }
    };

    named('x', 'the key along the columns');
    named('y', 'the key down the rows');
    named('value', 'the magnitude each cell colours');

    const valueChannel = firstChannel(block.encoding, 'value');
    const bound = bindField(table, valueChannel);
    if (bound !== undefined && !isQuantitative(bound.column.type)) {
      diagnostics.push(
        incompatibleField(block, 'value', bound.column.name, bound.column.type, VALUE_TYPES),
      );
    }

    return diagnostics;
  },

  encode,
  layout,
  describe,
};

export default heatmapChart;

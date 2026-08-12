/**
 * `histogram` — the distribution of one measure (SPEC 8.7).
 *
 * A histogram is a bar chart whose category axis is **continuous**: each bar
 * spans the bin it counts, so the bins tile the domain without a gap to divide
 * them. SPEC 8.7 is explicit about what that costs:
 *
 * > Bars in a histogram touch by default (no band padding) but keep the 2 px
 * > surface gap, because the x-axis is continuous.
 *
 * So there is no band scale and no `barPadding` here. Width comes from the bin
 * itself, and the only thing between two neighbours is the 2 px channel of
 * surface colour SPEC 11.4 requires of every pair of touching marks — never a
 * stroke, and never a cap on thickness, which would break the tiling the form
 * depends on.
 */

import type {
  AxisModel,
  BarMark,
  BlockAttrs,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import {
  boolAttr,
  autoNumberAttr,
  enumAttr,
  extentAttr,
  listAttr,
  numberAttr,
} from './internal/attrs.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './internal/cartesian.js';
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
import { buildLegend } from './internal/series.js';
import { barRadii, clampRadii, px } from './internal/geometry.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  findColumn,
  firstChannel,
  humaniseColumn,
  isQuantitative,
} from './internal/table.js';
import { clamp, compareNumbers, isFiniteNumber } from './internal/num.js';
import { createContinuousScale } from './internal/scale.js';
import { formatNumber } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { planOf } from './internal/plan.js';
import { seriesFill } from './internal/paint.js';
import { quantile } from './internal/stats.js';
import { extentOf, resolveDomain } from './internal/domain.js';

/** How a bin's count is expressed on the value axis (SPEC 8.7 `normalize`). */
const NORMALIZE_MODES = ['count', 'frequency', 'density'] as const;
type NormalizeMode = (typeof NORMALIZE_MODES)[number];

/** The Freedman–Diaconis rule is clamped to this range (SPEC 8.7 `bins: auto`). */
const MIN_AUTO_BINS = 5;
const MAX_AUTO_BINS = 50;
/** An explicit `bins` or `binStep` is still bounded, so one typo cannot hang a render. */
const MAX_BINS = 500;

/** Per-bin data `layout` needs that a {@link BarMark} does not carry. */
interface HistogramEntry {
  series: SeriesDescriptor;
  readout: ReadoutRow[];
  /** The bin's exclusive upper bound, in data space. */
  binEnd: number;
  /** `true` when this bin abuts the one below it (SPEC 11.4 gap). */
  gapNear: boolean;
  /** `true` when it abuts the one above. */
  gapFar: boolean;
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface HistogramPlan {
  corner: number;
  entries: HistogramEntry[];
}

const DEFAULT_PLAN: HistogramPlan = { corner: 4, entries: [] };

type HistogramEncodeResult = PlannedEncodeResult<BarMark, HistogramPlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The measure whose distribution the bins count. There is no y: the height is the count.',
  },
  {
    name: 'color',
    required: false,
    accepts: ['string', 'category'],
    constant: true,
    doc: 'Fixed color for the bars.',
  },
];

/** The resolved bin grid: `count` bins of `step`, tiling `[lo, hi]`. */
interface BinGrid {
  lo: number;
  hi: number;
  step: number;
  count: number;
}

/** The histogram attributes, resolved (SPEC 8.7). */
interface HistogramOptions {
  bins: number | undefined;
  binStep: number | undefined;
  domain?: [number, number];
  normalize: NormalizeMode;
  cumulative: boolean;
  corner: number;
}

/**
 * Read the histogram attributes (SPEC 8.7), reporting `MDV1502` for any enum
 * spelling that is not recognised and `MDV1501` for a `domain` that is not a pair.
 */
function readAttrs(input: EncodeInput): HistogramOptions {
  const { attrs, block } = input;
  const domain = extentAttr(attrs, 'domain');
  if (domain === undefined && listAttr(attrs, 'domain').length > 0) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1501',
        block,
        'encode',
        '`domain` is not an ascending `[min, max]` pair; using the data extent',
      ),
    );
  }
  const binStep = autoNumberAttr(attrs, 'binStep');
  return {
    bins: autoNumberAttr(attrs, 'bins', 1, MAX_BINS),
    binStep: binStep !== undefined && binStep > 0 ? binStep : undefined,
    ...(domain === undefined ? {} : { domain }),
    normalize: enumAttr(attrs, 'normalize', NORMALIZE_MODES, 'count', (given: string) => {
      input.diagnostic(unknownEnum(block, 'normalize', given, NORMALIZE_MODES, 'count'));
    }),
    cumulative: boolAttr(attrs, 'cumulative', false),
    corner: numberAttr(attrs, 'corner', input.theme.marks.bar.cornerRadius, 0, 64),
  };
}

/**
 * Freedman–Diaconis, clamped to 5–50 bins (SPEC 8.7).
 *
 * `2 · IQR · n^(-1/3)` is the bin width the rule prescribes. A sample with no
 * spread in its middle half gives a width of zero, so the square-root rule
 * stands in — the clamp then makes both outcomes readable rather than correct
 * to three decimal places, which is the point of a default.
 */
function autoBinCount(values: readonly number[], span: number): number {
  const sorted = [...values].sort(compareNumbers);
  const iqr = quantile(sorted, 0.75) - quantile(sorted, 0.25);
  const width = 2 * iqr * Math.pow(values.length, -1 / 3);
  const raw = width > 0 ? Math.ceil(span / width) : Math.ceil(Math.sqrt(values.length));
  if (!Number.isFinite(raw)) return MIN_AUTO_BINS;
  return clamp(raw, MIN_AUTO_BINS, MAX_AUTO_BINS);
}

/** Resolve the bin grid: `binStep` wins over `bins`, which wins over the rule. */
function planBins(
  values: readonly number[],
  lo: number,
  hi: number,
  options: HistogramOptions,
): BinGrid {
  const span = hi - lo;
  if (options.binStep !== undefined) {
    const step = options.binStep;
    // The last bin may overhang the extent; the domain grows to hold it, because
    // a half-width final bin would understate its own count.
    const needed = Math.ceil(span / step - 1e-9);
    const count = clamp(Number.isFinite(needed) ? Math.max(1, needed) : 1, 1, MAX_BINS);
    return { lo, hi: lo + step * count, step, count };
  }
  const requested = options.bins ?? autoBinCount(values, span);
  const count = clamp(Math.round(requested), 1, MAX_BINS);
  return { lo, hi, step: span / count, count };
}

/** Express one bin's count on the chosen value axis (SPEC 8.7 `normalize`). */
function normalized(count: number, total: number, step: number, mode: NormalizeMode): number {
  if (mode === 'count') return count;
  if (total <= 0) return 0;
  if (mode === 'frequency') return count / total;
  return step > 0 ? count / (total * step) : 0;
}

/** What the value axis is measuring, for its title and its readout row. */
function valueLabelFor(mode: NormalizeMode, cumulative: boolean): string {
  const base = mode === 'count' ? 'Count' : mode === 'frequency' ? 'Frequency' : 'Density';
  return cumulative ? `Cumulative ${base.toLowerCase()}` : base;
}

/** Frequencies read as percentages; counts and densities read as plain numbers. */
function valueFormatFor(mode: NormalizeMode): string | undefined {
  return mode === 'frequency' ? '.1%' : undefined;
}

/** The one series a histogram has, taken straight from the palette allocator. */
function singleSeries(input: EncodeInput, bound: ReturnType<typeof bindField>): SeriesDescriptor {
  const { palette } = input;
  const patternDef = palette.patternDef('');
  return {
    id: '',
    label: bound === undefined ? 'Count' : humaniseColumn(bound.column),
    slot: palette.slot(''),
    color: palette.color(''),
    source: bound?.column.name ?? '',
    ...(patternDef === undefined ? {} : { patternDef }),
  };
}

/** `histogram` (SPEC 8.7). */
export const histogramChart: ChartType<BarMark> = {
  name: 'histogram',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    bins: 'auto',
    normalize: 'count',
    cumulative: false,
    corner: 4,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/histogram.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const xChannel = firstChannel(block.encoding, 'x');

    if (xChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'x', 'the measure whose distribution the bins count'));
    } else if (findColumn(table, xChannel.field) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`x\` names \`${xChannel.field}\`, which is not a column`,
        ),
      );
    }

    const bound = bindField(table, xChannel);
    if (
      bound !== undefined &&
      !isQuantitative(bound.column.type) &&
      bound.column.type !== 'unknown'
    ) {
      diagnostics.push(
        incompatibleField(block, 'x', bound.column.name, bound.column.type, [
          'number',
          'integer',
          'duration',
        ]),
      );
    }

    if (block.attrs.bins !== undefined && block.attrs.binStep !== undefined) {
      diagnostics.push(
        blockDiagnostic(
          'MDV1501',
          block,
          'encode',
          '`bins` and `binStep` both set the bin grid; `binStep` wins',
          'Give one of them: `binStep` fixes the width, `bins` fixes the count.',
        ),
      );
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<BarMark> {
    const { table, encoding, attrs } = input;
    const options = readAttrs(input);
    const xChannel = firstChannel(encoding, 'x');
    const xBound = bindField(table, xChannel);
    const descriptor = singleSeries(input, xBound);
    const series: readonly SeriesDescriptor[] = [descriptor];

    if (xBound === undefined) return emptyResult(input, series);

    // ── Observations, in row order ────────────────────────────────────────────
    const values: number[] = [];
    const owners: number[] = [];
    for (let row = 0; row < table.rows.length; row += 1) {
      const numeric = cellNumber(cell(table, row, xBound.index));
      if (numeric === null || !isFiniteNumber(numeric)) continue;
      values.push(numeric);
      owners.push(row);
    }
    if (values.length === 0) return emptyResult(input, series);

    // ── The bin grid ──────────────────────────────────────────────────────────
    const dataExtent = extentOf(values) ?? [0, 1];
    let lo = options.domain?.[0] ?? dataExtent[0];
    let hi = options.domain?.[1] ?? dataExtent[1];
    if (!(hi > lo)) {
      // Every observation is the same number. One unit-wide bin around it says
      // that honestly; a zero-wide domain would divide by zero.
      hi = lo + 0.5;
      lo -= 0.5;
    }
    const grid = planBins(values, lo, hi, options);

    // ── Counting ──────────────────────────────────────────────────────────────
    const counts = new Array<number>(grid.count).fill(0);
    const datums = new Array<number>(grid.count).fill(0);
    const seen = new Array<boolean>(grid.count).fill(false);
    let total = 0;
    for (let i = 0; i < values.length; i += 1) {
      const value = values[i];
      if (value === undefined || value < grid.lo || value > grid.hi) continue;
      const raw = Math.floor((value - grid.lo) / grid.step);
      const index = clamp(Number.isFinite(raw) ? raw : 0, 0, grid.count - 1);
      counts[index] = (counts[index] ?? 0) + 1;
      if (seen[index] !== true) {
        seen[index] = true;
        datums[index] = owners[i] ?? 0;
      }
      total += 1;
    }

    const heights: number[] = [];
    let running = 0;
    for (const count of counts) {
      const value = normalized(count, total, grid.step, options.normalize);
      running += value;
      heights.push(options.cumulative ? running : value);
    }

    // ── Marks, one per bin — empty bins included, so the grid is complete ─────
    const valueFormat = valueFormatFor(options.normalize);
    const valueLabel = valueLabelFor(options.normalize, options.cumulative);
    const binFormat = channelFormat(xChannel, xBound.column);
    const measureLabel = humaniseColumn(xBound.column);
    const marks: BarMark[] = [];
    const entries: HistogramEntry[] = [];
    for (let index = 0; index < grid.count; index += 1) {
      const binLo = grid.lo + grid.step * index;
      const binHi = index === grid.count - 1 ? grid.hi : binLo + grid.step;
      const height = heights[index] ?? 0;
      marks.push({
        mark: 'bar',
        seriesId: '',
        datum: datums[index] ?? 0,
        x: binLo,
        y0: 0,
        y1: height,
      });
      entries.push({
        series: descriptor,
        readout: [
          readout(
            measureLabel,
            `${formatNumber(binLo, binFormat)}–${formatNumber(binHi, binFormat)}`,
          ),
          readout(valueLabel, formatNumber(height, valueFormat), descriptor, true),
        ],
        binEnd: binHi,
        gapNear: index > 0,
        gapFar: index < grid.count - 1,
      });
    }

    // ── Scales and axes ───────────────────────────────────────────────────────
    const binScale = createContinuousScale('linear', {
      domain: [grid.lo, grid.hi],
      ...(binFormat === undefined ? {} : { format: binFormat }),
    });
    // Counts start at zero by construction, so there is no `MDV3021` to report:
    // a histogram has no channel through which the baseline could be suppressed.
    const valueDomain = resolveDomain({
      data: extentOf(heights) ?? [0, 1],
      zeroByDefault: true,
      include: 0,
    });
    const valueScale = createContinuousScale('linear', {
      domain: valueDomain.domain,
      ...(valueFormat === undefined ? {} : { format: valueFormat }),
    });

    const binAxis = makeAxis({
      channel: 'x',
      position: 'bottom',
      scale: binScale,
      binding: xChannel,
      column: xBound.column,
      spec: axisSpecFor(attrs, 'x', xChannel),
      gridByDefault: false,
      baselineByDefault: true,
    });
    const valueSpec = axisSpecFor(attrs, 'y', undefined);
    const valueAxis = makeAxis({
      channel: 'y',
      position: 'left',
      scale: valueScale,
      binding: undefined,
      column: undefined,
      spec: valueSpec === false ? false : { title: valueLabel, ...valueSpec },
      gridByDefault: true,
      ...(valueFormat === undefined ? {} : { formatOverride: valueFormat }),
      baselineByDefault: false,
    });
    const axes: AxisModel[] = [binAxis, valueAxis].filter(
      (axis): axis is AxisModel => axis !== undefined,
    );

    const result: HistogramEncodeResult = {
      marks,
      series,
      scales: { x: binScale, y: valueScale },
      axes,
      a11yTable: buildA11yTable(
        table,
        [viewColumn(xBound)].filter((c): c is NonNullable<typeof c> => c !== undefined),
        attrs.title ?? attrs.caption ?? 'Chart data',
        presentationOf(attrs),
      ),
      state: { corner: options.corner, entries },
    };
    const legend = buildLegend(attrs, series, 'rect');
    if (legend !== undefined) result.legend = legend;
    return result;
  },

  layout(encoded: EncodeResult<BarMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<BarMark, HistogramPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];

    const binScale = encoded.scales.x;
    const valueScale = encoded.scales.y;
    if (binScale === undefined || valueScale === undefined || isDegenerateFrame(frame)) {
      return { nodes, hits };
    }
    rangeToFrame(frame, binScale, valueScale);

    const gap = ctx.theme.marks.spacer.surfaceGap;

    for (let i = 0; i < encoded.marks.length; i += 1) {
      const mark = encoded.marks[i];
      const entry = plan.entries[i];
      if (mark === undefined || entry === undefined) continue;

      const edgeLo = binScale.scale(mark.x);
      const edgeHi = binScale.scale(entry.binEnd);
      const base = valueScale.scale(mark.y0);
      const tip = valueScale.scale(mark.y1);
      if (!isFiniteNumber(edgeLo) || !isFiniteNumber(edgeHi)) continue;
      if (!isFiniteNumber(base) || !isFiniteNumber(tip)) continue;

      // The bar spans its whole bin. Each shared boundary recedes by half the
      // gap, so two neighbours together open exactly one 2 px channel of surface
      // — the separation SPEC 11.4 requires, and never a stroke.
      const left = Math.min(edgeLo, edgeHi) + (entry.gapNear ? gap / 2 : 0);
      const right = Math.max(edgeLo, edgeHi) - (entry.gapFar ? gap / 2 : 0);
      const thickness = Math.max(1, right - left);
      const length = Math.abs(tip - base);
      // An empty bin is a real part of the distribution but has nothing to draw.
      if (length <= 0) continue;
      const start = Math.min(base, tip);

      const radii = clampRadii(barRadii(plan.corner, true, mark.y1 >= mark.y0), thickness, length);
      const nodeId = ctx.ids.next('bar');
      nodes.push({
        kind: 'rect',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-bar',
        x: px(left),
        y: px(start),
        w: px(thickness),
        h: px(length),
        r: radii,
        fill: seriesFill(entry.series),
      });
      hits.push(
        hitRegion({
          x: left,
          y: start,
          w: thickness,
          h: length,
          anchor: { x: (left + right) / 2, y: tip },
          datumIndex: mark.datum,
          seriesId: mark.seriesId,
          readout: entry.readout,
          markNodeId: nodeId,
        }),
      );
    }

    return { nodes, hits };
  },

  describe(input: DescribeInput<BarMark>): string {
    const { encoded, block } = input;
    if (encoded.marks.length === 0) return 'Histogram with no data.';
    const xChannel = firstChannel(block.encoding, 'x');
    const xColumn = findColumn(input.table, xChannel?.field)?.column;
    const valueScale = encoded.scales.y;
    const binScale = encoded.scales.x;
    const format = (value: number): string =>
      valueScale === undefined ? formatNumber(value) : valueScale.format(value);
    const edge = (value: number): string =>
      binScale === undefined ? formatNumber(value) : binScale.format(value);

    const first = encoded.marks[0]?.x;
    const second = encoded.marks[1]?.x;
    const step =
      isFiniteNumber(first) && isFiniteNumber(second) && second > first ? second - first : 0;
    const labelOf = (start: number): string =>
      step > 0 ? `${edge(start)}–${edge(start + step)}` : edge(start);

    const observations = encoded.marks.reduce((sum, mark) => sum + (mark.y1 - mark.y0), 0);
    const extremes = extremesOf(
      encoded.marks
        .filter((mark) => isFiniteNumber(mark.x))
        .map((mark) => ({ label: labelOf(mark.x as number), value: mark.y1 - mark.y0 })),
      format,
    );

    const subject = subjectPhrase(
      xColumn === undefined ? undefined : humaniseColumn(xColumn),
      undefined,
    );

    return composeDescription({
      chartKind: 'Histogram',
      ...(subject === undefined ? {} : { subject }),
      scope: countPhrase(encoded.marks.length, 'bin'),
      ...(extremes === undefined || observations <= 0
        ? {}
        : {
            range: `Bin counts range from ${extremes.low.formatted} in ${extremes.low.label} to ${extremes.high.formatted} in ${extremes.high.label}`,
            extreme: `Most common: ${extremes.high.label}`,
          }),
    });
  },
};

/** A well-formed empty result, for a block whose measure resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
): HistogramEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createContinuousScale('linear', { domain: [0, 1] }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: buildA11yTable(
      input.table,
      [],
      input.attrs.title ?? 'Chart data',
      presentationOf(input.attrs),
    ),
    state: { ...DEFAULT_PLAN, entries: [] },
  };
}

export default histogramChart;

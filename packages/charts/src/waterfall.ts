/**
 * `waterfall` — a running total, one step at a time (SPEC 8.12).
 *
 * The chart is a walk. Each row contributes a signed change, and each bar is
 * drawn *floating* between the running total before the step and the running
 * total after it. The bars therefore do not share a baseline, which is the
 * whole point: the height of a bar is the size of a change and its position is
 * where the total stood when that change happened.
 *
 * Two things follow from that, and both are load-bearing here.
 *
 * 1. **Order is data.** A waterfall read out of order is a different chart with
 *    the same bars, so rows are walked in document order and never sorted. That
 *    also means two steps may legitimately carry the same label — "Adjustment"
 *    twice is a normal ledger — so the band domain is the *step index* and the
 *    axis label comes back through {@link BandScaleOptions.labelOf}. Keying the
 *    band on the label itself would have collapsed the repeats into one slot.
 *
 * 2. **A subtotal is arithmetic, not an observation.** A row flagged by the
 *    `total:` field is drawn from the baseline to the running total *as the
 *    steps above it left it*, and its own value cell is not read — it is
 *    usually a restatement of the sum, and where it is not, honouring it would
 *    put a number on the chart that the bars around it do not add up to.
 *
 * Direction uses the status palette (SPEC 11.3.1), never categorical slots. It
 * does not rest on hue: a rise draws upward and a fall draws downward, and the
 * readout and the table view both name the direction in words.
 */

import type {
  A11yTable,
  AxisModel,
  BarMark,
  BlockAttrs,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  Column,
  DescribeInput,
  Diagnostic,
  DirectLabel,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  ScaleInput,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';

import {
  alignFor,
  composeDescription,
  countPhrase,
  extremesOf,
  presentationOf,
  subjectPhrase,
} from './internal/a11y.js';
import type { Annotation } from './internal/annotations.js';
import { annotationNodes, parseAnnotations } from './internal/annotations.js';
import {
  autoNumberAttr,
  boolAttr,
  boolOrStringAttr,
  colorAttr,
  numberAttr,
  stringAttr,
} from './internal/attrs.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './internal/cartesian.js';
import { blockDiagnostic, incompatibleField, missingChannel } from './internal/diagnostics.js';
import { extentOf, resolveDomain, resolveScaleType } from './internal/domain.js';
import { formatNumber, formatValue } from './internal/format.js';
import { barRadii, clampRadii, px } from './internal/geometry.js';
import { hitRegion, readout } from './internal/hit.js';
import { isFiniteNumber } from './internal/num.js';
import { solid, chromeStroke } from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import { createBandScale, createContinuousScale } from './internal/scale.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  findColumn,
  firstChannelOf,
  humaniseColumn,
  isQuantitative,
} from './internal/table.js';

/** What one step does to the running total. */
type StepKind = 'increase' | 'decrease' | 'total';

/** The word for each kind, for readouts and the table view. */
const KIND_LABEL: Readonly<Record<StepKind, string>> = {
  increase: 'Increase',
  decrease: 'Decrease',
  total: 'Total',
};

/** One step of the walk, in the order the document listed it. */
interface WaterfallEntry {
  /** The axis label and the readout's subject. */
  label: string;
  /** The signed change; for a total row, the total it restates. */
  value: number;
  /** Running total the bar leaves from. `0` for a total row. */
  start: number;
  /** Running total the bar arrives at. */
  end: number;
  kind: StepKind;
  color: ColorString;
  /** Row this step was read from, for the readout and hit region. */
  row: number;
  readout: ReadoutRow[];
  /** Direct label text, when the block asked for labels. */
  text: string | undefined;
}

/** Per-mark data a waterfall owns, carried from `encode` to `layout`. */
interface WaterfallPlan {
  entries: WaterfallEntry[];
  /** Whether the hairlines that join step to step are drawn. */
  connector: boolean;
  corner: number;
  barWidth: number | undefined;
  barPadding: number;
  /** What the value axis measures, for the generated description. */
  measure: string | undefined;
  /** What the steps are of, for the generated description. */
  category: string | undefined;
  valueFormat: string | undefined;
  annotations: readonly Annotation[];
}

/** A waterfall draws bars, so its marks are {@link BarMark}s. */
export type WaterfallEncodeResult = PlannedEncodeResult<BarMark, WaterfallPlan>;

const DEFAULT_PLAN: WaterfallPlan = {
  entries: [],
  connector: true,
  corner: 4,
  barWidth: undefined,
  barPadding: 0.2,
  measure: undefined,
  category: undefined,
  valueFormat: undefined,
  annotations: [],
};

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'category',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime'],
    defaultScale: 'band',
    doc: 'The step each bar names. Row order is the walk and is never sorted.',
  },
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The signed change each step contributes to the running total.',
  },
  {
    name: 'color',
    required: false,
    accepts: ['string', 'category'],
    constant: true,
    doc: 'Fixed color for the total bars. Increases and decreases use the status palette.',
  },
];

/** `true` for the cell values an author would write to flag a subtotal row. */
function marksTotal(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (value instanceof Date) return true;
  const text = String(value).trim().toLowerCase();
  if (text === '') return false;
  // A flag column is often written as words rather than booleans, and the words
  // an author reaches for are the ones that say what the row *is*.
  return (
    text === 'true' ||
    text === 'yes' ||
    text === 'y' ||
    text === '1' ||
    text === 'total' ||
    text === 'subtotal'
  );
}

/**
 * The one series a waterfall has.
 *
 * Direction is **not** a series: the three status colors are a fixed vocabulary,
 * not palette slots, and folding them into `series` would have put them in the
 * legend as though a fourth direction could exist. The bars already say which
 * way each step went by pointing that way.
 */
function singleSeries(input: EncodeInput, column: Column | undefined): SeriesDescriptor {
  const { palette } = input;
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

/** A change, with its sign spelled out — direction must survive a greyscale print. */
function signed(value: number, format: (value: number) => string): string {
  const text = format(value);
  return value > 0 && !text.startsWith('+') ? `+${text}` : text;
}

/** The readout for one step: what it is, what it did, where it left the total. */
function stepReadout(
  categoryLabel: string,
  entry: WaterfallEntry,
  series: SeriesDescriptor,
  format: (value: number) => string,
): ReadoutRow[] {
  const rows: ReadoutRow[] = [readout(categoryLabel, entry.label)];
  if (entry.kind === 'total') {
    rows.push(readout(KIND_LABEL.total, format(entry.end), series, true));
    return rows;
  }
  rows.push(readout(KIND_LABEL[entry.kind], signed(entry.value, format), series, true));
  rows.push(readout('Running total', format(entry.end)));
  return rows;
}

/**
 * The table view for a waterfall (SPEC 12.3).
 *
 * The running total and the direction are **derived**, not columns the document
 * holds, and they are here anyway: the walk is what the chart shows, and a table
 * of changes alone would leave a reader to re-add the column the bars already
 * drew. The direction word is also what keeps the status colors from being the
 * only place the sign is stated.
 */
function waterfallA11yTable(
  caption: string,
  categoryLabel: string,
  categoryType: Column['type'],
  measure: string,
  entries: readonly WaterfallEntry[],
  attrs: BlockAttrs,
  format: (value: number) => string,
): A11yTable {
  return {
    caption,
    columns: [
      { name: categoryLabel, type: categoryType, align: alignFor(categoryType) },
      { name: 'Direction', type: 'string', align: alignFor('string') },
      { name: measure, type: 'number', align: 'right' as const },
      { name: 'Running total', type: 'number', align: 'right' as const },
    ],
    rows: entries.map((entry) => [
      entry.label,
      KIND_LABEL[entry.kind],
      entry.kind === 'total' ? '' : signed(entry.value, format),
      format(entry.end),
    ]),
    presentation: presentationOf(attrs),
  };
}

/** Attributes a waterfall reads beyond the common set (SPEC 8.1). */
function readAttrs(input: EncodeInput): {
  connector: boolean;
  corner: number;
  barWidth: number | undefined;
  barPadding: number;
  labels: boolean;
  total: string | undefined;
} {
  const { attrs } = input;
  const labelRequest = boolOrStringAttr(attrs, 'label');
  return {
    connector: boolAttr(attrs, 'connector', true),
    corner: numberAttr(attrs, 'corner', input.theme.marks.bar.cornerRadius, 0, 64),
    barWidth: autoNumberAttr(attrs, 'barWidth', 1, 512),
    barPadding: numberAttr(attrs, 'barPadding', 0.2, 0, 0.9),
    labels:
      labelRequest !== undefined &&
      (labelRequest.kind === 'bool' ? labelRequest.value : labelRequest.value !== 'none'),
    total: stringAttr(attrs, 'total'),
  };
}

/** `waterfall` (SPEC 8.12). */
export const waterfallChart: ChartType<BarMark> = {
  name: 'waterfall',
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    connector: true,
    barPadding: 0.2,
    corner: 4,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/waterfall.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    const categoryChannel = firstChannelOf(block.encoding, ['category', 'x', 'label']);
    if (categoryChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'category', 'the step each bar names'));
    } else if (findColumn(table, categoryChannel.field) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`category\` names \`${categoryChannel.field}\`, which is not a column`,
        ),
      );
    }

    const valueChannel = firstChannelOf(block.encoding, ['value', 'y']);
    if (valueChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'value', 'the signed change each step contributes'));
    } else {
      const bound = bindField(table, valueChannel);
      if (bound === undefined) {
        if (table.fields.length > 0) {
          diagnostics.push(
            blockDiagnostic(
              'MDV3000',
              block,
              'encode',
              `\`value\` names \`${valueChannel.field}\`, which is not a column`,
            ),
          );
        }
      } else if (!isQuantitative(bound.column.type) && bound.column.type !== 'unknown') {
        diagnostics.push(
          incompatibleField(block, 'value', bound.column.name, bound.column.type, [
            'number',
            'integer',
            'duration',
          ]),
        );
      }
    }

    const total = stringAttr(block.attrs, 'total');
    if (total !== undefined && findColumn(table, total) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`total\` names \`${total}\`, which is not a column`,
          'Point `total:` at a column whose truthy cells mark the subtotal rows, or drop the attribute.',
        ),
      );
    }

    return diagnostics;
  },

  encode(input: EncodeInput): WaterfallEncodeResult {
    const { table, encoding, attrs } = input;
    const options = readAttrs(input);

    const categoryChannel = firstChannelOf(encoding, ['category', 'x', 'label']);
    const valueChannel = firstChannelOf(encoding, ['value', 'y']);
    const categoryBound = bindField(table, categoryChannel);
    const valueBound = bindField(table, valueChannel);
    const series = singleSeries(input, valueBound?.column);

    if (categoryBound === undefined || valueBound === undefined) {
      return emptyResult(input, [series], options);
    }

    const categoryFormat = channelFormat(categoryChannel, categoryBound.column);
    const valueFormat = channelFormat(valueChannel, valueBound.column);
    const categoryLabel = humaniseColumn(categoryBound.column);
    const measure = humaniseColumn(valueBound.column);
    const totalColumn = options.total === undefined ? undefined : findColumn(table, options.total);

    const increaseColor = colorAttr(attrs, 'increaseColor', input.theme.status.good);
    const decreaseColor = colorAttr(attrs, 'decreaseColor', input.theme.status.critical);
    // A total is not a direction, so it wears the block's own color rather than
    // a status role: nothing went right or wrong, the walk simply paused to add up.
    const totalColor = colorAttr(attrs, 'totalColor', series.color);

    // ── The walk ──────────────────────────────────────────────────────────────
    const entries: WaterfallEntry[] = [];
    let running = 0;
    let dropped = 0;
    for (let row = 0; row < table.rows.length; row += 1) {
      const label = formatValue(cell(table, row, categoryBound.index), categoryFormat);
      const isTotal = totalColumn !== undefined && marksTotal(cell(table, row, totalColumn.index));
      if (isTotal) {
        entries.push({
          label,
          value: running,
          start: 0,
          end: running,
          kind: 'total',
          color: totalColor,
          row,
          readout: [],
          text: undefined,
        });
        continue;
      }
      const numeric = cellNumber(cell(table, row, valueBound.index));
      if (numeric === null || !isFiniteNumber(numeric)) {
        dropped += 1;
        continue;
      }
      const start = running;
      running += numeric;
      entries.push({
        label,
        value: numeric,
        start,
        end: running,
        // Zero is drawn as a rise. It is not one, but a step that changed
        // nothing has no direction to show, so it takes the one that reads as
        // "nothing went wrong". The readout still says `0` rather than `+0`:
        // `signed` only adds the plus to a number that actually rose.
        kind: numeric < 0 ? 'decrease' : 'increase',
        color: numeric < 0 ? decreaseColor : increaseColor,
        row,
        readout: [],
        text: undefined,
      });
    }

    if (entries.length === 0) return emptyResult(input, [series], options);

    // ── Scales ────────────────────────────────────────────────────────────────
    // The domain is the step index, not the label: see the note at the top of
    // the file about repeated step names.
    const categoryScale = createBandScale({
      domain: entries.map((_, index) => index),
      padding: options.barPadding,
      labelOf: (value: ScaleInput): string =>
        typeof value === 'number' ? (entries[value]?.label ?? String(value)) : String(value),
    });

    const scaleType = resolveScaleType(valueChannel, 'linear');
    const span: number[] = [];
    for (const entry of entries) span.push(entry.start, entry.end);
    const domainResult = resolveDomain({
      data: extentOf(span) ?? [0, 1],
      // Every bar is measured against the running total, and the running total
      // is measured from zero — a waterfall with a cropped value axis draws
      // changes whose sizes no longer compare (SPEC 7.2).
      zeroByDefault: true,
      ...(valueChannel?.scale === undefined ? {} : { spec: valueChannel.scale }),
      include: 0,
    });
    const valueScale = createContinuousScale(scaleType, {
      domain: domainResult.domain,
      ...(valueChannel?.scale?.clamp === undefined ? {} : { clamp: valueChannel.scale.clamp }),
      ...(valueFormat === undefined ? {} : { format: valueFormat }),
    });

    const format = (value: number): string => formatNumber(value, valueFormat);

    // ── Marks ─────────────────────────────────────────────────────────────────
    const marks: BarMark[] = [];
    for (const [index, entry] of entries.entries()) {
      entry.readout = stepReadout(categoryLabel, entry, series, format);
      if (options.labels) {
        entry.text = entry.kind === 'total' ? format(entry.end) : signed(entry.value, format);
      }
      const mark: BarMark = {
        mark: 'bar',
        seriesId: '',
        datum: entry.row,
        x: index,
        y0: entry.start,
        y1: entry.end,
      };
      if (entry.text !== undefined) mark.label = entry.text;
      marks.push(mark);
    }

    // ── Axes ──────────────────────────────────────────────────────────────────
    const categorySpec = axisSpecFor(attrs, 'x', categoryChannel);
    const categoryAxis = makeAxis({
      channel: 'x',
      position: 'bottom',
      scale: categoryScale,
      binding: categoryChannel,
      column: categoryBound.column,
      spec: categorySpec,
      gridByDefault: false,
      baselineByDefault: true,
    });
    const valueSpec = axisSpecFor(attrs, 'y', valueChannel);
    const valueAxis = makeAxis({
      channel: 'y',
      position: 'left',
      scale: valueScale,
      binding: valueChannel,
      column: valueBound.column,
      spec: valueSpec === false ? false : { title: measure, ...valueSpec },
      gridByDefault: true,
      baselineByDefault: false,
    });
    const axes: AxisModel[] = [categoryAxis, valueAxis].filter(
      (axis): axis is AxisModel => axis !== undefined,
    );

    const result: WaterfallEncodeResult = {
      marks,
      series: [series],
      scales: { x: categoryScale, y: valueScale },
      axes,
      // The total column decided which rows are subtotals, so it is a column
      // this chart read, not an attribute it happened to be handed.
      boundColumns:
        totalColumn === undefined
          ? [categoryBound.column, valueBound.column]
          : [categoryBound.column, valueBound.column, totalColumn.column],
      a11yTable: waterfallA11yTable(
        attrs.title ?? attrs.caption ?? 'Chart data',
        categoryLabel,
        categoryBound.column.type,
        measure,
        entries,
        attrs,
        format,
      ),
      state: {
        entries,
        connector: options.connector,
        corner: options.corner,
        barWidth: options.barWidth,
        barPadding: options.barPadding,
        measure,
        category: categoryLabel,
        valueFormat,
        annotations: parseAnnotations(attrs),
      },
    };
    if (dropped > 0) result.droppedRows = dropped;
    return result;
  },

  layout(encoded: EncodeResult<BarMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<BarMark, WaterfallPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    const labels: DirectLabel[] = [];

    const categoryScale = encoded.scales.x;
    const valueScale = encoded.scales.y;
    if (categoryScale === undefined || valueScale === undefined) return { nodes, hits };
    rangeToFrame(frame, categoryScale, valueScale);
    if (isDegenerateFrame(frame) || encoded.marks.length === 0) return { nodes, hits };

    const theme = ctx.theme;
    const band =
      typeof categoryScale.bandwidth === 'function' ? categoryScale.bandwidth() : frame.width;
    // A waterfall bar is a bar: beside a bar chart of the same steps it is drawn
    // the same width (SPEC 11.4). The band padding is the gap; a stroke never is.
    let width = Math.min(band, theme.marks.bar.maxThickness);
    if (plan.barWidth !== undefined) width = Math.min(plan.barWidth, band);
    width = Math.max(1, width);

    // Geometry first, for every step, because the connectors need both ends and
    // they have to be painted underneath the bars they join.
    const placed: { centre: number; top: number; height: number; entry: WaterfallEntry }[] = [];
    for (const [index, mark] of encoded.marks.entries()) {
      const entry = plan.entries[index];
      if (entry === undefined) continue;
      const bandStart = categoryScale.scale(mark.x);
      const y0 = valueScale.scale(mark.y0);
      const y1 = valueScale.scale(mark.y1);
      if (!isFiniteNumber(bandStart) || !isFiniteNumber(y0) || !isFiniteNumber(y1)) continue;
      placed.push({
        centre: bandStart + band / 2,
        top: Math.min(y0, y1),
        // A step of zero changed nothing, but it happened. One pixel keeps it in
        // the picture, on the level it left the total at.
        height: Math.max(1, Math.abs(y1 - y0)),
        entry,
      });
    }

    if (plan.connector) {
      const stroke = chromeStroke(theme, false);
      for (let i = 0; i + 1 < placed.length; i += 1) {
        const from = placed[i];
        const to = placed[i + 1];
        if (from === undefined || to === undefined) continue;
        const level = valueScale.scale(from.entry.end);
        if (!isFiniteNumber(level)) continue;
        const x1 = from.centre + width / 2;
        const x2 = to.centre - width / 2;
        if (x2 <= x1) continue;
        nodes.push({
          kind: 'line',
          id: ctx.ids.next('connector'),
          cls: 'mdv-mark mdv-mark-connector',
          x1: px(x1),
          y1: px(level),
          x2: px(x2),
          y2: px(level),
          stroke,
        });
      }
    }

    for (const { centre, top, height, entry } of placed) {
      const left = centre - width / 2;
      const nodeId = ctx.ids.next('bar');
      // The rounding sits on the end the step travelled to, which for a total is
      // the same rule a bar follows against its baseline (SPEC 11.4).
      const radii = clampRadii(
        barRadii(plan.corner, true, entry.end >= entry.start),
        width,
        height,
      );
      nodes.push({
        kind: 'rect',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-bar',
        x: px(left),
        y: px(top),
        w: px(width),
        h: px(height),
        r: radii,
        fill: solid(entry.color),
      });
      hits.push(
        hitRegion({
          x: left,
          y: top,
          w: width,
          h: height,
          datumIndex: entry.row,
          readout: entry.readout,
          markNodeId: nodeId,
        }),
      );
      if (entry.text !== undefined) {
        // A rise labels above its cap and a fall labels below its floor, so the
        // label sits on the side the eye already travelled to.
        const above = entry.kind !== 'decrease';
        labels.push({
          x: centre,
          y: above ? top : top + height,
          text: entry.text,
          placement: above ? 'above' : 'below',
          priority: height,
          seriesId: '',
          datum: entry.row,
        });
      }
    }

    nodes.push(
      ...annotationNodes(plan.annotations, { x: categoryScale, y: valueScale }, frame, ctx),
    );

    return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
  },

  describe(input: DescribeInput<BarMark>): string {
    const { encoded } = input;
    const plan = planOf<BarMark, WaterfallPlan>(encoded, DEFAULT_PLAN);
    const entries = plan.entries;
    if (entries.length === 0) return 'Waterfall chart with no data.';

    const valueScale = encoded.scales.y;
    const format = (value: number): string =>
      valueScale === undefined ? formatNumber(value, plan.valueFormat) : valueScale.format(value);

    const moves = entries.filter((entry) => entry.kind !== 'total');
    const rises = moves.filter((entry) => entry.value >= 0).length;
    const falls = moves.length - rises;
    const final = entries[entries.length - 1]?.end ?? 0;
    const extremes = extremesOf(
      moves.map((entry) => ({ label: entry.label, value: entry.value })),
      format,
    );

    const subject = subjectPhrase(plan.measure, plan.category);
    return composeDescription({
      chartKind: 'Waterfall chart',
      ...(subject === undefined ? {} : { subject }),
      scope: countPhrase(entries.length, 'step'),
      range: `Ends at ${format(final)} after ${countPhrase(rises, 'increase')} and ${countPhrase(falls, 'decrease')}`,
      ...(extremes === undefined
        ? {}
        : { extreme: `Largest increase: ${extremes.high.label} at ${extremes.high.formatted}` }),
    });
  },
};

/** A well-formed empty result, for a block whose steps resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
  options: ReturnType<typeof readAttrs>,
): WaterfallEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createBandScale({ domain: [], padding: options.barPadding }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: {
      caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
      columns: [],
      rows: [],
      presentation: presentationOf(input.attrs),
    },
    state: {
      ...DEFAULT_PLAN,
      entries: [],
      connector: options.connector,
      corner: options.corner,
      barWidth: options.barWidth,
      barPadding: options.barPadding,
    },
  };
}

export default waterfallChart;

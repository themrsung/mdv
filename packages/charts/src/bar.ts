/**
 * `bar` — magnitude by category (SPEC 8.2).
 *
 * Grouped, stacked, percent-stacked, centred (diverging) and horizontal, from one
 * encoder. The rendering contract is fixed by SPEC 11.4 and is not negotiable per
 * chart: **≤ 24 px thick, 4 px rounded data end, square at the baseline, bars
 * grow from a single baseline, and touching marks are separated by a 2 px gap in
 * the surface color — never by a stroke.**
 */

import type {
  A11yTable,
  AxisModel,
  BarMark,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
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
import type { Annotation } from './internal/annotations.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import type { Orientation, SortMode, StackMode } from './internal/types.js';
import { ORIENTATIONS, SORT_MODES, STACK_MODES } from './internal/types.js';
import { annotationNodes, parseAnnotations } from './internal/annotations.js';
import { autoNumberAttr, boolOrStringAttr, enumAttr, numberAttr, stringAttr } from './internal/attrs.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeDownFrame, rangeToFrame } from './internal/cartesian.js';
import { blockDiagnostic, incompatibleField, missingChannel, unknownEnum } from './internal/diagnostics.js';
import { buildA11yTable, composeDescription, countPhrase, extremesOf, presentationOf, subjectPhrase, viewColumn } from './internal/a11y.js';
import { buildLegend, buildSeries } from './internal/series.js';
import { barRadii, clampRadii, px } from './internal/geometry.js';
import {
  bindField,
  cell,
  cellNumber,
  cellScaleInput,
  channelFormat,
  channelList,
  findColumn,
  firstChannel,
  humaniseColumn,
  isChannelList,
  isQuantitative,
} from './internal/table.js';
import { clamp, compareNumbers, isFiniteNumber } from './internal/num.js';
import { createBandScale, createContinuousScale, discreteKey } from './internal/scale.js';
import { formatNumber, formatValue } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { planOf } from './internal/plan.js';
import { seriesFill } from './internal/paint.js';
import { resolveDomain, resolveScaleType } from './internal/domain.js';
import { stackColumn, stackExtent } from './internal/stack.js';

/** Per-mark data `layout` needs that a {@link BarMark} does not carry. */
interface BarEntry {
  series: SeriesDescriptor;
  readout: ReadoutRow[];
  /** `true` when this segment's near edge abuts another segment (SPEC 11.4 gap). */
  gapNear: boolean;
  /** `true` when its far edge does. */
  gapFar: boolean;
  /** Only the outermost segment of a stack is rounded (SPEC 11.4). */
  rounded: boolean;
  label?: string;
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface BarPlan {
  orientation: Orientation;
  stack: StackMode;
  corner: number;
  barWidth: number | undefined;
  groupPadding: number;
  entries: BarEntry[];
  annotations: Annotation[];
  labelsRequested: boolean;
}

const DEFAULT_PLAN: BarPlan = {
  orientation: 'vertical',
  stack: 'none',
  corner: 4,
  barWidth: undefined,
  groupPadding: 0.1,
  entries: [],
  annotations: [],
  labelsRequested: false,
};

type BarEncodeResult = PlannedEncodeResult<BarMark, BarPlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime', 'time', 'number', 'integer'],
    defaultScale: 'band',
    doc: 'The category, or the time bucket, one band per distinct value.',
  },
  {
    name: 'y',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    list: true,
    defaultScale: 'linear',
    doc: 'The measure. A list of fields makes one series per field (wide form).',
  },
  {
    name: 'series',
    required: false,
    accepts: ['string', 'category', 'boolean', 'number', 'integer', 'date', 'datetime'],
    defaultScale: 'ordinal',
    doc: 'Long-form alternative to a list-valued y: one series per distinct value.',
  },
  { name: 'color', required: false, accepts: ['string', 'category'], constant: true, doc: 'Fixed color or color field.' },
  { name: 'label', required: false, accepts: ['string', 'number', 'integer', 'category'], doc: 'Direct value labels.' },
  { name: 'tooltip', required: false, accepts: ['string', 'number', 'integer', 'category', 'date', 'datetime'], list: true, doc: 'Extra readout fields.' },
];

/**
 * Read the bar-specific attributes (SPEC 8.2), reporting `MDV1502` for any enum
 * spelling that is not recognised.
 */
function readAttrs(input: EncodeInput): {
  orientation: Orientation;
  stack: StackMode;
  corner: number;
  barWidth: number | undefined;
  barPadding: number;
  groupPadding: number;
  baseline: number;
  sort: SortMode;
  sortField: string | undefined;
} {
  const { attrs, block } = input;
  const report = (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
    input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
  };
  const sortRaw = stringAttr(attrs, 'sort');
  const sortIsMode = sortRaw === undefined || SORT_MODES.some((mode) => mode === sortRaw);
  return {
    orientation: enumAttr(attrs, 'orientation', ORIENTATIONS, 'vertical', report('orientation', ORIENTATIONS, 'vertical')),
    stack: enumAttr(attrs, 'stack', STACK_MODES, 'none', report('stack', STACK_MODES, 'none')),
    corner: numberAttr(attrs, 'corner', input.theme.marks.bar.cornerRadius, 0, 64),
    barWidth: autoNumberAttr(attrs, 'barWidth', 1, 512),
    barPadding: numberAttr(attrs, 'barPadding', 0.2, 0, 0.9),
    groupPadding: numberAttr(attrs, 'groupPadding', 0.1, 0, 0.9),
    baseline: numberAttr(attrs, 'baseline', 0),
    sort: sortIsMode ? enumAttr(attrs, 'sort', SORT_MODES, 'none') : 'none',
    sortField: sortIsMode ? undefined : sortRaw,
  };
}

/** `bar` (SPEC 8.2). */
export const barChart: ChartType<BarMark> = {
  name: 'bar',
  level: 1,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: { stack: 'none', orientation: 'vertical', barPadding: 0.2, groupPadding: 0.1, corner: 4, baseline: 0 },
  schemaId: 'https://mdv.dev/schema/1.0/block/bar.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const xChannel = firstChannel(block.encoding, 'x');
    const yChannels = channelList(block.encoding, 'y');

    if (xChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'x', 'the category each bar stands for'));
    } else if (findColumn(table, xChannel.field) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic('MDV3000', block, 'encode', `\`x\` names \`${xChannel.field}\`, which is not a column`),
      );
    }

    if (yChannels.length === 0 || yChannels.every((c) => c.field === undefined)) {
      diagnostics.push(missingChannel(block, 'y', 'the measure the bars encode'));
    }

    if (isChannelList(block.encoding, 'y') && firstChannel(block.encoding, 'series')?.field !== undefined) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3010',
          block,
          'encode',
          'A list-valued `y` and `series` both split the data into series',
          'Use a list `y` for wide data, or `series` with a single `y` for long data — not both.',
        ),
      );
    }

    for (const channel of yChannels) {
      const bound = bindField(table, channel);
      if (bound === undefined) continue;
      if (!isQuantitative(bound.column.type) && bound.column.type !== 'unknown') {
        diagnostics.push(
          incompatibleField(block, 'y', bound.column.name, bound.column.type, ['number', 'integer', 'duration']),
        );
      }
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<BarMark> {
    const { table, encoding, block, attrs } = input;
    const options = readAttrs(input);
    const xChannel = firstChannel(encoding, 'x');
    const xBound = bindField(table, xChannel);
    const resolution = buildSeries({ table, encoding, palette: input.palette, valueChannel: 'y' });
    const series = resolution.plans.map((plan) => plan.descriptor);

    if (xBound === undefined || resolution.plans.length === 0) {
      return emptyResult(input, options, series);
    }
    if (resolution.folded) {
      input.diagnostic(
        blockDiagnostic('MDV3062', block, 'encode', 'More series than palette slots; the surplus folded into "Other"'),
      );
    }

    const seriesChannel = firstChannel(encoding, 'series');
    const seriesColumn = findColumn(table, seriesChannel?.field);
    const valueFormat = channelFormat(channelList(encoding, 'y')[0], table.fields[resolution.plans[0]?.valueColumn ?? -1]);

    // ── Categories, in first-appearance order (never sorted by string) ────────
    const categories: { key: string; value: ScaleInput }[] = [];
    const categoryIndex = new Map<string, number>();
    const rowsByCategory = new Map<string, number[]>();
    for (let row = 0; row < table.rows.length; row += 1) {
      const raw = cellScaleInput(cell(table, row, xBound.index));
      if (raw === null) continue;
      const key = discreteKey(raw);
      let bucket = rowsByCategory.get(key);
      if (bucket === undefined) {
        bucket = [];
        rowsByCategory.set(key, bucket);
        categoryIndex.set(key, categories.length);
        categories.push({ key, value: raw });
      }
      bucket.push(row);
    }

    // ── Per-category, per-series values ───────────────────────────────────────
    const grid: (number | null)[][] = categories.map(() => resolution.plans.map(() => null));
    const rowOf: (number | null)[][] = categories.map(() => resolution.plans.map(() => null));
    for (const [key, rows] of rowsByCategory) {
      const ci = categoryIndex.get(key);
      if (ci === undefined) continue;
      const values = grid[ci];
      const owners = rowOf[ci];
      if (values === undefined || owners === undefined) continue;
      for (const row of rows) {
        for (let si = 0; si < resolution.plans.length; si += 1) {
          const plan = resolution.plans[si];
          if (plan === undefined) continue;
          if (plan.matchKey !== undefined) {
            if (seriesColumn === undefined) continue;
            const identity = cell(table, row, seriesColumn.index);
            const identityKey = identity instanceof Date ? identity.toISOString() : String(identity);
            if (identityKey !== plan.matchKey) continue;
          }
          const numeric = cellNumber(cell(table, row, plan.valueColumn));
          if (numeric === null) continue;
          // Repeated rows for one category+series sum, which is what a bar of a
          // pre-aggregated measure means when the data has duplicates.
          values[si] = (values[si] ?? 0) + numeric;
          owners[si] = owners[si] ?? row;
        }
      }
    }

    // ── Sorting (SPEC 8.2 `sort`) ─────────────────────────────────────────────
    const order = categories.map((_, i) => i);
    if (options.sort !== 'none' || options.sortField !== undefined) {
      const sortColumn = options.sortField === undefined ? undefined : findColumn(table, options.sortField);
      const magnitude = (ci: number): number => {
        if (sortColumn !== undefined) {
          const rows = rowsByCategory.get(categories[ci]?.key ?? '') ?? [];
          let total = 0;
          for (const row of rows) total += cellNumber(cell(table, row, sortColumn.index)) ?? 0;
          return total;
        }
        let total = 0;
        for (const value of grid[ci] ?? []) if (isFiniteNumber(value)) total += value;
        return total;
      };
      const direction = options.sort === 'asc' ? 1 : -1;
      const keyed = order.map((ci) => ({ ci, magnitude: magnitude(ci) }));
      keyed.sort((a, b) => {
        const byValue = compareNumbers(a.magnitude, b.magnitude) * direction;
        // Ties keep first-appearance order, so sorting stays deterministic.
        return byValue !== 0 ? byValue : a.ci - b.ci;
      });
      order.length = 0;
      order.push(...keyed.map((entry) => entry.ci));
    }

    // ── Stack and build marks ─────────────────────────────────────────────────
    const marks: BarMark[] = [];
    const entries: BarEntry[] = [];
    const stacked = options.stack !== 'none';
    const groupCount = stacked ? 1 : resolution.plans.length;
    const columns: ReturnType<typeof stackColumn>[] = [];
    const labelRequest = boolOrStringAttr(attrs, 'label');
    const wantsLabels =
      labelRequest !== undefined && (labelRequest.kind === 'bool' ? labelRequest.value : labelRequest.value !== 'none');
    const labelColumn =
      labelRequest?.kind === 'string' && labelRequest.value !== 'none' && labelRequest.value !== 'true'
        ? findColumn(table, labelRequest.value)
        : undefined;

    for (const ci of order) {
      const category = categories[ci];
      const values = grid[ci];
      const owners = rowOf[ci];
      if (category === undefined || values === undefined || owners === undefined) continue;
      const segments = stackColumn(values, options.stack, options.baseline);
      columns.push(segments);

      const positives = values.filter((v) => isFiniteNumber(v) && v >= 0).length;
      const negatives = values.filter((v) => isFiniteNumber(v) && v < 0).length;
      const bothSigns = positives > 0 && negatives > 0;
      let seenPositive = 0;
      let seenNegative = 0;

      for (let si = 0; si < resolution.plans.length; si += 1) {
        const plan = resolution.plans[si];
        const segment = segments[si];
        const value = values[si];
        if (plan === undefined || segment === undefined) continue;
        if (!segment.defined) continue;

        const isPositive = isFiniteNumber(value) && value >= 0;
        let gapNear = false;
        let gapFar = false;
        let rounded = true;
        if (stacked) {
          if (isPositive) {
            seenPositive += 1;
            gapNear = seenPositive > 1 || bothSigns;
            gapFar = seenPositive < positives;
            rounded = seenPositive === positives;
          } else {
            seenNegative += 1;
            gapNear = seenNegative > 1 || bothSigns;
            gapFar = seenNegative < negatives;
            rounded = seenNegative === negatives;
          }
        }

        const datum = owners[si] ?? 0;
        const mark: BarMark = {
          mark: 'bar',
          seriesId: plan.descriptor.id,
          datum,
          x: category.value,
          y0: segment.y0,
          y1: segment.y1,
        };
        if (!stacked && groupCount > 1) {
          mark.groupIndex = si;
          mark.groupCount = groupCount;
        }

        const displayValue = isFiniteNumber(value) ? value : 0;
        const formatted =
          options.stack === 'percent'
            ? formatNumber(Math.abs(segment.y1 - segment.y0), '.0%')
            : formatNumber(displayValue, valueFormat);
        let labelText: string | undefined;
        if (wantsLabels) {
          labelText =
            labelColumn === undefined
              ? formatted
              : formatValue(cell(table, datum, labelColumn.index), labelColumn.column.format);
          mark.label = labelText;
        }

        const rows: ReadoutRow[] = [
          readout(
            plan.descriptor.id === '' ? plan.descriptor.label : plan.descriptor.label,
            formatted,
            plan.descriptor,
            true,
          ),
        ];
        const extras = extraReadouts(input, datum);
        if (extras.length > 0) {
          mark.extra = extras;
          for (const extra of extras) rows.push(readout(extra.label, extra.value));
        }

        marks.push(mark);
        entries.push({
          series: plan.descriptor,
          readout: rows,
          gapNear,
          gapFar,
          rounded,
          ...(labelText === undefined ? {} : { label: labelText }),
        });
      }
    }

    // ── Scales ────────────────────────────────────────────────────────────────
    const yChannel = channelList(encoding, 'y')[0];
    const scaleType = resolveScaleType(yChannel, 'linear');
    const dataExtent = stackExtent(columns);
    const percent = options.stack === 'percent';
    const domainResult = percent
      ? { domain: pickPercentDomain(dataExtent), zeroSuppressed: false }
      : resolveDomain({
          data: dataExtent,
          zeroByDefault: true,
          ...(yChannel?.scale === undefined ? {} : { spec: yChannel.scale }),
          include: options.stack === 'none' ? options.baseline : 0,
        });

    if (domainResult.zeroSuppressed) {
      input.diagnostic(
        blockDiagnostic(
          'MDV3021',
          block,
          'encode',
          'The bar value axis does not include zero',
          'Truncating a bar chart\'s axis misstates magnitude. Remove `zero: false`, or use a line chart, which may be truncated.',
        ),
      );
    }

    const categoryScale = createBandScale({
      domain: order.map((ci) => categories[ci]?.value ?? ''),
      padding: options.barPadding,
      ...(xBound.column.format === undefined ? {} : { format: xBound.column.format }),
    });
    const valueScale = createContinuousScale(scaleType === 'log' ? 'log' : scaleType, {
      domain: domainResult.domain,
      ...(yChannel?.scale?.clamp === undefined ? {} : { clamp: yChannel.scale.clamp }),
      ...(percent ? { format: '.0%' } : valueFormat === undefined ? {} : { format: valueFormat }),
    });

    const vertical = options.orientation === 'vertical';
    const categoryAxis = makeAxis({
      channel: 'x',
      position: vertical ? 'bottom' : 'left',
      scale: categoryScale,
      binding: xChannel,
      column: xBound.column,
      spec: axisSpecFor(attrs, 'x', xChannel),
      gridByDefault: false,
      baselineByDefault: true,
    });
    const valueAxis = makeAxis({
      channel: 'y',
      position: vertical ? 'left' : 'bottom',
      scale: valueScale,
      binding: yChannel,
      column: table.fields[resolution.plans[0]?.valueColumn ?? -1],
      spec: axisSpecFor(attrs, 'y', yChannel),
      gridByDefault: true,
      ...(percent ? { formatOverride: '.0%' } : {}),
      baselineByDefault: false,
    });
    const axes: AxisModel[] = [categoryAxis, valueAxis].filter((axis): axis is AxisModel => axis !== undefined);

    const result: BarEncodeResult = {
      marks,
      series,
      scales: { x: categoryScale, y: valueScale },
      axes,
      a11yTable: barTableView(input, xBound, resolution.plans, seriesColumn?.index),
      state: {
        orientation: options.orientation,
        stack: options.stack,
        corner: options.corner,
        barWidth: options.barWidth,
        groupPadding: options.groupPadding,
        entries,
        annotations: parseAnnotations(attrs),
        labelsRequested: wantsLabels,
      },
    };
    const legend = buildLegend(attrs, series, 'rect');
    if (legend !== undefined) result.legend = legend;
    return result;
  },

  layout(encoded: EncodeResult<BarMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<BarMark, BarPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    const labels: DirectLabel[] = [];

    const categoryScale = encoded.scales.x;
    const valueScale = encoded.scales.y;
    if (categoryScale === undefined || valueScale === undefined || isDegenerateFrame(frame)) {
      return { nodes, hits };
    }

    const vertical = plan.orientation === 'vertical';
    if (vertical) {
      rangeToFrame(frame, categoryScale, valueScale);
    } else {
      rangeDownFrame(frame, categoryScale);
      rangeToFrame(frame, valueScale, undefined);
    }

    const theme = ctx.theme;
    const gap = theme.marks.spacer.surfaceGap;
    const maxThickness = theme.marks.bar.maxThickness;
    const band = typeof categoryScale.bandwidth === 'function' ? categoryScale.bandwidth() : 0;

    for (let i = 0; i < encoded.marks.length; i += 1) {
      const mark = encoded.marks[i];
      const entry = plan.entries[i];
      if (mark === undefined || entry === undefined) continue;

      const bandStart = categoryScale.scale(mark.x);
      if (!isFiniteNumber(bandStart)) continue;
      const near = valueScale.scale(mark.y0);
      const far = valueScale.scale(mark.y1);
      if (!isFiniteNumber(near) || !isFiniteNumber(far)) continue;

      // Slot within the band: one bar per band when stacked, else one per series.
      const groupCount = Math.max(1, mark.groupCount ?? 1);
      const groupIndex = clamp(mark.groupIndex ?? 0, 0, groupCount - 1);
      const slotWidth = band / groupCount;
      // The 2 px surface gap is what separates adjacent bars — never a stroke.
      const withinGroup = groupCount > 1 ? Math.max(1, slotWidth * (1 - plan.groupPadding) - gap) : slotWidth;
      let thickness = Math.min(withinGroup, maxThickness);
      if (plan.barWidth !== undefined) thickness = Math.min(plan.barWidth, slotWidth);
      thickness = Math.max(1, thickness);
      const slotCentre = bandStart + slotWidth * groupIndex + slotWidth / 2;
      const cross = slotCentre - thickness / 2;

      // Recede from each shared boundary by half the gap, so two neighbours
      // together open exactly one 2 px channel of surface.
      const nearInset = entry.gapNear ? gap / 2 : 0;
      const farInset = entry.gapFar ? gap / 2 : 0;
      const growsPositive = mark.y1 >= mark.y0;
      const signedNear = near + (vertical ? (growsPositive ? -nearInset : nearInset) : growsPositive ? nearInset : -nearInset);
      const signedFar = far + (vertical ? (growsPositive ? farInset : -farInset) : growsPositive ? -farInset : farInset);
      const length = Math.abs(signedFar - signedNear);
      const start = Math.min(signedNear, signedFar);

      const radius = entry.rounded ? plan.corner : 0;
      const radii = clampRadii(
        barRadii(radius, vertical, growsPositive),
        vertical ? thickness : length,
        vertical ? length : thickness,
      );

      const nodeId = ctx.ids.next('bar');
      const rect: SceneNode = vertical
        ? {
            kind: 'rect',
            id: nodeId,
            cls: 'mdv-mark mdv-mark-bar',
            x: px(cross),
            y: px(start),
            w: px(thickness),
            h: px(length),
            r: radii,
            fill: seriesFill(entry.series),
          }
        : {
            kind: 'rect',
            id: nodeId,
            cls: 'mdv-mark mdv-mark-bar',
            x: px(start),
            y: px(cross),
            w: px(length),
            h: px(thickness),
            r: radii,
            fill: seriesFill(entry.series),
          };
      nodes.push(rect);

      const tipX = vertical ? slotCentre : signedFar;
      const tipY = vertical ? signedFar : slotCentre;
      hits.push(
        hitRegion({
          x: vertical ? cross : start,
          y: vertical ? start : cross,
          w: vertical ? thickness : length,
          h: vertical ? length : thickness,
          anchor: { x: tipX, y: tipY },
          datumIndex: mark.datum,
          seriesId: mark.seriesId,
          group: mark.seriesId === '' ? undefined : mark.seriesId,
          readout: entry.readout,
          markNodeId: nodeId,
        }),
      );

      if (entry.label !== undefined) {
        // Bars → value at the tip; columns → value on the cap (SPEC 11.5).
        // A stacked segment labels inside itself, so it needs the fill luminance.
        const inside = plan.stack !== 'none';
        const label: DirectLabel = {
          x: inside ? (vertical ? slotCentre : (signedNear + signedFar) / 2) : tipX,
          y: inside ? (vertical ? (signedNear + signedFar) / 2 : slotCentre) : tipY,
          text: entry.label,
          placement: inside ? 'inside' : vertical ? 'above' : 'end',
          priority: Math.abs(mark.y1 - mark.y0),
          seriesId: mark.seriesId,
          datum: mark.datum,
        };
        if (inside) label.insideFill = entry.series.color;
        labels.push(label);
      }
    }

    nodes.push(
      ...annotationNodes(
        plan.annotations,
        vertical ? { x: categoryScale, y: valueScale } : { x: valueScale, y: categoryScale },
        frame,
        ctx,
      ),
    );

    return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
  },

  describe(input: DescribeInput<BarMark>): string {
    const { encoded, block } = input;
    if (encoded.marks.length === 0) return 'Bar chart with no data.';
    const xChannel = firstChannel(block.encoding, 'x');
    const xColumn = findColumn(input.table, xChannel?.field)?.column;
    const measure = encoded.series[0]?.label;
    const scale = encoded.scales.y;
    const format = (value: number): string => (scale === undefined ? formatNumber(value) : scale.format(value));

    const categories = new Set<string>();
    for (const mark of encoded.marks) categories.add(discreteKey(mark.x));

    const totals = new Map<string, number>();
    for (const mark of encoded.marks) {
      const key = discreteKey(mark.x);
      totals.set(key, (totals.get(key) ?? 0) + (mark.y1 - mark.y0));
    }
    const labelOf = (key: string): string => {
      const found = encoded.marks.find((mark) => discreteKey(mark.x) === key);
      const raw = found?.x;
      return raw === undefined ? key : encoded.scales.x?.format(raw) ?? String(raw);
    };
    const extremes = extremesOf(
      [...totals].map(([key, value]) => ({ label: labelOf(key), value })),
      format,
    );

    const seriesCount = encoded.series.filter((s) => s.id !== '').length;
    const scopeParts = [countPhrase(categories.size, 'category', 'categories')];
    if (seriesCount > 1) scopeParts.push(countPhrase(seriesCount, 'series', 'series'));

    const subject = subjectPhrase(measure, xColumn === undefined ? undefined : humaniseColumn(xColumn));

    return composeDescription({
      chartKind: 'Bar chart',
      ...(subject === undefined ? {} : { subject }),
      scope: scopeParts.join(', '),
      ...(extremes === undefined
        ? {}
        : {
            range: `Values range from ${extremes.low.formatted} in ${extremes.low.label} to ${extremes.high.formatted} in ${extremes.high.label}`,
            extreme: `Highest: ${extremes.high.label}`,
          }),
    });
  },
};

/** `stack: percent` forces the domain to `[0, 1]`, widened when signs are mixed. */
function pickPercentDomain(extent: readonly [number, number] | undefined): readonly [number, number] {
  if (extent === undefined) return [0, 1];
  const lo = Math.min(0, extent[0]);
  const hi = Math.max(1, extent[1]);
  if (lo < 0) return [Math.max(-1, lo), Math.min(1, hi)];
  return [0, 1];
}

/** Extra readout rows from `tooltip: [field, …]` (SPEC 7.5). */
function extraReadouts(input: EncodeInput, row: number): { label: string; value: string }[] {
  const tooltip = input.attrs.tooltip;
  if (!Array.isArray(tooltip)) return [];
  const out: { label: string; value: string }[] = [];
  for (const field of tooltip) {
    if (typeof field !== 'string') continue;
    const found = findColumn(input.table, field);
    if (found === undefined) continue;
    out.push({
      label: humaniseColumn(found.column),
      value: formatValue(cell(input.table, row, found.index), found.column.format),
    });
  }
  return out;
}

/** The table view: category, series identity when long-form, and every measure. */
function barTableView(
  input: EncodeInput,
  xBound: NonNullable<ReturnType<typeof bindField>>,
  plans: readonly { valueColumn: number; descriptor: SeriesDescriptor }[],
  seriesColumnIndex: number | undefined,
): A11yTable {
  const columns = [viewColumn(xBound)].filter((c): c is NonNullable<typeof c> => c !== undefined);
  if (seriesColumnIndex !== undefined) {
    const column = input.table.fields[seriesColumnIndex];
    if (column !== undefined) columns.push({ column, index: seriesColumnIndex });
  }
  const seen = new Set<number>();
  for (const plan of plans) {
    if (seen.has(plan.valueColumn)) continue;
    seen.add(plan.valueColumn);
    const column = input.table.fields[plan.valueColumn];
    if (column !== undefined) columns.push({ column, index: plan.valueColumn });
  }
  return buildA11yTable(
    input.table,
    columns,
    input.attrs.title ?? input.attrs.caption ?? 'Chart data',
    presentationOf(input.attrs),
  );
}

/** A well-formed empty result, for a block whose channels resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  options: ReturnType<typeof readAttrs>,
  series: readonly SeriesDescriptor[],
): BarEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createBandScale({ domain: [], padding: options.barPadding }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: buildA11yTable(input.table, [], input.attrs.title ?? 'Chart data', presentationOf(input.attrs)),
    state: { ...DEFAULT_PLAN, orientation: options.orientation, stack: options.stack, entries: [] },
  };
}

export default barChart;

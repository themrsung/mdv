/**
 * `scatter` / `bubble` — relationship between two measures (SPEC 8.6).
 *
 * Two rules carry the weight here.
 *
 * **Size is area, never radius.** `bubble` maps its size field through a `sqrt`
 * scale, so a datum twice as large covers twice the ink. Mapping value to radius
 * squares the perceived difference and overstates every large point — it is the
 * single most common quantitative lie in a bubble chart.
 *
 * **The series cap is three.** Scatter and bubble put *all* pairs of colors side
 * by side at once, not just adjacent ones, and only the first three categorical
 * slots clear the all-pairs contrast gate (SPEC 11.2 rule 3). Beyond three
 * series this emits `MDV3061` and the reader is pointed at faceting.
 */

import type {
  AxisModel,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  PointMark,
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
import type { PointShape } from './internal/types.js';
import { POINT_SHAPES } from './internal/types.js';
import { annotationNodes, parseAnnotations } from './internal/annotations.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './internal/cartesian.js';
import { blockDiagnostic, incompatibleField, missingChannel, unknownEnum } from './internal/diagnostics.js';
import { buildA11yTable, composeDescription, countPhrase, presentationOf, viewColumn } from './internal/a11y.js';
import { buildLegend, buildSeries } from './internal/series.js';
import { clamp, compareNumbers, isFiniteNumber, safeDiv } from './internal/num.js';
import { createContinuousScale, createPointScale, createTimeScale, toNumeric } from './internal/scale.js';
import { enumAttr, numberAttr } from './internal/attrs.js';
import { extentOf, resolveDomain, resolveScaleType } from './internal/domain.js';
import { formatNumber } from './internal/format.js';
import { lineStroke, solid, surfaceRing } from './internal/paint.js';
import { planOf } from './internal/plan.js';
import { pointHit, readout } from './internal/hit.js';
import { px, shapePath } from './internal/geometry.js';
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
  isTemporal,
} from './internal/table.js';

/** The all-pairs cap of SPEC 11.2 rule 3. */
const ALL_PAIRS_CAP = 3;

/** `trend` (SPEC 8.6). */
type TrendKind = 'none' | 'linear' | 'loess';
const TREND_KINDS: readonly TrendKind[] = ['none', 'linear', 'loess'];

/** One plotted point, with everything layout needs. */
interface PlottedPoint {
  series: SeriesDescriptor;
  x: ScaleInput;
  y: number;
  /** Data-space size for a bubble; `undefined` for a fixed-size scatter. */
  size: number | undefined;
  shape: PointShape;
  datum: number;
  readout: ReadoutRow[];
}

/** A fitted trend line, already in data space. */
interface TrendLine {
  seriesId: string;
  color: string;
  points: { x: number; y: number }[];
}

/** Everything `layout` needs. */
interface ScatterPlan {
  /** Radius in px when no size field is bound. */
  fixedRadius: number;
  /** Maximum radius a bubble may reach. */
  maxRadius: number;
  opacity: number;
  jitter: number;
  /** Deterministic jitter seed, derived from the block id (SPEC 24.3). */
  seed: number;
  points: PlottedPoint[];
  trends: TrendLine[];
  annotations: Annotation[];
}

const DEFAULT_PLAN: ScatterPlan = {
  fixedRadius: 4,
  maxRadius: 24,
  opacity: 0.85,
  jitter: 0,
  seed: 1,
  points: [],
  trends: [],
  annotations: [],
};

type ScatterEncodeResult = PlannedEncodeResult<PointMark, ScatterPlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['number', 'integer', 'date', 'datetime', 'time', 'duration', 'string', 'category'],
    defaultScale: 'linear',
    doc: 'The first measure, or a temporal domain.',
  },
  { name: 'y', required: true, accepts: ['number', 'integer', 'duration'], defaultScale: 'linear', doc: 'The second measure.' },
  {
    name: 'series',
    required: false,
    accepts: ['string', 'category', 'boolean', 'number', 'integer'],
    defaultScale: 'ordinal',
    doc: 'Identity → color. Capped at three for the all-pairs contrast gate.',
  },
  {
    name: 'size',
    required: false,
    accepts: ['number', 'integer'],
    constant: true,
    defaultScale: 'sqrt',
    doc: 'Bubble magnitude. Area-proportional, never radius-proportional.',
  },
  { name: 'shape', required: false, accepts: ['string', 'category'], constant: true, defaultScale: 'ordinal', doc: 'Point shape; a secondary encoding for CVD.' },
  { name: 'label', required: false, accepts: ['string', 'number', 'integer', 'category'], doc: 'Direct labels.' },
  { name: 'tooltip', required: false, accepts: ['string', 'number', 'integer', 'category', 'date', 'datetime'], list: true, doc: 'Extra readout fields.' },
];

/** Build `scatter` or `bubble`. */
function createScatterType(name: 'scatter' | 'bubble'): ChartType<PointMark> {
  return {
    name,
    level: 1,
    // Voronoi nearest-point hit testing: the pointer only has to be closest.
    family: 'nearest',
    channels: CHANNELS,
    defaultEncoding: {},
    defaults: { size: 8, shape: 'circle', opacity: 0.85, trend: 'none', jitter: 0 },
    schemaId: `https://mdv.dev/schema/1.0/block/${name}.json`,
    minWidth: 240,

    validate(block: ResolvedBlock, table: Table): Diagnostic[] {
      const diagnostics: Diagnostic[] = [];
      for (const channel of ['x', 'y'] as const) {
        const binding = firstChannel(block.encoding, channel);
        if (binding?.field === undefined) {
          diagnostics.push(
            missingChannel(block, channel, channel === 'x' ? 'the first measure' : 'the second measure'),
          );
          continue;
        }
        const bound = bindField(table, binding);
        if (bound === undefined) {
          if (table.fields.length > 0) {
            diagnostics.push(
              blockDiagnostic(
                'MDV3000',
                block,
                'encode',
                `\`${channel}\` names \`${binding.field}\`, which is not a column`,
              ),
            );
          }
          continue;
        }
        const acceptable = channel === 'x' ? isQuantitative(bound.column.type) || isTemporal(bound.column.type) : isQuantitative(bound.column.type);
        if (!acceptable && bound.column.type !== 'unknown' && bound.column.type !== 'string' && bound.column.type !== 'category') {
          diagnostics.push(
            incompatibleField(block, channel, bound.column.name, bound.column.type, ['number', 'integer']),
          );
        }
      }

      // `bubble` requires a size *field*: a bubble chart with a constant size is
      // a scatter chart wearing a misleading name (SPEC 8.6).
      if (name === 'bubble') {
        const size = firstChannel(block.encoding, 'size');
        if (size?.field === undefined) {
          diagnostics.push(
            missingChannel(block, 'size', 'the magnitude each bubble\'s *area* encodes; `bubble` requires a field here'),
          );
        }
      }
      return diagnostics;
    },

    encode(input: EncodeInput): EncodeResult<PointMark> {
      return encodeScatter(input, name);
    },

    layout(encoded: EncodeResult<PointMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
      return layoutScatter(encoded, frame, ctx);
    },

    describe(input: DescribeInput<PointMark>): string {
      const { encoded, table, block } = input;
      if (encoded.marks.length === 0) return `${name === 'bubble' ? 'Bubble' : 'Scatter'} chart with no data.`;
      const xColumn = findColumn(table, firstChannel(block.encoding, 'x')?.field)?.column;
      const yColumn = findColumn(table, firstChannel(block.encoding, 'y')?.field)?.column;
      const yScale = encoded.scales.y;
      const values = encoded.marks.map((mark) => mark.y);
      const extent = extentOf(values);
      const format = (value: number): string => (yScale === undefined ? formatNumber(value) : yScale.format(value));
      const seriesCount = encoded.series.filter((series) => series.id !== '').length;
      const scope = [countPhrase(encoded.marks.length, 'point')];
      if (seriesCount > 1) scope.push(countPhrase(seriesCount, 'series', 'series'));

      return composeDescription({
        chartKind: `${name === 'bubble' ? 'Bubble' : 'Scatter'} chart`,
        ...(xColumn === undefined || yColumn === undefined
          ? {}
          : { subject: `${humaniseColumn(yColumn)} against ${humaniseColumn(xColumn).toLowerCase()}` }),
        scope: scope.join(', '),
        ...(extent === undefined ? {} : { range: `Values range from ${format(extent[0])} to ${format(extent[1])}` }),
      });
    },
  };
}

/** Shared encoder. */
function encodeScatter(input: EncodeInput, name: 'scatter' | 'bubble'): EncodeResult<PointMark> {
  const { table, encoding, attrs, block } = input;
  const xChannel = firstChannel(encoding, 'x');
  const yChannel = firstChannel(encoding, 'y');
  const sizeChannel = firstChannel(encoding, 'size');
  const shapeChannel = firstChannel(encoding, 'shape');
  const xBound = bindField(table, xChannel);
  const yBound = bindField(table, yChannel);
  const sizeBound = bindField(table, sizeChannel);
  const shapeBound = bindField(table, shapeChannel);

  const report = (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
    input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
  };
  const opacity = numberAttr(attrs, 'opacity', 0.85, 0, 1);
  const jitter = numberAttr(attrs, 'jitter', 0, 0, 100);
  const trend = enumAttr(attrs, 'trend', TREND_KINDS, 'none', report('trend', TREND_KINDS, 'none'));
  const fixedDiameter = numberAttr(attrs, 'size', input.theme.marks.marker.minDiameter, 1, 128);
  const constantShape = enumAttr(attrs, 'shape', POINT_SHAPES, 'circle');

  if (xBound === undefined || yBound === undefined) {
    const empty: ScatterEncodeResult = {
      marks: [],
      series: [],
      scales: {},
      axes: [],
      a11yTable: buildA11yTable(table, [], attrs.title ?? 'Chart data', presentationOf(attrs)),
      state: { ...DEFAULT_PLAN, opacity, jitter },
    };
    return empty;
  }

  const resolution = buildSeries({
    table,
    encoding,
    palette: input.palette,
    valueChannel: 'y',
    singleLabel: humaniseColumn(yBound.column),
  });
  const descriptors = resolution.plans.map((plan) => plan.descriptor);
  const namedSeries = descriptors.filter((series) => series.id !== '');
  if (namedSeries.length > ALL_PAIRS_CAP) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3061',
        block,
        'encode',
        `${namedSeries.length} series exceeds the all-pairs cap of ${ALL_PAIRS_CAP}`,
        'A scatter compares every pair of colors at once, and only the first three palette slots clear that gate. Facet with `column:`, or fold the tail into "Other".',
      ),
    );
  }

  const seriesChannel = firstChannel(encoding, 'series');
  const seriesColumn = findColumn(table, seriesChannel?.field);
  const xFormat = channelFormat(xChannel, xBound.column);
  const yFormat = channelFormat(yChannel, yBound.column);
  const sizeFormat = sizeBound === undefined ? undefined : channelFormat(sizeChannel, sizeBound.column);

  const byId = new Map<string, SeriesDescriptor>();
  for (const descriptor of descriptors) byId.set(descriptor.id, descriptor);
  const fallbackSeries = descriptors[0];

  // ── Points ────────────────────────────────────────────────────────────────
  const points: PlottedPoint[] = [];
  const marks: PointMark[] = [];
  const xNumeric: number[] = [];
  const yNumeric: number[] = [];
  const sizeValues: number[] = [];
  const temporalX = isTemporal(xBound.column.type);
  const continuousX = temporalX || isQuantitative(xBound.column.type);
  const xCategories: ScaleInput[] = [];
  const seenCategory = new Set<string>();
  const shapeAssignments = new Map<string, PointShape>();
  let droppedRows = 0;

  for (let row = 0; row < table.rows.length; row += 1) {
    const yValue = cellNumber(cell(table, row, yBound.index));
    const xRaw = cellScaleInput(cell(table, row, xBound.index));
    if (yValue === null || xRaw === null) {
      droppedRows += 1;
      continue;
    }
    const xValue = temporalX && !(xRaw instanceof Date) ? new Date(String(xRaw)) : xRaw;
    if (xValue instanceof Date && !Number.isFinite(xValue.getTime())) {
      droppedRows += 1;
      continue;
    }
    if (!continuousX) {
      const key = String(xValue);
      if (!seenCategory.has(key)) {
        seenCategory.add(key);
        xCategories.push(xValue);
      }
    } else {
      const numeric = toNumeric(xValue);
      if (numeric !== undefined) xNumeric.push(numeric);
    }
    yNumeric.push(yValue);

    // Series identity for this row.
    let descriptor = fallbackSeries;
    if (seriesColumn !== undefined) {
      const identity = cell(table, row, seriesColumn.index);
      const key = identity instanceof Date ? identity.toISOString() : String(identity);
      descriptor = byId.get(key) ?? byId.get('Other') ?? fallbackSeries;
    }
    if (descriptor === undefined) continue;

    const sizeValue = sizeBound === undefined ? undefined : (cellNumber(cell(table, row, sizeBound.index)) ?? undefined);
    if (sizeValue !== undefined) sizeValues.push(sizeValue);

    const shape: PointShape =
      shapeBound === undefined
        ? constantShape
        : shapeFor(shapeAssignments, String(cell(table, row, shapeBound.index) ?? ''));

    const rows: ReadoutRow[] = [
      readout(humaniseColumn(xBound.column), formatCell(xValue, xFormat)),
      readout(humaniseColumn(yBound.column), formatNumber(yValue, yFormat), descriptor, true),
    ];
    if (sizeBound !== undefined && sizeValue !== undefined) {
      rows.push(readout(humaniseColumn(sizeBound.column), formatNumber(sizeValue, sizeFormat)));
    }

    const mark: PointMark = { mark: 'point', seriesId: descriptor.id, datum: row, x: xValue, y: yValue, shape };
    if (sizeValue !== undefined) mark.size = sizeValue;
    marks.push(mark);
    points.push({
      series: descriptor,
      x: xValue,
      y: yValue,
      size: sizeValue,
      shape,
      datum: row,
      readout: rows,
    });
  }

  // ── Scales. Neither axis includes zero: a scatter encodes relationship, not
  //    magnitude, so forcing zero usually throws away the whole point cloud.
  const xScale = continuousX
    ? temporalX
      ? createTimeScale({
          domain: temporalDomain(xNumeric),
          ...(xFormat === undefined ? {} : { format: xFormat }),
        })
      : createContinuousScale(resolveScaleType(xChannel, 'linear') === 'log' ? 'log' : resolveScaleType(xChannel, 'linear'), {
          domain: resolveDomain({
            data: extentOf(xNumeric),
            zeroByDefault: false,
            ...(xChannel?.scale === undefined ? {} : { spec: xChannel.scale }),
          }).domain,
          ...(xFormat === undefined ? {} : { format: xFormat }),
        })
    : createPointScale({ domain: xCategories, ...(xFormat === undefined ? {} : { format: xFormat }) });

  const yScaleType = resolveScaleType(yChannel, 'linear');
  const yScale = createContinuousScale(yScaleType === 'log' ? 'log' : yScaleType, {
    domain: resolveDomain({
      data: extentOf(yNumeric),
      zeroByDefault: false,
      ...(yChannel?.scale === undefined ? {} : { spec: yChannel.scale }),
    }).domain,
    ...(yFormat === undefined ? {} : { format: yFormat }),
  });

  // The size scale is `sqrt`, which is what makes **area** proportional to the
  // value: radius ∝ √value ⇒ πr² ∝ value (SPEC 8.6).
  const maxRadius = numberAttr(attrs, 'maxRadius', 24, 2, 96);
  const sizeExtent = extentOf(sizeValues);
  const sizeScale =
    sizeBound === undefined || sizeExtent === undefined
      ? undefined
      : createContinuousScale('sqrt', {
          // The domain starts at zero so a zero-valued bubble has zero area.
          domain: [Math.min(0, sizeExtent[0]), sizeExtent[1]],
          range: [0, maxRadius],
          clamp: true,
          ...(sizeFormat === undefined ? {} : { format: sizeFormat }),
        });

  const axes: AxisModel[] = [];
  const xAxis = makeAxis({
    channel: 'x',
    position: 'bottom',
    scale: xScale,
    binding: xChannel,
    column: xBound.column,
    spec: axisSpecFor(attrs, 'x', xChannel),
    gridByDefault: false,
    baselineByDefault: true,
  });
  if (xAxis !== undefined) axes.push(xAxis);
  const yAxis = makeAxis({
    channel: 'y',
    position: 'left',
    scale: yScale,
    binding: yChannel,
    column: yBound.column,
    spec: axisSpecFor(attrs, 'y', yChannel),
    gridByDefault: true,
    baselineByDefault: false,
  });
  if (yAxis !== undefined) axes.push(yAxis);

  // ── Trend lines ───────────────────────────────────────────────────────────
  const trends: TrendLine[] = [];
  if (trend !== 'none' && continuousX) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3060',
        block,
        'encode',
        `A ${trend} trend line asserts a relationship the data may not support`,
        'A fitted line is a claim about the process that produced the points, not a summary of them.',
      ),
    );
    for (const descriptor of descriptors) {
      const seriesPoints = points
        .filter((point) => point.series.id === descriptor.id)
        .map((point) => ({ x: toNumeric(point.x) ?? Number.NaN, y: point.y }))
        .filter((point) => Number.isFinite(point.x));
      const fitted = trend === 'linear' ? fitLinear(seriesPoints) : fitLoess(seriesPoints);
      if (fitted.length >= 2) trends.push({ seriesId: descriptor.id, color: descriptor.color, points: fitted });
    }
  }

  const viewColumns = [viewColumn(xBound), viewColumn(yBound), viewColumn(sizeBound)].filter(
    (column): column is NonNullable<typeof column> => column !== undefined,
  );
  if (seriesColumn !== undefined) {
    viewColumns.splice(0, 0, { column: seriesColumn.column, index: seriesColumn.index });
  }

  const result: ScatterEncodeResult = {
    marks,
    series: descriptors,
    scales: sizeScale === undefined ? { x: xScale, y: yScale } : { x: xScale, y: yScale, size: sizeScale },
    axes,
    a11yTable: buildA11yTable(
      table,
      viewColumns,
      attrs.title ?? attrs.caption ?? 'Chart data',
      presentationOf(attrs),
    ),
    state: {
      fixedRadius: Math.max(input.theme.marks.marker.minDiameter, fixedDiameter) / 2,
      maxRadius,
      opacity,
      jitter,
      seed: seedFrom(block.id),
      points,
      trends,
      annotations: parseAnnotations(attrs),
    },
  };
  if (droppedRows > 0) result.droppedRows = droppedRows;
  const legend = buildLegend(attrs, descriptors, 'point');
  if (legend !== undefined) result.legend = legend;
  if (name === 'bubble' && sizeScale === undefined) {
    input.diagnostic(
      blockDiagnostic('MDV3000', block, 'encode', '`bubble` has no usable `size` field; every point is drawn at the base size'),
    );
  }
  return result;
}

/** Shared layout. */
function layoutScatter(encoded: EncodeResult<PointMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
  const plan = planOf<PointMark, ScatterPlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];

  const xScale = encoded.scales.x;
  const yScale = encoded.scales.y;
  const sizeScale = encoded.scales.size;
  if (xScale === undefined || yScale === undefined || isDegenerateFrame(frame)) return { nodes, hits };
  rangeToFrame(frame, xScale, yScale);

  const theme = ctx.theme;
  const bandOffset = typeof xScale.bandwidth === 'function' ? xScale.bandwidth() / 2 : 0;
  const minRadius = theme.marks.marker.minDiameter / 2;
  const random = mulberry32(plan.seed);

  // Trend lines sit under the points: a fit is context, the observations are data.
  for (const trend of plan.trends) {
    const projected = trend.points
      .map((point) => {
        const sx = xScale.scale(point.x);
        const sy = yScale.scale(point.y);
        return isFiniteNumber(sx) && isFiniteNumber(sy) ? { x: sx + bandOffset, y: sy } : undefined;
      })
      .filter((point): point is { x: number; y: number } => point !== undefined);
    if (projected.length < 2) continue;
    const first = projected[0];
    if (first === undefined) continue;
    nodes.push({
      kind: 'path',
      cls: 'mdv-mark mdv-mark-trend',
      d: [
        { c: 'M', x: px(first.x), y: px(first.y) },
        ...projected.slice(1).map((point) => ({ c: 'L' as const, x: px(point.x), y: px(point.y) })),
      ],
      stroke: lineStroke(theme, trend.color, theme.marks.line.width),
    });
  }

  for (const point of plan.points) {
    const sx = xScale.scale(point.x);
    const sy = yScale.scale(point.y);
    if (!isFiniteNumber(sx) || !isFiniteNumber(sy)) continue;
    // Jitter is deterministic: the generator is seeded from the block id, never
    // from `Math.random` (SPEC 24.3).
    const jitterX = plan.jitter > 0 ? (random() - 0.5) * 2 * plan.jitter : 0;
    const jitterY = plan.jitter > 0 ? (random() - 0.5) * 2 * plan.jitter : 0;
    const cx = sx + bandOffset + jitterX;
    const cy = sy + jitterY;

    let radius = plan.fixedRadius;
    if (point.size !== undefined && sizeScale !== undefined) {
      const scaled = sizeScale.scale(point.size);
      // √-scaled radius, floored at the legible minimum: a bubble smaller than
      // 8 px across cannot be seen, let alone compared.
      radius = clamp(isFiniteNumber(scaled) ? scaled : minRadius, minRadius, plan.maxRadius);
    }
    if (!(radius > 0)) continue;

    const nodeId = ctx.ids.next('point');
    if (point.shape === 'circle') {
      nodes.push({
        kind: 'circle',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-point',
        cx: px(cx),
        cy: px(cy),
        r: px(radius),
        fill: solid(point.series.color, plan.opacity),
        stroke: surfaceRing(theme),
      });
    } else {
      const d = shapePath(point.shape, cx, cy, radius);
      if (d.length === 0) continue;
      nodes.push({
        kind: 'path',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-point',
        d,
        fill: solid(point.series.color, plan.opacity),
        stroke: surfaceRing(theme),
      });
    }

    hits.push(
      pointHit(cx, cy, radius, {
        datumIndex: point.datum,
        seriesId: point.series.id,
        group: point.series.id === '' ? undefined : point.series.id,
        readout: point.readout,
        markNodeId: nodeId,
      }),
    );
  }

  nodes.push(...annotationNodes(plan.annotations, { x: xScale, y: yScale }, frame, ctx));
  return { nodes, hits };
}

/** Format a scale input for a readout. */
function formatCell(value: ScaleInput, format: string | undefined): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number') return formatNumber(value, format);
  return String(value);
}

/** A temporal domain from epoch values, safe when there are none. */
function temporalDomain(values: readonly number[]): readonly [Date, Date] {
  const extent = extentOf(values);
  if (extent === undefined) return [new Date(0), new Date(86_400_000)];
  if (extent[0] === extent[1]) return [new Date(extent[0] - 43_200_000), new Date(extent[1] + 43_200_000)];
  return [new Date(extent[0]), new Date(extent[1])];
}

/**
 * Map a shape-channel value to a shape, deterministically.
 *
 * An exact shape name wins, so a column that literally holds `"square"` means
 * what it says. Otherwise the value is assigned a shape in first-appearance
 * order and remembered, which is the part that matters: keying off the *series*
 * slot alone makes every point identical whenever `shape` is bound to a column
 * of its own, and a secondary encoding that never varies encodes nothing
 * (SPEC 8.6). Row order is fixed, so the assignment is stable (SPEC 24.3).
 *
 * Binding `shape` and `series` to the same column keeps the two in step for
 * free, because series slots are handed out in first-appearance order too.
 */
function shapeFor(assigned: Map<string, PointShape>, value: string): PointShape {
  if (value !== '') {
    for (const shape of POINT_SHAPES) if (shape === value) return shape;
  }
  const remembered = assigned.get(value);
  if (remembered !== undefined) return remembered;
  const shape = POINT_SHAPES[assigned.size % POINT_SHAPES.length] ?? 'circle';
  assigned.set(value, shape);
  return shape;
}

/** Ordinary least squares, evaluated at the data's own extremes. */
function fitLinear(points: readonly { x: number; y: number }[]): { x: number; y: number }[] {
  const n = points.length;
  if (n < 2) return [];
  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let covariance = 0;
  let variance = 0;
  for (const point of points) {
    const dx = point.x - meanX;
    covariance += dx * (point.y - meanY);
    variance += dx * dx;
  }
  // A vertical point cloud has no least-squares line; drawing one would be an
  // arbitrary choice presented as a finding.
  if (variance === 0) return [];
  const slope = safeDiv(covariance, variance, 0);
  const intercept = meanY - slope * meanX;
  const extent = extentOf(points.map((point) => point.x));
  if (extent === undefined) return [];
  return [
    { x: extent[0], y: slope * extent[0] + intercept },
    { x: extent[1], y: slope * extent[1] + intercept },
  ].filter((point) => Number.isFinite(point.y));
}

/** Locally weighted linear regression with a tricube kernel. */
function fitLoess(points: readonly { x: number; y: number }[], bandwidth = 0.5, steps = 24): { x: number; y: number }[] {
  const n = points.length;
  if (n < 3) return fitLinear(points);
  const sorted = [...points].sort((a, b) => compareNumbers(a.x, b.x));
  const extent = extentOf(sorted.map((point) => point.x));
  if (extent === undefined || extent[0] === extent[1]) return [];
  const span = Math.max(2, Math.floor(clamp(bandwidth, 0.1, 1) * n));
  const out: { x: number; y: number }[] = [];

  for (let step = 0; step <= steps; step += 1) {
    const x = extent[0] + ((extent[1] - extent[0]) * step) / steps;
    const distances = sorted.map((point) => Math.abs(point.x - x)).sort(compareNumbers);
    const maxDistance = distances[Math.min(span - 1, distances.length - 1)] ?? 0;
    let sw = 0;
    let swx = 0;
    let swy = 0;
    let swxx = 0;
    let swxy = 0;
    for (const point of sorted) {
      const distance = Math.abs(point.x - x);
      if (maxDistance > 0 && distance > maxDistance) continue;
      const ratio = maxDistance === 0 ? 0 : distance / maxDistance;
      const weight = (1 - ratio ** 3) ** 3;
      if (!(weight > 0)) continue;
      sw += weight;
      swx += weight * point.x;
      swy += weight * point.y;
      swxx += weight * point.x * point.x;
      swxy += weight * point.x * point.y;
    }
    const denominator = sw * swxx - swx * swx;
    const y =
      denominator === 0 ? safeDiv(swy, sw, Number.NaN) : (swxx * swy - swx * swxy + (sw * swxy - swx * swy) * x) / denominator;
    if (Number.isFinite(y)) out.push({ x, y });
  }
  return out;
}

/** A deterministic seed from the block id (SPEC 24.3: never `Math.random`). */
function seedFrom(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

/** Mulberry32: a small, fast, fully deterministic PRNG. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `scatter` (SPEC 8.6). */
export const scatterChart: ChartType<PointMark> = createScatterType('scatter');

/** `bubble` (SPEC 8.6): scatter with an area-proportional size channel. */
export const bubbleChart: ChartType<PointMark> = createScatterType('bubble');

export default scatterChart;

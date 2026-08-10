/**
 * The shared encoder and layout for `line` (SPEC 8.3) and `area` (SPEC 8.4).
 *
 * Area's encoding is **identical to line's** plus stacking, fill and band
 * attributes, so the two are one algorithm with a mode flag rather than two that
 * drift apart. The rendering contract is SPEC 11.4: a 2 px stroke with round join
 * and cap, markers ≥ 8 px diameter carrying a 2 px surface ring, and an area fill
 * at ~10 % opacity — a wash, never a saturated block.
 *
 * Missing data is the interesting part. `nullPolicy` (SPEC 6.5) decides whether a
 * null breaks the line, is skipped, becomes zero, or drops the row; the default
 * is `gap`, because **a chart whose data has gaps MUST look like it has gaps**.
 */

import type {
  A11yTable,
  AxisModel,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  DirectLabel,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  LineMark,
  ReadoutRow,
  Rect,
  ScaleInput,
  SceneNode,
  SeriesDescriptor,
  Stroke,
} from '@mdv/core';
import type { Annotation } from './annotations.js';
import type { Point } from './geometry.js';
import type { PlannedEncodeResult } from './plan.js';
import type { CurveKind, NullPolicy, PointPolicy, StackMode } from './types.js';
import { CURVE_KINDS, NULL_POLICIES, POINT_POLICIES, STACK_MODES } from './types.js';
import { annotationNodes, parseAnnotations } from './annotations.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './cartesian.js';
import { areaPath, curvePath, px } from './geometry.js';
import { blockDiagnostic, unknownEnum } from './diagnostics.js';
import { boolOrStringAttr, enumAttr, listAttr, numberAttr } from './attrs.js';
import { buildA11yTable, presentationOf, viewColumn } from './a11y.js';
import { buildLegend, buildSeries } from './series.js';
import {
  bindField,
  cell,
  cellNumber,
  cellScaleInput,
  channelFormat,
  channelList,
  findColumn,
  firstChannel,
  isQuantitative,
  isTemporal,
} from './table.js';
import { compareNumbers, isFiniteNumber } from './num.js';
import {
  createBandScale,
  createContinuousScale,
  createPointScale,
  createTimeScale,
  discreteKey,
  toNumeric,
} from './scale.js';
import { formatNumber } from './format.js';
import { pointHit, readout } from './hit.js';
import { lineStroke, seriesFill, solid, surfaceRing } from './paint.js';
import { planOf } from './plan.js';
import { extentOf, resolveDomain, resolveScaleType, unionExtent } from './domain.js';
import { stackColumn } from './stack.js';

/** One plotted vertex, already resolved from the table. */
export interface SeriesPoint {
  x: ScaleInput;
  /** `null` marks a gap: the line breaks and does not interpolate (SPEC 6.5). */
  y: number | null;
  /** Stack baseline; `0` for an unstacked series. */
  y0: number;
  datum: number;
  readout: ReadoutRow[];
}

/** One series' plotted geometry and identity. */
export interface SeriesGeometry {
  descriptor: SeriesDescriptor;
  points: SeriesPoint[];
}

/** Everything `layout` needs, carried across the encode → layout seam. */
export interface LineAreaPlan {
  mode: 'line' | 'area';
  curve: CurveKind;
  strokeWidth: number;
  dash: number[] | undefined;
  points: PointPolicy;
  pointSize: number;
  fillOpacity: number;
  drawLine: boolean;
  stacked: boolean;
  series: SeriesGeometry[];
  annotations: Annotation[];
  labelPolicy: 'none' | 'end' | 'extremes';
  /** `true` when more than one series is drawn, which changes what a label says. */
  multiSeries: boolean;
}

/** The encode result these types return. */
export type LineAreaEncodeResult = PlannedEncodeResult<LineMark, LineAreaPlan>;

const DEFAULT_PLAN: LineAreaPlan = {
  mode: 'line',
  curve: 'linear',
  strokeWidth: 2,
  dash: undefined,
  points: 'none',
  pointSize: 8,
  fillOpacity: 0.1,
  drawLine: true,
  stacked: false,
  series: [],
  annotations: [],
  labelPolicy: 'none',
  multiSeries: false,
};

/** Channels both types accept (SPEC 8.3). */
export const LINE_CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['date', 'datetime', 'time', 'number', 'integer', 'string', 'category'],
    defaultScale: 'time',
    doc: 'The ordered domain, temporal or quantitative.',
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
    doc: 'Long-form alternative to a list-valued y.',
  },
  { name: 'color', required: false, accepts: ['string', 'category'], constant: true, doc: 'Fixed color or color field.' },
  { name: 'label', required: false, accepts: ['string', 'number', 'integer', 'category'], doc: 'Direct labels.' },
  { name: 'tooltip', required: false, accepts: ['string', 'number', 'integer', 'category', 'date', 'datetime'], list: true, doc: 'Extra readout fields.' },
];

/** Read the attributes of SPEC 8.3 / 8.4. */
function readAttrs(input: EncodeInput, mode: 'line' | 'area', seriesCount: number) {
  const { attrs, block, theme } = input;
  const report = (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
    input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
  };
  // Area stacks by default beyond one series: three translucent fills over one
  // another are unreadable (SPEC 8.4).
  const stackDefault: StackMode = mode === 'area' && seriesCount > 1 ? 'normal' : 'none';
  const dashRaw = listAttr(attrs, 'dash')
    .map((entry) => (typeof entry === 'number' ? entry : Number(entry)))
    .filter((entry): entry is number => Number.isFinite(entry) && entry > 0);
  const labelRequest = boolOrStringAttr(attrs, 'label');
  let labelPolicy: 'none' | 'end' | 'extremes' = 'none';
  if (labelRequest?.kind === 'bool') labelPolicy = labelRequest.value ? 'end' : 'none';
  else if (labelRequest?.kind === 'string') {
    labelPolicy = labelRequest.value === 'end' ? 'end' : labelRequest.value === 'extremes' ? 'extremes' : 'none';
  }

  return {
    curve: enumAttr(attrs, 'curve', CURVE_KINDS, 'linear', report('curve', CURVE_KINDS, 'linear')),
    strokeWidth: numberAttr(attrs, 'strokeWidth', theme.marks.line.width, 0.5, 24),
    dash: dashRaw.length > 0 ? dashRaw : undefined,
    points: enumAttr(attrs, 'points', POINT_POLICIES, 'none', report('points', POINT_POLICIES, 'none')),
    // Markers are ≥ 8 px in diameter — an 8 px dot is the floor, not a default.
    pointSize: numberAttr(attrs, 'pointSize', theme.marks.marker.minDiameter, theme.marks.marker.minDiameter, 64),
    nullPolicy: enumAttr(attrs, 'nullPolicy', NULL_POLICIES, 'gap', report('nullPolicy', NULL_POLICIES, 'gap')),
    stack: enumAttr(attrs, 'stack', STACK_MODES, stackDefault, report('stack', STACK_MODES, stackDefault)),
    fillOpacity: numberAttr(attrs, 'fillOpacity', theme.marks.area.fillOpacity, 0, 1),
    drawLine: attrs['line'] === false ? false : true,
    labelPolicy,
  };
}

/**
 * Encode a line or an area.
 *
 * Shared by both types; `mode` selects the two behaviours that genuinely differ —
 * whether the y-domain includes zero, and whether the band is filled.
 */
export function encodeLineArea(input: EncodeInput, mode: 'line' | 'area'): EncodeResult<LineMark> {
  const { table, encoding, attrs, block } = input;
  const xChannel = firstChannel(encoding, 'x');
  const xBound = bindField(table, xChannel);
  const resolution = buildSeries({ table, encoding, palette: input.palette, valueChannel: 'y' });
  const descriptors = resolution.plans.map((plan) => plan.descriptor);
  const options = readAttrs(input, mode, resolution.plans.length);

  if (xBound === undefined || resolution.plans.length === 0) {
    return emptyResult(input, mode, descriptors, options);
  }
  if (resolution.folded) {
    input.diagnostic(
      blockDiagnostic('MDV3062', block, 'encode', 'More series than palette slots; the surplus folded into "Other"'),
    );
  }

  const seriesChannel = firstChannel(encoding, 'series');
  const seriesColumn = findColumn(table, seriesChannel?.field);
  const yChannel = channelList(encoding, 'y')[0];
  const valueColumn = table.fields[resolution.plans[0]?.valueColumn ?? -1];
  const valueFormat = channelFormat(yChannel, valueColumn);

  const xType = xBound.column.type;
  const temporal = isTemporal(xType);
  const continuous = temporal || isQuantitative(xType);

  // ── Collect each series' points ────────────────────────────────────────────
  const raw: { descriptor: SeriesDescriptor; points: SeriesPoint[] }[] = resolution.plans.map((plan) => ({
    descriptor: plan.descriptor,
    points: [],
  }));
  let categoryOrder: ScaleInput[] = [];
  const categorySeen = new Set<string>();

  for (let row = 0; row < table.rows.length; row += 1) {
    const xRaw = cellScaleInput(cell(table, row, xBound.index));
    if (xRaw === null) continue;
    const xValue = temporal && !(xRaw instanceof Date) ? coerceDate(xRaw) : xRaw;
    if (xValue === null) continue;
    const key = discreteKey(xValue);
    if (!categorySeen.has(key)) {
      categorySeen.add(key);
      categoryOrder.push(xValue);
    }
    for (let si = 0; si < resolution.plans.length; si += 1) {
      const plan = resolution.plans[si];
      const bucket = raw[si];
      if (plan === undefined || bucket === undefined) continue;
      if (plan.matchKey !== undefined) {
        if (seriesColumn === undefined) continue;
        const identity = cell(table, row, seriesColumn.index);
        const identityKey = identity instanceof Date ? identity.toISOString() : String(identity);
        if (identityKey !== plan.matchKey) continue;
      }
      const numeric = cellNumber(cell(table, row, plan.valueColumn));
      const rows: ReadoutRow[] = [
        readout(plan.descriptor.label, formatNumber(numeric, valueFormat), plan.descriptor, true),
      ];
      bucket.points.push({ x: xValue, y: numeric, y0: 0, datum: row, readout: rows });
    }
  }

  // ── Apply the null policy (SPEC 6.5) ───────────────────────────────────────
  for (const entry of raw) {
    entry.points = applyNullPolicy(entry.points, options.nullPolicy);
    if (continuous) {
      entry.points.sort((a, b) => {
        const byX = compareNumbers(toNumeric(a.x) ?? 0, toNumeric(b.x) ?? 0);
        return byX !== 0 ? byX : a.datum - b.datum;
      });
    }
  }

  // `drop` removes the *row*, not just the point, so the x it sat at must leave
  // the domain too — otherwise the axis keeps a tick with nothing under it,
  // which reads as "we measured Q2 and got nothing" rather than "no Q2 row".
  // A category survives if any series still holds a point there, so long-form
  // data only loses an x when every series lost it.
  if (options.nullPolicy === 'drop') {
    const surviving = new Set<string>();
    for (const entry of raw) {
      for (const point of entry.points) surviving.add(discreteKey(point.x));
    }
    categoryOrder = categoryOrder.filter((category) => surviving.has(discreteKey(category)));
  }

  // ── Stack (area only) ──────────────────────────────────────────────────────
  const stacked = mode === 'area' && options.stack !== 'none';
  if (stacked) applyStacking(raw, categoryOrder, options.stack);

  // ── Domain ─────────────────────────────────────────────────────────────────
  let yExtent: readonly [number, number] | undefined;
  for (const entry of raw) {
    for (const point of entry.points) {
      if (point.y === null) continue;
      const top = stacked ? point.y0 + point.y : point.y;
      const bottom = stacked ? point.y0 : point.y;
      yExtent = unionExtent(yExtent, [Math.min(top, bottom), Math.max(top, bottom)]);
    }
  }
  const percent = stacked && options.stack === 'percent';
  const domainResult = percent
    ? { domain: [0, 1] as const, zeroSuppressed: false }
    : resolveDomain({
        data: yExtent,
        // An area encodes magnitude by filled height, so it must include zero;
        // a line encodes change and may be truncated (SPEC 7.2).
        zeroByDefault: mode === 'area',
        ...(yChannel?.scale === undefined ? {} : { spec: yChannel.scale }),
      });
  if (domainResult.zeroSuppressed) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3021',
        block,
        'encode',
        'The area value axis does not include zero',
        'A filled area encodes magnitude by height; truncating its axis misstates that magnitude.',
      ),
    );
  }

  // Unstacked overlapping areas are limited to two series (SPEC 8.4).
  if (mode === 'area' && !stacked && descriptors.length > 2) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3040',
        block,
        'encode',
        `${descriptors.length} unstacked areas overlap`,
        'Three translucent fills over one another are unreadable. Use `stack: normal`, a line chart, or small multiples.',
      ),
    );
  }

  // ── Scales ─────────────────────────────────────────────────────────────────
  const xScale = buildXScale(xChannel?.scale?.type, temporal, continuous, categoryOrder, xBound.column.format);
  const yScaleType = resolveScaleType(yChannel, 'linear');
  const yScale = createContinuousScale(yScaleType === 'log' ? 'log' : yScaleType, {
    domain: domainResult.domain,
    ...(yChannel?.scale?.clamp === undefined ? {} : { clamp: yChannel.scale.clamp }),
    ...(percent ? { format: '.0%' } : valueFormat === undefined ? {} : { format: valueFormat }),
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
    column: valueColumn,
    spec: axisSpecFor(attrs, 'y', yChannel),
    gridByDefault: true,
    ...(percent ? { formatOverride: '.0%' } : {}),
    baselineByDefault: false,
  });
  if (yAxis !== undefined) axes.push(yAxis);

  // ── Marks: one polyline per series ─────────────────────────────────────────
  const marks: LineMark[] = raw.map((entry) => {
    const mark: LineMark = {
      mark: 'line',
      seriesId: entry.descriptor.id,
      datum: entry.points[0]?.datum ?? 0,
      points: entry.points.map((point) => ({ x: point.x, y: point.y, datum: point.datum })),
    };
    if (mode === 'area') {
      mark.fill = true;
      mark.baseline = stacked ? 0 : Math.max(domainResult.domain[0], Math.min(0, domainResult.domain[1]));
    }
    return mark;
  });

  const result: LineAreaEncodeResult = {
    marks,
    series: descriptors,
    scales: { x: xScale, y: yScale },
    axes,
    a11yTable: tableView(input, xBound, resolution.plans, seriesColumn?.index),
    state: {
      mode,
      curve: options.curve,
      strokeWidth: options.strokeWidth,
      dash: options.dash,
      points: options.points,
      pointSize: options.pointSize,
      fillOpacity: options.fillOpacity,
      drawLine: options.drawLine,
      stacked,
      series: raw.map((entry) => ({ descriptor: entry.descriptor, points: entry.points })),
      annotations: parseAnnotations(attrs),
      labelPolicy: options.labelPolicy,
      multiSeries: descriptors.filter((s) => s.id !== '').length > 1,
    },
  };
  const legend = buildLegend(attrs, descriptors, mode === 'area' ? 'area' : 'line');
  if (legend !== undefined) result.legend = legend;
  return result;
}

/** YAML hands dates through as strings until inference types the column. */
function coerceDate(value: ScaleInput): ScaleInput | null {
  if (value instanceof Date) return value;
  if (typeof value === 'number') return new Date(value);
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : value;
}

/** Apply `nullPolicy` to one series' points (SPEC 6.5). */
function applyNullPolicy(points: readonly SeriesPoint[], policy: NullPolicy): SeriesPoint[] {
  switch (policy) {
    case 'zero':
      // Nulls are never *silently* coerced to zero; this is the explicit opt-in.
      return points.map((point) => (point.y === null ? { ...point, y: 0 } : point));
    case 'skip':
    case 'drop':
      return points.filter((point) => point.y !== null);
    default:
      return [...points];
  }
}

/**
 * Stack area series at each x position.
 *
 * A null contributes **zero to the offset** but stays null in its own series, so
 * one series' gap does not drag every series above it downward.
 */
function applyStacking(
  series: readonly { descriptor: SeriesDescriptor; points: SeriesPoint[] }[],
  categories: readonly ScaleInput[],
  mode: StackMode,
): void {
  const byKey = series.map((entry) => {
    const map = new Map<string, SeriesPoint>();
    for (const point of entry.points) map.set(discreteKey(point.x), point);
    return map;
  });
  for (const category of categories) {
    const key = discreteKey(category);
    const values = byKey.map((map) => {
      const point = map.get(key);
      return point === undefined || point.y === null ? 0 : point.y;
    });
    const segments = stackColumn(values, mode, 0);
    for (let si = 0; si < byKey.length; si += 1) {
      const point = byKey[si]?.get(key);
      const segment = segments[si];
      if (point === undefined || segment === undefined) continue;
      point.y0 = segment.y0;
      if (point.y !== null) point.y = segment.y1 - segment.y0;
    }
  }
}

/** Pick the x scale: temporal, quantitative, or a point scale over categories. */
function buildXScale(
  requested: string | undefined,
  temporal: boolean,
  continuous: boolean,
  categories: readonly ScaleInput[],
  format: string | undefined,
) {
  if (requested === 'band') {
    return createBandScale({ domain: categories, ...(format === undefined ? {} : { format }) });
  }
  if (requested === 'point' || (!continuous && !temporal)) {
    return createPointScale({ domain: categories, ...(format === undefined ? {} : { format }) });
  }
  const numeric = categories.map((value) => toNumeric(value)).filter((value): value is number => value !== undefined);
  const extent = extentOf(numeric) ?? [0, 1];
  if (temporal) {
    return createTimeScale({
      domain: [new Date(extent[0]), new Date(extent[1])],
      ...(format === undefined ? {} : { format }),
    });
  }
  const domain = resolveDomain({ data: extent, zeroByDefault: false, niceByDefault: false }).domain;
  return createContinuousScale('linear', { domain, ...(format === undefined ? {} : { format }) });
}

/**
 * Turn encoded series into scene nodes.
 *
 * Paint order matters: **fills first, then strokes, then markers**, so a marker
 * is never buried under the next series' wash and a boundary stroke always reads
 * against its own fill.
 */
export function layoutLineArea(
  encoded: EncodeResult<LineMark>,
  frame: Rect,
  ctx: LayoutContext,
): ChartLayoutResult {
  const plan = planOf<LineMark, LineAreaPlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];
  const labels: DirectLabel[] = [];

  const xScale = encoded.scales.x;
  const yScale = encoded.scales.y;
  if (xScale === undefined || yScale === undefined || isDegenerateFrame(frame)) return { nodes, hits };
  rangeToFrame(frame, xScale, yScale);

  const theme = ctx.theme;
  // A band scale would put a point at the band's edge; nudge to its centre.
  const bandOffset = typeof xScale.bandwidth === 'function' ? xScale.bandwidth() / 2 : 0;
  const project = (point: SeriesPoint): { top: Point; base: Point } | undefined => {
    if (point.y === null) return undefined;
    const sx = xScale.scale(point.x);
    const top = yScale.scale(plan.stacked ? point.y0 + point.y : point.y);
    const base = yScale.scale(plan.stacked ? point.y0 : 0);
    if (!isFiniteNumber(sx) || !isFiniteNumber(top)) return undefined;
    return {
      top: { x: sx + bandOffset, y: top },
      base: { x: sx + bandOffset, y: isFiniteNumber(base) ? base : top },
    };
  };

  const fills: SceneNode[] = [];
  const strokes: SceneNode[] = [];
  const markers: SceneNode[] = [];

  for (const geometry of plan.series) {
    const runs = splitRuns(geometry.points);

    for (const run of runs) {
      const projected = run.map(project).filter((p): p is { top: Point; base: Point } => p !== undefined);
      if (projected.length === 0) continue;
      const upper = projected.map((p) => p.top);

      if (plan.mode === 'area') {
        const lower = projected.map((p) => p.base);
        const d = areaPath(upper, lower, plan.curve);
        if (d.length > 0) {
          fills.push({
            kind: 'path',
            cls: 'mdv-mark mdv-mark-area',
            d,
            // A wash, never a saturated block (SPEC 11.4).
            fill: seriesFill(geometry.descriptor, plan.fillOpacity),
          });
        }
      }

      if (plan.mode === 'line' || plan.drawLine) {
        const d = curvePath(upper, plan.curve);
        if (d.length > 0) {
          const stroke: Stroke = lineStroke(theme, geometry.descriptor.color, plan.strokeWidth, plan.dash);
          strokes.push({ kind: 'path', cls: 'mdv-mark mdv-mark-line', d, stroke });
        }
      }
    }

    // ── Markers and hit targets ────────────────────────────────────────────
    const defined = geometry.points.filter((point) => point.y !== null);
    const markerIndices = markerSet(defined, plan.points);
    const radius = Math.max(theme.marks.marker.minDiameter, plan.pointSize) / 2;

    for (let i = 0; i < defined.length; i += 1) {
      const point = defined[i];
      if (point === undefined) continue;
      const projected = project(point);
      if (projected === undefined) continue;

      let nodeId: string | undefined;
      if (markerIndices.has(i)) {
        nodeId = ctx.ids.next('point');
        markers.push({
          kind: 'circle',
          id: nodeId,
          cls: 'mdv-mark mdv-mark-point',
          cx: px(projected.top.x),
          cy: px(projected.top.y),
          r: px(radius),
          fill: solid(geometry.descriptor.color),
          // The 2 px surface ring keeps a marker legible where lines cross.
          stroke: surfaceRing(theme),
        });
      }

      hits.push(
        pointHit(projected.top.x, projected.top.y, radius, {
          datumIndex: point.datum,
          seriesId: geometry.descriptor.id,
          group: geometry.descriptor.id === '' ? undefined : geometry.descriptor.id,
          readout: point.readout,
          ...(nodeId === undefined ? {} : { markNodeId: nodeId }),
        }),
      );
    }

    // ── Direct labels (SPEC 11.5: label the endpoint or the extreme) ────────
    if (plan.labelPolicy !== 'none' && defined.length > 0) {
      const chosen =
        plan.labelPolicy === 'end'
          ? [defined.length - 1]
          : [indexOfExtreme(defined, 'min'), indexOfExtreme(defined, 'max')];
      for (const index of new Set(chosen)) {
        const point = defined[index];
        if (point === undefined) continue;
        const projected = project(point);
        if (projected === undefined) continue;
        const text = plan.multiSeries
          ? geometry.descriptor.label
          : (point.readout[0]?.value ?? formatNumber(point.y));
        labels.push({
          x: projected.top.x,
          y: projected.top.y,
          text,
          placement: plan.labelPolicy === 'end' ? 'end' : 'above',
          priority: plan.labelPolicy === 'end' ? 100 : 50,
          seriesId: geometry.descriptor.id,
          datum: point.datum,
        });
      }
    }
  }

  nodes.push(...fills, ...strokes, ...markers);
  nodes.push(...annotationNodes(plan.annotations, { x: xScale, y: yScale }, frame, ctx));

  return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
}

/** Split a series on nulls: each run is one unbroken stretch of the line. */
function splitRuns(points: readonly SeriesPoint[]): SeriesPoint[][] {
  const runs: SeriesPoint[][] = [];
  let current: SeriesPoint[] = [];
  for (const point of points) {
    if (point.y === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push(point);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Which points carry a marker, per the `points` policy (SPEC 8.3). */
function markerSet(points: readonly SeriesPoint[], policy: PointPolicy): Set<number> {
  const out = new Set<number>();
  if (points.length === 0) return out;
  switch (policy) {
    case 'all':
      for (let i = 0; i < points.length; i += 1) out.add(i);
      break;
    case 'ends':
      out.add(0);
      out.add(points.length - 1);
      break;
    case 'extremes':
      out.add(indexOfExtreme(points, 'min'));
      out.add(indexOfExtreme(points, 'max'));
      break;
    default:
      break;
  }
  return out;
}

/** Index of the lowest or highest defined value; `0` when there is none. */
function indexOfExtreme(points: readonly SeriesPoint[], which: 'min' | 'max'): number {
  let best = 0;
  let bestValue: number | undefined;
  for (let i = 0; i < points.length; i += 1) {
    const value = points[i]?.y;
    if (!isFiniteNumber(value)) continue;
    if (bestValue === undefined || (which === 'min' ? value < bestValue : value > bestValue)) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/** The table view: the x column, the series identity, and every measure. */
function tableView(
  input: EncodeInput,
  xBound: NonNullable<ReturnType<typeof bindField>>,
  plans: readonly { valueColumn: number }[],
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

/** A well-formed result for a block whose channels resolved to nothing. */
function emptyResult(
  input: EncodeInput,
  mode: 'line' | 'area',
  series: readonly SeriesDescriptor[],
  options: ReturnType<typeof readAttrs>,
): LineAreaEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createContinuousScale('linear', { domain: [0, 1] }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: buildA11yTable(input.table, [], input.attrs.title ?? 'Chart data', presentationOf(input.attrs)),
    state: { ...DEFAULT_PLAN, mode, curve: options.curve, points: options.points },
  };
}

/** Shared `describe` body (SPEC 12.2). */
export function describeLineArea(
  kind: string,
  encoded: EncodeResult<LineMark>,
  xTitle: string | undefined,
): string {
  const plan = planOf<LineMark, LineAreaPlan>(encoded, DEFAULT_PLAN);
  const pointCount = plan.series.reduce((total, s) => total + s.points.filter((p) => p.y !== null).length, 0);
  if (pointCount === 0) return `${kind} with no data.`;

  const yScale = encoded.scales.y;
  const format = (value: number): string => (yScale === undefined ? formatNumber(value) : yScale.format(value));
  const xScale = encoded.scales.x;

  let low: { value: number; x: ScaleInput } | undefined;
  let high: { value: number; x: ScaleInput } | undefined;
  for (const geometry of plan.series) {
    for (const point of geometry.points) {
      if (point.y === null) continue;
      const value = plan.stacked ? point.y0 + point.y : point.y;
      if (low === undefined || value < low.value) low = { value, x: point.x };
      if (high === undefined || value > high.value) high = { value, x: point.x };
    }
  }
  const at = (value: ScaleInput): string => (xScale === undefined ? String(value) : xScale.format(value));
  const seriesCount = encoded.series.filter((s) => s.id !== '').length;
  const scope: string[] = [];
  if (seriesCount > 1) scope.push(`${seriesCount} series`);
  scope.push(`${pointCount} point${pointCount === 1 ? '' : 's'}`);

  const sentences = [`${kind}.`];
  if (xTitle !== undefined && xTitle !== '') sentences.push(`Plotted over ${xTitle.toLowerCase()}, ${scope.join(', ')}.`);
  else sentences.push(`${scope.join(', ')}.`);
  if (low !== undefined && high !== undefined) {
    sentences.push(`Values range from ${format(low.value)} at ${at(low.x)} to ${format(high.value)} at ${at(high.x)}.`);
  }
  return sentences.join(' ');
}


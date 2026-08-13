/**
 * `radar` — one subject's profile across several measured axes (SPEC 8.12).
 *
 * A radar answers "what is this thing's *shape*" — strong here, weak there — by
 * giving every measure its own spoke out of a common centre and joining the
 * readings into a closed outline. It is a profile chart, not a magnitude chart:
 * the reader compares one polygon against another, or against the grid, and the
 * comparison they actually make is of *silhouettes*.
 *
 * Four rules follow from that, and all four are load-bearing.
 *
 * 1. **The axis order is data, and it is stable.** SPEC 8.12 says the order "is
 *    meaningful and MUST be stable", because rotating two spokes produces a
 *    different silhouette from the same numbers. The order is therefore
 *    first-appearance order of the `category` column over the prepared table —
 *    the document's own order — and never a sorted, hashed or locale-collated
 *    one. Axis *i* of *n* sits at `i / n` of a turn, clockwise from 12 o'clock.
 * 2. **Past eight axes the chart still draws, and says so.** SPEC 8.12 caps a
 *    readable radar at eight spokes. That is a readability ceiling, not a
 *    resource limit, and this package treats every readability ceiling the same
 *    way its siblings do — `pie` past six slices (`MDV3050`), `area` past two
 *    overlaps (`MDV3040`), `scatter` past three series (`MDV3061`) all render
 *    everything and file a diagnostic. **Nothing is dropped.** Hiding the ninth
 *    axis would close the outline over a hole and misstate the profile, which is
 *    strictly worse than an over-full chart the reader can see is over-full.
 * 3. **The radial scale starts at the centre.** Radius *is* the value, so the
 *    centre is the domain floor and there is nothing to truncate: `zero` is
 *    forced on, and a column carrying negatives lowers the floor rather than
 *    folding below it. `maxValue` pins the top, which is how two radars are made
 *    comparable, but it only ever *raises* the rim: a cap below the data would
 *    have to clamp a reading onto the outer ring and say a series 3× over the
 *    cap was exactly at it, so the reading wins and `MDV1502` reports the
 *    attribute that was ignored.
 * 4. **A gap is a gap.** A null reading breaks the outline (SPEC 6.5) instead of
 *    interpolating across the axis, and a series with a break is not filled — a
 *    filled region asserts a closed boundary this series does not have.
 *
 * The polar grid — rings, spokes and the labels on both — is drawn here rather
 * than by core. Core owns axis furniture for the {@link AxisModel}s a type hands
 * it, and an {@link AxisModel} is cartesian (`position: 'left' | 'right' | 'top'
 * | 'bottom'`); a spider grid has no model to hang off, so `axes` is empty for
 * the same reason `pie`'s is, and the grid is this module's. It is still drawn
 * to core's specification, through {@link gridStroke}.
 */

import type {
  A11yTable,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  Column,
  DescribeInput,
  Diagnostic,
  DirectLabel,
  EncodeInput,
  EncodeResult,
  Encoding,
  LayoutContext,
  LineMark,
  PathCommand,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  Scale,
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
import { autoNumberAttr, enumAttr, numberOf, rawAttr } from './internal/attrs.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import { extentOf, resolveDomain } from './internal/domain.js';
import { formatNumber, formatValue } from './internal/format.js';
import { closePath, curvePath, polar, px } from './internal/geometry.js';
import type { Point } from './internal/geometry.js';
import { pointHit, readout } from './internal/hit.js';
import { clamp, compareNumbers, finite, isFiniteNumber } from './internal/num.js';
import {
  gridStroke,
  labelFont,
  lineStroke,
  seriesFill,
  solid,
  surfaceRing,
} from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import { createContinuousScale, setScaleRange } from './internal/scale.js';
import { buildLegend, buildSeries } from './internal/series.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  channelList,
  findColumn,
  firstChannelOf,
  humaniseColumn,
  identityKey,
  isChannelList,
  isQuantitative,
} from './internal/table.js';

/**
 * The readable ceiling of SPEC 8.12: "≤ 8 axes".
 *
 * Also the number of categorical slots (SPEC 11.2), which is a coincidence worth
 * not relying on: this caps *spokes*, and the palette caps *series*.
 */
const MAX_AXES = 8;

/** How the grid between the spokes is drawn (SPEC 8.12 `gridShape`). */
const GRID_SHAPES = ['polygon', 'circle'] as const;

/** `gridShape`: a web of straight chords, or plain rings. */
type GridShape = (typeof GRID_SHAPES)[number];

/**
 * How many rings to aim for.
 *
 * A hint, exactly like an axis `ticks` count (SPEC 7.3): the value comes off the
 * shared 1–2–5 ladder, so the ring a reader measures against is a round number
 * even when that means four rings instead of five.
 */
const RING_HINT = 4;

/** Where an axis label sits, as a multiple of the tick font's size. */
const LABEL_GAP_RATIO = 0.5;

/** Largest share of the half-width that axis labels may claim. */
const LABEL_WIDTH_SHARE = 0.2;

/** One spoke, in the order the document introduced it. */
interface RadarAxis {
  /** Stable identity — dates key by epoch, never by locale text. */
  key: string;
  /** What the spoke is labelled. */
  label: string;
  /** Radians, 0 at 12 o'clock and growing clockwise, as {@link polar} reads them. */
  angle: number;
  /** The row that introduced this axis, for the label's datum. */
  row: number;
}

/** One reading: a series' value on one axis. */
interface RadarVertex {
  /** Index into {@link RadarPlan.axes}. */
  axis: number;
  /** `null` is a break in the outline, not a zero (SPEC 6.5). */
  value: number | null;
  datum: number;
  readout: ReadoutRow[];
}

/** One series' outline, vertex per axis, in axis order. */
interface RadarSeriesPlan {
  descriptor: SeriesDescriptor;
  vertices: RadarVertex[];
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface RadarPlan {
  axes: RadarAxis[];
  series: RadarSeriesPlan[];
  gridShape: GridShape;
  /** Fill opacity, `0` for `fill: false`. */
  fillOpacity: number;
  /** `true` once the legend is not the only thing naming a series. */
  directLabels: boolean;
  valueFormat: string | undefined;
  /** What the spokes measure, for the generated description. */
  measure: string | undefined;
  /** What the spokes are, for the generated description. */
  category: string | undefined;
}

const DEFAULT_PLAN: RadarPlan = {
  axes: [],
  series: [],
  gridShape: 'polygon',
  fillOpacity: 0,
  directLabels: false,
  valueFormat: undefined,
  measure: undefined,
  category: undefined,
};

/** A radar's outlines are polylines, so its marks are {@link LineMark}s. */
export type RadarEncodeResult = PlannedEncodeResult<LineMark, RadarPlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'category',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime', 'number', 'integer'],
    defaultScale: 'point',
    doc: 'The axis each reading sits on. Document order is the spoke order and is never sorted. Also accepted as `x` or `label`.',
  },
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    list: true,
    defaultScale: 'linear',
    doc: 'The reading on each axis. A list gives one outline per field (wide form). Also accepted as `y`.',
  },
  {
    name: 'series',
    required: false,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime', 'number', 'integer'],
    doc: 'Splits rows into one outline per distinct value (long form).',
  },
  {
    name: 'color',
    required: false,
    accepts: ['string', 'category'],
    constant: true,
    doc: 'Fixed color or color field.',
  },
  {
    name: 'tooltip',
    required: false,
    accepts: ['string', 'number', 'integer', 'category', 'date', 'datetime'],
    list: true,
    doc: 'Extra readout fields.',
  },
];

/**
 * Fold the spelling aliases into the canonical channel names, once.
 *
 * SPEC 8.12 names radar's channels `category` and `value`; Appendix D lists
 * `category` as shared with `pie`, which also accepts `x` and `label` for it and
 * `y` for the measure (SPEC 8.5). Normalising here means the rest of the module —
 * and, importantly, {@link buildSeries}, which reads `encoding.value` directly to
 * find the wide form — sees exactly one spelling, rather than every call site
 * having to remember the alias list.
 */
function canonical(encoding: Encoding): Encoding {
  const category = firstChannelOf(encoding, ['category', 'x', 'label']);
  const out: Encoding = { ...encoding };
  if (encoding.category === undefined && category !== undefined) out.category = category;
  if (encoding.value === undefined && encoding.y !== undefined) out.value = encoding.y;
  return out;
}

/**
 * Read `fill` (SPEC 8.12).
 *
 * A boolean turns the wash on or off; a number is the opacity outright, for the
 * author who wants a heavier or lighter one. The default comes from the theme's
 * area spec — "series hue at ~10 % opacity, a wash, never a saturated block"
 * (SPEC 11.4) — because a radar's fill is that same mark, and a mark
 * specification is fixed across every chart type.
 */
function readFill(input: EncodeInput): number {
  const fallback = input.theme.marks.area.fillOpacity;
  const raw = rawAttr(input.attrs, 'fill');
  if (raw === undefined) return fallback;
  if (raw === true || raw === 'true') return fallback;
  if (raw === false || raw === 'false') return 0;
  const numeric = numberOf(raw);
  if (numeric !== undefined) return clamp(numeric, 0, 1);
  input.diagnostic(
    unknownEnum(
      input.block,
      'fill',
      String(raw),
      ['true', 'false', 'an opacity from 0 to 1'],
      'true',
    ),
  );
  return fallback;
}

/** `radar` (SPEC 8.12). */
export const radarChart: ChartType<LineMark> = {
  name: 'radar',
  level: 2,
  // The vertex is the hit target and the hovered outline lifts; there is no
  // crosshair, because there is no shared x to snap one to (SPEC 7.5).
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: { gridShape: 'polygon', fill: true },
  schemaId: 'https://mdv.dev/schema/1.0/block/radar.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const encoding = canonical(block.encoding);
    const categoryChannel =
      encoding.category === undefined ? undefined : channelList(encoding, 'category')[0];
    const valueChannels = channelList(encoding, 'value');

    if (categoryChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'category', 'the axis each reading sits on'));
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

    if (
      valueChannels.length === 0 ||
      valueChannels.every((channel) => channel.field === undefined)
    ) {
      diagnostics.push(missingChannel(block, 'value', 'the reading on each axis'));
    }

    // Wide form and long form both split the data into series; asking for both
    // leaves no answer to "which field is this outline of" (SPEC 7.1).
    if (
      (isChannelList(block.encoding, 'value') || isChannelList(block.encoding, 'y')) &&
      channelList(encoding, 'series')[0]?.field !== undefined
    ) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3010',
          block,
          'encode',
          'A list-valued `value` and `series` both split the data into outlines',
          'Use a list `value` for wide data, or `series` with a single `value` for long data — not both.',
        ),
      );
    }

    for (const channel of valueChannels) {
      const bound = bindField(table, channel);
      if (bound === undefined) continue;
      if (!isQuantitative(bound.column.type) && bound.column.type !== 'unknown') {
        diagnostics.push(
          incompatibleField(block, 'value', bound.column.name, bound.column.type, [
            'number',
            'integer',
            'duration',
          ]),
        );
      }
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<LineMark> {
    return encodeRadar(input);
  },

  layout(encoded: EncodeResult<LineMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    return layoutRadar(encoded, frame, ctx);
  },

  describe(input: DescribeInput<LineMark>): string {
    const { encoded } = input;
    const plan = planOf<LineMark, RadarPlan>(encoded, DEFAULT_PLAN);
    if (plan.axes.length === 0 || encoded.marks.length === 0) return 'Radar chart with no data.';

    const scale = encoded.scales.value;
    const format = (value: number): string =>
      scale === undefined ? formatNumber(value, plan.valueFormat) : scale.format(value);

    const named = encoded.series.filter((series) => series.id !== '');
    const multi = named.length > 1;
    // A reading is identified by its spoke; with several outlines on the chart it
    // takes the outline's name too, or "highest" would name a place and not a
    // thing.
    const readings = plan.series.flatMap((series) =>
      series.vertices
        .filter((vertex): vertex is RadarVertex & { value: number } => vertex.value !== null)
        .map((vertex) => {
          const axis = plan.axes[vertex.axis]?.label ?? '';
          return {
            label: multi ? `${axis} (${series.descriptor.label})` : axis,
            value: vertex.value,
          };
        }),
    );
    const extremes = extremesOf(readings, format);

    const axisPhrase = countPhrase(plan.axes.length, 'axis', 'axes');
    // "series" is its own plural; without the explicit form `countPhrase` would
    // say "2 seriess", the way `bar` and `scatter` already guard against.
    const scope = multi
      ? `${countPhrase(named.length, 'series', 'series')} across ${axisPhrase}`
      : axisPhrase;
    const subject = subjectPhrase(plan.measure, plan.category);

    return composeDescription({
      chartKind: 'Radar chart',
      ...(subject === undefined ? {} : { subject }),
      scope,
      ...(extremes === undefined
        ? {}
        : {
            range: `Values range from ${extremes.low.formatted} in ${extremes.low.label} to ${extremes.high.formatted} in ${extremes.high.label}`,
            extreme: `Highest: ${extremes.high.label}`,
          }),
    });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// encode
// ─────────────────────────────────────────────────────────────────────────────

function encodeRadar(input: EncodeInput): EncodeResult<LineMark> {
  const { table, attrs, block } = input;
  const encoding = canonical(input.encoding);
  const categoryChannel = channelList(encoding, 'category')[0];
  const categoryBound = bindField(table, categoryChannel);
  const valueChannel = channelList(encoding, 'value')[0];

  const gridShape: GridShape = enumAttr(attrs, 'gridShape', GRID_SHAPES, 'polygon', (given) => {
    input.diagnostic(unknownEnum(block, 'gridShape', given, GRID_SHAPES, 'polygon'));
  });
  const fillOpacity = readFill(input);
  const maxValue = autoNumberAttr(attrs, 'maxValue');

  const resolution = buildSeries({
    table,
    encoding,
    palette: input.palette,
    valueChannel: 'value',
    ...(categoryBound === undefined
      ? {}
      : {
          singleLabel: measureLabel(
            table,
            valueChannel?.field,
            resolvedValueColumn(table, encoding),
          ),
        }),
  });
  const descriptors = resolution.plans.map((plan) => plan.descriptor);

  if (categoryBound === undefined || resolution.plans.length === 0) {
    return emptyResult(input, descriptors, gridShape, fillOpacity);
  }
  if (resolution.folded) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3062',
        block,
        'encode',
        'More outlines than palette slots; the surplus folded into "Other"',
      ),
    );
  }

  const seriesChannel = channelList(encoding, 'series')[0];
  const seriesColumn = findColumn(table, seriesChannel?.field);
  const categoryFormat = channelFormat(categoryChannel, categoryBound.column);
  const valueColumn = table.fields[resolution.plans[0]?.valueColumn ?? -1];
  const valueFormat = channelFormat(valueChannel, valueColumn);
  const categoryTitle = humaniseColumn(categoryBound.column);

  // ── The spokes, in the order the document introduced them ──────────────────
  // First-appearance order is the whole of SPEC 8.12's stability requirement:
  // it is a property of the data, it survives a filter that removes a row, and
  // it never consults a collator.
  const axes: RadarAxis[] = [];
  const axisAt = new Map<string, number>();
  let droppedRows = 0;
  for (let row = 0; row < table.rows.length; row += 1) {
    const raw = cell(table, row, categoryBound.index);
    if (raw === null) {
      droppedRows += 1;
      continue;
    }
    const key = identityKey(raw);
    if (axisAt.has(key)) continue;
    axisAt.set(key, axes.length);
    axes.push({
      key,
      label: formatValue(raw, categoryFormat),
      // Filled in below: the angle is a function of the final axis count.
      angle: 0,
      row,
    });
  }
  if (axes.length === 0) return emptyResult(input, descriptors, gridShape, fillOpacity);

  for (let i = 0; i < axes.length; i += 1) {
    const axis = axes[i];
    if (axis !== undefined) axis.angle = (i / axes.length) * Math.PI * 2;
  }

  if (axes.length > MAX_AXES) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3050',
        block,
        'encode',
        `${axes.length} axes — more than the ${MAX_AXES} a radar can be read at`,
        'Every axis is still drawn and every reading is in the table view; nothing was dropped. Past eight spokes the silhouette stops being comparable, and a grouped bar chart or a small multiple answers the same question better.',
      ),
    );
  }

  // ── The readings ───────────────────────────────────────────────────────────
  const multi = descriptors.filter((descriptor) => descriptor.id !== '').length > 1;
  const plans: RadarSeriesPlan[] = resolution.plans.map((plan) => ({
    descriptor: plan.descriptor,
    vertices: axes.map((_, index) => ({
      axis: index,
      value: null,
      datum: axes[index]?.row ?? 0,
      readout: [] as ReadoutRow[],
    })),
  }));

  for (let row = 0; row < table.rows.length; row += 1) {
    const raw = cell(table, row, categoryBound.index);
    if (raw === null) continue;
    const index = axisAt.get(identityKey(raw));
    if (index === undefined) continue;
    for (let si = 0; si < resolution.plans.length; si += 1) {
      const plan = resolution.plans[si];
      const target = plans[si]?.vertices[index];
      if (plan === undefined || target === undefined) continue;
      if (plan.matchKey !== undefined) {
        if (seriesColumn === undefined) continue;
        if (identityKey(cell(table, row, seriesColumn.index)) !== plan.matchKey) continue;
      }
      const numeric = cellNumber(cell(table, row, plan.valueColumn));
      // A spoke carries one reading. Two rows for the same series and axis are an
      // authoring accident rather than a shape, and the later row wins — the same
      // rule `heatmap` applies to two rows landing on one cell.
      target.value = numeric;
      target.datum = row;
    }
  }

  const readings: number[] = [];
  for (const plan of plans) {
    for (const vertex of plan.vertices) {
      if (vertex.value !== null) readings.push(vertex.value);
      vertex.readout = [
        readout(categoryTitle, axes[vertex.axis]?.label ?? ''),
        readout(
          multi ? plan.descriptor.label : measure(valueColumn),
          formatNumber(vertex.value, valueFormat),
          plan.descriptor,
          true,
        ),
      ];
    }
  }

  // ── The radial scale ───────────────────────────────────────────────────────
  // Radius *is* the value, so the centre is the floor and `zero` is not optional:
  // there is no truncation to argue about. A column carrying negatives lowers the
  // floor below zero rather than folding underneath it, which is what
  // `zeroByDefault` already does through the shared union.
  const dataExtent = extentOf(readings);
  const domainResult = resolveDomain({
    data: dataExtent ?? [0, 1],
    zeroByDefault: true,
    ...(valueChannel?.scale === undefined ? {} : { spec: valueChannel.scale }),
  });
  const [lo, dataTop] = domainResult.domain;
  // `maxValue` pins the outer ring, which is how two radars of different
  // subjects are made comparable — but it raises the rim and never lowers it
  // under the data. On a radar the radius *is* the reading, so there is nowhere
  // to put a value past the rim: clamping it there would draw a series at 3×
  // the cap identically to one exactly at it. The reading wins and the
  // attribute is reported, the way `MDV3021` refuses to let a bar axis misstate
  // a magnitude.
  const crops = maxValue !== undefined && dataExtent !== undefined && maxValue < dataExtent[1];
  if (crops) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        block,
        'encode',
        `\`maxValue: ${maxValue}\` is below the largest reading, ${formatNumber(dataExtent[1], valueFormat)}`,
        'Using the data extent instead. A reading cannot sit outside the outer ring, and pinning it there would understate how far past the cap it is.',
      ),
    );
  }
  const hi = maxValue !== undefined && maxValue > lo && !crops ? maxValue : dataTop;
  const valueScale = createContinuousScale('linear', {
    domain: [lo, hi],
    ...(valueFormat === undefined ? {} : { format: valueFormat }),
  });

  // ── Marks ──────────────────────────────────────────────────────────────────
  const marks: LineMark[] = plans.map((plan) => {
    const complete = plan.vertices.every((vertex) => vertex.value !== null);
    return {
      mark: 'line',
      seriesId: plan.descriptor.id,
      datum: plan.vertices[0]?.datum ?? 0,
      points: plan.vertices.map((vertex) => ({
        x: axes[vertex.axis]?.label ?? '',
        y: vertex.value,
        datum: vertex.datum,
      })),
      // A wash asserts a closed region. A series with a break does not have one,
      // so it is outlined and left unfilled (SPEC 6.5).
      fill: fillOpacity > 0 && complete,
      baseline: lo,
    };
  });

  const result: RadarEncodeResult = {
    marks,
    series: descriptors,
    // The radial scale is not keyed `x` or `y`: those are the two core re-ranges
    // onto the plot rectangle's edges, and a radius runs from the middle outward.
    scales: { value: valueScale },
    // A polar grid has no `AxisModel` — see the note at the top of this file.
    axes: [],
    boundColumns: boundColumnsOf(
      table,
      categoryBound.column,
      resolution.plans,
      seriesColumn?.column,
    ),
    a11yTable: radarA11yTable(
      attrs.title ?? attrs.caption ?? 'Chart data',
      presentationOf(attrs),
      categoryBound.column,
      categoryTitle,
      axes,
      plans,
      multi ? undefined : measure(valueColumn),
      valueFormat,
    ),
    state: {
      axes,
      series: plans,
      gridShape,
      fillOpacity,
      // SPEC 12.5: identity may not rest on colour alone, and up to four series
      // are direct-labelled as well as legended.
      directLabels: multi && descriptors.length <= 4,
      valueFormat,
      measure: measure(valueColumn),
      category: categoryTitle,
    },
  };
  if (droppedRows > 0) result.droppedRows = droppedRows;
  // The mark is an outline, filled or not, so the swatch mirrors it (SPEC 7.4).
  const legend = buildLegend(attrs, descriptors, fillOpacity > 0 ? 'area' : 'line');
  if (legend !== undefined) result.legend = legend;
  return result;
}

/** The column the first series reads, for the measure's name and format. */
function resolvedValueColumn(table: Table, encoding: Encoding): Column | undefined {
  return findColumn(table, channelList(encoding, 'value')[0]?.field)?.column;
}

/** What the spokes measure: the value column's title, else a neutral word. */
function measure(column: Column | undefined): string {
  return column === undefined ? 'Value' : humaniseColumn(column);
}

/** The label a single unnamed outline carries in the legend and the table view. */
function measureLabel(table: Table, field: string | undefined, column: Column | undefined): string {
  return measure(findColumn(table, field)?.column ?? column);
}

/** The columns the encoding bound, in channel order (registry.ts). */
function boundColumnsOf(
  table: Table,
  category: Column,
  plans: readonly { valueColumn: number }[],
  series: Column | undefined,
): Column[] {
  const out: Column[] = [category];
  const seen = new Set<number>();
  for (const plan of plans) {
    if (seen.has(plan.valueColumn)) continue;
    seen.add(plan.valueColumn);
    const column = table.fields[plan.valueColumn];
    if (column !== undefined) out.push(column);
  }
  if (series !== undefined) out.push(series);
  return out;
}

/**
 * The table view (SPEC 12.3), as the matrix the chart actually shows.
 *
 * One row per spoke, one column per outline. The default projection — a column
 * per bound field — would restate long-form data as a three-column list and make
 * the reader do the pivot the chart already did; and since every axis is drawn,
 * including the ones past the eighth, every axis is here too.
 */
function radarA11yTable(
  caption: string,
  presentation: A11yTable['presentation'],
  categoryColumn: Column,
  categoryTitle: string,
  axes: readonly RadarAxis[],
  plans: readonly RadarSeriesPlan[],
  singleLabel: string | undefined,
  valueFormat: string | undefined,
): A11yTable {
  return {
    caption,
    columns: [
      { name: categoryTitle, type: categoryColumn.type, align: alignFor(categoryColumn.type) },
      ...plans.map((plan) => ({
        name: singleLabel ?? plan.descriptor.label,
        type: 'number' as const,
        align: 'right' as const,
      })),
    ],
    rows: axes.map((axis, index) => [
      axis.label,
      ...plans.map((plan) => {
        const value = plan.vertices[index]?.value;
        return value === undefined || value === null ? '' : formatNumber(value, valueFormat);
      }),
    ]),
    presentation,
  };
}

/** A well-formed empty result, for a block with no axes to draw. */
function emptyResult(
  input: EncodeInput,
  series: readonly SeriesDescriptor[],
  gridShape: GridShape,
  fillOpacity: number,
): RadarEncodeResult {
  return {
    marks: [],
    series,
    scales: { value: createContinuousScale('linear', { domain: [0, 1] }) },
    axes: [],
    a11yTable: {
      caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
      columns: [],
      rows: [],
      presentation: presentationOf(input.attrs),
    },
    state: { ...DEFAULT_PLAN, gridShape, fillOpacity },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// layout
// ─────────────────────────────────────────────────────────────────────────────

/** The circle the grid, the spokes and every outline are drawn on. */
interface RadarGeometry {
  cx: number;
  cy: number;
  outer: number;
}

/**
 * Fit the largest circle the frame holds, once the axis labels have their room.
 *
 * Labels are measured, not guessed at: a spoke label is chrome that sits outside
 * the outer ring, and a ring sized without allowing for it would push the labels
 * off the frame, where core's clip would crop them — and a clipped label is worse
 * than no label (SPEC 11.5). The horizontal reservation is capped, because one
 * very long category name must shrink the chart, not erase it.
 */
function fitCircle(frame: Rect, plan: RadarPlan, ctx: LayoutContext): RadarGeometry | undefined {
  const width = Math.max(0, finite(frame.width, 0));
  const height = Math.max(0, finite(frame.height, 0));
  if (width <= 0 || height <= 0) return undefined;

  const font = labelFont(ctx.theme, ctx.theme.type.tickScale);
  const gap = font.size * LABEL_GAP_RATIO;
  let widest = 0;
  for (const axis of plan.axes) {
    widest = Math.max(widest, finite(ctx.metrics.measure(axis.label, font).width, 0));
  }

  const horizontal = width / 2 - gap - Math.min(widest, width * LABEL_WIDTH_SHARE);
  const vertical = height / 2 - gap - font.size;
  const outer = Math.min(horizontal, vertical);
  if (!(outer > 0)) return undefined;

  return { cx: finite(frame.x, 0) + width / 2, cy: finite(frame.y, 0) + height / 2, outer };
}

function layoutRadar(
  encoded: EncodeResult<LineMark>,
  frame: Rect,
  ctx: LayoutContext,
): ChartLayoutResult {
  const plan = planOf<LineMark, RadarPlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];
  const labels: DirectLabel[] = [];

  const scale = encoded.scales.value;
  if (plan.axes.length === 0 || scale === undefined) return { nodes, hits };
  const circle = fitCircle(frame, plan, ctx);
  if (circle === undefined) return { nodes, hits };

  // The radius *is* the value: the domain floor sits at the centre and the top of
  // the domain sits on the outer ring.
  setScaleRange(scale, 0, circle.outer);

  nodes.push(...gridNodes(plan, circle, scale, ctx));
  drawOutlines(plan, circle, scale, ctx, nodes, hits, labels);

  return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
}

/** The point on axis `index` at radius `r`. */
function vertexAt(
  axes: readonly RadarAxis[],
  index: number,
  cx: number,
  cy: number,
  r: number,
): Point {
  return polar(cx, cy, r, axes[index]?.angle ?? 0);
}

/** A closed ring at radius `r`, as a polygon through every spoke. */
function ringPath(axes: readonly RadarAxis[], circle: RadarGeometry, r: number): PathCommand[] {
  const points = axes.map((_, index) => vertexAt(axes, index, circle.cx, circle.cy, r));
  const d = curvePath(points, 'linear');
  return d.length === 0 ? d : [...d, closePath()];
}

/**
 * The polar grid: rings, spokes, and the labels on both.
 *
 * Ring values come off the shared tick ladder, so a radar's rings are the round
 * numbers a cartesian value axis would have chosen for the same domain — the two
 * forms have to agree about what a clean number is (SPEC 11.5).
 */
function gridNodes(
  plan: RadarPlan,
  circle: RadarGeometry,
  scale: Scale,
  ctx: LayoutContext,
): SceneNode[] {
  const { theme } = ctx;
  const nodes: SceneNode[] = [];
  const ring = gridStroke(theme, 'grid');
  const spoke = gridStroke(theme, 'axis');
  const font = labelFont(theme, theme.type.tickScale);
  const [floor] = scale.domain as readonly number[];

  // ── Rings ──────────────────────────────────────────────────────────────────
  const ticks = scale.ticks(RING_HINT).filter((tick): tick is number => isFiniteNumber(tick));
  for (const tick of ticks) {
    const r = scale.scale(tick);
    if (!isFiniteNumber(r) || r <= 0 || r > circle.outer) continue;
    if (plan.gridShape === 'circle') {
      nodes.push({
        kind: 'circle',
        id: ctx.ids.next('ring'),
        cls: 'mdv-grid mdv-radar-ring',
        cx: px(circle.cx),
        cy: px(circle.cy),
        r: px(r),
        stroke: ring,
      });
    } else {
      const d = ringPath(plan.axes, circle, r);
      if (d.length === 0) continue;
      nodes.push({
        kind: 'path',
        id: ctx.ids.next('ring'),
        cls: 'mdv-grid mdv-radar-ring',
        d,
        stroke: ring,
      });
    }
  }

  // ── Spokes ─────────────────────────────────────────────────────────────────
  for (let index = 0; index < plan.axes.length; index += 1) {
    const tip = vertexAt(plan.axes, index, circle.cx, circle.cy, circle.outer);
    nodes.push({
      kind: 'line',
      id: ctx.ids.next('spoke'),
      cls: 'mdv-axis mdv-radar-spoke',
      x1: px(circle.cx),
      y1: px(circle.cy),
      x2: px(tip.x),
      y2: px(tip.y),
      stroke: spoke,
    });
  }

  // ── Ring labels, up the 12 o'clock spoke ───────────────────────────────────
  // They sit to the *left* of the spoke so they never collide with the first
  // axis label, which is centred above its tip.
  for (const tick of ticks) {
    const r = scale.scale(tick);
    if (!isFiniteNumber(r) || r <= 0 || r > circle.outer) continue;
    const text = scale.format(tick);
    nodes.push({
      kind: 'text',
      id: ctx.ids.next('ring-label'),
      cls: 'mdv-label mdv-radar-ring-label',
      x: px(circle.cx - font.size * LABEL_GAP_RATIO),
      y: px(circle.cy - r),
      text,
      font,
      fill: solid(theme.tokens['text-muted']),
      anchor: 'end',
      baseline: 'middle',
      // Ticks round to clean numbers and set in tabular figures (SPEC 11.5).
      tabular: true,
      width: px(finite(ctx.metrics.measure(text, font).width, 0)),
    });
  }
  if (isFiniteNumber(floor) && plan.axes.length > 0) {
    // The centre is a value too, and on a domain with a negative floor it is not
    // the one a reader would assume.
    const text = scale.format(floor);
    nodes.push({
      kind: 'text',
      id: ctx.ids.next('ring-label'),
      cls: 'mdv-label mdv-radar-ring-label',
      x: px(circle.cx - font.size * LABEL_GAP_RATIO),
      y: px(circle.cy),
      text,
      font,
      fill: solid(theme.tokens['text-muted']),
      anchor: 'end',
      baseline: 'middle',
      tabular: true,
      width: px(finite(ctx.metrics.measure(text, font).width, 0)),
    });
  }

  // ── Axis labels, outside the outer ring ────────────────────────────────────
  for (let index = 0; index < plan.axes.length; index += 1) {
    const axis = plan.axes[index];
    if (axis === undefined) continue;
    const anchorPoint = vertexAt(
      plan.axes,
      index,
      circle.cx,
      circle.cy,
      circle.outer + font.size * LABEL_GAP_RATIO,
    );
    const sin = Math.sin(axis.angle);
    const cos = Math.cos(axis.angle);
    nodes.push({
      kind: 'text',
      id: ctx.ids.next('axis-label'),
      cls: 'mdv-label mdv-radar-axis-label',
      x: px(anchorPoint.x),
      y: px(anchorPoint.y),
      text: axis.label,
      font,
      // Axis text is chrome and wears a text token, never the data colour
      // (SPEC 11.5).
      fill: solid(theme.tokens['text-secondary']),
      anchor: sin > 0.01 ? 'start' : sin < -0.01 ? 'end' : 'middle',
      baseline: cos > 0.01 ? 'bottom' : cos < -0.01 ? 'top' : 'middle',
      width: px(finite(ctx.metrics.measure(axis.label, font).width, 0)),
    });
  }

  return nodes;
}

/** Paint order: every wash, then every outline, then every vertex. */
function drawOutlines(
  plan: RadarPlan,
  circle: RadarGeometry,
  scale: Scale,
  ctx: LayoutContext,
  nodes: SceneNode[],
  hits: ChartHitRegion[],
  labels: DirectLabel[],
): void {
  const { theme } = ctx;
  const fills: SceneNode[] = [];
  const strokes: SceneNode[] = [];
  const markers: SceneNode[] = [];
  const radius = theme.marks.marker.minDiameter / 2;

  for (const series of plan.series) {
    const placed = series.vertices.map((vertex) => {
      if (vertex.value === null) return undefined;
      const r = scale.scale(vertex.value);
      if (!isFiniteNumber(r)) return undefined;
      // `maxValue` below a reading, or a reading under the floor, would otherwise
      // put a vertex outside the grid it is measured against.
      const clamped = clamp(r, 0, circle.outer);
      return { vertex, point: vertexAt(plan.axes, vertex.axis, circle.cx, circle.cy, clamped) };
    });
    const complete = placed.every((entry) => entry !== undefined);

    // ── The outline ─────────────────────────────────────────────────────────
    // Complete series close; a series with a break is drawn as its contiguous
    // runs, open, because joining across the gap would invent a reading.
    const runs: Point[][] = [];
    let run: Point[] = [];
    for (const entry of placed) {
      if (entry === undefined) {
        if (run.length > 0) runs.push(run);
        run = [];
        continue;
      }
      run.push(entry.point);
    }
    if (run.length > 0) runs.push(run);

    for (const points of runs) {
      const base = curvePath(points, 'linear');
      if (base.length === 0) continue;
      const d = complete ? [...base, closePath()] : base;
      if (complete && plan.fillOpacity > 0) {
        fills.push({
          kind: 'path',
          id: ctx.ids.next('area'),
          cls: 'mdv-mark mdv-mark-area',
          d,
          // A wash, never a saturated block (SPEC 11.4).
          fill: seriesFill(series.descriptor, plan.fillOpacity),
        });
      }
      strokes.push({
        kind: 'path',
        id: ctx.ids.next('outline'),
        cls: 'mdv-mark mdv-mark-line',
        d,
        stroke: lineStroke(theme, series.descriptor.color),
      });
    }

    // ── Vertices and hit targets ────────────────────────────────────────────
    for (const entry of placed) {
      if (entry === undefined) continue;
      const nodeId = ctx.ids.next('point');
      markers.push({
        kind: 'circle',
        id: nodeId,
        cls: 'mdv-mark mdv-mark-point',
        cx: px(entry.point.x),
        cy: px(entry.point.y),
        r: px(radius),
        fill: solid(series.descriptor.color),
        // The 2 px surface ring keeps a vertex legible where two outlines cross.
        stroke: surfaceRing(theme),
      });
      hits.push(
        pointHit(entry.point.x, entry.point.y, radius, {
          datumIndex: entry.vertex.datum,
          seriesId: series.descriptor.id,
          group: series.descriptor.id === '' ? undefined : series.descriptor.id,
          readout: entry.vertex.readout,
          markNodeId: nodeId,
        }),
      );
    }

    // ── One direct label per outline (SPEC 11.5, 12.5) ──────────────────────
    // On its widest vertex, which is the one place the outline is furthest from
    // its neighbours and so the one place the label attaches unambiguously.
    if (plan.directLabels) {
      let best: { point: Point; vertex: RadarVertex; value: number } | undefined;
      for (const entry of placed) {
        if (entry === undefined || entry.vertex.value === null) continue;
        if (best === undefined || compareNumbers(entry.vertex.value, best.value) > 0) {
          best = { point: entry.point, vertex: entry.vertex, value: entry.vertex.value };
        }
      }
      if (best !== undefined) {
        labels.push({
          x: best.point.x,
          y: best.point.y,
          text: series.descriptor.label,
          placement: 'outside',
          priority: 50,
          seriesId: series.descriptor.id,
          datum: best.vertex.datum,
        });
      }
    }
  }

  nodes.push(...fills, ...strokes, ...markers);
}

export default radarChart;

/**
 * `sparkline` — the line, with everything else taken away (SPEC 8.12).
 *
 * > | `sparkline` | `y` (or `data`) | `curve`, `points`, `band`, `width`,
 * > `height` | Chromeless: no axes, no legend, no tooltip. Also available
 * > inline (§9.2). |
 *
 * Four decisions follow from that one row, and every one of them is a *removal*.
 *
 * 1. **Chromeless is a contract, not a style.** `axes` is empty, no legend is
 *    built, and `layout` returns **no hit regions** — the family is `none`, so
 *    there is no crosshair and no tooltip to hover. A sparkline is read as a
 *    shape beside a number that some other element already states; adding a
 *    readout would make it a small line chart, which is a different form with a
 *    different (and much larger) minimum legible size.
 *
 * 2. **The data is still reachable.** SPEC 12.3 admits no exception: removing
 *    the axes removes the *ruler*, not the numbers. The table view carries every
 *    point, and both band bounds when there is a band, which is also the route
 *    SPEC 9.2 leaves for the inline spelling when it degrades.
 *
 * 3. **It self-scales, and it shares that arithmetic.** MDV draws this same
 *    picture in four places (`internal/spark.ts`); a tile's `trend` strip and
 *    the same numbers in a `sparkline` block must not disagree about where the
 *    line goes. The extent spans the line *and* the band together, so the band
 *    always contains the line it is a band around.
 *
 * 4. **Non-finite values are dropped, not gapped.** SPEC 8.12 gives the
 *    sparkline no `nullPolicy` — unlike `line` (SPEC 8.3), which gaps by
 *    default — and the other three spellings of a sparkline drop. A gap is a
 *    statement about missingness that needs an axis to read it against, and
 *    there is no axis here. A row whose *band* bound is missing keeps its value
 *    and breaks the band instead: the line is the claim, the band is the
 *    qualifier.
 *
 * `data="1,4,2,8"` (SPEC 5.2) is parsed **here**. Core treats a `data:` that is
 * not an `@reference` as an inline dataset request, and a block with no data
 * section resolves to an empty table with no diagnostic — so the numbers are
 * still sitting in the attribute bag when `encode` runs, and this is the one
 * type that knows they are a series rather than a dataset name.
 */

import type {
  A11yTable,
  ChannelSpec,
  ChartLayoutResult,
  ChartType,
  Column,
  DataType,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  LineMark,
  Rect,
  ResolvedBlock,
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';

import { composeDescription, countPhrase, presentationOf } from './internal/a11y.js';
import { autoNumberAttr, enumAttr, numberAttr, numberOf, rawAttr } from './internal/attrs.js';
import { blockDiagnostic, incompatibleField, unknownEnum } from './internal/diagnostics.js';
import { formatNumber } from './internal/format.js';
import type { Point } from './internal/geometry.js';
import { areaPath, curvePath, px } from './internal/geometry.js';
import { isFiniteNumber } from './internal/num.js';
import { lineStroke, seriesFill, solid, surfaceRing } from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import type { SparkStrip } from './internal/spark.js';
import { parseSeries, sparkExtent, sparkX, sparkY } from './internal/spark.js';
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
import type { CurveKind, PointPolicy } from './internal/types.js';
import { CURVE_KINDS, POINT_POLICIES } from './internal/types.js';

/** One observation, with the band bounds that belong to it. */
interface SparkStep {
  /** The value. Always finite: a step without one is not a step. */
  value: number;
  /** The band's lower bound at this step, or `null` where the band breaks. */
  lower: number | null;
  upper: number | null;
  /** Row in the prepared table, for export and debugging. */
  datum: number;
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface SparklinePlan {
  steps: SparkStep[];
  curve: CurveKind;
  points: PointPolicy;
  /** `undefined` means "the theme decides", which is the usual case. */
  strokeWidth: number | undefined;
  pointSize: number;
  series: SeriesDescriptor;
  hasBand: boolean;
}

const FALLBACK_SERIES: SeriesDescriptor = {
  id: '',
  label: 'Value',
  slot: 0,
  color: '#2a78d6',
  source: '',
};

const DEFAULT_PLAN: SparklinePlan = {
  steps: [],
  curve: 'linear',
  points: 'none',
  strokeWidth: undefined,
  pointSize: 8,
  series: FALLBACK_SERIES,
  hasBand: false,
};

/** What `encode` hands `layout`: the marks plus the plan above. */
export type SparklineEncodeResult = PlannedEncodeResult<LineMark, SparklinePlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'y',
    required: false,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The series to draw. Omit it and `data="1,4,2,8"` supplies the numbers inline.',
  },
];

/** `sparkline` (SPEC 8.12). */
export const sparklineChart: ChartType<LineMark> = {
  name: 'sparkline',
  level: 2,
  // No axes, no legend, no tooltip: there is no readout layer to attach.
  family: 'none',
  channels: CHANNELS,
  defaultEncoding: {},
  // `height` is a *per-type* default (cascade level 1, SPEC 5.5) — the generic
  // 300 px of SPEC 8.1 belongs to a plot with axes to hold up. A sparkline at
  // 300 px is not a sparkline.
  defaults: { curve: 'linear', points: 'none', pointSize: 8, height: 48 },
  schemaId: 'https://mdv.dev/schema/1.0/block/sparkline.json',
  // Legible far below a plot's minimum: it is a shape, not a reading.
  minWidth: 80,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const channel = firstChannelOf(block.encoding, ['y', 'value']);
    const inline = inlineSeries(block.attrs);

    if (channel?.field === undefined && inline.length === 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          '`y` is required by `sparkline` and is not bound',
          'Bind it to a column (`y: revenue`) or write the numbers inline (`data="1,4,2,8"`).',
        ),
      );
      return diagnostics;
    }

    if (channel?.field === undefined) return diagnostics;

    const found = findColumn(table, channel.field);
    if (found === undefined) {
      // An empty table is the inline case, where there are no columns to name.
      if (table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`y\` names \`${channel.field}\`, which is not a column`,
          ),
        );
      }
      return diagnostics;
    }
    if (!isQuantitative(found.column.type)) {
      diagnostics.push(
        incompatibleField(block, 'y', channel.field, found.column.type, [
          'number',
          'integer',
          'duration',
        ]),
      );
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<LineMark> {
    const { attrs, block, table } = input;
    const report =
      (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
        input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
      };

    const curve = enumAttr(
      attrs,
      'curve',
      CURVE_KINDS,
      'linear',
      report('curve', CURVE_KINDS, 'linear'),
    );
    const points = enumAttr(
      attrs,
      'points',
      POINT_POLICIES,
      'none',
      report('points', POINT_POLICIES, 'none'),
    );

    const channel = firstChannelOf(input.encoding, ['y', 'value']);
    const bound = bindField(table, channel);
    const format = channelFormat(channel, bound?.column);

    // A position keeps the index it was read at — the row for a bound column,
    // the author's ordinal for an inline list — and a band edge is read at that
    // same index. So a value dropped for being non-finite takes its bounds down
    // with it rather than handing them to its neighbour, and the band stays
    // attached to the number it qualifies even though the line re-spaces.
    const positions: { value: number | null; datum: number }[] = [];
    if (bound === undefined) {
      inlineSeries(attrs).forEach((value, index) => {
        positions.push({ value, datum: index });
      });
    } else {
      for (let row = 0; row < table.rows.length; row += 1) {
        const numeric = cellNumber(cell(table, row, bound.index));
        positions.push({ value: isFiniteNumber(numeric) ? numeric : null, datum: row });
      }
    }

    const band = bandBounds(input, table);
    const steps: SparkStep[] = [];
    for (const position of positions) {
      if (position.value === null) continue;
      steps.push({
        value: position.value,
        lower: band?.lower(position.datum) ?? null,
        upper: band?.upper(position.datum) ?? null,
        datum: position.datum,
      });
    }

    const label = bound === undefined ? 'Value' : humaniseColumn(bound.column);
    const series = singleSeries(input, bound?.column, label);
    const marks: LineMark[] = [
      {
        mark: 'line',
        seriesId: '',
        datum: steps[0]?.datum ?? 0,
        points: steps.map((step) => ({ x: step.datum, y: step.value, datum: step.datum })),
      },
    ];

    const result: SparklineEncodeResult = {
      marks,
      // No legend: one unnamed series, and nothing to distinguish it from.
      series: [series],
      scales: {},
      // Chromeless (SPEC 8.12): there is no domain to tick.
      axes: [],
      a11yTable: sparkTable(
        steps,
        label,
        format,
        band !== undefined,
        bound?.column.type,
        attrs.title,
        presentationOf(attrs),
      ),
      state: {
        steps,
        curve,
        points,
        strokeWidth: autoNumberAttr(attrs, 'strokeWidth', 0.5, 8),
        pointSize: numberAttr(attrs, 'pointSize', 8, 1, 64),
        series,
        hasBand: band !== undefined,
      },
    };
    return result;
  },

  layout(encoded: EncodeResult<LineMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<LineMark, SparklinePlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const theme = ctx.theme;
    // No tooltip (SPEC 8.12), so no hit regions — not empty by accident.
    const hits: [] = [];

    const width = Math.max(0, isFiniteNumber(frame.width) ? frame.width : 0);
    const height = Math.max(0, isFiniteNumber(frame.height) ? frame.height : 0);
    if (width <= 0 || height <= 0 || plan.steps.length === 0) return { nodes, hits };

    const strokeWidth = plan.strokeWidth ?? Math.max(1, theme.marks.line.width - 0.5);
    const radius = Math.max(theme.marks.marker.minDiameter, plan.pointSize) / 2;
    // The frame is the paint area, so a line drawn on its edge loses half its
    // stroke and a marker loses most of itself. Inset by what actually sticks
    // out — but never by so much that the strip stops being a strip.
    const wanted =
      plan.points === 'none'
        ? strokeWidth / 2
        : Math.max(strokeWidth / 2, radius + theme.marks.marker.ringWidth);
    const inset = Math.max(0, Math.min(wanted, width / 4, height / 4));
    const strip: SparkStrip = {
      x: (isFiniteNumber(frame.x) ? frame.x : 0) + inset,
      y: (isFiniteNumber(frame.y) ? frame.y : 0) + inset,
      width: width - inset * 2,
      height: height - inset * 2,
    };

    // One extent over the line and both band edges: the band must contain the
    // line, which it only does when they share a scale.
    const extent = sparkExtent([
      plan.steps.map((step) => step.value),
      plan.steps.map((step) => step.lower),
      plan.steps.map((step) => step.upper),
    ]);
    if (extent === undefined) return { nodes, hits };

    const count = plan.steps.length;
    const at = (index: number): number => sparkX(strip, index, count);
    const line: Point[] = plan.steps.map((step, index) => ({
      x: at(index),
      y: sparkY(strip, step.value, extent),
    }));

    // ── The band, beneath the line and with no stroke (SPEC 8.4) ─────────────
    if (plan.hasBand) {
      for (const run of bandRuns(plan.steps)) {
        if (run.length < 2) continue;
        const upper = run.map((index) => ({
          x: at(index),
          y: sparkY(strip, plan.steps[index]?.upper ?? 0, extent),
        }));
        const lower = run.map((index) => ({
          x: at(index),
          y: sparkY(strip, plan.steps[index]?.lower ?? 0, extent),
        }));
        const d = areaPath(upper, lower, plan.curve);
        if (d.length === 0) continue;
        nodes.push({
          kind: 'path',
          cls: 'mdv-mark mdv-mark-band',
          d,
          // A wash, never a saturated block (SPEC 11.4).
          fill: seriesFill(plan.series, theme.marks.area.fillOpacity),
        });
      }
    }

    // ── The line ─────────────────────────────────────────────────────────────
    const d = curvePath(line, plan.curve);
    if (d.length > 0) {
      nodes.push({
        kind: 'path',
        cls: 'mdv-mark mdv-mark-line',
        d,
        stroke: lineStroke(theme, plan.series.color, strokeWidth),
      });
    }

    // ── Markers (SPEC 8.3 `points`, off by default) ──────────────────────────
    for (const index of markerSet(plan.steps, plan.points)) {
      const point = line[index];
      if (point === undefined) continue;
      nodes.push({
        kind: 'circle',
        id: ctx.ids.next('point'),
        cls: 'mdv-mark mdv-mark-point',
        cx: px(point.x),
        cy: px(point.y),
        r: px(radius),
        fill: solid(plan.series.color),
        stroke: surfaceRing(theme),
      });
    }

    return { nodes, hits };
  },

  describe(input: DescribeInput<LineMark>): string {
    const plan = planOf<LineMark, SparklinePlan>(input.encoded, DEFAULT_PLAN);
    const steps = plan.steps;
    if (steps.length === 0) return 'Sparkline with no data.';

    const format = (value: number): string => formatNumber(value);
    let low = steps[0]?.value ?? 0;
    let high = low;
    for (const step of steps) {
      if (step.value < low) low = step.value;
      if (step.value > high) high = step.value;
    }
    const last = steps[steps.length - 1]?.value ?? high;
    const label = plan.series.label;

    return composeDescription({
      chartKind: 'Sparkline',
      ...(label === '' ? {} : { subject: label }),
      scope: countPhrase(steps.length, 'point'),
      range: `Values range from ${format(low)} to ${format(high)}`,
      // Where it ends is the reading a sparkline is for; there is no axis to
      // find a labelled extreme against.
      extreme: `Ends at ${format(last)}`,
    });
  },
};

/**
 * The numbers written straight into the block: `data="1,4,2,8"` (SPEC 5.2).
 *
 * A `@reference` yields nothing, which is correct rather than lucky —
 * `Number('@sales')` is `NaN` and {@link parseSeries} drops it, so a block that
 * names a dataset falls through to the bound-column path with no special case.
 */
function inlineSeries(attrs: EncodeInput['attrs']): number[] {
  return parseSeries(rawAttr(attrs, 'data'));
}

/** Reads one band edge at the index its value was read at — row, or ordinal. */
type BandEdge = (index: number) => number | null;

/**
 * Resolve `band: {lower, upper}` (SPEC 8.12) into a reader per edge.
 *
 * Each edge is a column name, a comma-separated list, a list of numbers, or a
 * single number (a constant reference band). **Both edges are required**: one
 * edge is not a band, it is a second line the form has no way to distinguish
 * from the first, so a half-specified band warns and draws nothing.
 */
function bandBounds(
  input: EncodeInput,
  table: Table,
): { lower: BandEdge; upper: BandEdge } | undefined {
  const raw = rawAttr(input.attrs, 'band');
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || raw instanceof Date) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1501',
        input.block,
        'encode',
        '`band` is not a `{lower, upper}` mapping and was ignored',
        'Write `band: {lower: low, upper: high}` naming two columns, or two inline lists.',
      ),
    );
    return undefined;
  }

  const record = raw as Readonly<Record<string, unknown>>;
  const lower = bandEdge(record['lower'], table);
  const upper = bandEdge(record['upper'], table);
  if (lower === undefined || upper === undefined) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1501',
        input.block,
        'encode',
        '`band` needs both `lower` and `upper`; the band was not drawn',
        'A single edge is indistinguishable from a second series once the axes are gone.',
      ),
    );
    return undefined;
  }
  return { lower, upper };
}

/** One edge of a band: a column, a list, or a constant. */
function bandEdge(value: unknown, table: Table): BandEdge | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value === 'string') {
    const found = findColumn(table, value);
    if (found !== undefined) {
      return (index) => finiteOrNull(cellNumber(cell(table, index, found.index)));
    }
    const parsed = parseSeries(value);
    if (parsed.length === 0) return undefined;
    return (index) => finiteOrNull(parsed[index]);
  }

  if (Array.isArray(value)) {
    const parsed = value.map((entry) => numberOf(entry));
    return (index) => finiteOrNull(parsed[index]);
  }

  const constant = numberOf(value);
  if (constant === undefined) return undefined;
  return () => constant;
}

/** A finite number, or `null` — the band's own way of saying "not here". */
function finiteOrNull(value: unknown): number | null {
  return isFiniteNumber(value) ? value : null;
}

/** Index runs where both band edges are present: each is one unbroken ribbon. */
function bandRuns(steps: readonly SparkStep[]): number[][] {
  const runs: number[][] = [];
  let current: number[] = [];
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    if (step === undefined || step.lower === null || step.upper === null) {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push(index);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

/** Which points carry a marker, per the `points` policy (SPEC 8.3). */
function markerSet(steps: readonly SparkStep[], policy: PointPolicy): Set<number> {
  const out = new Set<number>();
  if (steps.length === 0) return out;
  switch (policy) {
    case 'all':
      for (let i = 0; i < steps.length; i += 1) out.add(i);
      break;
    case 'ends':
      out.add(0);
      out.add(steps.length - 1);
      break;
    case 'extremes':
      out.add(indexOfExtreme(steps, 'min'));
      out.add(indexOfExtreme(steps, 'max'));
      break;
    default:
      break;
  }
  return out;
}

/** Index of the lowest or highest value; `0` when there is none. */
function indexOfExtreme(steps: readonly SparkStep[], which: 'min' | 'max'): number {
  let best = 0;
  let bestValue: number | undefined;
  for (let i = 0; i < steps.length; i += 1) {
    const value = steps[i]?.value;
    if (!isFiniteNumber(value)) continue;
    if (bestValue === undefined || (which === 'min' ? value < bestValue : value > bestValue)) {
      bestValue = value;
      best = i;
    }
  }
  return best;
}

/**
 * The one series, so the line takes slot 1 like any other lone measure.
 *
 * Allocated through the palette rather than hard-coded, because SPEC 11.2 rule 1
 * keys colour on identity: a sparkline of `revenue` beside a line chart of
 * `revenue` should be the same blue.
 */
function singleSeries(
  input: EncodeInput,
  column: Column | undefined,
  label: string,
): SeriesDescriptor {
  const { palette } = input;
  const patternDef = palette.patternDef('');
  return {
    id: '',
    label,
    slot: palette.slot(''),
    color: palette.color(''),
    source: column?.name ?? '',
    ...(patternDef === undefined ? {} : { patternDef }),
  };
}

/**
 * The table view: the ruler that was taken off the picture (SPEC 12.3).
 *
 * Ordinal first, because the sparkline has no x channel to name its positions —
 * the point's rank in the series *is* its identity here.
 */
function sparkTable(
  steps: readonly SparkStep[],
  label: string,
  format: string | undefined,
  hasBand: boolean,
  valueType: DataType | undefined,
  title: string | undefined,
  presentation: A11yTable['presentation'],
): A11yTable {
  const type: DataType = valueType ?? 'number';
  const columns: A11yTable['columns'] = [
    { name: 'Point', type: 'integer', align: 'right' },
    { name: label, type, align: 'right' },
  ];
  if (hasBand) {
    columns.push({ name: 'Lower', type, align: 'right' });
    columns.push({ name: 'Upper', type, align: 'right' });
  }

  const rows = steps.map((step, index) => {
    const row = [String(index + 1), formatNumber(step.value, format)];
    if (hasBand) {
      row.push(formatNumber(step.lower, format), formatNumber(step.upper, format));
    }
    return row;
  });

  return { caption: title ?? label, columns, rows, presentation };
}

export default sparklineChart;

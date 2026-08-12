/**
 * `box` — the distribution across categories (SPEC 8.8).
 *
 * A box plot is five numbers per category and an argument about the rest. The
 * box spans the quartiles, the line inside it is the median, and the whiskers
 * reach as far as a rule says the bulk of the sample goes. Everything past a
 * whisker is drawn one point at a time, because that is the entire purpose of
 * the form: it separates "the middle half sits here" from "and these four rows
 * are somewhere else entirely".
 *
 * Three consequences follow, and all three are load-bearing.
 *
 * 1. **A whisker ends on an observation, never on the fence.** Tukey's rule puts
 *    the fence at `q3 + 1.5 · IQR`; drawing the whisker there would assert a
 *    value the sample does not contain. The whisker goes to the most extreme
 *    observation at or inside the fence, and the fence itself is never painted.
 *    Every whisker mode works this way — `minmax` is the same rule with the
 *    fence at infinity, which is why it has no outliers.
 * 2. **The quartiles come from {@link quantile}**, the same interpolation
 *    `histogram` uses for its Freedman–Diaconis width (SPEC 8.7). A box drawn
 *    beside a histogram of one column has to put its hinges where the
 *    histogram's rule said the middle half was.
 * 3. **`points: jitter` is seeded from the block id** (SPEC 24.3). Two renders
 *    of a document scatter the observations identically, on every machine and in
 *    every process; `Math.random` is never called.
 *
 * The table may hold raw observations, one row per observation, or pre-computed
 * five-number summaries, one row per box. SPEC 8.8 makes the presence of a
 * `median` field the discriminator, so that is what is tested — with `q1` and
 * `q3` alongside it, because a median on its own is a line, not a box. In
 * summary form `whisker`, `outliers` and `points` have nothing left to describe:
 * the observations they would have re-derived are already gone.
 */

import type {
  A11yTable,
  AxisModel,
  BoxMark,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  Column,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  PathCommand,
  PointMark,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  ScaleInput,
  SceneNode,
  SeriesDescriptor,
  Stroke,
  Table,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import { boolAttr, enumAttr, stringAttr } from './internal/attrs.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './internal/cartesian.js';
import {
  blockDiagnostic,
  incompatibleField,
  missingChannel,
  unknownEnum,
} from './internal/diagnostics.js';
import {
  alignFor,
  composeDescription,
  countPhrase,
  extremesOf,
  presentationOf,
  subjectPhrase,
} from './internal/a11y.js';
import { buildLegend } from './internal/series.js';
import { closePath, lineTo, moveTo, px } from './internal/geometry.js';
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
import { compareNumbers, isFiniteNumber } from './internal/num.js';
import { createBandScale, createContinuousScale, discreteKey } from './internal/scale.js';
import { formatNumber, formatValue } from './internal/format.js';
import { hitRegion, pointHit, readout } from './internal/hit.js';
import { planOf } from './internal/plan.js';
import { readableOn, seriesFill, solid } from './internal/paint.js';
import { mulberry32, seedFrom } from './internal/random.js';
import { quantile } from './internal/stats.js';
import { extentOf, resolveDomain, resolveScaleType } from './internal/domain.js';

/** How the observations behind each box are drawn, if at all (SPEC 8.8). */
const POINT_MODES = ['none', 'all', 'jitter'] as const;
type PointMode = (typeof POINT_MODES)[number];

/** The named whisker rules; `p<lo>-p<hi>` is parsed separately. */
const WHISKER_MODES = ['tukey', 'minmax', 'stddev'] as const;

/** `p10-p90` and friends: two percentiles, ascending, each within 0–100. */
const PERCENTILE_PATTERN = /^p(\d{1,3}(?:\.\d+)?)-p(\d{1,3}(?:\.\d+)?)$/;

/** Tukey's multiplier: the fence sits 1.5 interquartile ranges past a hinge. */
const TUKEY_MULTIPLIER = 1.5;
/** `stddev` fences at one standard deviation either side of the mean. */
const STDDEV_MULTIPLIER = 1;
/** A notch spans `median ± 1.58 · IQR / √n` — the 95% interval on the median. */
const NOTCH_CONSTANT = 1.58;

/**
 * A whisker rule, flattened.
 *
 * The three named modes and the percentile form all reduce to the same
 * two-number question — where are the fences? — so they share one shape rather
 * than a union that would have to be narrowed at every use.
 */
interface WhiskerSpec {
  mode: 'tukey' | 'minmax' | 'stddev' | 'percentile';
  /** The lower multiplier, or the lower percentile under `percentile`. */
  lo: number;
  hi: number;
}

/** The box attributes, resolved (SPEC 8.8). */
interface BoxOptions {
  whisker: WhiskerSpec;
  outliers: boolean;
  points: PointMode;
  notch: boolean;
}

/** One category's five-number summary, plus what fell outside it. */
interface Summary {
  /** The lower whisker end: an observation, never the fence. */
  lo: number;
  q1: number;
  median: number;
  q3: number;
  /** The upper whisker end. */
  hi: number;
  outliers: number[];
  /** The sample size, or `0` when the row was already a summary. */
  n: number;
}

/** One box, before it becomes a mark. */
interface Group {
  key: string;
  value: ScaleInput;
  label: string;
  /** The row the box points back at — the first row of the category. */
  row: number;
  summary: Summary;
  /** The observations, in row order, for the `points` overlay. */
  values: number[];
  /** The row each observation came from, parallel to {@link Group.values}. */
  rows: number[];
}

/** Per-box data `layout` needs that a {@link BoxMark} does not carry. */
interface BoxEntry {
  label: string;
  readout: ReadoutRow[];
  /** Readouts for the outliers, in the order they appear on the mark. */
  outlierReadouts: ReadoutRow[][];
  /** The notch bounds, absent when `notch` is off or the sample size is unknown. */
  notchLo?: number;
  notchHi?: number;
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface BoxPlan {
  boxes: BoxEntry[];
  /**
   * The horizontal offset of each point mark, as a signed fraction of the box
   * width. Pixels are not known until layout, but the randomness has to be
   * settled in encode so that it is seeded once per block (SPEC 24.3).
   */
  jitter: number[];
  /** What the value axis measures, for the generated description. */
  measure: string | undefined;
  /** What the boxes are split by, for the generated description. */
  category: string | undefined;
  valueFormat: string | undefined;
}

const DEFAULT_PLAN: BoxPlan = {
  boxes: [],
  jitter: [],
  measure: undefined,
  category: undefined,
  valueFormat: undefined,
};

/** Boxes and the optional observation overlay share one mark array. */
type BoxChartMark = BoxMark | PointMark;

type BoxEncodeResult = PlannedEncodeResult<BoxChartMark, BoxPlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime'],
    defaultScale: 'band',
    doc: 'The category each box summarises.',
  },
  {
    name: 'y',
    required: false,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The observations each box summarises. Optional only when the table already holds `median`, `q1` and `q3` columns.',
  },
  {
    name: 'color',
    required: false,
    accepts: ['string', 'category'],
    constant: true,
    doc: 'Fixed color for the boxes.',
  },
];

/** The five-number columns a pre-computed table supplies (SPEC 8.8). */
interface SummaryColumns {
  median: number;
  q1: number;
  q3: number;
  min: number | undefined;
  max: number | undefined;
}

/** Find a column by name, case-insensitively — headings vary in their capitals. */
function columnNamed(table: Table, name: string): number | undefined {
  const wanted = name.toLowerCase();
  for (let i = 0; i < table.fields.length; i += 1) {
    const field = table.fields[i];
    if (field !== undefined && field.name.toLowerCase() === wanted) return i;
  }
  return undefined;
}

/**
 * Detect the pre-computed form (SPEC 8.8: "detected by presence of a `median`
 * field").
 *
 * `q1` and `q3` are required alongside it. A table with a `median` column and no
 * hinges is not a box plot waiting to be drawn — it is a bar chart of medians,
 * and silently inventing hinges for it would be a lie about the data.
 */
function summaryColumns(table: Table): SummaryColumns | undefined {
  const median = columnNamed(table, 'median');
  const q1 = columnNamed(table, 'q1');
  const q3 = columnNamed(table, 'q3');
  if (median === undefined || q1 === undefined || q3 === undefined) return undefined;
  return {
    median,
    q1,
    q3,
    min: columnNamed(table, 'min'),
    max: columnNamed(table, 'max'),
  };
}

/**
 * Parse the `whisker` attribute (SPEC 8.8), falling back to `tukey`.
 *
 * An unrecognised spelling is `MDV1502` and the default, never a throw: a typo
 * in one attribute must not cost the reader the whole chart (SPEC 14.1).
 */
function parseWhisker(text: string | undefined, onUnknown: (given: string) => void): WhiskerSpec {
  if (text === undefined) return { mode: 'tukey', lo: TUKEY_MULTIPLIER, hi: TUKEY_MULTIPLIER };
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'tukey') return { mode: 'tukey', lo: TUKEY_MULTIPLIER, hi: TUKEY_MULTIPLIER };
  if (trimmed === 'minmax') return { mode: 'minmax', lo: 0, hi: 0 };
  if (trimmed === 'stddev') {
    return { mode: 'stddev', lo: STDDEV_MULTIPLIER, hi: STDDEV_MULTIPLIER };
  }
  const match = PERCENTILE_PATTERN.exec(trimmed);
  if (match !== null) {
    const lo = Number(match[1]);
    const hi = Number(match[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi) && lo >= 0 && hi <= 100 && lo < hi) {
      return { mode: 'percentile', lo, hi };
    }
  }
  onUnknown(text);
  return { mode: 'tukey', lo: TUKEY_MULTIPLIER, hi: TUKEY_MULTIPLIER };
}

/** Read the box attributes (SPEC 8.8). */
function readAttrs(input: EncodeInput): BoxOptions {
  const { attrs, block } = input;
  return {
    whisker: parseWhisker(stringAttr(attrs, 'whisker'), (given: string) => {
      input.diagnostic(
        unknownEnum(block, 'whisker', given, [...WHISKER_MODES, 'p<lo>-p<hi>'], 'tukey'),
      );
    }),
    outliers: boolAttr(attrs, 'outliers', true),
    points: enumAttr(attrs, 'points', POINT_MODES, 'none', (given: string) => {
      input.diagnostic(unknownEnum(block, 'points', given, POINT_MODES, 'none'));
    }),
    notch: boolAttr(attrs, 'notch', false),
  };
}

/** The arithmetic mean of a non-empty sample. */
function meanOf(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/** The population standard deviation about `mean`. */
function deviationOf(values: readonly number[], mean: number): number {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += (value - mean) * (value - mean);
  return Math.sqrt(total / values.length);
}

/**
 * Summarise one ascending sample.
 *
 * Every whisker rule is the same two steps: put the fences somewhere, then walk
 * in from each end to the first observation inside them. `minmax` puts the
 * fences at infinity, which is how it ends up with no outliers without needing a
 * branch of its own.
 */
function summarise(sorted: readonly number[], whisker: WhiskerSpec): Summary | undefined {
  const n = sorted.length;
  const first = sorted[0];
  const last = sorted[n - 1];
  if (first === undefined || last === undefined) return undefined;

  const q1 = quantile(sorted, 0.25);
  const median = quantile(sorted, 0.5);
  const q3 = quantile(sorted, 0.75);

  let fenceLo = Number.NEGATIVE_INFINITY;
  let fenceHi = Number.POSITIVE_INFINITY;
  if (whisker.mode === 'tukey') {
    const iqr = q3 - q1;
    fenceLo = q1 - whisker.lo * iqr;
    fenceHi = q3 + whisker.hi * iqr;
  } else if (whisker.mode === 'stddev') {
    const mean = meanOf(sorted);
    const sd = deviationOf(sorted, mean);
    fenceLo = mean - whisker.lo * sd;
    fenceHi = mean + whisker.hi * sd;
  } else if (whisker.mode === 'percentile') {
    fenceLo = quantile(sorted, whisker.lo / 100);
    fenceHi = quantile(sorted, whisker.hi / 100);
  }

  let lo = first;
  let hi = last;
  let loIndex = 0;
  while (loIndex < n && (sorted[loIndex] as number) < fenceLo) loIndex += 1;
  let hiIndex = n - 1;
  while (hiIndex >= 0 && (sorted[hiIndex] as number) > fenceHi) hiIndex -= 1;
  if (loIndex <= hiIndex) {
    lo = sorted[loIndex] as number;
    hi = sorted[hiIndex] as number;
  } else {
    // Fences that exclude the whole sample — a percentile pair inside a single
    // repeated value, say. The whiskers collapse onto the median rather than
    // inverting, and nothing becomes an outlier.
    lo = median;
    hi = median;
    loIndex = 0;
    hiIndex = n - 1;
  }

  const outliers: number[] = [];
  for (const value of sorted) {
    if (value < lo || value > hi) outliers.push(value);
  }
  return { lo, q1, median, q3, hi, outliers, n };
}

/** Collect one box per distinct category, from raw observations. */
function rawGroups(
  table: Table,
  categoryIndex: number,
  valueIndex: number,
  whisker: WhiskerSpec,
  categoryFormat: string | undefined,
): Group[] {
  const order: string[] = [];
  const byKey = new Map<string, Group>();
  for (let row = 0; row < table.rows.length; row += 1) {
    const raw = cellScaleInput(cell(table, row, categoryIndex));
    if (raw === null) continue;
    const value = cellNumber(cell(table, row, valueIndex));
    if (value === null || !isFiniteNumber(value)) continue;
    const key = discreteKey(raw);
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        key,
        value: raw,
        label: formatValue(raw, categoryFormat),
        row,
        summary: { lo: 0, q1: 0, median: 0, q3: 0, hi: 0, outliers: [], n: 0 },
        values: [],
        rows: [],
      };
      byKey.set(key, group);
      order.push(key);
    }
    group.values.push(value);
    group.rows.push(row);
  }

  const groups: Group[] = [];
  for (const key of order) {
    const group = byKey.get(key);
    if (group === undefined) continue;
    const sorted = [...group.values].sort(compareNumbers);
    const summary = summarise(sorted, whisker);
    if (summary === undefined) continue;
    group.summary = summary;
    groups.push(group);
  }
  return groups;
}

/** Collect one box per row, from pre-computed five-number summaries. */
function summaryGroups(
  table: Table,
  categoryIndex: number,
  columns: SummaryColumns,
  categoryFormat: string | undefined,
): Group[] {
  const groups: Group[] = [];
  for (let row = 0; row < table.rows.length; row += 1) {
    const raw = cellScaleInput(cell(table, row, categoryIndex));
    if (raw === null) continue;
    const median = cellNumber(cell(table, row, columns.median));
    const q1 = cellNumber(cell(table, row, columns.q1));
    const q3 = cellNumber(cell(table, row, columns.q3));
    if (median === null || q1 === null || q3 === null) continue;
    if (!isFiniteNumber(median) || !isFiniteNumber(q1) || !isFiniteNumber(q3)) continue;
    // Absent `min`/`max` columns leave the whiskers on the hinges: a box with no
    // whiskers is the honest drawing of a summary that never had them.
    const min = columns.min === undefined ? null : cellNumber(cell(table, row, columns.min));
    const max = columns.max === undefined ? null : cellNumber(cell(table, row, columns.max));
    const lo = min !== null && isFiniteNumber(min) ? Math.min(min, q1) : q1;
    const hi = max !== null && isFiniteNumber(max) ? Math.max(max, q3) : q3;
    groups.push({
      key: discreteKey(raw),
      value: raw,
      label: formatValue(raw, categoryFormat),
      row,
      summary: { lo, q1, median, q3, hi, outliers: [], n: 0 },
      values: [],
      rows: [],
    });
  }
  return groups;
}

/** The 95% interval on the median, clamped inside the box it notches. */
function notchSpan(summary: Summary): [number, number] | undefined {
  if (summary.n <= 0) return undefined;
  const half = (NOTCH_CONSTANT * (summary.q3 - summary.q1)) / Math.sqrt(summary.n);
  if (!isFiniteNumber(half) || half <= 0) return undefined;
  // A wide interval on a small sample can reach past the hinges. Clamping keeps
  // the notch a notch; letting it escape would draw a shape that is no longer a
  // box, and the width it would claim is not information the box can carry.
  return [Math.max(summary.q1, summary.median - half), Math.min(summary.q3, summary.median + half)];
}

/** The one series a box plot has, taken straight from the palette allocator. */
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

/** The readout for one box: the summary, in the order the eye reads it. */
function boxReadout(
  categoryLabel: string,
  group: Group,
  summary: Summary,
  valueFormat: string | undefined,
  series: SeriesDescriptor,
  showOutliers: boolean,
): ReadoutRow[] {
  const fmt = (value: number): string => formatNumber(value, valueFormat);
  const rows: ReadoutRow[] = [
    readout(categoryLabel, group.label),
    readout('Median', fmt(summary.median), series, true),
    readout('Q1–Q3', `${fmt(summary.q1)}–${fmt(summary.q3)}`),
    readout('Whiskers', `${fmt(summary.lo)}–${fmt(summary.hi)}`),
  ];
  if (summary.n > 0) rows.push(readout('Observations', String(summary.n)));
  if (showOutliers && summary.outliers.length > 0) {
    rows.push(readout('Outliers', String(summary.outliers.length)));
  }
  return rows;
}

/**
 * The table view for a box plot, built by hand (SPEC 12.3).
 *
 * `buildA11yTable` projects the prepared table onto its bound columns, which for
 * a box plot would be the raw observations — a thousand rows of one number,
 * which is exactly the thing the chart exists to summarise. The reachable data
 * here is the summary itself, one row per box, so this type supplies its own.
 */
function boxA11yTable(
  caption: string,
  presentation: A11yTable['presentation'],
  categoryLabel: string,
  categoryType: Column['type'],
  groups: readonly Group[],
  valueFormat: string | undefined,
  showOutliers: boolean,
): A11yTable {
  const anyOutliers = showOutliers && groups.some((group) => group.summary.outliers.length > 0);
  const numeric = ['Lower whisker', 'Q1', 'Median', 'Q3', 'Upper whisker'];
  const fmt = (value: number): string => formatNumber(value, valueFormat);
  return {
    caption,
    columns: [
      { name: categoryLabel, type: categoryType, align: alignFor(categoryType) },
      ...numeric.map((name) => ({ name, type: 'number', align: 'right' as const })),
      ...(anyOutliers ? [{ name: 'Outliers', type: 'number', align: 'right' as const }] : []),
    ],
    rows: groups.map((group) => {
      const s = group.summary;
      return [
        group.label,
        fmt(s.lo),
        fmt(s.q1),
        fmt(s.median),
        fmt(s.q3),
        fmt(s.hi),
        ...(anyOutliers ? [String(s.outliers.length)] : []),
      ];
    }),
    presentation,
  };
}

/**
 * A stroke that stops exactly on the datum.
 *
 * `lineStroke` takes its caps from the theme, which rounds them: good for a line
 * chart, wrong here, because a round cap extends half a stroke width past the
 * observation the whisker ends on and would put the whisker's tip on a value the
 * sample does not contain.
 */
function datumStroke(color: string, width: number): Stroke {
  return { paint: solid(color), width, cap: 'butt', join: 'miter' };
}

/** The outline of a notched box, as a path. */
function notchedBoxPath(
  left: number,
  right: number,
  top: number,
  bottom: number,
  notchTop: number,
  notchBottom: number,
  medianY: number,
  inset: number,
): PathCommand[] {
  return [
    moveTo(px(left), px(top)),
    lineTo(px(right), px(top)),
    lineTo(px(right), px(notchTop)),
    lineTo(px(right - inset), px(medianY)),
    lineTo(px(right), px(notchBottom)),
    lineTo(px(right), px(bottom)),
    lineTo(px(left), px(bottom)),
    lineTo(px(left), px(notchBottom)),
    lineTo(px(left + inset), px(medianY)),
    lineTo(px(left), px(notchTop)),
    closePath(),
  ];
}

/** `box` (SPEC 8.8). */
export const boxChart: ChartType<BoxChartMark> = {
  name: 'box',
  aliases: ['boxplot'],
  level: 2,
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: {
    whisker: 'tukey',
    outliers: true,
    points: 'none',
    notch: false,
  },
  schemaId: 'https://mdv.dev/schema/1.0/block/box.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const summary = summaryColumns(table);

    const xChannel = firstChannel(block.encoding, 'x');
    if (xChannel?.field === undefined) {
      diagnostics.push(missingChannel(block, 'x', 'the category each box summarises'));
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

    const yChannel = firstChannel(block.encoding, 'y');
    if (yChannel?.field === undefined) {
      if (summary === undefined) {
        diagnostics.push(
          missingChannel(
            block,
            'y',
            'the observations each box summarises, or give the table `median`, `q1` and `q3` columns',
          ),
        );
      }
    } else if (findColumn(table, yChannel.field) === undefined && table.fields.length > 0) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`y\` names \`${yChannel.field}\`, which is not a column`,
        ),
      );
    } else {
      const bound = bindField(table, yChannel);
      if (
        bound !== undefined &&
        !isQuantitative(bound.column.type) &&
        bound.column.type !== 'unknown'
      ) {
        diagnostics.push(
          incompatibleField(block, 'y', bound.column.name, bound.column.type, [
            'number',
            'integer',
            'duration',
          ]),
        );
      }
    }

    // The pre-computed form has no observations left to scatter or re-fence.
    if (summary !== undefined && firstChannel(block.encoding, 'y')?.field === undefined) {
      for (const name of ['points', 'whisker'] as const) {
        if (block.attrs[name] !== undefined) {
          diagnostics.push(
            blockDiagnostic(
              'MDV1501',
              block,
              'encode',
              `\`${name}\` needs the raw observations; this table holds pre-computed summaries`,
              'Bind `y` to the observations to use it, or drop the attribute.',
            ),
          );
        }
      }
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<BoxChartMark> {
    const { table, encoding, attrs, block } = input;
    const options = readAttrs(input);
    const xChannel = firstChannel(encoding, 'x');
    const yChannel = firstChannel(encoding, 'y');
    const xBound = bindField(table, xChannel);
    const yBound = bindField(table, yChannel);
    const descriptor = singleSeries(input, yBound?.column);
    const series: readonly SeriesDescriptor[] = [descriptor];

    if (xBound === undefined) return emptyResult(input, series);

    const categoryFormat = channelFormat(xChannel, xBound.column);
    const summaryCols = yBound === undefined ? summaryColumns(table) : undefined;

    let groups: Group[];
    if (summaryCols !== undefined) {
      groups = summaryGroups(table, xBound.index, summaryCols, categoryFormat);
    } else if (yBound !== undefined) {
      groups = rawGroups(table, xBound.index, yBound.index, options.whisker, categoryFormat);
    } else {
      return emptyResult(input, series);
    }
    if (groups.length === 0) return emptyResult(input, series);

    const valueFormat = channelFormat(yChannel, yBound?.column);
    const categoryLabel = humaniseColumn(xBound.column);
    const measure = yBound === undefined ? 'Value' : humaniseColumn(yBound.column);

    // ── Marks: every box first, then every point ─────────────────────────────
    // Order is paint order, so the overlay lands on top of the boxes it belongs
    // to, and `layout` can walk each kind with its own index into the plan.
    const marks: BoxChartMark[] = [];
    const boxes: BoxEntry[] = [];
    const span: number[] = [];
    for (const group of groups) {
      const summary = group.summary;
      const outliers = options.outliers ? summary.outliers : [];
      const notch = options.notch ? notchSpan(summary) : undefined;
      marks.push({
        mark: 'box',
        seriesId: '',
        datum: group.row,
        x: group.value,
        min: summary.lo,
        q1: summary.q1,
        median: summary.median,
        q3: summary.q3,
        max: summary.hi,
        label: group.label,
        ...(outliers.length === 0 ? {} : { outliers: [...outliers] }),
      });
      boxes.push({
        label: group.label,
        readout: boxReadout(
          categoryLabel,
          group,
          summary,
          valueFormat,
          descriptor,
          options.outliers,
        ),
        outlierReadouts: outliers.map((value) => [
          readout(categoryLabel, group.label),
          readout('Outlier', formatNumber(value, valueFormat), descriptor, true),
        ]),
        ...(notch === undefined ? {} : { notchLo: notch[0], notchHi: notch[1] }),
      });
      span.push(summary.lo, summary.q1, summary.median, summary.q3, summary.hi, ...outliers);
    }

    const jitter: number[] = [];
    if (options.points !== 'none' && summaryCols === undefined) {
      const random = options.points === 'jitter' ? mulberry32(seedFrom(block.id)) : undefined;
      for (const group of groups) {
        for (let i = 0; i < group.values.length; i += 1) {
          const value = group.values[i];
          if (value === undefined) continue;
          marks.push({
            mark: 'point',
            seriesId: '',
            datum: group.rows[i] ?? group.row,
            x: group.value,
            y: value,
            label: group.label,
          });
          jitter.push(random === undefined ? 0 : random() - 0.5);
          span.push(value);
        }
      }
    }

    // ── Scales and axes ──────────────────────────────────────────────────────
    const scaleType = resolveScaleType(yChannel, 'linear');
    // A box axis is not forced through zero: the middle half of a sample is
    // rarely near it, and dragging the frame down to include it would flatten
    // every box into a line (SPEC 8.8 — the spread is the message).
    const domainResult = resolveDomain({
      data: extentOf(span) ?? [0, 1],
      zeroByDefault: false,
      ...(yChannel?.scale === undefined ? {} : { spec: yChannel.scale }),
    });
    const categoryScale = createBandScale({
      domain: groups.map((group) => group.value),
      ...(categoryFormat === undefined ? {} : { format: categoryFormat }),
    });
    const valueScale = createContinuousScale(scaleType, {
      domain: domainResult.domain,
      ...(yChannel?.scale?.clamp === undefined ? {} : { clamp: yChannel.scale.clamp }),
      ...(valueFormat === undefined ? {} : { format: valueFormat }),
    });

    const categoryAxis = makeAxis({
      channel: 'x',
      position: 'bottom',
      scale: categoryScale,
      binding: xChannel,
      column: xBound.column,
      spec: axisSpecFor(attrs, 'x', xChannel),
      gridByDefault: false,
      baselineByDefault: true,
    });
    const valueSpec = axisSpecFor(attrs, 'y', yChannel);
    const valueAxis = makeAxis({
      channel: 'y',
      position: 'left',
      scale: valueScale,
      binding: yChannel,
      column: yBound?.column,
      spec:
        valueSpec === false
          ? false
          : yBound === undefined
            ? { title: measure, ...valueSpec }
            : valueSpec,
      gridByDefault: true,
      baselineByDefault: false,
    });
    const axes: AxisModel[] = [categoryAxis, valueAxis].filter(
      (axis): axis is AxisModel => axis !== undefined,
    );

    const result: BoxEncodeResult = {
      marks,
      series,
      scales: { x: categoryScale, y: valueScale },
      axes,
      boundColumns: [xBound.column, ...(yBound === undefined ? [] : [yBound.column])],
      a11yTable: boxA11yTable(
        attrs.title ?? attrs.caption ?? 'Chart data',
        presentationOf(attrs),
        categoryLabel,
        xBound.column.type,
        groups,
        valueFormat,
        options.outliers,
      ),
      state: {
        boxes,
        jitter,
        measure,
        category: categoryLabel,
        valueFormat,
      },
    };
    const legend = buildLegend(attrs, series, 'rect');
    if (legend !== undefined) result.legend = legend;
    return result;
  },

  layout(encoded: EncodeResult<BoxChartMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<BoxChartMark, BoxPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];

    const categoryScale = encoded.scales.x;
    const valueScale = encoded.scales.y;
    const series = encoded.series[0];
    if (
      categoryScale === undefined ||
      valueScale === undefined ||
      series === undefined ||
      isDegenerateFrame(frame)
    ) {
      return { nodes, hits };
    }
    rangeToFrame(frame, categoryScale, valueScale);

    const band =
      typeof categoryScale.bandwidth === 'function' ? categoryScale.bandwidth() : frame.width;
    const gap = ctx.theme.marks.spacer.surfaceGap;
    // A box is a bar with more to say, so it obeys the same cap: a box beside a
    // bar of the same categories is drawn the same width (SPEC 11.4).
    const width = Math.max(2, Math.min(band - gap, ctx.theme.marks.bar.maxThickness * 2));
    const lineWidth = ctx.theme.marks.line.width;
    const stroke = datumStroke(series.color, lineWidth);
    const medianStroke = datumStroke(readableOn(ctx.theme, series.color), lineWidth);
    const outlierRadius = ctx.theme.marks.marker.minDiameter / 2;

    let boxIndex = 0;
    let pointIndex = 0;
    for (const mark of encoded.marks) {
      const start = categoryScale.scale(mark.x);
      if (!isFiniteNumber(start)) {
        if (mark.mark === 'box') boxIndex += 1;
        else pointIndex += 1;
        continue;
      }
      const centre = start + band / 2;

      if (mark.mark === 'point') {
        // The overlay is texture, not a target: it carries no hit region of its
        // own, because the box behind it already answers for these rows and two
        // overlapping readouts on one pixel would be a worse answer than one.
        const offset = (plan.jitter[pointIndex] ?? 0) * (width * 0.6);
        pointIndex += 1;
        const y = valueScale.scale(mark.y);
        if (!isFiniteNumber(y)) continue;
        nodes.push({
          kind: 'circle',
          id: ctx.ids.next('point'),
          cls: 'mdv-mark mdv-mark-point',
          cx: px(centre + offset),
          cy: px(y),
          r: px(Math.max(1.5, outlierRadius * 0.6)),
          fill: solid(series.color, 0.45),
        });
        continue;
      }

      const entry = plan.boxes[boxIndex];
      boxIndex += 1;

      const left = centre - width / 2;
      const right = centre + width / 2;
      const q1y = valueScale.scale(mark.q1);
      const q3y = valueScale.scale(mark.q3);
      const medianY = valueScale.scale(mark.median);
      const loY = valueScale.scale(mark.min);
      const hiY = valueScale.scale(mark.max);
      if (!isFiniteNumber(q1y) || !isFiniteNumber(q3y) || !isFiniteNumber(medianY)) continue;

      const top = Math.min(q1y, q3y);
      const bottom = Math.max(q1y, q3y);

      // Whiskers first, so the box covers the half of each one that would
      // otherwise show through it.
      if (isFiniteNumber(loY) && isFiniteNumber(hiY)) {
        const capHalf = width / 4;
        for (const [end, edge] of [
          [loY, bottom],
          [hiY, top],
        ] as const) {
          if (Math.abs(end - edge) < 0.5) continue;
          nodes.push({
            kind: 'line',
            id: ctx.ids.next('whisker'),
            cls: 'mdv-mark mdv-mark-whisker',
            x1: px(centre),
            y1: px(edge),
            x2: px(centre),
            y2: px(end),
            stroke,
          });
          nodes.push({
            kind: 'line',
            id: ctx.ids.next('whisker-cap'),
            cls: 'mdv-mark mdv-mark-whisker-cap',
            x1: px(centre - capHalf),
            y1: px(end),
            x2: px(centre + capHalf),
            y2: px(end),
            stroke,
          });
        }
      }

      const nodeId = ctx.ids.next('box');
      const height = Math.max(1, bottom - top);
      const notchLo = entry?.notchLo;
      const notchHi = entry?.notchHi;
      const notchTop = notchHi === undefined ? undefined : valueScale.scale(notchHi);
      const notchBottom = notchLo === undefined ? undefined : valueScale.scale(notchLo);
      if (
        notchTop !== undefined &&
        notchBottom !== undefined &&
        isFiniteNumber(notchTop) &&
        isFiniteNumber(notchBottom)
      ) {
        nodes.push({
          kind: 'path',
          id: nodeId,
          cls: 'mdv-mark mdv-mark-box',
          d: notchedBoxPath(
            left,
            right,
            top,
            bottom,
            Math.min(notchTop, notchBottom),
            Math.max(notchTop, notchBottom),
            medianY,
            width / 4,
          ),
          fill: seriesFill(series),
        });
      } else {
        nodes.push({
          kind: 'rect',
          id: nodeId,
          cls: 'mdv-mark mdv-mark-box',
          x: px(left),
          y: px(top),
          w: px(width),
          h: px(height),
          fill: seriesFill(series),
        });
      }

      nodes.push({
        kind: 'line',
        id: ctx.ids.next('median'),
        cls: 'mdv-mark mdv-mark-median',
        x1: px(left),
        y1: px(medianY),
        x2: px(right),
        y2: px(medianY),
        stroke: medianStroke,
      });

      hits.push(
        hitRegion({
          x: left,
          y: top,
          w: width,
          h: height,
          anchor: { x: centre, y: medianY },
          datumIndex: mark.datum,
          seriesId: mark.seriesId,
          readout: entry?.readout ?? [],
          markNodeId: nodeId,
        }),
      );

      const outliers = mark.outliers ?? [];
      for (let i = 0; i < outliers.length; i += 1) {
        const value = outliers[i];
        if (value === undefined) continue;
        const cy = valueScale.scale(value);
        if (!isFiniteNumber(cy)) continue;
        const outlierId = ctx.ids.next('outlier');
        nodes.push({
          kind: 'circle',
          id: outlierId,
          cls: 'mdv-mark mdv-mark-outlier',
          cx: px(centre),
          cy: px(cy),
          r: px(outlierRadius),
          fill: solid(series.color, 0.7),
        });
        hits.push(
          pointHit(centre, cy, Math.max(outlierRadius, 6), {
            datumIndex: mark.datum,
            seriesId: mark.seriesId,
            readout: entry?.outlierReadouts[i] ?? [],
            markNodeId: outlierId,
          }),
        );
      }
    }

    return { nodes, hits };
  },

  describe(input: DescribeInput<BoxChartMark>): string {
    const { encoded } = input;
    const plan = planOf<BoxChartMark, BoxPlan>(encoded, DEFAULT_PLAN);
    const boxes = encoded.marks.filter((mark): mark is BoxMark => mark.mark === 'box');
    if (boxes.length === 0) return 'Box plot with no data.';

    const valueScale = encoded.scales.y;
    const format = (value: number): string =>
      valueScale === undefined ? formatNumber(value, plan.valueFormat) : valueScale.format(value);

    const extremes = extremesOf(
      boxes.map((mark, index) => ({
        label: plan.boxes[index]?.label ?? String(mark.x),
        value: mark.median,
      })),
      format,
    );
    const outliers = boxes.reduce((sum, mark) => sum + (mark.outliers?.length ?? 0), 0);
    const scope =
      outliers > 0
        ? `${countPhrase(boxes.length, 'category', 'categories')}, ${countPhrase(outliers, 'outlier')}`
        : countPhrase(boxes.length, 'category', 'categories');
    const subject = subjectPhrase(plan.measure, plan.category);

    return composeDescription({
      chartKind: 'Box plot',
      ...(subject === undefined ? {} : { subject }),
      scope,
      ...(extremes === undefined
        ? {}
        : {
            range: `Medians range from ${extremes.low.formatted} in ${extremes.low.label} to ${extremes.high.formatted} in ${extremes.high.label}`,
            extreme: `Highest median: ${extremes.high.label}`,
          }),
    });
  },
};

/** A well-formed empty result, for a block whose category resolved to nothing. */
function emptyResult(input: EncodeInput, series: readonly SeriesDescriptor[]): BoxEncodeResult {
  return {
    marks: [],
    series,
    scales: {
      x: createBandScale({ domain: [] }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: {
      caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
      columns: [],
      rows: [],
      presentation: presentationOf(input.attrs),
    },
    state: { ...DEFAULT_PLAN, boxes: [], jitter: [] },
  };
}

export default boxChart;

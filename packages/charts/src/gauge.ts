/**
 * `gauge` — one reading against its declared range (SPEC 8.12).
 *
 * A gauge is a **one-number form**. SPEC 8.13 is blunt about what that means:
 *
 * > The correct form when the answer is **one number**. A chart of a single value
 * > is decoration.
 *
 * So a gauge is a `metric` that has been given a range to sit in, and every rule
 * below follows from that one fact.
 *
 * 1. **Many rows still make one reading.** A table can carry a hundred rows; a
 *    gauge shows one number. The reduction is `metric`'s (SPEC 8.13): the
 *    channel's own `aggregate` when the author declared one, otherwise the last
 *    row — the reading a dashboard means by "current". The reduction is reported
 *    (`MDV3050`, info) and every row is still in the table view, so nothing is
 *    hidden and no row is silently promoted to "the answer".
 * 2. **The reading always wins over the range.** `min`/`max` set the scale, but
 *    the arc is bounded by construction and a reading past the rim has nowhere
 *    to go: pinning it there would draw a value 3× over the cap identically to
 *    one exactly at it. So an out-of-range reading widens the bound and
 *    `MDV1502` reports the attribute that was ignored — exactly what `radar`'s
 *    `maxValue` cap does, and for exactly the same reason.
 * 3. **The track is a step of the fill's own ramp, never a grey.** SPEC 8.12:
 *    "The unfilled track is a **lighter step of the fill's own ramp**, so state
 *    reads across the whole arc." The step chosen is the *nearest the surface*
 *    that still clears the 2:1 floor SPEC 11.3 sets and SPEC 16.4's validator
 *    enforces. The theme's own ordinal band ({@link SequentialPalette.ordinalFloor}
 *    / `ordinalCeiling`) is the starting hint, but the ratio is recomputed here
 *    rather than taken on trust: a hand-written theme (SPEC 11.6) may declare a
 *    bound it never earned, and a track that vanishes into the page is a gauge
 *    that reads as empty. On the default ramp this lands exactly where SPEC 11.3
 *    says it should — step 250 on light, step 600 on dark.
 * 4. **Thresholds are status, not magnitude.** A threshold names a *band of
 *    meaning* — "past here it is a problem" — and SPEC 11.3.1 reserves the
 *    status palette for exactly that, the way SPEC 8.12's own `waterfall` row
 *    reserves it for increase/decrease. A sequential ramp encodes *more and
 *    less*, which is the wrong sentence: a value one unit into the critical band
 *    is exactly as critical as one thirty units in. Status colors "always ship
 *    with an icon and a label so meaning never rests on hue" (SPEC 11.3.1), so
 *    the band's name and its own marker shape are drawn beside the reading.
 *
 * The arc, its track and its end labels are drawn here rather than by core, for
 * the reason `radar`'s polar grid is: core owns axis furniture for the
 * {@link AxisModel}s a type hands it, and an `AxisModel` is cartesian. A gauge
 * has no cartesian axis to hang one off, so `axes` is empty — as `pie`'s and
 * `radar`'s are — and the ink is still drawn to core's specification, through
 * {@link gridStroke} and the theme's own mark specs (SPEC 11.4).
 */

import type {
  A11yTable,
  ArcMark,
  ChannelAggregate,
  ChannelSpec,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  Column,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  Encoding,
  Font,
  LayoutContext,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  SceneNode,
  Table,
  Theme,
} from '@mdv/core';

import { composeDescription, presentationOf, subjectPhrase } from './internal/a11y.js';
import {
  autoNumberAttr,
  boolAttr,
  listAttr,
  numberOf,
  rawAttr,
  stringAttr,
} from './internal/attrs.js';
import { blockDiagnostic, unknownEnum } from './internal/diagnostics.js';
import { extentOf, resolveDomain } from './internal/domain.js';
import { formatNumber } from './internal/format.js';
import { arcPath, polar, px, shapePath } from './internal/geometry.js';
import type { Point } from './internal/geometry.js';
import { hitRegion, readout } from './internal/hit.js';
import { clamp, compareNumbers, finite, isFiniteNumber, sum as sumOf } from './internal/num.js';
import { gridStroke, labelFont, relativeLuminance, solid, tickFont } from './internal/paint.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import { planOf } from './internal/plan.js';
import { createContinuousScale } from './internal/scale.js';
import { quantile } from './internal/stats.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  firstChannelOf,
  findColumn,
  humaniseColumn,
  isQuantitative,
} from './internal/table.js';
import type { PointShape } from './internal/types.js';

/** The default sweep (SPEC 8.12 `arc`): the classic half-dial, opening down. */
const DEFAULT_ARC_DEGREES = 180;

/**
 * The narrowest and widest sweep worth drawing.
 *
 * Below ~15° the arc is a tick and the fraction is unreadable; past a full turn
 * the arc overlaps itself and the reading becomes ambiguous, so both ends clamp
 * rather than reject — an unusable `arc` is a presentation problem, and SPEC
 * 15.2 degrades presentation instead of failing it.
 */
const MIN_ARC_DEGREES = 15;
const MAX_ARC_DEGREES = 360;

/**
 * The band's thickness as a share of the outer radius, before the mark cap.
 *
 * The cap is `theme.marks.bar.maxThickness`, because a gauge band **is** the bar
 * mark bent round a centre — "≤ 24 px thick" (SPEC 11.4) — and mark
 * specifications are fixed across every chart type, not re-chosen per type.
 */
const BAND_RADIUS_RATIO = 0.22;

/**
 * The contrast a ramp step must clear against its own surface (SPEC 11.3).
 *
 * The same number `@mdv/themes` calls `ORDINAL_RAMP_CONTRAST_MIN` and the same
 * one SPEC 16.4's validator enforces. It is restated rather than imported
 * because `@mdv/charts` does not depend on `@mdv/themes` — a chart type is
 * handed a {@link Theme}, not the machinery that built one.
 */
const ORDINAL_CONTRAST_MIN = 2;

/** Where an end label sits, as a multiple of the tick font's size. */
const LABEL_GAP_RATIO = 0.5;

/** Largest share of the half-width one end label may claim. */
const LABEL_WIDTH_SHARE = 0.25;

/** The status roles of SPEC 11.3.1, in ascending severity. */
type StatusRole = 'good' | 'warning' | 'serious' | 'critical';
const STATUS_ROLES: readonly StatusRole[] = ['good', 'warning', 'serious', 'critical'];

/**
 * The name each status role carries, since a status color never travels alone
 * (SPEC 11.3.1: "they always ship with an icon and a label").
 *
 * A fixed table rather than a case transform: `toUpperCase` is one more thing to
 * reason about under SPEC 24.3, and there is nothing to gain by deriving four
 * constant strings.
 */
const STATUS_LABEL: Readonly<Record<StatusRole, string>> = {
  good: 'Good',
  warning: 'Warning',
  serious: 'Serious',
  critical: 'Critical',
};

/**
 * The marker shape each role wears — the "icon" half of SPEC 11.3.1's pairing.
 *
 * Shape is the redundant channel SPEC 12.6 asks for: a reader who cannot
 * separate the four status hues still separates four silhouettes.
 */
const STATUS_SHAPE: Readonly<Record<StatusRole, PointShape>> = {
  good: 'circle',
  warning: 'triangle',
  serious: 'diamond',
  critical: 'square',
};

/** One threshold band, in data space. */
interface GaugeBand {
  /** Lower edge, inclusive. */
  from: number;
  /** Upper edge; inclusive only for the last band, so `max` lands somewhere. */
  to: number;
  status: StatusRole;
  label: string;
}

/** Everything `layout` needs, carried across the seam (see `internal/plan.ts`). */
interface GaugePlan {
  /** The reading, or `null` when the block has none to show. */
  value: number | null;
  /** The reading, formatted — `'—'` when there is none, as a tile's is. */
  valueText: string;
  min: number;
  max: number;
  minText: string;
  maxText: string;
  /** Share of the arc that is filled, 0…1; `null` with no reading. */
  fraction: number | null;
  /** Total sweep, in radians. */
  sweep: number;
  showValue: boolean;
  /** Every band, in ascending order; empty when no thresholds were given. */
  bands: readonly GaugeBand[];
  /** The band the reading falls in, when there are bands and a reading. */
  band: GaugeBand | undefined;
  /** What the gauge measures, for the description and the readout. */
  measure: string | undefined;
  readoutRows: readonly ReadoutRow[];
  /** Row the reading came from, for the hit region's datum. */
  datum: number;
}

const DEFAULT_PLAN: GaugePlan = {
  value: null,
  valueText: '—',
  min: 0,
  max: 1,
  minText: '0',
  maxText: '1',
  fraction: null,
  sweep: (DEFAULT_ARC_DEGREES * Math.PI) / 180,
  showValue: true,
  bands: [],
  band: undefined,
  measure: undefined,
  readoutRows: [],
  datum: 0,
};

/** A gauge's reading is an annular sector, so its mark is an {@link ArcMark}. */
export type GaugeEncodeResult = PlannedEncodeResult<ArcMark, GaugePlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    // Declared optional and enforced in `validate`, exactly as `metric`'s is:
    // core's required-channel check (`MDV3000`) fires on an unbound *channel*,
    // and `value: 72` — a bare number, the most natural way to write a gauge —
    // satisfies the requirement without binding one. `validate` raises the same
    // `MDV3000` when neither spelling is present, so the channel is required in
    // behaviour; only the layer that reports it moves.
    name: 'value',
    required: false,
    accepts: ['number', 'integer', 'duration'],
    constant: true,
    defaultScale: 'linear',
    doc: 'The reading, as a literal or a field. Many rows reduce to one (SPEC 8.13). Also accepted as `y`.',
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
 * Fold the spelling aliases into the canonical channel name, once.
 *
 * SPEC 8.12 names the channel `value`; Appendix D shares `y` with every
 * quantitative type, and `metric` — the sibling one-number form — already
 * accepts both. Normalising here means the rest of the module sees one spelling.
 */
function canonical(encoding: Encoding): Encoding {
  const out: Encoding = { ...encoding };
  if (encoding.value === undefined && encoding.y !== undefined) out.value = encoding.y;
  return out;
}

/** `gauge` (SPEC 8.12). */
export const gaugeChart: ChartType<ArcMark> = {
  name: 'gauge',
  level: 2,
  // The band is the hit target and there is no shared x to snap a crosshair to,
  // so the mark is the target — as `pie`'s arc is (SPEC 7.5).
  family: 'mark',
  channels: CHANNELS,
  defaultEncoding: {},
  defaults: { arc: DEFAULT_ARC_DEGREES, showValue: true },
  schemaId: 'https://mdv.dev/schema/1.0/block/gauge.json',
  // One number in a ring: legible far below a plot's minimum, as a tile is.
  minWidth: 160,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const encoding = canonical(block.encoding);
    const hasLiteral = numberOf(rawAttr(block.attrs, 'value')) !== undefined;
    const channel = firstChannelOf(encoding, ['value', 'y']);

    if (!hasLiteral && channel?.field === undefined) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          '`value` is required by `gauge` and is not bound',
          'Give the gauge a number: `value: 72`, or bind it to a column with `value: utilisation`.',
        ),
      );
    }

    if (
      channel?.field !== undefined &&
      findColumn(table, channel.field) === undefined &&
      table.fields.length > 0
    ) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          `\`value\` names \`${channel.field}\`, which is not a column`,
        ),
      );
    }

    const bound = bindField(table, channel);
    if (
      bound !== undefined &&
      !isQuantitative(bound.column.type) &&
      bound.column.type !== 'unknown'
    ) {
      diagnostics.push(incompatibleValue(block, bound.column.name, bound.column.type));
    }
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<ArcMark> {
    return encodeGauge(input);
  },

  layout(encoded: EncodeResult<ArcMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    return layoutGauge(encoded, frame, ctx);
  },

  describe(input: DescribeInput<ArcMark>): string {
    const plan = planOf<ArcMark, GaugePlan>(input.encoded, DEFAULT_PLAN);
    if (plan.value === null) return 'Gauge with no reading.';

    const percent = plan.fraction === null ? undefined : Math.round(plan.fraction * 100);
    return composeDescription({
      chartKind: 'Gauge',
      ...(plan.measure === undefined
        ? {}
        : { subject: subjectPhrase(plan.measure, undefined) ?? plan.measure }),
      scope: `${plan.valueText} of ${plan.minText} to ${plan.maxText}`,
      ...(percent === undefined ? {} : { range: `${String(percent)}% of the range` }),
      ...(plan.band === undefined ? {} : { extreme: `Band: ${plan.band.label}` }),
    });
  },
};

/** `MDV3001` for the one channel that carries a type (see `internal/diagnostics`). */
function incompatibleValue(block: ResolvedBlock, field: string, actual: string): Diagnostic {
  return blockDiagnostic(
    'MDV3001',
    block,
    'encode',
    `\`value\` is bound to \`${field}\`, which is ${actual}`,
    '`value` on a `gauge` block accepts number, integer, duration. Declare the type under `fields:` if it was inferred wrongly.',
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read `arc` (SPEC 8.12) as a sweep in degrees.
 *
 * Clamped rather than rejected: SPEC 15.2 degrades unknown *presentation*, and a
 * sweep is presentation. Both ends of the clamp are reported, because a gauge
 * silently redrawn at a different sweep than the one written is a gauge whose
 * author cannot tell what happened.
 */
function readArc(input: EncodeInput): number {
  const raw = rawAttr(input.attrs, 'arc');
  if (raw === undefined) return DEFAULT_ARC_DEGREES;
  const numeric = numberOf(raw);
  if (numeric === undefined) {
    input.diagnostic(
      unknownEnum(
        input.block,
        'arc',
        String(raw),
        [`a sweep in degrees, ${String(MIN_ARC_DEGREES)} to ${String(MAX_ARC_DEGREES)}`],
        String(DEFAULT_ARC_DEGREES),
      ),
    );
    return DEFAULT_ARC_DEGREES;
  }
  const clamped = clamp(numeric, MIN_ARC_DEGREES, MAX_ARC_DEGREES);
  if (clamped !== numeric) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `\`arc: ${String(numeric)}\` is outside the drawable sweep; using ${String(clamped)}°`,
        `A gauge sweeps between ${String(MIN_ARC_DEGREES)}° and ${String(MAX_ARC_DEGREES)}°: below that the fraction cannot be read, and past a full turn the arc overlaps itself.`,
      ),
    );
  }
  return clamped;
}

/** One entry of `thresholds`, before it is turned into a band. */
interface ThresholdEdge {
  at: number;
  /** The role the author named, if they named one. */
  status?: StatusRole;
  label?: string;
}

/** `true` for one of the four reserved roles of SPEC 11.3.1. */
function isStatusRole(value: unknown): value is StatusRole {
  return typeof value === 'string' && (STATUS_ROLES as readonly string[]).includes(value);
}

/**
 * Read one `thresholds` entry.
 *
 * Two spellings, because the ladder has a direction the bare form cannot state:
 *
 * - `thresholds: [70, 90]` — bare boundaries. Ascending numbers are read as
 *   ascending *alert* levels, the convention every monitoring tool shares
 *   ("warn at 70, page at 90"), and the bands take SPEC 11.3.1's roles in
 *   ascending severity.
 * - `thresholds: [{at: 70, status: warning}, …]` — explicit. The only way to say
 *   "higher is better" (uptime, coverage) without a `goodDirection` attribute
 *   SPEC 8.12 does not give a gauge, so it is worth supporting rather than
 *   guessing. A named role on an edge at or below `min` names the **bottom**
 *   band, which has no edge of its own to hang a role on.
 */
function readEdge(entry: unknown, report: (given: string) => void): ThresholdEdge | undefined {
  const direct = numberOf(entry);
  if (direct !== undefined) return { at: direct };
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;

  const record = entry as Readonly<Record<string, unknown>>;
  const at = numberOf(record.at ?? record.value);
  if (at === undefined) return undefined;

  const edge: ThresholdEdge = { at };
  const status = record.status ?? record.role;
  if (isStatusRole(status)) edge.status = status;
  else if (status !== undefined) report(String(status));
  if (typeof record.label === 'string' && record.label !== '') edge.label = record.label;
  return edge;
}

/**
 * Turn `thresholds` into the bands of `[min, max]`.
 *
 * Edges are sorted with an explicit comparator (SPEC 24.3 bans the bare one) and
 * edges outside the range are dropped with `MDV1502` — a threshold above `max`
 * describes a band the gauge cannot reach, and silently keeping it would draw a
 * boundary tick on the rim that means nothing.
 */
function readThresholds(input: EncodeInput, min: number, max: number): GaugeBand[] {
  const raw = rawAttr(input.attrs, 'thresholds');
  if (raw === undefined) return [];

  const report = (given: string): void => {
    input.diagnostic(
      unknownEnum(
        input.block,
        'thresholds.status',
        given,
        STATUS_ROLES,
        'the position on the severity ladder',
      ),
    );
  };
  const parsed: ThresholdEdge[] = [];
  for (const entry of listAttr(input.attrs, 'thresholds')) {
    const edge = readEdge(entry, report);
    if (edge !== undefined) parsed.push(edge);
  }
  if (parsed.length === 0) return [];

  const sorted = [...parsed].sort((a, b) => compareNumbers(a.at, b.at));
  const inside: ThresholdEdge[] = [];
  // An edge at or below the floor cuts nothing — but when it names a role it is
  // naming the bottom band, which is the one band with no edge of its own.
  let base: ThresholdEdge | undefined;
  let dropped = 0;
  for (const edge of sorted) {
    if (edge.at > min && edge.at < max) inside.push(edge);
    else if (edge.at <= min && edge.status !== undefined) base = edge;
    else dropped += 1;
  }
  if (dropped > 0) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `${String(dropped)} of ${String(sorted.length)} thresholds fall outside \`${formatNumber(min)}\`…\`${formatNumber(max)}\` and were dropped`,
        'A threshold outside the gauge’s own range describes a band the arc never reaches. Widen `min`/`max`, or move the threshold inside them.',
      ),
    );
  }
  if (inside.length === 0) return [];

  const edges = [min, ...inside.map((edge) => edge.at), max];
  const bands: GaugeBand[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const from = edges[i] ?? min;
    const to = edges[i + 1] ?? max;
    // The status an author writes on an edge describes the band that *starts*
    // there ("at 90 and above, critical"). Band 0 takes the role declared at or
    // below `min` when there is one, and otherwise the foot of the ladder.
    const declared = i === 0 ? base : inside[i - 1];
    const status = declared?.status ?? STATUS_ROLES[Math.min(i, STATUS_ROLES.length - 1)] ?? 'good';
    bands.push({
      from,
      to,
      status,
      label: declared?.label ?? STATUS_LABEL[status],
    });
  }
  return bands;
}

// ─────────────────────────────────────────────────────────────────────────────
// The reading
// ─────────────────────────────────────────────────────────────────────────────

/** Every finite reading in the bound column, in row order, with its row. */
interface Readings {
  values: number[];
  rows: number[];
  /** Rows whose cell was null or unparseable — reported as `droppedRows`. */
  dropped: number;
  column: Column | undefined;
  index: number;
}

function collectReadings(input: EncodeInput, encoding: Encoding): Readings {
  const channel = firstChannelOf(encoding, ['value', 'y']);
  const bound = bindField(input.table, channel);
  const out: Readings = { values: [], rows: [], dropped: 0, column: undefined, index: -1 };
  if (bound === undefined) return out;
  out.column = bound.column;
  out.index = bound.index;
  for (let row = 0; row < input.table.rows.length; row += 1) {
    const numeric = cellNumber(cell(input.table, row, bound.index));
    if (numeric === null) {
      out.dropped += 1;
      continue;
    }
    out.values.push(numeric);
    out.rows.push(row);
  }
  return out;
}

/**
 * Reduce many readings to the one number a gauge shows.
 *
 * The default is `last` because that is `metric`'s (SPEC 8.13) and because a
 * dashboard that hands a gauge a time series means "now" by it. Anything else is
 * the author's declared `aggregate` (SPEC 7.1).
 */
function reduceReadings(
  values: readonly number[],
  aggregate: ChannelAggregate | undefined,
): number {
  const n = values.length;
  switch (aggregate) {
    case 'sum':
      return sumOf(values);
    case 'mean':
      return sumOf(values) / n;
    case 'median': {
      const sorted = [...values].sort(compareNumbers);
      return quantile(sorted, 0.5);
    }
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return n;
    case 'stddev': {
      const mean = sumOf(values) / n;
      return Math.sqrt(sumOf(values.map((v) => (v - mean) ** 2)) / n);
    }
    case 'first':
      return values[0] ?? Number.NaN;
    default:
      return values[n - 1] ?? Number.NaN;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// encode
// ─────────────────────────────────────────────────────────────────────────────

function encodeGauge(input: EncodeInput): EncodeResult<ArcMark> {
  const { attrs, block } = input;
  const encoding = canonical(input.encoding);
  const channel = firstChannelOf(encoding, ['value', 'y']);
  const readings = collectReadings(input, encoding);
  const valueFormat = channelFormat(channel, readings.column) ?? stringAttr(attrs, 'format');

  const sweepDegrees = readArc(input);
  const showValue = boolAttr(attrs, 'showValue', true);
  const measure = readings.column === undefined ? undefined : humaniseColumn(readings.column);

  // ── The reading ────────────────────────────────────────────────────────────
  // A literal `value:` wins, as it does on a tile: an author who wrote the number
  // in the header is not asking the table a question (SPEC 8.13).
  const literal = numberOf(rawAttr(attrs, 'value'));
  let value: number | null = null;
  let datum = 0;
  if (literal !== undefined) {
    value = literal;
  } else if (readings.values.length > 0) {
    const reduced = reduceReadings(readings.values, channel?.aggregate);
    value = isFiniteNumber(reduced) ? reduced : null;
    datum = readings.rows[readings.rows.length - 1] ?? 0;
    // SPEC 8.13: a gauge is a one-number form. Say so rather than let one row of
    // many quietly become "the answer" — `info`, because every row is in the
    // table view below and nothing was dropped.
    if (readings.values.length > 1 && channel?.aggregate === undefined) {
      input.diagnostic(
        blockDiagnostic(
          'MDV3050',
          block,
          'encode',
          `${String(readings.values.length)} rows reduced to one reading — a gauge shows one number`,
          'The last row was used, as a `metric` tile would (SPEC 8.13). Declare `aggregate:` on the channel to summarise them instead, or use a `line` or `bar` block if the shape over rows is the point. Every row is listed in the table view.',
        ),
      );
    }
  }

  // ── The range ──────────────────────────────────────────────────────────────
  const extent = extentOf(value === null ? readings.values : [value]);
  const derived = resolveDomain({
    data: extent,
    // The arc grows from one end: length *is* the reading, so the floor is a
    // baseline and not a viewpoint — the same argument that forces `zero` on a
    // radar's radius (SPEC 8.12) and on a bar's axis (`MDV3021`).
    zeroByDefault: true,
    ...(channel?.scale === undefined ? {} : { spec: channel.scale }),
  }).domain;

  const range = resolveRange(input, derived[0], derived[1], value, valueFormat);
  const { min, max } = range;

  const fraction = value === null ? null : clamp((value - min) / (max - min), 0, 1);
  const bands = readThresholds(input, min, max);
  const band = value === null ? undefined : bandFor(bands, value);

  // ── Marks ──────────────────────────────────────────────────────────────────
  const valueText = value === null ? '—' : formatNumber(value, valueFormat);
  const minText = formatNumber(min, valueFormat);
  const maxText = formatNumber(max, valueFormat);

  const marks: ArcMark[] =
    value === null || fraction === null
      ? []
      : [
          {
            mark: 'arc',
            seriesId: '',
            datum,
            category: measure ?? 'Value',
            value,
            fraction,
          },
        ];

  const readoutRows: ReadoutRow[] = [
    readout(measure ?? 'Value', valueText, undefined, true),
    readout('Range', `${minText} – ${maxText}`),
  ];
  if (band !== undefined) readoutRows.push(readout('Band', band.label));

  const result: GaugeEncodeResult = {
    marks,
    // A gauge has no series: one reading needs no identity to tell it from
    // another, so it takes no palette slot (registry.ts) and gets no legend
    // (SPEC 7.4 — a one-swatch box is pure overhead).
    series: [],
    // The scale is keyed `value`, not `x`/`y`: those are the two core re-ranges
    // onto the frame's edges, and this one runs around a centre.
    scales: {
      value: createContinuousScale('linear', {
        domain: [min, max],
        ...(valueFormat === undefined ? {} : { format: valueFormat }),
      }),
    },
    // A dial has no cartesian axis — see the note at the top of this file.
    axes: [],
    ...(readings.column === undefined ? {} : { boundColumns: [readings.column] }),
    a11yTable: gaugeTable(
      attrs.title ?? attrs.caption ?? 'Chart data',
      presentationOf(attrs),
      measure,
      valueText,
      minText,
      maxText,
      band,
      readings,
      valueFormat,
    ),
    state: {
      value,
      valueText,
      min,
      max,
      minText,
      maxText,
      fraction,
      sweep: (sweepDegrees * Math.PI) / 180,
      showValue,
      bands,
      band,
      measure,
      readoutRows,
      datum,
    },
  };
  if (readings.dropped > 0) result.droppedRows = readings.dropped;
  return result;
}

/**
 * Settle `min` and `max` against the reading.
 *
 * Two failure modes, one principle: **the reading is never misstated.**
 *
 * - `min >= max` leaves no range to divide by. Both are ignored and the derived
 *   domain stands, with `MDV1502` naming what was dropped.
 * - A reading outside the range would have to be pinned to the rim, which draws
 *   a value far past the cap identically to one exactly at it. The bound gives
 *   way instead, and `MDV1502` reports it — the rule `radar` applies to
 *   `maxValue`, for the same reason.
 */
function resolveRange(
  input: EncodeInput,
  derivedMin: number,
  derivedMax: number,
  value: number | null,
  format: string | undefined,
): { min: number; max: number } {
  const askedMin = autoNumberAttr(input.attrs, 'min');
  const askedMax = autoNumberAttr(input.attrs, 'max');

  let min = askedMin ?? derivedMin;
  let max = askedMax ?? derivedMax;

  if (!(max > min)) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `\`min: ${formatNumber(min, format)}\` is not below \`max: ${formatNumber(max, format)}\``,
        'A gauge needs a range with width to place a reading in. Using the range derived from the data instead.',
      ),
    );
    min = derivedMin;
    max = derivedMax;
    // A derived domain can still be flat when the only reading is zero.
    if (!(max > min)) max = min + 1;
  }

  if (value !== null && value > max) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `\`max: ${formatNumber(max, format)}\` is below the reading, ${formatNumber(value, format)}`,
        'Using the reading instead. A gauge cannot draw past the end of its own arc, and pinning the reading there would say it was exactly at the maximum rather than over it.',
      ),
    );
    max = value;
  }
  if (value !== null && value < min) {
    input.diagnostic(
      blockDiagnostic(
        'MDV1502',
        input.block,
        'encode',
        `\`min: ${formatNumber(min, format)}\` is above the reading, ${formatNumber(value, format)}`,
        'Using the reading instead. A reading below the start of the arc has nowhere to sit, and clamping it to the start would say the gauge was empty rather than under its floor.',
      ),
    );
    min = value;
  }
  if (!(max > min)) max = min + 1;
  return { min, max };
}

/** The band a reading falls in: upper edges are exclusive, except the last. */
function bandFor(bands: readonly GaugeBand[], value: number): GaugeBand | undefined {
  for (let i = 0; i < bands.length; i += 1) {
    const band = bands[i];
    if (band === undefined) continue;
    const last = i === bands.length - 1;
    if (value >= band.from && (value < band.to || (last && value <= band.to))) return band;
  }
  return undefined;
}

/**
 * The table view (SPEC 12.3).
 *
 * The gauge's own numbers first — the reading, the range it is measured against,
 * the band it landed in — then **every** source reading, so the row the
 * reduction picked is not the only one a screen-reader user can reach. That is
 * what makes `MDV3050` an `info` rather than a warning: nothing is hidden.
 */
function gaugeTable(
  caption: string,
  presentation: A11yTable['presentation'],
  measure: string | undefined,
  valueText: string,
  minText: string,
  maxText: string,
  band: GaugeBand | undefined,
  readings: Readings,
  format: string | undefined,
): A11yTable {
  const rows: string[][] = [
    [measure ?? 'Value', valueText],
    ['Minimum', minText],
    ['Maximum', maxText],
  ];
  if (band !== undefined) rows.push(['Band', band.label]);
  if (readings.values.length > 1) {
    readings.values.forEach((reading, index) => {
      rows.push([`Reading ${String(index + 1)}`, formatNumber(reading, format)]);
    });
  }
  return {
    caption,
    columns: [
      { name: 'Measure', type: 'string', align: 'left' },
      { name: 'Value', type: readings.column?.type ?? 'number', align: 'right' },
    ],
    rows,
    presentation,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Paint
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The fill and the unfilled track (SPEC 8.12, 11.3).
 *
 * > The unfilled track is a **lighter step of the fill's own ramp**, so state
 * > reads across the whole arc.
 *
 * The step is the one nearest the surface that still clears **2:1** against it —
 * `ordinalFloor` on a light scheme, `ordinalCeiling` on a dark one, which is
 * where the search starts. On the built-in blue ramp that lands on step 250
 * (`#86b6ef`, 2.06:1 on `#fcfcfb`) and step 600 (`#184f95`, 2.15:1 on
 * `#1a1a19`) — precisely the two steps SPEC 11.3 names.
 *
 * The declared index is a **starting hint, not an answer**, and the ratio is
 * recomputed here. `ordinalFloor` is only as good as the theme that set it:
 * `@mdv/themes` derives it by running exactly this check, but SPEC 11.6 lets an
 * author hand-write a palette, and a hand-written one can declare a floor its
 * own ramp does not meet. SPEC 16.4 is explicit that "palette safety is
 * computed, never eyeballed" — so it is computed, on the theme actually in hand,
 * and the search walks away from the surface until the floor is really cleared.
 *
 * The fill is the ramp's **anchor hue**, not a step keyed to the reading: the
 * magnitude is already the arc's length, and encoding it a second time in
 * lightness would make the track's relationship to the fill wander with the data.
 */
function rampPaints(theme: Theme): { fill: ColorString; track: ColorString } {
  const ramp = theme.sequential;
  const steps = ramp.steps;
  const last = steps.length - 1;
  if (last < 0) return { fill: ramp.hue, track: ramp.hue };

  const dark = theme.scheme === 'dark';
  const surface = theme.tokens.surface;
  const start = clamp(Math.trunc(dark ? ramp.ordinalCeiling : ramp.ordinalFloor), 0, last);
  // Steps run light → dark, so "away from the surface" is darker on a light
  // scheme and lighter on a dark one.
  const step = dark ? -1 : 1;

  let track = steps[start] ?? ramp.hue;
  for (let i = start; i >= 0 && i <= last; i += step) {
    const candidate = steps[i];
    if (candidate === undefined) continue;
    track = candidate;
    if (contrastRatio(candidate, surface) >= ORDINAL_CONTRAST_MIN) break;
  }

  let fill = ramp.hue;
  // A theme whose anchor *is* the track step would draw the fill and the track in
  // one colour, and a gauge that reads as full at 10 % is worse than one whose
  // fill is a shade off its anchor.
  if (fill === track) {
    const far = clamp(Math.trunc(dark ? ramp.ordinalFloor : ramp.ordinalCeiling), 0, last);
    fill = steps[far] ?? fill;
  }
  return { fill, track };
}

/**
 * WCAG contrast between two opaque colours, `1…21`.
 *
 * The statistic SPEC 16.4's validator computes, over the luminance
 * `internal/paint` already derives for {@link readableOn}. Both theme colours
 * are opaque, so there is nothing to composite first.
 */
function contrastRatio(a: ColorString, b: ColorString): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05);
}

// ─────────────────────────────────────────────────────────────────────────────
// layout
// ─────────────────────────────────────────────────────────────────────────────

/** The annulus the track, the fill and the ticks are drawn on. */
interface GaugeGeometry {
  cx: number;
  cy: number;
  outer: number;
  inner: number;
  /** Sweep start, radians clockwise from 12 o'clock; negative is anticlockwise. */
  start: number;
  end: number;
}

/** The cardinal directions, for the bounding box of a sector. */
const CARDINALS: readonly number[] = [-Math.PI, -Math.PI / 2, 0, Math.PI / 2, Math.PI];

/**
 * Fit the largest dial the frame holds, once the end labels have their room.
 *
 * The box measured is the **full sector**, centre included, rather than the thin
 * annulus actually painted. That is deliberately conservative: the annulus is
 * contained in the sector for every sweep, the two coincide at 180° and beyond,
 * and a fit that cannot depend on the band thickness cannot be wrong when the
 * 24 px mark cap (SPEC 11.4) shrinks that thickness out from under it.
 *
 * The end labels are measured, not guessed at, for the reason `radar`'s axis
 * labels are: a label pushed outside the frame is cropped by core's clip, and a
 * clipped label is worse than no label (SPEC 11.5).
 */
function fitDial(frame: Rect, plan: GaugePlan, ctx: LayoutContext): GaugeGeometry | undefined {
  const width = Math.max(0, finite(frame.width, 0));
  const height = Math.max(0, finite(frame.height, 0));
  if (width <= 0 || height <= 0) return undefined;

  const font = tickFont(ctx.theme);
  const gap = font.size * LABEL_GAP_RATIO;
  const widest = Math.max(
    finite(ctx.metrics.measure(plan.minText, font).width, 0),
    finite(ctx.metrics.measure(plan.maxText, font).width, 0),
  );
  const padX = gap + Math.min(widest, width * LABEL_WIDTH_SHARE);
  const padY = gap + font.size;
  const usableW = width - padX * 2;
  const usableH = height - padY * 2;
  if (usableW <= 0 || usableH <= 0) return undefined;

  const start = -plan.sweep / 2;
  const end = plan.sweep / 2;

  // Unit sector at radius 1: the centre, the two ends, and any cardinal the
  // sweep passes through — the only places a sector's extremes can occur.
  const xs: number[] = [0];
  const ys: number[] = [0];
  const sample = (angle: number): void => {
    xs.push(Math.sin(angle));
    ys.push(-Math.cos(angle));
  };
  sample(start);
  sample(end);
  for (const angle of CARDINALS) {
    if (angle >= start && angle <= end) sample(angle);
  }
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const boxW = x1 - x0;
  const boxH = y1 - y0;

  const fitW = boxW > 0 ? usableW / boxW : Number.POSITIVE_INFINITY;
  const fitH = boxH > 0 ? usableH / boxH : Number.POSITIVE_INFINITY;
  const outer = Math.min(fitW, fitH);
  if (!isFiniteNumber(outer) || outer <= 0) return undefined;

  // The band is the bar mark bent round a centre, so it takes the bar's cap.
  const band = Math.min(ctx.theme.marks.bar.maxThickness, outer * BAND_RADIUS_RATIO);
  const inner = Math.max(0, outer - band);

  return {
    cx: finite(frame.x, 0) + padX + (usableW - outer * boxW) / 2 - outer * x0,
    cy: finite(frame.y, 0) + padY + (usableH - outer * boxH) / 2 - outer * y0,
    outer,
    inner,
    start,
    end,
  };
}

function layoutGauge(
  encoded: EncodeResult<ArcMark>,
  frame: Rect,
  ctx: LayoutContext,
): ChartLayoutResult {
  const plan = planOf<ArcMark, GaugePlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];

  const dial = fitDial(frame, plan, ctx);
  if (dial === undefined) return { nodes, hits };

  const { theme } = ctx;
  const paints = rampPaints(theme);
  const fillColor = plan.band === undefined ? paints.fill : theme.status[plan.band.status];

  // ── The track ──────────────────────────────────────────────────────────────
  const trackPath = arcPath(dial.cx, dial.cy, dial.outer, dial.inner, dial.start, dial.end);
  if (trackPath.length > 0) {
    nodes.push({
      kind: 'path',
      id: ctx.ids.next('track'),
      cls: 'mdv-mark mdv-gauge-track',
      d: trackPath,
      fill: solid(paints.track),
    });
  }

  // ── The reading ────────────────────────────────────────────────────────────
  let markNodeId: string | undefined;
  let anchor: Point | undefined;
  if (plan.fraction !== null && plan.fraction > 0) {
    const end = dial.start + plan.sweep * plan.fraction;
    const d = arcPath(dial.cx, dial.cy, dial.outer, dial.inner, dial.start, end);
    if (d.length > 0) {
      markNodeId = ctx.ids.next('fill');
      nodes.push({
        kind: 'path',
        id: markNodeId,
        cls: 'mdv-mark mdv-mark-arc mdv-gauge-fill',
        d,
        fill: solid(fillColor),
      });
      anchor = polar(dial.cx, dial.cy, (dial.outer + dial.inner) / 2, (dial.start + end) / 2);
    }
  }

  nodes.push(...thresholdTicks(plan, dial, ctx));
  nodes.push(...endLabels(plan, dial, ctx));
  nodes.push(...centreText(plan, dial, frame, fillColor, ctx));

  // ── The hit target ─────────────────────────────────────────────────────────
  // Anchored on the filled arc when there is one, on the dial's own centre when
  // the reading is zero — a zero reading still has a readout to show.
  if (plan.value !== null) {
    const at = anchor ?? polar(dial.cx, dial.cy, (dial.outer + dial.inner) / 2, dial.start);
    const half = Math.max(theme.marks.marker.minDiameter, (dial.outer - dial.inner) / 2);
    hits.push(
      hitRegion({
        x: at.x - half,
        y: at.y - half,
        w: half * 2,
        h: half * 2,
        anchor: at,
        datumIndex: plan.datum,
        readout: [...plan.readoutRows],
        ...(markNodeId === undefined ? {} : { markNodeId }),
      }),
    );
  }

  return { nodes, hits };
}

/**
 * A boundary between two threshold bands.
 *
 * Drawn in the **surface color**, because that is what separates two touching
 * marks (SPEC 11.4: "the two spacers — white does the separating"). A darker
 * rule here would be data-weight ink that is not data.
 */
function thresholdTicks(plan: GaugePlan, dial: GaugeGeometry, ctx: LayoutContext): SceneNode[] {
  const nodes: SceneNode[] = [];
  const span = plan.max - plan.min;
  if (!(span > 0)) return nodes;
  const stroke = gridStroke(ctx.theme, 'axis');
  stroke.paint = solid(ctx.theme.tokens.surface);
  stroke.width = ctx.theme.marks.spacer.surfaceGap;

  for (let i = 1; i < plan.bands.length; i += 1) {
    const edge = plan.bands[i]?.from;
    if (edge === undefined || !isFiniteNumber(edge)) continue;
    const angle = dial.start + plan.sweep * clamp((edge - plan.min) / span, 0, 1);
    const from = polar(dial.cx, dial.cy, dial.inner, angle);
    const to = polar(dial.cx, dial.cy, dial.outer, angle);
    nodes.push({
      kind: 'line',
      id: ctx.ids.next('threshold'),
      cls: 'mdv-axis mdv-gauge-threshold',
      x1: px(from.x),
      y1: px(from.y),
      x2: px(to.x),
      y2: px(to.y),
      stroke: { ...stroke },
    });
  }
  return nodes;
}

/**
 * `min` and `max`, written at the two ends of the arc.
 *
 * The gauge's range is what makes its fraction mean anything, so these are the
 * dial's axis rather than decoration — and like every axis they wear a text
 * token, never the data colour (SPEC 11.5).
 */
function endLabels(plan: GaugePlan, dial: GaugeGeometry, ctx: LayoutContext): SceneNode[] {
  const { theme } = ctx;
  const font = tickFont(theme);
  const radius = dial.outer + font.size * LABEL_GAP_RATIO;
  const nodes: SceneNode[] = [];

  for (const [angle, text] of [
    [dial.start, plan.minText],
    [dial.end, plan.maxText],
  ] as const) {
    const at = polar(dial.cx, dial.cy, radius, angle);
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);
    nodes.push({
      kind: 'text',
      id: ctx.ids.next('end-label'),
      cls: 'mdv-label mdv-gauge-end-label',
      x: px(at.x),
      y: px(at.y),
      text,
      font,
      fill: solid(theme.tokens['text-muted']),
      anchor: sin > 0.01 ? 'start' : sin < -0.01 ? 'end' : 'middle',
      baseline: cos > 0.01 ? 'bottom' : cos < -0.01 ? 'top' : 'middle',
      // Range ends are ticks, and ticks set in tabular figures (SPEC 11.5).
      tabular: true,
      width: px(finite(ctx.metrics.measure(text, font).width, 0)),
    });
  }
  return nodes;
}

/**
 * The reading in the middle of the dial, and the band it landed in.
 *
 * The figure is a large standalone number, so it sets in **proportional** figures
 * — `tabular` is deliberately absent (SPEC 11.5, SPEC 8.13). The band beneath it
 * carries both a name and a shape, because a status colour never carries meaning
 * alone (SPEC 11.3.1, 12.5).
 */
function centreText(
  plan: GaugePlan,
  dial: GaugeGeometry,
  frame: Rect,
  fillColor: ColorString,
  ctx: LayoutContext,
): SceneNode[] {
  if (!plan.showValue) return [];
  const { theme } = ctx;
  const nodes: SceneNode[] = [];

  // The dial's box is centred in the frame by construction, so the frame's own
  // centre is the middle of the hole for every sweep.
  const cx = finite(frame.x, 0) + Math.max(0, finite(frame.width, 0)) / 2;
  const cy = finite(frame.y, 0) + Math.max(0, finite(frame.height, 0)) / 2;

  // Start from the hole and shrink to what fits: measure first, never clip
  // (SPEC 11.5).
  const target = Math.max(theme.type.fontSize, Math.min(dial.inner * 0.55, 48));
  const probe: Font = { family: theme.type.fontFamily, size: target, weight: 600 };
  const probeWidth = finite(ctx.metrics.measure(plan.valueText, probe).width, 0);
  const room = dial.inner * 1.6;
  const size =
    probeWidth > room && probeWidth > 0 ? Math.max(1, (target * room) / probeWidth) : target;
  const font: Font = { family: theme.type.fontFamily, size, weight: 600 };
  const width = finite(ctx.metrics.measure(plan.valueText, font).width, 0);

  nodes.push({
    kind: 'text',
    id: ctx.ids.next('value'),
    cls: 'mdv-label mdv-gauge-value',
    x: px(cx),
    y: px(cy),
    text: plan.valueText,
    font,
    fill: solid(theme.tokens['text-primary']),
    anchor: 'middle',
    baseline: 'middle',
    width: px(width),
  });

  if (plan.band === undefined) return nodes;

  // ── The band: icon + label, never hue alone (SPEC 11.3.1) ──────────────────
  const bandFont = labelFont(theme, theme.type.tickScale, 500);
  const bandWidth = finite(ctx.metrics.measure(plan.band.label, bandFont).width, 0);
  const iconR = bandFont.size * 0.35;
  const iconGap = bandFont.size * 0.4;
  const baseline = cy + size * 0.5 + bandFont.size;
  const left = cx - (bandWidth + iconR * 2 + iconGap) / 2;

  const shape = STATUS_SHAPE[plan.band.status];
  const iconX = left + iconR;
  const iconY = baseline - iconR;
  // A circle is a circle node, not a path of Béziers — the same split `scatter`
  // makes, so the two modules put the same marker on the page the same way.
  if (shape === 'circle') {
    nodes.push({
      kind: 'circle',
      id: ctx.ids.next('band-icon'),
      cls: 'mdv-gauge-band-icon',
      cx: px(iconX),
      cy: px(iconY),
      r: px(iconR),
      fill: solid(fillColor),
    });
  } else {
    const icon = shapePath(shape, iconX, iconY, iconR);
    if (icon.length > 0) {
      nodes.push({
        kind: 'path',
        id: ctx.ids.next('band-icon'),
        cls: 'mdv-gauge-band-icon',
        d: icon,
        fill: solid(fillColor),
      });
    }
  }
  nodes.push({
    kind: 'text',
    id: ctx.ids.next('band-label'),
    cls: 'mdv-label mdv-gauge-band-label',
    x: px(left + iconR * 2 + iconGap),
    y: px(baseline),
    text: plan.band.label,
    font: bandFont,
    // Text never wears the data colour (SPEC 11.5); the marker beside it carries
    // the status hue.
    fill: solid(theme.tokens['text-secondary']),
    anchor: 'start',
    baseline: 'alphabetic',
    width: px(bandWidth),
  });
  return nodes;
}

export default gaugeChart;

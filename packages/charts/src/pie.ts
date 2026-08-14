/**
 * `pie` / `donut` — parts of one whole (SPEC 8.5).
 *
 * **Use when** there are ≤ 6 parts, they sum to a meaningful whole, and the reader
 * needs "roughly what share", not precise comparison. Beyond six slices this
 * emits `MDV3050` (info) pointing at a horizontal bar chart, which answers the
 * same question better.
 *
 * Two rules shape the geometry:
 *
 * - **Small slices fold.** Anything below the `other` share (default 2 %) merges
 *   into a single "Other" slice, because a 0.3 % wedge is an unreadable sliver
 *   that still costs a palette slot and a legend row.
 * - **Small slices are not labelled.** `label: auto` places labels outside and
 *   suppresses them under 5 %; a label that will not fit is never clipped
 *   (SPEC 11.5).
 */

import type {
  ArcMark,
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
  SceneNode,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import type { SortMode } from './internal/types.js';
import { SORT_MODES } from './internal/types.js';
import { arcPath, polar, px } from './internal/geometry.js';
import { blockDiagnostic, missingChannel, unknownEnum } from './internal/diagnostics.js';
import {
  buildA11yTable,
  composeDescription,
  countPhrase,
  presentationOf,
  viewColumn,
} from './internal/a11y.js';
import { buildLegend } from './internal/series.js';
import { clamp, compareNumbers, finite, sum as sumOf } from './internal/num.js';
import {
  enumAttr,
  fractionOrPxAttr,
  numberAttr,
  rawAttr,
  recordAttr,
  stringAttr,
} from './internal/attrs.js';
import { expandTemplate, formatNumber } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { labelFont, seriesFill, solid } from './internal/paint.js';
import { planOf } from './internal/plan.js';
import {
  bindField,
  cell,
  cellNumber,
  channelFormat,
  findColumn,
  firstChannelOf,
  humaniseColumn,
} from './internal/table.js';

/** The default `labelFormat` of SPEC 8.5. */
const DEFAULT_LABEL_FORMAT = '{category}: {value:,.0f} ({percent:.0%})';

/** Slices under this share carry no label under `label: auto` (SPEC 8.5). */
const LABEL_SUPPRESS_SHARE = 0.05;

/** How labels are placed. */
type LabelMode = 'none' | 'outside' | 'inside' | 'auto';

const LABEL_MODES: readonly LabelMode[] = ['none', 'outside', 'inside', 'auto'];

/** One slice, resolved. */
interface Slice {
  series: SeriesDescriptor;
  /** Radians, in the scene convention: 0 at 12 o'clock, growing clockwise. */
  start: number;
  end: number;
  label: string;
  readout: ReadoutRow[];
  datum: number;
  fraction: number;
}

/** Everything `layout` needs. */
interface PiePlan {
  innerRadiusFraction: number;
  padAngle: number;
  labelMode: LabelMode;
  slices: Slice[];
  center: { title?: string; value?: string } | undefined;
}

const DEFAULT_PLAN: PiePlan = {
  innerRadiusFraction: 0,
  padAngle: (1 * Math.PI) / 180,
  labelMode: 'auto',
  slices: [],
  center: undefined,
};

type PieEncodeResult = PlannedEncodeResult<ArcMark, PiePlan>;

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'category',
    required: true,
    accepts: ['string', 'category', 'boolean', 'date', 'datetime', 'number', 'integer'],
    defaultScale: 'ordinal',
    doc: 'The identity of each slice. Also accepted as `x` or `label`.',
  },
  {
    name: 'value',
    required: true,
    accepts: ['number', 'integer', 'duration'],
    defaultScale: 'linear',
    doc: 'The magnitude each slice encodes. Also accepted as `y`.',
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

/** Build one of the two pie-family types. */
function createPieType(name: 'pie' | 'donut', defaultInner: number): ChartType<ArcMark> {
  return {
    name,
    level: 1,
    // The mark is the hit target; no crosshair, and the hovered slice lifts.
    family: 'mark',
    channels: CHANNELS,
    // A pie's entity is its slice, so colour is keyed on the category column,
    // not on a series (SPEC 11.2 rule 1).
    colorIdentityFields: (block) => {
      const field = firstChannelOf(block.encoding, ['category', 'x', 'label'])?.field;
      return field === undefined ? [] : [field];
    },
    defaultEncoding: {},
    defaults: {
      innerRadius: defaultInner,
      padAngle: 1,
      sort: 'desc',
      startAngle: -90,
      label: 'auto',
      other: 0.02,
    },
    schemaId: `https://mdv.dev/schema/1.0/block/${name}.json`,
    minWidth: 240,

    validate(block: ResolvedBlock, table: Table): Diagnostic[] {
      const diagnostics: Diagnostic[] = [];
      const categoryChannel = firstChannelOf(block.encoding, ['category', 'x', 'label']);
      const valueChannel = firstChannelOf(block.encoding, ['value', 'y']);

      if (categoryChannel?.field === undefined) {
        diagnostics.push(missingChannel(block, 'category', 'the identity of each slice'));
      } else if (
        findColumn(table, categoryChannel.field) === undefined &&
        table.fields.length > 0
      ) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`category\` names \`${categoryChannel.field}\`, which is not a column`,
          ),
        );
      }
      if (valueChannel?.field === undefined) {
        diagnostics.push(missingChannel(block, 'value', 'the magnitude each slice encodes'));
      }

      // A negative share has no meaning in a part-of-a-whole chart.
      const valueBound = bindField(table, valueChannel);
      if (valueBound !== undefined) {
        for (let row = 0; row < table.rows.length; row += 1) {
          const numeric = cellNumber(cell(table, row, valueBound.index));
          if (numeric !== null && numeric < 0) {
            diagnostics.push(
              blockDiagnostic(
                'MDV3001',
                block,
                'encode',
                `\`${valueBound.column.name}\` contains negative values`,
                'A slice cannot be a negative part of a whole. Use a bar chart, which can show values below a baseline.',
              ),
            );
            break;
          }
        }
      }
      return diagnostics;
    },

    encode(input: EncodeInput): EncodeResult<ArcMark> {
      return encodePie(input, defaultInner);
    },

    layout(encoded: EncodeResult<ArcMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
      return layoutPie(encoded, frame, ctx);
    },

    describe(input: DescribeInput<ArcMark>): string {
      const { encoded } = input;
      if (encoded.marks.length === 0)
        return `${name === 'donut' ? 'Donut' : 'Pie'} chart with no data.`;
      const largest = [...encoded.marks].sort((a, b) => compareNumbers(b.fraction, a.fraction))[0];
      const categoryChannel = firstChannelOf(input.block.encoding, ['category', 'x', 'label']);
      const categoryColumn = findColumn(input.table, categoryChannel?.field)?.column;
      // The measure is the `value` column, not `series[0].source` — for a pie
      // the series identity *is* the category, so reading the source here would
      // describe "revenue by quarter" as "quarter by quarter".
      const valueColumn = findColumn(
        input.table,
        firstChannelOf(input.block.encoding, ['value', 'y'])?.field,
      )?.column;
      const measure = valueColumn === undefined ? 'Share' : humaniseColumn(valueColumn);

      return composeDescription({
        chartKind: `${name === 'donut' ? 'Donut' : 'Pie'} chart`,
        ...(categoryColumn === undefined
          ? {}
          : { subject: `${measure} by ${humaniseColumn(categoryColumn).toLowerCase()}` }),
        scope: countPhrase(encoded.marks.length, 'slice'),
        ...(largest === undefined
          ? {}
          : {
              extreme: `Largest: ${largest.category} at ${formatNumber(largest.fraction, '.0%')}`,
            }),
      });
    },
  };
}

/** Shared encoder for `pie` and `donut`. */
function encodePie(input: EncodeInput, defaultInner: number): EncodeResult<ArcMark> {
  const { table, encoding, attrs, block } = input;
  const categoryChannel = firstChannelOf(encoding, ['category', 'x', 'label']);
  const valueChannel = firstChannelOf(encoding, ['value', 'y']);
  const categoryBound = bindField(table, categoryChannel);
  const valueBound = bindField(table, valueChannel);

  const report =
    (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
      input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
    };
  const sortMode: SortMode = enumAttr(
    attrs,
    'sort',
    SORT_MODES,
    'desc',
    report('sort', SORT_MODES, 'desc'),
  );
  const labelMode: LabelMode = enumAttr(
    attrs,
    'label',
    LABEL_MODES,
    'auto',
    report('label', LABEL_MODES, 'auto'),
  );
  const padAngleDegrees = numberAttr(attrs, 'padAngle', 1, 0, 30);
  const startAngleDegrees = numberAttr(attrs, 'startAngle', -90);
  const otherRaw = rawAttr(attrs, 'other');
  const otherThreshold = otherRaw === false ? 0 : numberAttr(attrs, 'other', 0.02, 0, 0.5);
  const labelTemplate = stringAttr(attrs, 'labelFormat') ?? DEFAULT_LABEL_FORMAT;
  const valueFormat = channelFormat(valueChannel, valueBound?.column);
  // `innerRadius` is a fraction of the outer radius; resolve it against 1 here
  // and multiply by the real radius in layout, which is the only place that
  // knows how big the frame is.
  const innerFraction = clamp(fractionOrPxAttr(attrs, 'innerRadius', 1, defaultInner), 0, 0.95);

  if (categoryBound === undefined || valueBound === undefined) {
    const empty: PieEncodeResult = {
      marks: [],
      series: [],
      scales: {},
      axes: [],
      a11yTable: buildA11yTable(table, [], attrs.title ?? 'Chart data', presentationOf(attrs)),
      state: { ...DEFAULT_PLAN, innerRadiusFraction: innerFraction, labelMode },
    };
    return empty;
  }

  // ── Gather slices, summing duplicate categories ───────────────────────────
  interface Bucket {
    key: string;
    label: string;
    value: number;
    datum: number;
  }
  const buckets: Bucket[] = [];
  const byKey = new Map<string, Bucket>();
  let droppedRows = 0;
  for (let row = 0; row < table.rows.length; row += 1) {
    const rawCategory = cell(table, row, categoryBound.index);
    if (rawCategory === null) continue;
    const key = rawCategory instanceof Date ? rawCategory.toISOString() : String(rawCategory);
    const numeric = cellNumber(cell(table, row, valueBound.index));
    if (numeric === null || numeric <= 0) {
      // A zero or negative slice has no angle; it belongs in the table view only.
      droppedRows += 1;
      continue;
    }
    const existing = byKey.get(key);
    if (existing === undefined) {
      const bucket: Bucket = { key, label: key, value: numeric, datum: row };
      byKey.set(key, bucket);
      buckets.push(bucket);
    } else {
      existing.value += numeric;
    }
  }

  const total = sumOf(buckets.map((bucket) => bucket.value));

  // ── Fold the small slices (SPEC 8.5 `other`) ──────────────────────────────
  let kept = buckets;
  let folded: Bucket[] = [];
  if (otherThreshold > 0 && total > 0) {
    kept = buckets.filter((bucket) => bucket.value / total >= otherThreshold);
    folded = buckets.filter((bucket) => bucket.value / total < otherThreshold);
  }

  // ── Order (SPEC 8.5 `sort`, default desc) ─────────────────────────────────
  const ordered = [...kept];
  if (sortMode !== 'none') {
    const direction = sortMode === 'asc' ? 1 : -1;
    const indexed = ordered.map((bucket, i) => ({ bucket, i }));
    indexed.sort((a, b) => {
      const byValue = compareNumbers(a.bucket.value, b.bucket.value) * direction;
      return byValue !== 0 ? byValue : a.i - b.i;
    });
    ordered.length = 0;
    ordered.push(...indexed.map((entry) => entry.bucket));
  }
  if (folded.length > 0) {
    // "Other" always sits last, whatever the sort: it is a remainder, not a rank.
    ordered.push({
      key: 'Other',
      label: 'Other',
      value: sumOf(folded.map((bucket) => bucket.value)),
      datum: folded[0]?.datum ?? 0,
    });
  }

  if (ordered.length > 6) {
    input.diagnostic(
      blockDiagnostic(
        'MDV3050',
        block,
        'encode',
        `${ordered.length} slices — more than the six a pie can be read at`,
        'A horizontal bar chart answers "which is biggest" and "by how much" far better past six parts.',
      ),
    );
  }

  // ── Angles ────────────────────────────────────────────────────────────────
  // The scene convention puts 0 at 12 o'clock, so the SPEC default of −90°
  // (12 o'clock in the conventional reading) is 0 here.
  const startAngle = ((startAngleDegrees + 90) * Math.PI) / 180;
  const padAngle = (padAngleDegrees * Math.PI) / 180;

  const marks: ArcMark[] = [];
  const series: SeriesDescriptor[] = [];
  const slices: Slice[] = [];
  let cursor = startAngle;

  for (const bucket of ordered) {
    const fraction = total > 0 ? bucket.value / total : 0;
    const sweep = fraction * Math.PI * 2;
    const isOther = bucket.key === 'Other' && folded.length > 0;
    const descriptor: SeriesDescriptor = {
      id: bucket.key,
      label: bucket.label,
      slot: input.palette.slot(bucket.key),
      color: input.palette.color(bucket.key),
      source: categoryBound.column.name,
      ...(isOther ? { isOther: true as const } : {}),
      ...(input.palette.patternDef(bucket.key) === undefined
        ? {}
        : { patternDef: input.palette.patternDef(bucket.key) as string }),
    };
    series.push(descriptor);

    const formattedValue = formatNumber(bucket.value, valueFormat);
    const labelText = expandTemplate(labelTemplate, {
      category: bucket.label,
      value: bucket.value,
      percent: fraction,
    });

    marks.push({
      mark: 'arc',
      seriesId: bucket.key,
      datum: bucket.datum,
      category: bucket.label,
      value: bucket.value,
      fraction,
      label: labelText,
    });
    slices.push({
      series: descriptor,
      start: cursor,
      end: cursor + sweep,
      label: labelText,
      datum: bucket.datum,
      fraction,
      readout: [
        readout(bucket.label, formattedValue, descriptor, true),
        readout('Share', formatNumber(fraction, '.1%')),
      ],
    });
    cursor += sweep;
  }

  const result: PieEncodeResult = {
    marks,
    series,
    scales: {},
    // A pie has no axes: there is nothing to tick (registry.ts).
    axes: [],
    a11yTable: buildA11yTable(
      table,
      [viewColumn(categoryBound), viewColumn(valueBound)].filter(
        (c): c is NonNullable<typeof c> => c !== undefined,
      ),
      attrs.title ?? attrs.caption ?? 'Chart data',
      presentationOf(attrs),
    ),
    state: {
      innerRadiusFraction: innerFraction,
      padAngle,
      labelMode,
      slices,
      center: readCenter(input, valueBound.index, total, valueFormat),
    },
  };
  if (droppedRows > 0) result.droppedRows = droppedRows;
  const legend = buildLegend(attrs, series, 'rect');
  if (legend !== undefined) result.legend = legend;
  return result;
}

/**
 * Resolve `center:` for a donut (SPEC 8.5).
 *
 * `value:` accepts a literal, or one of the aggregate spellings the spec's own
 * example uses (`sum(sessions)`). A general expression is `@mdv/core`'s
 * evaluator, not this module's, so anything it does not recognise is rendered
 * verbatim rather than guessed at.
 */
function readCenter(
  input: EncodeInput,
  valueColumn: number,
  total: number,
  format: string | undefined,
): { title?: string; value?: string } | undefined {
  const raw = rawAttr(input.attrs, 'center');
  if (raw === undefined) return undefined;
  if (typeof raw === 'string') return { value: raw };
  const record = recordAttr(input.attrs, 'center');
  if (record === undefined) return undefined;

  const out: { title?: string; value?: string } = {};
  if (typeof record['title'] === 'string') out.title = record['title'];
  const value = record['value'];
  if (typeof value === 'number') out.value = formatNumber(value, format);
  else if (typeof value === 'string')
    out.value = evaluateAggregate(value, input, valueColumn, total, format);
  return out;
}

/** Recognise `sum(field)`, `mean(field)`, `min`, `max`, `count`. */
function evaluateAggregate(
  expression: string,
  input: EncodeInput,
  valueColumn: number,
  total: number,
  format: string | undefined,
): string {
  const match = /^\s*(sum|mean|avg|min|max|count)\s*\(\s*([^)]*)\s*\)\s*$/i.exec(expression);
  if (match === null) return expression;
  const op = (match[1] ?? '').toLowerCase();
  const field = (match[2] ?? '').trim();
  const column = field === '' ? { index: valueColumn } : findColumn(input.table, field);
  if (column === undefined) return expression;

  const values: number[] = [];
  for (let row = 0; row < input.table.rows.length; row += 1) {
    const numeric = cellNumber(cell(input.table, row, column.index));
    if (numeric !== null) values.push(numeric);
  }
  if (values.length === 0) return formatNumber(op === 'count' ? 0 : total, format);
  switch (op) {
    case 'count':
      return formatNumber(values.length, ',.0f');
    case 'mean':
    case 'avg':
      return formatNumber(sumOf(values) / values.length, format);
    case 'min':
      return formatNumber(Math.min(...values), format);
    case 'max':
      return formatNumber(Math.max(...values), format);
    default:
      return formatNumber(sumOf(values), format);
  }
}

/** Shared layout for `pie` and `donut`. */
function layoutPie(
  encoded: EncodeResult<ArcMark>,
  frame: Rect,
  ctx: LayoutContext,
): ChartLayoutResult {
  const plan = planOf<ArcMark, PiePlan>(encoded, DEFAULT_PLAN);
  const nodes: SceneNode[] = [];
  const hits: ChartHitRegion[] = [];
  const labels: DirectLabel[] = [];

  const width = Math.max(0, finite(frame.width, 0));
  const height = Math.max(0, finite(frame.height, 0));
  if (width <= 0 || height <= 0 || plan.slices.length === 0) return { nodes, hits };

  const cx = finite(frame.x, 0) + width / 2;
  const cy = finite(frame.y, 0) + height / 2;
  const outer = Math.min(width, height) / 2;
  if (outer <= 0) return { nodes, hits };
  const inner = clamp(plan.innerRadiusFraction * outer, 0, outer);
  const theme = ctx.theme;

  for (const slice of plan.slices) {
    const sweep = slice.end - slice.start;
    if (!(sweep > 0)) continue;
    // The pad is the 2 px surface gap expressed angularly; a slice narrower than
    // the pad keeps a hairline of itself rather than inverting into nothing.
    const pad = Math.min(plan.padAngle, sweep * 0.5);
    const start = slice.start + pad / 2;
    const end = slice.end - pad / 2;
    const d = arcPath(cx, cy, outer, inner, start, end);
    if (d.length === 0) continue;

    const nodeId = ctx.ids.next('slice');
    nodes.push({
      kind: 'path',
      id: nodeId,
      cls: 'mdv-mark mdv-mark-arc',
      d,
      fill: seriesFill(slice.series),
    });

    const midAngle = (start + end) / 2;
    const anchor = polar(cx, cy, (outer + inner) / 2, midAngle);
    // The hit rectangle bounds the slice's mid-arc neighbourhood; core grows it
    // to the 24 px minimum, so a thin slice is still reachable.
    const half = Math.max(theme.marks.marker.minDiameter, (outer - inner) / 2);
    hits.push(
      hitRegion({
        x: anchor.x - half,
        y: anchor.y - half,
        w: half * 2,
        h: half * 2,
        anchor,
        datumIndex: slice.datum,
        seriesId: slice.series.id,
        readout: slice.readout,
        markNodeId: nodeId,
      }),
    );

    if (plan.labelMode === 'none') continue;
    // `auto` suppresses labels under 5 %: a wedge that thin cannot carry text,
    // and the legend plus the table view already carry the value (SPEC 8.5).
    if (plan.labelMode === 'auto' && slice.fraction < LABEL_SUPPRESS_SHARE) continue;
    const insideLabel = plan.labelMode === 'inside';
    const labelAnchor = insideLabel ? anchor : polar(cx, cy, outer, midAngle);
    const label: DirectLabel = {
      x: labelAnchor.x,
      y: labelAnchor.y,
      text: slice.label,
      placement: insideLabel ? 'inside' : 'outside',
      // Bigger slices win the space when labels compete (SPEC 11.5).
      priority: slice.fraction * 100,
      seriesId: slice.series.id,
      datum: slice.datum,
    };
    if (insideLabel) label.insideFill = slice.series.color;
    labels.push(label);
  }

  // ── Donut centre content (SPEC 8.5 `center`) ──────────────────────────────
  if (plan.center !== undefined && inner > 0) {
    const titleFont = labelFont(theme, theme.type.tickScale);
    const valueFont = labelFont(theme, theme.type.titleScale, 600);
    const hasTitle = plan.center.title !== undefined && plan.center.title !== '';
    const hasValue = plan.center.value !== undefined && plan.center.value !== '';
    const titleY = hasValue ? cy - valueFont.size * 0.35 : cy;
    if (hasTitle) {
      const text = plan.center.title ?? '';
      nodes.push({
        kind: 'text',
        cls: 'mdv-center-title',
        x: px(cx),
        y: px(titleY),
        text,
        font: titleFont,
        fill: solid(theme.tokens['text-secondary']),
        anchor: 'middle',
        baseline: 'bottom',
        width: px(ctx.metrics.measure(text, titleFont).width),
      });
    }
    if (hasValue) {
      const text = plan.center.value ?? '';
      nodes.push({
        kind: 'text',
        cls: 'mdv-center-value',
        x: px(cx),
        y: px(hasTitle ? cy + valueFont.size * 0.45 : cy),
        text,
        font: valueFont,
        // A large standalone figure uses proportional figures (SPEC 11.5).
        fill: solid(theme.tokens['text-primary']),
        anchor: 'middle',
        baseline: hasTitle ? 'alphabetic' : 'middle',
        width: px(ctx.metrics.measure(text, valueFont).width),
      });
    }
  }

  return labels.length > 0 ? { nodes, hits, labels } : { nodes, hits };
}

/** `pie` (SPEC 8.5). */
export const pieChart: ChartType<ArcMark> = createPieType('pie', 0);

/** `donut` (SPEC 8.5): a pie with a 0.6 inner radius and optional centre content. */
export const donutChart: ChartType<ArcMark> = createPieType('donut', 0.6);

export default pieChart;

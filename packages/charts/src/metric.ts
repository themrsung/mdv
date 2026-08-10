/**
 * `metric` — the stat tile (SPEC 8.13).
 *
 * > The correct form when the answer is **one number**. A chart of a single value
 * > is decoration.
 *
 * The contract, verbatim from SPEC 8.13: `label` in sentence case with no
 * trailing colon; `value` auto-compacted in the UI sans with **proportional**
 * figures; `delta` signed and always naming its comparison period, colored by
 * direction × `goodDirection`; `trend` an optional 12-point sparkline in the
 * de-emphasis hue with the current period accented.
 *
 * The delta is the one place a chart type may color text by data, and it is
 * status color (SPEC 11.3.1), never a categorical slot — a KPI that went the
 * wrong way is not "series 4".
 */

import type {
  A11yTable,
  ChartHitRegion,
  ChartLayoutResult,
  ChartType,
  ColorString,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  Font,
  LayoutContext,
  Mark,
  Rect,
  ResolvedBlock,
  SceneNode,
  Table,
  TextMark,
} from '@mdv/core';
import type { PlannedEncodeResult } from './internal/plan.js';
import type { Point } from './internal/geometry.js';
import { blockDiagnostic, unknownEnum } from './internal/diagnostics.js';
import { cell, cellNumber, findColumn, firstChannelOf } from './internal/table.js';
import { finite, isFiniteNumber, sum as sumOf } from './internal/num.js';
import { curvePath, px } from './internal/geometry.js';
import { enumAttr, numberAttr, listAttr, rawAttr, stringAttr } from './internal/attrs.js';
import { formatNumber } from './internal/format.js';
import { hitRegion, readout } from './internal/hit.js';
import { labelFont, lineStroke, solid } from './internal/paint.js';
import { planOf } from './internal/plan.js';
import { presentationOf } from './internal/a11y.js';

/** The sparkline keeps at most twelve periods (SPEC 8.13). */
const TREND_POINTS = 12;

/** `size` (SPEC 8.13): exactly one hero figure per view, ≥ 48 px. */
type TileSize = 'normal' | 'hero';
const TILE_SIZES: readonly TileSize[] = ['normal', 'hero'];

/** `goodDirection` (SPEC 8.13). */
type GoodDirection = 'up' | 'down' | 'none';
const GOOD_DIRECTIONS: readonly GoodDirection[] = ['up', 'down', 'none'];

/** Everything `layout` needs. */
interface MetricPlan {
  label: string | undefined;
  value: string;
  delta: { text: string; tone: 'good' | 'critical' | 'neutral' } | undefined;
  deltaOf: string | undefined;
  trend: number[];
  size: TileSize;
  /** The readout shown on keyboard focus, identical to hover (SPEC 12.4). */
  readoutRows: ReturnType<typeof readout>[];
}

const DEFAULT_PLAN: MetricPlan = {
  label: undefined,
  value: '—',
  delta: undefined,
  deltaOf: undefined,
  trend: [],
  size: 'normal',
  readoutRows: [],
};

type MetricEncodeResult = PlannedEncodeResult<Mark, MetricPlan>;

/** `metric` (SPEC 8.13). */
export const metricChart: ChartType<Mark> = {
  name: 'metric',
  level: 1,
  // A stat tile has no readout layer: the number is already the whole message.
  family: 'none',
  channels: [
    {
      name: 'value',
      required: false,
      accepts: ['number', 'integer', 'duration'],
      constant: true,
      doc: 'The figure, as a literal or a field.',
    },
    {
      name: 'label',
      required: false,
      accepts: ['string', 'category'],
      constant: true,
      doc: 'The sentence-case caption above the figure.',
    },
  ],
  defaultEncoding: {},
  defaults: { goodDirection: 'up', size: 'normal' },
  schemaId: 'https://mdv.dev/schema/1.0/block/metric.json',
  // A tile is legible far below a plot's minimum: it is one number.
  minWidth: 120,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];
    const hasLiteral = rawAttr(block.attrs, 'value') !== undefined;
    const channel = firstChannelOf(block.encoding, ['value', 'y']);
    if (!hasLiteral && channel?.field === undefined) {
      diagnostics.push(
        blockDiagnostic(
          'MDV3000',
          block,
          'encode',
          '`value` is required by `metric` and is not bound',
          'Give the tile a number: `value: 1284000`, or bind it to a column with `value: revenue`.',
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
    return diagnostics;
  },

  encode(input: EncodeInput): EncodeResult<Mark> {
    const { attrs, block, table } = input;
    const report =
      (attribute: string, allowed: readonly string[], fallback: string) => (given: string) => {
        input.diagnostic(unknownEnum(block, attribute, given, allowed, fallback));
      };

    // `format` on a `metric` is a *number* format (`"$~s"`, SPEC 8.13), not the
    // data-section syntax that `BlockAttrs.format` is typed as (SPEC 6.2). The
    // two share a name in the attribute bag, so this reads the raw string and
    // never touches the typed field. Reported upstream; see the summary.
    const format = stringAttr(attrs, 'format');
    const numericValue = resolveValue(input);
    const valueText = numericValue === undefined ? '—' : formatNumber(numericValue, format);

    // `label` in sentence case with no trailing colon (SPEC 8.13).
    const rawLabel = stringAttr(attrs, 'label') ?? attrs.title;
    const label = rawLabel === undefined ? undefined : rawLabel.replace(/\s*:\s*$/, '');

    const goodDirection = enumAttr(
      attrs,
      'goodDirection',
      GOOD_DIRECTIONS,
      'up',
      report('goodDirection', GOOD_DIRECTIONS, 'up'),
    );
    const size = enumAttr(
      attrs,
      'size',
      TILE_SIZES,
      'normal',
      report('size', TILE_SIZES, 'normal'),
    );
    const deltaValue =
      rawAttr(attrs, 'delta') === undefined ? undefined : numberAttr(attrs, 'delta', Number.NaN);
    const deltaOf = stringAttr(attrs, 'deltaOf');

    let delta: MetricPlan['delta'];
    if (deltaValue !== undefined && Number.isFinite(deltaValue)) {
      const deltaFormat =
        stringAttr(attrs, 'deltaFormat') ?? (Math.abs(deltaValue) <= 1 ? '+.1%' : '+,.0f');
      delta = {
        text: formatNumber(deltaValue, deltaFormat),
        tone: toneFor(deltaValue, goodDirection),
      };
    }
    if (deltaValue !== undefined && Number.isFinite(deltaValue) && deltaOf === undefined) {
      // A delta that does not name its comparison period is not interpretable.
      input.diagnostic(
        blockDiagnostic(
          'MDV1501',
          block,
          'encode',
          '`delta` has no `deltaOf`; the comparison period is unnamed',
          'Add `deltaOf: vs. last month` — a signed percentage means nothing without the period it compares against.',
        ),
      );
    }

    const trend = resolveTrend(input);

    const marks: TextMark[] = [
      { mark: 'text', seriesId: '', datum: 0, x: 0, y: 0, text: valueText },
    ];
    const rows = [readout(label ?? 'Value', valueText, undefined, true)];
    if (delta !== undefined) {
      rows.push(readout(deltaOf ?? 'Change', delta.text));
    }

    const result: MetricEncodeResult = {
      marks,
      series: [],
      scales: {},
      // A stat tile has no axes: there is no domain to tick.
      axes: [],
      a11yTable: metricTable(
        label,
        valueText,
        delta?.text,
        deltaOf,
        trend,
        presentationOf(attrs),
        table,
      ),
      state: {
        label,
        value: valueText,
        delta,
        deltaOf,
        trend,
        size,
        readoutRows: rows,
      },
    };
    return result;
  },

  layout(encoded: EncodeResult<Mark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    const plan = planOf<Mark, MetricPlan>(encoded, DEFAULT_PLAN);
    const nodes: SceneNode[] = [];
    const hits: ChartHitRegion[] = [];
    const theme = ctx.theme;

    const x = finite(frame.x, 0);
    const y = finite(frame.y, 0);
    const width = Math.max(0, finite(frame.width, 0));
    const height = Math.max(0, finite(frame.height, 0));
    if (width <= 0 || height <= 0) return { nodes, hits };

    const labelFontSpec = labelFont(theme, theme.type.tickScale);
    // A hero figure is ≥ 48 px (SPEC 8.13); a normal tile scales with the theme.
    const heroSize = Math.max(48, theme.type.fontSize * theme.type.titleScale * 1.6);
    const normalSize = Math.max(theme.type.fontSize * theme.type.titleScale * 1.2, 20);
    const figureSize = plan.size === 'hero' ? heroSize : normalSize;
    // Large standalone figures use **proportional** figures, not tabular
    // (SPEC 11.5, SPEC 8.13) — so `tabular` is deliberately left off below.
    const figureFont: Font = { family: theme.type.fontFamily, size: figureSize, weight: 600 };
    const deltaFont = labelFont(theme, theme.type.tickScale, 500);

    const lineGap = 4;
    const trendHeight = plan.trend.length > 1 ? Math.min(28, Math.max(16, height * 0.22)) : 0;
    let cursor = y;

    if (plan.label !== undefined && plan.label !== '') {
      const metrics = ctx.metrics.measure(plan.label, labelFontSpec);
      cursor += metrics.ascent;
      nodes.push({
        kind: 'text',
        cls: 'mdv-metric-label',
        x: px(x),
        y: px(cursor),
        text: plan.label,
        font: labelFontSpec,
        fill: solid(theme.tokens['text-secondary']),
        anchor: 'start',
        baseline: 'alphabetic',
        width: px(metrics.width),
      });
      cursor += metrics.descent + lineGap;
    }

    const figureMetrics = ctx.metrics.measure(plan.value, figureFont);
    cursor += figureMetrics.ascent;
    nodes.push({
      kind: 'text',
      cls: 'mdv-metric-value',
      x: px(x),
      y: px(cursor),
      text: plan.value,
      font: figureFont,
      fill: solid(theme.tokens['text-primary']),
      anchor: 'start',
      baseline: 'alphabetic',
      width: px(figureMetrics.width),
    });
    const figureRight = x + figureMetrics.width;
    const figureBaseline = cursor;
    cursor += figureMetrics.descent;

    if (plan.delta !== undefined) {
      const text =
        plan.deltaOf === undefined ? plan.delta.text : `${plan.delta.text} ${plan.deltaOf}`;
      const metrics = ctx.metrics.measure(text, deltaFont);
      const fitsBeside = figureRight + 8 + metrics.width <= x + width;
      const deltaX = fitsBeside ? figureRight + 8 : x;
      const deltaY = fitsBeside ? figureBaseline : cursor + metrics.ascent + lineGap;
      nodes.push({
        kind: 'text',
        cls: 'mdv-metric-delta',
        x: px(deltaX),
        y: px(deltaY),
        text,
        font: deltaFont,
        fill: solid(deltaColor(theme.status, plan.delta.tone, theme.tokens['text-secondary'])),
        anchor: 'start',
        baseline: 'alphabetic',
        width: px(metrics.width),
      });
      if (!fitsBeside) cursor = deltaY + metrics.descent;
    }

    // ── Trend sparkline (SPEC 8.13) ───────────────────────────────────────────
    if (trendHeight > 0) {
      const top = Math.max(cursor + lineGap, y + height - trendHeight);
      const points = sparklinePoints(plan.trend, x, top, width, trendHeight);
      if (points.length > 1) {
        const d = curvePath(points, 'linear');
        if (d.length > 0) {
          nodes.push({
            kind: 'path',
            cls: 'mdv-metric-trend',
            d,
            // The de-emphasis hue: the sparkline is context for the figure, not
            // a second chart competing with it.
            stroke: lineStroke(
              theme,
              theme.tokens['text-muted'],
              Math.max(1, theme.marks.line.width - 0.5),
            ),
          });
        }
        const current = points[points.length - 1];
        if (current !== undefined) {
          // The current period is accented; the rest of the trend is recessive.
          nodes.push({
            kind: 'circle',
            cls: 'mdv-metric-trend-current',
            cx: px(current.x),
            cy: px(current.y),
            r: px(Math.max(2, theme.marks.marker.minDiameter / 4)),
            fill: solid(theme.tokens['text-primary']),
          });
        }
      }
    }

    hits.push(
      hitRegion({
        x,
        y,
        w: width,
        h: height,
        datumIndex: 0,
        readout: plan.readoutRows,
      }),
    );

    return { nodes, hits };
  },

  describe(input: DescribeInput<Mark>): string {
    const plan = planOf<Mark, MetricPlan>(input.encoded, DEFAULT_PLAN);
    const parts: string[] = ['Stat tile.'];
    parts.push(plan.label === undefined ? `Value ${plan.value}.` : `${plan.label}: ${plan.value}.`);
    if (plan.delta !== undefined) {
      const direction =
        plan.delta.tone === 'neutral'
          ? 'changed by'
          : plan.delta.tone === 'good'
            ? 'improved by'
            : 'worsened by';
      parts.push(
        `${direction} ${plan.delta.text}${plan.deltaOf === undefined ? '' : ` ${plan.deltaOf}`}.`,
      );
    }
    if (plan.trend.length > 1) parts.push(`Trend over ${plan.trend.length} periods.`);
    return parts.join(' ');
  },
};

/** Resolve the figure: a literal, a column's latest value, or an aggregate. */
function resolveValue(input: EncodeInput): number | undefined {
  const raw = rawAttr(input.attrs, 'value');
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;

  const channel = firstChannelOf(input.encoding, ['value', 'y']);
  const field = channel?.field ?? (typeof raw === 'string' ? raw : undefined);
  if (field === undefined) return undefined;

  const aggregate = /^\s*(sum|mean|avg|min|max|count|last|first)\s*\(\s*([^)]*)\s*\)\s*$/i.exec(
    field,
  );
  const columnName = aggregate === null ? field : (aggregate[2] ?? '').trim();
  const found = findColumn(input.table, columnName);
  if (found === undefined) {
    const numeric = Number(field);
    return Number.isFinite(numeric) ? numeric : undefined;
  }

  const values: number[] = [];
  for (let row = 0; row < input.table.rows.length; row += 1) {
    const numeric = cellNumber(cell(input.table, row, found.index));
    if (numeric !== null) values.push(numeric);
  }
  if (values.length === 0) return undefined;

  const op =
    aggregate === null ? (channel?.aggregate ?? 'last') : (aggregate[1] ?? 'last').toLowerCase();
  switch (op) {
    case 'sum':
      return sumOf(values);
    case 'mean':
    case 'avg':
      return sumOf(values) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
    case 'count':
      return values.length;
    case 'first':
      return values[0];
    // A KPI without an explicit aggregate means "where it stands now".
    default:
      return values[values.length - 1];
  }
}

/**
 * Resolve `trend:` — an inline list, or the tail of a bound column.
 *
 * The string case is settled *first*. `listAttr` wraps a scalar into a
 * one-element list, so testing the list before the string makes `trend: revenue`
 * look like a one-point sparkline of `NaN` and silently drops the column.
 */
function resolveTrend(input: EncodeInput): number[] {
  const field = stringAttr(input.attrs, 'trend');
  if (field === undefined) {
    const inline: number[] = [];
    for (const entry of listAttr(input.attrs, 'trend')) {
      const numeric = typeof entry === 'number' ? entry : Number(entry);
      if (Number.isFinite(numeric)) inline.push(numeric);
    }
    return inline.slice(-TREND_POINTS);
  }

  const found = findColumn(input.table, field);
  if (found === undefined) return [];
  const values: number[] = [];
  for (let row = 0; row < input.table.rows.length; row += 1) {
    const numeric = cellNumber(cell(input.table, row, found.index));
    if (numeric !== null) values.push(numeric);
  }
  return values.slice(-TREND_POINTS);
}

/** Direction × `goodDirection` (SPEC 8.13). */
function toneFor(delta: number, goodDirection: GoodDirection): 'good' | 'critical' | 'neutral' {
  if (delta === 0 || goodDirection === 'none') return 'neutral';
  const rose = delta > 0;
  if (goodDirection === 'up') return rose ? 'good' : 'critical';
  return rose ? 'critical' : 'good';
}

/** The status color for a delta; neutral deltas stay in a text token. */
function deltaColor(
  status: Readonly<Record<'good' | 'warning' | 'serious' | 'critical', ColorString>>,
  tone: 'good' | 'critical' | 'neutral',
  neutral: ColorString,
): ColorString {
  if (tone === 'good') return status.good;
  if (tone === 'critical') return status.critical;
  return neutral;
}

/** Lay the sparkline out inside its strip, flat-lining a constant series. */
function sparklinePoints(
  values: readonly number[],
  x: number,
  y: number,
  width: number,
  height: number,
): Point[] {
  const usable = values.filter(isFiniteNumber);
  if (usable.length === 0) return [];
  let lo = usable[0] ?? 0;
  let hi = lo;
  for (const value of usable) {
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  const span = hi - lo;
  const step = usable.length > 1 ? width / (usable.length - 1) : 0;
  return usable.map((value, i) => ({
    x: x + step * i,
    // A constant series draws a flat line through the middle, not a divide-by-zero.
    y: span === 0 ? y + height / 2 : y + height - ((value - lo) / span) * height,
  }));
}

/** The table view for a tile: the figure, its delta, and the trend it carries. */
function metricTable(
  label: string | undefined,
  value: string,
  delta: string | undefined,
  deltaOf: string | undefined,
  trend: readonly number[],
  presentation: A11yTable['presentation'],
  table: Table,
): A11yTable {
  const rows: string[][] = [[label ?? 'Value', value]];
  if (delta !== undefined) rows.push([deltaOf ?? 'Change', delta]);
  trend.forEach((point, index) => {
    rows.push([`Period ${index + 1}`, formatNumber(point)]);
  });
  return {
    caption: label ?? 'Metric',
    columns: [
      { name: 'Measure', type: 'string', align: 'left' },
      { name: 'Value', type: table.fields[0]?.type ?? 'number', align: 'right' },
    ],
    rows,
    presentation,
  };
}

export default metricChart;

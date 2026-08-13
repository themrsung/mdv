/**
 * `ohlc` and `ohlcv` — price action per period (SPEC 8.10, 8.11).
 *
 * Four numbers per period, drawn as one mark: the body spans open→close, the
 * wick spans low→high. **Direction is encoded twice** — by color *and* by body
 * fill (SPEC 8.10 rendering notes) — so the chart survives CVD and grayscale
 * print, which red/green alone does not. The up/down colors come from the
 * status palette (SPEC 11.3.1), never from a categorical slot: a rising day is
 * not "series 1".
 *
 * `gaps: collapse` is the default and the reason the x scale is ordinal: a
 * weekend is not two days of flat price, it is no observation at all, and
 * painting it as empty space is the single most common complaint about
 * financial charts. The axis still carries real dates, because collapsing the
 * *scale* must not collapse the *labels*.
 *
 * `ohlcv` adds a volume panel. Price and volume are **stacked panels sharing one
 * x-axis** (SPEC 8.11) — never a second y-axis on the same frame, which is the
 * dual-axis anti-pattern (SPEC 7.3.1) wearing its most respectable disguise.
 * Extra panels (`rsi`, `macd`) stack the same way, so this file has one panel
 * mechanism rather than a special case for volume.
 *
 * Overlays (SPEC 8.11.1) are computed here, not by the author: the formulas are
 * fixed by the spec precisely so that two readers draw the same line.
 */

import type {
  A11yTable,
  AxisModel,
  BlockAttrs,
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
  LayoutContext,
  OhlcMark,
  ReadoutRow,
  Rect,
  ResolvedBlock,
  Scale,
  SceneNode,
  ScaleInput,
  SequentialPalette,
  SeriesDescriptor,
  Table,
  Theme,
} from '@mdv/core';
import type { Point } from './internal/geometry.js';
import type { PlannedEncodeResult } from './internal/plan.js';
import {
  buildA11yTable,
  composeDescription,
  countPhrase,
  presentationOf,
  viewColumn,
} from './internal/a11y.js';
import {
  boolAttr,
  colorAttr,
  enumAttr,
  listAttr,
  numberAttr,
  rawAttr,
  stringAttr,
} from './internal/attrs.js';
import { axisSpecFor, isDegenerateFrame, makeAxis, rangeToFrame } from './internal/cartesian.js';
import { blockDiagnostic, incompatibleField, missingChannel } from './internal/diagnostics.js';
import { extentOf, resolveDomain } from './internal/domain.js';
import { formatNumber, formatValue } from './internal/format.js';
import { areaPath, lineTo, moveTo, px } from './internal/geometry.js';
import { hitRegion, readout } from './internal/hit.js';
import { isFiniteNumber } from './internal/num.js';
import { chromeStroke, lineStroke, solid, tickFont } from './internal/paint.js';
import { planOf } from './internal/plan.js';
import {
  createBandScale,
  createContinuousScale,
  createTimeScale,
  setScaleRange,
} from './internal/scale.js';
import {
  cell,
  cellNumber,
  cellScaleInput,
  channelFormat,
  findColumn,
  firstChannel,
  humaniseColumn,
} from './internal/table.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shape
// ─────────────────────────────────────────────────────────────────────────────

const CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: true,
    accepts: ['date', 'datetime', 'string', 'category', 'number', 'integer'],
    defaultScale: 'band',
    doc: 'The period each bar covers. Also accepted as the `date` or `time` attribute.',
  },
];

/** Field-name spellings auto-detected when the attribute is omitted (SPEC 8.10). */
const PRICE_ALIASES = {
  open: ['open', 'o'],
  high: ['high', 'h'],
  low: ['low', 'l'],
  close: ['close', 'c'],
} as const;
const VOLUME_ALIASES = ['volume', 'vol', 'v'] as const;

/** SPEC 8.10: the body is capped so a four-point series does not draw slabs. */
const MAX_BODY_WIDTH = 24;
/** Fraction of the slot the body occupies; the rest is the gutter between bars. */
const BODY_FRACTION = 0.7;
/** Below this the price panel has nothing left to say, so panels give way. */
const MIN_PRICE_PANEL = 60;
const MIN_PANEL_HEIGHT = 24;
/** Panels may not take more of the block than the price they annotate. */
const MAX_PANEL_SHARE = 0.6;

type OhlcStyle = 'candle' | 'bar' | 'hlc';
type GapMode = 'collapse' | 'preserve';

/** One period, already read out of the table and validated. */
interface Period {
  readonly x: ScaleInput;
  readonly label: string;
  readonly row: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number | undefined;
  readonly direction: 'up' | 'down' | 'flat';
}

/** A computed overlay, ready to draw against the price scale (SPEC 8.11.1). */
type OverlayPlot =
  | {
      readonly kind: 'line';
      readonly label: string;
      readonly color: ColorString;
      readonly dash: readonly number[] | undefined;
      readonly values: readonly (number | undefined)[];
    }
  | {
      readonly kind: 'band';
      readonly label: string;
      readonly color: ColorString;
      readonly upper: readonly (number | undefined)[];
      readonly lower: readonly (number | undefined)[];
    };

/** A stacked panel below the price panel (SPEC 8.11.2). */
interface PanelPlot {
  readonly kind: 'volume' | 'rsi' | 'macd';
  readonly label: string;
  /** `0.25`, `"20%"` or `"80"` — resolved against the block height at layout. */
  readonly height: unknown;
  readonly domain: readonly [number, number];
  readonly format: string | undefined;
  /** Volume and MACD histogram bars, in period order. */
  readonly bars: readonly (number | undefined)[];
  /** `true` when bars take the period's up/down color rather than one fill. */
  readonly barsByDirection: boolean;
  /** The single fill for the bars when `barsByDirection` is false (`volumeColor`). */
  readonly fill?: ColorString;
  readonly lines: readonly {
    readonly label: string;
    readonly color: ColorString;
    readonly dash: readonly number[] | undefined;
    readonly values: readonly (number | undefined)[];
  }[];
  /** Horizontal guides, e.g. RSI 30/70. */
  readonly guides: readonly number[];
}

/** Everything layout needs that the scales and marks do not already carry. */
interface OhlcPlan {
  readonly style: OhlcStyle;
  readonly hollow: boolean;
  readonly wickWidth: number;
  readonly bodyWidth: number | undefined;
  readonly gaps: GapMode;
  readonly up: ColorString;
  readonly down: ColorString;
  readonly periods: readonly Period[];
  readonly overlays: readonly OverlayPlot[];
  readonly panels: readonly PanelPlot[];
  readonly priceFormat: string | undefined;
  readonly measure: string;
  readonly category: string | undefined;
}

const DEFAULT_PLAN: OhlcPlan = {
  style: 'candle',
  hollow: false,
  wickWidth: 1,
  bodyWidth: undefined,
  gaps: 'collapse',
  up: '#1a7f37' as ColorString,
  down: '#d1242f' as ColorString,
  periods: [],
  overlays: [],
  panels: [],
  priceFormat: undefined,
  measure: 'Price',
  category: undefined,
};

type OhlcEncodeResult = PlannedEncodeResult<OhlcMark, OhlcPlan>;

// ─────────────────────────────────────────────────────────────────────────────
// Attributes
// ─────────────────────────────────────────────────────────────────────────────

/** Read one key out of a list item, which arrives as `unknown` from YAML. */
function itemOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function itemString(item: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = item[key];
  return typeof value === 'string' ? value : undefined;
}

function itemNumber(
  item: Readonly<Record<string, unknown>>,
  key: string,
  fallback: number,
): number {
  const value = item[key];
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/** A period count is at least 1 and never fractional. */
function periodOf(item: Readonly<Record<string, unknown>>, fallback: number): number {
  return Math.max(1, Math.round(itemNumber(item, 'period', fallback)));
}

/**
 * A dimension attribute: a fraction of the reference, a percentage, or px.
 *
 * Mirrors `fractionOrPxAttr` for values that arrive inside a list item rather
 * than as a named attribute (SPEC 8.5's rule, applied to `height` in `panels`).
 */
function resolveDimension(value: unknown, reference: number, fallbackFraction: number): number {
  const ref = isFiniteNumber(reference) && reference > 0 ? reference : 0;
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.endsWith('%')) {
      const percent = Number(text.slice(0, -1));
      if (Number.isFinite(percent)) return (percent / 100) * ref;
    }
    const numeric = Number(text);
    if (Number.isFinite(numeric)) return numeric > 1 ? numeric : numeric * ref;
  }
  if (isFiniteNumber(value)) return value > 1 ? value : value * ref;
  return fallbackFraction * ref;
}

/** The price format: `precision` wins, then the close column's own format. */
function priceFormatOf(attrs: BlockAttrs, column: Column | undefined): string | undefined {
  const raw = rawAttr(attrs, 'precision');
  if (raw !== undefined) {
    const digits = Math.max(0, Math.min(10, Math.round(numberAttr(attrs, 'precision', 2, 0, 10))));
    return `,.${digits}f`;
  }
  return column?.format;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fields
// ─────────────────────────────────────────────────────────────────────────────

interface BoundColumn {
  readonly column: Column;
  readonly index: number;
}

/**
 * Resolve one price field: the attribute if the author named it, otherwise the
 * first column whose name matches a documented spelling (SPEC 8.10).
 *
 * Auto-detection is a convenience, not a guess: `o/h/l/c` and their long forms
 * are the only names tried, and a table without them reports `MDV3000` rather
 * than plotting some other numeric column that happened to be nearby.
 */
function resolveField(
  table: Table,
  attrs: BlockAttrs,
  key: string,
  aliases: readonly string[],
): { readonly bound: BoundColumn | undefined; readonly requested: string | undefined } {
  const named = stringAttr(attrs, key);
  if (named !== undefined) {
    const found = findColumn(table, named);
    return {
      bound: found === undefined ? undefined : { column: found.column, index: found.index },
      requested: named,
    };
  }
  for (const alias of aliases) {
    const found = columnNamed(table, alias);
    if (found !== undefined) return { bound: found, requested: undefined };
  }
  return { bound: undefined, requested: undefined };
}

/**
 * Locate a column by case-insensitive name.
 *
 * Auto-detection only: an explicit `close: Close` attribute goes through
 * {@link findColumn} and stays case-sensitive, because SPEC 6.1.2 makes field
 * references exact and silently matching `close` to `CLOSE` there would hide a
 * typo. Sniffing for a conventional spelling is the one place where `Close`,
 * `close` and `CLOSE` are all obviously the same column.
 */
function columnNamed(table: Table, name: string): BoundColumn | undefined {
  const wanted = name.toLowerCase();
  for (let index = 0; index < table.fields.length; index += 1) {
    const column = table.fields[index];
    if (column !== undefined && column.name.toLowerCase() === wanted) return { column, index };
  }
  return undefined;
}

/** The x binding, which may arrive as `x`, `date` or `time` (SPEC 8.10). */
function resolveX(input: EncodeInput): {
  channel: { readonly field: string } | undefined;
  from: string;
} {
  const bound = firstChannel(input.block.encoding, 'x');
  if (bound?.field !== undefined) return { channel: { field: bound.field }, from: 'x' };
  for (const name of ['date', 'time'] as const) {
    const field = stringAttr(input.attrs, name);
    if (field !== undefined) return { channel: { field }, from: name };
  }
  return { channel: undefined, from: 'x' };
}

const PRICE_TYPES = ['number', 'integer'] as const;

/** `MDV3000`/`MDV3001` for the five fields a price chart is made of. */
function validatePrices(block: ResolvedBlock, table: Table, needsVolume: boolean): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const attrs = block.attrs;
  const keys = needsVolume
    ? ([...Object.keys(PRICE_ALIASES), 'volume'] as const)
    : (Object.keys(PRICE_ALIASES) as readonly string[]);
  for (const key of keys) {
    const aliases =
      key === 'volume' ? VOLUME_ALIASES : PRICE_ALIASES[key as keyof typeof PRICE_ALIASES];
    const { bound, requested } = resolveField(table, attrs, key, aliases);
    if (bound === undefined) {
      diagnostics.push(
        requested === undefined
          ? missingChannel(block, key, `the ${key} of each period`)
          : blockDiagnostic(
              'MDV3000',
              block,
              'encode',
              `\`${key}: ${requested}\` names \`${requested}\`, which is not a column`,
              `Name one of: ${table.fields.map((field) => field.name).join(', ')}.`,
            ),
      );
      continue;
    }
    const type = bound.column.type;
    if (type !== 'number' && type !== 'integer' && type !== 'unknown') {
      diagnostics.push(
        incompatibleField(block, key, bound.column.name, bound.column.type, [...PRICE_TYPES]),
      );
    }
  }
  return diagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// Indicators (SPEC 8.11.1)
// ─────────────────────────────────────────────────────────────────────────────

type Sparse = readonly (number | undefined)[];

/** Simple moving average; the first `period - 1` values are null (SPEC 8.11.1). */
function sma(values: Sparse, period: number): Sparse {
  const out: (number | undefined)[] = [];
  let sum = 0;
  let count = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value !== undefined) {
      sum += value;
      count += 1;
    }
    const dropped = values[i - period];
    if (dropped !== undefined) {
      sum -= dropped;
      count -= 1;
    }
    out.push(i >= period - 1 && count === period ? sum / period : undefined);
  }
  return out;
}

/** α = 2/(period+1), seeded with the SMA of the first `period` values. */
function ema(values: Sparse, period: number): Sparse {
  const alpha = 2 / (period + 1);
  const seed = sma(values, period);
  const out: (number | undefined)[] = [];
  let previous: number | undefined;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (previous === undefined) {
      previous = seed[i];
      out.push(previous);
      continue;
    }
    previous = value === undefined ? previous : value * alpha + previous * (1 - alpha);
    out.push(previous);
  }
  return out;
}

/** Linear weights 1…n over the window. */
function wma(values: Sparse, period: number): Sparse {
  const out: (number | undefined)[] = [];
  const denominator = (period * (period + 1)) / 2;
  for (let i = 0; i < values.length; i += 1) {
    if (i < period - 1) {
      out.push(undefined);
      continue;
    }
    let sum = 0;
    let ok = true;
    for (let k = 0; k < period; k += 1) {
      const value = values[i - period + 1 + k];
      if (value === undefined) {
        ok = false;
        break;
      }
      sum += value * (k + 1);
    }
    out.push(ok ? sum / denominator : undefined);
  }
  return out;
}

/** Population standard deviation of each window — Bollinger's ± term. */
function rollingStddev(values: Sparse, period: number, mean: Sparse): Sparse {
  const out: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const centre = mean[i];
    if (centre === undefined) {
      out.push(undefined);
      continue;
    }
    let sum = 0;
    let ok = true;
    for (let k = 0; k < period; k += 1) {
      const value = values[i - k];
      if (value === undefined) {
        ok = false;
        break;
      }
      sum += (value - centre) ** 2;
    }
    out.push(ok ? Math.sqrt(sum / period) : undefined);
  }
  return out;
}

/** Highest high / lowest low over the window (Donchian). */
function donchian(periods: readonly Period[], period: number): { upper: Sparse; lower: Sparse } {
  const upper: (number | undefined)[] = [];
  const lower: (number | undefined)[] = [];
  for (let i = 0; i < periods.length; i += 1) {
    if (i < period - 1) {
      upper.push(undefined);
      lower.push(undefined);
      continue;
    }
    let hi = Number.NEGATIVE_INFINITY;
    let lo = Number.POSITIVE_INFINITY;
    for (let k = 0; k < period; k += 1) {
      const entry = periods[i - k];
      if (entry === undefined) continue;
      hi = Math.max(hi, entry.high);
      lo = Math.min(lo, entry.low);
    }
    upper.push(Number.isFinite(hi) ? hi : undefined);
    lower.push(Number.isFinite(lo) ? lo : undefined);
  }
  return { upper, lower };
}

/** Σ(typical × volume)/Σ(volume). `anchor: start` never resets (SPEC 8.11.1). */
function vwap(periods: readonly Period[]): Sparse {
  const out: (number | undefined)[] = [];
  let numerator = 0;
  let denominator = 0;
  for (const period of periods) {
    const volume = period.volume;
    if (volume !== undefined && volume > 0) {
      const typical = (period.high + period.low + period.close) / 3;
      numerator += typical * volume;
      denominator += volume;
    }
    out.push(denominator > 0 ? numerator / denominator : undefined);
  }
  return out;
}

/** Wilder's RSI over the close series. */
function rsi(values: Sparse, period: number): Sparse {
  const out: (number | undefined)[] = [undefined];
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < values.length; i += 1) {
    const now = values[i];
    const before = values[i - 1];
    const change = now === undefined || before === undefined ? 0 : now - before;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      out.push(i === period ? rsiOf(avgGain, avgLoss) : undefined);
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out.push(rsiOf(avgGain, avgLoss));
  }
  return out.slice(0, values.length);
}

function rsiOf(gain: number, loss: number): number {
  if (loss === 0) return gain === 0 ? 50 : 100;
  const rs = gain / loss;
  return 100 - 100 / (1 + rs);
}

/** MACD line, signal line and histogram. */
function macd(
  values: Sparse,
  fast: number,
  slow: number,
  signal: number,
): { line: Sparse; signal: Sparse; histogram: Sparse } {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line: (number | undefined)[] = [];
  for (let i = 0; i < values.length; i += 1) {
    const a = fastEma[i];
    const b = slowEma[i];
    line.push(a === undefined || b === undefined ? undefined : a - b);
  }
  const signalLine = ema(line, signal);
  const histogram: (number | undefined)[] = [];
  for (let i = 0; i < line.length; i += 1) {
    const a = line[i];
    const b = signalLine[i];
    histogram.push(a === undefined || b === undefined ? undefined : a - b);
  }
  return { line, signal: signalLine, histogram };
}

/** The series an overlay reads: `close` unless the author names another field. */
function fieldSeries(periods: readonly Period[], table: Table, field: string | undefined): Sparse {
  if (field === undefined) return periods.map((period) => period.close);
  const known: Record<string, (period: Period) => number> = {
    open: (period) => period.open,
    high: (period) => period.high,
    low: (period) => period.low,
    close: (period) => period.close,
  };
  const pick = known[field.toLowerCase()];
  if (pick !== undefined) return periods.map(pick);
  const found = findColumn(table, field);
  if (found === undefined) return periods.map((period) => period.close);
  return periods.map((period) => cellNumber(cell(table, period.row, found.index)) ?? undefined);
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlays and panels
// ─────────────────────────────────────────────────────────────────────────────

const OVERLAY_DASH: Readonly<Record<string, readonly number[] | undefined>> = {
  sma: undefined,
  ema: [6, 3],
  wma: [2, 2],
  vwap: [8, 3],
  channel: [4, 4],
  line: [4, 3],
};

/**
 * Build the overlay plots.
 *
 * Overlay color comes from the *sequential* ramp, not the categorical palette:
 * an indicator is a derived reading of the same price, not a second series, and
 * giving it a series slot would claim an identity it does not have (SPEC 11.2).
 */
function buildOverlays(
  attrs: BlockAttrs,
  periods: readonly Period[],
  table: Table,
  theme: Theme,
): OverlayPlot[] {
  const plots: OverlayPlot[] = [];
  const items = listAttr(attrs, 'overlay');
  const ramp = theme.sequential;
  let index = 0;
  for (const raw of items) {
    const item = itemOf(raw);
    if (item === undefined) continue;
    const type = (itemString(item, 'type') ?? '').toLowerCase();
    const color = (itemString(item, 'color') ?? rampColor(ramp, index)) as ColorString;
    const field = itemString(item, 'field');
    const dash = OVERLAY_DASH[type];
    index += 1;
    switch (type) {
      case 'sma':
      case 'ema':
      case 'wma': {
        const period = periodOf(item, 20);
        const source = fieldSeries(periods, table, field);
        const values =
          type === 'sma'
            ? sma(source, period)
            : type === 'ema'
              ? ema(source, period)
              : wma(source, period);
        plots.push({ kind: 'line', label: `${type.toUpperCase()} ${period}`, color, dash, values });
        break;
      }
      case 'bollinger': {
        const period = periodOf(item, 20);
        const k = itemNumber(item, 'k', 2);
        const source = fieldSeries(periods, table, field);
        const mean = sma(source, period);
        const deviation = rollingStddev(source, period, mean);
        const upper = mean.map((value, i) => {
          const sd = deviation[i];
          return value === undefined || sd === undefined ? undefined : value + k * sd;
        });
        const lower = mean.map((value, i) => {
          const sd = deviation[i];
          return value === undefined || sd === undefined ? undefined : value - k * sd;
        });
        plots.push({ kind: 'band', label: `Bollinger ${period}±${k}σ`, color, upper, lower });
        plots.push({ kind: 'line', label: `Bollinger mid`, color, dash: undefined, values: mean });
        break;
      }
      case 'vwap': {
        plots.push({ kind: 'line', label: 'VWAP', color, dash, values: vwap(periods) });
        break;
      }
      case 'channel': {
        const period = periodOf(item, 20);
        const { upper, lower } = donchian(periods, period);
        plots.push({ kind: 'line', label: `Donchian ${period} high`, color, dash, values: upper });
        plots.push({ kind: 'line', label: `Donchian ${period} low`, color, dash, values: lower });
        break;
      }
      case 'line': {
        const value = item['value'];
        if (isFiniteNumber(value)) {
          const label = itemString(item, 'label') ?? formatNumber(value, undefined);
          plots.push({
            kind: 'line',
            label,
            color,
            dash,
            values: periods.map(() => value),
          });
          break;
        }
        const source = fieldSeries(periods, table, field);
        plots.push({
          kind: 'line',
          label: itemString(item, 'label') ?? field ?? 'Reference',
          color,
          dash,
          values: source,
        });
        break;
      }
      default:
        break;
    }
  }
  return plots;
}

/** A ramp step for the nth overlay, wrapping rather than repeating adjacents. */
function rampColor(ramp: SequentialPalette, index: number): ColorString {
  // Only the band between the floor and the ceiling clears 2:1 against this
  // scheme's surface (SPEC 11.3, ordinal ramps): the pale end cannot hold a 1 px
  // line on light, and the dark end disappears on dark. Overlays cycle inside
  // that band rather than walking the whole ramp, so an indicator stays legible
  // on both schemes without the theme having to special-case it.
  const steps = ramp.steps;
  const first = Math.max(0, Math.min(ramp.ordinalFloor, steps.length - 1));
  const last = Math.max(first, Math.min(ramp.ordinalCeiling, steps.length - 1));
  const step = steps[first + (index % (last - first + 1))];
  return step ?? ramp.hue;
}

/** Volume is its own panel, and always the first one when the type has it. */
function volumePanel(
  periods: readonly Period[],
  byDirection: boolean,
  fill: ColorString | undefined,
  label: string,
): PanelPlot | undefined {
  const bars = periods.map((period) => period.volume);
  const values = bars.filter((value): value is number => value !== undefined);
  if (values.length === 0) return undefined;
  const top = Math.max(...values);
  return {
    kind: 'volume',
    label,
    height: 0.25,
    domain: [0, top > 0 ? top : 1],
    format: '.3~s',
    bars,
    barsByDirection: byDirection,
    lines: [],
    guides: [],
    ...(fill === undefined ? {} : { fill }),
  };
}

/** The `panels:` list (SPEC 8.11.2), in author order, below the price panel. */
function buildPanels(
  attrs: BlockAttrs,
  periods: readonly Period[],
  table: Table,
  theme: Theme,
  volume: PanelPlot | undefined,
): PanelPlot[] {
  const panels: PanelPlot[] = [];
  const closes = periods.map((period) => period.close);
  for (const raw of listAttr(attrs, 'panels')) {
    const item = itemOf(raw);
    if (item === undefined) continue;
    const type = (itemString(item, 'type') ?? '').toLowerCase();
    const height = item['height'];
    if (type === 'volume') {
      if (volume !== undefined) panels.push({ ...volume, height: height ?? volume.height });
      continue;
    }
    if (type === 'rsi') {
      const period = periodOf(item, 14);
      const bands = item['bands'];
      const guides = Array.isArray(bands)
        ? bands.filter((value): value is number => isFiniteNumber(value))
        : [30, 70];
      panels.push({
        kind: 'rsi',
        label: `RSI ${period}`,
        height: height ?? 0.15,
        domain: [0, 100],
        format: '.0f',
        bars: [],
        barsByDirection: false,
        lines: [
          {
            label: `RSI ${period}`,
            color: rampColor(theme.sequential, 0),
            dash: undefined,
            values: rsi(closes, period),
          },
        ],
        guides,
      });
      continue;
    }
    if (type === 'macd') {
      const fast = Math.max(1, Math.round(itemNumber(item, 'fast', 12)));
      const slow = Math.max(1, Math.round(itemNumber(item, 'slow', 26)));
      const signal = Math.max(1, Math.round(itemNumber(item, 'signal', 9)));
      const result = macd(closes, fast, slow, signal);
      const span = [...result.line, ...result.signal, ...result.histogram].filter(
        (value): value is number => value !== undefined,
      );
      const extent = extentOf(span) ?? [-1, 1];
      const reach = Math.max(Math.abs(extent[0]), Math.abs(extent[1]), Number.EPSILON);
      panels.push({
        kind: 'macd',
        label: `MACD ${fast},${slow},${signal}`,
        height: height ?? 0.2,
        // A MACD panel is symmetric about zero: the sign is the signal, and an
        // asymmetric frame would make a small positive look like a large one.
        domain: [-reach, reach],
        format: undefined,
        bars: result.histogram,
        barsByDirection: true,
        lines: [
          {
            label: 'MACD',
            color: rampColor(theme.sequential, 0),
            dash: undefined,
            values: result.line,
          },
          {
            label: 'Signal',
            color: rampColor(theme.sequential, 2),
            dash: [6, 3],
            values: result.signal,
          },
        ],
        guides: [0],
      });
    }
  }
  return panels;
}

// ─────────────────────────────────────────────────────────────────────────────
// The type
// ─────────────────────────────────────────────────────────────────────────────

function emptyResult(input: EncodeInput, series: readonly SeriesDescriptor[]): OhlcEncodeResult {
  const empty: A11yTable = {
    caption: input.attrs.title ?? input.attrs.caption ?? 'Chart data',
    columns: [],
    rows: [],
    presentation: presentationOf(input.attrs),
  };
  return {
    marks: [],
    series,
    scales: {
      x: createBandScale({ domain: [] }),
      y: createContinuousScale('linear', { domain: [0, 1] }),
    },
    axes: [],
    a11yTable: empty,
    state: DEFAULT_PLAN,
  };
}

/**
 * Build `ohlc` or `ohlcv`. The two differ by one required field and one panel,
 * which is not enough difference to justify two implementations of the same
 * candle geometry.
 */
function priceChart(options: {
  name: string;
  aliases?: readonly string[];
  withVolume: boolean;
  kind: string;
}): ChartType<OhlcMark> {
  return {
    name: options.name,
    ...(options.aliases === undefined ? {} : { aliases: options.aliases }),
    level: 2,
    family: 'mark',
    channels: CHANNELS,
    defaultEncoding: {},
    defaults: { style: 'candle', gaps: 'collapse', hollow: false },
    schemaId: `https://mdv.dev/schema/1.0/${options.name}.json`,
    minWidth: 240,

    validate(block: ResolvedBlock, table: Table): Diagnostic[] {
      const diagnostics: Diagnostic[] = [];
      const x = resolveXFromBlock(block);
      if (x === undefined) {
        diagnostics.push(missingChannel(block, 'x', 'the period each bar covers'));
      } else if (findColumn(table, x.field) === undefined && table.fields.length > 0) {
        diagnostics.push(
          blockDiagnostic(
            'MDV3000',
            block,
            'encode',
            `\`x\` names \`${x.field}\`, which is not a column`,
            `Name one of: ${table.fields.map((field) => field.name).join(', ')}.`,
          ),
        );
      }
      diagnostics.push(...validatePrices(block, table, options.withVolume));
      return diagnostics;
    },

    encode(input: EncodeInput): EncodeResult<OhlcMark> {
      const { table, attrs, block } = input;
      const theme = input.theme;
      const x = resolveX(input);
      const xBound = x.channel === undefined ? undefined : findColumn(table, x.channel.field);
      const fields = {
        open: resolveField(table, attrs, 'open', PRICE_ALIASES.open).bound,
        high: resolveField(table, attrs, 'high', PRICE_ALIASES.high).bound,
        low: resolveField(table, attrs, 'low', PRICE_ALIASES.low).bound,
        close: resolveField(table, attrs, 'close', PRICE_ALIASES.close).bound,
      };
      const volumeBound = resolveField(table, attrs, 'volume', VOLUME_ALIASES).bound;
      if (
        xBound === undefined ||
        fields.open === undefined ||
        fields.high === undefined ||
        fields.low === undefined ||
        fields.close === undefined
      ) {
        return emptyResult(input, []);
      }

      const style = enumAttr<OhlcStyle>(attrs, 'style', ['candle', 'bar', 'hlc'], 'candle');
      const gaps = enumAttr<GapMode>(attrs, 'gaps', ['collapse', 'preserve'], 'collapse');
      const hollow = boolAttr(attrs, 'hollow', false);
      const wickWidth = numberAttr(attrs, 'wickWidth', 1, 0.5, 8);
      const rawBody = rawAttr(attrs, 'bodyWidth');
      const bodyWidth = isFiniteNumber(rawBody) ? Math.max(1, rawBody) : undefined;
      const up = colorAttr(attrs, 'upColor', theme.status.good);
      const down = colorAttr(attrs, 'downColor', theme.status.critical);
      const xFormat = channelFormat(
        x.channel === undefined ? undefined : firstChannel(block.encoding, 'x'),
        xBound.column,
      );
      const priceFormat = priceFormatOf(attrs, fields.close.column);

      // ── Periods ──────────────────────────────────────────────────────────
      const periods: Period[] = [];
      let dropped = 0;
      for (let row = 0; row < table.rows.length; row += 1) {
        const open = cellNumber(cell(table, row, fields.open.index));
        const high = cellNumber(cell(table, row, fields.high.index));
        const low = cellNumber(cell(table, row, fields.low.index));
        const close = cellNumber(cell(table, row, fields.close.index));
        const at = cellScaleInput(cell(table, row, xBound.index));
        if (open === null || high === null || low === null || close === null || at === null) {
          dropped += 1;
          continue;
        }
        const volume =
          volumeBound === undefined
            ? undefined
            : (cellNumber(cell(table, row, volumeBound.index)) ?? undefined);
        if (options.withVolume && volume === undefined) {
          dropped += 1;
          continue;
        }
        periods.push({
          x: at,
          label: formatValue(cell(table, row, xBound.index), xFormat ?? xBound.column.format),
          row,
          open,
          // A bar whose high is below its low is a transcription error, not a
          // shape to draw: normalise so the wick still spans the observations
          // rather than collapsing onto whichever one was written first.
          high: Math.max(high, low),
          low: Math.min(low, high),
          close,
          volume,
          direction: close > open ? 'up' : close < open ? 'down' : 'flat',
        });
      }
      if (periods.length === 0) {
        // Every row was unusable. That is the case where the count matters
        // most — an empty chart with no `droppedRows` reads as "no data was
        // supplied" rather than "none of the data you supplied was complete".
        const none = emptyResult(input, []);
        if (dropped > 0) none.droppedRows = dropped;
        return none;
      }

      const overlays = buildOverlays(attrs, periods, table, theme);
      const volumeColor = stringAttr(attrs, 'volumeColor') ?? 'direction';
      const panel =
        volumeBound === undefined
          ? undefined
          : volumePanel(
              periods,
              volumeColor === 'direction',
              volumeColor === 'direction' ? undefined : (volumeColor as ColorString),
              humaniseColumn(volumeBound.column),
            );
      const requested = buildPanels(attrs, periods, table, theme, panel);
      const panels =
        options.withVolume &&
        panel !== undefined &&
        !requested.some((entry) => entry.kind === 'volume')
          ? [panel, ...requested]
          : requested;

      // ── Scales ───────────────────────────────────────────────────────────
      const span: number[] = [];
      for (const period of periods) span.push(period.low, period.high);
      for (const overlay of overlays) {
        const values = overlay.kind === 'line' ? [overlay.values] : [overlay.upper, overlay.lower];
        for (const list of values) {
          for (const value of list) if (value !== undefined) span.push(value);
        }
      }
      const yChannel = firstChannel(block.encoding, 'y');
      // Price is not forced through zero: a stock that trades at 41 does not
      // become more honest by drawing 41 units of empty space beneath it.
      const domainResult = resolveDomain({
        data: extentOf(span) ?? [0, 1],
        zeroByDefault: false,
        ...(yChannel?.scale === undefined ? {} : { spec: yChannel.scale }),
      });
      const priceScale = createContinuousScale('linear', {
        domain: domainResult.domain,
        ...(priceFormat === undefined ? {} : { format: priceFormat }),
      });
      const dates = periods
        .map((period) => (period.x instanceof Date ? period.x : undefined))
        .filter((value): value is Date => value !== undefined);
      const timeScale =
        gaps === 'preserve' && dates.length === periods.length && dates.length > 1
          ? createTimeScale({
              domain: [dates[0] ?? new Date(0), dates[dates.length - 1] ?? new Date(0)],
              ...(xFormat === undefined ? {} : { format: xFormat }),
            })
          : undefined;
      const xScale: Scale =
        timeScale ??
        createBandScale({
          domain: periods.map((period) => period.x),
          padding: 0.2,
          ...(xFormat === undefined ? {} : { format: xFormat }),
        });

      // ── Marks ────────────────────────────────────────────────────────────
      const marks: OhlcMark[] = periods.map((period) => ({
        mark: 'ohlc',
        seriesId: '',
        datum: period.row,
        label: period.label,
        x: period.x,
        open: period.open,
        high: period.high,
        low: period.low,
        close: period.close,
        direction: period.direction,
        ...(period.volume === undefined ? {} : { volume: period.volume }),
      }));

      const periodAxis = makeAxis({
        channel: 'x',
        position: 'bottom',
        scale: xScale,
        binding: firstChannel(block.encoding, 'x'),
        column: xBound.column,
        spec: axisSpecFor(attrs, 'x', firstChannel(block.encoding, 'x')),
        gridByDefault: false,
        baselineByDefault: true,
      });
      const priceAxis = makeAxis({
        channel: 'y',
        position: 'left',
        scale: priceScale,
        binding: yChannel,
        column: fields.close.column,
        spec: axisSpecFor(attrs, 'y', yChannel),
        gridByDefault: true,
        baselineByDefault: false,
      });
      const axes: AxisModel[] = [periodAxis, priceAxis].filter(
        (axis): axis is AxisModel => axis !== undefined,
      );

      const columns = [
        viewColumn(xBound),
        viewColumn(fields.open),
        viewColumn(fields.high),
        viewColumn(fields.low),
        viewColumn(fields.close),
        ...(volumeBound === undefined ? [] : [viewColumn(volumeBound)]),
      ].filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

      const result: OhlcEncodeResult = {
        marks,
        series: [],
        scales: { x: xScale, y: priceScale },
        axes,
        boundColumns: [
          xBound.column,
          fields.open.column,
          fields.high.column,
          fields.low.column,
          fields.close.column,
          ...(volumeBound === undefined ? [] : [volumeBound.column]),
        ],
        a11yTable: buildA11yTable(
          table,
          columns,
          attrs.title ?? attrs.caption ?? 'Chart data',
          presentationOf(attrs),
        ),
        state: {
          style,
          hollow,
          wickWidth,
          bodyWidth,
          gaps,
          up,
          down,
          periods,
          overlays,
          panels,
          priceFormat,
          measure: humaniseColumn(fields.close.column),
          category: humaniseColumn(xBound.column),
        },
      };
      if (dropped > 0) result.droppedRows = dropped;
      return result;
    },

    layout(encoded: EncodeResult<OhlcMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
      const plan = planOf<OhlcMark, OhlcPlan>(encoded, DEFAULT_PLAN);
      const nodes: SceneNode[] = [];
      const hits: ChartHitRegion[] = [];
      const xScale = encoded.scales.x;
      const priceScale = encoded.scales.y;
      if (
        xScale === undefined ||
        priceScale === undefined ||
        isDegenerateFrame(frame) ||
        plan.periods.length === 0
      ) {
        return { nodes, hits };
      }

      // ── Panel stack (SPEC 8.11.2) ────────────────────────────────────────
      const gap = Math.max(4, ctx.theme.marks.spacer.surfaceGap * 4);
      const heights: number[] = plan.panels.map((panel) =>
        Math.max(MIN_PANEL_HEIGHT, resolveDimension(panel.height, frame.height, 0.2)),
      );
      let total = heights.reduce((sum, value) => sum + value + gap, 0);
      const budget = frame.height * MAX_PANEL_SHARE;
      if (total > budget && total > 0) {
        const scale = budget / total;
        for (let i = 0; i < heights.length; i += 1) heights[i] = (heights[i] ?? 0) * scale;
        total = heights.reduce((sum, value) => sum + value + gap, 0);
      }
      const priceHeight = frame.height - total;
      const stacked = priceHeight >= MIN_PRICE_PANEL ? plan.panels : [];
      const priceRect: Rect =
        stacked.length === 0
          ? frame
          : { x: frame.x, y: frame.y, width: frame.width, height: priceHeight };

      rangeToFrame(priceRect, xScale, priceScale);

      const bandwidth = typeof xScale.bandwidth === 'function' ? xScale.bandwidth() : 0;
      const slot = bandwidth > 0 ? bandwidth : frame.width / Math.max(1, plan.periods.length);
      const body = Math.max(1, Math.min(plan.bodyWidth ?? slot * BODY_FRACTION, MAX_BODY_WIDTH));
      const half = body / 2;
      const centres: number[] = plan.periods.map((period) => {
        const at = xScale.scale(period.x);
        return at === undefined ? Number.NaN : at + (bandwidth > 0 ? bandwidth / 2 : 0);
      });

      // ── Overlay bands sit under the candles, lines over them ─────────────
      for (const overlay of plan.overlays) {
        if (overlay.kind !== 'band') continue;
        const upper: Point[] = [];
        const lower: Point[] = [];
        for (let i = 0; i < plan.periods.length; i += 1) {
          const cx = centres[i];
          const hi = overlay.upper[i];
          const lo = overlay.lower[i];
          if (cx === undefined || !Number.isFinite(cx) || hi === undefined || lo === undefined)
            continue;
          const top = priceScale.scale(hi);
          const bottom = priceScale.scale(lo);
          if (top === undefined || bottom === undefined) continue;
          upper.push({ x: px(cx), y: px(top) });
          lower.push({ x: px(cx), y: px(bottom) });
        }
        if (upper.length < 2) continue;
        nodes.push({
          kind: 'path',
          id: ctx.ids.next('overlay-band'),
          cls: 'mdv-overlay mdv-overlay-band',
          d: areaPath(upper, lower, 'linear'),
          fill: solid(overlay.color, 0.12),
        });
      }

      // ── Candles ──────────────────────────────────────────────────────────
      for (let i = 0; i < plan.periods.length; i += 1) {
        const period = plan.periods[i];
        const centre = centres[i];
        if (period === undefined || centre === undefined || !Number.isFinite(centre)) continue;
        const color = period.direction === 'down' ? plan.down : plan.up;
        const highY = priceScale.scale(period.high);
        const lowY = priceScale.scale(period.low);
        const openY = priceScale.scale(period.open);
        const closeY = priceScale.scale(period.close);
        if (
          highY === undefined ||
          lowY === undefined ||
          openY === undefined ||
          closeY === undefined
        ) {
          continue;
        }
        const stroke = lineStroke(ctx.theme, color, plan.wickWidth);
        const nodeId = ctx.ids.next(plan.style === 'candle' ? 'candle' : 'ohlc-bar');
        if (plan.style === 'candle') {
          nodes.push({
            kind: 'line',
            id: ctx.ids.next('wick'),
            cls: 'mdv-mark mdv-mark-wick',
            x1: px(centre),
            y1: px(highY),
            x2: px(centre),
            y2: px(lowY),
            stroke,
          });
          const top = Math.min(openY, closeY);
          const height = Math.max(1, Math.abs(closeY - openY));
          // Hollow up-candles are the second channel: fill carries direction
          // even when the color is lost (SPEC 8.10 rendering notes).
          const filled = !(plan.hollow && period.direction === 'up');
          nodes.push({
            kind: 'rect',
            id: nodeId,
            cls: `mdv-mark mdv-mark-candle mdv-mark-${period.direction}`,
            x: px(centre - half),
            y: px(top),
            w: px(body),
            h: px(height),
            ...(filled ? { fill: solid(color) } : { fill: solid(ctx.theme.tokens.surface) }),
            stroke: lineStroke(ctx.theme, color, Math.max(1, plan.wickWidth)),
          });
        } else {
          nodes.push({
            kind: 'path',
            id: nodeId,
            cls: `mdv-mark mdv-mark-ohlc mdv-mark-${period.direction}`,
            d: [
              moveTo(px(centre), px(highY)),
              lineTo(px(centre), px(lowY)),
              ...(plan.style === 'bar'
                ? [moveTo(px(centre - half), px(openY)), lineTo(px(centre), px(openY))]
                : []),
              moveTo(px(centre), px(closeY)),
              lineTo(px(centre + half), px(closeY)),
            ],
            stroke,
          });
        }

        const rows: ReadoutRow[] = [
          readout('Open', formatNumber(period.open, plan.priceFormat)),
          readout('High', formatNumber(period.high, plan.priceFormat)),
          readout('Low', formatNumber(period.low, plan.priceFormat)),
          readout('Close', formatNumber(period.close, plan.priceFormat), undefined, true),
        ];
        if (period.volume !== undefined) {
          rows.push(readout('Volume', formatNumber(period.volume, '.3~s')));
        }
        // One hit region per period spanning the whole stack: the crosshair is
        // shared across panels (SPEC 8.11.2), so the target must be too.
        hits.push(
          hitRegion({
            x: centre - slot / 2,
            y: frame.y,
            w: slot,
            h: frame.height,
            anchor: { x: centre, y: Math.min(highY, lowY) },
            datumIndex: period.row,
            seriesId: '',
            group: period.label,
            readout: rows,
            markNodeId: nodeId,
          }),
        );
      }

      // ── Overlay lines ────────────────────────────────────────────────────
      for (const overlay of plan.overlays) {
        if (overlay.kind !== 'line') continue;
        nodes.push(
          ...polyline(
            overlay.values,
            centres,
            priceScale,
            ctx,
            overlay.color,
            overlay.dash,
            'mdv-overlay mdv-overlay-line',
          ),
        );
      }

      // ── Stacked panels ───────────────────────────────────────────────────
      let cursor = priceRect.y + priceRect.height + gap;
      for (let p = 0; p < stacked.length; p += 1) {
        const panel = stacked[p];
        const height = heights[p];
        if (panel === undefined || height === undefined) continue;
        const rect: Rect = { x: frame.x, y: cursor, width: frame.width, height };
        cursor += height + gap;
        nodes.push(...drawPanel(panel, rect, plan, centres, body, ctx));
      }

      return { nodes, hits };
    },

    describe(input: DescribeInput<OhlcMark>): string {
      const plan = planOf<OhlcMark, OhlcPlan>(input.encoded, DEFAULT_PLAN);
      if (plan.periods.length === 0) return `${options.kind}. No data.`;
      const lows = plan.periods.map((period) => period.low);
      const highs = plan.periods.map((period) => period.high);
      const low = Math.min(...lows);
      const high = Math.max(...highs);
      const first = plan.periods[0];
      const last = plan.periods[plan.periods.length - 1];
      const change =
        first === undefined || last === undefined || first.open === 0
          ? undefined
          : ((last.close - first.open) / Math.abs(first.open)) * 100;
      const parts = [
        `${plan.measure}${plan.category === undefined ? '' : ` by ${plan.category.toLowerCase()}`}`,
        countPhrase(plan.periods.length, 'period'),
      ];
      const description = composeDescription({
        chartKind: options.kind,
        subject: parts[0] ?? plan.measure,
        scope: parts[1] ?? countPhrase(plan.periods.length, 'period'),
        range: `Prices range from ${formatNumber(low, plan.priceFormat)} to ${formatNumber(high, plan.priceFormat)}`,
        ...(change === undefined || !Number.isFinite(change)
          ? {}
          : {
              extreme: `${change >= 0 ? 'Up' : 'Down'} ${formatNumber(Math.abs(change), '.1f')}% from ${first?.label ?? ''} to ${last?.label ?? ''}`,
            }),
      });
      return description;
    },
  };
}

/** The x binding as `validate` sees it, before the table is prepared. */
function resolveXFromBlock(block: ResolvedBlock): { readonly field: string } | undefined {
  const bound = firstChannel(block.encoding, 'x');
  if (bound?.field !== undefined) return { field: bound.field };
  for (const name of ['date', 'time'] as const) {
    const field = stringAttr(block.attrs, name);
    if (field !== undefined) return { field };
  }
  return undefined;
}

/** One indicator line, broken at every null rather than interpolated. */
function polyline(
  values: Sparse,
  centres: readonly number[],
  scale: Scale,
  ctx: LayoutContext,
  color: ColorString,
  dash: readonly number[] | undefined,
  cls: string,
): SceneNode[] {
  const nodes: SceneNode[] = [];
  let run: Point[] = [];
  const flush = (): void => {
    if (run.length > 0) {
      nodes.push({
        kind: 'path',
        id: ctx.ids.next('overlay'),
        cls,
        d:
          run.length === 1
            ? [moveTo(run[0]?.x ?? 0, run[0]?.y ?? 0), lineTo(run[0]?.x ?? 0, run[0]?.y ?? 0)]
            : run.flatMap((point, i) =>
                i === 0 ? [moveTo(point.x, point.y)] : [lineTo(point.x, point.y)],
              ),
        stroke: lineStroke(ctx.theme, color, 1.5, dash),
      });
    }
    run = [];
  };
  for (let i = 0; i < centres.length; i += 1) {
    const value = values[i];
    const cx = centres[i];
    if (value === undefined || cx === undefined || !Number.isFinite(cx)) {
      flush();
      continue;
    }
    const y = scale.scale(value);
    if (y === undefined) {
      flush();
      continue;
    }
    run.push({ x: px(cx), y: px(y) });
  }
  flush();
  return nodes;
}

/** Draw one stacked panel: its own y-scale, its bars, lines and guides. */
function drawPanel(
  panel: PanelPlot,
  rect: Rect,
  plan: OhlcPlan,
  centres: readonly number[],
  body: number,
  ctx: LayoutContext,
): SceneNode[] {
  const nodes: SceneNode[] = [];
  const scale = createContinuousScale('linear', {
    domain: [panel.domain[0], panel.domain[1]],
    ...(panel.format === undefined ? {} : { format: panel.format }),
  });
  setScaleRange(scale, rect.y + rect.height, rect.y);
  const zero = scale.scale(panel.domain[0] < 0 ? 0 : panel.domain[0]) ?? rect.y + rect.height;

  for (const guide of panel.guides) {
    const y = scale.scale(guide);
    if (y === undefined) continue;
    nodes.push({
      kind: 'line',
      id: ctx.ids.next('panel-guide'),
      cls: 'mdv-panel-guide',
      x1: px(rect.x),
      y1: px(y),
      x2: px(rect.x + rect.width),
      y2: px(y),
      stroke: chromeStroke(ctx.theme, guide !== 0),
    });
  }

  for (let i = 0; i < centres.length; i += 1) {
    const value = panel.bars[i];
    const cx = centres[i];
    if (value === undefined || cx === undefined || !Number.isFinite(cx)) continue;
    const y = scale.scale(value);
    if (y === undefined) continue;
    const period = plan.periods[i];
    const color = panel.barsByDirection
      ? panel.kind === 'macd'
        ? value >= 0
          ? plan.up
          : plan.down
        : period?.direction === 'down'
          ? plan.down
          : plan.up
      : (panel.fill ?? ctx.theme.tokens.grid);
    const top = Math.min(y, zero);
    const height = Math.max(1, Math.abs(zero - y));
    nodes.push({
      kind: 'rect',
      id: ctx.ids.next(`${panel.kind}-bar`),
      cls: `mdv-mark mdv-panel-bar mdv-panel-${panel.kind}`,
      x: px(cx - body / 2),
      y: px(top),
      w: px(body),
      h: px(height),
      fill: solid(color, panel.kind === 'volume' ? 0.65 : 0.85),
    });
  }

  for (const line of panel.lines) {
    nodes.push(
      ...polyline(
        line.values,
        centres,
        scale,
        ctx,
        line.color,
        line.dash,
        `mdv-panel-line mdv-panel-${panel.kind}`,
      ),
    );
  }

  // The panel names itself: a stack of unlabelled boxes is a puzzle, and there
  // is no axis title to carry it (SPEC 8.11.2 — panels share the x-axis only).
  nodes.push({
    kind: 'text',
    id: ctx.ids.next('panel-label'),
    cls: 'mdv-panel-label',
    x: px(rect.x + 2),
    y: px(rect.y + 2),
    text: panel.label,
    font: tickFont(ctx.theme),
    fill: solid(ctx.theme.tokens['text-muted']),
    anchor: 'start',
    baseline: 'top',
  });

  return nodes;
}

/** `ohlc` — price action per period, no volume (SPEC 8.10). */
export const ohlcChart: ChartType<OhlcMark> = priceChart({
  name: 'ohlc',
  aliases: ['candlestick'],
  withVolume: false,
  kind: 'Candlestick chart',
});

/** `ohlcv` — price with a volume panel (SPEC 8.11). */
export const ohlcvChart: ChartType<OhlcMark> = priceChart({
  name: 'ohlcv',
  withVolume: true,
  kind: 'Candlestick chart with volume',
});

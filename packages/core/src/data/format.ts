/**
 * Formatting (SPEC 6.9).
 *
 * `format` accepts either a **format string** or an **options object**.
 *
 * SPEC 6.9.3 is the reason this file exists at all:
 *
 * > `Intl` output varies with the host ICU version, which would break
 * > determinism. Therefore conforming readers **MUST** ship a built-in formatter
 * > covering the format-string grammar and the `en-US` locale, and use it by
 * > default. `Intl` is used only when the document requests a non-default locale
 * > or an options object.
 *
 * So: the d3-format subset below is hand-implemented and never touches `Intl`.
 * {@link formatValue} routes to `Intl` only for an options object or a
 * non-`en-US` locale, and reports which path it took so the exporter can record
 * the ICU version (SPEC 28.9).
 */

import type { Value } from '../types/data.js';
import { formatWithPattern, wallClockIn } from './strftime.js';
import type { TimeZoneSpec } from './temporal.js';

// ─────────────────────────────────────────────────────────────────────────────
// Number format strings (SPEC 6.9.1)
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed `[[fill]align][sign][symbol][0][width][,][.precision][~][type]`. */
export interface NumberFormatSpec {
  fill: string;
  align: '<' | '>' | '^' | '=' | undefined;
  sign: '-' | '+' | '(' | ' ';
  symbol: '$' | '#' | undefined;
  zero: boolean;
  width: number | undefined;
  comma: boolean;
  precision: number | undefined;
  trim: boolean;
  type: string | undefined;
}

const ALIGNS = '<>^=';
const SIGNS = '-+( ';
const TYPES = 'efgrs%pdboxXc';

/**
 * Parse a d3-style number format string.
 *
 * @returns `undefined` when the string is not a valid specifier, so the caller
 * can fall back to plain rendering rather than printing nonsense.
 */
export function parseNumberFormat(spec: string): NumberFormatSpec | undefined {
  let i = 0;
  let fill = ' ';
  let align: NumberFormatSpec['align'];

  const second = spec[1];
  if (second !== undefined && ALIGNS.includes(second)) {
    fill = spec[0] as string;
    align = second as NumberFormatSpec['align'];
    i = 2;
  } else if (spec[0] !== undefined && ALIGNS.includes(spec[0])) {
    align = spec[0] as NumberFormatSpec['align'];
    i = 1;
  }

  let sign: NumberFormatSpec['sign'] = '-';
  if (spec[i] !== undefined && SIGNS.includes(spec[i] as string)) {
    sign = spec[i] as NumberFormatSpec['sign'];
    i += 1;
  }

  let symbol: NumberFormatSpec['symbol'];
  if (spec[i] === '$' || spec[i] === '#') {
    symbol = spec[i] as '$' | '#';
    i += 1;
  }

  let zero = false;
  if (spec[i] === '0') {
    zero = true;
    i += 1;
  }

  let widthText = '';
  while (i < spec.length && isDigit(spec.charCodeAt(i))) {
    widthText += spec[i] as string;
    i += 1;
  }

  let comma = false;
  if (spec[i] === ',') {
    comma = true;
    i += 1;
  }

  let precision: number | undefined;
  if (spec[i] === '.') {
    i += 1;
    let digits = '';
    while (i < spec.length && isDigit(spec.charCodeAt(i))) {
      digits += spec[i] as string;
      i += 1;
    }
    if (digits === '') return undefined;
    precision = Number(digits);
  }

  let trim = false;
  if (spec[i] === '~') {
    trim = true;
    i += 1;
  }

  let type: string | undefined;
  if (i < spec.length) {
    const t = spec[i] as string;
    if (!TYPES.includes(t)) return undefined;
    type = t;
    i += 1;
  }
  if (i !== spec.length) return undefined;

  return {
    fill,
    align,
    sign,
    symbol,
    zero,
    width: widthText === '' ? undefined : Number(widthText),
    comma,
    precision,
    trim,
    type,
  };
}

const SI_PREFIXES = [
  'y',
  'z',
  'a',
  'f',
  'p',
  'n',
  'µ',
  'm',
  '',
  'k',
  'M',
  'G',
  'T',
  'P',
  'E',
  'Z',
  'Y',
];

/** Group the integer part in threes with `,`. */
function group(intText: string): string {
  if (intText.length <= 3) return intText;
  let out = '';
  let count = 0;
  for (let i = intText.length - 1; i >= 0; i -= 1) {
    out = (intText[i] as string) + out;
    count += 1;
    if (count % 3 === 0 && i > 0) out = `,${out}`;
  }
  return out;
}

function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  let out = text;
  while (out.endsWith('0')) out = out.slice(0, -1);
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/** Render the magnitude of `value` for `type`, without sign, symbol or padding. */
function renderMagnitude(value: number, spec: NumberFormatSpec): { body: string; suffix: string } {
  const abs = Math.abs(value);
  const p = spec.precision;

  switch (spec.type) {
    case 'e': {
      const text = abs.toExponential(p ?? 6);
      return { body: spec.trim ? trimExponential(text) : text, suffix: '' };
    }
    case 'g': {
      const digits = Math.max(1, p ?? 6);
      const text = abs.toPrecision(digits);
      return { body: spec.trim ? trimZeros(text) : text, suffix: '' };
    }
    case 'r': {
      const digits = Math.max(1, p ?? 6);
      const rounded = Number(abs.toPrecision(digits));
      const decimals = Math.max(0, digits - 1 - Math.floor(safeLog10(rounded)));
      const text = rounded.toFixed(Math.min(decimals, 100));
      return { body: spec.trim ? trimZeros(text) : text, suffix: '' };
    }
    case 's': {
      const { mantissa, prefix } = siForm(abs, p);
      return { body: spec.trim ? trimZeros(mantissa) : mantissa, suffix: prefix };
    }
    case '%': {
      const text = (abs * 100).toFixed(p ?? 0);
      return { body: spec.trim ? trimZeros(text) : text, suffix: '%' };
    }
    case 'p': {
      const scaled = abs * 100;
      const digits = Math.max(1, p ?? 6);
      const text = Number(scaled.toPrecision(digits)).toFixed(
        Math.max(0, digits - 1 - Math.floor(safeLog10(scaled))),
      );
      return { body: spec.trim ? trimZeros(text) : text, suffix: '%' };
    }
    case 'd': {
      return { body: Math.round(abs).toFixed(0), suffix: '' };
    }
    case 'b':
      return { body: Math.round(abs).toString(2), suffix: '' };
    case 'o':
      return { body: Math.round(abs).toString(8), suffix: '' };
    case 'x':
      return { body: Math.round(abs).toString(16), suffix: '' };
    case 'X':
      return { body: Math.round(abs).toString(16).toUpperCase(), suffix: '' };
    case 'c':
      return { body: String.fromCodePoint(Math.max(0, Math.round(abs))), suffix: '' };
    case 'f':
      return {
        body: spec.trim ? trimZeros(abs.toFixed(p ?? 6)) : abs.toFixed(p ?? 6),
        suffix: '',
      };
    default: {
      // No type: fixed when a precision was given, otherwise the shortest
      // round-trip form, which is what an axis label wants.
      const text = p === undefined ? shortest(abs) : abs.toFixed(p);
      return { body: spec.trim ? trimZeros(text) : text, suffix: '' };
    }
  }
}

function trimExponential(text: string): string {
  const at = text.indexOf('e');
  if (at < 0) return trimZeros(text);
  return `${trimZeros(text.slice(0, at))}${text.slice(at)}`;
}

function safeLog10(value: number): number {
  return value === 0 ? 0 : Math.log10(value);
}

function shortest(value: number): string {
  return Number.isInteger(value) ? value.toFixed(0) : String(value);
}

function siForm(abs: number, precision: number | undefined): { mantissa: string; prefix: string } {
  if (abs === 0) return { mantissa: (0).toPrecision(Math.max(1, precision ?? 3)), prefix: '' };
  const exponent = Math.floor(Math.log10(abs) / 3);
  const clamped = Math.max(-8, Math.min(8, exponent));
  const scaled = abs / 10 ** (clamped * 3);
  const digits = Math.max(1, precision ?? 3);
  const rounded = Number(scaled.toPrecision(digits));
  const decimals = Math.max(0, digits - 1 - Math.floor(safeLog10(rounded)));
  return {
    mantissa: rounded.toFixed(Math.min(decimals, 20)),
    prefix: SI_PREFIXES[clamped + 8] ?? '',
  };
}

/** Currency symbol for the built-in `en-US` formatter (SPEC 6.9.3). */
const DEFAULT_CURRENCY_SYMBOL = '$';

/**
 * Format a number with a format string. Never throws; a non-finite value
 * renders as an em dash, because `NaN` on an axis is a bug made visible.
 */
export function formatNumber(value: number, spec: string): string {
  if (!Number.isFinite(value)) return '—';
  const parsed = parseNumberFormat(spec);
  if (parsed === undefined) return shortest(value);
  return applyNumberFormat(value, parsed);
}

/** Format a number with an already-parsed specifier. */
export function applyNumberFormat(value: number, spec: NumberFormatSpec): string {
  if (!Number.isFinite(value)) return '—';

  const negative = value < 0 || Object.is(value, -0);
  const { body, suffix } = renderMagnitude(value, spec);

  let intPart = body;
  let fracPart = '';
  const dot = body.indexOf('.');
  if (dot >= 0) {
    intPart = body.slice(0, dot);
    fracPart = body.slice(dot);
  }
  if (spec.comma) intPart = group(intPart);

  let signText = '';
  if (negative) signText = spec.sign === '(' ? '(' : '-';
  else if (spec.sign === '+') signText = '+';
  else if (spec.sign === ' ') signText = ' ';

  const prefix =
    (spec.symbol === '$' ? DEFAULT_CURRENCY_SYMBOL : '') +
    (spec.symbol === '#' ? radixPrefix(spec.type) : '');
  const closing = negative && spec.sign === '(' ? ')' : '';

  let text = `${signText}${prefix}${intPart}${fracPart}${suffix}${closing}`;

  const width = spec.width;
  if (width !== undefined && text.length < width) {
    const padCount = width - text.length;
    const fill = spec.zero && spec.align === undefined ? '0' : spec.fill;
    const align = spec.align ?? (spec.zero ? '=' : '>');
    if (align === '<') text += fill.repeat(padCount);
    else if (align === '^') {
      const left = Math.floor(padCount / 2);
      text = fill.repeat(left) + text + fill.repeat(padCount - left);
    } else if (align === '=') {
      const head = signText + prefix;
      text = head + fill.repeat(padCount) + text.slice(head.length);
    } else {
      text = fill.repeat(padCount) + text;
    }
  }
  return text;
}

function radixPrefix(type: string | undefined): string {
  switch (type) {
    case 'b':
      return '0b';
    case 'o':
      return '0o';
    case 'x':
    case 'X':
      return '0x';
    default:
      return '';
  }
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

// ─────────────────────────────────────────────────────────────────────────────
// Date format strings (SPEC 6.9.4)
// ─────────────────────────────────────────────────────────────────────────────

/** The presets of SPEC 6.9.4. */
export const DATE_PRESETS: Readonly<Record<string, string>> = Object.freeze({
  iso: '%Y-%m-%dT%H:%M:%SZ',
  date: '%Y-%m-%d',
  time: '%H:%M:%S',
  datetime: '%Y-%m-%d %H:%M',
  month: '%b %Y',
  quarter: 'Q%q %Y',
  year: '%Y',
  relative: 'relative',
});

/**
 * Format an instant with a strftime pattern or a preset (SPEC 6.9.4).
 *
 * `quarter` and `relative` are presets rather than directives, so they are
 * expanded here instead of in the strftime engine — `%q` is not in the SPEC 6.6
 * subset and MUST NOT be accepted in a user-written pattern.
 */
export function formatDate(date: Date, spec: string, zone: TimeZoneSpec, now?: Date): string {
  const preset = DATE_PRESETS[spec];
  if (preset === 'relative') return formatRelative(date, now ?? new Date(0), zone);
  const pattern = preset ?? spec;
  if (pattern.includes('%q')) {
    const w = wallClockIn(date, zone);
    const quarter = Math.floor((w.month - 1) / 3) + 1;
    return formatWithPattern(date, pattern.split('%q').join(String(quarter)), zone);
  }
  return formatWithPattern(date, pattern, zone);
}

/**
 * The `relative` preset. Anchored on the document's build time (`now()`), never
 * on the wall clock, so "3 days ago" is reproducible (SPEC 24.3 rule 2).
 */
export function formatRelative(date: Date, now: Date, zone: TimeZoneSpec): string {
  const delta = date.getTime() - now.getTime();
  const abs = Math.abs(delta);
  const units: readonly [number, string][] = [
    [86400000 * 365, 'year'],
    [86400000 * 30, 'month'],
    [86400000 * 7, 'week'],
    [86400000, 'day'],
    [3600000, 'hour'],
    [60000, 'minute'],
    [1000, 'second'],
  ];
  for (const [ms, name] of units) {
    if (abs >= ms) {
      const count = Math.floor(abs / ms);
      const plural = count === 1 ? '' : 's';
      return delta < 0 ? `${count} ${name}${plural} ago` : `in ${count} ${name}${plural}`;
    }
  }
  void zone;
  return 'now';
}

// ─────────────────────────────────────────────────────────────────────────────
// The options object (SPEC 6.9.2) and the dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/** `format: {style: currency, currency: USD, …}` (SPEC 6.9.2). */
export interface FormatOptionsObject {
  readonly [key: string]: unknown;
}

/** Either spelling of `format:` (SPEC 6.9). */
export type FormatSpecValue = string | FormatOptionsObject;

/** Context a formatter needs that is not in the spec string itself. */
export interface FormatContext {
  locale: string;
  timezone: TimeZoneSpec;
  /** `now()` — the document build time (SPEC 6.8.2). */
  buildTime: Date;
  /** Set when `Intl` was used, so the exporter can record the ICU version. */
  onIntlUse?: (kind: 'number' | 'date') => void;
}

const DEFAULT_LOCALE = 'en-US';

/**
 * Format one cell (SPEC 6.9).
 *
 * Routing, in order:
 * 1. no spec ⇒ the plain rendering of the value;
 * 2. an options object, or a non-`en-US` locale ⇒ `Intl` (and `onIntlUse`);
 * 3. otherwise ⇒ the built-in formatter, which is byte-stable everywhere.
 */
export function formatValue(
  value: Value,
  spec: FormatSpecValue | undefined,
  ctx: FormatContext,
): string {
  if (value === null) return '';
  if (spec === undefined) return plain(value, ctx);

  if (typeof spec === 'object') return formatWithIntl(value, spec, ctx);

  if (value instanceof Date) {
    if (ctx.locale !== DEFAULT_LOCALE && DATE_PRESETS[spec] !== undefined) {
      return formatWithIntl(value, presetToIntl(spec), ctx);
    }
    return formatDate(value, spec, ctx.timezone, ctx.buildTime);
  }
  if (typeof value === 'number') {
    if (ctx.locale !== DEFAULT_LOCALE) return formatWithIntl(value, specToIntl(spec), ctx);
    return formatNumber(value, spec);
  }
  return String(value);
}

function plain(value: Value, ctx: FormatContext): string {
  if (value === null) return '';
  if (value instanceof Date) return formatDate(value, 'iso', ctx.timezone, ctx.buildTime);
  if (typeof value === 'number') return shortest(value);
  return String(value);
}

function presetToIntl(preset: string): FormatOptionsObject {
  switch (preset) {
    case 'date':
      return { year: 'numeric', month: '2-digit', day: '2-digit' };
    case 'time':
      return { hour: '2-digit', minute: '2-digit', second: '2-digit' };
    case 'datetime':
      return {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      };
    case 'month':
      return { year: 'numeric', month: 'short' };
    case 'year':
      return { year: 'numeric' };
    default:
      return { dateStyle: 'medium' };
  }
}

function specToIntl(spec: string): FormatOptionsObject {
  const parsed = parseNumberFormat(spec);
  if (parsed === undefined) return {};
  const options: Record<string, unknown> = {};
  if (parsed.symbol === '$') {
    options['style'] = 'currency';
    options['currency'] = 'USD';
  } else if (parsed.type === '%' || parsed.type === 'p') {
    options['style'] = 'percent';
  }
  if (parsed.precision !== undefined) {
    options['minimumFractionDigits'] = parsed.precision;
    options['maximumFractionDigits'] = parsed.precision;
  }
  options['useGrouping'] = parsed.comma;
  if (parsed.type === 's') options['notation'] = 'compact';
  return options;
}

function formatWithIntl(value: Value, options: FormatOptionsObject, ctx: FormatContext): string {
  const intl = (globalThis as { Intl?: typeof Intl }).Intl;
  if (value instanceof Date) {
    if (intl?.DateTimeFormat === undefined)
      return formatDate(value, 'iso', ctx.timezone, ctx.buildTime);
    ctx.onIntlUse?.('date');
    try {
      return new intl.DateTimeFormat(ctx.locale, {
        timeZone: ctx.timezone,
        ...(options as Intl.DateTimeFormatOptions),
      }).format(value);
    } catch {
      return formatDate(value, 'iso', ctx.timezone, ctx.buildTime);
    }
  }
  if (typeof value === 'number') {
    if (intl?.NumberFormat === undefined) return shortest(value);
    ctx.onIntlUse?.('number');
    try {
      return new intl.NumberFormat(ctx.locale, options as Intl.NumberFormatOptions).format(value);
    } catch {
      return shortest(value);
    }
  }
  return String(value);
}

/**
 * Deterministic value formatting for axis ticks, direct labels, readouts and the
 * table view (SPEC 6.9).
 *
 * **Why this is not `Intl`.** SPEC 24.3 requires byte-identical output for the
 * same source, config and version. `Intl.NumberFormat` and `Intl.DateTimeFormat`
 * resolve against the host's ICU tables, which differ between Node builds,
 * browsers and operating systems: the same document would produce two different
 * PDFs. Everything here is computed from first principles instead.
 *
 * The trade-off is honest and bounded: separators and month/day names follow the
 * `en` convention regardless of `locale`. Full locale data belongs in
 * `@mdv/core`'s formatter (CONTRACTS §3 lists formatting as core's concern); when
 * that lands, this module becomes a thin adapter and every call site is unchanged.
 */

import { isFiniteNumber } from './num.js';

/** SI prefixes for the `s` format type, exponent −24 … +24 in steps of 3. */
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
/** Index of the empty (10^0) prefix in {@link SI_PREFIXES}. */
const SI_ZERO_INDEX = 8;

const CURRENCY_SYMBOLS = new Set(['$', '€', '£', '¥', '₩', '₹']);

/**
 * The values `format` takes in its *other* meaning: the data-section syntax
 * enum (SPEC 6.2, and the common-attribute table at SPEC 1198).
 */
const DATA_SECTION_FORMATS = new Set([
  'auto',
  'table',
  'csv',
  'tsv',
  'json',
  'ndjson',
  'columns',
  'matrix',
]);

/**
 * Read `format` from a block's attribute bag as a *number* format.
 *
 * One key, two meanings: `format` is the data-section syntax on every block
 * (SPEC 6.2), and the number format on the handful of one-number forms that
 * declare it in their key attributes (`metric`, SPEC 8.13). A block that
 * carries an inline table and writes `format: table` means the first, so
 * spending it on the second appends the word to the reading — a gauge that
 * says `99.94table` is a wrong number on the page, not a styling slip.
 *
 * Data-section names are therefore never number formats. Nothing is reported:
 * the attribute was not ignored, it was honoured by the reader.
 */
export function numberFormatAttr(format: string | undefined): string | undefined {
  if (format === undefined) return undefined;
  return DATA_SECTION_FORMATS.has(format.trim()) ? undefined : format;
}

/** A parsed d3-style number pattern. */
export interface NumberFormatSpec {
  prefix: string;
  /** `+` forces a sign on positives. */
  sign: '' | '+';
  group: boolean;
  precision?: number;
  /** `~` trims insignificant trailing zeros. */
  trim: boolean;
  type: 'f' | 'e' | 'g' | 'd' | 's' | '%' | 'auto';
  suffix: string;
}

/**
 * Parse the d3-format subset MDV uses: `[symbol][sign][,][.precision][~][type]`.
 *
 * Unrecognised input degrades to `auto` rather than throwing — a bad format
 * string must never take out a block (SPEC 14.1).
 */
export function parseNumberFormat(spec: string): NumberFormatSpec {
  const out: NumberFormatSpec = {
    prefix: '',
    sign: '',
    group: false,
    trim: false,
    type: 'auto',
    suffix: '',
  };
  let i = 0;
  while (i < spec.length) {
    const ch = spec[i];
    if (ch === undefined || !CURRENCY_SYMBOLS.has(ch)) break;
    out.prefix += ch;
    i += 1;
  }
  if (spec[i] === '+') {
    out.sign = '+';
    i += 1;
  } else if (spec[i] === '-' || spec[i] === ' ') {
    i += 1;
  }
  if (spec[i] === ',') {
    out.group = true;
    i += 1;
  }
  if (spec[i] === '.') {
    i += 1;
    let digits = '';
    while (i < spec.length) {
      const d = spec[i];
      if (d === undefined || d < '0' || d > '9') break;
      digits += d;
      i += 1;
    }
    if (digits !== '') out.precision = Number.parseInt(digits, 10);
  }
  if (spec[i] === '~') {
    out.trim = true;
    i += 1;
  }
  const type = spec[i];
  if (
    type === 'f' ||
    type === 'e' ||
    type === 'g' ||
    type === 'd' ||
    type === 's' ||
    type === '%'
  ) {
    out.type = type;
    i += 1;
  }
  out.suffix = spec.slice(i);
  return out;
}

/** Insert `,` every three digits of an integer-part string. */
function group(intPart: string): string {
  if (intPart.length <= 3) return intPart;
  let out = '';
  let count = 0;
  for (let i = intPart.length - 1; i >= 0; i -= 1) {
    out = `${intPart[i] ?? ''}${out}`;
    count += 1;
    if (count % 3 === 0 && i > 0) out = `,${out}`;
  }
  return out;
}

/** Drop trailing fractional zeros (and a bare trailing point). */
function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  let out = text;
  while (out.endsWith('0')) out = out.slice(0, -1);
  if (out.endsWith('.')) out = out.slice(0, -1);
  return out;
}

/** `toFixed` without the `-0` artefact, and with grouping applied to the integer part. */
function fixed(value: number, precision: number, useGrouping: boolean, trim: boolean): string {
  const p = precision < 0 ? 0 : precision > 20 ? 20 : precision;
  let text = Math.abs(value).toFixed(p);
  if (trim) text = trimZeros(text);
  if (useGrouping) {
    const dot = text.indexOf('.');
    const intPart = dot === -1 ? text : text.slice(0, dot);
    const rest = dot === -1 ? '' : text.slice(dot);
    text = group(intPart) + rest;
  }
  return text;
}

/** Significant-digit rounding, used by `s` and `g`. */
function toPrecisionDigits(value: number, digits: number): string {
  const d = digits < 1 ? 1 : digits > 21 ? 21 : digits;
  const text = value.toPrecision(d);
  // `toPrecision` may return exponential form; normalise back to plain decimal.
  return text.includes('e') ? String(Number.parseFloat(text)) : text;
}

/** Format with an SI prefix (`12900` → `12.9k`). */
function siFormat(
  value: number,
  precision: number | undefined,
  trim: boolean,
  useGrouping: boolean,
): string {
  const abs = Math.abs(value);
  if (abs === 0) return fixed(0, precision ?? 0, useGrouping, trim);
  const exponent = Math.floor(Math.log10(abs) / 3) * 3;
  const clampedExp = Math.max(-24, Math.min(24, exponent));
  const index = clampedExp / 3 + SI_ZERO_INDEX;
  const prefix = SI_PREFIXES[index] ?? '';
  const scaled = value / 10 ** clampedExp;
  const digits = precision ?? 3;
  let mantissa = toPrecisionDigits(Math.abs(scaled), digits);
  if (trim) mantissa = trimZeros(mantissa);
  return `${mantissa}${prefix}`;
}

/**
 * Choose a readable representation when the author supplied no format.
 *
 * Integers group and show no decimals; fractions keep enough decimals to carry
 * about four significant digits, with trailing zeros trimmed.
 */
function autoFormat(value: number, useGrouping = true): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return useGrouping ? group(Math.abs(value).toFixed(0)) : Math.abs(value).toFixed(0);
  }
  const abs = Math.abs(value);
  if (abs >= 1e15 || (abs < 1e-4 && abs > 0)) {
    return Math.abs(value).toExponential(3);
  }
  const magnitude = abs === 0 ? 0 : Math.floor(Math.log10(abs));
  const decimals = Math.max(0, Math.min(10, 3 - magnitude));
  return fixed(Math.abs(value), decimals, useGrouping, true);
}

/**
 * Format a number against a d3-style pattern.
 *
 * Non-finite input yields an em dash: a chart with gaps must look like it has
 * gaps (SPEC 6.5), and `"NaN"` in an axis label is a bug made visible.
 */
export function formatNumber(value: number | null | undefined, spec?: string): string {
  if (!isFiniteNumber(value)) return '—';
  const parsed = spec === undefined || spec === '' ? undefined : parseNumberFormat(spec);
  const negative = value < 0;
  let body: string;
  if (parsed === undefined) {
    body = autoFormat(value);
  } else {
    switch (parsed.type) {
      case 'f':
        body = fixed(value, parsed.precision ?? 0, parsed.group, parsed.trim);
        break;
      case 'd':
        body = fixed(Math.round(Math.abs(value)) * (negative ? -1 : 1), 0, parsed.group, false);
        break;
      case '%': {
        const scaled = value * 100;
        body = `${fixed(scaled, parsed.precision ?? 0, parsed.group, parsed.trim)}%`;
        break;
      }
      case 's':
        body = siFormat(value, parsed.precision, parsed.trim, parsed.group);
        break;
      case 'e':
        body = Math.abs(value).toExponential(parsed.precision ?? 6);
        break;
      case 'g':
        body = toPrecisionDigits(Math.abs(value), parsed.precision ?? 6);
        break;
      default:
        body =
          parsed.precision === undefined
            ? autoFormat(value, parsed.group || spec?.includes(',') === true)
            : fixed(value, parsed.precision, parsed.group, parsed.trim);
    }
  }
  const signText = negative ? '-' : parsed?.sign === '+' ? '+' : '';
  return `${signText}${parsed?.prefix ?? ''}${body}${parsed?.suffix ?? ''}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates (SPEC 6.6, 6.9)
// ─────────────────────────────────────────────────────────────────────────────

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function pad(value: number, width: number): string {
  const text = String(Math.abs(Math.trunc(value)));
  return text.length >= width ? text : '0'.repeat(width - text.length) + text;
}

/**
 * Format a date against the strftime subset of SPEC 6.6.
 *
 * All fields are read in **UTC**. A temporal axis must not depend on the host's
 * zone (SPEC 6.6): the document's `timezone` is applied by shifting the instant
 * before it reaches here, so the getters below are deliberately the UTC ones.
 */
export function formatDate(date: Date, spec = '%Y-%m-%d'): string {
  const time = date.getTime();
  if (!Number.isFinite(time)) return '—';
  let out = '';
  for (let i = 0; i < spec.length; i += 1) {
    const ch = spec[i];
    if (ch !== '%') {
      out += ch ?? '';
      continue;
    }
    i += 1;
    let noPad = false;
    if (spec[i] === '-') {
      noPad = true;
      i += 1;
    }
    const token = spec[i];
    const p = (value: number, width: number): string =>
      noPad ? String(Math.trunc(value)) : pad(value, width);
    switch (token) {
      case 'Y':
        out += String(date.getUTCFullYear());
        break;
      case 'y':
        out += pad(date.getUTCFullYear() % 100, 2);
        break;
      case 'm':
        out += p(date.getUTCMonth() + 1, 2);
        break;
      case 'd':
        out += p(date.getUTCDate(), 2);
        break;
      case 'H':
        out += p(date.getUTCHours(), 2);
        break;
      case 'M':
        out += p(date.getUTCMinutes(), 2);
        break;
      case 'S':
        out += p(date.getUTCSeconds(), 2);
        break;
      case 'L':
        out += pad(date.getUTCMilliseconds(), 3);
        break;
      case 'b':
        out += MONTHS_SHORT[date.getUTCMonth()] ?? '';
        break;
      case 'B':
        out += MONTHS_LONG[date.getUTCMonth()] ?? '';
        break;
      case 'a':
        out += DAYS_SHORT[date.getUTCDay()] ?? '';
        break;
      case 'A':
        out += DAYS_LONG[date.getUTCDay()] ?? '';
        break;
      case 'j': {
        const start = Date.UTC(date.getUTCFullYear(), 0, 1);
        out += pad(Math.floor((time - start) / 86_400_000) + 1, 3);
        break;
      }
      case 'p':
        out += date.getUTCHours() < 12 ? 'AM' : 'PM';
        break;
      case 'z':
        out += '+0000';
        break;
      case '%':
        out += '%';
        break;
      default:
        out += `%${token ?? ''}`;
    }
  }
  return out;
}

/** Humanise a field name for an axis or legend title: `total_revenue` → `Total revenue`. */
export function humanise(field: string): string {
  const spaced = field
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  if (spaced === '') return field;
  const lower = spaced.toLowerCase();
  return (lower[0] ?? '').toUpperCase() + lower.slice(1);
}

/** Format any cell value for the table view and readouts. */
export function formatValue(value: unknown, spec?: string): string {
  if (value === null || value === undefined) return '—';
  if (value instanceof Date) return formatDate(value, spec ?? '%Y-%m-%d');
  if (typeof value === 'number') return formatNumber(value, spec);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * What a cell is called when the name is its **identity** — a category, a node,
 * a parent reference — or `undefined` when it names nothing.
 *
 * Deliberately not {@link formatValue}. That one answers a display question and
 * renders a missing cell as `—`, because a table view has to put something in
 * the gap. A chart that keyed off it would take the dash at its word: every row
 * that forgot to say anything would pile up into one tile or one band called
 * `—`, sized by their total, sitting in the picture as if the author had written
 * a category by that name. A row with no key has no identity, and the caller
 * drops it and counts it among `droppedRows` like any other unusable row.
 */
export function keyValue(value: unknown, spec?: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = formatValue(value, spec);
  return text === '' ? undefined : text;
}

/**
 * Expand a `labelFormat` template such as
 * `"{category}: {value:,.0f} ({percent:.0%})"` (SPEC 8.5).
 *
 * An unknown placeholder is left verbatim so the author can see their typo,
 * rather than silently rendering an empty label.
 */
export function expandTemplate(
  template: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  return template.replace(/\{(\w+)(?::([^}]*))?\}/g, (whole, name: string, spec?: string) => {
    if (!Object.hasOwn(fields, name)) return whole;
    return formatValue(fields[name], spec);
  });
}

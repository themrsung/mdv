/**
 * Deterministic value formatting (SPEC 6.9, 7.3, 11.5).
 *
 * Two grammars, one entry point:
 *
 * - a **d3-format** number pattern — `",.0f"`, `"$,.2f"`, `".1%"`, `"~s"`;
 * - a **strftime** date pattern — `"%b %Y"`, `"%Y-%m-%d %H:%M"`.
 *
 * Neither goes through `Intl.NumberFormat` or `Intl.DateTimeFormat` for the
 * output text. ICU data differs between Node builds, browsers and OS versions,
 * so an Intl-formatted axis label is not reproducible across machines — exactly
 * what SPEC 24.3 forbids. Locale sensitivity is limited to a bundled separator
 * table and bundled English month/day names; anything richer belongs in the
 * embedder, which can format values itself and bind the strings as fields.
 *
 * `Intl` is used in one narrow place — {@link zoneOffsetMinutes} — to turn an
 * IANA zone name into a UTC offset. That is a lookup, not a rendering, and it is
 * wrapped so a host without the zone falls back to UTC rather than throwing.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Locale conventions (bundled, deterministic)
// ─────────────────────────────────────────────────────────────────────────────

/** Group and decimal separators for one locale family. */
export interface NumberConventions {
  /** Thousands separator. */
  group: string;
  /** Decimal separator. */
  decimal: string;
  /** Currency symbol used by the `$` d3 symbol. */
  currency: string;
}

const EN: NumberConventions = { group: ',', decimal: '.', currency: '$' };

/**
 * Bundled conventions, keyed by the primary subtag (and a few full tags).
 *
 * Deliberately small. A locale that is not listed formats as `en-US`; that is a
 * documented limitation, not a silent fallback — {@link numberConventions}
 * always returns a defined value so no caller has to branch.
 */
const CONVENTIONS: Readonly<Record<string, NumberConventions>> = Object.freeze({
  en: EN,
  'en-in': { group: ',', decimal: '.', currency: '₹' },
  de: { group: '.', decimal: ',', currency: '€' },
  'de-ch': { group: '’', decimal: '.', currency: 'CHF' },
  es: { group: '.', decimal: ',', currency: '€' },
  it: { group: '.', decimal: ',', currency: '€' },
  nl: { group: '.', decimal: ',', currency: '€' },
  pt: { group: '.', decimal: ',', currency: 'R$' },
  id: { group: '.', decimal: ',', currency: 'Rp' },
  tr: { group: '.', decimal: ',', currency: '₺' },
  fr: { group: ' ', decimal: ',', currency: '€' },
  ru: { group: ' ', decimal: ',', currency: '₽' },
  pl: { group: ' ', decimal: ',', currency: 'zł' },
  cs: { group: ' ', decimal: ',', currency: 'Kč' },
  sv: { group: ' ', decimal: ',', currency: 'kr' },
  fi: { group: ' ', decimal: ',', currency: '€' },
  nb: { group: ' ', decimal: ',', currency: 'kr' },
  ja: { group: ',', decimal: '.', currency: '¥' },
  ko: { group: ',', decimal: '.', currency: '₩' },
  zh: { group: ',', decimal: '.', currency: '¥' },
});

/** Conventions for a BCP 47 tag, falling back to `en-US`. */
export function numberConventions(locale: string): NumberConventions {
  const tag = locale.toLowerCase();
  return CONVENTIONS[tag] ?? CONVENTIONS[tag.split('-')[0] ?? ''] ?? EN;
}

/** Bundled English month names — deterministic, never from the host's ICU. */
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
] as const;

const DAYS_LONG = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────

/** A parsed d3-format specifier. */
export interface NumberFormatSpec {
  fill: string;
  align: '>' | '<' | '^' | '=' | '';
  sign: '-' | '+' | '(' | ' ';
  symbol: '$' | '#' | '';
  zero: boolean;
  width: number;
  comma: boolean;
  precision: number | undefined;
  trim: boolean;
  type: string;
}

const FORMAT_RE = /^(?:(.)?([<>=^]))?([+\-( ])?([$#])?(0)?(\d+)?(,)?(?:\.(\d+))?(~)?([a-z%])?$/i;

/**
 * Parse a d3-format specifier.
 *
 * @returns the parsed spec, or `undefined` when the pattern is not a number
 * pattern (a strftime pattern, or nonsense). Callers treat `undefined` as "not
 * mine" rather than as an error — {@link formatValue} then tries the date
 * grammar.
 */
export function parseNumberFormat(pattern: string): NumberFormatSpec | undefined {
  const m = FORMAT_RE.exec(pattern);
  if (m === null) return undefined;
  const [, fill, align, sign, symbol, zero, width, comma, precision, trim, type] = m;
  // A bare `""` matches the regex but carries no instruction; treat it as default.
  const spec: NumberFormatSpec = {
    fill: fill ?? ' ',
    align: (align as NumberFormatSpec['align']) ?? '',
    sign: (sign as NumberFormatSpec['sign']) ?? '-',
    symbol: (symbol as NumberFormatSpec['symbol']) ?? '',
    zero: zero === '0',
    width: width === undefined ? 0 : Number.parseInt(width, 10),
    comma: comma === ',',
    precision: precision === undefined ? undefined : Number.parseInt(precision, 10),
    trim: trim === '~',
    type: type ?? '',
  };
  if (spec.zero && spec.align === '') {
    spec.align = '=';
    if (fill === undefined) spec.fill = '0';
  }
  return spec;
}

/** SI prefixes for the `s` type, from 10⁻²⁴ to 10²⁴. */
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

/** Insert group separators into the integer part of a digit string. */
function group(digits: string, separator: string): string {
  if (separator === '' || digits.length <= 3) return digits;
  let out = '';
  let count = 0;
  for (let i = digits.length - 1; i >= 0; --i) {
    out = digits[i] + out;
    if (++count % 3 === 0 && i > 0) out = separator + out;
  }
  return out;
}

/** Strip trailing fractional zeros (the `~` flag), keeping at least one digit. */
function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  let end = text.length;
  while (end > 0 && text[end - 1] === '0') --end;
  if (end > 0 && text[end - 1] === '.') --end;
  return text.slice(0, end);
}

/** Split a decimal string into its sign, integer digits and fraction digits. */
function split(text: string): { negative: boolean; int: string; frac: string } {
  const negative = text.startsWith('-');
  const body = negative ? text.slice(1) : text;
  const dot = body.indexOf('.');
  return dot === -1
    ? { negative, int: body, frac: '' }
    : { negative, int: body.slice(0, dot), frac: body.slice(dot + 1) };
}

/**
 * Format a number against a parsed d3-format spec.
 *
 * `toFixed`, `toPrecision` and `toExponential` are used for the digit
 * production: their results are pinned by ECMA-262, so they are identical on
 * every conforming engine — unlike `Intl`.
 */
export function formatNumberSpec(
  value: number,
  spec: NumberFormatSpec,
  conventions: NumberConventions,
): string {
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return value > 0 ? '∞' : '−∞';

  let scaled = value;
  let suffix = '';
  let body: string;

  switch (spec.type) {
    case '%': {
      scaled = value * 100;
      suffix = '%';
      body = scaled.toFixed(spec.precision ?? 0);
      break;
    }
    case 'p': {
      scaled = value * 100;
      suffix = '%';
      body = scaled.toPrecision(Math.max(1, spec.precision ?? 6));
      break;
    }
    case 'e': {
      body = value.toExponential(spec.precision ?? 6);
      break;
    }
    case 'd': {
      body = Math.round(value).toFixed(0);
      break;
    }
    case 'r': {
      body = value.toPrecision(Math.max(1, spec.precision ?? 6));
      if (body.includes('e')) body = Number.parseFloat(body).toString();
      break;
    }
    case 's': {
      const magnitude = Math.abs(value);
      let exp = magnitude === 0 ? 0 : Math.floor(Math.log(magnitude) / Math.LN10 / 3) * 3;
      exp = Math.max(-24, Math.min(24, exp));
      const prefix = SI_PREFIXES[exp / 3 + 8] ?? '';
      scaled = value / 10 ** exp;
      // Re-normalise 1000k → 1M after rounding pushed it over the decade.
      const rounded = Number.parseFloat(scaled.toFixed(spec.precision ?? 2));
      if (Math.abs(rounded) >= 1000 && exp < 24) {
        scaled = rounded / 1000;
        suffix = SI_PREFIXES[exp / 3 + 9] ?? prefix;
      } else {
        scaled = rounded;
        suffix = prefix;
      }
      body = scaled.toFixed(spec.precision ?? 2);
      break;
    }
    case 'g': {
      body = value.toPrecision(Math.max(1, spec.precision ?? 6));
      if (body.includes('e')) {
        const n = Number.parseFloat(body);
        body = Math.abs(n) >= 1e-6 && Math.abs(n) < 1e21 ? n.toString() : body;
      }
      break;
    }
    case 'f':
    default: {
      body =
        spec.precision === undefined
          ? formatDefault(value)
          : value.toFixed(Math.min(100, spec.precision));
      break;
    }
  }

  if (spec.trim) body = trimZeros(body);

  const parts = split(body);
  let digits = spec.comma ? group(parts.int, conventions.group) : parts.int;
  if (parts.frac !== '') digits += conventions.decimal + parts.frac;

  const currency = spec.symbol === '$' ? conventions.currency : '';
  const negative = parts.negative && Number.parseFloat(body) !== 0;
  let signText = '';
  if (negative) signText = spec.sign === '(' ? '(' : '−';
  else if (spec.sign === '+') signText = '+';
  else if (spec.sign === ' ') signText = ' ';

  const closing = negative && spec.sign === '(' ? ')' : '';
  const prefix = signText + currency;
  const core = prefix + digits + suffix + closing;

  return pad(core, prefix, spec);
}

/** Apply `width`, `fill` and `align`. `=` pads between the sign and the digits. */
function pad(core: string, prefix: string, spec: NumberFormatSpec): string {
  const deficit = spec.width - core.length;
  if (deficit <= 0) return core;
  const filler = spec.fill.repeat(deficit);
  switch (spec.align) {
    case '<':
      return core + filler;
    case '^': {
      const left = deficit >> 1;
      return spec.fill.repeat(left) + core + spec.fill.repeat(deficit - left);
    }
    case '=':
      return prefix + filler + core.slice(prefix.length);
    case '>':
    default:
      return filler + core;
  }
}

/**
 * The default rendering of a number with no explicit precision: the shortest
 * round-trippable decimal, minus JavaScript's exponent notation for values a
 * reader would rather see in full.
 */
function formatDefault(value: number): string {
  if (Number.isInteger(value) && Math.abs(value) < 1e21) return value.toFixed(0);
  const text = value.toString();
  if (!text.includes('e')) return text;
  // Small magnitudes: expand to plain decimal rather than showing `1e-7`.
  const abs = Math.abs(value);
  if (abs > 0 && abs < 1e-6) return value.toFixed(Math.min(100, 20));
  return text;
}

/** Format a number with a d3-format pattern. An unparseable pattern is ignored. */
export function formatNumber(value: number, pattern: string | undefined, locale: string): string {
  const conventions = numberConventions(locale);
  const spec = pattern === undefined || pattern === '' ? undefined : parseNumberFormat(pattern);
  if (spec === undefined) {
    return formatNumberSpec(value, { ...DEFAULT_NUMBER_SPEC, comma: true }, conventions);
  }
  return formatNumberSpec(value, spec, conventions);
}

/** A neutral spec: no width, no symbol, minus sign, natural precision. */
export const DEFAULT_NUMBER_SPEC: NumberFormatSpec = Object.freeze({
  fill: ' ',
  align: '' as const,
  sign: '-' as const,
  symbol: '' as const,
  zero: false,
  width: 0,
  comma: false,
  precision: undefined,
  trim: false,
  type: '',
});

/**
 * The axis-tick number format (SPEC 11.5): clean numbers, thousands-separated,
 * with exactly the decimals the step requires.
 */
export function tickNumberFormatter(step: number, locale: string): (value: number) => string {
  const conventions = numberConventions(locale);
  const magnitude = Math.abs(step);
  // Very large or very small ladders read better with an SI prefix than with
  // twelve digits or eight leading zeros.
  const useSi = magnitude !== 0 && (magnitude >= 1e6 || magnitude < 1e-4);
  const decimals = useSi ? 0 : decimalsFor(step);
  const spec: NumberFormatSpec = useSi
    ? { ...DEFAULT_NUMBER_SPEC, type: 's', precision: 3, trim: true }
    : { ...DEFAULT_NUMBER_SPEC, type: 'f', precision: decimals, comma: true };
  return (value) => formatNumberSpec(value, spec, conventions);
}

/** Decimal places needed to write `step` exactly, capped at 10. */
function decimalsFor(step: number): number {
  if (!Number.isFinite(step) || step === 0) return 0;
  for (let d = 0; d <= 10; ++d) {
    const scaled = step * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-9 * Math.max(1, Math.abs(scaled))) return d;
  }
  return 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dates
// ─────────────────────────────────────────────────────────────────────────────

/** Civil (wall-clock) fields of an instant in some zone. */
export interface CivilTime {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
  /** 0 = Sunday. */
  weekday: number;
  /** Minutes east of UTC. */
  offsetMinutes: number;
}

/** Cache of zone-offset probes, keyed by `zone|instant-hour`. Insertion-ordered. */
const OFFSET_CACHE = new Map<string, number>();

/**
 * Minutes east of UTC for `instant` in `timeZone`.
 *
 * `UTC`, the empty string and fixed `±HH:MM` offsets are computed arithmetically.
 * A named IANA zone is resolved through `Intl.DateTimeFormat`, which is a data
 * lookup rather than a rendering; if the host cannot resolve the zone the
 * function returns 0 (UTC) instead of throwing, because a missing zone must not
 * take out a document.
 */
export function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const zone = timeZone === '' ? 'UTC' : timeZone;
  if (zone === 'UTC' || zone === 'Etc/UTC' || zone === 'Z' || zone === 'GMT') return 0;

  const fixed = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
  if (fixed !== null) {
    const hours = Number.parseInt(fixed[2] ?? '0', 10);
    const minutes = Number.parseInt(fixed[3] ?? '0', 10);
    return (fixed[1] === '-' ? -1 : 1) * (hours * 60 + minutes);
  }

  const time = instant.getTime();
  if (!Number.isFinite(time)) return 0;
  const bucket = Math.floor(time / 3_600_000);
  const key = `${zone}|${bucket}`;
  const cached = OFFSET_CACHE.get(key);
  if (cached !== undefined) return cached;

  let offset = 0;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(instant);
    const field = (name: string): number => {
      for (const part of parts) if (part.type === name) return Number.parseInt(part.value, 10);
      return 0;
    };
    const hour = field('hour') % 24;
    const asUtc = Date.UTC(
      field('year'),
      field('month') - 1,
      field('day'),
      hour,
      field('minute'),
      field('second'),
    );
    offset = Math.round((asUtc - Math.floor(time / 1000) * 1000) / 60_000);
  } catch {
    offset = 0;
  }
  OFFSET_CACHE.set(key, offset);
  return offset;
}

/** Decompose an instant into the civil fields of `timeZone`. */
export function toCivil(instant: Date, timeZone: string): CivilTime {
  const offsetMinutes = zoneOffsetMinutes(instant, timeZone);
  const shifted = new Date(instant.getTime() + offsetMinutes * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    weekday: shifted.getUTCDay(),
    offsetMinutes,
  };
}

/**
 * Rebuild an instant from civil fields in `timeZone`.
 *
 * Two passes: the first guesses the offset from the naive UTC reading, the
 * second corrects it when the guess landed on the other side of a DST
 * transition.
 */
export function fromCivil(
  fields: {
    year: number;
    month: number;
    day: number;
    hour?: number;
    minute?: number;
    second?: number;
    millisecond?: number;
  },
  timeZone: string,
): Date {
  const naive = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour ?? 0,
    fields.minute ?? 0,
    fields.second ?? 0,
    fields.millisecond ?? 0,
  );
  const guess = zoneOffsetMinutes(new Date(naive), timeZone);
  const first = naive - guess * 60_000;
  const corrected = zoneOffsetMinutes(new Date(first), timeZone);
  return new Date(corrected === guess ? first : naive - corrected * 60_000);
}

/** Zero-pad to `width` digits. */
function pad2(value: number, width = 2): string {
  const text = Math.abs(value).toFixed(0);
  const body = text.length >= width ? text : '0'.repeat(width - text.length) + text;
  return value < 0 ? `-${body}` : body;
}

/** Day of the year, 1-based. */
function dayOfYear(civil: CivilTime): number {
  const start = Date.UTC(civil.year, 0, 1);
  const here = Date.UTC(civil.year, civil.month - 1, civil.day);
  return Math.round((here - start) / 86_400_000) + 1;
}

/**
 * Format an instant with a strftime pattern.
 *
 * Supported directives: `%a %A %b %B %d %e %f %F %H %I %j %L %m %M %p %S %T %u
 * %y %Y %Z %%`, each optionally with `-` to suppress zero-padding (`%-d`).
 * An unknown directive is emitted verbatim, so a stray `%` never destroys a
 * label.
 */
export function formatDate(instant: Date, pattern: string, timeZone: string): string {
  if (Number.isNaN(instant.getTime())) return '';
  const c = toCivil(instant, timeZone);
  let out = '';
  for (let i = 0; i < pattern.length; ++i) {
    if (pattern[i] !== '%') {
      out += pattern[i];
      continue;
    }
    let j = i + 1;
    let padded = true;
    if (pattern[j] === '-') {
      padded = false;
      ++j;
    }
    const directive = pattern[j];
    if (directive === undefined) {
      out += '%';
      break;
    }
    out += directiveText(directive, c, padded, timeZone, pattern.slice(i, j + 1));
    i = j;
  }
  return out;
}

function directiveText(
  directive: string,
  c: CivilTime,
  padded: boolean,
  timeZone: string,
  verbatim: string,
): string {
  const n = (value: number, width = 2): string => (padded ? pad2(value, width) : value.toFixed(0));
  switch (directive) {
    case 'a':
      return (DAYS_LONG[c.weekday] ?? '').slice(0, 3);
    case 'A':
      return DAYS_LONG[c.weekday] ?? '';
    case 'b':
    case 'h':
      return (MONTHS_LONG[c.month - 1] ?? '').slice(0, 3);
    case 'B':
      return MONTHS_LONG[c.month - 1] ?? '';
    case 'd':
      return n(c.day);
    case 'e':
      return padded ? (c.day < 10 ? ` ${c.day}` : `${c.day}`) : `${c.day}`;
    case 'f':
    case 'L':
      return pad2(c.millisecond, 3);
    case 'F':
      return `${pad2(c.year, 4)}-${pad2(c.month)}-${pad2(c.day)}`;
    case 'H':
      return n(c.hour);
    case 'I':
      return n(c.hour % 12 === 0 ? 12 : c.hour % 12);
    case 'j':
      return pad2(dayOfYear(c), 3);
    case 'm':
      return n(c.month);
    case 'M':
      return n(c.minute);
    case 'p':
      return c.hour < 12 ? 'AM' : 'PM';
    case 'S':
      return n(c.second);
    case 'T':
      return `${pad2(c.hour)}:${pad2(c.minute)}:${pad2(c.second)}`;
    case 'u':
      return `${c.weekday === 0 ? 7 : c.weekday}`;
    case 'y':
      return pad2(c.year % 100);
    case 'Y':
      return padded ? pad2(c.year, 4) : `${c.year}`;
    case 'Z':
      return offsetLabel(c.offsetMinutes, timeZone);
    case '%':
      return '%';
    default:
      return verbatim;
  }
}

/** `UTC`, or `+HH:MM` for anything else — never an abbreviation from the host. */
function offsetLabel(offsetMinutes: number, timeZone: string): string {
  if (offsetMinutes === 0) return timeZone === '' ? 'UTC' : timeZone === 'UTC' ? 'UTC' : '+00:00';
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** `true` when a pattern looks like strftime rather than d3-format. */
export function isDatePattern(pattern: string): boolean {
  return /%[-]?[a-zA-Z%]/.test(pattern);
}

// ─────────────────────────────────────────────────────────────────────────────
// The dispatcher
// ─────────────────────────────────────────────────────────────────────────────

/** Everything {@link formatValue} needs that is not the value itself. */
export interface FormatContext {
  locale: string;
  timezone: string;
}

/**
 * Format any cell value for display (SPEC 6.9).
 *
 * `null` becomes the empty string: a readout row reading "null" is worse than a
 * blank one, and the table view marks missing cells the same way.
 */
export function formatValue(
  value: number | string | boolean | Date | null,
  pattern: string | undefined,
  ctx: FormatContext,
): string {
  if (value === null) return '';
  if (value instanceof Date) {
    return formatDate(
      value,
      pattern !== undefined && pattern !== '' ? pattern : '%Y-%m-%d',
      ctx.timezone,
    );
  }
  if (typeof value === 'number') {
    if (pattern !== undefined && pattern !== '' && isDatePattern(pattern)) {
      return formatDate(new Date(value), pattern, ctx.timezone);
    }
    return formatNumber(value, pattern, ctx.locale);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

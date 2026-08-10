/**
 * The MDVX function whitelist (SPEC 6.8.2).
 *
 * > Only these identifiers may be called. There is no member access (`a.b`), no
 * > indexing on arbitrary objects, no `this`, and no way to reach a host object.
 *
 * The table below *is* the whitelist: an identifier absent from it is `MDV2220`
 * at compile time, so an unknown call never reaches evaluation. Every entry is a
 * plain function over {@link ExprValue}s — nothing here closes over the host.
 */

import { formatValue, type FormatContext } from '../data/format.js';
import { parseIso8601, type TimeZoneSpec } from '../data/temporal.js';
import { parseLooseNumber } from '../data/scalar.js';
import { instantFromWallClock } from '../data/temporal.js';
import { wallClockIn } from '../data/strftime.js';
import type { Value } from '../types/data.js';
import {
  asNumber,
  equals,
  isList,
  truthy,
  typeName,
  type ExprValue,
  type TypeErrorSink,
} from './values.js';

/** What a function body may read besides its arguments. */
export interface FunctionContext extends TypeErrorSink {
  /** The document timezone (SPEC 6.6). Never the host zone. */
  zone: TimeZoneSpec;
  /** `now()` — the build time, never a per-call clock read (SPEC 6.8.2). */
  buildTime: Date;
  /** Formatting context for `format()`. */
  format: FormatContext;
  /** `true` inside `aggregate`, where field references yield whole columns. */
  aggregate: boolean;
}

/** A whitelisted function. Arguments arrive already evaluated. */
export interface FunctionDef {
  /** Minimum argument count; fewer is `MDV2200` at compile time. */
  min: number;
  /** Maximum argument count, or `Infinity` for variadic. */
  max: number;
  /** `true` for the SPEC 6.8.2 stats group, legal only in an aggregate context. */
  aggregateOnly?: boolean;
  call(args: readonly ExprValue[], ctx: FunctionContext): ExprValue;
}

// ─────────────────────────────────────────────────────────────────────────────
// Argument helpers
// ─────────────────────────────────────────────────────────────────────────────

const MISSING = Symbol('missing');

/** A numeric argument, or `null` when the argument is null (propagation). */
function num(
  args: readonly ExprValue[],
  index: number,
  name: string,
  ctx: FunctionContext,
): number | null | typeof MISSING {
  const value = args[index];
  if (value === undefined || value === null) return null;
  const n = asNumber(value);
  if (n === undefined) {
    ctx.fail(`${name}() needs a number, not ${typeName(value)}`);
    return MISSING;
  }
  return n;
}

function str(
  args: readonly ExprValue[],
  index: number,
  name: string,
  ctx: FunctionContext,
): string | null | typeof MISSING {
  const value = args[index];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    ctx.fail(`${name}() needs a string, not ${typeName(value)}`);
    return MISSING;
  }
  return value;
}

function date(
  args: readonly ExprValue[],
  index: number,
  name: string,
  ctx: FunctionContext,
): Date | null | typeof MISSING {
  const value = args[index];
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value;
  ctx.fail(`${name}() needs a date, not ${typeName(value)}`);
  return MISSING;
}

/** A one-argument numeric function with null propagation. */
function math1(name: string, fn: (x: number) => number): FunctionDef {
  return {
    min: 1,
    max: 1,
    call(args, ctx) {
      const x = num(args, 0, name, ctx);
      if (x === MISSING || x === null) return null;
      const out = fn(x);
      return Number.isFinite(out) ? out : null;
    },
  };
}

/** Flatten arguments for a stats function: a single list, or loose numbers. */
function samples(args: readonly ExprValue[]): ExprValue[] {
  if (args.length === 1) {
    const only = args[0];
    if (only !== undefined && isList(only)) return [...only];
  }
  return [...args];
}

/** The numeric, non-null members of a sample — nulls are skipped, never zeroed. */
function numericSamples(args: readonly ExprValue[]): number[] {
  const out: number[] = [];
  for (const item of samples(args)) {
    if (item === null) continue;
    const n = asNumber(item);
    if (n !== undefined) out.push(n);
  }
  return out;
}

/** Ascending numeric order; used by median and the percentiles. */
function sorted(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

/** Linear-interpolated percentile, the definition d3 and NumPy agree on. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const ordered = sorted(values);
  if (ordered.length === 1) return ordered[0] as number;
  const rank = (p / 100) * (ordered.length - 1);
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  const lower = ordered[low] as number;
  if (low === high) return lower;
  const upper = ordered[high] as number;
  return lower + (upper - lower) * (rank - low);
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

/** Sample variance (n − 1), the convention `stddev` in charts is expected to use. */
function varianceOf(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = meanOf(values) as number;
  let sum = 0;
  for (const v of values) sum += (v - mean) ** 2;
  return sum / (values.length - 1);
}

function statsFn(
  fn: (values: readonly number[], all: readonly ExprValue[]) => ExprValue,
): FunctionDef {
  return {
    min: 1,
    max: Infinity,
    aggregateOnly: true,
    call(args) {
      return fn(numericSamples(args), samples(args));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Temporal helpers
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** ISO week number and week-numbering year for an instant, in `zone`. */
export function isoWeek(instant: Date, zone: TimeZoneSpec): { year: number; week: number } {
  const wall = wallClockIn(instant, zone);
  // Thursday of the current ISO week decides the week-numbering year.
  const dayOfWeek = wall.weekday === 0 ? 7 : wall.weekday;
  const thursdayUtc = Date.UTC(wall.year, wall.month - 1, wall.day) + (4 - dayOfWeek) * DAY_MS;
  const thursday = new Date(thursdayUtc);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursdayUtc - jan1) / (7 * DAY_MS)) + 1;
  return { year, week };
}

/** Units accepted by `dateAdd`, `dateDiff` and `dateTrunc`. */
const CALENDAR_UNITS: readonly string[] = [
  'millisecond',
  'second',
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
];

function addCalendar(instant: Date, unit: string, amount: number, zone: TimeZoneSpec): Date | null {
  const wall = wallClockIn(instant, zone);
  switch (unit) {
    case 'millisecond':
      return new Date(instant.getTime() + amount);
    case 'second':
      return new Date(instant.getTime() + amount * 1000);
    case 'minute':
      return new Date(instant.getTime() + amount * 60_000);
    case 'hour':
      return new Date(instant.getTime() + amount * 3_600_000);
    case 'day':
    case 'week': {
      const days = unit === 'week' ? amount * 7 : amount;
      // Re-anchor through the wall clock so a DST day stays the same local time.
      return new Date(instantFromWallClock({ ...wall, day: wall.day + days }, zone));
    }
    case 'month':
    case 'quarter':
    case 'year': {
      const months = unit === 'year' ? amount * 12 : unit === 'quarter' ? amount * 3 : amount;
      const total = wall.year * 12 + (wall.month - 1) + months;
      const year = Math.floor(total / 12);
      const month = total - year * 12 + 1;
      // Clamp the day, so 31 Jan + 1 month is 28/29 Feb rather than 3 March.
      const day = Math.min(wall.day, daysInMonth(year, month));
      return new Date(instantFromWallClock({ ...wall, year, month, day }, zone));
    }
    /* c8 ignore next 2 -- the unit is validated before the call. */
    default:
      return null;
  }
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function truncate(instant: Date, unit: string, zone: TimeZoneSpec): Date | null {
  const wall = wallClockIn(instant, zone);
  const base = { ...wall };
  switch (unit) {
    case 'millisecond':
      return instant;
    case 'second':
      base.ms = 0;
      break;
    case 'minute':
      base.ms = 0;
      base.second = 0;
      break;
    case 'hour':
      base.ms = 0;
      base.second = 0;
      base.minute = 0;
      break;
    case 'day':
      zeroTime(base);
      break;
    case 'week': {
      zeroTime(base);
      // ISO weeks start on Monday.
      const dayOfWeek = wall.weekday === 0 ? 7 : wall.weekday;
      base.day = wall.day - (dayOfWeek - 1);
      break;
    }
    case 'month':
      zeroTime(base);
      base.day = 1;
      break;
    case 'quarter':
      zeroTime(base);
      base.day = 1;
      base.month = Math.floor((wall.month - 1) / 3) * 3 + 1;
      break;
    case 'year':
      zeroTime(base);
      base.day = 1;
      base.month = 1;
      break;
    /* c8 ignore next 2 -- the unit is validated before the call. */
    default:
      return null;
  }
  return new Date(instantFromWallClock(base, zone));
}

function zeroTime(parts: { hour: number; minute: number; second: number; ms: number }): void {
  parts.hour = 0;
  parts.minute = 0;
  parts.second = 0;
  parts.ms = 0;
}

/** `dateDiff` counts whole units from `start` to `end`, negative when reversed. */
function diffCalendar(start: Date, end: Date, unit: string, zone: TimeZoneSpec): number | null {
  switch (unit) {
    case 'millisecond':
      return end.getTime() - start.getTime();
    case 'second':
      return Math.trunc((end.getTime() - start.getTime()) / 1000);
    case 'minute':
      return Math.trunc((end.getTime() - start.getTime()) / 60_000);
    case 'hour':
      return Math.trunc((end.getTime() - start.getTime()) / 3_600_000);
    case 'day':
    case 'week': {
      const a = truncate(start, 'day', zone);
      const b = truncate(end, 'day', zone);
      /* c8 ignore next -- `truncate('day')` never returns null. */
      if (a === null || b === null) return null;
      const days = Math.round((b.getTime() - a.getTime()) / DAY_MS);
      return unit === 'week' ? Math.trunc(days / 7) : days;
    }
    case 'month':
    case 'quarter':
    case 'year': {
      const s = wallClockIn(start, zone);
      const e = wallClockIn(end, zone);
      let months = (e.year - s.year) * 12 + (e.month - s.month);
      // A partial final month does not count: 31 Jan → 28 Feb is 0 months.
      if (months > 0 && e.day < s.day) months -= 1;
      if (months < 0 && e.day > s.day) months += 1;
      if (unit === 'month') return months;
      return Math.trunc(months / (unit === 'quarter' ? 3 : 12));
    }
    /* c8 ignore next 2 -- the unit is validated before the call. */
    default:
      return null;
  }
}

/** A temporal component accessor: `year(date)`, `month(date)`, … */
function part(name: string, read: (wall: ReturnType<typeof wallClockIn>) => number): FunctionDef {
  return {
    min: 1,
    max: 1,
    call(args, ctx) {
      const d = date(args, 0, name, ctx);
      if (d === MISSING || d === null) return null;
      return read(wallClockIn(d, ctx.zone));
    },
  };
}

function unitArg(
  args: readonly ExprValue[],
  index: number,
  name: string,
  ctx: FunctionContext,
): string | undefined {
  const raw = args[index];
  if (typeof raw !== 'string') {
    ctx.fail(`${name}() needs a unit name, not ${typeName(raw ?? null)}`);
    return undefined;
  }
  const unit = raw.toLowerCase().replace(/s$/, '');
  if (!CALENDAR_UNITS.includes(unit)) {
    ctx.fail(`${name}() does not know the unit ${JSON.stringify(raw)}`);
    return undefined;
  }
  return unit;
}

/**
 * `toString` is declared apart from the table below: written inline, an object
 * literal takes this key's contextual type from `Object.prototype.toString`
 * rather than from the index signature, and the entry stops type-checking.
 */
const TO_STRING: FunctionDef = {
  min: 1,
  max: 1,
  call(args, ctx) {
    const value = args[0];
    if (value === undefined || value === null) return null;
    if (isList(value)) return null;
    return formatValue(value as Value, undefined, ctx.format);
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// The whitelist
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every callable identifier in MDVX, keyed by name (SPEC 6.8.2).
 *
 * Declared as a typed local first: a bare object literal would take `toString`'s
 * contextual type from `Object.prototype`, and the entry would stop type-checking
 * against {@link FunctionDef}.
 */
const TABLE: Record<string, FunctionDef> = {
  // ── Math ───────────────────────────────────────────────────────────────────
  abs: math1('abs', Math.abs),
  ceil: math1('ceil', Math.ceil),
  floor: math1('floor', Math.floor),
  round: math1('round', (x) => roundHalfAwayFromZero(x)),
  trunc: math1('trunc', Math.trunc),
  sign: math1('sign', Math.sign),
  sqrt: math1('sqrt', Math.sqrt),
  cbrt: math1('cbrt', Math.cbrt),
  exp: math1('exp', Math.exp),
  log: math1('log', Math.log),
  log10: math1('log10', Math.log10),
  log2: math1('log2', Math.log2),
  pow: {
    min: 2,
    max: 2,
    call(args, ctx) {
      const base = num(args, 0, 'pow', ctx);
      const exponent = num(args, 1, 'pow', ctx);
      if (base === MISSING || exponent === MISSING) return null;
      if (base === null || exponent === null) return null;
      const out = base ** exponent;
      return Number.isFinite(out) ? out : null;
    },
  },
  min: extremum('min', (a, b) => a < b),
  max: extremum('max', (a, b) => a > b),
  clamp: {
    min: 3,
    max: 3,
    call(args, ctx) {
      const value = num(args, 0, 'clamp', ctx);
      const low = num(args, 1, 'clamp', ctx);
      const high = num(args, 2, 'clamp', ctx);
      if (value === MISSING || low === MISSING || high === MISSING) return null;
      if (value === null || low === null || high === null) return null;
      return Math.min(Math.max(value, low), high);
    },
  },

  // ── Stats (aggregate context only) ─────────────────────────────────────────
  sum: statsFn((values) => {
    if (values.length === 0) return null;
    let total = 0;
    for (const v of values) total += v;
    return total;
  }),
  mean: statsFn((values) => meanOf(values)),
  median: statsFn((values) => percentile(values, 50)),
  mode: statsFn((_numbers, all) => modeOf(all)),
  stddev: statsFn((values) => {
    const variance = varianceOf(values);
    return variance === null ? null : Math.sqrt(variance);
  }),
  variance: statsFn((values) => varianceOf(values)),
  count: statsFn((_numbers, all) => all.filter((v) => v !== null).length),
  countDistinct: statsFn((_numbers, all) => {
    const seen: ExprValue[] = [];
    for (const item of all) {
      if (item === null) continue;
      if (!seen.some((other) => equals(other, item))) seen.push(item);
    }
    return seen.length;
  }),
  p25: statsFn((values) => percentile(values, 25)),
  p50: statsFn((values) => percentile(values, 50)),
  p75: statsFn((values) => percentile(values, 75)),
  p90: statsFn((values) => percentile(values, 90)),
  p95: statsFn((values) => percentile(values, 95)),
  p99: statsFn((values) => percentile(values, 99)),

  // ── String ─────────────────────────────────────────────────────────────────
  lower: string1('lower', (s) => s.toLowerCase()),
  upper: string1('upper', (s) => s.toUpperCase()),
  trim: string1('trim', (s) => s.trim()),
  len: {
    min: 1,
    max: 1,
    call(args, ctx) {
      const value = args[0];
      if (value === undefined || value === null) return null;
      if (typeof value === 'string') return [...value].length;
      if (isList(value)) return value.length;
      ctx.fail(`len() needs a string or a list, not ${typeName(value)}`);
      return null;
    },
  },
  startsWith: string2('startsWith', (s, other) => s.startsWith(other)),
  endsWith: string2('endsWith', (s, other) => s.endsWith(other)),
  contains: string2('contains', (s, other) => s.includes(other)),
  replace: {
    min: 3,
    max: 3,
    call(args, ctx) {
      const text = str(args, 0, 'replace', ctx);
      const from = str(args, 1, 'replace', ctx);
      const to = str(args, 2, 'replace', ctx);
      if (text === MISSING || from === MISSING || to === MISSING) return null;
      if (text === null || from === null || to === null) return null;
      // `replaceAll` with string arguments never interprets a pattern, so a
      // document cannot smuggle a regular expression in here (SPEC 13.6).
      return from === '' ? text : text.split(from).join(to);
    },
  },
  split: {
    min: 2,
    max: 2,
    call(args, ctx) {
      const text = str(args, 0, 'split', ctx);
      const sep = str(args, 1, 'split', ctx);
      if (text === MISSING || sep === MISSING) return null;
      if (text === null || sep === null) return null;
      return sep === '' ? [...text] : text.split(sep);
    },
  },
  substr: {
    min: 2,
    max: 3,
    call(args, ctx) {
      const text = str(args, 0, 'substr', ctx);
      const start = num(args, 1, 'substr', ctx);
      if (text === MISSING || start === MISSING) return null;
      if (text === null || start === null) return null;
      const chars = [...text];
      const from = start < 0 ? Math.max(chars.length + start, 0) : Math.trunc(start);
      if (args.length < 3 || args[2] === null) return chars.slice(from).join('');
      const length = num(args, 2, 'substr', ctx);
      if (length === MISSING || length === null) return null;
      return chars.slice(from, from + Math.max(0, Math.trunc(length))).join('');
    },
  },
  concat: {
    min: 1,
    max: Infinity,
    call(args, ctx) {
      let out = '';
      for (const arg of args) {
        if (arg === null) continue; // Null contributes nothing, rather than "null".
        if (typeof arg !== 'string') {
          ctx.fail(`concat() needs strings, not ${typeName(arg)}`);
          return null;
        }
        out += arg;
      }
      return out;
    },
  },
  pad: {
    min: 2,
    max: 3,
    call(args, ctx) {
      const text = str(args, 0, 'pad', ctx);
      const width = num(args, 1, 'pad', ctx);
      if (text === MISSING || width === MISSING) return null;
      if (text === null || width === null) return null;
      const fillArg = args.length >= 3 ? str(args, 2, 'pad', ctx) : ' ';
      if (fillArg === MISSING) return null;
      const fill = fillArg === null || fillArg === '' ? ' ' : fillArg;
      const target = Math.trunc(width);
      // A negative width pads on the right, matching the sign convention of
      // `%-10s`-style formats.
      const chars = [...text];
      if (chars.length >= Math.abs(target)) return text;
      const padding = repeatTo(fill, Math.abs(target) - chars.length);
      return target < 0 ? text + padding : padding + text;
    },
  },

  // ── Temporal ───────────────────────────────────────────────────────────────
  year: part('year', (wall) => wall.year),
  quarter: part('quarter', (wall) => Math.floor((wall.month - 1) / 3) + 1),
  month: part('month', (wall) => wall.month),
  week: {
    min: 1,
    max: 1,
    call(args, ctx) {
      const d = date(args, 0, 'week', ctx);
      if (d === MISSING || d === null) return null;
      return isoWeek(d, ctx.zone).week;
    },
  },
  day: part('day', (wall) => wall.day),
  hour: part('hour', (wall) => wall.hour),
  minute: part('minute', (wall) => wall.minute),
  second: part('second', (wall) => wall.second),
  dayOfWeek: part('dayOfWeek', (wall) => wall.weekday),
  dateAdd: {
    min: 3,
    max: 3,
    call(args, ctx) {
      const d = date(args, 0, 'dateAdd', ctx);
      if (d === MISSING) return null;
      const unit = unitArg(args, 1, 'dateAdd', ctx);
      const amount = num(args, 2, 'dateAdd', ctx);
      if (unit === undefined || amount === MISSING) return null;
      if (d === null || amount === null) return null;
      return addCalendar(d, unit, Math.trunc(amount), ctx.zone);
    },
  },
  dateDiff: {
    min: 3,
    max: 3,
    call(args, ctx) {
      const unit = unitArg(args, 0, 'dateDiff', ctx);
      const start = date(args, 1, 'dateDiff', ctx);
      const end = date(args, 2, 'dateDiff', ctx);
      if (unit === undefined || start === MISSING || end === MISSING) return null;
      if (start === null || end === null) return null;
      return diffCalendar(start, end, unit, ctx.zone);
    },
  },
  dateTrunc: {
    min: 2,
    max: 2,
    call(args, ctx) {
      const unit = unitArg(args, 0, 'dateTrunc', ctx);
      const d = date(args, 1, 'dateTrunc', ctx);
      if (unit === undefined || d === MISSING) return null;
      if (d === null) return null;
      return truncate(d, unit, ctx.zone);
    },
  },
  now: {
    min: 0,
    max: 0,
    call(_args, ctx) {
      // The build time, never a clock read: two renders of one document must
      // agree byte for byte (SPEC 24.3 rule 2).
      return new Date(ctx.buildTime.getTime());
    },
  },

  // ── Logic ──────────────────────────────────────────────────────────────────
  if: {
    min: 3,
    max: 3,
    call(args) {
      // Both branches are already evaluated: MDVX has no side effects, so
      // eagerness is unobservable apart from cost.
      return truthy(args[0] as ExprValue) ? (args[1] as ExprValue) : (args[2] as ExprValue);
    },
  },
  coalesce: {
    min: 1,
    max: Infinity,
    call(args) {
      for (const arg of args) {
        if (arg !== null && arg !== undefined) return arg;
      }
      return null;
    },
  },
  isNull: {
    min: 1,
    max: 1,
    call(args) {
      return args[0] === null || args[0] === undefined;
    },
  },
  isNumber: {
    min: 1,
    max: 1,
    call(args) {
      return typeof args[0] === 'number';
    },
  },
  isString: {
    min: 1,
    max: 1,
    call(args) {
      return typeof args[0] === 'string';
    },
  },
  toNumber: {
    min: 1,
    max: 1,
    call(args) {
      const value = args[0];
      if (value === undefined || value === null) return null;
      if (typeof value === 'number') return value;
      if (typeof value === 'boolean') return value ? 1 : 0;
      if (value instanceof Date) return value.getTime();
      if (typeof value === 'string') {
        // An explicit conversion, so the loose reader is right here — this is
        // not the implicit coercion SPEC 6.8.3 forbids.
        const parsed = parseLooseNumber(value.trim());
        return parsed ?? null;
      }
      return null;
    },
  },
  toString: TO_STRING,
  toDate: {
    min: 1,
    max: 1,
    call(args, ctx) {
      const value = args[0];
      if (value === undefined || value === null) return null;
      if (value instanceof Date) return value;
      if (typeof value !== 'string') {
        ctx.fail(`toDate() needs an ISO 8601 string, not ${typeName(value)}`);
        return null;
      }
      // ISO 8601 only: no `Date.parse` fallback, which is implementation-defined
      // and would make one document render differently per engine (SPEC 6.6).
      const iso = parseIso8601(value.trim(), ctx.zone);
      return iso === undefined ? null : iso.date;
    },
  },

  // ── Formatting ─────────────────────────────────────────────────────────────
  format: {
    min: 1,
    max: 2,
    call(args, ctx) {
      const value = args[0];
      if (value === undefined || value === null) return null;
      if (isList(value)) {
        ctx.fail('format() cannot format a list');
        return null;
      }
      const spec = args[1];
      if (spec === undefined || spec === null) {
        return formatValue(value as Value, undefined, ctx.format);
      }
      if (typeof spec !== 'string') {
        ctx.fail(`format() needs a format string, not ${typeName(spec)}`);
        return null;
      }
      return formatValue(value as Value, spec, ctx.format);
    },
  },
};

/** The frozen whitelist. */
export const FUNCTIONS: Readonly<Record<string, FunctionDef>> = Object.freeze(TABLE);

/** `true` when `name` is callable at all (SPEC 6.8.2). Otherwise `MDV2220`. */
export function isWhitelisted(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}

/** Look up a whitelisted function without inheriting from `Object.prototype`. */
export function lookupFunction(name: string): FunctionDef | undefined {
  return Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined;
}

function string1(name: string, fn: (text: string) => string): FunctionDef {
  return {
    min: 1,
    max: 1,
    call(args, ctx) {
      const text = str(args, 0, name, ctx);
      if (text === MISSING || text === null) return null;
      return fn(text);
    },
  };
}

function string2(name: string, fn: (text: string, other: string) => boolean): FunctionDef {
  return {
    min: 2,
    max: 2,
    call(args, ctx) {
      const text = str(args, 0, name, ctx);
      const other = str(args, 1, name, ctx);
      if (text === MISSING || other === MISSING) return null;
      if (text === null || other === null) return null;
      return fn(text, other);
    },
  };
}

/**
 * `min`/`max` over loose arguments or one list. Nulls are skipped rather than
 * winning the comparison, which is what a reader means by "the smallest value".
 */
function extremum(name: string, better: (a: number, b: number) => boolean): FunctionDef {
  return {
    min: 1,
    max: Infinity,
    call(args, ctx) {
      const items = samples(args);
      let best: number | undefined;
      let bestDate: Date | undefined;
      for (const item of items) {
        if (item === null) continue;
        const n = asNumber(item);
        if (n === undefined) {
          ctx.fail(`${name}() needs numbers or dates, not ${typeName(item)}`);
          return null;
        }
        if (best === undefined || better(n, best)) {
          best = n;
          bestDate = item instanceof Date ? item : undefined;
        }
      }
      if (best === undefined) return null;
      return bestDate !== undefined ? new Date(best) : best;
    },
  };
}

/** Most frequent value; ties break towards the first in encounter order. */
function modeOf(values: readonly ExprValue[]): ExprValue {
  const keys: ExprValue[] = [];
  const counts: number[] = [];
  for (const value of values) {
    if (value === null) continue;
    const index = keys.findIndex((other) => equals(other, value));
    if (index === -1) {
      keys.push(value);
      counts.push(1);
    } else {
      counts[index] = (counts[index] as number) + 1;
    }
  }
  let bestIndex = -1;
  for (let i = 0; i < counts.length; i += 1) {
    if (bestIndex === -1 || (counts[i] as number) > (counts[bestIndex] as number)) bestIndex = i;
  }
  return bestIndex === -1 ? null : (keys[bestIndex] as ExprValue);
}

/**
 * `Math.round` rounds −0.5 to −0, which reads as an off-by-one in a table. Half
 * away from zero is the convention every spreadsheet uses.
 */
function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

function repeatTo(fill: string, width: number): string {
  const chars = [...fill];
  let out = '';
  while ([...out].length < width) out += chars[[...out].length % chars.length] as string;
  return out;
}

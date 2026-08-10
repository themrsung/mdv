/**
 * Temporal values (SPEC 6.6).
 *
 * > ISO 8601 is always accepted: `2026-08-10`, `2026-08-10T14:30:00Z`,
 * > `2026-08-10T14:30:00+09:00`, `2026-W33-1`, `2026-08`.
 * > Other layouts require `parse:` with a strftime subset.
 * > A value with no zone offset is interpreted in the document `timezone`
 * > (default `UTC`). Rendering MUST NOT depend on the machine's local zone.
 *
 * Consequences, all deliberate:
 *
 * - **`Date.parse` is never called.** It is implementation-defined for anything
 *   outside the ISO grammar, it silently accepts locale layouts, and it treats
 *   date-only strings as UTC but date-time strings without a zone as *local* —
 *   which would make a PDF depend on the machine that built it.
 * - Every `Date` produced here is an absolute instant. Zone interpretation
 *   happens once, at parse time, from the document's configured timezone.
 * - Nothing in this module reads the clock (SPEC 17.3 invariant 1).
 */

/** What an ISO string denoted, before it became an instant. */
export type TemporalKind = 'date' | 'datetime' | 'time';

/** A successfully parsed temporal value. */
export interface TemporalValue {
  /** The absolute instant. */
  date: Date;
  kind: TemporalKind;
  /** `true` when the source carried an explicit zone (`Z` or `±HH:MM`). */
  hasZone: boolean;
}

/** A timezone as configured on the document: `UTC`, `+09:00`, or an IANA name. */
export type TimeZoneSpec = string;

// ─────────────────────────────────────────────────────────────────────────────
// Zone handling
// ─────────────────────────────────────────────────────────────────────────────

const FIXED_ZONE = /^(?:UTC|GMT)?([+-])(\d{2})(?::?(\d{2}))?$/u;

/**
 * The offset, in minutes east of UTC, that `zone` had at `utcMillis`.
 *
 * `UTC`/`Z`/`GMT` and fixed offsets are computed arithmetically. A named IANA
 * zone is resolved through `Intl` when the host has it — a tzdata lookup, not a
 * clock read, so it stays deterministic for a given ICU version (SPEC 6.9.3
 * requires that version to be recorded in export metadata). A host without
 * `Intl` degrades to UTC rather than to the machine's local zone.
 */
export function zoneOffsetMinutes(zone: TimeZoneSpec, utcMillis: number): number {
  if (zone === '' || zone === 'UTC' || zone === 'Z' || zone === 'GMT' || zone === 'Etc/UTC') {
    return 0;
  }
  const fixed = FIXED_ZONE.exec(zone);
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1;
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3] ?? '0');
    return sign * (hours * 60 + minutes);
  }
  return namedZoneOffsetMinutes(zone, utcMillis);
}

function namedZoneOffsetMinutes(zone: string, utcMillis: number): number {
  const DTF = (globalThis as { Intl?: typeof Intl }).Intl?.DateTimeFormat;
  if (DTF === undefined) return 0;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new DTF('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMillis));
  } catch {
    return 0;
  }
  const get = (type: string): number => {
    for (const p of parts) if (p.type === type) return Number(p.value);
    return 0;
  };
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - utcMillis) / 60000);
}

/**
 * Turn wall-clock components into an instant, interpreting them in `zone`.
 *
 * Two passes: guess with the offset at the naive instant, then correct with the
 * offset that actually applies there. That is exact everywhere except inside a
 * DST spring-forward gap, where the later of the two readings is chosen.
 */
export function instantFromWallClock(
  parts: {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    ms: number;
  },
  zone: TimeZoneSpec,
): number {
  const naive = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    parts.ms,
  );
  const first = zoneOffsetMinutes(zone, naive);
  const candidate = naive - first * 60000;
  const second = zoneOffsetMinutes(zone, candidate);
  return second === first ? candidate : naive - second * 60000;
}

// ─────────────────────────────────────────────────────────────────────────────
// ISO 8601
// ─────────────────────────────────────────────────────────────────────────────

interface Scanner {
  s: string;
  i: number;
}

function digits(sc: Scanner, count: number): number | undefined {
  let value = 0;
  for (let k = 0; k < count; k += 1) {
    const c = sc.s.charCodeAt(sc.i + k);
    if (Number.isNaN(c) || c < 0x30 || c > 0x39) return undefined;
    value = value * 10 + (c - 0x30);
  }
  sc.i += count;
  return value;
}

function isDigitAt(sc: Scanner, offset = 0): boolean {
  const c = sc.s.charCodeAt(sc.i + offset);
  return c >= 0x30 && c <= 0x39;
}

/** Days in a Gregorian month. */
function daysInMonth(year: number, month: number): number {
  const table = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) return 29;
  return table[month - 1] ?? 31;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** The Monday of ISO week 1 of `year`, as a UTC millisecond value. */
function isoWeekOneMonday(year: number): number {
  const jan4 = Date.UTC(year, 0, 4);
  const dow = new Date(jan4).getUTCDay() || 7; // 1..7, Monday = 1
  return jan4 - (dow - 1) * 86400000;
}

/**
 * Parse an ISO 8601 value.
 *
 * Accepted: `YYYY`, `YYYY-MM`, `YYYY-MM-DD`, `YYYY-DDD` (ordinal),
 * `YYYY-Www`, `YYYY-Www-D`, any of those with `T`/space plus
 * `HH`, `HH:MM`, `HH:MM:SS`, `HH:MM:SS.sss`, and a trailing `Z`, `±HH`,
 * `±HHMM` or `±HH:MM`. Also a bare time (`14:30`, `14:30:05.250`).
 *
 * @returns `undefined` when the text is not ISO 8601 — **never** a guess.
 */
export function parseIso8601(text: string, zone: TimeZoneSpec = 'UTC'): TemporalValue | undefined {
  const s = text.trim();
  if (s === '') return undefined;
  const sc: Scanner = { s, i: 0 };

  // Bare time.
  if (s.length >= 3 && isDigitAt(sc) && isDigitAt(sc, 1) && s[2] === ':') {
    const time = scanTime(sc);
    if (time === undefined) return undefined;
    const zoneInfo = scanZone(sc);
    if (sc.i !== s.length) return undefined;
    const base = { year: 1970, month: 1, day: 1, ...time };
    const millis =
      zoneInfo === undefined
        ? instantFromWallClock(base, zone)
        : Date.UTC(1970, 0, 1, base.hour, base.minute, base.second, base.ms) - zoneInfo * 60000;
    return { date: new Date(millis), kind: 'time', hasZone: zoneInfo !== undefined };
  }

  const year = digits(sc, 4);
  if (year === undefined) return undefined;

  let month = 1;
  let day = 1;
  const kind: TemporalKind = 'date';

  if (sc.s[sc.i] === '-') {
    sc.i += 1;
    if (sc.s[sc.i] === 'W') {
      sc.i += 1;
      const week = digits(sc, 2);
      if (week === undefined || week < 1 || week > 53) return undefined;
      let weekday = 1;
      if (sc.s[sc.i] === '-') {
        sc.i += 1;
        const d = digits(sc, 1);
        if (d === undefined || d < 1 || d > 7) return undefined;
        weekday = d;
      }
      const millis = isoWeekOneMonday(year) + ((week - 1) * 7 + (weekday - 1)) * 86400000;
      const asDate = new Date(millis);
      month = asDate.getUTCMonth() + 1;
      day = asDate.getUTCDate();
      return finish(sc, { year: asDate.getUTCFullYear(), month, day }, zone, 'date');
    }
    if (isDigitAt(sc) && isDigitAt(sc, 1) && isDigitAt(sc, 2) && !isDigitAt(sc, 3)) {
      // Ordinal date `YYYY-DDD`.
      const ordinal = digits(sc, 3);
      if (ordinal === undefined || ordinal < 1 || ordinal > (isLeapYear(year) ? 366 : 365)) {
        return undefined;
      }
      const asDate = new Date(Date.UTC(year, 0, 1) + (ordinal - 1) * 86400000);
      return finish(
        sc,
        {
          year: asDate.getUTCFullYear(),
          month: asDate.getUTCMonth() + 1,
          day: asDate.getUTCDate(),
        },
        zone,
        'date',
      );
    }
    const m = digits(sc, 2);
    if (m === undefined || m < 1 || m > 12) return undefined;
    month = m;
    if (sc.s[sc.i] === '-') {
      sc.i += 1;
      const d = digits(sc, 2);
      if (d === undefined || d < 1 || d > daysInMonth(year, month)) return undefined;
      day = d;
    }
  } else if (sc.i !== s.length) {
    return undefined; // `20260810` basic format is not accepted: too easy to confuse with a number
  }

  return finish(sc, { year, month, day }, zone, kind);
}

function finish(
  sc: Scanner,
  date: { year: number; month: number; day: number },
  zone: TimeZoneSpec,
  kind: TemporalKind,
): TemporalValue | undefined {
  let hour = 0;
  let minute = 0;
  let second = 0;
  let ms = 0;
  let resolved = kind;

  const sep = sc.s[sc.i];
  if (sep === 'T' || sep === 't' || sep === ' ') {
    sc.i += 1;
    const time = scanTime(sc);
    if (time === undefined) return undefined;
    hour = time.hour;
    minute = time.minute;
    second = time.second;
    ms = time.ms;
    resolved = 'datetime';
  }

  const offset = scanZone(sc);
  if (sc.i !== sc.s.length) return undefined;

  const parts = { ...date, hour, minute, second, ms };
  const millis =
    offset === undefined
      ? instantFromWallClock(parts, zone)
      : Date.UTC(parts.year, parts.month - 1, parts.day, hour, minute, second, ms) - offset * 60000;

  return { date: new Date(millis), kind: resolved, hasZone: offset !== undefined };
}

function scanTime(
  sc: Scanner,
): { hour: number; minute: number; second: number; ms: number } | undefined {
  const hour = digits(sc, 2);
  if (hour === undefined || hour > 24) return undefined;
  let minute = 0;
  let second = 0;
  let ms = 0;
  if (sc.s[sc.i] === ':') {
    sc.i += 1;
    const m = digits(sc, 2);
    if (m === undefined || m > 59) return undefined;
    minute = m;
    if (sc.s[sc.i] === ':') {
      sc.i += 1;
      const s = digits(sc, 2);
      if (s === undefined || s > 60) return undefined;
      second = Math.min(s, 59);
      if (sc.s[sc.i] === '.' || sc.s[sc.i] === ',') {
        sc.i += 1;
        let frac = '';
        while (isDigitAt(sc)) {
          frac += sc.s[sc.i] as string;
          sc.i += 1;
        }
        if (frac === '') return undefined;
        ms = Math.round(Number(`0.${frac}`) * 1000);
      }
    }
  }
  return { hour, minute, second, ms };
}

/** @returns minutes east of UTC, or `undefined` when no zone was written. */
function scanZone(sc: Scanner): number | undefined {
  const ch = sc.s[sc.i];
  if (ch === 'Z' || ch === 'z') {
    sc.i += 1;
    return 0;
  }
  if (ch !== '+' && ch !== '-') return undefined;
  const sign = ch === '-' ? -1 : 1;
  sc.i += 1;
  const hour = digits(sc, 2);
  if (hour === undefined) return undefined;
  let minute = 0;
  if (sc.s[sc.i] === ':') {
    sc.i += 1;
    const m = digits(sc, 2);
    if (m === undefined) return undefined;
    minute = m;
  } else if (isDigitAt(sc)) {
    const m = digits(sc, 2);
    if (m === undefined) return undefined;
    minute = m;
  }
  return sign * (hour * 60 + minute);
}

// ─────────────────────────────────────────────────────────────────────────────
// Durations (SPEC 6.6)
// ─────────────────────────────────────────────────────────────────────────────

/** Milliseconds per unit, for `unit:` and for duration arithmetic. */
export const UNIT_MS: Readonly<Record<string, number>> = Object.freeze({
  ns: 1e-6,
  us: 1e-3,
  ms: 1,
  s: 1000,
  second: 1000,
  seconds: 1000,
  minute: 60000,
  minutes: 60000,
  m: 60000,
  hour: 3600000,
  hours: 3600000,
  h: 3600000,
  day: 86400000,
  days: 86400000,
  d: 86400000,
  week: 604800000,
  weeks: 604800000,
  w: 604800000,
});

/**
 * Parse an ISO 8601 duration (`PT2H30M`, `P1DT6H`, `P2W`) into milliseconds.
 *
 * Months and years are accepted and converted with the calendar-average lengths
 * used everywhere else in MDV (30.436875 d and 365.2425 d): a duration is a
 * quantity, not a calendar span, and a bar chart of durations must be additive.
 */
export function parseIsoDuration(text: string): number | undefined {
  const s = text.trim();
  if (s.length < 3) return undefined;
  let i = 0;
  let sign = 1;
  if (s[i] === '-') {
    sign = -1;
    i += 1;
  } else if (s[i] === '+') {
    i += 1;
  }
  if (s[i] !== 'P') return undefined;
  i += 1;

  let total = 0;
  let inTime = false;
  let sawAny = false;

  while (i < s.length) {
    if (s[i] === 'T') {
      inTime = true;
      i += 1;
      continue;
    }
    let num = '';
    while (i < s.length && ((s.charCodeAt(i) >= 0x30 && s.charCodeAt(i) <= 0x39) || s[i] === '.')) {
      num += s[i] as string;
      i += 1;
    }
    if (num === '') return undefined;
    const value = Number(num);
    if (!Number.isFinite(value)) return undefined;
    const unit = s[i];
    if (unit === undefined) return undefined;
    i += 1;
    sawAny = true;
    switch (unit) {
      case 'Y':
        total += value * 365.2425 * 86400000;
        break;
      case 'W':
        total += value * 604800000;
        break;
      case 'D':
        total += value * 86400000;
        break;
      case 'H':
        if (!inTime) return undefined;
        total += value * 3600000;
        break;
      case 'S':
        if (!inTime) return undefined;
        total += value * 1000;
        break;
      case 'M':
        total += inTime ? value * 60000 : value * 30.436875 * 86400000;
        break;
      default:
        return undefined;
    }
  }
  return sawAny ? sign * total : undefined;
}

/**
 * The strftime subset of SPEC 6.6, used both for `parse:` (input) and for
 * `format:` on temporal fields (SPEC 6.9.4, output).
 *
 * > `%Y %y %m %d %H %M %S %L %b %B %a %A %j %p %z %%`, plus `%-` to suppress
 * > zero-padding (`%-d`). Anything else is `MDV2150`.
 *
 * The month and weekday names are the fixed `en-US` set, spelled out here rather
 * than taken from `Intl`: SPEC 6.9.3 requires a built-in formatter for the
 * default locale so that output cannot vary with the host ICU version.
 */

import { instantFromWallClock, zoneOffsetMinutes, type TimeZoneSpec } from './temporal.js';

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

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

/** Every directive letter the subset allows. */
export const SUPPORTED_DIRECTIVES = 'YymdHMSLbBaAjpz%';

/** Wall-clock components of an instant in a given zone. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  ms: number;
  /** 0 = Sunday. */
  weekday: number;
  /** 1-based day of year. */
  yearDay: number;
  /** Minutes east of UTC. */
  offsetMinutes: number;
}

/** Decompose an instant into wall-clock components in `zone`. */
export function wallClockIn(date: Date, zone: TimeZoneSpec): WallClock {
  const t = date.getTime();
  const offsetMinutes = zoneOffsetMinutes(zone, t);
  const shifted = new Date(t + offsetMinutes * 60000);
  const year = shifted.getUTCFullYear();
  const startOfYear = Date.UTC(year, 0, 1);
  return {
    year,
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    ms: shifted.getUTCMilliseconds(),
    weekday: shifted.getUTCDay(),
    yearDay: Math.floor((shifted.getTime() - startOfYear) / 86400000) + 1,
    offsetMinutes,
  };
}

function pad(value: number, width: number, padded: boolean): string {
  const s = String(Math.abs(value));
  const sign = value < 0 ? '-' : '';
  if (!padded) return sign + s;
  return sign + (s.length >= width ? s : '0'.repeat(width - s.length) + s);
}

/**
 * Every unsupported directive in a pattern, in source order.
 * A non-empty result is `MDV2150`.
 */
export function unsupportedDirectives(pattern: string): string[] {
  const bad: string[] = [];
  for (let i = 0; i < pattern.length; i += 1) {
    if (pattern[i] !== '%') continue;
    let j = i + 1;
    if (pattern[j] === '-') j += 1;
    const letter = pattern[j];
    if (letter === undefined || !SUPPORTED_DIRECTIVES.includes(letter)) {
      bad.push(pattern.slice(i, j + 1));
    }
    i = j;
  }
  return bad;
}

/** Render an instant with a strftime pattern, in `zone`. */
export function formatWithPattern(date: Date, pattern: string, zone: TimeZoneSpec): string {
  const w = wallClockIn(date, zone);
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch !== '%') {
      out += ch;
      continue;
    }
    let j = i + 1;
    let padded = true;
    if (pattern[j] === '-') {
      padded = false;
      j += 1;
    }
    const letter = pattern[j];
    i = j;
    switch (letter) {
      case 'Y':
        out += String(w.year);
        break;
      case 'y':
        out += pad(((w.year % 100) + 100) % 100, 2, padded);
        break;
      case 'm':
        out += pad(w.month, 2, padded);
        break;
      case 'd':
        out += pad(w.day, 2, padded);
        break;
      case 'H':
        out += pad(w.hour, 2, padded);
        break;
      case 'M':
        out += pad(w.minute, 2, padded);
        break;
      case 'S':
        out += pad(w.second, 2, padded);
        break;
      case 'L':
        out += pad(w.ms, 3, padded);
        break;
      case 'b':
        out += MONTHS_SHORT[w.month - 1] ?? '';
        break;
      case 'B':
        out += MONTHS_LONG[w.month - 1] ?? '';
        break;
      case 'a':
        out += DAYS_SHORT[w.weekday] ?? '';
        break;
      case 'A':
        out += DAYS_LONG[w.weekday] ?? '';
        break;
      case 'j':
        out += pad(w.yearDay, 3, padded);
        break;
      case 'p':
        out += w.hour < 12 ? 'AM' : 'PM';
        break;
      case 'z':
        out += formatOffset(w.offsetMinutes);
        break;
      case '%':
        out += '%';
        break;
      default:
        // Unsupported: reported as MDV2150 by the caller; echoed verbatim so the
        // author can see what was not understood.
        out += letter === undefined ? '%' : `%${letter}`;
    }
  }
  return out;
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60), 2, true)}${pad(abs % 60, 2, true)}`;
}

/**
 * Parse text with a strftime pattern (`parse:` in SPEC 6.6).
 *
 * Strict: literal characters must match exactly, and a numeric field consumes at
 * most its natural width. Returns `undefined` on any mismatch — the caller emits
 * `MDV2151` and the cell becomes null, rather than a plausible wrong date.
 */
export function parseWithPattern(
  text: string,
  pattern: string,
  zone: TimeZoneSpec,
): Date | undefined {
  const s = text.trim();
  let si = 0;
  let year: number | undefined;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let ms = 0;
  let pm: boolean | undefined;
  let offsetMinutes: number | undefined;
  let century = true;

  const readNumber = (maxWidth: number): number | undefined => {
    const start = si;
    if (s[si] === '+' || s[si] === '-') si += 1;
    let count = 0;
    while (si < s.length && count < maxWidth && isDigit(s.charCodeAt(si))) {
      si += 1;
      count += 1;
    }
    if (count === 0) {
      si = start;
      return undefined;
    }
    const value = Number(s.slice(start, si));
    return Number.isFinite(value) ? value : undefined;
  };

  const readName = (names: readonly string[]): number | undefined => {
    for (let index = 0; index < names.length; index += 1) {
      const name = names[index] as string;
      if (s.slice(si, si + name.length).toLowerCase() === name.toLowerCase()) {
        si += name.length;
        return index;
      }
    }
    return undefined;
  };

  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i] as string;
    if (ch !== '%') {
      if (ch === ' ') {
        while (s[si] === ' ') si += 1;
        continue;
      }
      if (s[si] !== ch) return undefined;
      si += 1;
      continue;
    }
    let j = i + 1;
    if (pattern[j] === '-') j += 1;
    const letter = pattern[j];
    i = j;

    switch (letter) {
      case 'Y': {
        const v = readNumber(4);
        if (v === undefined) return undefined;
        year = v;
        century = false;
        break;
      }
      case 'y': {
        const v = readNumber(2);
        if (v === undefined) return undefined;
        year = v;
        century = true;
        break;
      }
      case 'm': {
        const v = readNumber(2);
        if (v === undefined || v < 1 || v > 12) return undefined;
        month = v;
        break;
      }
      case 'd': {
        const v = readNumber(2);
        if (v === undefined || v < 1 || v > 31) return undefined;
        day = v;
        break;
      }
      case 'H': {
        const v = readNumber(2);
        if (v === undefined || v > 24) return undefined;
        hour = v;
        break;
      }
      case 'M': {
        const v = readNumber(2);
        if (v === undefined || v > 59) return undefined;
        minute = v;
        break;
      }
      case 'S': {
        const v = readNumber(2);
        if (v === undefined || v > 60) return undefined;
        second = Math.min(v, 59);
        break;
      }
      case 'L': {
        const v = readNumber(3);
        if (v === undefined) return undefined;
        ms = v;
        break;
      }
      case 'j': {
        const v = readNumber(3);
        if (v === undefined || v < 1 || v > 366) return undefined;
        month = 1;
        day = v;
        break;
      }
      case 'b': {
        const v = readName(MONTHS_SHORT);
        if (v === undefined) return undefined;
        month = v + 1;
        break;
      }
      case 'B': {
        const v = readName(MONTHS_LONG);
        if (v === undefined) return undefined;
        month = v + 1;
        break;
      }
      case 'a': {
        if (readName(DAYS_SHORT) === undefined) return undefined;
        break;
      }
      case 'A': {
        if (readName(DAYS_LONG) === undefined) return undefined;
        break;
      }
      case 'p': {
        const upper = s.slice(si, si + 2).toUpperCase();
        if (upper === 'AM') pm = false;
        else if (upper === 'PM') pm = true;
        else return undefined;
        si += 2;
        break;
      }
      case 'z': {
        if (s[si] === 'Z') {
          offsetMinutes = 0;
          si += 1;
          break;
        }
        const sign = s[si] === '-' ? -1 : s[si] === '+' ? 1 : undefined;
        if (sign === undefined) return undefined;
        si += 1;
        const h = readNumber(2);
        if (h === undefined) return undefined;
        if (s[si] === ':') si += 1;
        const m = isDigit(s.charCodeAt(si)) ? readNumber(2) : 0;
        offsetMinutes = sign * (h * 60 + (m ?? 0));
        break;
      }
      case '%': {
        if (s[si] !== '%') return undefined;
        si += 1;
        break;
      }
      default:
        return undefined;
    }
  }

  if (si !== s.length) return undefined;
  if (year === undefined) return undefined;
  if (century && year < 100) year += year < 69 ? 2000 : 1900;
  if (pm === true && hour < 12) hour += 12;
  if (pm === false && hour === 12) hour = 0;

  const parts = { year, month, day, hour, minute, second, ms };
  const millis =
    offsetMinutes === undefined
      ? instantFromWallClock(parts, zone)
      : Date.UTC(year, month - 1, day, hour, minute, second, ms) - offsetMinutes * 60000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

export { MONTHS_LONG, MONTHS_SHORT, DAYS_LONG, DAYS_SHORT };

/**
 * The calendar-aware tick ladder for temporal scales (SPEC 7.2, "Ticks chosen
 * from a calendar-aware ladder").
 *
 * A time axis is not a linear axis with dates painted on it. 1 000 000 ms is not
 * a tick a reader can use; the first of the month is. Every interval here floors
 * to a **civil boundary in the configured timezone**, so a daily ladder crossing
 * a DST transition still lands on midnight local time, not on midnight-plus-one-
 * hour.
 */

import { fromCivil, toCivil } from './format.js';

/** A rung of the ladder. */
export interface TimeInterval {
  /** Stable name, used to pick a default label format. */
  readonly unit: 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  /** How many units per step (1 hour, 3 hours, 6 hours…). */
  readonly every: number;
  /** Approximate length in ms, for choosing the rung. */
  readonly approx: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30.436875 * DAY;
const YEAR = 365.2425 * DAY;

/**
 * The ladder, coarsening left to right.
 *
 * The gaps are deliberate: there is no 4-hour rung because 4 does not divide 24
 * into halves a reader tracks, and no 10-day rung because "the 21st" is not a
 * boundary anyone recognises.
 */
export const TIME_LADDER: readonly TimeInterval[] = Object.freeze([
  { unit: 'millisecond', every: 1, approx: 1 },
  { unit: 'millisecond', every: 5, approx: 5 },
  { unit: 'millisecond', every: 25, approx: 25 },
  { unit: 'millisecond', every: 100, approx: 100 },
  { unit: 'millisecond', every: 250, approx: 250 },
  { unit: 'millisecond', every: 500, approx: 500 },
  { unit: 'second', every: 1, approx: SECOND },
  { unit: 'second', every: 5, approx: 5 * SECOND },
  { unit: 'second', every: 15, approx: 15 * SECOND },
  { unit: 'second', every: 30, approx: 30 * SECOND },
  { unit: 'minute', every: 1, approx: MINUTE },
  { unit: 'minute', every: 5, approx: 5 * MINUTE },
  { unit: 'minute', every: 15, approx: 15 * MINUTE },
  { unit: 'minute', every: 30, approx: 30 * MINUTE },
  { unit: 'hour', every: 1, approx: HOUR },
  { unit: 'hour', every: 3, approx: 3 * HOUR },
  { unit: 'hour', every: 6, approx: 6 * HOUR },
  { unit: 'hour', every: 12, approx: 12 * HOUR },
  { unit: 'day', every: 1, approx: DAY },
  { unit: 'day', every: 2, approx: 2 * DAY },
  { unit: 'week', every: 1, approx: WEEK },
  { unit: 'month', every: 1, approx: MONTH },
  { unit: 'month', every: 3, approx: 3 * MONTH },
  { unit: 'month', every: 6, approx: 6 * MONTH },
  { unit: 'year', every: 1, approx: YEAR },
]);

/**
 * Choose the rung whose step is closest to `span / count` on a log scale.
 *
 * Log distance, not linear: overshooting from 1 day to 1 week is the same
 * mistake as undershooting from 1 week to 1 day, and a linear comparison would
 * always prefer the finer rung.
 */
export function chooseInterval(span: number, count: number): TimeInterval {
  const target = span / Math.max(1, count);
  const first = TIME_LADDER[0] as TimeInterval;
  const last = TIME_LADDER[TIME_LADDER.length - 1] as TimeInterval;
  if (!Number.isFinite(target) || target <= 0) return first;
  if (target >= last.approx) {
    // Past a year, keep the calendar but coarsen the year step on the 1/2/5
    // ladder so a century does not emit 100 labels.
    const years = target / YEAR;
    const step = niceYearStep(years);
    return { unit: 'year', every: step, approx: step * YEAR };
  }
  let best = first;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const rung of TIME_LADDER) {
    const distance = Math.abs(Math.log(rung.approx / target));
    if (distance < bestDistance) {
      best = rung;
      bestDistance = distance;
    }
  }
  return best;
}

/** The 1 / 2 / 5 × 10ⁿ rung at or above `years`. */
function niceYearStep(years: number): number {
  const power = Math.max(0, Math.floor(Math.log(years) / Math.LN10));
  const base = 10 ** power;
  const error = years / base;
  const factor = error > 5 ? 10 : error > 2 ? 5 : error > 1 ? 2 : 1;
  return Math.max(1, factor * base);
}

/** Floor an instant to the start of `interval` in `timeZone`. */
export function floorTime(instant: Date, interval: TimeInterval, timeZone: string): Date {
  const c = toCivil(instant, timeZone);
  switch (interval.unit) {
    case 'year': {
      const year = Math.floor(c.year / interval.every) * interval.every;
      return fromCivil({ year, month: 1, day: 1 }, timeZone);
    }
    case 'month': {
      const month = Math.floor((c.month - 1) / interval.every) * interval.every + 1;
      return fromCivil({ year: c.year, month, day: 1 }, timeZone);
    }
    case 'week': {
      const midnight = fromCivil({ year: c.year, month: c.month, day: c.day }, timeZone);
      // Weeks start on Sunday, matching the bundled day names.
      return new Date(midnight.getTime() - c.weekday * DAY);
    }
    case 'day': {
      if (interval.every === 1) {
        return fromCivil({ year: c.year, month: c.month, day: c.day }, timeZone);
      }
      // Multi-day steps anchor on the first of the month so the ladder restarts
      // cleanly rather than drifting across month boundaries.
      const day = Math.floor((c.day - 1) / interval.every) * interval.every + 1;
      return fromCivil({ year: c.year, month: c.month, day }, timeZone);
    }
    case 'hour': {
      const hour = Math.floor(c.hour / interval.every) * interval.every;
      return fromCivil({ year: c.year, month: c.month, day: c.day, hour }, timeZone);
    }
    case 'minute': {
      const minute = Math.floor(c.minute / interval.every) * interval.every;
      return fromCivil(
        { year: c.year, month: c.month, day: c.day, hour: c.hour, minute },
        timeZone,
      );
    }
    case 'second': {
      const second = Math.floor(c.second / interval.every) * interval.every;
      return fromCivil(
        { year: c.year, month: c.month, day: c.day, hour: c.hour, minute: c.minute, second },
        timeZone,
      );
    }
    case 'millisecond':
    default: {
      const time = instant.getTime();
      return new Date(Math.floor(time / interval.every) * interval.every);
    }
  }
}

/** Advance one step from a floored instant. Calendar units keep civil alignment. */
export function stepTime(instant: Date, interval: TimeInterval, timeZone: string): Date {
  const c = toCivil(instant, timeZone);
  switch (interval.unit) {
    case 'year':
      return fromCivil({ year: c.year + interval.every, month: 1, day: 1 }, timeZone);
    case 'month': {
      const total = c.month - 1 + interval.every;
      return fromCivil(
        { year: c.year + Math.floor(total / 12), month: (total % 12) + 1, day: 1 },
        timeZone,
      );
    }
    case 'week':
      return new Date(instant.getTime() + interval.every * WEEK);
    case 'day': {
      if (interval.every === 1) {
        // Add a nominal day then re-floor: DST days are 23 or 25 hours long.
        const nominal = new Date(instant.getTime() + DAY + 2 * HOUR);
        const n = toCivil(nominal, timeZone);
        return fromCivil({ year: n.year, month: n.month, day: n.day }, timeZone);
      }
      const day = c.day + interval.every;
      const daysInMonth = daysIn(c.year, c.month);
      return day > daysInMonth
        ? fromCivil(
            { year: c.month === 12 ? c.year + 1 : c.year, month: (c.month % 12) + 1, day: 1 },
            timeZone,
          )
        : fromCivil({ year: c.year, month: c.month, day }, timeZone);
    }
    case 'hour':
      return new Date(instant.getTime() + interval.every * HOUR);
    case 'minute':
      return new Date(instant.getTime() + interval.every * MINUTE);
    case 'second':
      return new Date(instant.getTime() + interval.every * SECOND);
    case 'millisecond':
    default:
      return new Date(instant.getTime() + interval.every);
  }
}

/** Days in a civil month. */
function daysIn(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Hard cap so a pathological domain cannot allocate an unbounded tick array. */
const MAX_TIME_TICKS = 1000;

/** Calendar ticks covering `[start, stop]`, inclusive of boundaries that land exactly. */
export function timeTicks(start: Date, stop: Date, count: number, timeZone: string): Date[] {
  const t0 = start.getTime();
  const t1 = stop.getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [];
  if (t0 === t1) return [new Date(t0)];
  const reverse = t1 < t0;
  const lo = reverse ? t1 : t0;
  const hi = reverse ? t0 : t1;

  const interval = chooseInterval(hi - lo, count);
  const out: Date[] = [];
  let cursor = floorTime(new Date(lo), interval, timeZone);
  if (cursor.getTime() < lo) cursor = stepTime(cursor, interval, timeZone);
  let guard = 0;
  while (cursor.getTime() <= hi && guard < MAX_TIME_TICKS) {
    out.push(new Date(cursor.getTime()));
    const next = stepTime(cursor, interval, timeZone);
    if (next.getTime() <= cursor.getTime()) break;
    cursor = next;
    ++guard;
  }
  if (reverse) out.reverse();
  return out;
}

/** Extend `[start, stop]` outward to the enclosing calendar boundaries. */
export function niceTimeDomain(
  start: Date,
  stop: Date,
  count: number,
  timeZone: string,
): [Date, Date] {
  const t0 = start.getTime();
  const t1 = stop.getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t0 === t1) return [start, stop];
  const reverse = t1 < t0;
  const lo = new Date(reverse ? t1 : t0);
  const hi = new Date(reverse ? t0 : t1);

  const interval = chooseInterval(hi.getTime() - lo.getTime(), count);
  const flooredLo = floorTime(lo, interval, timeZone);
  let ceiledHi = floorTime(hi, interval, timeZone);
  if (ceiledHi.getTime() < hi.getTime()) ceiledHi = stepTime(ceiledHi, interval, timeZone);
  return reverse ? [ceiledHi, flooredLo] : [flooredLo, ceiledHi];
}

/**
 * The default label pattern for a ladder rung (SPEC 7.3, `format` default).
 *
 * Chosen by the *step*, not by the value: an axis stepping by months wants
 * `Jan 2024`, even where one of its ticks happens to fall on the 1st of January.
 */
export function defaultTimeFormat(interval: TimeInterval): string {
  switch (interval.unit) {
    case 'year':
      return '%Y';
    case 'month':
      return '%b %Y';
    case 'week':
    case 'day':
      return '%b %-d';
    case 'hour':
      return '%-I %p';
    case 'minute':
      return '%-I:%M %p';
    case 'second':
      return '%-I:%M:%S';
    case 'millisecond':
    default:
      return '%-I:%M:%S.%L';
  }
}

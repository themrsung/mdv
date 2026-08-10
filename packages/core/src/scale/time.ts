/**
 * The temporal scale (SPEC 7.2, `time`).
 *
 * Linear in milliseconds, calendar-aware in its ticks. The timezone comes from
 * configuration, never from the host (SPEC 24.3 rule 3), so the same document
 * renders the same axis in Seoul and in São Paulo.
 */

import type { Scale } from '../types/encode.js';
import { formatDate } from './format.js';
import { attachRerange } from './rerange.js';
import { chooseInterval, defaultTimeFormat, niceTimeDomain, timeTicks } from './time-ticks.js';

/** Construction options for {@link createTimeScale}. */
export interface TimeScaleOptions {
  domain: readonly [Date, Date];
  range: readonly [number, number];
  clamp?: boolean;
  /** strftime pattern; otherwise chosen from the tick interval. */
  format?: string;
  /** IANA zone. @defaultValue 'UTC' */
  timezone?: string;
  /** @defaultValue 5 */
  tickCount?: number;
  /** Flip the range; re-applied by {@link Rerangeable.withRange}. */
  reverse?: boolean;
}

/** Build a temporal scale. Frozen and stateless, like every other scale. */
export function createTimeScale(options: TimeScaleOptions): Scale<Date, number> {
  const timezone = options.timezone ?? 'UTC';
  const tickCount = options.tickCount ?? 5;

  let [d0, d1] = options.domain;
  if (!(d0 instanceof Date) || Number.isNaN(d0.getTime())) d0 = new Date(0);
  if (!(d1 instanceof Date) || Number.isNaN(d1.getTime())) d1 = new Date(d0.getTime() + 86_400_000);
  if (d0.getTime() === d1.getTime()) {
    // A single instant is not an axis: give it a day of context.
    d0 = new Date(d0.getTime() - 43_200_000);
    d1 = new Date(d1.getTime() + 43_200_000);
  }

  const [r0, r1] =
    options.reverse === true
      ? [options.range[1], options.range[0]]
      : [options.range[0], options.range[1]];
  const t0 = d0.getTime();
  const t1 = d1.getTime();
  const tSpan = t1 - t0;
  const rSpan = r1 - r0;
  const lo = Math.min(t0, t1);
  const hi = Math.max(t0, t1);
  const tolerance = Math.abs(tSpan) * 1e-9;

  const domain: readonly Date[] = Object.freeze([new Date(t0), new Date(t1)]);
  const range: readonly number[] = Object.freeze([r0, r1]);

  const labeller = ((): ((value: Date) => string) => {
    if (options.format !== undefined && options.format !== '') {
      const pattern = options.format;
      return (value) => formatDate(value, pattern, timezone);
    }
    const pattern = defaultTimeFormat(chooseInterval(Math.abs(tSpan), tickCount));
    return (value) => formatDate(value, pattern, timezone);
  })();

  const scale: Scale<Date, number> = {
    type: 'time',
    domain,
    range,
    scale(value: Date): number | undefined {
      const time = value instanceof Date ? value.getTime() : Number.NaN;
      if (!Number.isFinite(time)) return undefined;
      if (time < lo - tolerance || time > hi + tolerance) {
        if (options.clamp !== true) return undefined;
        return time < lo ? (t0 <= t1 ? r0 : r1) : t0 <= t1 ? r1 : r0;
      }
      if (tSpan === 0) return r0;
      return r0 + ((time - t0) / tSpan) * rSpan;
    },
    invert(position: number): Date | undefined {
      if (!Number.isFinite(position) || rSpan === 0) return undefined;
      return new Date(Math.round(t0 + ((position - r0) / rSpan) * tSpan));
    },
    ticks(count?: number): readonly Date[] {
      return timeTicks(new Date(t0), new Date(t1), count ?? tickCount, timezone);
    },
    format: labeller,
  };
  return attachRerange(
    scale,
    (next) => createTimeScale({ ...options, range: [next[0], next[1]] }) as unknown as Scale,
  );
}

/** Derive a temporal domain from data, optionally rounded to calendar bounds. */
export function computeTimeDomain(
  values: Iterable<Date | number | null>,
  options: {
    nice?: boolean;
    explicit?: readonly (Date | number | null)[] | undefined;
    tickCount?: number;
    timezone?: string;
  } = {},
): [Date, Date] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const time = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : NaN;
    if (!Number.isFinite(time)) continue;
    if (time < min) min = time;
    if (time > max) max = time;
  }
  if (min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) {
    const epoch = 0;
    return [new Date(epoch), new Date(epoch + 86_400_000)];
  }

  const explicitMin = options.explicit?.[0];
  const explicitMax = options.explicit?.[1];
  const asTime = (v: Date | number | null | undefined): number | undefined => {
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    return undefined;
  };
  const pinnedMin = asTime(explicitMin);
  const pinnedMax = asTime(explicitMax);
  if (pinnedMin !== undefined) min = pinnedMin;
  if (pinnedMax !== undefined) max = pinnedMax;

  if (min === max) {
    min -= 43_200_000;
    max += 43_200_000;
  }

  if (options.nice !== false && !(pinnedMin !== undefined && pinnedMax !== undefined)) {
    const [niceMin, niceMax] = niceTimeDomain(
      new Date(min),
      new Date(max),
      options.tickCount ?? 5,
      options.timezone ?? 'UTC',
    );
    if (pinnedMin === undefined) min = niceMin.getTime();
    if (pinnedMax === undefined) max = niceMax.getTime();
  }
  return [new Date(min), new Date(max)];
}

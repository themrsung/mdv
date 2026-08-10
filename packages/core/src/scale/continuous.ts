/**
 * Continuous scales (SPEC 7.2): `linear`, `log`, `sqrt`, `pow`, `symlog`.
 *
 * All five are the same machine with a different transform pair, which is what
 * keeps `invert` exact and keeps a `sqrt` size scale honest about zero.
 *
 * **Out-of-domain values return `undefined`** unless `clamp` is set, per the
 * {@link Scale} contract. A tolerance of one part in 10⁹ of the span absorbs the
 * float error of a `nice`-ed bound so a datum sitting exactly on the maximum is
 * never silently dropped.
 */

import type { Scale, ScaleType } from '../types/encode.js';
import { formatNumber, numberConventions, tickNumberFormatter } from './format.js';
import { attachRerange } from './rerange.js';
import { niceDomain, padDegenerate, ticks as linearTicks, tickStep } from './ticks.js';

/** Construction options shared by every continuous scale. */
export interface ContinuousScaleOptions {
  type: 'linear' | 'log' | 'sqrt' | 'pow' | 'symlog';
  /** `[min, max]` in data space, already niced by {@link computeContinuousDomain}. */
  domain: readonly [number, number];
  /** `[start, end]` in scene units. Reverse by passing `[end, start]`. */
  range: readonly [number, number];
  /** Log base. @defaultValue 10 */
  base?: number;
  /** `pow` exponent. @defaultValue 1 */
  exponent?: number;
  /** `symlog` linear-region width. @defaultValue 1 */
  constant?: number;
  /** Clip out-of-domain values into the range instead of returning `undefined`. */
  clamp?: boolean;
  /** Explicit d3-format pattern; otherwise derived from the tick step. */
  format?: string;
  /** @defaultValue 'en-US' */
  locale?: string;
  /** Tick-count hint used for the default format. @defaultValue 5 */
  tickCount?: number;
  /**
   * Flip the range. Applied inside the factory rather than by the caller so that
   * {@link Rerangeable.withRange} can re-apply it when core re-ranges onto the
   * plot frame.
   */
  reverse?: boolean;
}

/** A forward/inverse transform pair on the real line. */
interface TransformPair {
  forward(value: number): number;
  inverse(value: number): number;
}

function transformFor(options: ContinuousScaleOptions): TransformPair {
  switch (options.type) {
    case 'log': {
      const base = options.base !== undefined && options.base > 1 ? options.base : 10;
      const lnBase = Math.log(base);
      return {
        forward: (v) => Math.log(v) / lnBase,
        inverse: (v) => base ** v,
      };
    }
    case 'sqrt':
      return {
        forward: (v) => Math.sign(v) * Math.sqrt(Math.abs(v)),
        inverse: (v) => Math.sign(v) * v * v,
      };
    case 'pow': {
      const k = options.exponent ?? 1;
      const inverseK = k === 0 ? 1 : 1 / k;
      return {
        forward: (v) => Math.sign(v) * Math.abs(v) ** k,
        inverse: (v) => Math.sign(v) * Math.abs(v) ** inverseK,
      };
    }
    case 'symlog': {
      const c = options.constant !== undefined && options.constant > 0 ? options.constant : 1;
      return {
        forward: (v) => Math.sign(v) * Math.log1p(Math.abs(v / c)),
        inverse: (v) => Math.sign(v) * c * Math.expm1(Math.abs(v)),
      };
    }
    case 'linear':
    default:
      return { forward: (v) => v, inverse: (v) => v };
  }
}

/**
 * Build a continuous scale.
 *
 * The returned object is frozen and holds no mutable state: two calls with the
 * same options produce interchangeable instances, and a chart type may hand the
 * instance to core for axis ticking without fear of it being reconfigured
 * underneath (the registry contract requires exactly that).
 */
export function createContinuousScale(options: ContinuousScaleOptions): Scale<number, number> {
  const locale = options.locale ?? 'en-US';
  const tickCount = options.tickCount ?? 5;
  const transform = transformFor(options);

  let [d0, d1] = options.domain;
  if (!Number.isFinite(d0) || !Number.isFinite(d1)) [d0, d1] = [0, 1];
  if (d0 === d1) [d0, d1] = padDegenerate(d0);
  if (options.type === 'log') {
    // A log domain must be strictly positive; non-positive rows were dropped
    // upstream with MDV3020, but an explicit `domain:` can still ask for one.
    if (d0 <= 0) d0 = d1 > 0 ? Math.min(d1 / 1000, 1) : 1;
    if (d1 <= d0) d1 = d0 * 10;
  }

  const [r0, r1] =
    options.reverse === true
      ? [options.range[1], options.range[0]]
      : [options.range[0], options.range[1]];
  const t0 = transform.forward(d0);
  const t1 = transform.forward(d1);
  const tSpan = t1 - t0;
  const rSpan = r1 - r0;
  const tolerance = Math.abs(d1 - d0) * 1e-9;

  const domain: readonly number[] = Object.freeze([d0, d1]);
  const range: readonly number[] = Object.freeze([r0, r1]);

  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);

  const scaleValue = (value: number): number | undefined => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    if (value < lo - tolerance || value > hi + tolerance) {
      if (options.clamp !== true) return undefined;
      return value < lo ? (d0 <= d1 ? r0 : r1) : d0 <= d1 ? r1 : r0;
    }
    if (tSpan === 0) return r0;
    const position = r0 + ((transform.forward(value) - t0) / tSpan) * rSpan;
    if (!Number.isFinite(position)) return undefined;
    if (options.clamp === true) {
      const rLo = Math.min(r0, r1);
      const rHi = Math.max(r0, r1);
      return Math.min(rHi, Math.max(rLo, position));
    }
    return position;
  };

  const tickValues = (count?: number): number[] => {
    const n = count ?? tickCount;
    if (options.type === 'log') {
      const base = options.base !== undefined && options.base > 1 ? options.base : 10;
      return logTicks(lo, hi, base, n);
    }
    return linearTicks(d0, d1, n);
  };

  const defaultFormatter = ((): ((value: number) => string) => {
    if (options.format !== undefined && options.format !== '') {
      const pattern = options.format;
      return (value) => formatNumber(value, pattern, locale);
    }
    if (options.type === 'log') {
      const conventions = numberConventions(locale);
      return (value) => logLabel(value, conventions.group, conventions.decimal);
    }
    const step = tickStep(d0, d1, tickCount);
    return tickNumberFormatter(Number.isFinite(step) ? step : 1, locale);
  })();

  const scale: Scale<number, number> = {
    type: options.type as ScaleType,
    domain,
    range,
    scale: scaleValue,
    invert(position: number): number | undefined {
      if (!Number.isFinite(position) || rSpan === 0) return undefined;
      const t = t0 + ((position - r0) / rSpan) * tSpan;
      const value = transform.inverse(t);
      return Number.isFinite(value) ? value : undefined;
    },
    ticks: tickValues,
    format: defaultFormatter,
  };
  return attachRerange(
    scale,
    (next) => createContinuousScale({ ...options, range: [next[0], next[1]] }) as unknown as Scale,
  );
}

/**
 * Ticks for a log domain.
 *
 * Below one decade per tick the mantissa ladder subdivides (1, 2, 5 — or every
 * integer when there is room); above it, whole decades step by an integer so the
 * labels stay powers of the base.
 */
export function logTicks(lo: number, hi: number, base: number, count: number): number[] {
  if (!(lo > 0) || !(hi > lo)) return [];
  const lnBase = Math.log(base);
  // `Math.log(1e6) / Math.log(10)` is 5.999999999999999, and an un-snapped
  // exponent turns "six decades" into "five and a bit" — which changes the
  // decade stride and drops the top label. Snap to the integer when we are
  // within a rounding error of one.
  const logLo = snapExponent(Math.log(lo) / lnBase);
  const logHi = snapExponent(Math.log(hi) / lnBase);
  const decades = logHi - logLo;
  const out: number[] = [];

  if (decades >= count) {
    const step = Math.max(1, Math.round(decades / Math.max(1, count)));
    for (let i = Math.ceil(logLo); i <= Math.floor(logHi) + 1e-9; i += step) {
      const value = base ** i;
      if (value >= lo * (1 - 1e-9) && value <= hi * (1 + 1e-9)) out.push(value);
    }
    if (out.length > 0) return out;
  }

  const mantissas =
    base === 10
      ? decades * 8 <= count
        ? [1, 2, 3, 4, 5, 6, 7, 8, 9]
        : decades * 3 <= count
          ? [1, 2, 5]
          : [1]
      : [1];

  for (let i = Math.floor(logLo); i <= Math.ceil(logHi); ++i) {
    const decade = base ** i;
    for (const m of mantissas) {
      const value = m * decade;
      if (value >= lo * (1 - 1e-9) && value <= hi * (1 + 1e-9)) out.push(value);
    }
  }
  return out;
}

/** Round an exponent that is within 1e-9 of an integer to that integer. */
function snapExponent(value: number): number {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) < 1e-9 ? rounded : value;
}

/** A log label: plain digits, never `1e-7`. */
function logLabel(value: number, groupSeparator: string, decimalSeparator: string): string {
  if (!Number.isFinite(value)) return '';
  const abs = Math.abs(value);
  if (abs >= 1 && abs < 1e21 && Number.isInteger(value)) {
    const digits = Math.abs(value).toFixed(0);
    let grouped = '';
    let n = 0;
    for (let i = digits.length - 1; i >= 0; --i) {
      grouped = digits[i] + grouped;
      if (++n % 3 === 0 && i > 0) grouped = groupSeparator + grouped;
    }
    return (value < 0 ? '−' : '') + grouped;
  }
  const decimals = abs === 0 ? 0 : Math.max(0, Math.min(10, -Math.floor(Math.log10(abs))));
  return value.toFixed(decimals).replace('.', decimalSeparator);
}

/** How a quantitative domain should be derived (SPEC 7.2, "Domain rules"). */
export interface DomainOptions {
  /** Extend to include zero. Bars and areas default to `true`. */
  zero?: boolean;
  /** Round outward to a clean step. @defaultValue true */
  nice?: boolean;
  /** `[min, max]`; a `null` pins only one end. */
  explicit?: readonly (number | null)[] | undefined;
  /** Tick-count hint used by `nice`. @defaultValue 5 */
  tickCount?: number;
  /** Keep the domain strictly positive (log scales). */
  positive?: boolean;
}

/**
 * Derive a quantitative domain from data extent plus the author's requests.
 *
 * Order matters and is normative: explicit bounds win over `zero`, `zero` widens
 * the extent, and `nice` rounds last so the axis ends on a label a reader can
 * read (SPEC 7.2).
 */
export function computeContinuousDomain(
  values: Iterable<number>,
  options: DomainOptions = {},
): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (options.positive === true && value <= 0) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (min === Number.POSITIVE_INFINITY || max === Number.NEGATIVE_INFINITY) {
    return options.positive === true ? [1, 10] : [0, 1];
  }

  if (options.zero === true && options.positive !== true) {
    if (min > 0) min = 0;
    if (max < 0) max = 0;
  }
  if (min === max) {
    if (options.positive === true) {
      min = min / 10;
      max = max * 10;
    } else {
      [min, max] = padDegenerate(min);
    }
  }

  const explicitMin = options.explicit?.[0];
  const explicitMax = options.explicit?.[1];
  if (typeof explicitMin === 'number' && Number.isFinite(explicitMin)) min = explicitMin;
  if (typeof explicitMax === 'number' && Number.isFinite(explicitMax)) max = explicitMax;
  if (min === max)
    [min, max] = options.positive === true ? [min / 10, max * 10] : padDegenerate(min);

  const pinnedMin = typeof explicitMin === 'number';
  const pinnedMax = typeof explicitMax === 'number';
  if (options.nice !== false && !(pinnedMin && pinnedMax) && options.positive !== true) {
    const [niceMin, niceMax] = niceDomain(min, max, options.tickCount ?? 5);
    if (!pinnedMin) min = niceMin;
    if (!pinnedMax) max = niceMax;
  }
  if (options.positive === true) {
    if (min <= 0) min = Math.min(max / 1000, 1);
    if (max <= min) max = min * 10;
  }
  return [min, max];
}

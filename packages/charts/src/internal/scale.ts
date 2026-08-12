/**
 * Scale construction (SPEC 7.2).
 *
 * `encode` builds these; **core ticks the very same instances** for the axes, so
 * a bar edge and a gridline always land on the same pixel (see the contract at
 * the top of `@mdv/core/registry`).
 *
 * ## The range handshake
 *
 * `encode` never sees a pixel, but a positional scale's range *is* pixels. The
 * handshake resolves that by construction order: `encode` fixes the **domain**,
 * core reserves axis space (which needs only {@link Scale.ticks}, a function of
 * the domain), core computes the plot frame, and the chart type's `layout` then
 * calls {@link setScaleRange} on the same instance before any geometry is
 * computed. Core draws its axis furniture after `layout` returns, so it reads the
 * range the frame implies.
 *
 * CONTRACT: `@mdv/core`'s `Scale` declares `range` readonly and offers no
 * re-ranging member, so the setter lives on the concrete objects here and is
 * reached through the duck-typed {@link setScaleRange}. A `withRange(r0, r1)`
 * member on `Scale` in `packages/core/src/types/encode.ts` would make this
 * explicit rather than conventional.
 */

import type { Scale, ScaleInput, ScaleType } from '@mdv/core';
import {
  bandGeometry,
  niceDomain,
  tickStep as coreTickStep,
  ticks as coreTicks,
  timeTicks as coreTimeTicks,
} from '@mdv/core';
import { compareNumbers, finite, isFiniteNumber, safeDiv } from './num.js';
import { formatDate, formatNumber } from './format.js';

/**
 * A scale whose output range can be fixed once the plot frame is known.
 *
 * Two members, because core reaches for the range in two different ways and
 * both have to arrive at the same geometry:
 *
 * - {@link MutableScale.setRange} is the in-place handshake described above:
 *   this package's `layout` fixes the range on the instance `encode` built.
 * - {@link Rerangeable.withRange} is core's: `layout/block.ts` re-ranges every
 *   positional scale onto the measured frame *before* handing the bundle to
 *   `layout`, through `rerangeScale`.
 *
 * `withRange` used to be missing here, so `isRerangeable` was false for every
 * scale this package builds and core silently fell through to its documented
 * "best-effort reconstruction of a foreign scale" on **every real chart**. That
 * path is not faithful for bands: it recovers padding from `bandwidth()/step()`
 * — which is `0/0` before a range is set — and then uses `outer = inner / 2`,
 * where this package uses `outer = inner`. The step came out `span / n` instead
 * of `span / (n + padding)`, so the axis ladder core drew and the bars this
 * package drew were computed from different geometry. Implementing `withRange`
 * makes the path lossless by construction rather than by coincidence.
 */
export interface MutableScale extends Scale {
  /** Replace the output range in place. Called exactly once, from `layout`. */
  setRange(r0: number, r1: number): void;
  /** The same scale on a different range, as a fresh instance (core's `Rerangeable`). */
  withRange(range: readonly [number, number]): MutableScale;
}

/** Duck-typed re-range; a no-op for any scale that does not support it. */
export function setScaleRange(scale: Scale | undefined, r0: number, r1: number): void {
  if (scale === undefined) return;
  const candidate = scale as Partial<MutableScale>;
  if (typeof candidate.setRange === 'function') {
    candidate.setRange(finite(r0, 0), finite(r1, 0));
  }
}

/** Numeric projection of any scale input; `undefined` when it has none. */
export function toNumeric(value: ScaleInput | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/** Stable key for a discrete domain member. Dates key by epoch, not by locale text. */
export function discreteKey(value: ScaleInput | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? `@${t}` : '';
  }
  return String(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick ladders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The round step nearest to `span / count`, from the 1–2–5–10 ladder.
 *
 * Ticks prefer round values over hitting the requested count exactly: `ticks` is
 * a hint (SPEC 7.3).
 *
 * DELEGATES to `@mdv/core`. This package used to carry its own ladder, and the
 * two agreed on every *step* but disagreed on the *values*: core computes a
 * sub-unit step as a negative "inverse step" and divides an integer index by it,
 * where this file multiplied a float, so a 0.1 ladder came out
 * `0, 0.1, 0.2, 0.30000000000000004, …` here and `0, 0.1, 0.2, 0.3, …` there.
 * Core draws the axis ladder and this package draws the marks, so the two ran
 * against each other on the same chart and SPEC 28.10's byte-identical promise
 * held only by luck. There is now exactly one implementation.
 *
 * The wrappers keep this package's *edge-case* contract, which is deliberately
 * more forgiving than core's — a caller here gets `1` for a degenerate span
 * rather than `NaN`, because a NaN step propagates into geometry.
 */
export function tickStep(start: number, stop: number, count: number): number {
  const step = coreTickStep(Math.min(start, stop), Math.max(start, stop), count > 0 ? count : 1);
  return Number.isFinite(step) && step !== 0 ? step : 1;
}

/** Round tick values spanning `[start, stop]`, inclusive of aligned endpoints. */
export function linearTicks(start: number, stop: number, count: number): number[] {
  const lo = Math.min(start, stop);
  const hi = Math.max(start, stop);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  const out = coreTicks(lo, hi, count > 0 ? count : 1);
  // A pathological domain (huge span, tiny step) must not allocate unboundedly.
  // Core has no cap because core's own scales pre-`nice` their domains; this
  // package accepts raw author domains, so the guard stays on this side.
  if (out.length > TICK_CAP) out.length = TICK_CAP;
  for (let i = 0; i < out.length; i += 1) if (out[i] === 0) out[i] = 0; // normalise -0
  return start > stop ? out.reverse() : out;
}

/** The most ticks `linearTicks` will ever return. */
const TICK_CAP = 1001;

/** Extend `[lo, hi]` outward to the enclosing round step. */
export function niceBounds(lo: number, hi: number, count = 10): [number, number] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (lo === hi) return [lo, hi];
  const [niceLo, niceHi] = niceDomain(Math.min(lo, hi), Math.max(lo, hi), count);
  return [niceLo === 0 ? 0 : niceLo, niceHi === 0 ? 0 : niceHi];
}

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;

/**
 * The timezone this package's temporal scales tick in.
 *
 * UTC, which is what the ladder here has always assumed (it used `Date.UTC` and
 * `getUTC*` throughout) and what `LayoutContext.timezone` defaults to. Core's
 * `timeTicks` is civil-boundary-aware and takes the zone as an argument, so the
 * moment a chart type is given the layout context at encode time this becomes
 * `ctx.timezone` and daily ticks stop drifting across a DST transition.
 *
 * CONTRACT: `EncodeInput` (`packages/core/src/registry.ts`) carries no timezone.
 * Adding one would let this constant go.
 */
const TICK_TIMEZONE = 'UTC';

/**
 * Time ticks over `[lo, hi]` epoch milliseconds.
 *
 * DELEGATES to `@mdv/core`, for the same reason the numeric ladder does. The two
 * ladders were not the same ladder: this one had 10 ms and 100 ms rungs and no
 * 5/25/250/500 ms rungs, no week rung, and it stepped months by
 * `Date.UTC(y, m, 1)` arithmetic rather than by civil flooring — so core's axis
 * and this package's marks could choose different rungs for the same domain.
 */
export function timeTicks(lo: number, hi: number, count: number): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [];
  if (lo === hi) return [lo];
  return coreTimeTicks(new Date(lo), new Date(hi), count > 0 ? count : 1, TICK_TIMEZONE).map((d) =>
    d.getTime(),
  );
}

/** Pick a strftime pattern that suits the tick spacing. */
export function timeFormatFor(spanMs: number): string {
  if (spanMs < MS_SECOND) return '%H:%M:%S.%L';
  if (spanMs < MS_MINUTE) return '%H:%M:%S';
  if (spanMs < MS_DAY) return '%H:%M';
  if (spanMs < 30 * MS_DAY) return '%b %d';
  if (spanMs < 365 * MS_DAY) return '%b %Y';
  return '%Y';
}

// ─────────────────────────────────────────────────────────────────────────────
// Continuous scales
// ─────────────────────────────────────────────────────────────────────────────

/** Options shared by the continuous scale factories. */
export interface ContinuousScaleOptions {
  domain: readonly [number, number];
  range?: readonly [number, number];
  clamp?: boolean;
  reverse?: boolean;
  format?: string;
  /** For `log`. @defaultValue 10 */
  base?: number;
  /** For `pow`. @defaultValue 1 */
  exponent?: number;
  /** For `symlog`. @defaultValue 1 */
  constant?: number;
}

/** Forward/inverse transform pair defining a continuous scale family. */
interface Transform {
  forward(value: number): number;
  inverse(value: number): number;
}

function transformFor(type: ScaleType, options: ContinuousScaleOptions): Transform {
  switch (type) {
    case 'log': {
      const base = options.base !== undefined && options.base > 1 ? options.base : 10;
      const logBase = Math.log(base);
      return {
        forward: (v) => (v > 0 ? Math.log(v) / logBase : Number.NaN),
        inverse: (v) => base ** v,
      };
    }
    case 'sqrt':
      return {
        forward: (v) => (v < 0 ? -Math.sqrt(-v) : Math.sqrt(v)),
        inverse: (v) => (v < 0 ? -(v * v) : v * v),
      };
    case 'pow': {
      const k = options.exponent ?? 1;
      return {
        forward: (v) => (v < 0 ? -((-v) ** k) : v ** k),
        inverse: (v) => (v < 0 ? -((-v) ** (1 / k)) : v ** (1 / k)),
      };
    }
    case 'symlog': {
      const c = options.constant ?? 1;
      return {
        forward: (v) => Math.sign(v) * Math.log1p(Math.abs(v / c)),
        inverse: (v) => Math.sign(v) * c * Math.expm1(Math.abs(v)),
      };
    }
    default:
      return { forward: (v) => v, inverse: (v) => v };
  }
}

/**
 * Build a continuous scale (`linear`, `log`, `sqrt`, `pow`, `symlog`).
 *
 * A **degenerate domain** — a single row, or a column whose values are all equal —
 * maps every input to the midpoint of the range instead of dividing by zero. That
 * is the difference between a flat line and a scene full of `NaN`.
 */
export function createContinuousScale(
  type: ScaleType,
  options: ContinuousScaleOptions,
): MutableScale {
  const transform = transformFor(type, options);
  const d0 = finite(options.domain[0], 0);
  const d1 = finite(options.domain[1], d0);
  let r0 = finite(options.range?.[0], 0);
  let r1 = finite(options.range?.[1], 1);
  if (options.reverse === true) {
    const swap = r0;
    r0 = r1;
    r1 = swap;
  }
  const t0 = transform.forward(d0);
  const t1 = transform.forward(d1);
  const spanIsUsable = Number.isFinite(t0) && Number.isFinite(t1) && t1 !== t0;
  const domain: readonly number[] = [d0, d1];
  const formatSpec = options.format;

  const scale: MutableScale = {
    type,
    domain,
    get range(): readonly number[] {
      return [r0, r1];
    },
    setRange(next0: number, next1: number): void {
      if (options.reverse === true) {
        r0 = next1;
        r1 = next0;
      } else {
        r0 = next0;
        r1 = next1;
      }
    },
    withRange(next: readonly [number, number]): MutableScale {
      // Rebuilt from the original options rather than cloned, so every derived
      // quantity (the transform, the degenerate-domain guard, the reverse swap)
      // is recomputed exactly as it was the first time. `reverse` is applied by
      // the constructor, which is why `next` is passed through unswapped —
      // matching `setRange`, which also takes frame order.
      return createContinuousScale(type, { ...options, range: [next[0], next[1]] });
    },
    scale(value: ScaleInput): number | undefined {
      const numeric = toNumeric(value);
      if (numeric === undefined) return undefined;
      if (!spanIsUsable) return (r0 + r1) / 2;
      const t = transform.forward(numeric);
      if (!Number.isFinite(t)) return undefined;
      let ratio = (t - t0) / (t1 - t0);
      if (options.clamp === true) ratio = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
      const out = r0 + ratio * (r1 - r0);
      return Number.isFinite(out) ? out : undefined;
    },
    invert(pixel: number): number | undefined {
      if (!spanIsUsable) return d0;
      const ratio = safeDiv(pixel - r0, r1 - r0, 0);
      const value = transform.inverse(t0 + ratio * (t1 - t0));
      return Number.isFinite(value) ? value : undefined;
    },
    ticks(count = 10): readonly number[] {
      if (type === 'log') {
        return logTicks(d0, d1, options.base ?? 10, count);
      }
      return linearTicks(d0, d1, count);
    },
    format(value: ScaleInput): string {
      const numeric = toNumeric(value);
      return formatNumber(numeric ?? null, formatSpec);
    },
  };
  return scale;
}

/** Powers of `base` inside the domain, subdivided when the span is short. */
function logTicks(d0: number, d1: number, base: number, count: number): number[] {
  const lo = Math.min(d0, d1);
  const hi = Math.max(d0, d1);
  if (!(lo > 0) || !(hi > 0) || lo === hi) return lo > 0 ? [lo] : [];
  const logBase = Math.log(base > 1 ? base : 10);
  const e0 = Math.floor(Math.log(lo) / logBase);
  const e1 = Math.ceil(Math.log(hi) / logBase);
  const decades = e1 - e0;
  const out: number[] = [];
  const subdivisions = decades <= count / 2 ? [1, 2, 5] : [1];
  for (let e = e0; e <= e1 && out.length < 1000; e += 1) {
    for (const m of subdivisions) {
      const value = m * base ** e;
      if (value >= lo && value <= hi) out.push(value);
    }
  }
  return out.sort(compareNumbers);
}

/** Build a temporal scale over epoch milliseconds, exposing `Date` domain values. */
export function createTimeScale(options: {
  domain: readonly [Date, Date];
  range?: readonly [number, number];
  clamp?: boolean;
  format?: string;
}): MutableScale {
  const lo = options.domain[0].getTime();
  const hi = options.domain[1].getTime();
  const d0 = Number.isFinite(lo) ? lo : 0;
  const d1 = Number.isFinite(hi) ? hi : d0;
  let r0 = finite(options.range?.[0], 0);
  let r1 = finite(options.range?.[1], 1);
  const usable = d1 !== d0;
  const explicitFormat = options.format;

  const scale: MutableScale = {
    type: 'time',
    domain: [new Date(d0), new Date(d1)],
    get range(): readonly number[] {
      return [r0, r1];
    },
    setRange(next0: number, next1: number): void {
      r0 = next0;
      r1 = next1;
    },
    withRange(next: readonly [number, number]): MutableScale {
      return createTimeScale({ ...options, range: [next[0], next[1]] });
    },
    scale(value: ScaleInput): number | undefined {
      const numeric = toNumeric(value);
      if (numeric === undefined) return undefined;
      if (!usable) return (r0 + r1) / 2;
      let ratio = (numeric - d0) / (d1 - d0);
      if (options.clamp === true) ratio = ratio < 0 ? 0 : ratio > 1 ? 1 : ratio;
      const out = r0 + ratio * (r1 - r0);
      return Number.isFinite(out) ? out : undefined;
    },
    invert(pixel: number): Date | undefined {
      if (!usable) return new Date(d0);
      const ratio = safeDiv(pixel - r0, r1 - r0, 0);
      const t = d0 + ratio * (d1 - d0);
      return Number.isFinite(t) ? new Date(t) : undefined;
    },
    ticks(count = 8): readonly Date[] {
      return timeTicks(d0, d1, count).map((t) => new Date(t));
    },
    format(value: ScaleInput): string {
      const numeric = toNumeric(value);
      if (numeric === undefined) return '—';
      const pattern = explicitFormat ?? timeFormatFor(Math.abs(d1 - d0));
      return formatDate(new Date(numeric), pattern);
    },
  };
  return scale;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discrete scales
// ─────────────────────────────────────────────────────────────────────────────

/** Options for {@link createBandScale} and {@link createPointScale}. */
export interface BandScaleOptions {
  domain: readonly ScaleInput[];
  range?: readonly [number, number];
  /** Inner and outer padding as a fraction of the step. @defaultValue 0.2 */
  padding?: number;
  reverse?: boolean;
  format?: string;
  /** Formats a domain member for an axis label; defaults to `String`. */
  labelOf?(value: ScaleInput): string;
}

/**
 * A band scale: discrete domain → contiguous intervals (SPEC 7.2).
 *
 * An **empty domain** yields zero bandwidth and parks every lookup at the range
 * start, rather than producing `NaN` widths for a chart with no rows.
 *
 * `reverse` is applied **at construction as well as in `setRange`**, because
 * both paths receive the range in frame order and core uses `withRange` — which
 * goes through the constructor — for every re-range it performs itself. Swapping
 * in only one of them would have meant a reversed band read the right way round
 * when a chart type re-ranged it and the wrong way round when core did: the axis
 * ladder and the marks would have disagreed about which end the first category
 * sits at.
 *
 * A chart type that wants its categories to read top-to-bottom does not need
 * this flag: {@link rangeDownFrame} hands the range over already flipped, which
 * is how the horizontal bar chart does it. `reverse` is for a domain that is
 * built the wrong way round at the source.
 */
export function createBandScale(options: BandScaleOptions): MutableScale {
  const domain = [...options.domain];
  const index = new Map<string, number>();
  domain.forEach((value, i) => {
    const key = discreteKey(value);
    if (!index.has(key)) index.set(key, i);
  });
  const padding = clampPadding(options.padding ?? 0.2);
  let r0 = finite(options.range?.[0], 0);
  let r1 = finite(options.range?.[1], 1);
  if (options.reverse === true) {
    const swap = r0;
    r0 = r1;
    r1 = swap;
  }
  const labelOf = options.labelOf;
  const formatSpec = options.format;

  // One `padding` knob spends on both gaps (SPEC 8.1), which is core's default
  // too; the arithmetic itself is core's, so an axis core builds from the same
  // numbers lands on the same pixels as these bars.
  const geometry = (): { start: number; step: number; width: number; reverse: boolean } => {
    const { start, step, bandwidth, reverse } = bandGeometry({
      count: domain.length,
      range: [r0, r1],
      paddingInner: padding,
      paddingOuter: padding,
    });
    return { start, step, width: bandwidth, reverse };
  };

  const scale: MutableScale = {
    type: 'band',
    domain,
    get range(): readonly number[] {
      return [r0, r1];
    },
    setRange(next0: number, next1: number): void {
      if (options.reverse === true) {
        r0 = next1;
        r1 = next0;
      } else {
        r0 = next0;
        r1 = next1;
      }
    },
    withRange(next: readonly [number, number]): MutableScale {
      return createBandScale({ ...options, range: [next[0], next[1]] });
    },
    scale(value: ScaleInput): number | undefined {
      const i = index.get(discreteKey(value));
      if (i === undefined) return undefined;
      const { start, step, reverse } = geometry();
      const out = start + (reverse ? domain.length - 1 - i : i) * step;
      return Number.isFinite(out) ? out : undefined;
    },
    ticks(): readonly ScaleInput[] {
      return domain;
    },
    format(value: ScaleInput): string {
      if (labelOf !== undefined) return labelOf(value);
      if (value instanceof Date) return formatDate(value, formatSpec ?? '%Y-%m-%d');
      if (typeof value === 'number') return formatNumber(value, formatSpec);
      return String(value);
    },
    bandwidth(): number {
      const { width } = geometry();
      return width > 0 ? width : 0;
    },
    step(): number {
      const { step } = geometry();
      return step > 0 ? step : 0;
    },
  };
  return scale;
}

function clampPadding(value: number): number {
  if (!isFiniteNumber(value)) return 0.2;
  return value < 0 ? 0 : value > 0.9 ? 0.9 : value;
}

/**
 * A point scale: a band scale of zero width, for discrete x on line and scatter
 * (SPEC 7.2). A single-member domain sits at the range centre.
 */
export function createPointScale(options: BandScaleOptions): MutableScale {
  const domain = [...options.domain];
  const index = new Map<string, number>();
  domain.forEach((value, i) => {
    const key = discreteKey(value);
    if (!index.has(key)) index.set(key, i);
  });
  const padding = clampPadding(options.padding ?? 0.5);
  let r0 = finite(options.range?.[0], 0);
  let r1 = finite(options.range?.[1], 1);
  // Same construction-time swap as {@link createBandScale}, for the same reason.
  if (options.reverse === true) {
    const swap = r0;
    r0 = r1;
    r1 = swap;
  }
  const labelOf = options.labelOf;
  const formatSpec = options.format;

  // A point scale is a band scale with `paddingInner: 1` — zero width, and a
  // step of `span / (n − 1 + 2·padding)`. Deferring to core's {@link bandGeometry}
  // keeps the one formula in one place; the `n <= 1` case falls out of it as the
  // range centre, which is what a lone category wants.
  const geometry = (): { start: number; step: number; reverse: boolean } => {
    const { start, step, reverse } = bandGeometry({
      count: domain.length,
      range: [r0, r1],
      paddingInner: 1,
      paddingOuter: padding,
    });
    return { start, step, reverse };
  };

  const scale: MutableScale = {
    type: 'point',
    domain,
    get range(): readonly number[] {
      return [r0, r1];
    },
    setRange(next0: number, next1: number): void {
      if (options.reverse === true) {
        r0 = next1;
        r1 = next0;
      } else {
        r0 = next0;
        r1 = next1;
      }
    },
    withRange(next: readonly [number, number]): MutableScale {
      return createPointScale({ ...options, range: [next[0], next[1]] });
    },
    scale(value: ScaleInput): number | undefined {
      const i = index.get(discreteKey(value));
      if (i === undefined) return undefined;
      const { start, step, reverse } = geometry();
      const out = start + (reverse ? domain.length - 1 - i : i) * step;
      return Number.isFinite(out) ? out : undefined;
    },
    ticks(): readonly ScaleInput[] {
      return domain;
    },
    format(value: ScaleInput): string {
      if (labelOf !== undefined) return labelOf(value);
      if (value instanceof Date) return formatDate(value, formatSpec ?? '%Y-%m-%d');
      if (typeof value === 'number') return formatNumber(value, formatSpec);
      return String(value);
    },
    bandwidth(): number {
      return 0;
    },
    step(): number {
      // A lone category has a step in the geometry (the whole span) but no
      // spacing to report, and callers size marks off this number.
      return domain.length <= 1 ? 0 : geometry().step;
    },
  };
  return scale;
}

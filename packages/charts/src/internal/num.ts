/**
 * Numeric primitives shared by every chart type.
 *
 * The whole package's NaN-freedom guarantee rests on this module: geometry code
 * calls {@link finite} (or a helper built on it) at every point where data could
 * be degenerate — an empty extent, a single row, an all-null column, a zero-width
 * frame — so that no `NaN`, `Infinity` or `-0` ever reaches a scene node.
 *
 * Determinism (SPEC 24.3): no locale, no clock, no randomness. Comparators are
 * code-unit based, never `localeCompare`.
 */

/** `true` for a real, finite number. Rejects `NaN`, `±Infinity` and non-numbers. */
export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce anything to a finite number, falling back when it is not one.
 *
 * This is the single choke point that keeps `NaN` out of the scene graph. It also
 * normalises `-0` to `0`, because `-0` serialises as `"-0"` and would break
 * byte-identical output (SPEC 24.3).
 */
export function finite(value: unknown, fallback = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return value === 0 ? 0 : value;
}

/** Clamp into `[lo, hi]`. Returns `lo` when the bounds are inverted or non-finite. */
export function clamp(value: number, lo: number, hi: number): number {
  const v = finite(value, lo);
  const min = finite(lo, 0);
  const max = finite(hi, min);
  if (max <= min) return min;
  return v < min ? min : v > max ? max : v;
}

/**
 * `a / b`, or `fallback` when the quotient is not finite.
 *
 * Degenerate domains (`max === min`) and zero-size frames both reach division;
 * this is where they stop being a problem.
 */
export function safeDiv(a: number, b: number, fallback = 0): number {
  if (b === 0) return fallback;
  const q = a / b;
  return Number.isFinite(q) ? (q === 0 ? 0 : q) : fallback;
}

/**
 * Round to `digits` decimal places, half away from zero.
 *
 * `Math.round` is half-up, which is asymmetric about zero and would make a mark
 * at `-0.5` and its mirror at `+0.5` land differently. Geometry is rounded once,
 * here, so the SVG and PDF backends receive identical numbers.
 */
export function round(value: number, digits = 4): number {
  const v = finite(value, 0);
  if (!Number.isInteger(digits) || digits < 0 || digits > 15) return v;
  const factor = 10 ** digits;
  const scaled = v * factor;
  if (!Number.isFinite(scaled)) return v;
  const r = (scaled < 0 ? -Math.round(-scaled) : Math.round(scaled)) / factor;
  return r === 0 ? 0 : r;
}

/** Sum, skipping anything non-finite. Never `NaN`. */
export function sum(values: Iterable<number | null | undefined>): number {
  let total = 0;
  for (const v of values) if (isFiniteNumber(v)) total += v;
  return total === 0 ? 0 : total;
}

/** Ascending numeric comparator. `NaN` sorts last so it cannot poison a sort. */
export function compareNumbers(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (!af && !bf) return 0;
  if (!af) return 1;
  if (!bf) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Code-unit string comparator.
 *
 * `localeCompare` is banned in library code: it depends on the host's ICU data
 * and would make the same document sort differently on two machines
 * (SPEC 24.3 rule 3).
 */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Smallest finite value, or `undefined` when nothing was finite. */
export function minOf(values: Iterable<number>): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (best === undefined || v < best) best = v;
  }
  return best;
}

/** Largest finite value, or `undefined` when nothing was finite. */
export function maxOf(values: Iterable<number>): number | undefined {
  let best: number | undefined;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (best === undefined || v > best) best = v;
  }
  return best;
}

/** Linear interpolation, guarded against non-finite endpoints. */
export function lerp(a: number, b: number, t: number): number {
  const a0 = finite(a, 0);
  const b0 = finite(b, a0);
  const t0 = finite(t, 0);
  return a0 + (b0 - a0) * t0;
}

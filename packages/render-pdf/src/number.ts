/**
 * Deterministic number serialisation for PDF content streams (SPEC 24.3 rule 4).
 *
 * Every number that reaches a content stream, a page dictionary or the operator
 * trace goes through {@link roundTo} and {@link formatNumber}. One code path is
 * the only way byte-stability survives: two call sites with two roundings
 * produce two golden files for the same geometry.
 */

/** Decimals kept in content streams. Matches the scene graph's own precision. */
export const PDF_DECIMALS = 3;

/**
 * Round half to **even** at `decimals` places, normalising `-0` to `0`.
 *
 * Half-even rather than half-up because half-up is biased: a page full of `.5`s
 * drifts, and a backend that rounds differently from the SVG one makes the two
 * disagree about whether a label fits.
 *
 * @throws TypeError for a non-finite input — a `NaN` coordinate is an engine
 * bug upstream, never document content, and writing `0` for it would produce a
 * plausible-looking page that is quietly wrong.
 */
export function roundTo(value: number, decimals: number = PDF_DECIMALS): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `Non-finite value ${String(value)} reached the PDF backend; layout must not emit NaN or Infinity`,
    );
  }
  const p = decimals < 0 ? 0 : decimals > 12 ? 12 : Math.trunc(decimals);
  const scale = 10 ** p;
  const scaled = value * scale;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  if (rounded === 0) return 0;
  return rounded / scale;
}

/**
 * Render a number the way a PDF content stream wants it: no exponent, trailing
 * zeros stripped, `-0` normalised.
 *
 * PDF has no exponential notation for numbers, so `1e-7` written verbatim is a
 * syntax error that most viewers silently swallow — hence the explicit
 * `toFixed` path rather than `String(n)`.
 */
export function formatNumber(value: number, decimals: number = PDF_DECIMALS): string {
  const rounded = roundTo(value, decimals);
  if (rounded === 0) return '0';
  const p = decimals < 0 ? 0 : decimals > 12 ? 12 : Math.trunc(decimals);
  const fixed = rounded.toFixed(p);
  const trimmed = p === 0 ? fixed : fixed.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/** Clamp into `[lo, hi]`. Total: a `NaN` input yields `lo`. */
export function clamp(value: number, lo: number, hi: number): number {
  if (!(value > lo)) return lo;
  if (value > hi) return hi;
  return value;
}

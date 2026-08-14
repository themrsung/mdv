/**
 * The sparkline primitive: a bare series, laid out inside a strip.
 *
 * MDV draws a sparkline in four places and they are the same picture every time:
 * the `trend` strip of a `metric` tile (SPEC 8.13), a `sparkline` column of an
 * enhanced table (SPEC 10.1), the `sparkline` block type (SPEC 8.12), and the
 * inline `:mdv-spark[…]` directive (SPEC 9.2). The first two grew their own copy
 * of this arithmetic and the copies had already drifted — one guarded a
 * zero-sized strip and the other did not — which is exactly the drift a shared
 * module exists to stop. A tile's trend and the same numbers in a block must not
 * disagree about where the line goes.
 *
 * Two rules make the primitive total, and both are visible in the output rather
 * than hidden in a guard:
 *
 * 1. **A constant series is flat, not undefined.** Every value equal means a zero
 *    span, and normalising by it would be a division by zero. The line runs
 *    through the middle of the strip, which is the truthful picture: nothing
 *    changed.
 * 2. **A sparkline is self-scaled.** It has no axis, so its extent is its own
 *    min and max — there is no shared domain to inherit and no zero baseline to
 *    include. That is the whole bargain of the form: shape at a glance, and the
 *    number itself read from somewhere else.
 */

import type { Point } from './geometry.js';
import { isFiniteNumber } from './num.js';

/**
 * Parse a comma-separated series, the way an author writes one by hand.
 *
 * The same spelling serves `data="1,4,2,8"` on a block (SPEC 5.2), one cell of a
 * `sparkline` column (SPEC 10.1) and the body of `:mdv-spark[12,15,13,19,24]`
 * (SPEC 9.2). Unparseable entries are dropped rather than becoming `NaN`: a
 * stray trailing comma is a typo, not a reason to lose the series.
 */
export function parseSeries(text: unknown): number[] {
  if (text === null || text === undefined) return [];
  const out: number[] = [];
  for (const part of String(text).split(',')) {
    const trimmed = part.trim();
    if (trimmed === '') continue;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) out.push(numeric);
  }
  return out;
}

/** The rectangle a sparkline is drawn in. */
export interface SparkStrip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The extent to scale by, across every series that shares the strip.
 *
 * Taken over *all* the series at once, which is the whole reason this is a
 * separate function: a `band` (SPEC 8.12) is two more series drawn in the same
 * strip, and scaling each one to its own min and max would let the line escape
 * the band that is supposed to contain it. `undefined` means there was nothing
 * finite to scale.
 */
export function sparkExtent(
  series: readonly (readonly (number | null | undefined)[])[],
): [number, number] | undefined {
  let lo: number | undefined;
  let hi: number | undefined;
  for (const values of series) {
    for (const value of values) {
      if (!isFiniteNumber(value)) continue;
      if (lo === undefined || value < lo) lo = value;
      if (hi === undefined || value > hi) hi = value;
    }
  }
  if (lo === undefined || hi === undefined) return undefined;
  return [lo, hi];
}

/**
 * The x of the `index`-th of `count` evenly spaced points.
 *
 * A single point sits at the left edge rather than the centre, so that adding a
 * second observation moves the picture the way the reader expects: the series
 * grows rightwards from where it started.
 */
export function sparkX(strip: SparkStrip, index: number, count: number): number {
  if (count <= 1) return strip.x;
  return strip.x + (strip.width / (count - 1)) * index;
}

/** The y of one value under `extent`, top-down like every other screen scale. */
export function sparkY(
  strip: SparkStrip,
  value: number,
  extent: readonly [number, number],
): number {
  const [lo, hi] = extent;
  const span = hi - lo;
  // A constant series draws a flat line through the middle, not a divide-by-zero.
  if (span === 0) return strip.y + strip.height / 2;
  return strip.y + strip.height - ((value - lo) / span) * strip.height;
}

/**
 * Lay one series out inside its strip, self-scaled to its own extent.
 *
 * The convenience form, for the callers that draw a bare line and nothing else:
 * a `metric` tile's trend (SPEC 8.13) and a table's `sparkline` column
 * (SPEC 10.1). Non-finite entries are dropped **and the survivors re-spaced**,
 * which is why the `sparkline` block does not use this: a band's bounds are
 * indexed against the values they belong to, and dropping a value here would
 * slide the band out from under the line. Callers that draw more than the line
 * compose {@link sparkExtent}, {@link sparkX} and {@link sparkY} instead.
 *
 * A zero-sized strip yields no points at all — a run of coincident coordinates
 * is not a smaller sparkline, it is a smudge.
 *
 * @param values - the series, in order; non-finite entries are dropped
 * @param x - left edge of the strip
 * @param y - top edge of the strip
 * @param width - strip width; the first point sits at `x`, the last at `x + width`
 * @param height - strip height; the maximum sits at `y`, the minimum at `y + height`
 */
export function sparkPoints(
  values: readonly number[],
  x: number,
  y: number,
  width: number,
  height: number,
): Point[] {
  const usable = values.filter(isFiniteNumber);
  if (usable.length === 0 || width <= 0 || height <= 0) return [];
  const extent = sparkExtent([usable]);
  if (extent === undefined) return [];
  const strip: SparkStrip = { x, y, width, height };
  return usable.map((value, index) => ({
    x: sparkX(strip, index, usable.length),
    y: sparkY(strip, value, extent),
  }));
}

/**
 * Stacking arithmetic for bar and area (SPEC 8.2 `stack`, SPEC 8.4).
 *
 * Four modes: `none`, `normal`, `percent`, `center` (a streamgraph).
 *
 * **Negatives are not an edge case.** A stack containing both signs grows
 * positives upward from the baseline and negatives downward from it, so the two
 * never overlap and the baseline stays where the axis says it is. Folding a
 * negative into a positive run — which a naïve cumulative sum does — draws a
 * segment on the wrong side of zero and silently misstates the data.
 *
 * **`percent` sums to exactly 100.** Boundaries are computed as
 * `cumulative / total` rather than by accumulating fractions, so the last
 * positive boundary is `positiveTotal / positiveTotal`, which is exactly `1` in
 * IEEE 754. Accumulating `v / total` term by term is not exact and leaves a
 * visible sliver at the top of the last column.
 */

import type { StackMode } from './types.js';
import { isFiniteNumber } from './num.js';

/** One stacked span in data space. `y0` is the near edge, `y1` the far edge. */
export interface StackSegment {
  y0: number;
  y1: number;
  /** `false` when the source value was null or non-finite — nothing to draw. */
  defined: boolean;
}

/**
 * Stack one column of values — that is, the values of every series at a single
 * category — in series order.
 *
 * @param values - one entry per series, `null` where that series has no datum
 * @param mode - the `stack` attribute
 * @param baseline - where `stack: none` bars grow from (SPEC 8.2 `baseline`)
 */
export function stackColumn(
  values: readonly (number | null)[],
  mode: StackMode,
  baseline = 0,
): StackSegment[] {
  const base = isFiniteNumber(baseline) ? baseline : 0;

  if (mode === 'none') {
    return values.map((value) =>
      isFiniteNumber(value) ? { y0: base, y1: value, defined: true } : { y0: base, y1: base, defined: false },
    );
  }

  if (mode === 'percent') return stackPercent(values);

  // `normal` and `center` share the cumulative pass; `center` shifts afterwards.
  const segments: StackSegment[] = [];
  let positive = 0;
  let negative = 0;
  for (const value of values) {
    if (!isFiniteNumber(value)) {
      segments.push({ y0: 0, y1: 0, defined: false });
      continue;
    }
    if (value >= 0) {
      const start = positive;
      positive += value;
      segments.push({ y0: start, y1: positive, defined: true });
    } else {
      const start = negative;
      negative += value;
      segments.push({ y0: start, y1: negative, defined: true });
    }
  }

  if (mode === 'center') {
    // Centre the band on zero: a streamgraph has no meaningful baseline.
    const offset = (positive + negative) / 2;
    if (isFiniteNumber(offset) && offset !== 0) {
      for (const segment of segments) {
        segment.y0 -= offset;
        segment.y1 -= offset;
      }
    }
  }
  return segments;
}

/**
 * Percent stacking: each column spans exactly one unit of the axis.
 *
 * With mixed signs the column spans `[-negativeShare, +positiveShare]`, and
 * those two shares sum to exactly 1 — the whole column is still 100 % of the
 * absolute magnitude present at that category.
 */
function stackPercent(values: readonly (number | null)[]): StackSegment[] {
  let total = 0;
  for (const value of values) if (isFiniteNumber(value)) total += Math.abs(value);

  if (total === 0) {
    return values.map(() => ({ y0: 0, y1: 0, defined: false }));
  }

  const segments: StackSegment[] = [];
  let positive = 0;
  let negative = 0;
  for (const value of values) {
    if (!isFiniteNumber(value)) {
      segments.push({ y0: 0, y1: 0, defined: false });
      continue;
    }
    if (value >= 0) {
      const start = positive;
      positive += value;
      // Divide the cumulative sums, never accumulate quotients: the final
      // boundary is then exactly `positive / positive === 1`.
      segments.push({ y0: start / total, y1: positive / total, defined: true });
    } else {
      const start = negative;
      negative += value;
      segments.push({ y0: start / total, y1: negative / total, defined: true });
    }
  }
  return segments;
}

/** The outer extent a set of stacked columns occupies, for domain computation. */
export function stackExtent(columns: readonly (readonly StackSegment[])[]): [number, number] | undefined {
  let lo: number | undefined;
  let hi: number | undefined;
  for (const column of columns) {
    for (const segment of column) {
      if (!segment.defined) continue;
      for (const edge of [segment.y0, segment.y1]) {
        if (!isFiniteNumber(edge)) continue;
        if (lo === undefined || edge < lo) lo = edge;
        if (hi === undefined || edge > hi) hi = edge;
      }
    }
  }
  if (lo === undefined || hi === undefined) return undefined;
  return [lo, hi];
}

/** `true` for the modes that place series end to end rather than side by side. */
export function isStacked(mode: StackMode): boolean {
  return mode !== 'none';
}

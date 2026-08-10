/**
 * Stacking arithmetic (SPEC 8.2, 8.4).
 *
 * Three properties matter more than any individual number:
 *
 * 1. **Negatives grow downward from the baseline.** A negative value is never
 *    folded into the positive run — a stack of `[10, -4]` spans `[-4, 10]`, not
 *    `[0, 6]`, because the two facts "sold 10" and "returned 4" must both be
 *    visible.
 * 2. **Percent stacking sums to exactly 100 %.** Not 0.9999999999999999. The
 *    implementation divides cumulative sums rather than accumulating quotients
 *    precisely so the last boundary is `positive / positive`, which IEEE 754
 *    guarantees is exactly 1.
 * 3. **A null contributes nothing and occupies nothing.** It does not become a
 *    zero-height segment sitting in the middle of the stack.
 */

import { describe, expect, it } from 'vitest';
import { isStacked, stackColumn, stackExtent } from '../src/internal/stack.js';

/** `[y0, y1, defined]` triples, which read more clearly than object literals. */
function shape(
  values: readonly (number | null)[],
  mode: Parameters<typeof stackColumn>[1],
  baseline?: number,
) {
  return stackColumn(values, mode, baseline).map((s) => [s.y0, s.y1, s.defined] as const);
}

describe('stackColumn: none', () => {
  it('grows every bar from the baseline independently', () => {
    expect(shape([10, 20, 30], 'none')).toEqual([
      [0, 10, true],
      [0, 20, true],
      [0, 30, true],
    ]);
  });

  it('honours a non-zero baseline in both directions', () => {
    expect(shape([120, 80], 'none', 100)).toEqual([
      [100, 120, true],
      [100, 80, true],
    ]);
  });

  it('parks a null at the baseline and marks it undefined', () => {
    expect(shape([10, null], 'none', 5)).toEqual([
      [5, 10, true],
      [5, 5, false],
    ]);
  });

  it('treats a non-finite baseline as zero rather than propagating NaN', () => {
    expect(shape([10], 'none', Number.NaN)).toEqual([[0, 10, true]]);
  });
});

describe('stackColumn: normal', () => {
  it('accumulates in series order', () => {
    expect(shape([10, 20, 30], 'normal')).toEqual([
      [0, 10, true],
      [10, 30, true],
      [30, 60, true],
    ]);
  });

  it('grows negatives downward from zero, never into the positive run', () => {
    expect(shape([10, -4, 5, -6], 'normal')).toEqual([
      [0, 10, true],
      [0, -4, true],
      [10, 15, true],
      [-4, -10, true],
    ]);
  });

  it('spans the full signed extent when signs are mixed', () => {
    const segments = stackColumn([10, -4], 'normal');
    expect(stackExtent([segments])).toEqual([-4, 10]);
  });

  it('skips a null without leaving a gap in the accumulation', () => {
    expect(shape([10, null, 5], 'normal')).toEqual([
      [0, 10, true],
      [0, 0, false],
      [10, 15, true],
    ]);
  });

  it('stacks an all-negative column entirely below zero', () => {
    expect(shape([-1, -2, -3], 'normal')).toEqual([
      [0, -1, true],
      [-1, -3, true],
      [-3, -6, true],
    ]);
  });
});

describe('stackColumn: center', () => {
  it('centres the band on zero', () => {
    // Total 60, so the band shifts down by 30 and spans [-30, +30].
    expect(shape([10, 20, 30], 'center')).toEqual([
      [-30, -20, true],
      [-20, 0, true],
      [0, 30, true],
    ]);
  });

  it('leaves an already balanced column alone', () => {
    expect(shape([5, -5], 'center')).toEqual([
      [0, 5, true],
      [0, -5, true],
    ]);
  });
});

describe('stackColumn: percent', () => {
  it('sums to exactly 1 — not 0.9999999999999999', () => {
    const segments = stackColumn([1, 1, 1], 'percent');
    // Thirds are the classic float trap: 1/3 + 1/3 + 1/3 !== 1 in IEEE 754.
    expect(segments[2]?.y1).toBe(1);
    expect(segments[0]?.y0).toBe(0);
  });

  it('reaches exactly 1 for a pathological set of shares', () => {
    for (const values of [
      [1, 2, 3, 4, 5, 6, 7],
      [0.1, 0.2, 0.30000000000000004],
      [1e-9, 1, 1e9],
      [7, 11, 13, 17, 19, 23, 29, 31, 37],
    ]) {
      const segments = stackColumn(values, 'percent');
      expect(segments[segments.length - 1]?.y1).toBe(1);
    }
  });

  it('is contiguous: every segment starts where the previous one ended', () => {
    const segments = stackColumn([3, 5, 8, 13], 'percent');
    for (let i = 1; i < segments.length; i += 1) {
      expect(segments[i]?.y0).toBe(segments[i - 1]?.y1);
    }
  });

  it('splits a mixed-sign column into shares that sum to exactly 1', () => {
    const segments = stackColumn([3, -1], 'percent');
    // Total absolute magnitude is 4, so the column spans [-0.25, +0.75].
    expect(segments[0]).toEqual({ y0: 0, y1: 0.75, defined: true });
    expect(segments[1]).toEqual({ y0: 0, y1: -0.25, defined: true });
    const span = (segments[0]?.y1 ?? 0) - (segments[1]?.y1 ?? 0);
    expect(span).toBe(1);
  });

  it('reaches exactly 1 even with a null in the column', () => {
    const segments = stackColumn([2, null, 6], 'percent');
    expect(segments[1]?.defined).toBe(false);
    expect(segments[2]?.y1).toBe(1);
  });

  it('draws nothing at all rather than dividing by zero for an all-zero column', () => {
    const segments = stackColumn([0, 0], 'percent');
    expect(segments.every((s) => !s.defined)).toBe(true);
    expect(segments.every((s) => Number.isFinite(s.y0) && Number.isFinite(s.y1))).toBe(true);
  });

  it('yields no extent for a column with nothing defined', () => {
    expect(stackExtent([stackColumn([null, null], 'percent')])).toBeUndefined();
  });
});

describe('stackExtent', () => {
  it('spans every column', () => {
    const columns = [stackColumn([1, 2], 'normal'), stackColumn([-5], 'normal')];
    expect(stackExtent(columns)).toEqual([-5, 3]);
  });

  it('is undefined for no columns, so the caller picks its own domain', () => {
    expect(stackExtent([])).toBeUndefined();
  });
});

describe('isStacked', () => {
  it('is true for every mode that places series end to end', () => {
    expect(isStacked('none')).toBe(false);
    expect(isStacked('normal')).toBe(true);
    expect(isStacked('percent')).toBe(true);
    expect(isStacked('center')).toBe(true);
  });
});

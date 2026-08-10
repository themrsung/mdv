/**
 * One band geometry, two scale objects (SPEC 28.10).
 *
 * `@mdv/core` and this package both hand out band and point scales. They have to
 * — core's are immutable and typed over `string`, this package's are mutable and
 * typed over `ScaleInput`, and `layout` needs the mutable kind — but the numbers
 * underneath must come from a single place, because an axis ladder core draws
 * and the bars this package draws are two views of the same geometry. When they
 * drift, nothing throws: the gridlines simply stop lining up with the bars.
 *
 * They did drift. Core defaulted `paddingOuter` to `paddingInner / 2` (d3's
 * rule) while this package spends one `padding` on both gaps, so the same four
 * categories on the same 400 px landed at 10/110/210/310 in core and at
 * 19.05/114.29/209.52/304.76 here. Both factories now call core's
 * `bandGeometry`, and this suite is what keeps them there.
 *
 * The assertions are `toBe`, not `toBeCloseTo`. "Close enough" is what SPEC
 * 28.10 rules out: a byte-identical render needs bit-identical arithmetic.
 */

import { describe, expect, it } from 'vitest';
import { bandGeometry, createBandScale as coreBandScale } from '@mdv/core';
import { createBandScale, createPointScale } from '../src/internal/scale.js';

const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];

/** Ranges chosen to include a reversed one and a non-zero origin. */
const RANGES: readonly (readonly [number, number])[] = [
  [0, 400],
  [0, 963.25],
  [48, 800],
  [300, 0],
];

describe('band geometry parity between @mdv/core and @mdv/charts', () => {
  it('places bands identically, to the last bit, on the shared default padding', () => {
    for (const range of RANGES) {
      const mine = createBandScale({ domain: QUARTERS, range });
      const theirs = coreBandScale({ domain: QUARTERS, range });

      for (const q of QUARTERS) {
        expect(mine.scale(q), `${q} on [${range[0]}, ${range[1]}]`).toBe(theirs.scale(q));
      }
      expect(mine.bandwidth?.()).toBe(theirs.bandwidth?.());
      expect(mine.step?.()).toBe(theirs.step?.());
    }
  });

  it('agrees for every padding an author can write, and every domain size', () => {
    for (const padding of [0, 0.05, 0.2, 0.5, 0.9]) {
      for (let n = 1; n <= 12; ++n) {
        const domain = Array.from({ length: n }, (_, i) => `c${i}`);
        const mine = createBandScale({ domain, range: [0, 640], padding });
        const theirs = coreBandScale({
          domain,
          range: [0, 640],
          paddingInner: padding,
          paddingOuter: padding,
        });

        const where = `n=${n} padding=${padding}`;
        expect(mine.scale(`c0`), where).toBe(theirs.scale('c0'));
        expect(mine.scale(`c${n - 1}`), where).toBe(theirs.scale(`c${n - 1}`));
        expect(mine.bandwidth?.(), where).toBe(theirs.bandwidth?.());
        expect(mine.step?.(), where).toBe(theirs.step?.());
      }
    }
  });

  it('agrees on point scales, which are bands of zero width', () => {
    for (const range of RANGES) {
      const mine = createPointScale({ domain: QUARTERS, range });
      const theirs = coreBandScale({ domain: QUARTERS, range, point: true });

      for (const q of QUARTERS) {
        expect(mine.scale(q), `${q} on [${range[0]}, ${range[1]}]`).toBe(theirs.scale(q));
      }
      expect(mine.bandwidth?.()).toBe(0);
      expect(theirs.bandwidth?.()).toBe(0);
    }
  });

  it('gives a top-to-bottom axis positive width, not zero', () => {
    // Before the two factories shared their arithmetic this package computed on
    // a negative span: `bandwidth()` clamped the negative width to 0 and every
    // bar on a descending category axis would have collapsed. Nothing in the
    // repository ranges a band scale downwards today — `rangeDownFrame` hands
    // over `[y, y + height]` — so the bug was unreachable rather than absent.
    const descending = createBandScale({ domain: QUARTERS, range: [300, 0] });
    const ascending = createBandScale({ domain: QUARTERS, range: [0, 300] });

    expect(descending.bandwidth?.()).toBe(ascending.bandwidth?.());
    expect(descending.bandwidth?.()).toBeGreaterThan(0);
    // The order flips, the geometry does not: Q1 takes the slot Q4 had.
    expect(descending.scale('Q1')).toBe(ascending.scale('Q4'));
    expect(descending.scale('Q4')).toBe(ascending.scale('Q1'));
  });

  it('survives the re-range core performs before layout', () => {
    // `rerangeScale` calls `withRange`; the result must be the geometry the
    // scale would have had if the frame had been known all along.
    const built = createBandScale({ domain: QUARTERS, range: [0, 100] });
    const reranged = built.withRange([0, 400]);
    const direct = createBandScale({ domain: QUARTERS, range: [0, 400] });

    for (const q of QUARTERS) expect(reranged.scale(q), q).toBe(direct.scale(q));
    expect(reranged.bandwidth?.()).toBe(direct.bandwidth?.());
  });

  it('keeps the in-place setRange handshake on the same geometry as withRange', () => {
    const mutated = createBandScale({ domain: QUARTERS, range: [0, 100] });
    mutated.setRange(0, 400);
    const fresh = createBandScale({ domain: QUARTERS, range: [0, 400] });

    for (const q of QUARTERS) expect(mutated.scale(q), q).toBe(fresh.scale(q));
    expect(mutated.step?.()).toBe(fresh.step?.());
  });
});

describe('bandGeometry itself', () => {
  it('fills the range exactly: outer + n bands + (n−1) inner gaps = span', () => {
    const { start, step, bandwidth } = bandGeometry({
      count: 7,
      range: [0, 500],
      paddingInner: 0.3,
      paddingOuter: 0.3,
    });
    const end = start + step * 6 + bandwidth;
    expect(end + start).toBeCloseTo(500, 9);
  });

  it('answers an empty domain without producing NaN', () => {
    const geometry = bandGeometry({
      count: 0,
      range: [12, 340],
      paddingInner: 0.2,
      paddingOuter: 0.2,
    });
    expect(geometry).toEqual({ start: 12, step: 0, bandwidth: 0, reverse: false });
  });

  it('gives `align` the outer space, and only the outer space', () => {
    const common = { count: 4, range: [0, 400] as const, paddingInner: 0.2, paddingOuter: 0.2 };
    const left = bandGeometry({ ...common, align: 0 });
    const right = bandGeometry({ ...common, align: 1 });

    expect(left.start).toBe(0);
    expect(right.start).toBe(left.step * 0.2 * 2);
    // Only the offset moves; the bands keep their size and spacing.
    expect(right.step).toBe(left.step);
    expect(right.bandwidth).toBe(left.bandwidth);
  });

  it('hands the rounding leftover to `align` rather than dropping it', () => {
    const rounded = bandGeometry({
      count: 7,
      range: [0, 500],
      paddingInner: 0.2,
      paddingOuter: 0.2,
      round: true,
    });
    expect(Number.isInteger(rounded.step)).toBe(true);
    expect(Number.isInteger(rounded.bandwidth)).toBe(true);
    expect(Number.isInteger(rounded.start)).toBe(true);
    expect(rounded.step).toBeLessThanOrEqual(500 / (7 - 0.2 + 0.4));
  });
});

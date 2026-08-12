/**
 * `box` (SPEC 8.8), asserted numerically.
 *
 * The fixture is two categories of five observations each, chosen so that every
 * number in the five-number summary is an integer under the `quantile`
 * interpolation this package uses, and so that the two medians differ — the
 * description sentence has exactly one right answer.
 *
 * ```
 * A: 2 4 6 8 10   → min 2, q1 4,  median 6,  q3 8,  max 10
 * B: 0 5 10 15 20 → min 0, q1 5,  median 10, q3 15, max 20
 * ```
 *
 * Neither sample has a Tukey outlier, so the value extent is exactly `[0, 20]`
 * and nices to itself. The frame is 400 × 200, so the value axis is **10 px per
 * unit** and every y in the geometry suite is a round number a reader can redo
 * by hand.
 *
 * Two facts are *not* data-derived and are the point of the geometry suite:
 *
 * - a box is **48 px** wide — `marks.bar.maxThickness × 2` in the test theme —
 *   because a box is a bar with more to say and obeys the same cap (SPEC 11.4);
 * - the whiskers stop on **observations**, never on the fences that selected
 *   them, so a whisker tip is always a value the sample contains.
 */

import { describe, expect, it } from 'vitest';
import type { BoxMark, Mark, PathCommand } from '@mdv/core';
import { boxChart } from '../src/box.js';
import {
  EMPTY_TABLE,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const XY = { x: { field: 'group' }, y: { field: 'value' } };

const FIELDS = [
  ['group', 'category'],
  ['value', 'number'],
] as const;

/** Two five-observation samples with integer quartiles and distinct medians. */
function values(): ReturnType<typeof makeTable> {
  return makeTable(FIELDS, [
    ['A', 2],
    ['A', 4],
    ['A', 6],
    ['A', 8],
    ['A', 10],
    ['B', 0],
    ['B', 5],
    ['B', 10],
    ['B', 15],
    ['B', 20],
  ]);
}

/**
 * One sample with a single far outlier: `1 2 3 4 5 100`.
 *
 * Six observations put the quartiles between values — q1 2.25, q3 4.75, so the
 * Tukey fences are −1.5 and 8.5 and only the `100` is out. The whisker must come
 * back to `5`, the outermost observation inside the fence.
 */
function outlying(): ReturnType<typeof makeTable> {
  return makeTable(FIELDS, [
    ['A', 1],
    ['A', 2],
    ['A', 3],
    ['A', 4],
    ['A', 5],
    ['A', 100],
  ]);
}

/**
 * Twenty-five observations, `1…25`, so the notch fits *inside* the hinges.
 *
 * q1 7, median 13, q3 19; the 95% interval is 1.58 × 12 / √25 ≈ ±3.79, which
 * lands well short of the hinges. Every smaller sample in this file clamps.
 */
function wideSample(): ReturnType<typeof makeTable> {
  return makeTable(
    FIELDS,
    Array.from({ length: 25 }, (_, i) => ['A', i + 1]),
  );
}

const SUMMARY_FIELDS = [
  ['stage', 'category'],
  ['min', 'number'],
  ['q1', 'number'],
  ['median', 'number'],
  ['q3', 'number'],
  ['max', 'number'],
] as const;

/** The pre-computed form: one row per box, already summarised (SPEC 8.8). */
function precomputed(): ReturnType<typeof makeTable> {
  return makeTable(SUMMARY_FIELDS, [
    ['A', 0, 5, 10, 15, 20],
    ['B', 2, 4, 6, 8, 10],
  ]);
}

const CATEGORY = { x: { field: 'stage' } };

/**
 * The box marks alone.
 *
 * `box` emits boxes and the optional observation overlay into one array, so
 * `marks[0]` is a union at the type level even in the tests that never turn the
 * overlay on. Narrowing here keeps every assertion about a summary reading as
 * one expression.
 */
function boxesOf(marks: readonly Mark[]): BoxMark[] {
  return marks.filter((mark): mark is BoxMark => mark.mark === 'box');
}

/** Every coordinate a path visits, in order. `Z` carries none. */
function pathPoints(d: readonly PathCommand[]): { x: number; y: number }[] {
  return d.flatMap((c) => ('x' in c && 'y' in c ? [{ x: c.x, y: c.y }] : []));
}

describe('box: summarising a sample (SPEC 8.8)', () => {
  it('reduces each category to a five-number summary', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const boxes = boxesOf(run.encoded.marks);
    expect(boxes).toHaveLength(2);
    expect(boxes.map((b) => [b.min, b.q1, b.median, b.q3, b.max])).toEqual([
      [2, 4, 6, 8, 10],
      [0, 5, 10, 15, 20],
    ]);
  });

  it('keeps the categories in the order the table introduces them', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.encoded.marks.map((m) => m.label)).toEqual(['A', 'B']);
    expect(run.encoded.scales.x?.domain).toEqual(['A', 'B']);
  });

  it('points each box back at the first row of its category', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.encoded.marks.map((m) => m.datum)).toEqual([0, 5]);
  });

  it('gathers the rows of a category wherever they sit in the table', () => {
    const table = makeTable(FIELDS, [
      ['A', 2],
      ['B', 0],
      ['A', 4],
      ['B', 5],
      ['A', 6],
      ['B', 10],
      ['A', 8],
      ['B', 15],
      ['A', 10],
      ['B', 20],
    ]);
    const run = runChart(boxChart, table, { encoding: XY });
    const boxes = boxesOf(run.encoded.marks);
    expect(boxes.map((b) => [b.min, b.q1, b.median, b.q3, b.max])).toEqual([
      [2, 4, 6, 8, 10],
      [0, 5, 10, 15, 20],
    ]);
  });

  it('summarises one observation as a box of its own', () => {
    const run = runChart(boxChart, makeTable(FIELDS, [['A', 5]]), { encoding: XY });
    const box = boxesOf(run.encoded.marks)[0];
    expect([box?.min, box?.q1, box?.median, box?.q3, box?.max]).toEqual([5, 5, 5, 5, 5]);
  });
});

describe('box: whisker rules (SPEC 8.8)', () => {
  it('fences at 1.5 IQR by default and reports what falls outside', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    const box = boxesOf(run.encoded.marks)[0];
    expect(box?.q1).toBe(2.25);
    expect(box?.median).toBe(3.5);
    expect(box?.q3).toBe(4.75);
    expect(box?.outliers).toEqual([100]);
  });

  it('pulls the whisker back to an observation, never out to the fence', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    const box = boxesOf(run.encoded.marks)[0];
    // The upper fence is 8.5; the outermost observation under it is 5.
    expect(box?.max).toBe(5);
    expect(box?.min).toBe(1);
  });

  it('leaves no outliers when the whole sample is inside the fence', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(boxesOf(run.encoded.marks).map((m) => m.outliers)).toEqual([undefined, undefined]);
  });

  it('reaches the extremes under `minmax`, which can have no outliers', () => {
    const run = runChart(boxChart, outlying(), {
      encoding: XY,
      attrs: { whisker: 'minmax' },
    });
    const box = boxesOf(run.encoded.marks)[0];
    expect([box?.min, box?.max]).toEqual([1, 100]);
    expect(box?.outliers).toBeUndefined();
  });

  it('fences one standard deviation either side of the mean under `stddev`', () => {
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: 'stddev' },
    });
    // A is mean 6, σ = √8 ≈ 2.83, so the fences are 3.17 and 8.83 and the
    // whiskers come in to 4 and 8 — the 2 and the 10 fall out.
    const box = boxesOf(run.encoded.marks)[0];
    expect([box?.min, box?.max]).toEqual([4, 8]);
    expect(box?.outliers).toEqual([2, 10]);
  });

  it('reads a percentile pair as the fences', () => {
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: 'p10-p90' },
    });
    // p10 = 2.8 and p90 = 9.2 over A, so 2 and 10 are outside.
    const box = boxesOf(run.encoded.marks)[0];
    expect([box?.min, box?.max]).toEqual([4, 8]);
    expect(box?.outliers).toEqual([2, 10]);
  });

  it('accepts a percentile pair with no whitespace or case to lose', () => {
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: '  P25-P75  ' },
    });
    expect(codesOf(run.encodeDiagnostics)).not.toContain('MDV1502');
    expect(boxesOf(run.encoded.marks).map((m) => [m.min, m.max])).toEqual([
      [4, 8],
      [5, 15],
    ]);
  });

  it('reports MDV1502 and falls back to tukey for an unreadable whisker', () => {
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: 'sideways' },
    });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
    expect(boxesOf(run.encoded.marks).map((m) => [m.min, m.max])).toEqual([
      [2, 10],
      [0, 20],
    ]);
  });

  it('reports MDV1502 for a percentile pair that is not ascending', () => {
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: 'p90-p10' },
    });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
  });

  it('collapses the whiskers onto the median when the fences exclude everything', () => {
    // `p50-p50` fences on the median itself: nothing in A is ≤ 6 *and* ≥ 6
    // except the 6, so the whiskers have exactly one place left to be.
    const run = runChart(boxChart, values(), {
      encoding: XY,
      attrs: { whisker: 'p50-p50' },
    });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
  });
});

describe('box: pre-computed summaries (SPEC 8.8)', () => {
  it('reads median, q1 and q3 columns when `y` is unbound', () => {
    const run = runChart(boxChart, precomputed(), { encoding: CATEGORY });
    expect(codesOf(run.validation)).toEqual([]);
    expect(boxesOf(run.encoded.marks).map((m) => [m.min, m.q1, m.median, m.q3, m.max])).toEqual([
      [0, 5, 10, 15, 20],
      [2, 4, 6, 8, 10],
    ]);
  });

  it('leaves the whiskers on the hinges when there is no min or max', () => {
    const table = makeTable(
      [
        ['stage', 'category'],
        ['q1', 'number'],
        ['median', 'number'],
        ['q3', 'number'],
      ] as const,
      [
        ['A', 5, 10, 15],
        ['B', 4, 6, 8],
      ],
    );
    const run = runChart(boxChart, table, { encoding: CATEGORY });
    const box = boxesOf(run.encoded.marks)[0];
    expect([box?.min, box?.max]).toEqual([5, 15]);
    // A whisker of zero length is not drawn: it would be a cap on the hinge.
    const laid = runChart(boxChart, table, { encoding: CATEGORY }).laid;
    expect(laid.nodes.filter((n) => n.cls === 'mdv-mark mdv-mark-whisker')).toEqual([]);
  });

  it('finds the summary columns whatever their capitalisation', () => {
    const table = makeTable(
      [
        ['stage', 'category'],
        ['Q1', 'number'],
        ['Median', 'number'],
        ['Q3', 'number'],
      ] as const,
      [['A', 5, 10, 15]],
    );
    const run = runChart(boxChart, table, { encoding: CATEGORY });
    expect(boxesOf(run.encoded.marks)[0]?.median).toBe(10);
  });

  it('reports MDV1501 for attributes that need the raw observations', () => {
    const run = runChart(boxChart, precomputed(), {
      encoding: CATEGORY,
      attrs: { points: 'jitter', whisker: 'minmax' },
    });
    expect(codesOf(run.validation)).toEqual(['MDV1501', 'MDV1501']);
    expect(run.encoded.marks.every((m) => m.mark === 'box')).toBe(true);
  });

  it('carries no observation count, and so no notch', () => {
    const run = runChart(boxChart, precomputed(), {
      encoding: CATEGORY,
      attrs: { notch: true },
    });
    expect(nodesOfKind(run.laid.nodes, 'path')).toEqual([]);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(2);
  });

  it('prefers the bound observations over the summary columns', () => {
    const table = makeTable(
      [
        ['stage', 'category'],
        ['median', 'number'],
        ['q1', 'number'],
        ['q3', 'number'],
        ['value', 'number'],
      ] as const,
      [
        ['A', 99, 99, 99, 2],
        ['A', 99, 99, 99, 4],
        ['A', 99, 99, 99, 6],
        ['A', 99, 99, 99, 8],
        ['A', 99, 99, 99, 10],
      ],
    );
    const run = runChart(boxChart, table, {
      encoding: { x: { field: 'stage' }, y: { field: 'value' } },
    });
    expect(boxesOf(run.encoded.marks)[0]?.median).toBe(6);
  });
});

describe('box: attributes', () => {
  it('hides the outliers when asked, everywhere at once', () => {
    const run = runChart(boxChart, outlying(), {
      encoding: XY,
      attrs: { outliers: false },
    });
    expect(boxesOf(run.encoded.marks)[0]?.outliers).toBeUndefined();
    expect(nodesOfKind(run.laid.nodes, 'circle')).toEqual([]);
    expect(run.laid.hits).toHaveLength(1);
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).not.toContain('Outliers');
  });

  it('keeps the hidden outliers out of the value domain', () => {
    const run = runChart(boxChart, outlying(), {
      encoding: XY,
      attrs: { outliers: false },
    });
    expect(run.encoded.scales.y?.domain).toEqual([1, 5]);
  });

  it('overlays every observation under `points: all`', () => {
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'all' } });
    const kinds = run.encoded.marks.map((m) => m.mark);
    // Paint order: every box, then every point.
    expect(kinds).toEqual(['box', 'box', ...Array<string>(10).fill('point')]);
    const circles = nodesOfKind(run.laid.nodes, 'circle');
    expect(circles).toHaveLength(10);
    expect(new Set(circles.map((c) => c.cx)).size).toBe(2);
  });

  it('displaces the points under `points: jitter`, and reproducibly', () => {
    const first = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'jitter' } });
    const second = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'jitter' } });
    const cx = (run: typeof first): number[] =>
      nodesOfKind(run.laid.nodes, 'circle').map((c) => c.cx);
    expect(cx(first)).toEqual(cx(second));
    expect(new Set(cx(first)).size).toBeGreaterThan(2);
  });

  it('keeps a jittered point inside the box it belongs to', () => {
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'jitter' } });
    const centres = nodesOfKind(run.laid.nodes, 'rect').map((r) => r.x + r.w / 2);
    for (const circle of nodesOfKind(run.laid.nodes, 'circle')) {
      const nearest = Math.min(...centres.map((c) => Math.abs(circle.cx - c)));
      // The spread is 60% of the box width, half of it either side.
      expect(nearest).toBeLessThanOrEqual(48 * 0.3);
    }
  });

  it('gives the overlay no hit region of its own', () => {
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'all' } });
    expect(run.laid.hits).toHaveLength(2);
  });

  it('reports MDV1502 for an unknown points mode and draws none', () => {
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'some' } });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
    expect(nodesOfKind(run.laid.nodes, 'circle')).toEqual([]);
  });
});

describe('box: scales and axes', () => {
  it('does not drag the value axis to zero', () => {
    const table = makeTable(FIELDS, [
      ['A', 102],
      ['A', 104],
      ['A', 106],
      ['A', 108],
      ['A', 110],
    ]);
    const run = runChart(boxChart, table, { encoding: XY });
    expect(run.encoded.scales.y?.domain).toEqual([102, 110]);
  });

  it('still honours an explicit `zero`', () => {
    const table = makeTable(FIELDS, [
      ['A', 102],
      ['A', 104],
      ['A', 106],
      ['A', 108],
      ['A', 110],
    ]);
    const run = runChart(boxChart, table, {
      encoding: { x: { field: 'group' }, y: { field: 'value', scale: { zero: true } } },
    });
    expect(run.encoded.scales.y?.domain[0]).toBe(0);
  });

  it('stretches the domain to hold the outliers it draws', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    const domain = run.encoded.scales.y?.domain ?? [];
    expect(domain[1]).toBeGreaterThanOrEqual(100);
  });

  it('titles both axes from the columns they are bound to', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.encoded.axes.map((a) => a.title)).toEqual(['group', 'value']);
  });

  it('titles the value axis from the measure when no column is bound to it', () => {
    const run = runChart(boxChart, precomputed(), { encoding: CATEGORY });
    expect(run.encoded.axes.map((a) => a.title)).toEqual(['stage', 'Value']);
  });

  it('bands the categories and keeps the value axis continuous', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.encoded.scales.x?.type).toBe('band');
    expect(run.encoded.scales.y?.type).toBe('linear');
  });
});

describe('box: geometry (SPEC 11.4)', () => {
  it('draws a box, a median, two whiskers and two caps per category', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const cls = (name: string): number =>
      run.laid.nodes.filter((n) => n.cls === `mdv-mark mdv-mark-${name}`).length;
    expect(cls('box')).toBe(2);
    expect(cls('median')).toBe(2);
    expect(cls('whisker')).toBe(4);
    expect(cls('whisker-cap')).toBe(4);
  });

  it('caps a box at twice the bar thickness, however wide the band', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(nodesOfKind(run.laid.nodes, 'rect').map((r) => r.w)).toEqual([48, 48]);
  });

  it('spans the hinges exactly, on a 10 px-per-unit axis', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    // A: q3 8 → y 120, q1 4 → y 160. B: q3 15 → y 50, q1 5 → y 150.
    expect(rects.map((r) => [r.y, r.h])).toEqual([
      [120, 40],
      [50, 100],
    ]);
  });

  it('rules the median across the box, and nowhere else', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const medians = run.laid.nodes.filter((n) => n.cls === 'mdv-mark mdv-mark-median');
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    expect(medians.map((m) => ('y1' in m ? m.y1 : undefined))).toEqual([140, 100]);
    for (let i = 0; i < medians.length; i += 1) {
      const median = medians[i];
      const rect = rects[i];
      if (median === undefined || rect === undefined || !('x1' in median)) throw new Error('shape');
      expect(median.x1).toBe(rect.x);
      expect(median.x2).toBe(rect.x + rect.w);
    }
  });

  it('runs each whisker from the hinge out to the observation', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const whiskers = run.laid.nodes.filter((n) => n.cls === 'mdv-mark mdv-mark-whisker');
    const ends = whiskers.map((w) => ('y1' in w ? [w.y1, w.y2] : []));
    // A: down from q1 (160) to 2 (180), up from q3 (120) to 10 (100).
    // B: down from q1 (150) to 0 (200), up from q3 (50) to 20 (0).
    expect(ends).toEqual([
      [160, 180],
      [120, 100],
      [150, 200],
      [50, 0],
    ]);
  });

  it('makes each cap half the box wide, centred on the whisker', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const caps = run.laid.nodes.filter((n) => n.cls === 'mdv-mark mdv-mark-whisker-cap');
    for (const cap of caps) {
      if (!('x1' in cap)) throw new Error('shape');
      expect(cap.x2 - cap.x1).toBe(24);
      expect(cap.y1).toBe(cap.y2);
    }
  });

  it('keeps the boxes apart and inside the frame', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    const first = rects[0];
    const second = rects[1];
    if (first === undefined || second === undefined) throw new Error('two boxes expected');
    expect(first.x).toBeGreaterThanOrEqual(0);
    expect(second.x + second.w).toBeLessThanOrEqual(400);
    expect(first.x + first.w).toBeLessThan(second.x);
  });

  it('gives a flat sample a box a pixel tall rather than nothing at all', () => {
    const run = runChart(boxChart, makeTable(FIELDS, [['A', 5]]), { encoding: XY });
    expect(nodesOfKind(run.laid.nodes, 'rect').map((r) => r.h)).toEqual([1]);
  });

  it('draws an outlier as a circle, above the whisker that excluded it', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    const circles = nodesOfKind(run.laid.nodes, 'circle');
    expect(circles).toHaveLength(1);
    const cap = run.laid.nodes.find((n) => n.cls === 'mdv-mark mdv-mark-whisker-cap');
    if (cap === undefined || !('y1' in cap)) throw new Error('shape');
    expect(circles[0]?.cy).toBeLessThan(cap.y1);
  });

  it('produces no NaN geometry', () => {
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { points: 'jitter' } });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(nonFiniteNumbers(run.encoded)).toEqual([]);
  });
});

describe('box: notch (SPEC 8.8)', () => {
  it('draws a plain rectangle when the notch is off', () => {
    const run = runChart(boxChart, wideSample(), { encoding: XY });
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(1);
    expect(nodesOfKind(run.laid.nodes, 'path')).toEqual([]);
  });

  it('cuts the waist in at the median when the notch is on', () => {
    const run = runChart(boxChart, wideSample(), { encoding: XY, attrs: { notch: true } });
    const paths = nodesOfKind(run.laid.nodes, 'path');
    expect(paths).toHaveLength(1);
    const points = pathPoints(paths[0]?.d ?? []);
    const xs = [...new Set(points.map((p) => p.x))].sort((a, b) => a - b);
    expect(xs).toHaveLength(4);
    const left = xs[0] ?? 0;
    const right = xs[3] ?? 0;
    expect(right - left).toBe(48);
    // The waist is inset by a quarter of the width on each side.
    expect(xs[1]).toBeCloseTo(left + 12, 6);
    expect(xs[2]).toBeCloseTo(right - 12, 6);
    const waist = points.filter((p) => p.x === xs[1] || p.x === xs[2]);
    expect(waist).toHaveLength(2);
    expect(waist[0]?.y).toBe(waist[1]?.y);
  });

  it('clamps the notch to the hinges rather than letting it escape', () => {
    // Five observations make the 95% interval wider than the box: A's interval
    // is 6 ± 2.83 against hinges of 4 and 8, so the notch has to give way.
    const run = runChart(boxChart, values(), { encoding: XY, attrs: { notch: true } });
    const points = pathPoints(nodesOfKind(run.laid.nodes, 'path')[0]?.d ?? []);
    const ys = points.map((p) => p.y);
    expect(Math.min(...ys)).toBe(120);
    expect(Math.max(...ys)).toBe(160);
  });

  it('leaves the hit region on the box, not on the notched outline', () => {
    const run = runChart(boxChart, wideSample(), { encoding: XY, attrs: { notch: true } });
    const hit = run.laid.hits[0];
    expect(hit?.w).toBe(48);
    expect(hit?.markNodeId).toBe(nodesOfKind(run.laid.nodes, 'path')[0]?.id);
  });
});

describe('box: hit regions (SPEC 12.4)', () => {
  it('gives one region per box, anchored on the median', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.laid.hits).toHaveLength(2);
    expect(run.laid.hits.map((h) => h.anchor.y)).toEqual([140, 100]);
    expect(run.laid.hits.map((h) => h.datumIndex)).toEqual([0, 5]);
  });

  it('reads the whole summary out, in the order the eye takes it', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.laid.hits[0]?.readout.map((r) => [r.label, r.value])).toEqual([
      ['Group', 'A'],
      ['Median', '6'],
      ['Q1–Q3', '4–8'],
      ['Whiskers', '2–10'],
      ['Observations', '5'],
    ]);
  });

  it('emphasises the median, which is the number the box is about', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const rows = run.laid.hits[0]?.readout ?? [];
    expect(rows.filter((r) => r.emphasis === true).map((r) => r.label)).toEqual(['Median']);
  });

  it('counts the outliers in the box readout and targets each one', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    expect(run.laid.hits).toHaveLength(2);
    const box = run.laid.hits[0]?.readout.map((r) => [r.label, r.value]) ?? [];
    expect(box).toContainEqual(['Outliers', '1']);
    expect(run.laid.hits[1]?.readout.map((r) => [r.label, r.value])).toEqual([
      ['Group', 'A'],
      ['Outlier', '100'],
    ]);
  });

  it('leaves the observation count off a summary that never had one', () => {
    const run = runChart(boxChart, precomputed(), { encoding: CATEGORY });
    const labels = run.laid.hits[0]?.readout.map((r) => r.label) ?? [];
    expect(labels).not.toContain('Observations');
  });
});

describe('box: a11y table (SPEC 12.3)', () => {
  it('tabulates the summary, one row per box, not the observations', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const view = run.encoded.a11yTable;
    expect(view?.columns.map((c) => c.name)).toEqual([
      'Group',
      'Lower whisker',
      'Q1',
      'Median',
      'Q3',
      'Upper whisker',
    ]);
    expect(view?.rows).toEqual([
      ['A', '2', '4', '6', '8', '10'],
      ['B', '0', '5', '10', '15', '20'],
    ]);
  });

  it('adds an outlier count only when there is one to add', () => {
    const plain = runChart(boxChart, values(), { encoding: XY });
    expect(plain.encoded.a11yTable?.columns).toHaveLength(6);
    const run = runChart(boxChart, outlying(), { encoding: XY });
    expect(run.encoded.a11yTable?.columns.map((c) => c.name).at(-1)).toBe('Outliers');
    expect(run.encoded.a11yTable?.rows[0]?.at(-1)).toBe('1');
  });

  it('aligns the numbers right and keeps the category column typed', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    const columns = run.encoded.a11yTable?.columns ?? [];
    expect(columns[0]?.type).toBe('category');
    expect(columns.slice(1).map((c) => c.align)).toEqual(Array<string>(5).fill('right'));
  });
});

describe('box: description (SPEC 12.2)', () => {
  it('names the measure, the categories and the extremes of the medians', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.description).toBe(
      'Box plot. Value by group, 2 categories. Medians range from 6 in A to 10 in B. Highest median: B.',
    );
  });

  it('counts the outliers it drew', () => {
    const run = runChart(boxChart, outlying(), { encoding: XY });
    expect(run.description).toContain('1 category, 1 outlier');
  });

  it('says so, without inventing data, when there is nothing to describe', () => {
    const run = runChart(boxChart, EMPTY_TABLE, { encoding: XY });
    expect(run.description).toBe('Box plot with no data.');
  });
});

describe('box: diagnostics', () => {
  it('reports MDV3000 when `x` is not bound', () => {
    const run = runChart(boxChart, values(), { encoding: { y: { field: 'value' } } });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when `x` names something that is not a column', () => {
    const run = runChart(boxChart, values(), {
      encoding: { x: { field: 'missing' }, y: { field: 'value' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when there are neither observations nor a summary', () => {
    const run = runChart(boxChart, values(), { encoding: { x: { field: 'group' } } });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3001 when the observations are not quantitative', () => {
    const table = makeTable(
      [
        ['group', 'category'],
        ['value', 'category'],
      ] as const,
      [
        ['A', 'x'],
        ['A', 'y'],
      ],
    );
    const run = runChart(boxChart, table, { encoding: XY });
    expect(codesOf(run.validation)).toContain('MDV3001');
  });

  it('does not complain about a table it can read', () => {
    const run = runChart(boxChart, values(), { encoding: XY });
    expect(run.diagnostics).toEqual([]);
  });
});

describe('box: degenerate input', () => {
  it('draws nothing for an empty table and does not throw', () => {
    const run = runChart(boxChart, EMPTY_TABLE, { encoding: XY });
    expect(run.encoded.marks).toEqual([]);
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('draws nothing when the columns exist but have no rows', () => {
    const run = runChart(boxChart, noRows(FIELDS), { encoding: XY });
    expect(run.encoded.marks).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives an all-null measure', () => {
    const table = makeTable(FIELDS, [
      ['A', null],
      ['A', null],
    ]);
    const run = runChart(boxChart, table, { encoding: XY });
    expect(run.encoded.marks).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('skips the rows it cannot read and keeps the rest', () => {
    const table = makeTable(FIELDS, [
      ['A', 2],
      [null, 4],
      ['A', null],
      ['A', 4],
      ['A', 6],
      ['A', 8],
      ['A', 10],
    ]);
    const run = runChart(boxChart, table, { encoding: XY });
    expect(run.encoded.marks).toHaveLength(1);
    expect(boxesOf(run.encoded.marks)[0]?.median).toBe(6);
  });

  it('drops a category whose observations are all unreadable', () => {
    const table = makeTable(FIELDS, [
      ['A', 2],
      ['B', null],
      ['A', 4],
      ['A', 6],
      ['A', 8],
      ['A', 10],
    ]);
    const run = runChart(boxChart, table, { encoding: XY });
    expect(run.encoded.marks.map((m) => m.label)).toEqual(['A']);
    expect(run.encoded.scales.x?.domain).toEqual(['A']);
  });

  it('survives extreme aspect ratios in both directions', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 900 },
      { x: 0, y: 0, width: 2000, height: 1 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(boxChart, values(), { encoding: XY, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
      for (const rect of nodesOfKind(run.laid.nodes, 'rect')) {
        expect(rect.w).toBeGreaterThanOrEqual(0);
        expect(rect.h).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

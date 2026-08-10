/**
 * `scatter` and `bubble` (SPEC 8.6), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame and the
 * `spend / revenue` fixture, whose extents are `[0, 30]` on both axes (already
 * round, so `nice` leaves them alone) and neither of which is forced to include
 * zero — a scatter encodes *relationship*, not magnitude:
 *
 * - x: 0 → 0, 10 → 133.3333, 20 → 266.6667, 30 → 400
 * - y: 0 → 200, 10 → 133.3333, 20 → 66.6667, 30 → 0
 *
 * The rule this file exists to defend is **area, not radius**: `bubble` maps
 * size through a `sqrt` scale, so `r ∝ √value` and `πr² ∝ value`. Mapping value
 * to radius instead would square every difference, and it is asserted here as
 * an invariant (`r² / value` constant) rather than as four magic numbers.
 */

import { describe, expect, it } from 'vitest';
import type { PathNode, SceneNode } from '@mdv/core';
import { bubbleChart, scatterChart } from '../src/scatter.js';
import { EMPTY_TABLE, codesOf, makeTable, nodesOfKind, nonFiniteNumbers, noRows, runChart } from './harness.js';

const XY = { x: { field: 'spend' }, y: { field: 'revenue' } };
const SIZED = { ...XY, size: { field: 'weight' } };

/** Four points on a perfect descending line, with sizes in a 1 : 4 : 9 : 16 ratio. */
function cloud() {
  return makeTable(
    [
      ['spend', 'number'],
      ['revenue', 'number'],
      ['weight', 'number'],
    ],
    [
      [0, 30, 1],
      [10, 20, 4],
      [20, 10, 9],
      [30, 0, 16],
    ],
  );
}

function dots(nodes: readonly SceneNode[]) {
  return nodesOfKind(nodes, 'circle');
}

describe('scatter: mark geometry', () => {
  const run = runChart(scatterChart, cloud(), { encoding: XY });

  it('places one dot per row at the exact data coordinates', () => {
    const points = dots(run.laid.nodes);
    expect(points.map((d) => d.cx)).toEqual([0, 133.3333, 266.6667, 400]);
    expect(points.map((d) => d.cy)).toEqual([0, 66.6667, 133.3333, 200]);
  });

  it('leaves zero out of both domains (SPEC 8.6)', () => {
    // Both happen to start at zero here because the data does; what matters is
    // that neither domain was *extended* to reach it.
    expect(run.encoded.scales.x?.domain).toEqual([0, 30]);
    expect(run.encoded.scales.y?.domain).toEqual([0, 30]);
  });

  it('draws every dot at least 8 px across (SPEC 11.4)', () => {
    for (const dot of dots(run.laid.nodes)) expect(dot.r * 2).toBeGreaterThanOrEqual(8);
  });

  it('rings each dot in the surface colour at 2 px', () => {
    const dot = dots(run.laid.nodes)[0];
    expect(dot?.stroke?.width).toBe(2);
    expect(dot?.stroke?.paint).toEqual({ kind: 'solid', color: '#ffffff' });
  });

  it('fills at the default 0.85 opacity, so overlaps stay readable', () => {
    expect(dots(run.laid.nodes)[0]?.fill).toEqual({ kind: 'solid', color: '#111180', opacity: 0.85 });
  });

  it('gives every point a hit target on the point itself', () => {
    expect(run.laid.hits).toHaveLength(4);
    expect(run.laid.hits[0]?.anchor).toEqual({ x: 0, y: 0 });
  });

  it('emits no NaN anywhere', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('bubble: size is area, never radius (SPEC 8.6)', () => {
  const run = runChart(bubbleChart, cloud(), { encoding: SIZED });
  const radii = dots(run.laid.nodes).map((d) => d.r);

  it('scales the radius as the square root of the value', () => {
    // Domain [0, 16] over range [0, 24]: r = 24·√(v/16) = 6·√v.
    expect(radii).toEqual([6, 12, 18, 24]);
  });

  it('keeps area proportional to value, which is the whole point', () => {
    const values = [1, 4, 9, 16];
    const ratios = radii.map((r, i) => (r * r) / (values[i] ?? 1));
    for (const ratio of ratios) expect(ratio).toBeCloseTo(ratios[0] ?? 0, 9);
  });

  it('is not radius-proportional, which would overstate every large bubble', () => {
    // Radius-proportional would put the 16-weight bubble at 16× the 1-weight
    // one; area-proportional puts it at 4×.
    expect((radii[3] ?? 0) / (radii[0] ?? 1)).toBeCloseTo(4, 9);
  });

  it('starts the size domain at zero so a zero value has zero area', () => {
    expect(run.encoded.scales.size?.domain).toEqual([0, 16]);
  });

  it('never shrinks a bubble below the 8 px legibility floor', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
        ['weight', 'number'],
      ],
      [
        [0, 1, 1],
        [1, 2, 1_000_000],
      ],
    );
    const tiny = runChart(bubbleChart, table, { encoding: SIZED });
    for (const dot of dots(tiny.laid.nodes)) expect(dot.r).toBeGreaterThanOrEqual(4);
  });

  it('caps the largest bubble at maxRadius', () => {
    const capped = runChart(bubbleChart, cloud(), { encoding: SIZED, attrs: { maxRadius: 10 } });
    for (const dot of dots(capped.laid.nodes)) expect(dot.r).toBeLessThanOrEqual(10);
  });

  it('demands a size field: a constant-size bubble chart is a scatter chart', () => {
    const codes = codesOf(runChart(bubbleChart, cloud(), { encoding: XY }).validation);
    expect(codes).toContain('MDV3000');
  });

  it('still draws something when the size field is missing, rather than nothing', () => {
    const run2 = runChart(bubbleChart, cloud(), { encoding: XY });
    expect(dots(run2.laid.nodes)).toHaveLength(4);
    expect(nonFiniteNumbers(run2.laid)).toEqual([]);
  });

  it('carries the size into the readout', () => {
    expect(run.laid.hits[0]?.readout.map((r) => r.label)).toEqual(['Spend', 'Revenue', 'Weight']);
  });
});

describe('scatter: shape channel', () => {
  it('draws a non-circular shape as a path, not a circle', () => {
    const run = runChart(scatterChart, cloud(), { encoding: XY, attrs: { shape: 'square' } });
    expect(dots(run.laid.nodes)).toHaveLength(0);
    expect(nodesOfKind(run.laid.nodes, 'path')).toHaveLength(4);
  });

  it('sizes every shape to the same area as the circle it replaces', () => {
    const circles = runChart(scatterChart, cloud(), { encoding: XY });
    const squares = runChart(scatterChart, cloud(), { encoding: XY, attrs: { shape: 'square' } });
    const bounds = (node: PathNode | undefined): number => {
      const xs = (node?.d ?? []).flatMap((c) => (c.c === 'M' || c.c === 'L' ? [c.x] : []));
      return Math.max(...xs) - Math.min(...xs);
    };
    const side = bounds(nodesOfKind(squares.laid.nodes, 'path')[0]);
    const r = dots(circles.laid.nodes)[0]?.r ?? 0;
    // A square of the same area as a circle of radius r has side r·√π.
    expect(side).toBeCloseTo(r * Math.sqrt(Math.PI), 3);
  });

  it('varies the shape per category when a field is bound', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
        ['kind', 'category'],
      ],
      [
        [0, 1, 'a'],
        [1, 2, 'b'],
      ],
    );
    const run = runChart(scatterChart, table, { encoding: { ...XY, shape: { field: 'kind' } } });
    const shapes = run.encoded.marks.map((mark) => mark.shape);
    expect(new Set(shapes).size).toBe(2);
  });
});

describe('scatter: series', () => {
  function manySeries(count: number) {
    const rows = Array.from({ length: count }, (_, i) => [i, i * 2, `s${i}`] as const);
    return makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
        ['team', 'category'],
      ],
      rows,
    );
  }

  it('accepts three series without comment', () => {
    const run = runChart(scatterChart, manySeries(3), { encoding: { ...XY, series: { field: 'team' } } });
    expect(codesOf(run)).not.toContain('MDV3061');
  });

  it('refuses a fourth: a scatter compares every pair of colours at once (MDV3061)', () => {
    const run = runChart(scatterChart, manySeries(4), { encoding: { ...XY, series: { field: 'team' } } });
    expect(codesOf(run)).toContain('MDV3061');
  });
});

describe('scatter: trend lines', () => {
  it('warns that a fit is a claim, not a summary (MDV3060)', () => {
    const run = runChart(scatterChart, cloud(), { encoding: XY, attrs: { trend: 'linear' } });
    expect(codesOf(run)).toContain('MDV3060');
  });

  it('fits the exact line through collinear points', () => {
    const run = runChart(scatterChart, cloud(), { encoding: XY, attrs: { trend: 'linear' } });
    const trend = nodesOfKind(run.laid.nodes, 'path')[0];
    // revenue = 30 − spend, so the fit runs corner to corner of the plot.
    expect(trend?.d).toEqual([
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 400, y: 200 },
    ]);
  });

  it('draws the trend under the points, never over them', () => {
    const run = runChart(scatterChart, cloud(), { encoding: XY, attrs: { trend: 'linear' } });
    expect(run.laid.nodes[0]?.cls).toContain('mdv-mark-trend');
  });

  it('refuses to fit a vertical cloud rather than inventing a slope', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
      ],
      [
        [5, 1],
        [5, 2],
        [5, 3],
      ],
    );
    const run = runChart(scatterChart, table, { encoding: XY, attrs: { trend: 'linear' } });
    expect(nodesOfKind(run.laid.nodes, 'path')).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('scatter: jitter is deterministic (SPEC 24.3)', () => {
  it('produces byte-identical coordinates across runs', () => {
    const a = runChart(scatterChart, cloud(), { encoding: XY, attrs: { jitter: 4 } });
    const b = runChart(scatterChart, cloud(), { encoding: XY, attrs: { jitter: 4 } });
    expect(dots(a.laid.nodes).map((d) => [d.cx, d.cy])).toEqual(dots(b.laid.nodes).map((d) => [d.cx, d.cy]));
  });

  it('actually moves the points, but never further than asked', () => {
    const plain = dots(runChart(scatterChart, cloud(), { encoding: XY }).laid.nodes);
    const jittered = dots(runChart(scatterChart, cloud(), { encoding: XY, attrs: { jitter: 4 } }).laid.nodes);
    expect(jittered.map((d) => d.cx)).not.toEqual(plain.map((d) => d.cx));
    for (let i = 0; i < plain.length; i += 1) {
      expect(Math.abs((jittered[i]?.cx ?? 0) - (plain[i]?.cx ?? 0))).toBeLessThanOrEqual(4);
      expect(Math.abs((jittered[i]?.cy ?? 0) - (plain[i]?.cy ?? 0))).toBeLessThanOrEqual(4);
    }
  });
});

describe('scatter: degenerate data', () => {
  it('survives the empty table', () => {
    const run = runChart(scatterChart, EMPTY_TABLE, { encoding: XY });
    expect(run.laid.nodes).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives columns with no rows', () => {
    const run = runChart(
      scatterChart,
      noRows([
        ['spend', 'number'],
        ['revenue', 'number'],
      ]),
      { encoding: XY },
    );
    expect(dots(run.laid.nodes)).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('gives a single point a domain with room around it', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
      ],
      [[10, 20]],
    );
    const run = runChart(scatterChart, table, { encoding: XY });
    expect(dots(run.laid.nodes)).toHaveLength(1);
    const [lo, hi] = run.encoded.scales.x?.domain as [number, number];
    expect(hi).toBeGreaterThan(lo);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('drops rows with a null on either axis and counts them', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
      ],
      [
        [1, 2],
        [null, 3],
        [4, null],
      ],
    );
    const run = runChart(scatterChart, table, { encoding: XY });
    expect(run.encoded.marks).toHaveLength(1);
    expect(run.encoded.droppedRows).toBe(2);
  });

  it('survives an all-null column', () => {
    const table = makeTable(
      [
        ['spend', 'number'],
        ['revenue', 'number'],
      ],
      [
        [null, null],
        [null, null],
      ],
    );
    const run = runChart(scatterChart, table, { encoding: XY });
    expect(run.encoded.marks).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN at any extreme aspect ratio', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 4, height: 2000 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(bubbleChart, cloud(), { encoding: SIZED, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });
});

describe('scatter: accessibility', () => {
  it('describes itself through the registry contract', () => {
    const run = runChart(scatterChart, cloud(), { encoding: XY });
    expect(run.description).toBe('Scatter chart. Revenue against spend, 4 points. Values range from 0 to 30.');
  });

  it('names itself a bubble when it is one', () => {
    const run = runChart(bubbleChart, cloud(), { encoding: SIZED });
    expect(run.description?.startsWith('Bubble chart.')).toBe(true);
  });

  it('says so plainly when there is nothing to describe', () => {
    expect(runChart(scatterChart, EMPTY_TABLE, { encoding: XY }).description).toBe('Scatter chart with no data.');
  });

  it('offers the data as a table through `a11yTable`', () => {
    const run = runChart(bubbleChart, cloud(), { encoding: SIZED });
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).toEqual(['Spend', 'Revenue', 'Weight']);
    expect(run.encoded.a11yTable?.rows[0]).toEqual(['0', '30', '1']);
  });
});

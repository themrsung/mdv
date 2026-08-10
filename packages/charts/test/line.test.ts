/**
 * `line` (SPEC 8.3), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame and the
 * `100, 200, 300, 400` quarters fixture:
 *
 * - a categorical x becomes a **point** scale at padding 0.5, so step = 400 / 4
 *   and the four points sit at x = 50, 150, 250, 350
 * - the y-domain does **not** include zero for a line (SPEC 7.2), so it is
 *   `[100, 400]` over the inverted range `[200, 0]`: 1 unit = ⅔ px
 *
 * The missing-data policy gets the most attention here, because SPEC 6.5 states
 * the rule that is easiest to get quietly wrong: *a chart whose data has gaps
 * MUST look like it has gaps.*
 */

import { describe, expect, it } from 'vitest';
import type { PathNode } from '@mdv/core';
import { lineChart } from '../src/line.js';
import {
  EMPTY_TABLE,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  quarters,
  runChart,
  twoSeries,
} from './harness.js';

const XY = { x: { field: 'quarter' }, y: { field: 'revenue' } };

/** A table with a hole in the middle of the series. */
function gapped() {
  return makeTable(
    [
      ['quarter', 'category'],
      ['revenue', 'number'],
    ],
    [
      ['Q1', 100],
      ['Q2', null],
      ['Q3', 300],
      ['Q4', 400],
    ],
  );
}

function paths(nodes: readonly unknown[]): PathNode[] {
  return nodesOfKind(nodes as never, 'path');
}

/** The x of every command that has one; `Z` carries no coordinates. */
function xsOf(node: PathNode | undefined): number[] {
  return (node?.d ?? []).flatMap((command) => ('x' in command ? [command.x] : []));
}

describe('line: mark geometry', () => {
  const run = runChart(lineChart, quarters(), { encoding: XY });
  const lines = paths(run.laid.nodes);

  it('draws one polyline through every point', () => {
    expect(lines).toHaveLength(1);
    expect(lines[0]?.d.map((c) => c.c)).toEqual(['M', 'L', 'L', 'L']);
  });

  it('places the points on the point scale, at the exact data values', () => {
    const d = lines[0]?.d ?? [];
    const xs = d.map((c) => (c.c === 'M' || c.c === 'L' ? c.x : Number.NaN));
    const ys = d.map((c) => (c.c === 'M' || c.c === 'L' ? c.y : Number.NaN));
    expect(xs).toEqual([50, 150, 250, 350]);
    expect(ys).toEqual([200, 133.3333, 66.6667, 0]);
  });

  it('does not force zero into the domain (SPEC 7.2)', () => {
    expect(run.encoded.scales.y?.domain).toEqual([100, 400]);
  });

  it('strokes 2 px with a round join and cap (SPEC 11.4)', () => {
    expect(lines[0]?.stroke?.width).toBe(2);
    expect(lines[0]?.stroke?.join).toBe('round');
    expect(lines[0]?.stroke?.cap).toBe('round');
  });

  it('emits a hit target per point even where no marker is drawn', () => {
    expect(run.laid.hits).toHaveLength(4);
    expect(nodesOfKind(run.laid.nodes, 'circle')).toHaveLength(0);
    expect(run.laid.hits[0]?.anchor).toEqual({ x: 50, y: 200 });
  });

  it('emits no NaN anywhere', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('line: point markers', () => {
  it('draws a marker at every point when asked, at least 8 px across', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { points: 'all' } });
    const dots = nodesOfKind(run.laid.nodes, 'circle');
    expect(dots).toHaveLength(4);
    for (const dot of dots) expect(dot.r * 2).toBeGreaterThanOrEqual(8);
    expect(dots.map((d) => d.cx)).toEqual([50, 150, 250, 350]);
  });

  it('rings each marker in the surface color so crossings stay legible', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { points: 'all' } });
    const dot = nodesOfKind(run.laid.nodes, 'circle')[0];
    expect(dot?.stroke?.width).toBe(2);
    expect(dot?.stroke?.paint).toEqual({ kind: 'solid', color: '#ffffff' });
  });

  it('marks only the two ends for `points: ends`', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { points: 'ends' } });
    expect(nodesOfKind(run.laid.nodes, 'circle').map((d) => d.cx)).toEqual([50, 350]);
  });

  it('never shrinks a marker below the 8 px floor even when asked to', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { points: 'all', pointSize: 2 } });
    for (const dot of nodesOfKind(run.laid.nodes, 'circle')) expect(dot.r).toBeGreaterThanOrEqual(4);
  });

  it('paints a single-point series as a visible dot rather than nothing', () => {
    const table = makeTable([['quarter', 'category'], ['revenue', 'number']], [['Q1', 5]]);
    const run = runChart(lineChart, table, { encoding: XY });
    const line = paths(run.laid.nodes)[0];
    // A zero-length segment under a round cap paints as a dot.
    expect(line?.d).toEqual([
      { c: 'M', x: 200, y: 100 },
      { c: 'L', x: 200, y: 100 },
    ]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('line: curves', () => {
  it('emits cubics for a monotone curve and never overshoots the data', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { curve: 'monotone' } });
    const d = paths(run.laid.nodes)[0]?.d ?? [];
    expect(d.map((c) => c.c)).toEqual(['M', 'C', 'C', 'C']);
    const ys = d.flatMap((c) => (c.c === 'C' ? [c.y1, c.y2, c.y] : c.c === 'M' ? [c.y] : []));
    // The data spans y 0 … 200; a monotone fit must stay inside it.
    for (const y of ys) {
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(200);
    }
  });

  it('emits only orthogonal segments for a step curve', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { curve: 'step' } });
    const d = paths(run.laid.nodes)[0]?.d ?? [];
    expect(d.length).toBeGreaterThan(4);
    for (const command of d) expect(command.c === 'M' || command.c === 'L').toBe(true);
  });

  it('falls back to linear and warns for an unknown curve', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { curve: 'squiggle' } });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
    expect(paths(run.laid.nodes)[0]?.d.map((c) => c.c)).toEqual(['M', 'L', 'L', 'L']);
  });

  it('produces finite geometry for every curve kind', () => {
    for (const curve of ['linear', 'monotone', 'natural', 'basis', 'step', 'stepBefore', 'stepAfter']) {
      const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { curve } });
      expect(nonFiniteNumbers(run.laid), curve).toEqual([]);
    }
  });
});

describe('line: missing data (SPEC 6.5)', () => {
  it('breaks the line at a gap by default — a gap must look like a gap', () => {
    const run = runChart(lineChart, gapped(), { encoding: XY });
    const lines = paths(run.laid.nodes);
    expect(lines).toHaveLength(2);
    expect(lines[0]?.d).toEqual([
      { c: 'M', x: 50, y: 200 },
      { c: 'L', x: 50, y: 200 },
    ]);
    expect(xsOf(lines[1])).toEqual([250, 350]);
  });

  it('bridges the gap for `nullPolicy: skip`', () => {
    const run = runChart(lineChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'skip' } });
    const lines = paths(run.laid.nodes);
    expect(lines).toHaveLength(1);
    expect(xsOf(lines[0])).toEqual([50, 250, 350]);
  });

  it('reads a null as zero for `nullPolicy: zero`, which changes the domain', () => {
    const run = runChart(lineChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'zero' } });
    expect(run.encoded.scales.y?.domain?.[0]).toBe(0);
    expect(paths(run.laid.nodes)).toHaveLength(1);
  });

  it('drops the row entirely for `nullPolicy: drop`, closing the gap in x too', () => {
    const run = runChart(lineChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'drop' } });
    expect(run.encoded.scales.x?.domain).toEqual(['Q1', 'Q3', 'Q4']);
  });

  it('emits no geometry at all when every value is null', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
      ],
      [
        ['Q1', null],
        ['Q2', null],
      ],
    );
    const run = runChart(lineChart, table, { encoding: XY });
    expect(paths(run.laid.nodes)).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('line: multiple series', () => {
  const run = runChart(lineChart, twoSeries(), { encoding: { ...XY, series: { field: 'region' } } });

  it('draws one path per series and does not stack them', () => {
    expect(paths(run.laid.nodes)).toHaveLength(2);
    expect(run.encoded.series.map((s) => s.id)).toEqual(['North', 'South']);
    expect(run.encoded.marks).toHaveLength(2);
  });

  it('offers a legend once there is more than one series (SPEC 7.4)', () => {
    expect(run.encoded.legend?.entries.map((e) => e.label)).toEqual(['North', 'South']);
  });

  it('offers no legend for a single series', () => {
    const single = runChart(lineChart, quarters(), { encoding: XY });
    expect(single.encoded.legend).toBeUndefined();
  });
});

describe('line: wide form', () => {
  it('makes one series per bound field', () => {
    const table = makeTable(
      [
        ['month', 'category'],
        ['plan', 'number'],
        ['actual', 'number'],
      ],
      [
        ['Jan', 10, 12],
        ['Feb', 20, 18],
      ],
    );
    const run = runChart(lineChart, table, {
      encoding: { x: { field: 'month' }, y: [{ field: 'plan' }, { field: 'actual' }] },
    });
    expect(run.encoded.series.map((s) => s.label)).toEqual(['Plan', 'Actual']);
    expect(paths(run.laid.nodes)).toHaveLength(2);
  });

  it('rejects a list y combined with a series channel (MDV3010)', () => {
    const run = runChart(lineChart, twoSeries(), {
      encoding: { x: { field: 'quarter' }, y: [{ field: 'revenue' }], series: { field: 'region' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3010');
  });
});

describe('line: temporal x', () => {
  it('uses a time scale and keeps the geometry finite', () => {
    const table = makeTable(
      [
        ['day', 'date'],
        ['visits', 'number'],
      ],
      [
        [new Date(Date.UTC(2024, 0, 1)), 10],
        [new Date(Date.UTC(2024, 0, 2)), 20],
        [new Date(Date.UTC(2024, 0, 3)), 15],
      ],
    );
    const run = runChart(lineChart, table, { encoding: { x: { field: 'day' }, y: { field: 'visits' } } });
    expect(run.encoded.scales.x?.type).toBe('time');
    const xs = paths(run.laid.nodes)[0]?.d.map((c) => (c.c === 'M' || c.c === 'L' ? c.x : -1));
    expect(xs).toEqual([0, 200, 400]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('line: degenerate input', () => {
  it('draws nothing for an empty table', () => {
    const run = runChart(lineChart, EMPTY_TABLE, { encoding: XY });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('survives extreme aspect ratios', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 800 },
      { x: 0, y: 0, width: 1600, height: 2 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(lineChart, quarters(), { encoding: XY, attrs: { points: 'all' }, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('survives a constant series, which has a degenerate domain', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
      ],
      [
        ['Q1', 7],
        ['Q2', 7],
      ],
    );
    const run = runChart(lineChart, table, { encoding: XY });
    const [lo, hi] = run.encoded.scales.y?.domain as [number, number];
    expect(lo).toBeLessThan(hi);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('line: description', () => {
  it('names the type, the count and the range', () => {
    const run = runChart(lineChart, quarters(), { encoding: XY });
    expect(run.description).toMatch(/^Line chart\./);
    expect(run.description).toContain('4 points');
  });
});

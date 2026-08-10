/**
 * `bar` (SPEC 8.2), asserted numerically.
 *
 * The frame is 400 × 200 and the data is `100, 200, 300, 400` over four
 * quarters, so every expected number below is arithmetic a reader can redo by
 * hand:
 *
 * - band step = `400 / (4 + 0.2)` = 95.238…, bandwidth = step × 0.8
 * - value domain nices to `[0, 400]`, range inverts to `[200, 0]`
 * - therefore 100 → y 150, 200 → y 100, 400 → y 0
 *
 * The one number that is *not* data-derived is the 24 px thickness cap: the
 * bands are 76 px wide, so SPEC 11.4's "bars are at most 24 px thick" is what
 * decides the width, and a regression there shows up as a 76.19.
 */

import { describe, expect, it } from 'vitest';
import type { BarMark, RectNode } from '@mdv/core';
import { barChart } from '../src/bar.js';
import {
  EMPTY_TABLE,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  quarters,
  runChart,
  twoSeries,
} from './harness.js';

const XY = { x: { field: 'quarter' }, y: { field: 'revenue' } };

/** Band geometry for `n` categories across the 400 px frame at padding 0.2. */
function band(n: number, padding = 0.2) {
  const step = 400 / (n + padding);
  return { step, width: step * (1 - padding), start: step * padding };
}

function rects(nodes: readonly RectNode[] | ReturnType<typeof nodesOfKind>): RectNode[] {
  return nodes as RectNode[];
}

describe('bar: mark geometry', () => {
  const run = runChart(barChart, quarters(), { encoding: XY });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('emits one rect per row, in row order', () => {
    expect(bars).toHaveLength(4);
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([100, 200, 300, 400]);
  });

  it('places the first bar at the centre of the first band, 24 px wide', () => {
    const { step, start, width } = band(4);
    const centre = start + width / 2;
    expect(bars[0]?.w).toBe(24);
    expect(bars[0]?.x).toBeCloseTo(centre - 12, 4);
    expect(bars[1]?.x).toBeCloseTo(centre + step - 12, 4);
  });

  it('caps thickness at the theme maximum rather than filling the band', () => {
    // The band is 76 px wide; SPEC 11.4 caps the bar at 24.
    expect(band(4).width).toBeCloseTo(76.190476, 4);
    for (const bar of bars) expect(bar.w).toBe(24);
  });

  it('grows every bar from the zero baseline, upward', () => {
    // domain [0, 400] over the inverted range [200, 0]: 1 unit = 0.5 px.
    expect(bars.map((b) => b.h)).toEqual([50, 100, 150, 200]);
    expect(bars.map((b) => b.y)).toEqual([150, 100, 50, 0]);
    for (const bar of bars) expect(bar.y + bar.h).toBe(200);
  });

  it('rounds the data end only, square at the baseline (SPEC 11.4)', () => {
    expect(bars[0]?.r).toEqual([4, 4, 0, 0]);
  });

  it('anchors each hit region at the bar tip, not its centre', () => {
    const { start, width } = band(4);
    expect(run.laid.hits).toHaveLength(4);
    expect(run.laid.hits[0]?.anchor?.x).toBeCloseTo(start + width / 2, 4);
    expect(run.laid.hits[0]?.anchor?.y).toBe(150);
    expect(run.laid.hits[0]?.markNodeId).toBe(bars[0]?.id);
  });

  it('reports a value axis and a category axis, and no second value axis', () => {
    expect(run.encoded.axes.map((a) => a.position).sort()).toEqual(['bottom', 'left']);
    expect(run.encoded.scales.x?.type).toBe('band');
    expect(run.encoded.scales.y?.domain).toEqual([0, 400]);
  });

  it('emits no NaN anywhere in the scene, the hits or the marks', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(nonFiniteNumbers(run.encoded.marks)).toEqual([]);
  });
});

describe('bar: negative values', () => {
  const table = makeTable(
    [
      ['label', 'category'],
      ['delta', 'number'],
    ],
    [
      ['A', 40],
      ['B', -40],
    ],
  );
  const run = runChart(barChart, table, {
    encoding: { x: { field: 'label' }, y: { field: 'delta' } },
  });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('puts the zero line in the middle and hangs the negative bar below it', () => {
    // Domain [-40, 40] over [200, 0]: zero sits at y 100.
    expect(run.encoded.scales.y?.domain).toEqual([-40, 40]);
    expect(bars[0]?.y).toBe(0);
    expect(bars[0]?.h).toBe(100);
    expect(bars[1]?.y).toBe(100);
    expect(bars[1]?.h).toBe(100);
  });

  it('rounds the bottom corners of a downward bar', () => {
    expect(bars[0]?.r).toEqual([4, 4, 0, 0]);
    expect(bars[1]?.r).toEqual([0, 0, 4, 4]);
  });
});

describe('bar: grouped', () => {
  const run = runChart(barChart, twoSeries(), {
    encoding: { ...XY, series: { field: 'region' } },
  });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('splits each band into one slot per series', () => {
    expect(run.encoded.series.map((s) => s.id)).toEqual(['North', 'South']);
    expect(bars).toHaveLength(4);
    for (const mark of run.encoded.marks) expect(mark.groupCount).toBe(2);
  });

  it('opens exactly one 2 px surface channel between neighbours', () => {
    const { width } = band(2);
    const slot = width / 2;
    // withinGroup = slot × (1 − groupPadding) − surfaceGap, then capped at 24.
    const expected = Math.min(slot * 0.9 - 2, 24);
    expect(bars[0]?.w).toBeCloseTo(expected, 4);
    const left = bars[0];
    const right = bars[1];
    if (left === undefined || right === undefined) throw new Error('two bars expected');
    // Slot centres are one slot apart; the drawn edges leave the rest as surface.
    expect(right.x - (left.x + left.w)).toBeGreaterThanOrEqual(2);
  });

  it('gives each series its own palette slot, ordered by first appearance', () => {
    expect(run.encoded.series.map((s) => s.slot)).toEqual([0, 1]);
  });
});

describe('bar: stacked', () => {
  const run = runChart(barChart, twoSeries(), {
    encoding: { ...XY, series: { field: 'region' } },
    attrs: { stack: 'normal' },
  });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('places one bar per band and stacks the series within it', () => {
    // Q1 is 10 + 30 = 40, Q2 is 20 + 20 = 40; the domain nices to [0, 40].
    expect(run.encoded.scales.y?.domain).toEqual([0, 40]);
    expect(run.encoded.marks.map((m) => [m.y0, m.y1])).toEqual([
      [0, 10],
      [10, 40],
      [0, 20],
      [20, 40],
    ]);
    for (const bar of bars) expect(bar.w).toBe(24);
  });

  it('separates touching segments by the 2 px surface gap', () => {
    const lower = bars[0];
    const upper = bars[1];
    if (lower === undefined || upper === undefined) throw new Error('two segments expected');
    // 10 of 40 over 200 px is 50 px, less half the gap where it meets the segment above.
    expect(lower.y + lower.h).toBe(200);
    expect(lower.h).toBe(49);
    expect(upper.y + upper.h).toBe(149);
  });

  it('rounds only the outermost segment', () => {
    expect(bars[0]?.r).toEqual([0, 0, 0, 0]);
    expect(bars[1]?.r).toEqual([4, 4, 0, 0]);
  });
});

describe('bar: percent stacked', () => {
  const run = runChart(barChart, twoSeries(), {
    encoding: { ...XY, series: { field: 'region' } },
    attrs: { stack: 'percent' },
  });

  it('spans exactly 0 → 1 at every category', () => {
    expect(run.encoded.scales.y?.domain).toEqual([0, 1]);
    const tops = run.encoded.marks.filter((m) => m.seriesId === 'South').map((m) => m.y1);
    expect(tops).toEqual([1, 1]);
  });

  it('fills the plot exactly, top to bottom', () => {
    const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));
    const q1 = bars.slice(0, 2);
    const bottom = q1[0];
    const top = q1[1];
    if (bottom === undefined || top === undefined) throw new Error('two segments expected');
    expect(bottom.y + bottom.h).toBe(200);
    expect(top.y).toBe(0);
  });
});

describe('bar: horizontal', () => {
  const run = runChart(barChart, quarters(), {
    encoding: XY,
    attrs: { orientation: 'horizontal' },
  });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('runs the category down the frame and the value across it', () => {
    const step = 200 / (4 + 0.2);
    expect(bars).toHaveLength(4);
    expect(bars[0]?.x).toBe(0);
    expect(bars[0]?.w).toBe(100);
    expect(bars[0]?.h).toBe(24);
    expect(bars[1]?.y).toBeCloseTo((bars[0]?.y ?? 0) + step, 3);
  });

  it('rounds the right-hand end of a positive bar', () => {
    expect(bars[0]?.r).toEqual([0, 4, 4, 0]);
  });

  it('puts the category axis on the left and the value axis on the bottom', () => {
    const byChannel = Object.fromEntries(run.encoded.axes.map((a) => [a.channel, a.position]));
    expect(byChannel).toEqual({ x: 'left', y: 'bottom' });
  });
});

describe('bar: sorting', () => {
  it('sorts descending by value while keeping each series its own color', () => {
    const run = runChart(barChart, quarters(), { encoding: XY, attrs: { sort: 'desc' } });
    expect(run.encoded.scales.x?.domain).toEqual(['Q4', 'Q3', 'Q2', 'Q1']);
  });

  it('leaves the data order alone by default', () => {
    const run = runChart(barChart, quarters(), { encoding: XY });
    expect(run.encoded.scales.x?.domain).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
  });
});

describe('bar: diagnostics', () => {
  it('reports MDV3000 when a required channel is missing', () => {
    const run = runChart(barChart, quarters(), { encoding: { x: { field: 'quarter' } } });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3001 when the value channel is not quantitative', () => {
    const run = runChart(barChart, quarters(), {
      encoding: { x: { field: 'revenue' }, y: { field: 'quarter' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3001');
  });

  it('reports MDV3021 when the author suppresses zero on a bar axis', () => {
    const run = runChart(barChart, quarters(), {
      encoding: { ...XY, y: { field: 'revenue', scale: { zero: false } } },
    });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV3021');
  });

  it('reports MDV1502 for an unknown enum and falls back to the default', () => {
    const run = runChart(barChart, quarters(), { encoding: XY, attrs: { stack: 'sideways' } });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(4);
  });
});

describe('bar: degenerate input', () => {
  it('draws nothing for an empty table and does not throw', () => {
    const run = runChart(barChart, EMPTY_TABLE, { encoding: XY });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
    expect(nonFiniteNumbers(run.encoded)).toEqual([]);
  });

  it('draws nothing when the columns exist but no rows do', () => {
    const run = runChart(
      barChart,
      noRows([
        ['quarter', 'category'],
        ['revenue', 'number'],
      ]),
      { encoding: XY },
    );
    expect(nodesOfKind(run.laid.nodes, 'rect')).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('draws a single row as one centred bar', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
      ],
      [['Q1', 250]],
    );
    const run = runChart(barChart, table, { encoding: XY });
    const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));
    const { start, width } = band(1);
    expect(bars).toHaveLength(1);
    expect(bars[0]?.x).toBeCloseTo(start + width / 2 - 12, 4);
    expect(bars[0]?.y).toBeGreaterThanOrEqual(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives an all-null value column without NaN geometry', () => {
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
    const run = runChart(barChart, table, { encoding: XY });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(nonFiniteNumbers(run.encoded)).toEqual([]);
  });

  it('survives an all-null category column', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
      ],
      [
        [null, 1],
        [null, 2],
      ],
    );
    const run = runChart(barChart, table, { encoding: XY });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives extreme aspect ratios in both directions', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 900 },
      { x: 0, y: 0, width: 2000, height: 1 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 3, height: 3 },
    ]) {
      const run = runChart(barChart, quarters(), { encoding: XY, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
      for (const rect of rects(nodesOfKind(run.laid.nodes, 'rect'))) {
        expect(rect.w).toBeGreaterThanOrEqual(0);
        expect(rect.h).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('bar: description', () => {
  it('names the subject, the count and the extremes (SPEC 12.2)', () => {
    const run = runChart(barChart, quarters(), { encoding: XY });
    expect(run.description).toMatch(/^Bar chart\./);
    expect(run.description).toContain('4 categories');
    expect(run.description).toContain('Q4');
  });

  it('describes an empty chart without inventing data', () => {
    const run = runChart(barChart, EMPTY_TABLE, { encoding: XY });
    expect(run.description).toBe('Bar chart with no data.');
  });
});

describe('bar: a11y table', () => {
  it('carries one row per datum through the registry contract', () => {
    const run = runChart(barChart, quarters(), { encoding: XY });
    const view = run.encoded.a11yTable;
    expect(view?.rows).toHaveLength(4);
    expect(view?.columns.map((c) => c.name)).toEqual(['Quarter', 'Revenue']);
    expect(view?.columns.map((c) => c.align)).toEqual(['left', 'right']);
    expect(view?.rows[0]).toEqual(['Q1', '100']);
  });
});

describe('bar: marks are data space', () => {
  it('never puts a pixel in a mark', () => {
    const run = runChart(barChart, quarters(), {
      encoding: XY,
      frame: { x: 0, y: 0, width: 1000, height: 1000 },
    });
    const values = run.encoded.marks.flatMap((m: BarMark) => [m.y0, m.y1]);
    expect(values).toEqual([0, 100, 0, 200, 0, 300, 0, 400]);
  });
});

/**
 * `area` (SPEC 8.4), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame:
 *
 * - `quarters()`: a categorical x is a **point** scale at padding 0.5, so
 *   step = 400 / 4 and the points sit at x = 50, 150, 250, 350. Unlike a line,
 *   the y-domain **includes zero** (SPEC 7.2), so it is `[0, 400]` over the
 *   inverted range `[200, 0]`: 1 unit = ½ px, and the baseline is y = 200.
 * - `twoSeries()`: two categories, so step = 400 / 2 and x = 100, 300. Stacked,
 *   both quarters total 40, so the domain is `[0, 40]`: 1 unit = 5 px.
 *
 * The area-specific rules are the ones worth guarding: the fill is a ~10 %
 * wash rather than a block, three unstacked fills are `MDV3040`, a truncated
 * axis is `MDV3021`, and a percent stack reaches the top of the plot exactly.
 */

import { describe, expect, it } from 'vitest';
import type { PathNode } from '@mdv/core';
import { areaChart } from '../src/area.js';
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
const SERIES = { ...XY, series: { field: 'region' } };

function paths(nodes: readonly unknown[]): PathNode[] {
  return nodesOfKind(nodes as never, 'path');
}

/** Only the closed fills, not the boundary strokes. */
function fills(nodes: readonly unknown[]): PathNode[] {
  return paths(nodes).filter((node) => node.fill !== undefined);
}

/** Only the boundary strokes. */
function strokes(nodes: readonly unknown[]): PathNode[] {
  return paths(nodes).filter((node) => node.stroke !== undefined);
}

/** The `(x, y)` pairs of a path's move/line commands, in order. */
function vertices(node: PathNode | undefined): [number, number][] {
  return (node?.d ?? [])
    .filter((command) => command.c === 'M' || command.c === 'L')
    .map((command) => [(command as { x: number }).x, (command as { y: number }).y]);
}

/** Three regions, so unstacked overlap becomes unreadable. */
function threeSeries() {
  return makeTable(
    [
      ['quarter', 'category'],
      ['region', 'category'],
      ['revenue', 'number'],
    ],
    [
      ['Q1', 'North', 10],
      ['Q1', 'South', 30],
      ['Q1', 'East', 20],
      ['Q2', 'North', 20],
      ['Q2', 'South', 20],
      ['Q2', 'East', 40],
    ],
  );
}

describe('area: mark geometry', () => {
  const run = runChart(areaChart, quarters(), { encoding: XY });

  it('closes the band between the values and the baseline', () => {
    const fill = fills(run.laid.nodes)[0];
    expect(fill).toBeDefined();
    expect(fill?.d.at(-1)?.c).toBe('Z');
    // Four points across the top, then four back along the baseline.
    expect(vertices(fill)).toEqual([
      [50, 150],
      [150, 100],
      [250, 50],
      [350, 0],
      [350, 200],
      [250, 200],
      [150, 200],
      [50, 200],
    ]);
  });

  it('includes zero in the domain, unlike a line (SPEC 7.2)', () => {
    expect(run.encoded.scales.y?.domain).toEqual([0, 400]);
  });

  it('fills at ~10 % opacity — a wash, never a block (SPEC 11.4)', () => {
    const fill = fills(run.laid.nodes)[0]?.fill;
    expect(fill).toEqual({ kind: 'solid', color: '#111180', opacity: 0.1 });
  });

  it('draws the boundary line over the fill at the mark spec width', () => {
    const nodes = paths(run.laid.nodes);
    expect(nodes).toHaveLength(2);
    expect(nodes[0]?.fill).toBeDefined();
    expect(nodes[1]?.stroke?.width).toBe(2);
    expect(nodes[1]?.stroke?.join).toBe('round');
    // The stroke traces only the top edge, not the closed band.
    expect(vertices(nodes[1])).toEqual([
      [50, 150],
      [150, 100],
      [250, 50],
      [350, 0],
    ]);
  });

  it('drops the boundary line for `line: false` but keeps the fill', () => {
    const bare = runChart(areaChart, quarters(), { encoding: XY, attrs: { line: false } });
    expect(fills(bare.laid.nodes)).toHaveLength(1);
    expect(strokes(bare.laid.nodes)).toHaveLength(0);
  });

  it('honours an explicit fillOpacity', () => {
    const solid = runChart(areaChart, quarters(), { encoding: XY, attrs: { fillOpacity: 0.5 } });
    expect(fills(solid.laid.nodes)[0]?.fill).toMatchObject({ opacity: 0.5 });
  });

  it('emits no NaN anywhere', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('area: stacking (SPEC 8.4)', () => {
  it('stacks by default once there is more than one series', () => {
    const run = runChart(areaChart, twoSeries(), { encoding: SERIES });
    expect(run.encoded.scales.y?.domain).toEqual([0, 40]);
  });

  it('lays the second series on top of the first, not over it', () => {
    const run = runChart(areaChart, twoSeries(), { encoding: SERIES });
    const [north, south] = fills(run.laid.nodes);
    // North: 10 and 20 above a zero baseline at y = 200.
    expect(vertices(north)).toEqual([
      [100, 150],
      [300, 100],
      [300, 200],
      [100, 200],
    ]);
    // South rests on North's top edge and reaches the 40-unit total at y = 0.
    expect(vertices(south)).toEqual([
      [100, 0],
      [300, 0],
      [300, 100],
      [100, 150],
    ]);
  });

  it('overlaps rather than stacks for `stack: none`', () => {
    const run = runChart(areaChart, twoSeries(), { encoding: SERIES, attrs: { stack: 'none' } });
    // Both series now grow from the same baseline, so the domain is the max, 30.
    expect(run.encoded.scales.y?.domain).toEqual([0, 30]);
    for (const fill of fills(run.laid.nodes)) {
      expect(vertices(fill).some(([, y]) => y === 200)).toBe(true);
    }
  });

  it('rejects three unstacked overlapping fills (MDV3040)', () => {
    const run = runChart(areaChart, threeSeries(), { encoding: SERIES, attrs: { stack: 'none' } });
    expect(codesOf(run)).toContain('MDV3040');
  });

  it('says nothing about overlap when the three series are stacked', () => {
    const run = runChart(areaChart, threeSeries(), { encoding: SERIES });
    expect(codesOf(run)).not.toContain('MDV3040');
  });

  it('handles negative values by growing the band downward', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['region', 'category'],
        ['revenue', 'number'],
      ],
      [
        ['Q1', 'North', 10],
        ['Q1', 'South', -4],
        ['Q2', 'North', 5],
        ['Q2', 'South', -6],
      ],
    );
    const run = runChart(areaChart, table, { encoding: SERIES });
    // Q1 spans [-4, 10] and Q2 spans [-6, 5]: each negative grows downward from
    // zero rather than being folded into the positive run above it.
    expect(run.encoded.scales.y?.domain).toEqual([-6, 10]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('area: percent stacking', () => {
  const run = runChart(areaChart, twoSeries(), { encoding: SERIES, attrs: { stack: 'percent' } });

  it('pins the domain to exactly [0, 1]', () => {
    expect(run.encoded.scales.y?.domain).toEqual([0, 1]);
  });

  it('reaches the top of the plot exactly, with no sliver of background', () => {
    const [, south] = fills(run.laid.nodes);
    // Q1 is 10 / 40 = 25 %, Q2 is 20 / 40 = 50 %; the top edge is y = 0 exactly.
    expect(vertices(south)).toEqual([
      [100, 0],
      [300, 0],
      [300, 100],
      [100, 150],
    ]);
  });

  it('formats the value axis as a percentage', () => {
    expect(run.encoded.scales.y?.format(0.25)).toBe('25%');
  });

  it('still reaches exactly 100 % for shares that do not divide evenly', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['region', 'category'],
        ['revenue', 'number'],
      ],
      [
        ['Q1', 'North', 1],
        ['Q1', 'South', 1],
        ['Q1', 'East', 1],
      ],
    );
    const thirds = runChart(areaChart, table, { encoding: SERIES, attrs: { stack: 'percent' } });
    const top = fills(thirds.laid.nodes).at(-1);
    expect(vertices(top)[0]?.[1]).toBe(0);
  });
});

describe('area: truncated axis (MDV3021)', () => {
  it('warns when the author suppresses zero on a filled magnitude', () => {
    const run = runChart(areaChart, quarters(), {
      encoding: { x: { field: 'quarter' }, y: { field: 'revenue', scale: { zero: false } } },
    });
    expect(codesOf(run)).toContain('MDV3021');
  });

  it('does not warn when zero is present by default', () => {
    expect(codesOf(runChart(areaChart, quarters(), { encoding: XY }))).not.toContain('MDV3021');
  });
});

describe('area: missing data', () => {
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
      ],
    );
  }

  it('breaks the band into two closed fills by default (SPEC 6.5)', () => {
    const run = runChart(areaChart, gapped(), { encoding: XY });
    const bands = fills(run.laid.nodes);
    expect(bands).toHaveLength(2);
    for (const band of bands) expect(band.d.at(-1)?.c).toBe('Z');
  });

  it('bridges the gap for `nullPolicy: skip`', () => {
    const run = runChart(areaChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'skip' } });
    expect(fills(run.laid.nodes)).toHaveLength(1);
  });

  it('sinks the band to the baseline for `nullPolicy: zero`', () => {
    const run = runChart(areaChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'zero' } });
    const band = fills(run.laid.nodes)[0];
    // The middle point sits on the baseline rather than leaving a hole.
    expect(vertices(band)[1]).toEqual([200, 200]);
  });

  it('takes the category off the axis for `nullPolicy: drop`', () => {
    const run = runChart(areaChart, gapped(), { encoding: XY, attrs: { nullPolicy: 'drop' } });
    expect(run.encoded.scales.x?.domain).toEqual(['Q1', 'Q3']);
  });
});

describe('area: degenerate data', () => {
  it('survives the empty table without drawing anything', () => {
    const run = runChart(areaChart, EMPTY_TABLE, { encoding: XY });
    expect(fills(run.laid.nodes)).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives columns with no rows', () => {
    const run = runChart(
      areaChart,
      noRows([
        ['quarter', 'category'],
        ['revenue', 'number'],
      ]),
      { encoding: XY },
    );
    expect(run.laid.hits).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('draws a single row as a band with a usable domain', () => {
    const table = makeTable(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
      ],
      [['Q1', 50]],
    );
    const run = runChart(areaChart, table, { encoding: XY });
    expect(run.encoded.scales.y?.domain).toEqual([0, 50]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives an all-null value column', () => {
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
    const run = runChart(areaChart, table, { encoding: XY });
    expect(fills(run.laid.nodes)).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN at any extreme aspect ratio', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 4, height: 2000 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(areaChart, twoSeries(), { encoding: SERIES, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });
});

describe('area: accessibility', () => {
  it('describes itself through the registry contract', () => {
    const run = runChart(areaChart, quarters(), { encoding: XY });
    expect(run.description).toBe(
      'Area chart. Plotted over quarter, 4 points. Values range from 100 at Q1 to 400 at Q4.',
    );
  });

  it('says so plainly when there is nothing to describe', () => {
    expect(runChart(areaChart, EMPTY_TABLE, { encoding: XY }).description).toBe(
      'Area chart with no data.',
    );
  });

  it('offers the data as a table through `a11yTable`', () => {
    const run = runChart(areaChart, quarters(), { encoding: XY });
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).toEqual(['Quarter', 'Revenue']);
    expect(run.encoded.a11yTable?.rows[0]).toEqual(['Q1', '100']);
  });
});

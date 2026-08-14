/**
 * `sparkline` (SPEC 8.12, 9.2), asserted numerically.
 *
 * A sparkline is defined by everything it does **not** have — no axes, no
 * legend, no tooltip, no hit regions (SPEC 8.12) — so most of what a chart
 * suite normally reads back is gone. What is left is the strip and the numbers
 * in it, and that is what this file checks, to the pixel.
 *
 * ## The strip
 *
 * The line is inset by the room its own ink needs, so a stroke or a marker
 * cannot be clipped by the frame it is drawn to the edge of:
 *
 *   - `points: none` wants half a stroke — at `strokeWidth: 2`, **1 px**;
 *   - any other policy wants the marker radius plus its surface ring — at the
 *     default `pointSize: 8` and the theme's 2 px ring, **6 px**.
 *
 * Both frames here are chosen so the strip comes out **120 × 96**: 122 × 98 for
 * the chromeless runs and 132 × 108 for the ones with markers. So five points
 * sit 30 px apart and one data unit is a whole number of pixels in every
 * fixture below, and every coordinate this file names is exact.
 *
 *   - {@link SERIES} — `12, 15, 13, 19, 24`, extent `[12, 24]`, **8 px per
 *     unit**: y = 97, 73, 89, 41, 1 in the chromeless strip;
 *   - {@link LOWER}/{@link UPPER} — a band around it that widens the shared
 *     extent to `[6, 30]`, **4 px per unit**, which moves the line: y = 73, 61,
 *     69, 45, 25. That the *line* moves when only the *band* changed is the
 *     whole claim of SPEC 8.12 here — one extent covers both, so the band is
 *     always visibly around the line rather than crossing it.
 *
 * ## What the suite leans on
 *
 *   - **chromeless is a contract, not a style** (SPEC 8.12): no axes, no text
 *     node anywhere in the scene, no hit region, and `family: 'none'`. A
 *     sparkline that grew a readout would still draw correctly and would still
 *     be the wrong picture;
 *   - **it self-scales, and it shares that arithmetic** (SPEC 9.2). The extent
 *     is taken over the line *and* both band edges together;
 *   - **non-finite values are dropped, not gapped** (SPEC 8.12). There is no
 *     `nullPolicy` here — unlike `line` (SPEC 8.3), which gaps by default —
 *     because a gap is a statement about missingness that needs an axis to be
 *     read against, and there is no axis. The survivors re-space, and a band
 *     edge leaves with the value it qualified rather than sliding onto its
 *     neighbour;
 *   - **the data is still reachable** (SPEC 12.3). The table view carries every
 *     point, and both band bounds when there is a band; the description says
 *     where the line ends, which is the reading a sparkline is for;
 *   - **the author is told when a spelling is wrong** (SPEC 15.2) and the chart
 *     still draws: `MDV1502` for an unknown `curve` or `points`, `MDV1501` for
 *     a half-specified `band`.
 */

import { describe, expect, it } from 'vitest';
import type { LineMark, Rect, Table } from '@mdv/core';
import { sparklineChart } from '../src/sparkline.js';
import {
  EMPTY_TABLE,
  type ChartRun,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  runChart,
} from './harness.js';

/** 122 × 98: with `strokeWidth: 2` and no markers, a 120 × 96 strip at (1, 1). */
const FRAME: Rect = { x: 0, y: 0, width: 122, height: 98 };

/** 132 × 108: with markers, the 6 px inset leaves the same 120 × 96 strip. */
const MARKER_FRAME: Rect = { x: 0, y: 0, width: 132, height: 108 };

/** The running example. Extent `[12, 24]`, so 8 px per unit in a 96 px strip. */
const SERIES = '12,15,13,19,24';

/** A band around {@link SERIES}: it widens the shared extent to `[6, 30]`. */
const LOWER = [6, 9, 7, 13, 18];
const UPPER = [18, 21, 19, 25, 30];

/** The same numbers as {@link SERIES}, in a column an author can bind to. */
function visits(): Table {
  return makeTable([['visits', 'number']], [[12], [15], [13], [19], [24]]);
}

function runSpark(
  table: Table = EMPTY_TABLE,
  options: Parameters<typeof runChart>[2] = {},
): ChartRun<LineMark> {
  return runChart(sparklineChart, table, {
    blockType: 'sparkline',
    level: 2,
    frame: FRAME,
    ...options,
  });
}

/** The chromeless run everything in the geometry section reads. */
function inline(attrs: Record<string, unknown> = {}, frame: Rect = FRAME): ChartRun<LineMark> {
  return runSpark(EMPTY_TABLE, {
    attrs: attrsOf({ data: SERIES, strokeWidth: 2, ...attrs }),
    frame,
  });
}

/**
 * The point each of a path's commands lands on, in order.
 *
 * Every command but `Z` carries its endpoint as `(x, y)`, so this reads the
 * same list of points out of a linear path and a curved one — which is what
 * makes "a curve reaches the same points" assertable.
 */
function vertices(run: ChartRun<LineMark>, index = 0): [number, number][] {
  const node = nodesOfKind(run.laid.nodes, 'path')[index];
  return (node?.d ?? []).flatMap((command) =>
    'x' in command && 'y' in command ? [[command.x, command.y] as [number, number]] : [],
  );
}

/** The centre of every marker, in paint order. */
function markers(run: ChartRun<LineMark>): [number, number][] {
  return nodesOfKind(run.laid.nodes, 'circle').map((node) => [node.cx, node.cy]);
}

describe('sparkline: the type declaration (SPEC 8.12)', () => {
  it('is a Level 2 type with no readout family', () => {
    expect(sparklineChart.level).toBe(2);
    expect(sparklineChart.family).toBe('none');
  });

  it('defaults to 48 px tall, not the 300 px of a plot (SPEC 8.1, 5.5)', () => {
    expect(sparklineChart.defaults?.['height']).toBe(48);
  });

  it('stays legible far below a plot minimum: it is a shape, not a reading', () => {
    expect(sparklineChart.minWidth).toBe(80);
  });
});

describe('sparkline: chromeless is a contract (SPEC 8.12)', () => {
  const run = inline();

  it('encodes no axes and no scales to tick', () => {
    expect(run.encoded.axes).toEqual([]);
    expect(run.encoded.scales).toEqual({});
  });

  it('names one unnamed series, so there is no legend to draw', () => {
    expect(run.encoded.series).toHaveLength(1);
    expect(run.encoded.series[0]?.id).toBe('');
  });

  it('lays out no text anywhere in the scene', () => {
    expect(nodesOfKind(run.laid.nodes, 'text')).toEqual([]);
  });

  it('offers no hit regions, so nothing can be hovered', () => {
    expect(run.laid.hits).toEqual([]);
  });

  it('reports nothing: a correct sparkline is a silent one', () => {
    expect(run.diagnostics).toEqual([]);
  });
});

describe('sparkline: the numbers are the geometry (SPEC 9.2)', () => {
  const run = inline();

  it('draws one polyline and nothing else', () => {
    expect(nodesOfKind(run.laid.nodes, 'path')).toHaveLength(1);
    expect(nodesOfKind(run.laid.nodes, 'circle')).toEqual([]);
  });

  it('spaces the points evenly across the strip and scales to their own extent', () => {
    expect(vertices(run)).toEqual([
      [1, 97],
      [31, 73],
      [61, 89],
      [91, 41],
      [121, 1],
    ]);
  });

  it('reaches both edges: the lowest value sits on the floor, the highest on the ceiling', () => {
    const ys = vertices(run).map(([, y]) => y);
    expect(Math.min(...ys)).toBe(1);
    expect(Math.max(...ys)).toBe(97);
  });

  it('carries the class token and the author stroke width (SPEC 22.4, 11.4)', () => {
    const line = nodesOfKind(run.laid.nodes, 'path')[0];
    expect(line?.cls).toBe('mdv-mark mdv-mark-line');
    expect(line?.stroke?.width).toBe(2);
    expect(line?.stroke?.cap).toBe('round');
    expect(line?.fill).toBeUndefined();
  });

  it('reads a bound column to the same picture as the inline list (SPEC 5.2)', () => {
    const bound = runSpark(visits(), {
      encoding: { y: { field: 'visits' } },
      attrs: attrsOf({ strokeWidth: 2 }),
    });
    expect(vertices(bound)).toEqual(vertices(inline()));
    expect(bound.diagnostics).toEqual([]);
  });

  it('answers to `value` as well as `y`, since either spelling reaches the same channel', () => {
    const run2 = runSpark(visits(), {
      encoding: { value: { field: 'visits' } },
      attrs: attrsOf({ strokeWidth: 2 }),
    });
    expect(vertices(run2)).toEqual(vertices(inline()));
  });

  it('produces no NaN geometry anywhere', () => {
    expect(nonFiniteNumbers(run)).toEqual([]);
  });
});

describe('sparkline: the band contains the line (SPEC 8.12)', () => {
  const run = inline({ band: { lower: LOWER, upper: UPPER } });

  it('draws the band first, then the line over it', () => {
    const paths = nodesOfKind(run.laid.nodes, 'path');
    expect(paths).toHaveLength(2);
    expect(paths[0]?.cls).toBe('mdv-mark mdv-mark-band');
    expect(paths[1]?.cls).toBe('mdv-mark mdv-mark-line');
  });

  it('rescales the line to the extent it now shares with both edges', () => {
    expect(vertices(run, 1)).toEqual([
      [1, 73],
      [31, 61],
      [61, 69],
      [91, 45],
      [121, 25],
    ]);
  });

  it('closes the band over the upper edge and back along the lower', () => {
    expect(vertices(run, 0)).toEqual([
      [1, 49],
      [31, 37],
      [61, 45],
      [91, 21],
      [121, 1],
      [121, 49],
      [91, 69],
      [61, 93],
      [31, 85],
      [1, 97],
    ]);
  });

  it('closes the subpath, so the band is an area and not a stroke', () => {
    expect(nodesOfKind(run.laid.nodes, 'path')[0]?.d.at(-1)).toEqual({ c: 'Z' });
  });

  it('contains the line at every point it draws', () => {
    const band = vertices(run, 0);
    const line = vertices(run, 1);
    const upper = band.slice(0, 5);
    const lower = band.slice(5).reverse();
    line.forEach(([x, y], index) => {
      expect(upper[index]?.[0]).toBe(x);
      expect(lower[index]?.[0]).toBe(x);
      // y grows downwards: the upper edge is the smaller number.
      expect(upper[index]?.[1]).toBeLessThanOrEqual(y);
      expect(lower[index]?.[1]).toBeGreaterThanOrEqual(y);
    });
  });

  it('never saturates the band: it is a wash under the line (SPEC 11.4)', () => {
    expect(nodesOfKind(run.laid.nodes, 'path')[0]?.fill).toEqual({
      kind: 'solid',
      color: '#111180',
      opacity: 0.1,
    });
    expect(nodesOfKind(run.laid.nodes, 'path')[0]?.stroke).toBeUndefined();
  });

  it('reads band edges from columns as readily as from inline lists', () => {
    const table = makeTable(
      [
        ['visits', 'number'],
        ['low', 'number'],
        ['high', 'number'],
      ],
      [
        [12, 6, 18],
        [15, 9, 21],
        [13, 7, 19],
        [19, 13, 25],
        [24, 18, 30],
      ],
    );
    const bound = runSpark(table, {
      encoding: { y: { field: 'visits' } },
      attrs: attrsOf({ strokeWidth: 2, band: { lower: 'low', upper: 'high' } }),
    });
    expect(vertices(bound, 0)).toEqual(vertices(run, 0));
    expect(vertices(bound, 1)).toEqual(vertices(run, 1));
  });

  it('accepts a constant reference band, which is a second line the form cannot draw', () => {
    const flat = inline({ band: { lower: 6, upper: 30 } });
    // The same extent as the varying band, so the line lands in the same place.
    expect(vertices(flat, 1)).toEqual(vertices(run, 1));
    expect(vertices(flat, 0)).toEqual([
      [1, 1],
      [31, 1],
      [61, 1],
      [91, 1],
      [121, 1],
      [121, 97],
      [91, 97],
      [61, 97],
      [31, 97],
      [1, 97],
    ]);
  });

  it('produces no NaN geometry anywhere', () => {
    expect(nonFiniteNumbers(run)).toEqual([]);
  });
});

describe('sparkline: non-finite values are dropped, not gapped (SPEC 8.12)', () => {
  const table = makeTable([['visits', 'number']], [[12], [15], [null], [19], [24]]);
  const run = runSpark(table, {
    encoding: { y: { field: 'visits' } },
    attrs: attrsOf({ strokeWidth: 2 }),
  });

  it('keeps one unbroken polyline where `line` would have made two', () => {
    expect(nodesOfKind(run.laid.nodes, 'path')).toHaveLength(1);
    expect(run.laid.nodes.length).toBe(1);
  });

  it('re-spaces the survivors across the whole strip', () => {
    expect(vertices(run)).toEqual([
      [1, 97],
      [41, 73],
      [81, 41],
      [121, 1],
    ]);
  });

  it('takes each band edge down with the value it qualified, not the neighbour', () => {
    const banded = runSpark(table, {
      encoding: { y: { field: 'visits' } },
      attrs: attrsOf({ strokeWidth: 2, band: { lower: LOWER, upper: UPPER } }),
    });
    // Row 3 left, and `7`/`19` left with it rather than sliding onto 19, which
    // keeps its own 13 and 25. The points renumber because the line re-spaced:
    // point 3 in the table is the third point on the picture.
    expect(banded.encoded.a11yTable?.rows).toEqual([
      ['1', '12', '6', '18'],
      ['2', '15', '9', '21'],
      ['3', '19', '13', '25'],
      ['4', '24', '18', '30'],
    ]);
  });

  it('drops the unparseable entries of an inline list the same way (SPEC 5.2)', () => {
    expect(vertices(inline({ data: '12,15,oops,19,24' }))).toEqual(vertices(run));
  });

  it('produces no NaN geometry anywhere', () => {
    expect(nonFiniteNumbers(run)).toEqual([]);
  });
});

describe('sparkline: markers, per the points policy (SPEC 8.3)', () => {
  it('draws none by default, which is what makes it a sparkline', () => {
    expect(markers(inline({}, MARKER_FRAME))).toEqual([]);
  });

  it('sits every marker exactly on the line it marks', () => {
    const run = inline({ points: 'all', strokeWidth: undefined }, MARKER_FRAME);
    expect(markers(run)).toEqual([
      [6, 102],
      [36, 78],
      [66, 94],
      [96, 46],
      [126, 6],
    ]);
    expect(markers(run)).toEqual(vertices(run));
  });

  it('wears the surface ring, so a dot stays legible where it crosses the line (SPEC 11.4)', () => {
    const dot = nodesOfKind(inline({ points: 'all' }, MARKER_FRAME).laid.nodes, 'circle')[0];
    expect(dot?.r).toBe(4);
    expect(dot?.cls).toBe('mdv-mark mdv-mark-point');
    expect(dot?.fill).toEqual({ kind: 'solid', color: '#111180' });
    expect(dot?.stroke?.paint).toEqual({ kind: 'solid', color: '#ffffff' });
  });

  it('gives every marker a deterministic id, never a random one (SPEC 24.3)', () => {
    const ids = nodesOfKind(inline({ points: 'all' }, MARKER_FRAME).laid.nodes, 'circle').map(
      (node) => node.id,
    );
    expect(ids).toEqual([
      'mdv-0-point-1',
      'mdv-0-point-2',
      'mdv-0-point-3',
      'mdv-0-point-4',
      'mdv-0-point-5',
    ]);
  });

  it('marks the ends, which is where the reading starts and finishes', () => {
    const run = inline({ data: '5,1,9,4', points: 'ends' }, MARKER_FRAME);
    expect(markers(run)).toEqual([
      [6, 54],
      [126, 66],
    ]);
  });

  it('marks the extremes, which are somewhere else entirely', () => {
    const run = inline({ data: '5,1,9,4', points: 'extremes' }, MARKER_FRAME);
    expect(markers(run)).toEqual([
      [46, 102],
      [86, 6],
    ]);
  });

  it('insets the strip further for markers, so a dot at the edge is not clipped', () => {
    const dotted = inline({ points: 'all' }, MARKER_FRAME);
    const [first] = markers(dotted);
    expect(first?.[0]).toBe(6);
    expect(first?.[1]).toBe(102);
  });
});

describe('sparkline: curves (SPEC 8.3)', () => {
  it('is linear by default: every command after the first is a line', () => {
    const commands = nodesOfKind(inline().laid.nodes, 'path')[0]?.d ?? [];
    expect(commands.map((command) => command.c)).toEqual(['M', 'L', 'L', 'L', 'L']);
  });

  it('takes a monotone curve, which reaches the same points by cubics', () => {
    const commands = nodesOfKind(inline({ curve: 'monotone' }).laid.nodes, 'path')[0]?.d ?? [];
    expect(commands.map((command) => command.c)).toEqual(['M', 'C', 'C', 'C', 'C']);
    expect(vertices(inline({ curve: 'monotone' }))).toEqual(vertices(inline()));
  });
});

describe('sparkline: the data is still reachable (SPEC 12.3)', () => {
  it('carries every point in the table view, ordinal first', () => {
    const table = inline().encoded.a11yTable;
    expect(table?.columns).toEqual([
      { name: 'Point', type: 'integer', align: 'right' },
      { name: 'Value', type: 'number', align: 'right' },
    ]);
    expect(table?.rows).toEqual([
      ['1', '12'],
      ['2', '15'],
      ['3', '13'],
      ['4', '19'],
      ['5', '24'],
    ]);
  });

  it('names the column when there is one, and titles the table with it', () => {
    const table = runSpark(visits(), { encoding: { y: { field: 'visits' } } }).encoded.a11yTable;
    expect(table?.caption).toBe('Visits');
    expect(table?.columns[1]?.name).toBe('Visits');
  });

  it('prefers the author title over the column name', () => {
    const table = runSpark(visits(), {
      encoding: { y: { field: 'visits' } },
      attrs: attrsOf({ title: 'Weekly visits' }),
    }).encoded.a11yTable;
    expect(table?.caption).toBe('Weekly visits');
  });

  it('adds both bounds when there is a band', () => {
    const table = inline({ band: { lower: LOWER, upper: UPPER } }).encoded.a11yTable;
    expect(table?.columns.map((column) => column.name)).toEqual([
      'Point',
      'Value',
      'Lower',
      'Upper',
    ]);
    expect(table?.rows[0]).toEqual(['1', '12', '6', '18']);
  });

  it('describes the shape and, above all, where it ends (SPEC 12.2)', () => {
    expect(inline().description).toBe(
      'Sparkline. Value, 5 points. Values range from 12 to 24. Ends at 24.',
    );
  });

  it('uses the column name as the subject when the numbers came from one', () => {
    expect(runSpark(visits(), { encoding: { y: { field: 'visits' } } }).description).toBe(
      'Sparkline. Visits, 5 points. Values range from 12 to 24. Ends at 24.',
    );
  });

  it('gets its plural right for a single point', () => {
    expect(inline({ data: '7' }).description).toBe(
      'Sparkline. Value, 1 point. Values range from 7 to 7. Ends at 7.',
    );
  });
});

describe('sparkline: what the author gets told (SPEC 15.2)', () => {
  it('asks for the numbers when there are none: no `y`, no `data`', () => {
    const run = runSpark(visits());
    expect(codesOf(run.validation)).toEqual(['MDV3000']);
    // Both doors are named, because the inline one is the whole point here.
    expect(run.validation[0]?.detail).toContain('data="1,4,2,8"');
    expect(run.validation[0]?.detail).toContain('y: revenue');
  });

  it('says which name it could not find', () => {
    const run = runSpark(visits(), { encoding: { y: { field: 'vists' } } });
    expect(codesOf(run.validation)).toEqual(['MDV3000']);
    expect(run.validation[0]?.message).toContain('`vists`');
  });

  it('stays quiet about a missing column when there is no table to look in', () => {
    // The inline case: `data=` supplied the numbers, so there is nothing to name.
    expect(runSpark(EMPTY_TABLE, { attrs: attrsOf({ data: SERIES }) }).validation).toEqual([]);
  });

  it('refuses a category where it needs a measure', () => {
    const table = makeTable([['quarter', 'category']], [['Q1'], ['Q2']]);
    const run = runSpark(table, { encoding: { y: { field: 'quarter' } } });
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
  });

  it('names an unknown curve and draws the default anyway', () => {
    const run = inline({ curve: 'squiggle' });
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1502']);
    expect(vertices(run)).toEqual(vertices(inline()));
  });

  it('names an unknown points policy and draws no markers', () => {
    const run = inline({ points: 'sometimes' }, MARKER_FRAME);
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1502']);
    expect(markers(run)).toEqual([]);
  });

  it('ignores a band that is not a `{lower, upper}` mapping', () => {
    const run = inline({ band: 'high' });
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1501']);
    expect(nodesOfKind(run.laid.nodes, 'path')).toHaveLength(1);
  });

  it('refuses a half-specified band: one edge is just a second series', () => {
    const run = inline({ band: { lower: LOWER } });
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1501']);
    expect(vertices(run)).toEqual(vertices(inline()));
  });
});

describe('sparkline: degenerate shapes', () => {
  it('runs a constant series through the middle rather than dividing by zero', () => {
    expect(vertices(inline({ data: '7,7,7,7' }))).toEqual([
      [1, 49],
      [41, 49],
      [81, 49],
      [121, 49],
    ]);
  });

  it('still marks a single observation: a zero-length line with a round cap', () => {
    expect(vertices(inline({ data: '7' }))).toEqual([
      [1, 49],
      [1, 49],
    ]);
  });

  it('draws nothing, and says so, when there is nothing to draw', () => {
    const run = runSpark();
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Sparkline with no data.');
    expect(run.encoded.a11yTable?.rows).toEqual([]);
  });

  it('draws nothing in a frame with no room, without complaint', () => {
    const run = inline({}, { x: 0, y: 0, width: 0, height: 0 });
    expect(run.laid.nodes).toEqual([]);
    expect(run.layoutDiagnostics).toEqual([]);
  });

  it('insets no further than a quarter of the frame, so a tiny strip survives', () => {
    const run = inline({ points: 'all' }, { x: 0, y: 0, width: 8, height: 8 });
    expect(nonFiniteNumbers(run)).toEqual([]);
    for (const [x, y] of markers(run)) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(8);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(8);
    }
  });

  it('draws at an offset frame, not at the origin it was written for', () => {
    const run = inline({}, { x: 10, y: 20, width: 122, height: 98 });
    expect(vertices(run)).toEqual([
      [11, 117],
      [41, 93],
      [71, 109],
      [101, 61],
      [131, 21],
    ]);
  });
});

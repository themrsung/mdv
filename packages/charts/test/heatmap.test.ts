/**
 * `heatmap` (SPEC 8.9), asserted numerically.
 *
 * The fixture is a complete 3 × 2 grid — three days across, two half-days down —
 * whose six values are `1 … 6` in a fixed reading order:
 *
 * ```
 *        Mon  Tue  Wed
 *   AM     1    2    3
 *   PM     4    5    6
 * ```
 *
 * Three properties of that shape are what the suite leans on:
 *
 * - the value extent is exactly `[1, 6]`, so a cell's colour is a point on the
 *   theme ramp a test can name (`1` is the first step, `6` is the last);
 * - no two cells share a value, so "highest" has one right answer and the
 *   description sentence is not a coin toss;
 * - the data order of the keys (`Mon, Tue, Wed` / `AM, PM`) is *already* the
 *   ascending order, so a `sort` test that reorders proves it reordered.
 *
 * The geometry suite runs in a **360 × 200** frame rather than the harness'
 * 400 × 200, because 360 divides by three: the column band is 120 px and every
 * cell edge is an integer a reader can redo by hand. Rows read **top to bottom**
 * — the first category sits at the top of the frame, like the table it came
 * from — which is the one place a heatmap's y axis disagrees with every other
 * cartesian type in this package.
 */

import { describe, expect, it } from 'vitest';
import type { CellMark, Rect } from '@mdv/core';
import { heatmapChart } from '../src/heatmap.js';
import {
  EMPTY_TABLE,
  attrsOf,
  codesOf,
  makeTable,
  makeTheme,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const XYV = { x: { field: 'day' }, y: { field: 'hour' }, value: { field: 'value' } };

const FIELDS = [
  ['day', 'category'],
  ['hour', 'category'],
  ['value', 'number'],
] as const;

/** The complete grid: every day × half-day combination, values 1 … 6. */
function grid(): ReturnType<typeof makeTable> {
  return makeTable(FIELDS, [
    ['Mon', 'AM', 1],
    ['Mon', 'PM', 4],
    ['Tue', 'AM', 2],
    ['Tue', 'PM', 5],
    ['Wed', 'AM', 3],
    ['Wed', 'PM', 6],
  ]);
}

/** The same grid with `Tue PM` never observed — a hole, not a zero. */
function gappy(): ReturnType<typeof makeTable> {
  return makeTable(FIELDS, [
    ['Mon', 'AM', 1],
    ['Mon', 'PM', 4],
    ['Tue', 'AM', 2],
    ['Wed', 'AM', 3],
    ['Wed', 'PM', 6],
  ]);
}

/** A frame whose column band is a round 120 px. */
const GRID_FRAME: Rect = { x: 0, y: 0, width: 360, height: 200 };

/** Every cell mark, in the order `encode` emitted them. */
function cells(marks: readonly CellMark[]): [unknown, unknown, number | null][] {
  return marks.map((mark) => [mark.x, mark.y, mark.value]);
}

describe('heatmap: the grid (SPEC 8.9)', () => {
  it('emits one cell per observed combination', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.marks).toHaveLength(6);
    expect(run.encoded.marks.every((mark) => mark.mark === 'cell')).toBe(true);
  });

  it('emits the cells in reading order — rows down, columns across', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(cells(run.encoded.marks)).toEqual([
      ['Mon', 'AM', 1],
      ['Tue', 'AM', 2],
      ['Wed', 'AM', 3],
      ['Mon', 'PM', 4],
      ['Tue', 'PM', 5],
      ['Wed', 'PM', 6],
    ]);
  });

  it('keys both axes in first-appearance order', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.scales.x?.domain).toEqual(['Mon', 'Tue', 'Wed']);
    expect(run.encoded.scales.y?.domain).toEqual(['AM', 'PM']);
  });

  it('carries each cell back to the row it came from', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.marks.map((mark) => mark.datum)).toEqual([0, 2, 4, 1, 3, 5]);
  });

  it('puts the column axis under the plot and the row axis beside it', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.axes?.map((axis) => [axis.channel, axis.position])).toEqual([
      ['x', 'bottom'],
      ['y', 'left'],
    ]);
  });

  it('draws no gridlines: the cells are the grid', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.axes?.map((axis) => axis.grid)).toEqual([false, false]);
  });

  it('names the three bound columns', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.boundColumns?.map((column) => column.name)).toEqual([
      'day',
      'hour',
      'value',
    ]);
  });
});

describe('heatmap: holes in the grid (SPEC 8.9)', () => {
  it('emits nothing for a combination that never appeared', () => {
    const run = runChart(heatmapChart, gappy(), { encoding: XYV });
    expect(cells(run.encoded.marks)).toEqual([
      ['Mon', 'AM', 1],
      ['Tue', 'AM', 2],
      ['Wed', 'AM', 3],
      ['Mon', 'PM', 4],
      ['Wed', 'PM', 6],
    ]);
  });

  it('keeps the key that only appears in the missing cell', () => {
    const run = runChart(heatmapChart, gappy(), { encoding: XYV });
    expect(run.encoded.scales.x?.domain).toEqual(['Mon', 'Tue', 'Wed']);
    expect(run.encoded.scales.y?.domain).toEqual(['AM', 'PM']);
  });

  it('paints nothing over a hole by default', () => {
    const run = runChart(heatmapChart, gappy(), { encoding: XYV, frame: GRID_FRAME });
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(5);
  });

  it('paints a hole with `nullFill` when the author asked for one', () => {
    const run = runChart(heatmapChart, gappy(), {
      encoding: XYV,
      attrs: attrsOf({ nullFill: '#eeeeee' }),
      frame: GRID_FRAME,
    });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    expect(rects).toHaveLength(6);
    const empty = rects.filter((node) => node.cls?.includes('mdv-mark-empty') === true);
    expect(empty).toHaveLength(1);
    expect(empty[0]?.fill).toEqual({ kind: 'solid', color: '#eeeeee' });
  });

  it('puts the painted hole exactly where the missing cell would be', () => {
    const run = runChart(heatmapChart, gappy(), {
      encoding: XYV,
      attrs: attrsOf({ nullFill: '#eeeeee' }),
      frame: GRID_FRAME,
    });
    const empty = nodesOfKind(run.laid.nodes, 'rect').find(
      (node) => node.cls?.includes('mdv-mark-empty') === true,
    );
    expect([empty?.x, empty?.y]).toEqual([121, 101]);
  });

  it('leaves a null measure unpainted but on the grid', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Mon', 'PM', null],
      ['Tue', 'AM', 2],
      ['Tue', 'PM', 6],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(run.encoded.marks.map((mark) => mark.value)).toEqual([1, 2, null, 6]);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(3);
  });

  it('treats a null measure and a missing combination the same way', () => {
    const read = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Mon', 'PM', null],
      ['Tue', 'AM', 2],
      ['Tue', 'PM', 6],
    ]);
    const unread = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Tue', 'AM', 2],
      ['Tue', 'PM', 6],
    ]);
    const attrs = attrsOf({ nullFill: '#eeeeee' });
    const one = runChart(heatmapChart, read, { encoding: XYV, attrs, frame: GRID_FRAME });
    const other = runChart(heatmapChart, unread, { encoding: XYV, attrs, frame: GRID_FRAME });
    const paint = (nodes: readonly { x?: number; y?: number; cls?: string }[]) =>
      nodes.map((node) => [node.x, node.y, node.cls]).sort();
    expect(paint(nodesOfKind(one.laid.nodes, 'rect'))).toEqual(
      paint(nodesOfKind(other.laid.nodes, 'rect')),
    );
  });

  it('drops a row whose key is missing: a cell with no key has nowhere to sit', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      [null, 'PM', 4],
      ['Tue', 'AM', 2],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV });
    expect(cells(run.encoded.marks)).toEqual([
      ['Mon', 'AM', 1],
      ['Tue', 'AM', 2],
    ]);
    expect(run.encoded.droppedRows).toBe(1);
  });
});

describe('heatmap: ordering (SPEC 8.9 `sort`)', () => {
  /** Reverse data order, so any sort at all is visible in the domain. */
  function scrambled(): ReturnType<typeof makeTable> {
    return makeTable(FIELDS, [
      ['Wed', 'PM', 6],
      ['Tue', 'PM', 5],
      ['Mon', 'PM', 4],
      ['Wed', 'AM', 3],
      ['Tue', 'AM', 2],
      ['Mon', 'AM', 1],
    ]);
  }

  it('leaves the data order alone when nothing was asked for', () => {
    const run = runChart(heatmapChart, scrambled(), { encoding: XYV });
    expect(run.encoded.scales.x?.domain).toEqual(['Wed', 'Tue', 'Mon']);
    expect(run.encoded.scales.y?.domain).toEqual(['PM', 'AM']);
  });

  it('sorts both axes when `sort` is bare', () => {
    const run = runChart(heatmapChart, scrambled(), {
      encoding: XYV,
      attrs: attrsOf({ sort: 'asc' }),
    });
    expect(run.encoded.scales.x?.domain).toEqual(['Mon', 'Tue', 'Wed']);
    expect(run.encoded.scales.y?.domain).toEqual(['AM', 'PM']);
  });

  it('sorts one axis when `sort` names one', () => {
    const run = runChart(heatmapChart, scrambled(), {
      encoding: XYV,
      attrs: attrsOf({ sort: { x: 'asc' } }),
    });
    expect(run.encoded.scales.x?.domain).toEqual(['Mon', 'Tue', 'Wed']);
    expect(run.encoded.scales.y?.domain).toEqual(['PM', 'AM']);
  });

  it('reverses for `desc`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ sort: { x: 'desc', y: 'desc' } }),
    });
    expect(run.encoded.scales.x?.domain).toEqual(['Wed', 'Tue', 'Mon']);
    expect(run.encoded.scales.y?.domain).toEqual(['PM', 'AM']);
  });

  it('promotes the keys an explicit list names and keeps the rest', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ sort: { x: ['Wed'] } }),
    });
    expect(run.encoded.scales.x?.domain).toEqual(['Wed', 'Mon', 'Tue']);
  });

  it('re-sorts the cells to match, so reading order still follows the picture', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ sort: { x: 'desc' } }),
    });
    expect(cells(run.encoded.marks)).toEqual([
      ['Wed', 'AM', 3],
      ['Tue', 'AM', 2],
      ['Mon', 'AM', 1],
      ['Wed', 'PM', 6],
      ['Tue', 'PM', 5],
      ['Mon', 'PM', 4],
    ]);
  });

  it('never adds or removes a cell, whatever the sort', () => {
    const plain = runChart(heatmapChart, grid(), { encoding: XYV });
    const sorted = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ sort: 'desc' }),
    });
    expect(sorted.encoded.marks).toHaveLength(plain.encoded.marks.length);
    expect(sorted.encoded.marks.map((mark) => mark.value).sort()).toEqual(
      plain.encoded.marks.map((mark) => mark.value).sort(),
    );
  });

  it('puts rows that behave alike next to each other under `cluster`', () => {
    // `a` and `c` have the same profile; `b` is its opposite. Whatever the
    // seriation decides the direction is, the twins must not be separated.
    const table = makeTable(FIELDS, [
      ['p', 'a', 10],
      ['q', 'a', 0],
      ['r', 'a', 10],
      ['p', 'b', 0],
      ['q', 'b', 10],
      ['r', 'b', 0],
      ['p', 'c', 10],
      ['q', 'c', 0],
      ['r', 'c', 10],
    ]);
    const run = runChart(heatmapChart, table, {
      encoding: XYV,
      attrs: attrsOf({ sort: { y: 'cluster' } }),
    });
    const order = run.encoded.scales.y?.domain ?? [];
    expect([...order].sort()).toEqual(['a', 'b', 'c']);
    expect(Math.abs(order.indexOf('a') - order.indexOf('c'))).toBe(1);
  });

  it('clusters the same matrix the same way every time (SPEC 24.3)', () => {
    const table = makeTable(FIELDS, [
      ['p', 'a', 10],
      ['q', 'a', 0],
      ['r', 'a', 10],
      ['p', 'b', 0],
      ['q', 'b', 10],
      ['r', 'b', 0],
      ['p', 'c', 9],
      ['q', 'c', 1],
      ['r', 'c', 8],
    ]);
    const once = runChart(heatmapChart, table, {
      encoding: XYV,
      attrs: attrsOf({ sort: 'cluster' }),
    });
    const twice = runChart(heatmapChart, table, {
      encoding: XYV,
      attrs: attrsOf({ sort: 'cluster' }),
    });
    expect(once.encoded.scales.y?.domain).toEqual(twice.encoded.scales.y?.domain);
    expect(once.encoded.scales.x?.domain).toEqual(twice.encoded.scales.x?.domain);
  });
});

describe('heatmap: the ramp (SPEC 8.9, 11.3)', () => {
  const STEPS = makeTheme().sequential.steps;

  it('paints the extremes with the ends of the theme ramp', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    const fills = nodesOfKind(run.laid.nodes, 'rect').map((node) => node.fill);
    expect(fills[0]).toEqual({ kind: 'solid', color: STEPS[0] });
    expect(fills.at(-1)).toEqual({ kind: 'solid', color: STEPS.at(-1) });
  });

  it('stays on one hue: every fill is a step of the ramp or between two', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    const fills = nodesOfKind(run.laid.nodes, 'rect').map((node) => node.fill);
    expect(fills).toHaveLength(6);
    for (const fill of fills) expect(fill).toMatchObject({ kind: 'solid' });
  });

  it('cuts the ramp into classes for `bins`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ bins: 2 }),
      frame: GRID_FRAME,
    });
    const colors = new Set(
      nodesOfKind(run.laid.nodes, 'rect').map((node) =>
        node.fill?.kind === 'solid' ? node.fill.color : '',
      ),
    );
    expect(colors.size).toBe(2);
  });

  it('marks a classed legend discrete', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, attrs: attrsOf({ bins: 2 }) });
    expect(run.encoded.legend?.ramp?.discrete).toBe(true);
  });

  it('leaves a continuous legend continuous', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.legend?.ramp?.discrete).toBeUndefined();
  });

  it('honours an explicit `domain`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ domain: [0, 100] }),
    });
    expect(run.encoded.legend?.ramp?.labels.map((label) => label.text)).toEqual(['0', '50', '100']);
  });

  it('labels the ends and the middle of a continuous ramp', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.legend?.ramp?.labels.map((label) => label.text)).toEqual(['1', '3.5', '6']);
  });

  it('labels the cuts of a classed ramp', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ colorScale: 'threshold', thresholds: [3, 5] }),
    });
    expect(run.encoded.legend?.ramp?.labels.map((label) => label.text)).toEqual([
      '1',
      '3',
      '5',
      '6',
    ]);
  });

  it('meets a diverging ramp at the neutral the theme names', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', -10],
      ['Tue', 'AM', 0],
      ['Wed', 'AM', 10],
    ]);
    const run = runChart(heatmapChart, table, {
      encoding: XYV,
      attrs: attrsOf({ colorScale: 'diverging' }),
      frame: GRID_FRAME,
    });
    const fills = nodesOfKind(run.laid.nodes, 'rect').map((node) =>
      node.fill?.kind === 'solid' ? node.fill.color : '',
    );
    expect(fills[1]).toBe(makeTheme().diverging.mid);
  });

  it('widens a diverging extent to reach an off-centre midpoint', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ colorScale: 'diverging', midpoint: 0 }),
    });
    const labels = run.encoded.legend?.ramp?.labels.map((label) => label.text) ?? [];
    expect(labels[0]).toBe('0');
    expect(labels.at(-1)).toBe('6');
  });

  it('reports MDV1502 for a colour scale it does not know, and draws anyway', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ colorScale: 'rainbow' }),
    });
    expect(codesOf(run.diagnostics)).toContain('MDV1502');
    expect(run.encoded.marks).toHaveLength(6);
  });

  it('reports MDV1502 for a scheme this theme has no ramp for, and draws anyway', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ scheme: 'viridis' }),
    });
    expect(codesOf(run.diagnostics)).toContain('MDV1502');
    expect(run.encoded.marks).toHaveLength(6);
  });

  it('says which hue was missing when a single hue is named for a diverging ramp', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ colorScale: 'diverging', scheme: 'sequential' }),
    });
    expect(codesOf(run.diagnostics)).toContain('MDV1502');
    expect(run.diagnostics.map((entry) => entry.message).join(' ')).toContain('needs two');
  });
});

describe('heatmap: legend (SPEC 8.9)', () => {
  it('always draws the ramp: it is the only thing that says what a colour means', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.legend?.position).toBe('right');
    expect((run.encoded.legend?.ramp?.stops.length ?? 0) >= 2).toBe(true);
  });

  it('drops it when the author said `legend: false`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ legend: false }),
    });
    expect(run.encoded.legend).toBeUndefined();
  });

  it('formats the ramp labels the way the cells are formatted', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { ...XYV, value: { field: 'value', format: '.1f' } },
    });
    expect(run.encoded.legend?.ramp?.labels.map((label) => label.text)).toEqual([
      '1.0',
      '3.5',
      '6.0',
    ]);
  });
});

describe('heatmap: geometry (SPEC 11.4)', () => {
  it('lays every cell inside the frame', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    for (const node of nodesOfKind(run.laid.nodes, 'rect')) {
      expect(node.x).toBeGreaterThanOrEqual(0);
      expect(node.y).toBeGreaterThanOrEqual(0);
      expect((node.x ?? 0) + (node.w ?? 0)).toBeLessThanOrEqual(360);
      expect((node.y ?? 0) + (node.h ?? 0)).toBeLessThanOrEqual(200);
    }
  });

  it('tiles the frame: bands of 120 × 100 less the gap', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    expect(rects.map((node) => [node.x, node.y, node.w, node.h])).toEqual([
      [1, 1, 118, 98],
      [121, 1, 118, 98],
      [241, 1, 118, 98],
      [1, 101, 118, 98],
      [121, 101, 118, 98],
      [241, 101, 118, 98],
    ]);
  });

  it('reads rows top to bottom, like the table they came from', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    // `AM` is the first row in the data, so it is the top band.
    expect(rects[0]?.y).toBe(1);
    expect(rects[3]?.y).toBe(101);
  });

  it('widens the cells when the gap is closed', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellGap: 0 }),
      frame: GRID_FRAME,
    });
    const rects = nodesOfKind(run.laid.nodes, 'rect');
    expect(rects.map((node) => [node.x, node.w])).toEqual([
      [0, 120],
      [120, 120],
      [240, 120],
      [0, 120],
      [120, 120],
      [240, 120],
    ]);
  });

  it('never lets a gap eat the cell it separates', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellGap: 24 }),
      frame: { x: 0, y: 0, width: 40, height: 20 },
    });
    for (const node of nodesOfKind(run.laid.nodes, 'rect')) {
      expect(node.w ?? 0).toBeGreaterThan(0);
      expect(node.h ?? 0).toBeGreaterThan(0);
    }
  });

  it('rounds the corners by `cellRadius`, capped by the cell', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellRadius: 8 }),
      frame: GRID_FRAME,
    });
    expect(nodesOfKind(run.laid.nodes, 'rect')[0]?.r).toBe(8);
  });

  it('produces no non-finite geometry', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('draws nothing into a frame with no room', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      frame: { x: 0, y: 0, width: 0, height: 0 },
    });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });
});

describe('heatmap: cell labels (SPEC 8.9)', () => {
  it('writes the value in the cell when it fits', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect(nodesOfKind(run.laid.nodes, 'text').map((node) => node.text)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  });

  it('leaves them out when the cell is too small to hold one', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      frame: { x: 0, y: 0, width: 60, height: 30 },
    });
    expect(nodesOfKind(run.laid.nodes, 'text')).toEqual([]);
  });

  it('writes them anyway when the author said `cellLabel: true`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellLabel: true }),
      frame: { x: 0, y: 0, width: 60, height: 30 },
    });
    expect(nodesOfKind(run.laid.nodes, 'text')).toHaveLength(6);
  });

  it('leaves them off when the author said `cellLabel: false`', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellLabel: false }),
      frame: GRID_FRAME,
    });
    expect(nodesOfKind(run.laid.nodes, 'text')).toEqual([]);
  });

  it('formats them with the format `cellLabel` carries', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ cellLabel: '.2f' }),
      frame: GRID_FRAME,
    });
    expect(nodesOfKind(run.laid.nodes, 'text')[0]?.text).toBe('1.00');
  });

  it('writes nothing in a cell with no value to write', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Tue', 'AM', null],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(nodesOfKind(run.laid.nodes, 'text').map((node) => node.text)).toEqual(['1']);
  });

  it('centres the label in its cell', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    const label = nodesOfKind(run.laid.nodes, 'text')[0];
    expect([label?.x, label?.y]).toEqual([60, 50]);
    expect(label?.anchor).toBe('middle');
    expect(label?.baseline).toBe('middle');
  });
});

describe('heatmap: hit regions (SPEC 12.4)', () => {
  it('gives one region per cell', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect(run.laid.hits).toHaveLength(6);
  });

  it('covers the cell it answers for', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect([
      run.laid.hits[0]?.x,
      run.laid.hits[0]?.y,
      run.laid.hits[0]?.w,
      run.laid.hits[0]?.h,
    ]).toEqual([1, 1, 118, 98]);
  });

  it('reads out both keys and the measure, the measure emphasised', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect(run.laid.hits[0]?.readout.map((entry) => [entry.label, entry.value])).toEqual([
      ['Day', 'Mon'],
      ['Hour', 'AM'],
      ['Value', '1'],
    ]);
    expect(run.laid.hits[0]?.readout.filter((entry) => entry.emphasis === true)).toHaveLength(1);
  });

  it('says so when the cell has no value', () => {
    const table = makeTable(FIELDS, [['Mon', 'AM', null]]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(run.laid.hits[0]?.readout.at(-1)?.value).toBe('—');
  });

  it('answers once for a slot two rows landed in', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Mon', 'AM', 9],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(run.laid.hits).toHaveLength(1);
    expect(run.laid.hits[0]?.readout.at(-1)?.value).toBe('9');
  });

  it('points each region back at a row of the table', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV, frame: GRID_FRAME });
    expect(run.laid.hits.map((hit) => hit.datumIndex)).toEqual([0, 2, 4, 1, 3, 5]);
  });
});

describe('heatmap: a11y table (SPEC 12.3)', () => {
  it('tabulates the three bound columns, one row per observation', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    const view = run.encoded.a11yTable;
    expect(view?.columns.map((column) => column.name)).toEqual(['Day', 'Hour', 'Value']);
    expect(view?.rows).toHaveLength(6);
    expect(view?.rows[0]).toEqual(['Mon', 'AM', '1']);
  });

  it('aligns the measure right and the keys left', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.encoded.a11yTable?.columns.map((column) => column.align)).toEqual([
      'left',
      'left',
      'right',
    ]);
  });

  it('captions the table with the block title', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: XYV,
      attrs: attrsOf({ title: 'Traffic by day' }),
    });
    expect(run.encoded.a11yTable?.caption).toBe('Traffic by day');
  });
});

describe('heatmap: description (SPEC 12.2)', () => {
  it('names the measure, both keys, the shape, and the extremes', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.description).toBe(
      'Heatmap. Value by day and hour, 2 rows × 3 columns. Values range from 1 at Mon, AM to 6 at Wed, PM. Highest: Wed, PM.',
    );
  });

  it('counts the grid it actually drew, not the rows it read', () => {
    const run = runChart(heatmapChart, gappy(), { encoding: XYV });
    expect(run.description).toContain('2 rows × 3 columns');
  });

  it('says so, without inventing data, when there is nothing to describe', () => {
    const run = runChart(heatmapChart, EMPTY_TABLE, { encoding: XYV });
    expect(run.description).toBe('');
  });
});

describe('heatmap: diagnostics', () => {
  it('reports MDV3000 when `x` is not bound', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { y: { field: 'hour' }, value: { field: 'value' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when `y` is not bound', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { x: { field: 'day' }, value: { field: 'value' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when `value` is not bound', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { x: { field: 'day' }, y: { field: 'hour' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when a channel names something that is not a column', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { ...XYV, x: { field: 'missing' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3001 when the measure is not quantitative', () => {
    const run = runChart(heatmapChart, grid(), {
      encoding: { ...XYV, value: { field: 'hour' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3001');
  });

  it('does not complain about a grid it can read', () => {
    const run = runChart(heatmapChart, grid(), { encoding: XYV });
    expect(run.diagnostics).toEqual([]);
  });
});

describe('heatmap: degenerate input', () => {
  it('draws nothing for an empty table and does not throw', () => {
    const run = runChart(heatmapChart, EMPTY_TABLE, { encoding: XYV });
    expect(run.encoded.marks).toEqual([]);
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('draws nothing when the columns exist but have no rows', () => {
    const run = runChart(heatmapChart, noRows(FIELDS), { encoding: XYV });
    expect(run.encoded.marks).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives a grid of one cell', () => {
    const table = makeTable(FIELDS, [['Mon', 'AM', 5]]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(run.encoded.marks).toHaveLength(1);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toHaveLength(1);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives a grid whose values are all the same', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 3],
      ['Tue', 'AM', 3],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    const fills = nodesOfKind(run.laid.nodes, 'rect').map((node) =>
      node.fill?.kind === 'solid' ? node.fill.color : '',
    );
    expect(new Set(fills).size).toBe(1);
  });

  it('survives an all-null measure', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', null],
      ['Tue', 'AM', null],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV, frame: GRID_FRAME });
    expect(run.encoded.marks).toHaveLength(2);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toEqual([]);
    expect(run.laid.hits).toHaveLength(2);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('skips the rows it cannot read and keeps the rest', () => {
    const table = makeTable(FIELDS, [
      ['Mon', 'AM', 1],
      ['Tue', null, 4],
      ['Wed', 'AM', 3],
    ]);
    const run = runChart(heatmapChart, table, { encoding: XYV });
    expect(run.encoded.marks).toHaveLength(2);
    expect(run.encoded.droppedRows).toBe(1);
  });
});

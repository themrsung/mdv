/**
 * `waterfall` (SPEC 8.12), asserted numerically.
 *
 * The fixture is one five-step walk whose numbers are chosen so that every
 * pixel this suite names is a whole one:
 *
 *   - the frame is **520** px wide rather than the harness's 400, because a band
 *     scale divides the width by `n − paddingInner + 2·paddingOuter` = 5.2 and
 *     only a multiple of 5.2 gives a round step. At 520 the step is 100, the
 *     band 80, and the five centres land on 60, 160, 260, 360, 460;
 *   - the drawn bar is **not** the band: the theme caps a bar at 24 px
 *     (`marks.bar.maxThickness`), so each bar is 24 px wide and its left edge
 *     sits 12 px before its centre;
 *   - the value domain is pinned to `[0, 200]` over a 200 px frame, so one unit
 *     is one pixel and `y = 200 − value`. Both ends are pinned, which is also
 *     what keeps `nice` from moving the top out from under the arithmetic.
 *
 * What the suite leans on:
 *
 *   - a waterfall is a *walk*: each bar floats between the running total before
 *     the step and the running total after it, so a test that only measured bar
 *     heights would pass on a chart that had drawn every step from the baseline;
 *   - a subtotal row is the exception — it is drawn from the baseline to the
 *     running total, and its own change cell is never read;
 *   - direction is a status color, not a series slot, and it is stated in words
 *     as well, because the sign has to survive a greyscale print (SPEC 11.6).
 */

import { describe, expect, it } from 'vitest';
import { STATUS_PALETTE, type BarMark, type Rect, type Table } from '@mdv/core';
import { waterfallChart } from '../src/waterfall.js';
import {
  EMPTY_TABLE,
  type ChartRun,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const FIELDS = [
  ['step', 'category'],
  ['change', 'number'],
  ['total', 'string'],
] as const;

/** A step is 100 px of width; a unit of value is 1 px of height. */
const FRAME: Rect = { x: 0, y: 0, width: 520, height: 200 };

/**
 * Opening 100, +60, −30, +20, and a subtotal that closes at 150.
 *
 * The closing row's own `change` cell is `0` and would be a lie if it were read:
 * the subtotal is the walk so far, not a step of its own.
 */
function walk(): Table {
  return makeTable(FIELDS, [
    ['Opening', 100, ''],
    ['New', 60, ''],
    ['Churn', -30, ''],
    ['Expansion', 20, ''],
    ['Closing', 0, 'yes'],
  ]);
}

function runWalk(
  table: Table = walk(),
  attrs: Readonly<Record<string, unknown>> = { total: 'total' },
): ChartRun<BarMark> {
  return runChart(waterfallChart, table, {
    encoding: {
      category: { field: 'step' },
      value: { field: 'change', scale: { domain: [0, 200] } },
    },
    attrs: attrsOf(attrs),
    frame: FRAME,
  });
}

/** `[x, y, w, h]` for each drawn bar, in document order. */
function barBoxes(run: ChartRun<BarMark>): number[][] {
  return nodesOfKind(run.laid.nodes, 'rect')
    .filter((node) => node.cls === 'mdv-mark mdv-mark-bar')
    .map((node) => [node.x, node.y, node.w, node.h]);
}

/** `[x1, y1, x2, y2]` for each connector, in document order. */
function connectors(run: ChartRun<BarMark>): number[][] {
  return nodesOfKind(run.laid.nodes, 'line')
    .filter((node) => node.cls === 'mdv-mark mdv-mark-connector')
    .map((node) => [node.x1, node.y1, node.x2, node.y2]);
}

describe('waterfall geometry (SPEC 8.12)', () => {
  it('floats every step between the total before it and the total after', () => {
    // Opening 0→100, New 100→160, Churn 160→130, Expansion 130→150.
    expect(barBoxes(runWalk()).slice(0, 4)).toEqual([
      [48, 100, 24, 100],
      [148, 40, 24, 60],
      [248, 40, 24, 30],
      [348, 50, 24, 20],
    ]);
  });

  it('draws a subtotal from the baseline, because it is not a step', () => {
    // Closing is the walk so far: 0→150, not the `0` its own row carries.
    expect(barBoxes(runWalk())[4]).toEqual([448, 50, 24, 150]);
  });

  it('never lets the change cell on a subtotal row move the total', () => {
    const lying = makeTable(FIELDS, [
      ['Opening', 100, ''],
      ['New', 60, ''],
      ['Churn', -30, ''],
      ['Expansion', 20, ''],
      ['Closing', 9999, 'yes'],
    ]);
    expect(barBoxes(runWalk(lying))[4]).toEqual([448, 50, 24, 150]);
  });

  it('connects each bar to the next at the level the walk left it on', () => {
    expect(connectors(runWalk())).toEqual([
      [72, 100, 148, 100],
      [172, 40, 248, 40],
      [272, 70, 348, 70],
      [372, 50, 448, 50],
    ]);
  });

  it('drops the connectors when the author turns them off', () => {
    const run = runWalk(walk(), { total: 'total', connector: false });
    expect(connectors(run)).toEqual([]);
    expect(barBoxes(run)).toHaveLength(5);
  });

  it('keeps a step that changed nothing visible, at one pixel', () => {
    const flat = makeTable(FIELDS, [
      ['Opening', 40, ''],
      ['Flat', 0, ''],
      ['Closing', 0, 'yes'],
    ]);
    const boxes = barBoxes(runWalk(flat));
    expect(boxes).toHaveLength(3);
    // 40 → 40 is zero pixels of height; a step that happened must still be seen.
    expect(boxes[1]?.[3]).toBe(1);
    expect(boxes[1]?.[1]).toBe(160);
  });
});

describe('waterfall colour and words (SPEC 8.12, 11.6)', () => {
  function fills(run: ChartRun<BarMark>): unknown[] {
    return nodesOfKind(run.laid.nodes, 'rect')
      .filter((node) => node.cls === 'mdv-mark mdv-mark-bar')
      .map((node) => node.fill);
  }

  it('reads direction from the status palette, not from a series slot', () => {
    const run = runWalk();
    const seriesColor = run.encoded.series?.[0]?.color;
    expect(fills(run)).toEqual([
      { kind: 'solid', color: STATUS_PALETTE.good },
      { kind: 'solid', color: STATUS_PALETTE.good },
      { kind: 'solid', color: STATUS_PALETTE.critical },
      { kind: 'solid', color: STATUS_PALETTE.good },
      // A total is not a direction: nothing went right or wrong.
      { kind: 'solid', color: seriesColor },
    ]);
  });

  it('lets the author name the two directions', () => {
    const run = runWalk(walk(), {
      total: 'total',
      increaseColor: '#112233',
      decreaseColor: '#332211',
    });
    expect(fills(run).slice(0, 3)).toEqual([
      { kind: 'solid', color: '#112233' },
      { kind: 'solid', color: '#112233' },
      { kind: 'solid', color: '#332211' },
    ]);
  });

  it('says the direction in words in the readout, with the sign spelled out', () => {
    const run = runWalk();
    const rows = run.laid.hits[2]?.readout ?? [];
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Step', 'Churn'],
      ['Decrease', '-30'],
      ['Running total', '130'],
    ]);
  });

  it('gives a subtotal a readout that stops at the total', () => {
    const run = runWalk();
    const rows = run.laid.hits[4]?.readout ?? [];
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Step', 'Closing'],
      ['Total', '150'],
    ]);
  });

  it('writes `0` rather than `+0` for the step that did nothing', () => {
    const flat = makeTable(FIELDS, [
      ['Opening', 40, ''],
      ['Flat', 0, ''],
      ['Closing', 0, 'yes'],
    ]);
    const rows = runWalk(flat).laid.hits[1]?.readout ?? [];
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ['Step', 'Flat'],
      ['Increase', '0'],
      ['Running total', '40'],
    ]);
  });

  it('names where the walk ends, and how it got there', () => {
    const description = runWalk().description ?? '';
    expect(description).toContain('Waterfall chart');
    expect(description).toContain('5 steps');
    expect(description).toContain('Ends at 150 after 3 increases and 1 decrease');
  });
});

describe('waterfall table view (SPEC 12.3)', () => {
  it('adds the running total and the direction the document does not hold', () => {
    const table = runWalk().encoded.a11yTable;
    expect(table?.columns.map((column) => column.name)).toEqual([
      'Step',
      'Direction',
      'Change',
      'Running total',
    ]);
    expect(table?.rows).toEqual([
      ['Opening', 'Increase', '+100', '100'],
      ['New', 'Increase', '+60', '160'],
      ['Churn', 'Decrease', '-30', '130'],
      ['Expansion', 'Increase', '+20', '150'],
      ['Closing', 'Total', '', '150'],
    ]);
  });

  it('captions the table with the block title', () => {
    const run = runWalk(walk(), { total: 'total', title: 'Net new revenue' });
    expect(run.encoded.a11yTable?.caption).toBe('Net new revenue');
  });

  it('reports the total column as a column it read, not an attribute', () => {
    expect(runWalk().encoded.boundColumns?.map((column) => column.name)).toEqual([
      'step',
      'change',
      'total',
    ]);
  });
});

describe('waterfall subtotal flag (SPEC 8.12)', () => {
  it('accepts a subtotal written the way an author writes one', () => {
    for (const flag of ['yes', 'y', 'true', '1', 'total', 'subtotal', true]) {
      const table = makeTable(FIELDS, [
        ['Opening', 100, ''],
        ['Closing', 0, flag],
      ]);
      // The subtotal reaches the running total: 0 → 100.
      expect(barBoxes(runWalk(table))[1]?.[3]).toBe(100);
    }
  });

  it('treats an empty flag cell as a step, so a blank column changes nothing', () => {
    const table = makeTable(FIELDS, [
      ['Opening', 100, ''],
      ['New', 60, 'no'],
    ]);
    const withColumn = runWalk(table);
    const withoutColumn = runWalk(table, {});
    expect(barBoxes(withColumn)).toEqual(barBoxes(withoutColumn));
    expect(withoutColumn.encoded.boundColumns?.map((column) => column.name)).toEqual([
      'step',
      'change',
    ]);
  });
});

describe('waterfall degradation (SPEC 15.2, 6.5)', () => {
  it('asks for the two channels it cannot draw without', () => {
    const run = runChart(waterfallChart, walk(), { frame: FRAME });
    expect(codesOf(run.validation)).toEqual(['MDV3000', 'MDV3000']);
    expect(run.laid.nodes).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('names a field that is not a column', () => {
    const run = runChart(waterfallChart, walk(), {
      encoding: { category: { field: 'step' }, value: { field: 'profit' } },
      frame: FRAME,
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('drops a row it cannot measure and says how many', () => {
    const gappy = makeTable(FIELDS, [
      ['Opening', 100, ''],
      ['Missing', Number.NaN, ''],
      ['Closing', 0, 'yes'],
    ]);
    const run = runWalk(gappy);
    expect(run.encoded.droppedRows).toBe(1);
    expect(barBoxes(run)).toHaveLength(2);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives a table with columns but no rows', () => {
    const run = runWalk(noRows(FIELDS));
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Waterfall chart with no data.');
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives the empty table', () => {
    const run = runWalk(EMPTY_TABLE);
    expect(run.laid.nodes).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

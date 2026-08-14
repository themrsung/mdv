/**
 * `treemap` (SPEC 8.12), asserted numerically.
 *
 * Two fixtures, both totalling 400 so that every share is a round percentage
 * and every rectangle this suite names is a whole pixel:
 *
 *   - **flat** — four budget items listed alphabetically: Power 100, Print 40,
 *     Rent 200, Travel 60. The document order is deliberately *not* the value
 *     order, because the two orders answer different questions: squarify sizes
 *     by value, and the scene is painted by document position. In the harness's
 *     400 × 200 frame the squarified layout is Rent 200 × 200 at the origin,
 *     Power 100 × 200 beside it, and the tail — Travel and Print — stacked in
 *     the last 100 px as 100 × 120 over 100 × 80. That stack *is* the algorithm:
 *     a fourth vertical strip would have been 20 px wide and unreadable;
 *   - **nested** — the same four items under two groups, Fixed (Power 50,
 *     Rent 150) and Variable (Travel 120, Print 80). The groups are 200 each, so
 *     they halve the frame; the theme's 2 px surface gap and a 17 px header band
 *     (13 px of line plus a gap above and below) inset each group's children to
 *     196 × 181, which the parts divide as 147 / 49 and 117.6 / 78.4.
 *
 * What the suite leans on:
 *
 *   - **area is the magnitude, and nothing else is**. Every geometry assertion
 *     is checkable against `share × 80 000 px²`, and one test does exactly that
 *     across all three tilings, so a layout that drifted would fail on the
 *     arithmetic rather than on a remembered rectangle;
 *   - **a group is the sum of its parts** (decision 1). `Fixed` has no row of
 *     its own; it exists because two rows named it, it is worth what they are
 *     worth, and it is not a target — the parts are what a reader points at;
 *   - **colour names the branch, not the value** (SPEC 11.2 rule 1). Slots go
 *     out in document order, so `Rent`, the largest tile, wears the *third*
 *     slot, and both parts of `Fixed` wear the group's hue;
 *   - **a label is drawn only where it fits, uncropped** (SPEC 11.5). Three
 *     separate refusals are tested — the area floor, a name wider than its own
 *     tile, and a tile too short for a second line — because each one is a
 *     different reason and half a word inside a rectangle is worse than none;
 *   - the numbers reach the reader through the table view and the description,
 *     since a treemap has no axis to read anything off.
 */

import { describe, expect, it } from 'vitest';
import { type NodeMark, type Table } from '@mdv/core';
import { treemapChart, type TreemapEncodeResult } from '../src/treemap.js';
import {
  EMPTY_TABLE,
  FRAME,
  type ChartRun,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const FLAT_FIELDS = [
  ['item', 'category'],
  ['spend', 'number'],
] as const;

const NESTED_FIELDS = [
  ['item', 'category'],
  ['group', 'category'],
  ['spend', 'number'],
] as const;

const ENCODING = { category: { field: 'item' }, value: { field: 'spend' } };

/** Four items, alphabetical — an order that is not the order of their sizes. */
function budget(): Table {
  return makeTable(FLAT_FIELDS, [
    ['Power', 100],
    ['Print', 40],
    ['Rent', 200],
    ['Travel', 60],
  ]);
}

/** The same 400, sorted into two groups that neither row spells out. */
function ledger(): Table {
  return makeTable(NESTED_FIELDS, [
    ['Power', 'Fixed', 50],
    ['Rent', 'Fixed', 150],
    ['Travel', 'Variable', 120],
    ['Print', 'Variable', 80],
  ]);
}

function runTreemap(
  table: Table = budget(),
  options: Parameters<typeof runChart>[2] = {},
): ChartRun<NodeMark> {
  return runChart(treemapChart, table, { encoding: ENCODING, frame: FRAME, ...options });
}

function runNested(attrs: Record<string, unknown> = {}): ChartRun<NodeMark> {
  return runTreemap(ledger(), { attrs: attrsOf({ parent: 'group', ...attrs }) });
}

/** The per-mark state a treemap carries from `encode` to `layout`. */
function planOf(run: ChartRun<NodeMark>): TreemapEncodeResult['state'] {
  return (run.encoded as TreemapEncodeResult).state;
}

/** Every drawn rectangle, in paint order, as `[x, y, w, h]`. */
function boxes(run: ChartRun<NodeMark>): number[][] {
  return nodesOfKind(run.laid.nodes, 'rect').map((node) => [node.x, node.y, node.w, node.h]);
}

function textsOf(run: ChartRun<NodeMark>, cls: string): string[] {
  return nodesOfKind(run.laid.nodes, 'text')
    .filter((node) => node.cls === cls)
    .map((node) => node.text);
}

const LEAF_LABEL = 'mdv-label mdv-treemap-label';
const LEAF_VALUE = 'mdv-label mdv-treemap-value';
const GROUP_LABEL = 'mdv-label mdv-treemap-group-label';

// ─────────────────────────────────────────────────────────────────────────────

describe('treemap geometry (SPEC 8.12)', () => {
  it('gives every row a rectangle whose area is its share of the frame', () => {
    // The whole claim of the chart, and the only one that must survive a change
    // of tiling: 400 units over 80 000 px² is 200 px² per unit, whichever way
    // the rectangles are packed.
    for (const tile of ['squarify', 'slice', 'dice']) {
      const run = runTreemap(budget(), { attrs: attrsOf({ tile }) });
      const areas = nodesOfKind(run.laid.nodes, 'rect').map((node) => node.w * node.h);
      expect(areas).toEqual([20_000, 8_000, 40_000, 12_000]);
      expect(areas.reduce((sum, area) => sum + area, 0)).toBe(FRAME.width * FRAME.height);
    }
  });

  it('squarifies by value, and paints in document order', () => {
    // Rent is the biggest tile and the third row. Both facts are visible here:
    // it takes the left half, and it is painted third.
    const run = runTreemap();
    expect(textsOf(run, LEAF_LABEL)).toEqual(['Power', 'Print', 'Rent', 'Travel']);
    expect(boxes(run)).toEqual([
      [200, 0, 100, 200],
      [300, 120, 100, 80],
      [0, 0, 200, 200],
      [300, 0, 100, 120],
    ]);
  });

  it('stacks the tail of the list rather than running it off the edge', () => {
    // Travel and Print share the last 100 px as a column of two. Laid out as a
    // fourth and fifth strip they would have been 30 px and 20 px wide.
    const run = runTreemap();
    const [travel, print] = [boxes(run)[3], boxes(run)[1]];
    expect(travel).toEqual([300, 0, 100, 120]);
    expect(print).toEqual([300, 120, 100, 80]);
  });

  it('slices down one axis and dices across it, keeping document order', () => {
    // `slice` and `dice` are for when the order *is* the data, so neither sorts.
    expect(boxes(runTreemap(budget(), { attrs: attrsOf({ tile: 'slice' }) }))).toEqual([
      [0, 0, 400, 50],
      [0, 50, 400, 20],
      [0, 70, 400, 100],
      [0, 170, 400, 30],
    ]);
    expect(boxes(runTreemap(budget(), { attrs: attrsOf({ tile: 'dice' }) }))).toEqual([
      [0, 0, 100, 200],
      [100, 0, 40, 200],
      [140, 0, 200, 200],
      [340, 0, 60, 200],
    ]);
  });

  it('names an unreadable tiling and draws the default one', () => {
    const run = runTreemap(budget(), { attrs: attrsOf({ tile: 'mosaic' }) });
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1502']);
    expect(planOf(run).tiling).toBe('squarify');
    expect(boxes(run)).toEqual(boxes(runTreemap()));
  });

  it('has no axes to draw, and carries the extent for everything downstream', () => {
    const run = runTreemap();
    expect(run.encoded.axes).toEqual([]);
    expect(run.encoded.scales?.y?.domain).toEqual([0, 400]);
  });

  it('draws nothing at all in a frame with no usable area', () => {
    const run = runTreemap(budget(), { frame: { x: 0, y: 0, width: 400, height: 0 } });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });
});

describe('treemap hierarchy (SPEC 8.12, 6.1)', () => {
  it('makes a group out of a column, and makes it worth the sum of its parts', () => {
    // Neither `Fixed` nor `Variable` has a row. Demanding one before the chart
    // will draw would be pedantry: the cells already say where each part sits.
    const plan = planOf(runNested());
    expect(plan.tiles.map((tile) => [tile.label, tile.depth, tile.value])).toEqual([
      ['Fixed', 0, 200],
      ['Power', 1, 50],
      ['Rent', 1, 150],
      ['Variable', 0, 200],
      ['Travel', 1, 120],
      ['Print', 1, 80],
    ]);
    expect(plan.total).toBe(400);
    expect(plan.roots).toEqual([0, 3]);
  });

  it('draws each group before the parts that sit on top of it', () => {
    // The 17 px header and the 2 px gap come out of the group's rectangle
    // first; 196 × 181 is what is left for the parts to divide.
    expect(boxes(runNested())).toEqual([
      [0, 0, 200, 200],
      [149, 17, 49, 181],
      [2, 17, 147, 181],
      [200, 0, 200, 200],
      [202, 17, 117.6, 181],
      [319.6, 17, 78.4, 181],
    ]);
  });

  it('takes a header band only from a group that can spare it', () => {
    const run = runNested();
    expect(textsOf(run, GROUP_LABEL)).toEqual(['Fixed', 'Variable']);
    const header = nodesOfKind(run.laid.nodes, 'text').find((node) => node.cls === GROUP_LABEL);
    // Baseline is the middle of the 13 px line, one 2 px gap below the top.
    expect([header?.x, header?.y]).toEqual([2, 8.5]);
  });

  it('points the reader at the parts, never at the group holding them', () => {
    const run = runNested();
    expect(run.laid.hits.map((hit) => [hit.x, hit.y, hit.w, hit.h])).toEqual([
      [149, 17, 49, 181],
      [2, 17, 147, 181],
      [202, 17, 117.6, 181],
      [319.6, 17, 78.4, 181],
    ]);
    expect(run.laid.hits.map((hit) => hit.datumIndex)).toEqual([0, 1, 2, 3]);
    expect(run.laid.hits.map((hit) => hit.seriesId)).toEqual([
      'Fixed',
      'Fixed',
      'Variable',
      'Variable',
    ]);
  });

  it('tells a part what it is inside, and how much of it it is', () => {
    const rent = planOf(runNested()).tiles[2];
    expect(rent?.readout).toEqual([
      { label: 'Rent', value: '150', swatch: '#111180', emphasis: true },
      { label: 'Within', value: 'Fixed' },
      { label: 'Share of Fixed', value: '75.0%' },
      { label: 'Share of total', value: '37.5%' },
    ]);
  });

  it('sums two rows that name the same part into one tile', () => {
    // A picture cannot show one name twice and mean two things by it.
    const run = runTreemap(
      makeTable(FLAT_FIELDS, [
        ['Rent', 150],
        ['Power', 100],
        ['Rent', 50],
      ]),
    );
    expect(planOf(run).tiles.map((tile) => [tile.label, tile.value])).toEqual([
      ['Rent', 200],
      ['Power', 100],
    ]);
  });

  it('stops at the depth the author asked for, and draws the groups whole', () => {
    // `depth: 1` is a request for the top level, so the groups become the tiles:
    // full-strength fill, their own labels, and their own hit regions.
    const run = runNested({ depth: 1 });
    expect(boxes(run)).toEqual([
      [0, 0, 200, 200],
      [200, 0, 200, 200],
    ]);
    expect(textsOf(run, GROUP_LABEL)).toEqual([]);
    expect(textsOf(run, LEAF_LABEL)).toEqual(['Fixed', 'Variable']);
    expect(run.laid.hits).toHaveLength(2);
  });

  it('names the parent column as a bound column, so a change to it redraws', () => {
    expect(runNested().encoded.boundColumns?.map((column) => column.name)).toEqual([
      'item',
      'group',
      'spend',
    ]);
    expect(runTreemap().encoded.boundColumns?.map((column) => column.name)).toEqual([
      'item',
      'spend',
    ]);
  });
});

describe('treemap colour (SPEC 11.2, 11.3)', () => {
  it('gives a slot to each branch in document order, not in size order', () => {
    // Rent is the largest tile and takes the third slot, because colour follows
    // the entity and the entity was written third.
    const run = runTreemap();
    expect(run.encoded.series.map((series) => [series.id, series.slot, series.color])).toEqual([
      ['Power', 0, '#111180'],
      ['Print', 1, '#118011'],
      ['Rent', 2, '#801111'],
      ['Travel', 3, '#118080'],
    ]);
  });

  it('dresses every part of a branch in the branch hue', () => {
    const plan = planOf(runNested());
    expect(plan.tiles.map((tile) => tile.color)).toEqual([
      '#111180',
      '#111180',
      '#111180',
      '#118011',
      '#118011',
      '#118011',
    ]);
    expect(runNested().encoded.series.map((series) => series.id)).toEqual(['Fixed', 'Variable']);
  });

  it('paints a subdivided group faintly, and a drawn tile at full strength', () => {
    // The group shows only in its padding and its header band. At full strength
    // it would compete with the parts it is holding.
    const drawn = nodesOfKind(runNested().laid.nodes, 'rect');
    expect(drawn[0]?.fill).toEqual({ kind: 'solid', color: '#111180', opacity: 0.28 });
    expect(drawn[0]?.cls).toBe('mdv-mark mdv-mark-treemap mdv-mark-group');
    expect(drawn[1]?.fill).toEqual({ kind: 'solid', color: '#111180' });
    expect(drawn[1]?.cls).toBe('mdv-mark mdv-mark-treemap');
  });

  it('lists the branches in the legend, not every tile in the tree', () => {
    expect(runNested().encoded.legend?.entries.map((entry) => entry.label)).toEqual([
      'Fixed',
      'Variable',
    ]);
  });
});

describe('treemap labels (SPEC 11.5)', () => {
  it('writes the name and then the value, both inside the tile', () => {
    const run = runTreemap();
    const rent = nodesOfKind(run.laid.nodes, 'text').filter((node) => node.x === 2);
    // 2 px of padding in, and the two lines are 11.05 px apart.
    expect(rent.map((node) => [node.cls, node.text, node.y])).toEqual([
      [LEAF_LABEL, 'Rent', 7.525],
      [LEAF_VALUE, '200', 18.575],
    ]);
    expect(rent[0]?.fill).toEqual({ kind: 'solid', color: '#ffffff' });
  });

  it('does not attempt a label below the area floor', () => {
    // 15 000 px² leaves Rent and Power labelled and drops the two small tiles,
    // whose names would have fitted: the floor is a judgement about reading, not
    // about measurement.
    const run = runTreemap(budget(), { attrs: attrsOf({ labelMinArea: 15_000 }) });
    expect(textsOf(run, LEAF_LABEL)).toEqual(['Power', 'Rent']);
  });

  it('drops a name that is wider than the tile it names', () => {
    const run = runTreemap(
      makeTable(FLAT_FIELDS, [
        ['Power', 100],
        ['Print and postage', 40],
        ['Rent', 200],
        ['Travel', 60],
      ]),
    );
    // The tile is 100 × 80 — well over the floor, and 16 px too narrow.
    expect(textsOf(run, LEAF_LABEL)).toEqual(['Power', 'Rent', 'Travel']);
    expect(textsOf(run, LEAF_VALUE)).toEqual(['100', '200', '60']);
  });

  it('keeps the name when only the second line will not fit', () => {
    // Sliced, Print is 400 × 20: one 11.05 px line and its padding fit, two do
    // not. A name without its value still identifies the area it labels.
    const run = runTreemap(budget(), { attrs: attrsOf({ tile: 'slice' }) });
    expect(textsOf(run, LEAF_LABEL)).toEqual(['Power', 'Print', 'Rent', 'Travel']);
    expect(textsOf(run, LEAF_VALUE)).toEqual(['100', '200', '60']);
  });

  it('leaves the tiles bare when the author turns labels off', () => {
    const run = runNested({ label: false });
    expect(nodesOfKind(run.laid.nodes, 'text')).toEqual([]);
    // No header band either, so the parts get the whole rectangle back.
    expect(boxes(run)[1]).toEqual([149, 2, 49, 196]);
  });
});

describe('treemap readout and words (SPEC 12.3)', () => {
  it('spells the hierarchy out as a column in the table view', () => {
    const run = runNested();
    expect(run.encoded.a11yTable?.columns.map((column) => column.name)).toEqual([
      'Item',
      'Group',
      'Spend',
      'Share',
    ]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Fixed', '', '200', '50.0%'],
      ['Power', 'Fixed', '50', '12.5%'],
      ['Rent', 'Fixed', '150', '37.5%'],
      ['Variable', '', '200', '50.0%'],
      ['Travel', 'Variable', '120', '30.0%'],
      ['Print', 'Variable', '80', '20.0%'],
    ]);
  });

  it('drops the parent column from a table that has no hierarchy', () => {
    const run = runTreemap();
    expect(run.encoded.a11yTable?.columns.map((column) => column.name)).toEqual([
      'Item',
      'Spend',
      'Share',
    ]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Power', '100', '25.0%'],
      ['Print', '40', '10.0%'],
      ['Rent', '200', '50.0%'],
      ['Travel', '60', '15.0%'],
    ]);
  });

  it('counts the tiles, the groups, and the biggest part', () => {
    expect(runTreemap().description).toBe(
      'Treemap. Spend by item, 4 tiles. They total 400. Largest: Rent, 200 (50.0% of the whole).',
    );
    expect(runNested().description).toBe(
      'Treemap. Spend by item, 4 tiles in 2 groups. They total 400. Largest: Rent, 150 (37.5% of the whole).',
    );
  });
});

describe('treemap degradation (SPEC 15.2, 6.5)', () => {
  it('asks for the two channels it cannot draw without', () => {
    const run = runChart(treemapChart, budget(), { encoding: {}, frame: FRAME });
    expect(codesOf(run.validation)).toEqual(['MDV3000', 'MDV3000']);
  });

  it('names a field that is not a column, for each of the three it reads', () => {
    const missing = runChart(treemapChart, budget(), {
      encoding: { category: { field: 'part' }, value: { field: 'cost' } },
      frame: FRAME,
    });
    expect(codesOf(missing.validation)).toEqual(['MDV3000', 'MDV3000']);

    const parent = runTreemap(budget(), { attrs: attrsOf({ parent: 'group' }) });
    expect(codesOf(parent.validation)).toEqual(['MDV3000']);
    expect(parent.validation[0]?.message).toContain('`parent` names `group`');
  });

  it('refuses a value channel it cannot measure', () => {
    const run = runChart(treemapChart, ledger(), {
      encoding: { category: { field: 'group' }, value: { field: 'item' } },
      frame: FRAME,
    });
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
    expect(run.validation[0]?.message).toBe('`value` is bound to `item`, which is category');
  });

  it('sends a negative area to a chart that has a baseline', () => {
    const run = runTreemap(
      makeTable(FLAT_FIELDS, [
        ['Power', 100],
        ['Print', -40],
        ['Rent', 200],
      ]),
    );
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
    expect(run.validation[0]?.message).toBe('`spend` contains negative values');
    // Said once, and the rest of the document still draws.
    expect(run.encoded.droppedRows).toBe(1);
    expect(planOf(run).tiles.map((tile) => tile.label)).toEqual(['Power', 'Rent']);
  });

  it('breaks a parent chain that closes on itself, and draws what is left', () => {
    const run = runTreemap(
      makeTable(NESTED_FIELDS, [
        ['Power', 'Rent', 100],
        ['Rent', 'Power', 200],
      ]),
      { attrs: attrsOf({ parent: 'group' }) },
    );
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV3070']);
    expect(run.encodeDiagnostics[0]?.message).toBe(
      'One row names a `parent` that is inside its own branch',
    );
    // Rent keeps the outermost rectangle; the loop is cut at the second row.
    expect(planOf(run).tiles.map((tile) => [tile.label, tile.depth])).toEqual([
      ['Rent', 0],
      ['Power', 1],
    ]);
  });

  it('drops a row whose value is not a number, and says how many', () => {
    const run = runTreemap(
      makeTable(FLAT_FIELDS, [
        ['Power', 100],
        ['Print', null],
        ['Rent', 'lots'],
        ['Travel', 60],
      ]),
    );
    expect(run.encoded.droppedRows).toBe(2);
    expect(planOf(run).tiles.map((tile) => tile.label)).toEqual(['Power', 'Travel']);
  });

  it('does not turn a missing category into a tile called "—"', () => {
    // `formatValue` renders an empty cell as an em dash because a table view has
    // to put something in the gap. Keying off that would collect every unnamed
    // row into one tile named after the dash, sized by their total.
    const run = runTreemap(
      makeTable(FLAT_FIELDS, [
        ['Power', 100],
        [null, 40],
        ['Rent', 200],
      ]),
    );
    expect(planOf(run).tiles.map((tile) => tile.label)).toEqual(['Power', 'Rent']);
    expect(run.encoded.droppedRows).toBe(1);
    expect(planOf(run).total).toBe(300);
  });

  it('leaves a row with no parent at the top level, not in a group called "—"', () => {
    const run = runTreemap(
      makeTable(NESTED_FIELDS, [
        ['Power', 'Fixed', 50],
        ['Rent', null, 150],
      ]),
      { attrs: attrsOf({ parent: 'group' }) },
    );
    expect(planOf(run).tiles.map((tile) => [tile.label, tile.depth])).toEqual([
      ['Rent', 0],
      ['Fixed', 0],
      ['Power', 1],
    ]);
  });

  it('survives a table with columns but no rows', () => {
    const run = runTreemap(noRows(FLAT_FIELDS));
    expect(run.laid.nodes).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.description).toBe('Treemap with no data.');
  });

  it('survives the empty table', () => {
    const run = runChart(treemapChart, EMPTY_TABLE, { encoding: ENCODING, frame: FRAME });
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Treemap with no data.');
  });

  it('never produces a number that is not a number', () => {
    expect(nonFiniteNumbers(runTreemap().laid)).toEqual([]);
    expect(nonFiniteNumbers(runNested().laid)).toEqual([]);
    expect(nonFiniteNumbers(runTreemap(noRows(FLAT_FIELDS)).laid)).toEqual([]);
    expect(nonFiniteNumbers(runTreemap(makeTable(FLAT_FIELDS, [['Power', 0]])).laid)).toEqual([]);
  });
});

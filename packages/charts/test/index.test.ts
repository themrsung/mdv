/**
 * Registration (SPEC 16.1) and graceful degradation (SPEC 15.2).
 *
 * This file asserts the *shape of the package*: which types exist, at which
 * conformance level, and what a reader gets when a document asks for a type this
 * reader cannot draw. It deliberately does not build a real registry — that is
 * core's object, and a test that constructs one would be testing core's
 * resolution rules rather than this package's registrations.
 */

import { describe, expect, it } from 'vitest';
import type { ChartType } from '@mdv/core';
import {
  LEVEL_1_TYPE_NAMES,
  LEVEL_2_TYPE_NAMES,
  LEVEL_3_TYPE_NAMES,
  UNIMPLEMENTED_TYPES,
  builtinChartTypes,
  chartTypesForLevel,
  createUnimplementedChartType,
  level1ChartTypes,
} from '../src/index.js';
import { codesOf, makeTable, nodesOfKind, nonFiniteNumbers, runChart } from './harness.js';

/** A hand-built OHLC table — the data a Level 2 document would bring. */
function prices() {
  return makeTable(
    [
      ['day', 'string'],
      ['open', 'number'],
      ['high', 'number'],
      ['low', 'number'],
      ['close', 'number'],
    ],
    [
      ['Mon', 10, 14, 9, 13],
      ['Tue', 13, 15, 12, 12],
    ],
  );
}

function byName(name: string): ChartType {
  const found = builtinChartTypes.find((type) => type.name === name);
  if (found === undefined) throw new Error(`no chart type named ${name}`);
  return found;
}

describe('the Level 1 set (SPEC 16.1)', () => {
  it('implements all eight named types', () => {
    expect([...LEVEL_1_TYPE_NAMES]).toEqual([
      'area',
      'bar',
      'donut',
      'line',
      'metric',
      'pie',
      'scatter',
      'table',
    ]);
    for (const name of LEVEL_1_TYPE_NAMES) expect(byName(name).level).toBe(1);
  });

  it('registers `bubble` separately, so it resolves without an alias', () => {
    expect(byName('bubble').level).toBe(1);
  });

  it('exposes the implemented set on its own, without the stubs', () => {
    expect(level1ChartTypes.map((type) => type.name)).toEqual([
      'area',
      'bar',
      'bubble',
      'donut',
      'line',
      'metric',
      'pie',
      'scatter',
      'table',
    ]);
  });

  it('gives every type a schema id, so a document can be validated ahead of render', () => {
    for (const type of level1ChartTypes) {
      expect(type.schemaId, type.name).toMatch(
        /^https:\/\/mdv\.dev\/schema\/1\.0\/block\/[a-z]+\.json$/,
      );
    }
  });

  it('gives every type a minimum width, so core can refuse to draw a sliver', () => {
    for (const type of level1ChartTypes) expect(type.minWidth, type.name).toBeGreaterThan(0);
  });

  it('gives every type the three required entry points', () => {
    for (const type of builtinChartTypes) {
      expect(typeof type.validate, type.name).toBe('function');
      expect(typeof type.encode, type.name).toBe('function');
      expect(typeof type.layout, type.name).toBe('function');
    }
  });

  it('contributes its description through the registry contract, not its own a11y path', () => {
    // `describe` is the only hook a type has into the accessible name; nothing in
    // this package writes an `A11yTree`, which is core's to build.
    for (const type of level1ChartTypes) expect(typeof type.describe, type.name).toBe('function');
  });
});

describe('the built-in list', () => {
  it('is sorted by name, so registration order is not a hidden input', () => {
    const names = builtinChartTypes.map((type) => type.name);
    expect(names).toEqual([...names].sort());
  });

  it('has no duplicate names', () => {
    const names = builtinChartTypes.map((type) => type.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('has no name that is also somebody else’s alias', () => {
    const names = new Set(builtinChartTypes.map((type) => type.name));
    for (const type of builtinChartTypes) {
      for (const alias of type.aliases ?? []) expect(names.has(alias), alias).toBe(false);
    }
  });

  it('covers every level 1, 2 and 3 name in the spec', () => {
    const reachable = new Set<string>();
    for (const type of builtinChartTypes) {
      reachable.add(type.name);
      for (const alias of type.aliases ?? []) reachable.add(alias);
    }
    for (const name of [...LEVEL_1_TYPE_NAMES, ...LEVEL_2_TYPE_NAMES, ...LEVEL_3_TYPE_NAMES]) {
      expect(reachable.has(name), name).toBe(true);
    }
  });

  it('resolves `candlestick` through `ohlcv` rather than registering it twice', () => {
    expect(builtinChartTypes.find((type) => type.name === 'candlestick')).toBeUndefined();
    expect(byName('ohlcv').aliases).toEqual(['candlestick']);
  });
});

describe('chartTypesForLevel', () => {
  it('gives a Level 1 reader exactly the types it can draw', () => {
    expect(chartTypesForLevel(1)).toEqual(level1ChartTypes);
  });

  it('is cumulative: a Level 2 reader keeps every Level 1 type', () => {
    const two = chartTypesForLevel(2).map((type) => type.name);
    for (const type of level1ChartTypes) expect(two).toContain(type.name);
  });

  it('adds the Level 2 stubs at level 2 and the Level 3 ones at level 3', () => {
    const two = chartTypesForLevel(2).map((type) => type.name);
    expect(two).toContain('sankey');
    expect(two).not.toContain('gantt');
    expect(chartTypesForLevel(3).map((type) => type.name)).toContain('gantt');
  });
});

describe('unimplemented types degrade to a table (SPEC 15.2)', () => {
  const run = runChart(byName('sankey'), prices(), { attrs: { title: 'Flows' } });

  it('warns rather than failing, so a Level 2 document stays readable', () => {
    expect(codesOf(run)).toEqual(['MDV1500']);
  });

  it('never returns an error from `validate`: nothing here is the author’s fault', () => {
    for (const spec of UNIMPLEMENTED_TYPES) {
      const stub = byName(spec.name);
      expect(stub.validate({} as never, prices()), spec.name).toEqual([]);
    }
  });

  it('names the type and the level the document actually needs', () => {
    const message = run.diagnostics[0]?.message ?? '';
    expect(message).toContain('sankey');
    expect(message).toContain('Level 2');
  });

  it('says what a capable reader would have drawn', () => {
    expect(run.diagnostics[0]?.detail).toContain('Sankey diagram of the flows');
  });

  it('draws the real table, not a placeholder', () => {
    expect(
      nodesOfKind(run.laid.nodes, 'text').filter((node) => node.cls === 'mdv-table-header'),
    ).toHaveLength(5);
    expect(run.laid.hits).toHaveLength(2);
  });

  it('shows every row, so nothing is lost in the degradation', () => {
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Mon', '10', '14', '9', '13'],
      ['Tue', '13', '15', '12', '12'],
    ]);
  });

  it('leads its description with the notice, then describes the table', () => {
    expect(run.description).toBe(
      'Shown as a table: this reader does not implement the `sankey` block type. ' +
        'Table. 2 rows across 5 columns: Day, Open, High, Low, Close.',
    );
  });

  it('does not complain about the attributes of the type it is standing in for', () => {
    // `table`'s own validate would report `nodeWidth` as an unknown column; that
    // would bury the one diagnostic that matters under a dozen that do not.
    const fussy = runChart(byName('sankey'), prices(), {
      attrs: { nodeWidth: 12, linkOpacity: 0.4 },
    });
    expect(codesOf(fussy)).toEqual(['MDV1500']);
  });

  it('degrades every single Level 2 and Level 3 type the same way', () => {
    for (const spec of UNIMPLEMENTED_TYPES) {
      const stub = runChart(byName(spec.name), prices(), {});
      expect(codesOf(stub), spec.name).toEqual(['MDV1500']);
      expect(stub.laid.hits, spec.name).toHaveLength(2);
      expect(nonFiniteNumbers(stub.laid), spec.name).toEqual([]);
    }
  });

  it('degrades cleanly on an empty table too', () => {
    const empty = runChart(byName('treemap'), makeTable([], []), {});
    expect(codesOf(empty)).toEqual(['MDV1500']);
    expect(empty.laid.nodes).toEqual([]);
  });

  it('reports the reader’s level, not a hard-coded 1', () => {
    const level2 = runChart(byName('gantt'), prices(), { level: 2 });
    expect(level2.diagnostics[0]?.message).toContain('implements Level 2');
  });

  it('can be built for a type this package does not list', () => {
    const custom = createUnimplementedChartType({
      name: 'chord',
      level: 3,
      summary: 'a chord diagram',
    });
    const run2 = runChart(custom, prices(), {});
    expect(codesOf(run2)).toEqual(['MDV1500']);
    expect(run2.laid.hits).toHaveLength(2);
  });
});

describe('the stubs stay honest about being stubs', () => {
  it('accepts every channel, so no second misleading diagnostic appears', () => {
    const stub = byName('radar');
    const permissive = stub.channels.every((channel) => channel.required !== true);
    expect(permissive).toBe(true);
  });

  it('borrows the table minimum width, because a table is what gets drawn', () => {
    expect(byName('treemap').minWidth).toBe(byName('table').minWidth);
  });

  it('targets the row, because the row is what is on screen', () => {
    expect(byName('funnel').family).toBe('mark');
  });

  it('lists each stub exactly once, at the level SPEC 16.1 assigns it', () => {
    const levels = new Map(UNIMPLEMENTED_TYPES.map((spec) => [spec.name, spec.level]));
    expect(levels.get('waterfall')).toBe(2);
    expect(levels.get('ohlcv')).toBe(2);
    expect(levels.get('sparkline')).toBe(2);
    expect(levels.get('map')).toBe(3);
    expect(levels.get('network')).toBe(3);
    expect(levels.get('gantt')).toBe(3);
  });

  it('drops a name from the list the moment the real module lands', () => {
    // `histogram` graduated (SPEC 8.7), `box` after it (SPEC 8.8), then
    // `heatmap` (SPEC 8.9). This list is the *only* thing that decides whether
    // a name degrades, so a name left on it after its module arrives would keep
    // drawing the table however complete the module is.
    const names = UNIMPLEMENTED_TYPES.map((spec) => spec.name);
    expect(names).not.toContain('histogram');
    expect(names).not.toContain('box');
    expect(names).not.toContain('heatmap');
    const real = runChart(byName('histogram'), prices(), { encoding: { x: { field: 'close' } } });
    expect(codesOf(real)).toEqual([]);
    expect(nodesOfKind(real.laid.nodes, 'rect').length).toBeGreaterThan(0);
    const drawn = runChart(byName('box'), prices(), {
      encoding: { x: { field: 'day' }, y: { field: 'close' } },
    });
    expect(codesOf(drawn)).toEqual([]);
    expect(nodesOfKind(drawn.laid.nodes, 'rect').length).toBeGreaterThan(0);
    const grid = runChart(
      byName('heatmap'),
      makeTable(
        [
          ['day', 'category'],
          ['hour', 'category'],
          ['value', 'number'],
        ],
        [
          ['Mon', 'AM', 1],
          ['Tue', 'PM', 2],
        ],
      ),
      { encoding: { x: { field: 'day' }, y: { field: 'hour' }, value: { field: 'value' } } },
    );
    expect(codesOf(grid)).toEqual([]);
    expect(nodesOfKind(grid.laid.nodes, 'rect').length).toBeGreaterThan(0);
  });
});

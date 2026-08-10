/**
 * `table` — the enhanced table block (SPEC 10), asserted numerically.
 *
 * Row geometry is fixed by the theme, not by the data:
 * `rowHeight = max(20, 11.05 × 1.4 + 2 × 6) = 27.47`, where 11.05 is the body
 * font (`13 × tickScale 0.85`), 1.4 the line height and 6 the vertical cell
 * padding. Text sits on the row's middle, so the header baseline is 13.735 and
 * body row *n* has its baseline at `27.47 × (n + 1.5)`.
 *
 * Column widths are measured content, then fitted to the frame. Most tests here
 * pin the widths explicitly (`columns.*.width`) so the interesting assertion is
 * the *placement*, not the harness's `length × size × 0.6` metric stub; the
 * fitting rules get their own block.
 */

import { describe, expect, it } from 'vitest';
import type { Rect, Table } from '@mdv/core';
import { tableChart } from '../src/table.js';
import {
  EMPTY_TABLE,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

/** Two regions and their revenue — the smallest table with a real column pair. */
function regions() {
  return makeTable(
    [
      ['region', 'string'],
      ['revenue', 'number'],
    ],
    [
      ['North', 100],
      ['South', 250],
    ],
  );
}

/** Widths pinned so placement is exact: two 200 px columns in a 400 px frame. */
const PINNED = { columns: { region: { width: 200 }, revenue: { width: 200 } } };

/**
 * `runChart` for this file, taking the attribute bag as a plain record.
 *
 * See {@link attrsOf}: SPEC 10.1 spells the per-column configuration `columns:`
 * as a map, while the shared `BlockAttrs` declares `columns` as SPEC 7.6's facet
 * wrap *count*. Every fixture below would otherwise carry the same cast.
 */
function runTable(
  table: Table,
  options: { attrs?: Readonly<Record<string, unknown>>; frame?: Rect } = {},
) {
  return runChart(tableChart, table, {
    ...(options.attrs === undefined ? {} : { attrs: attrsOf(options.attrs) }),
    ...(options.frame === undefined ? {} : { frame: options.frame }),
  });
}

function texts(run: ReturnType<typeof runTable>, cls?: string) {
  const all = nodesOfKind(run.laid.nodes, 'text');
  return cls === undefined ? all : all.filter((node) => node.cls === cls);
}

describe('table: header and rows', () => {
  const run = runTable(regions(), { attrs: PINNED });

  it('humanises each column name into a header', () => {
    expect(texts(run, 'mdv-table-header').map((node) => node.text)).toEqual(['Region', 'Revenue']);
  });

  it('centres the header in its own row', () => {
    expect(texts(run, 'mdv-table-header').map((node) => node.y)).toEqual([13.735, 13.735]);
  });

  it('advances one row height per row', () => {
    const cells = texts(run, 'mdv-table-cell');
    expect(cells.map((node) => node.y)).toEqual([41.205, 41.205, 68.675, 68.675]);
  });

  it('sets text left in a text column and right in a numeric one (SPEC 10.1)', () => {
    const [region, revenue] = texts(run, 'mdv-table-header');
    expect({ x: region?.x, anchor: region?.anchor }).toEqual({ x: 8, anchor: 'start' });
    expect({ x: revenue?.x, anchor: revenue?.anchor }).toEqual({ x: 392, anchor: 'end' });
  });

  it('gives numbers tabular figures so digits line up down the column (SPEC 11.5)', () => {
    const cells = texts(run, 'mdv-table-cell');
    expect(cells[0]?.tabular).toBeUndefined();
    expect(cells[1]?.tabular).toBe(true);
  });

  it('rules the header off, and only the header', () => {
    const rules = nodesOfKind(run.laid.nodes, 'line');
    expect(rules).toHaveLength(1);
    expect({ y1: rules[0]?.y1, y2: rules[0]?.y2 }).toEqual({ y1: 27.47, y2: 27.47 });
  });

  it('makes each data row one target, spanning the full width', () => {
    expect(run.laid.hits).toHaveLength(2);
    expect(run.laid.hits[0]).toMatchObject({ x: 0, y: 27.47, w: 400, h: 27.47, datumIndex: 0 });
    expect(run.laid.hits[1]).toMatchObject({ y: 54.94, datumIndex: 1 });
  });

  it('reads out every column, leading with the first', () => {
    expect(run.laid.hits[0]?.readout).toEqual([
      { label: 'Region', value: 'North', emphasis: true },
      { label: 'Revenue', value: '100' },
    ]);
  });

  it('stops drawing at the bottom of the frame instead of overflowing it', () => {
    const short = runTable(regions(), {
      attrs: PINNED,
      frame: { x: 0, y: 0, width: 400, height: 40 },
    });
    // Header (27.47) plus one row is already past 40, so only the first row lands.
    expect(texts(short, 'mdv-table-cell')).toHaveLength(2);
  });
});

describe('table: column configuration (SPEC 10.1)', () => {
  it('takes column order from `columns:` as written, not from the data', () => {
    const run = runTable(regions(), { attrs: { columns: { revenue: {}, region: {} } } });
    expect(texts(run, 'mdv-table-header').map((node) => node.text)).toEqual(['Revenue', 'Region']);
  });

  it('shows only the configured columns', () => {
    const run = runTable(regions(), { attrs: { columns: { revenue: {} } } });
    expect(texts(run, 'mdv-table-header').map((node) => node.text)).toEqual(['Revenue']);
  });

  it('takes an explicit label over the humanised name', () => {
    const run = runTable(regions(), { attrs: { columns: { region: { label: 'Sales area' } } } });
    expect(texts(run, 'mdv-table-header')[0]?.text).toBe('Sales area');
  });

  it('applies a per-column format', () => {
    const run = runTable(regions(), { attrs: { columns: { revenue: { format: '$,.2f' } } } });
    expect(texts(run, 'mdv-table-cell').map((node) => node.text)).toEqual(['$100.00', '$250.00']);
  });

  it('takes an explicit alignment over the inferred one', () => {
    const run = runTable(regions(), {
      attrs: { columns: { revenue: { width: 400, align: 'center' } } },
    });
    expect(texts(run, 'mdv-table-cell')[0]?.anchor).toBe('middle');
  });

  it('names a column that is not in the data rather than silently dropping it (MDV1501)', () => {
    const run = runTable(regions(), { attrs: { columns: { profit: {} } } });
    expect(codesOf(run.validation)).toEqual(['MDV1501']);
  });

  it('compares column names case-sensitively (SPEC 6.1.2)', () => {
    const run = runTable(regions(), { attrs: { columns: { Revenue: {} } } });
    expect(codesOf(run.validation)).toEqual(['MDV1501']);
  });
});

describe('table: in-cell encodings supplement the value, never replace it (SPEC 10.1)', () => {
  it('draws a proportional bar behind the number, and still draws the number', () => {
    const run = runTable(regions(), {
      attrs: { columns: { region: { width: 200 }, revenue: { width: 200, heat: 'bar' } } },
    });
    const bars = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-bar',
    );
    // The bar measures from zero, not from the column minimum: 100/250 and 250/250
    // of the 198 px inner width.
    expect(bars.map((node) => node.w)).toEqual([79.2, 198]);
    expect(texts(run, 'mdv-table-cell').map((node) => node.text)).toContain('100');
  });

  it('anchors the bar at zero so a small value looks small', () => {
    const table = makeTable([['n', 'number']], [[90], [100]]);
    const run = runTable(table, { attrs: { columns: { n: { heat: 'bar' } } } });
    const bars = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-bar',
    );
    // The lone column fills the 400 px frame, so the inner width is 398: the bars
    // are 90 % and 100 % of it, not 0 % and 100 %, which is what measuring from
    // the column minimum would draw.
    expect(bars.map((node) => node.w)).toEqual([358.2, 398]);
  });

  it('tints the cell behind the number for a sequential heat', () => {
    const run = runTable(regions(), {
      attrs: { columns: { region: { width: 200 }, revenue: { width: 200, heat: 'sequential' } } },
    });
    const heat = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-heat',
    );
    expect(heat.map((node) => node.fill)).toEqual([
      { kind: 'solid', color: '#e6f4f4' },
      { kind: 'solid', color: '#0b5f5f' },
    ]);
  });

  it('flips the text between ink and white by the fill it sits on', () => {
    const run = runTable(regions(), {
      attrs: { columns: { region: { width: 200 }, revenue: { width: 200, heat: 'sequential' } } },
    });
    const values = texts(run, 'mdv-table-cell').filter((node) => node.anchor === 'end');
    expect(values[0]?.fill).toEqual({ kind: 'solid', color: '#1a1a1a' }); // on the palest step
    expect(values[1]?.fill).toEqual({ kind: 'solid', color: '#ffffff' }); // on the darkest
  });

  it('keeps the midpoint neutral, because zero must read as "nothing" (SPEC 11.3)', () => {
    const table = makeTable([['delta', 'number']], [[-10], [0], [10]]);
    const run = runTable(table, { attrs: { columns: { delta: { heat: 'diverging' } } } });
    const heat = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-heat',
    );
    expect(heat[1]?.fill).toEqual({ kind: 'solid', color: '#f2f2f2' });
  });

  it('gives each arm its own hue, at matching strength', () => {
    const table = makeTable([['delta', 'number']], [[-10], [0], [10]]);
    const run = runTable(table, { attrs: { columns: { delta: { heat: 'diverging' } } } });
    const heat = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-heat',
    );
    // `lowSteps` reads from the low extreme inwards and `highSteps` outwards, so
    // −10 must land on the *first* low step, not the last.
    expect(heat[0]?.fill).toEqual({ kind: 'solid', color: '#801111' });
    expect(heat[2]?.fill).toEqual({ kind: 'solid', color: '#111180' });
  });

  it('moves the diverging neutral to an explicit midpoint', () => {
    const table = makeTable([['score', 'number']], [[0], [50], [100]]);
    const run = runTable(table, {
      attrs: { columns: { score: { heat: 'diverging', midpoint: 50 } } },
    });
    const heat = nodesOfKind(run.laid.nodes, 'rect').filter(
      (node) => node.cls === 'mdv-table-cell-heat',
    );
    expect(heat[1]?.fill).toEqual({ kind: 'solid', color: '#f2f2f2' });
    expect(heat[0]?.fill).toEqual({ kind: 'solid', color: '#801111' });
    expect(heat[2]?.fill).toEqual({ kind: 'solid', color: '#111180' });
  });

  it('tints nothing when every value is the same: there is no magnitude to show', () => {
    const table = makeTable([['n', 'number']], [[5], [5]]);
    const run = runTable(table, { attrs: { columns: { n: { heat: 'sequential' } } } });
    expect(
      nodesOfKind(run.laid.nodes, 'rect').filter((node) => node.cls === 'mdv-table-cell-heat'),
    ).toHaveLength(0);
  });

  it('draws a per-cell sparkline from a comma-separated series', () => {
    const table = makeTable([['history', 'string']], [['1,2,3']]);
    const run = runTable(table, {
      attrs: { columns: { history: { type: 'sparkline', width: 400 } } },
    });
    const spark = nodesOfKind(run.laid.nodes, 'path')[0];
    // Inner box: x from 8 to 392, y from 27.47 + 6 down 15.47.
    expect(spark?.d).toEqual([
      { c: 'M', x: 8, y: 48.94 },
      { c: 'L', x: 200, y: 41.205 },
      { c: 'L', x: 392, y: 33.47 },
    ]);
  });

  it('summarises a sparkline cell in the accessible table, where a path is useless', () => {
    const table = makeTable([['history', 'string']], [['1,2,3']]);
    const run = runTable(table, { attrs: { columns: { history: { type: 'sparkline' } } } });
    expect(run.encoded.a11yTable?.rows).toEqual([['3 points']]);
  });

  it('sets a badge behind its text without hiding it', () => {
    const table = makeTable([['status', 'string']], [['ok']]);
    const run = runTable(table, { attrs: { columns: { status: { type: 'badge', width: 400 } } } });
    expect(
      nodesOfKind(run.laid.nodes, 'rect').filter((node) => node.cls === 'mdv-table-cell-badge'),
    ).toHaveLength(1);
    expect(texts(run, 'mdv-table-cell')[0]?.text).toBe('ok');
  });
});

describe('table: sorting (SPEC 10.1)', () => {
  function scores() {
    return makeTable(
      [
        ['name', 'string'],
        ['score', 'number'],
      ],
      [
        ['Ada', 2],
        ['Bo', 3],
        ['Cy', 1],
      ],
    );
  }

  it('sorts ascending by a named column', () => {
    const run = runTable(scores(), { attrs: { sort: 'score' } });
    expect(run.encoded.a11yTable?.rows.map((row) => row[0])).toEqual(['Cy', 'Ada', 'Bo']);
  });

  it('reads a leading minus as descending', () => {
    const run = runTable(scores(), { attrs: { sort: '-score' } });
    expect(run.encoded.a11yTable?.rows.map((row) => row[0])).toEqual(['Bo', 'Ada', 'Cy']);
  });

  it('keeps ties in source order, so sorting never shuffles equal rows', () => {
    const table = makeTable(
      [
        ['name', 'string'],
        ['score', 'number'],
      ],
      [
        ['Ada', 1],
        ['Bo', 1],
        ['Cy', 1],
      ],
    );
    const run = runTable(table, { attrs: { sort: 'score' } });
    expect(run.encoded.a11yTable?.rows.map((row) => row[0])).toEqual(['Ada', 'Bo', 'Cy']);
  });

  it('falls through to the next key', () => {
    const table = makeTable(
      [
        ['team', 'string'],
        ['score', 'number'],
      ],
      [
        ['b', 1],
        ['a', 2],
        ['a', 1],
      ],
    );
    const run = runTable(table, { attrs: { sort: ['team', '-score'] } });
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['a', '2'],
      ['a', '1'],
      ['b', '1'],
    ]);
  });

  it('sorts strings without asking the host what locale it is in (SPEC 17.3)', () => {
    const table = makeTable([['name', 'string']], [['b'], ['A'], ['a']]);
    const run = runTable(table, { attrs: { sort: 'name' } });
    // Code-point order, identically on every machine.
    expect(run.encoded.a11yTable?.rows).toEqual([['A'], ['a'], ['b']]);
  });

  it('puts blanks last, whichever way the column is sorted', () => {
    const table = makeTable([['n', 'number']], [[2], [null], [1]]);
    const ascending = runTable(table, { attrs: { sort: 'n' } });
    expect(ascending.encoded.a11yTable?.rows).toEqual([['1'], ['2'], ['—']]);
  });

  it('names a sort column that is not in the data (MDV1501)', () => {
    expect(codesOf(runTable(scores(), { attrs: { sort: 'rank' } }).validation)).toEqual([
      'MDV1501',
    ]);
  });
});

describe('table: grouping and totals (SPEC 10.1)', () => {
  function sales() {
    return makeTable(
      [
        ['region', 'string'],
        ['revenue', 'number'],
      ],
      [
        ['North', 100],
        ['South', 250],
        ['North', 400],
      ],
    );
  }

  it('heads each group and subtotals it, so no one adds rows up by eye', () => {
    const run = runTable(sales(), { attrs: { group: 'region' } });
    expect(texts(run, 'mdv-table-group').map((node) => node.text)).toEqual(['North', 'South']);
    expect(texts(run, 'mdv-table-subtotal').map((node) => node.text)).toEqual([
      '',
      '500',
      '',
      '250',
    ]);
  });

  it('keeps groups in first-appearance order, not alphabetical', () => {
    const run = runTable(sales(), { attrs: { group: 'region' } });
    expect(texts(run, 'mdv-table-group')[0]?.text).toBe('North');
  });

  it('leaves the accessible table ungrouped: it is the data, not the presentation', () => {
    const run = runTable(sales(), { attrs: { group: 'region' } });
    expect(run.encoded.a11yTable?.rows).toHaveLength(3);
  });

  it('adds a footer total under the rule', () => {
    const run = runTable(sales(), { attrs: { total: { revenue: 'sum' } } });
    expect(texts(run, 'mdv-table-total').map((node) => node.text)).toEqual(['750']);
    expect(nodesOfKind(run.laid.nodes, 'line')).toHaveLength(2); // header rule + footer rule
  });

  it('supports each aggregate it advertises', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['sum', '750'],
      ['mean', '250'],
      ['min', '100'],
      ['max', '400'],
      ['count', '3'],
    ];
    for (const [op, expected] of cases) {
      const run = runTable(sales(), { attrs: { total: { revenue: op } } });
      expect(texts(run, 'mdv-table-total')[0]?.text, op).toBe(expected);
    }
  });

  it('formats the total the way it formats the column', () => {
    const run = runTable(sales(), {
      attrs: { total: { revenue: 'sum' }, columns: { region: {}, revenue: { format: '$,.0f' } } },
    });
    expect(texts(run, 'mdv-table-total')[0]?.text).toBe('$750');
  });
});

describe('table: presentation', () => {
  it('stripes alternate rows when asked, and not otherwise', () => {
    const plain = runTable(regions(), {});
    const zebra = runTable(regions(), { attrs: { zebra: true } });
    const stripes = (run: typeof plain) =>
      nodesOfKind(run.laid.nodes, 'rect').filter((node) => node.cls === 'mdv-table-zebra');
    expect(stripes(plain)).toHaveLength(0);
    expect(stripes(zebra)).toHaveLength(1); // the second of two rows
  });

  it('records stickiness for the DOM without acting on it in a static scene', () => {
    const run = runTable(regions(), { attrs: { sticky: 'both' } });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(codesOf(run)).toEqual([]);
  });

  it('says plainly that pagination does nothing to a static render (MDV1501)', () => {
    const run = runTable(regions(), { attrs: { pageSize: 10 } });
    expect(codesOf(run)).toContain('MDV1501');
    expect(run.laid.hits).toHaveLength(2); // every row still drawn
  });
});

describe('table: width fitting', () => {
  it('fills the frame exactly when the content is narrower', () => {
    const run = runTable(regions(), {});
    const rights = texts(run, 'mdv-table-header').map((node) => node.x);
    // The right-aligned second header sits one cell pad in from the frame edge.
    expect(rights[1]).toBe(392);
  });

  it('shrinks rather than overflowing the block (SPEC 8.1)', () => {
    const run = runTable(regions(), {
      attrs: { columns: { region: { width: 2000 }, revenue: { width: 2000 } } },
      frame: { x: 0, y: 0, width: 400, height: 200 },
    });
    const cells = texts(run, 'mdv-table-cell');
    for (const node of cells) expect(node.x).toBeLessThanOrEqual(400);
  });

  it('honours the frame origin, so a table can be placed anywhere', () => {
    const run = runTable(regions(), {
      attrs: PINNED,
      frame: { x: 30, y: 10, width: 400, height: 200 },
    });
    expect(texts(run, 'mdv-table-header')[0]?.x).toBe(38);
    expect(texts(run, 'mdv-table-header')[0]?.y).toBe(23.735);
  });
});

describe('table: degenerate input', () => {
  it('draws nothing for a table with no columns', () => {
    const run = runTable(EMPTY_TABLE, {});
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('still draws the header when there are no rows', () => {
    const run = runTable(noRows([['region', 'string']]), {});
    expect(texts(run, 'mdv-table-header').map((node) => node.text)).toEqual(['Region']);
    expect(run.laid.hits).toEqual([]);
  });

  it('handles a single row', () => {
    const run = runTable(makeTable([['n', 'number']], [[1]]), {});
    expect(run.laid.hits).toHaveLength(1);
    expect(run.description).toBe('Table. 1 row across 1 column: N.');
  });

  it('renders an all-null column as em dashes, not as "null"', () => {
    const run = runTable(makeTable([['n', 'number']], [[null], [null]]), {});
    expect(texts(run, 'mdv-table-cell').map((node) => node.text)).toEqual(['—', '—']);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN at any extreme frame', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 4, height: 2000 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: Number.NaN, height: 200 },
    ]) {
      const run = runTable(regions(), {
        attrs: {
          zebra: true,
          total: { revenue: 'sum' },
          columns: { region: {}, revenue: { heat: 'bar' } },
        },
        frame,
      });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('never throws for document content, however wrong', () => {
    expect(() =>
      runTable(regions(), {
        attrs: {
          columns: 'nope',
          sort: 7,
          total: [1, 2],
          group: 42,
          zebra: 'maybe',
          sticky: 'sideways',
        },
      }),
    ).not.toThrow();
  });
});

describe('table: the duality with charts (SPEC 10.3)', () => {
  it('emits one text mark per cell, so the export path is the same as any chart', () => {
    const run = runTable(regions(), {});
    expect(run.encoded.marks).toHaveLength(4);
    expect(run.encoded.marks[0]).toEqual({
      mark: 'text',
      seriesId: '',
      datum: 0,
      x: 'Region',
      y: 0,
      text: 'North',
    });
  });

  it('carries its content as the accessible table, not as a description of one', () => {
    const run = runTable(regions(), { attrs: { caption: 'Regional revenue' } });
    expect(run.encoded.a11yTable).toMatchObject({
      caption: 'Regional revenue',
      columns: [
        { name: 'Region', type: 'string', align: 'left' },
        { name: 'Revenue', type: 'number', align: 'right' },
      ],
      rows: [
        ['North', '100'],
        ['South', '250'],
      ],
    });
  });

  it('has no scales and no axes: a table has no domain to tick', () => {
    const run = runTable(regions(), {});
    expect(run.encoded.scales).toEqual({});
    expect(run.encoded.axes).toEqual([]);
  });

  it('describes its shape rather than reading itself aloud', () => {
    expect(runTable(regions(), {}).description).toBe(
      'Table. 2 rows across 2 columns: Region, Revenue.',
    );
  });

  it('says so when there is nothing to show', () => {
    expect(runTable(EMPTY_TABLE, {}).description).toBe('Table with no columns.');
  });
});

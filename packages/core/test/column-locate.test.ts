/**
 * The column locator (SPEC 6.2, 6.7, 7.1.2).
 *
 * Two claims are under test and they pull in opposite directions. The first is
 * that every site can be edited: a caller finds the text inside the range and
 * counts to the offset, and lands on the name — which `resolved` does here
 * exactly as a language server would, so a site that cannot be hit is a
 * failure and not a curiosity. The second is that no site is one too many: a
 * pipeline decides how far a header name reaches, and a reference past that
 * point belongs to a different column that happens to be spelled the same. So
 * the pipeline cases are written as pairs — the step, and the channel behind it
 * that must or must not come with it.
 */

import { parse, type MdvBlock } from '@mdv/parser';
import { describe, expect, it } from 'vitest';
import {
  HEADER_PATH,
  checkColumnName,
  locateColumns,
  type ColumnSite,
} from '../src/data/locate.js';

/** A block on its own, written as the body between the fences. */
function source(...body: readonly string[]): string {
  return ['```mdv line', ...body, '```', ''].join('\n');
}

/** The first block anywhere in the tree, since a fence inside a list is nested. */
function blockOf(text: string): MdvBlock {
  const walk = (nodes: readonly { type: string; children?: unknown }[]): MdvBlock | undefined => {
    for (const node of nodes) {
      if (node.type === 'mdvBlock') return node as MdvBlock;
      const children = node.children;
      if (Array.isArray(children)) {
        const found = walk(children as { type: string }[]);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const found = walk(parse(text).children);
  if (found === undefined) throw new Error('no block in the source');
  return found;
}

/** The map of a block, which every case but the refusals expects to exist. */
function mapOf(text: string) {
  const map = locateColumns(blockOf(text));
  if (map === undefined) throw new Error('the block declares no columns');
  return map;
}

/** Every site of one column, as `kind path`, in the order they are reported. */
function sitesOf(text: string, name: string): string[] {
  return columnOf(text, name).sites.map((site) => `${site.kind} ${site.path}`);
}

function columnOf(text: string, name: string) {
  const column = mapOf(text).columns.find((entry) => entry.name === name);
  if (column === undefined) throw new Error(`no column named ${name}`);
  return column;
}

function siteAt(text: string, name: string, path: string): ColumnSite {
  const found = columnOf(text, name).sites.filter((site) => site.path === path);
  if (found.length !== 1) throw new Error(`expected one site at ${path}, got ${found.length}`);
  return found[0] as ColumnSite;
}

/**
 * The text a site points at, resolved the way an editor resolves it: find
 * `text` inside `range`, then count `offset` characters into it.
 */
function resolved(text: string, site: ColumnSite): string {
  const span = text.slice(site.range.start.offset, site.range.end.offset);
  const at = span.indexOf(site.text);
  if (at === -1) throw new Error(`${site.path}: ${JSON.stringify(site.text)} is not in its range`);
  const start = site.range.start.offset + at + site.offset;
  return text.slice(start, start + site.name.length);
}

const PIPELINE = source(
  'x: date',
  'y: revenue',
  'color: "region"',
  'transform:',
  '  - filter: "revenue > 0"',
  '  - derive:',
  '      margin: revenue - cost',
  '  - sort: [-revenue]',
  '---',
  'date,revenue,cost,region',
  '2026-01-01,10,4,north',
);

describe('locateColumns (SPEC 6.2, 6.7)', () => {
  it('reports every column of the header, the declaration first', () => {
    const map = mapOf(PIPELINE);
    expect(map.columns.map((column) => `${column.index} ${column.name}`)).toEqual([
      '0 date',
      '1 revenue',
      '2 cost',
      '3 region',
    ]);
    expect(map.columns.every((column) => column.sites[0]?.path === HEADER_PATH)).toBe(true);
    expect(map.delimiter).toBe(',');
  });

  it('finds a name in the pipeline and in the channel behind it', () => {
    expect(sitesOf(PIPELINE, 'revenue')).toEqual([
      'header #header',
      'identifier transform[0].filter',
      'identifier transform[1].derive.margin',
      'attribute transform[2].sort[0]',
      'attribute y',
    ]);
    expect(sitesOf(PIPELINE, 'cost')).toEqual([
      'header #header',
      'identifier transform[1].derive.margin',
    ]);
    expect(sitesOf(PIPELINE, 'region')).toEqual(['header #header', 'attribute color']);
  });

  it('points every site at the name and nothing else', () => {
    for (const column of mapOf(PIPELINE).columns) {
      for (const site of column.sites) {
        expect(`${site.path}: ${resolved(PIPELINE, site)}`).toBe(`${site.path}: ${column.name}`);
      }
    }
  });

  it('skips the `-` a descending sort key wears', () => {
    const site = siteAt(PIPELINE, 'revenue', 'transform[2].sort[0]');
    expect([site.text, site.offset]).toEqual(['-revenue', 1]);
  });

  it('spans the whole data section for a header cell, which has no range of its own', () => {
    const site = siteAt(PIPELINE, 'cost', HEADER_PATH);
    expect(PIPELINE.slice(site.range.start.offset, site.range.end.offset)).toBe(
      'date,revenue,cost,region\n2026-01-01,10,4,north',
    );
    expect([site.text, site.offset]).toEqual(['date,revenue,cost,region', 13]);
  });

  it('finds an indented header cell, whose text the parser has already de-indented', () => {
    const text = [
      '- item',
      '',
      '  ```mdv line',
      '  x: date',
      '  ---',
      '  date,revenue',
      '  2026-01-01,10',
      '  ```',
      '',
    ].join('\n');
    const map = locateColumns(blockOf(text));
    expect(map?.columns.map((column) => column.name)).toEqual(['date', 'revenue']);
    const site = siteAt(text, 'revenue', HEADER_PATH);
    expect(resolved(text, site)).toBe('revenue');
  });
});

describe('the header row', () => {
  it('reads a `table` row through the padding', () => {
    const text = source(
      'format: table',
      'x: date',
      '---',
      '| date       | net revenue |',
      '| ---------- | ----------- |',
      '| 2026-01-01 | 10          |',
    );
    const map = mapOf(text);
    expect(map.columns.map((column) => column.name)).toEqual(['date', 'net revenue']);
    expect(map.delimiter).toBe('|');
    expect(resolved(text, siteAt(text, 'net revenue', HEADER_PATH))).toBe('net revenue');
  });

  it('reads a `tsv` row, whose delimiter is the one a name may not contain', () => {
    const text = source('format: tsv', '---', ['date', 'revenue'].join('\t'), '2026-01-01\t10');
    const map = mapOf(text);
    expect(map.columns.map((column) => column.name)).toEqual(['date', 'revenue']);
    expect(checkColumnName(map, 'revenue', 'net\trevenue')).toMatch(/cannot contain a tab/u);
  });

  it('honours a `delimiter:` the reader would honour', () => {
    const text = source('format: csv', 'delimiter: ";"', '---', 'date;revenue', '2026-01-01;10');
    const map = mapOf(text);
    expect(map.columns.map((column) => column.name)).toEqual(['date', 'revenue']);
    expect(resolved(text, siteAt(text, 'revenue', HEADER_PATH))).toBe('revenue');
  });

  it('points inside the quotes of a quoted cell, which are not part of the name', () => {
    const text = source('x: date', '---', 'date,"net, revenue"', '2026-01-01,10');
    const map = mapOf(text);
    expect(map.columns.map((column) => column.name)).toEqual(['date', 'net, revenue']);
    expect(resolved(text, siteAt(text, 'net, revenue', HEADER_PATH))).toBe('net, revenue');
  });

  it('drops a name written twice, which identifies no one column', () => {
    const text = source('x: date', '---', 'date,revenue,revenue', '2026-01-01,10,11');
    expect(mapOf(text).columns.map((column) => column.name)).toEqual(['date']);
  });

  it('drops an empty cell, which is a column the reader names for itself', () => {
    const text = source('x: date', '---', 'date,,revenue', '2026-01-01,1,10');
    expect(mapOf(text).columns.map((column) => column.name)).toEqual(['date', 'revenue']);
  });
});

describe('blocks that declare no columns of their own', () => {
  const cases: readonly (readonly [string, string[]])[] = [
    ['rows that come from a dataset', ['from: "@sales"', 'x: date']],
    ['a `data:` reference', ['data: "@sales"', 'x: date']],
    ['no data section at all', ['x: date']],
    ['an empty data section', ['x: date', '---', '']],
    ['`header: false`', ['header: false', '---', 'date,revenue']],
    ['names given by `columns:`', ['columns: [date, revenue]', '---', '[["2026-01-01", 10]]']],
    ['rows read from a file', ['src: sales.csv', 'x: date']],
    ['`json`, which names a column once per record', ['---', '[{"date": "2026-01-01"}]']],
    ['`matrix`, which names none', ['format: matrix', '---', '1\t2', '3\t4']],
  ];

  for (const [what, body] of cases) {
    it(`reports nothing for ${what}`, () => {
      expect(locateColumns(blockOf(source(...body)))).toBeUndefined();
    });
  }
});

describe('how far a name reaches', () => {
  it('stops at a `select` that drops the column', () => {
    const text = source(
      'x: date',
      'y: revenue',
      'transform:',
      '  - select: [date]',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual(['header #header']);
    expect(sitesOf(text, 'date')).toEqual([
      'header #header',
      'attribute transform[0].select[0]',
      'attribute x',
    ]);
  });

  it('stops at a `rename`, and says the key cannot be rewritten', () => {
    const text = source(
      'y: takings',
      'transform:',
      '  - rename: {revenue: takings}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'attribute transform[0].rename.revenue#key',
    ]);
    // The parser records ranges for values, not for keys, so there is no span
    // to edit and the site says so instead of guessing at one. In particular
    // it does not borrow the range of `takings`, the value at that same key.
    expect(siteAt(text, 'revenue', 'transform[0].rename.revenue#key').offset).toBe(-1);
  });

  it('reads the expression of a `derive` that overwrites the column, then stops', () => {
    const text = source(
      'y: revenue',
      'transform:',
      '  - derive: {revenue: revenue * 2}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'identifier transform[0].derive.revenue',
    ]);
  });

  it('follows an aggregator that names its output after its input', () => {
    const text = source(
      'y: revenue',
      'transform:',
      '  - aggregate: {group: [date], sum: [revenue]}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'attribute transform[0].aggregate.sum[0]',
      'attribute y',
    ]);
  });

  it('stops at an aggregator that names its own output', () => {
    const text = source(
      'y: total',
      'transform:',
      '  - aggregate: {group: [date], sum: {total: revenue}}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'attribute transform[0].aggregate.sum.total',
    ]);
    expect(sitesOf(text, 'date')).toEqual([
      'header #header',
      'attribute transform[0].aggregate.group[0]',
    ]);
  });

  it('stops at a step it does not recognise, which could do anything', () => {
    const text = source(
      'y: revenue',
      'transform:',
      '  - fold: [revenue]',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual(['header #header']);
  });

  it('reads a lone step written unwrapped', () => {
    const text = source(
      'y: revenue',
      'transform:',
      '  filter: "revenue > 0"',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'identifier transform.filter',
      'attribute y',
    ]);
  });

  it('refuses a `bin` whose output name is written nowhere', () => {
    const text = source(
      'x: revenue_bin',
      'transform:',
      '  - bin: {field: revenue, step: 10}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'attribute transform[0].bin.field',
      'attribute transform[0].bin.output',
    ]);
    expect(siteAt(text, 'revenue', 'transform[0].bin.output').offset).toBe(-1);
  });

  it('takes a `bin` at its word when the output is written', () => {
    const text = source(
      'x: bucket',
      'transform:',
      '  - bin: {field: revenue, step: 10, output: bucket}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'revenue')).toEqual([
      'header #header',
      'attribute transform[0].bin.field',
    ]);
  });

  it('reads the left side of a join key and not the right', () => {
    const text = source(
      'transform:',
      '  - join: {with: "@costs", on: {left: date, right: day}}',
      '---',
      'date,revenue',
      '2026-01-01,10',
    );
    expect(sitesOf(text, 'date')).toEqual([
      'header #header',
      'attribute transform[0].join.on.left',
    ]);
  });
});

describe('channel bindings (SPEC 7.1.2)', () => {
  it('reads a list channel and a `field:` sub-key', () => {
    const text = source(
      'y: [revenue, cost]',
      'color: {field: region, scale: category}',
      '---',
      'date,revenue,cost,region',
      '2026-01-01,10,4,north',
    );
    expect(sitesOf(text, 'cost')).toEqual(['header #header', 'attribute y[1]']);
    expect(sitesOf(text, 'region')).toEqual(['header #header', 'attribute color.field']);
    expect(resolved(text, siteAt(text, 'region', 'color.field'))).toBe('region');
  });

  it('says nothing about an attribute that is not a channel', () => {
    const text = source('title: revenue', 'x: date', '---', 'date,revenue', '2026-01-01,10');
    expect(sitesOf(text, 'revenue')).toEqual(['header #header']);
  });
});

describe('expressions (SPEC 6.8)', () => {
  const BRACKETED = source(
    'y: "[net revenue]"',
    'transform:',
    '  - filter: "[net revenue] > 0"',
    '---',
    'date,net revenue',
    '2026-01-01,10',
  );

  it('reads a bracketed field as a bracket site', () => {
    expect(sitesOf(BRACKETED, 'net revenue')).toEqual([
      'header #header',
      'bracket transform[0].filter',
    ]);
    expect(resolved(BRACKETED, siteAt(BRACKETED, 'net revenue', 'transform[0].filter'))).toBe(
      'net revenue',
    );
  });

  it('does not read a callee or a keyword as a field', () => {
    const text = source(
      'transform:',
      '  - filter: "abs(revenue) > 0 and null != revenue"',
      '---',
      'abs,null,revenue',
      '1,2,10',
    );
    expect(sitesOf(text, 'abs')).toEqual(['header #header']);
    expect(sitesOf(text, 'null')).toEqual(['header #header']);
    expect(sitesOf(text, 'revenue').length).toBe(3);
  });
});

describe('checkColumnName (SPEC 6.8)', () => {
  const MAP = mapOf(PIPELINE);
  const BRACKETS = mapOf(
    source('transform:', '  - filter: "[net revenue] > 0"', '---', 'date,net revenue', '2026,10'),
  );

  it('accepts a name the header and every reference can hold', () => {
    expect(checkColumnName(MAP, 'revenue', 'takings')).toBeUndefined();
    expect(checkColumnName(MAP, 'revenue', 'revenue')).toBeUndefined();
  });

  it('refuses a column this block does not have', () => {
    expect(checkColumnName(MAP, 'takings', 'revenue')).toMatch(/not a column of this block/u);
  });

  it('refuses a name the header row could not carry back out', () => {
    expect(checkColumnName(MAP, 'revenue', '')).toMatch(/cannot be empty/u);
    expect(checkColumnName(MAP, 'revenue', ' takings')).toMatch(/start or end with a space/u);
    expect(checkColumnName(MAP, 'revenue', 'net\nrevenue')).toMatch(/line break/u);
    expect(checkColumnName(MAP, 'revenue', 'net,revenue')).toMatch(/separates the header cells/u);
    expect(checkColumnName(MAP, 'revenue', 'net "revenue"')).toMatch(/cannot contain a quote/u);
  });

  it('refuses a name the block already uses', () => {
    expect(checkColumnName(MAP, 'revenue', 'cost')).toMatch(/already a column of this block/u);
  });

  it('refuses a name a bare reference could not spell', () => {
    expect(checkColumnName(MAP, 'revenue', 'net revenue')).toMatch(/would have to be bracketed/u);
    expect(checkColumnName(MAP, 'revenue', 'true')).toMatch(/would have to be bracketed/u);
    // `region` is written in a channel and never in an expression, so two words
    // are fine there.
    expect(checkColumnName(MAP, 'region', 'sales region')).toBeUndefined();
  });

  it('lets a bracketed reference hold anything but a bracket', () => {
    expect(checkColumnName(BRACKETS, 'net revenue', 'gross revenue')).toBeUndefined();
    expect(checkColumnName(BRACKETS, 'net revenue', 'net [revenue]')).toMatch(
      /cannot contain a bracket/u,
    );
  });
});

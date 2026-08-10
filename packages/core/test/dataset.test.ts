import { describe, expect, it } from 'vitest';
import type { AttrMap } from '@mdv/parser';
import { createCollector } from '../src/data/diag.js';
import { effectiveLimits } from '../src/data/limits.js';
import {
  buildGraph,
  createTableCache,
  createRegistry,
  declareDatasets,
  dependenciesOf,
  describeCycle,
  formatReference,
  inlineDatasetId,
  isDatasetId,
  isReference,
  lookupIn,
  parseReference,
  prepareDatasets,
  readDeclaration,
  resolveTableRef,
  tableKey,
  type DatasetDeclaration,
  type PrepareOptions,
} from '../src/dataset/index.js';
import type { DatasetNode, Table, TransformPipeline, Value } from '../src/types/data.js';

const BUILD_TIME = new Date('2026-08-10T12:00:00Z');

function options(): PrepareOptions {
  return {
    timezone: 'UTC',
    buildTime: BUILD_TIME,
    limits: effectiveLimits(),
    format: { locale: 'en-US', timezone: 'UTC', buildTime: BUILD_TIME },
  };
}

function collector() {
  return createCollector('data');
}

/** Declare, prepare, and hand back everything a caller would hold. */
function prepare(declarations: readonly DatasetDeclaration[]) {
  const diag = collector();
  const nodes = declareDatasets(declarations, diag);
  const prepared = prepareDatasets(nodes, options(), diag);
  return {
    ...prepared,
    diag,
    codes: (): string[] => diag.diagnostics.map((d) => d.code),
    node: (id: string): DatasetNode => prepared.registry.get(id) as DatasetNode,
  };
}

const SALES_CSV = 'region,revenue\neast,100\nwest,200\neast,50\n';

/**
 * An inline dataset. `format` is pinned so the tests read a fixed diagnostic
 * list; auto-detection has its own test below, and emits `MDV2101` (info).
 */
const inline = (id: string, raw: string, extra: Partial<DatasetDeclaration> = {}): DatasetDeclaration => ({
  id,
  origin: 'block',
  raw,
  format: 'csv',
  ...extra,
});

const names = (table: Table): string[] => table.fields.map((field) => field.name);
const col = (table: Table, name: string): Value[] => {
  const at = table.fields.findIndex((field) => field.name === name);
  return table.rows.map((row) => row[at] ?? null);
};

describe('references (SPEC 6.3)', () => {
  it('parses a plain reference', () => {
    expect(parseReference('@sales')).toEqual({ id: 'sales' });
    expect(parseReference('  @sales  ')).toEqual({ id: 'sales' });
    expect(isReference('@sales')).toBe(true);
    expect(isReference('sales')).toBe(false);
  });

  it('parses a projection, preserving order', () => {
    expect(parseReference('@sales[date, revenue]')).toEqual({
      id: 'sales',
      projection: ['date', 'revenue'],
    });
    expect(parseReference('@sales[revenue,date]')?.projection).toEqual(['revenue', 'date']);
  });

  it('parses a bracketed field name containing a comma', () => {
    expect(parseReference('@sales[[Net revenue, USD], date]')?.projection).toEqual([
      'Net revenue, USD',
      'date',
    ]);
  });

  it('rejects malformed references', () => {
    expect(parseReference('sales')).toBeUndefined();
    expect(parseReference('@9sales')).toBeUndefined();
    expect(parseReference('@sa les')).toBeUndefined();
    expect(parseReference('@sales[date')).toBeUndefined();
    expect(parseReference('@sales[]')).toBeUndefined();
    expect(parseReference('@sales[date,]')).toBeUndefined();
    expect(parseReference('@sales[a]]')).toBeUndefined();
  });

  it('accepts the id grammar of SPEC 6.3 and the synthetic form', () => {
    expect(isDatasetId('sales')).toBe(true);
    expect(isDatasetId('_x-2')).toBe(true);
    expect(isDatasetId('2sales')).toBe(false);
    expect(isDatasetId('sales.q1')).toBe(false);
    expect(parseReference(`@${inlineDatasetId(3)}`)).toEqual({ id: '#block-3' });
  });

  it('round-trips through formatReference', () => {
    for (const text of ['@sales', '@sales[date, revenue]', '@sales[[a, b], c]']) {
      const parsed = parseReference(text);
      expect(parsed).toBeDefined();
      expect(formatReference(parsed as { id: string })).toBe(text);
    }
  });
});

describe('declaration (SPEC 6.3)', () => {
  it('keeps declaration order', () => {
    const diag = collector();
    const nodes = declareDatasets(
      [inline('a', 'x\n1'), inline('b', 'x\n2'), inline('c', 'x\n3')],
      diag,
    );
    expect(nodes.map((node) => node.id)).toEqual(['a', 'b', 'c']);
    expect(nodes.every((node) => node.state === 'declared')).toBe(true);
    expect(diag.diagnostics).toHaveLength(0);
  });

  it('drops an invalid id with MDV1220', () => {
    const diag = collector();
    const nodes = declareDatasets([inline('9bad', 'x\n1'), inline('good', 'x\n2')], diag);
    expect(nodes.map((node) => node.id)).toEqual(['good']);
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV1220']);
  });

  it('lets the last definition win, with MDV2140', () => {
    const diag = collector();
    const nodes = declareDatasets(
      [inline('a', 'x\n1'), inline('b', 'x\n2'), inline('a', 'x\n9')],
      diag,
    );
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV2140']);
    expect(nodes.map((node) => node.id)).toEqual(['b', 'a']);
    expect(nodes[1]?.raw).toBe('x\n9');
  });

  it('shares one namespace across origins', () => {
    const diag = collector();
    const nodes = declareDatasets(
      [
        { id: 'a', origin: 'front-matter', raw: 'x\n1' },
        { id: 'a', origin: 'block', raw: 'x\n2' },
      ],
      diag,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.origin).toBe('block');
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV2140']);
  });
});

describe('reading a declaration from a header', () => {
  it('reads the dataset keys', () => {
    const diag = collector();
    const attrs: AttrMap = {
      from: '@sales',
      format: 'csv',
      show: 'table',
      fields: { date: 'date', revenue: { type: 'number', format: ',.0f', title: 'Revenue' } },
      transform: [{ filter: 'revenue > 0' }, { limit: 10 }],
    };
    const declaration = readDeclaration('q1', attrs, 'block', diag);
    expect(diag.diagnostics).toHaveLength(0);
    expect(declaration.from).toBe('@sales');
    expect(declaration.format).toBe('csv');
    expect(declaration.show).toBe('table');
    expect(declaration.fields?.['date']).toEqual({ type: 'date' });
    expect(declaration.fields?.['revenue']).toEqual({
      type: 'number',
      format: ',.0f',
      title: 'Revenue',
    });
    expect(declaration.transform).toHaveLength(2);
  });

  it('reports a bad value and carries on', () => {
    const diag = collector();
    const declaration = readDeclaration(
      'q1',
      { from: 12, format: 'xlsx', show: 'chart', fields: 'date', transform: ['filter'] },
      'block',
      diag,
    );
    expect(diag.diagnostics.map((d) => d.code)).toEqual([
      'MDV1220',
      'MDV1502',
      'MDV1502',
      'MDV1220',
      'MDV2501',
    ]);
    expect(declaration.from).toBeUndefined();
    expect(declaration.format).toBeUndefined();
    expect(declaration.transform).toBeUndefined();
  });

  it('accepts a single transform step written without a list', () => {
    const diag = collector();
    const declaration = readDeclaration('q1', { transform: { limit: 5 } }, 'block', diag);
    expect(declaration.transform).toEqual([{ limit: 5 }]);
  });

  it('reports an unknown field type and an options-object format', () => {
    const diag = collector();
    const declaration = readDeclaration(
      'q1',
      { fields: { a: 'moneys', b: { format: { style: 'currency' } } } },
      'block',
      diag,
    );
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV1502', 'MDV1220']);
    expect(declaration.fields?.['b']).toEqual({});
  });
});

describe('the graph (SPEC 6.3)', () => {
  const node = (id: string, from?: string, transform?: TransformPipeline): DatasetNode => ({
    id,
    origin: 'block',
    state: 'declared',
    ...(from !== undefined ? { from } : {}),
    ...(transform !== undefined ? { transform } : {}),
  });

  it('lists dependencies from `from` and from `join`', () => {
    expect(dependenciesOf(node('c', '@a', [{ join: { with: '@b', on: 'k' } }]))).toEqual(['a', 'b']);
    expect(dependenciesOf(node('a'))).toEqual([]);
  });

  it('orders a chain so a node follows what it derives from', () => {
    const graph = buildGraph([node('c', '@b'), node('b', '@a'), node('a')]);
    expect(graph.order).toEqual(['a', 'b', 'c']);
    expect(graph.cyclic.size).toBe(0);
  });

  it('keeps declaration order among independent nodes', () => {
    const graph = buildGraph([node('a'), node('b'), node('c')]);
    expect(graph.order).toEqual(['a', 'b', 'c']);
  });

  it('finds a two-node cycle', () => {
    const graph = buildGraph([node('a', '@b'), node('b', '@a')]);
    expect([...graph.cyclic].sort()).toEqual(['a', 'b']);
    expect(describeCycle(graph.cycles[0] as string[])).toBe('@a → @b → @a');
  });

  it('finds a cycle through a join', () => {
    const graph = buildGraph([
      node('a', undefined, [{ join: { with: '@b', on: 'k' } }]),
      node('b', '@a'),
    ]);
    expect([...graph.cyclic].sort()).toEqual(['a', 'b']);
  });

  it('ignores a self-reference in `from` rather than looping', () => {
    const graph = buildGraph([node('a', '@a')]);
    expect(graph.cyclic.size).toBe(0);
    expect(graph.edges.get('a')).toEqual([]);
  });

  it('treats an unknown dependency as no edge', () => {
    const graph = buildGraph([node('a', '@missing')]);
    expect(graph.order).toEqual(['a']);
    expect(graph.cyclic.size).toBe(0);
  });

  it('handles a deep chain without recursion', () => {
    const chain: DatasetNode[] = [];
    for (let i = 0; i < 5000; i += 1) {
      chain.push(node(`n${i}`, i === 0 ? undefined : `@n${i - 1}`));
    }
    const graph = buildGraph([...chain].reverse());
    expect(graph.order).toHaveLength(5000);
    expect(graph.order[0]).toBe('n0');
    expect(graph.cyclic.size).toBe(0);
  });
});

describe('preparation (SPEC 18 stage 4)', () => {
  it('auto-detects the format of an unpinned section, with MDV2101', () => {
    const prepared = prepare([{ id: 'sales', origin: 'block', raw: SALES_CSV }]);
    expect(prepared.codes()).toEqual(['MDV2101']);
    expect(prepared.node('sales').state).toBe('ready');
  });

  it('parses an inline data section into a ready table', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const node = prepared.node('sales');
    expect(node.state).toBe('ready');
    expect(names(node.table as Table)).toEqual(['region', 'revenue']);
    expect(col(node.table as Table, 'revenue')).toEqual([100, 200, 50]);
  });

  it('applies the dataset’s own transform', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV, { transform: [{ filter: 'revenue >= 100' }] }),
    ]);
    expect((prepared.node('sales').table as Table).rows).toHaveLength(2);
  });

  it('derives one dataset from another, in any declaration order', () => {
    const prepared = prepare([
      {
        id: 'big',
        origin: 'front-matter',
        from: '@sales',
        transform: [{ filter: 'revenue > 60' }, { sort: '-revenue' }],
      },
      inline('sales', SALES_CSV),
    ]);
    expect(prepared.codes()).toEqual([]);
    const big = prepared.node('big').table as Table;
    expect(col(big, 'revenue')).toEqual([200, 100]);
    // The base dataset is untouched by its derivative.
    expect((prepared.node('sales').table as Table).rows).toHaveLength(3);
  });

  it('applies a projection written on `from`', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV),
      { id: 'only', origin: 'block', from: '@sales[revenue]' },
    ]);
    expect(names(prepared.node('only').table as Table)).toEqual(['revenue']);
  });

  it('reports an unknown projected field with MDV2111', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV),
      { id: 'only', origin: 'block', from: '@sales[profit, revenue]' },
    ]);
    expect(prepared.codes()).toEqual(['MDV2111']);
    expect(names(prepared.node('only').table as Table)).toEqual(['revenue']);
  });

  it('fails a dataset whose source is unresolved, with MDV2142', () => {
    const prepared = prepare([{ id: 'derived', origin: 'block', from: '@absent' }]);
    expect(prepared.codes()).toEqual(['MDV2142']);
    const node = prepared.node('derived');
    expect(node.state).toBe('failed');
    expect(node.stateReason).toBe('MDV2142');
    expect(node.table).toBeUndefined();
  });

  it('rejects a `from` that is not a reference', () => {
    const prepared = prepare([{ id: 'derived', origin: 'block', from: 'sales' }]);
    expect(prepared.codes()).toEqual(['MDV2142']);
    expect(prepared.node('derived').state).toBe('failed');
  });

  it('reports a cycle once and fails every node on it (MDV2141)', () => {
    const prepared = prepare([
      { id: 'a', origin: 'block', from: '@b' },
      { id: 'b', origin: 'block', from: '@a' },
    ]);
    expect(prepared.codes()).toEqual(['MDV2141']);
    expect(prepared.node('a').state).toBe('failed');
    expect(prepared.node('b').state).toBe('failed');
    expect(prepared.node('a').stateReason).toBe('MDV2141');
  });

  it('lets an unrelated dataset survive a cycle', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV),
      { id: 'a', origin: 'block', from: '@b' },
      { id: 'b', origin: 'block', from: '@a' },
    ]);
    expect(prepared.node('sales').state).toBe('ready');
  });

  it('blocks an external source that was never loaded', () => {
    const prepared = prepare([{ id: 'remote', origin: 'block', src: './data.csv' }]);
    const node = prepared.node('remote');
    expect(node.state).toBe('blocked');
    expect(node.stateReason).toBe('MDV4002');
    expect(prepared.codes()).toEqual([]);
  });

  it('prepares an external source once its text has arrived', () => {
    const prepared = prepare([
      { id: 'remote', origin: 'block', src: './data.csv', raw: SALES_CSV, format: 'csv' },
    ]);
    expect(prepared.node('remote').state).toBe('ready');
    expect((prepared.node('remote').table as Table).rows).toHaveLength(3);
  });

  it('reports a dataset with no data at all (MDV2100)', () => {
    const prepared = prepare([{ id: 'empty', origin: 'block' }]);
    expect(prepared.codes()).toEqual(['MDV2100']);
    expect(prepared.node('empty').state).toBe('ready');
    expect((prepared.node('empty').table as Table).rows).toHaveLength(0);
  });

  it('honours declared field types', () => {
    const prepared = prepare([
      inline('t', 'when,n\n2026-01-31,1\n2026-02-28,2\n', {
        fields: { when: { type: 'date' } },
      }),
    ]);
    const table = prepared.node('t').table as Table;
    expect(table.fields[0]?.type).toBe('date');
    expect(col(table, 'when')[0]).toBeInstanceOf(Date);
  });

  it('joins one dataset against another', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV),
      inline('targets', 'region,target\neast,500\nwest,400\n'),
      {
        id: 'joined',
        origin: 'block',
        from: '@sales',
        transform: [{ join: { with: '@targets', on: 'region' } }],
      },
    ]);
    expect(prepared.codes()).toEqual([]);
    const joined = prepared.node('joined').table as Table;
    expect(names(joined)).toEqual(['region', 'revenue', 'target']);
    expect(col(joined, 'target')).toEqual([500, 400, 500]);
  });

  it('does not mutate the nodes it was given', () => {
    const diag = collector();
    const nodes = declareDatasets([inline('sales', SALES_CSV)], diag);
    prepareDatasets(nodes, options(), diag);
    expect(nodes[0]?.state).toBe('declared');
    expect(nodes[0]?.table).toBeUndefined();
  });

  it('produces byte-identical output on a second run', () => {
    const declarations = [
      inline('sales', SALES_CSV),
      { id: 'top', origin: 'block' as const, from: '@sales', transform: [{ sort: '-revenue' }] },
    ];
    const first = prepare(declarations).node('top').table;
    const second = prepare(declarations).node('top').table;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe('the registry (SPEC 6.3)', () => {
  it('answers get, has and list in declaration order', () => {
    const prepared = prepare([inline('a', 'x\n1'), inline('b', 'x\n2')]);
    expect(prepared.registry.has('a')).toBe(true);
    expect(prepared.registry.has('zz')).toBe(false);
    expect(prepared.registry.get('zz')).toBeUndefined();
    expect(prepared.registry.list().map((node) => node.id)).toEqual(['a', 'b']);
  });

  it('resolves a ref, applying its projection', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const table = prepared.registry.resolve({
      datasetId: 'sales',
      projection: ['revenue'],
      key: tableKey('sales', ['revenue'], undefined),
    });
    expect(names(table as Table)).toEqual(['revenue']);
  });

  it('returns undefined for a missing or unready dataset', () => {
    const prepared = prepare([{ id: 'remote', origin: 'block', src: './x.csv' }]);
    expect(prepared.registry.resolve({ datasetId: 'remote', key: 'k' })).toBeUndefined();
    expect(prepared.registry.resolve({ datasetId: 'nope', key: 'k' })).toBeUndefined();
  });

  it('keys tables by dataset, projection and pipeline', () => {
    expect(tableKey('a', undefined, undefined)).toBe('a||');
    expect(tableKey('a', ['x'], undefined)).not.toBe(tableKey('a', ['y'], undefined));
    expect(tableKey('a', undefined, [{ limit: 1 }])).not.toBe(
      tableKey('a', undefined, [{ limit: 2 }]),
    );
    expect(tableKey('a', ['x', 'y'], [{ limit: 1 }])).toBe(tableKey('a', ['x', 'y'], [{ limit: 1 }]));
  });

  it('looks a reference up for a join', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const lookup = lookupIn(prepared.registry);
    expect(names(lookup('@sales') as Table)).toEqual(['region', 'revenue']);
    expect(names(lookup('@sales[revenue]') as Table)).toEqual(['revenue']);
    expect(lookup('@nope')).toBeUndefined();
    expect(lookup('nope')).toBeUndefined();
  });

  it('memoises through the table cache', () => {
    const cache = createTableCache();
    let calls = 0;
    const compute = (): Table => {
      calls += 1;
      return { fields: [], rows: [] };
    };
    cache.get('k', compute);
    cache.get('k', compute);
    expect(calls).toBe(1);
    expect(cache.size).toBe(1);
  });

  it('wraps a hand-built node list', () => {
    const registry = createRegistry([
      { id: 'x', origin: 'config', state: 'ready', table: { fields: [], rows: [] } },
    ]);
    expect(registry.list()).toHaveLength(1);
    expect(registry.resolve({ datasetId: 'x', key: 'x||' })).toEqual({ fields: [], rows: [] });
  });
});

describe('resolving a block’s data (SPEC 6.7 memoisation)', () => {
  it('returns the dataset table and a ref that keys it', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const diag = collector();
    const result = resolveTableRef({ reference: '@sales' }, prepared.registry, prepared.cache, options(), diag);
    expect(result.state).toBe('ready');
    expect(result.ref).toEqual({ datasetId: 'sales', key: 'sales||' });
    expect(result.table.rows).toHaveLength(3);
    expect(diag.diagnostics).toHaveLength(0);
  });

  it('evaluates one pipeline once for many blocks', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const diag = collector();
    const before = prepared.cache.size;
    const request = { reference: '@sales', transform: [{ sort: '-revenue' }] };
    const first = resolveTableRef(request, prepared.registry, prepared.cache, options(), diag);
    const second = resolveTableRef(request, prepared.registry, prepared.cache, options(), diag);
    expect(second.table).toBe(first.table);
    expect(prepared.cache.size).toBe(before + 1);
  });

  it('reuses the dataset’s own entry when the block adds nothing', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const size = prepared.cache.size;
    const result = resolveTableRef(
      { reference: '@sales' },
      prepared.registry,
      prepared.cache,
      options(),
      collector(),
    );
    expect(prepared.cache.size).toBe(size);
    expect(result.table).toBe(prepared.node('sales').table);
  });

  it('applies the block’s own projection and transform', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const result = resolveTableRef(
      { reference: '@sales[revenue]', transform: [{ limit: 1 }] },
      prepared.registry,
      prepared.cache,
      options(),
      collector(),
    );
    expect(names(result.table)).toEqual(['revenue']);
    expect(result.table.rows).toEqual([[100]]);
    expect(result.ref.projection).toEqual(['revenue']);
  });

  it('reports MDV2142 for an unresolved reference and hands back an empty table', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const diag = collector();
    const result = resolveTableRef({ reference: '@nope' }, prepared.registry, prepared.cache, options(), diag);
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV2142']);
    expect(diag.diagnostics[0]?.detail).toContain('@sales');
    expect(result.state).toBe('failed');
    expect(result.reason).toBe('MDV2142');
    expect(result.table).toEqual({ fields: [], rows: [] });
  });

  it('reports MDV2142 for a reference that is not one', () => {
    const prepared = prepare([]);
    const diag = collector();
    const result = resolveTableRef({ reference: 'sales' }, prepared.registry, prepared.cache, options(), diag);
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV2142']);
    expect(diag.diagnostics[0]?.detail).toContain('data: "@sales"');
    expect(result.state).toBe('failed');
  });

  it('reports an unknown projected field with MDV2111 and keeps the rest', () => {
    const prepared = prepare([inline('sales', SALES_CSV)]);
    const diag = collector();
    const result = resolveTableRef(
      { reference: '@sales[revenue, profit]' },
      prepared.registry,
      prepared.cache,
      options(),
      diag,
    );
    expect(diag.diagnostics.map((d) => d.code)).toEqual(['MDV2111']);
    expect(names(result.table)).toEqual(['revenue']);
  });

  it('passes an unready dataset’s state through for the placeholder', () => {
    const prepared = prepare([{ id: 'remote', origin: 'block', src: './x.csv' }]);
    const diag = collector();
    const result = resolveTableRef({ reference: '@remote' }, prepared.registry, prepared.cache, options(), diag);
    expect(result.state).toBe('blocked');
    expect(result.reason).toBe('MDV4002');
    expect(result.table.rows).toHaveLength(0);
    // The load already reported itself; the block must not report it twice.
    expect(diag.diagnostics).toHaveLength(0);
  });

  it('resolves a join inside a block-level pipeline', () => {
    const prepared = prepare([
      inline('sales', SALES_CSV),
      inline('targets', 'region,target\neast,500\nwest,400\n'),
    ]);
    const diag = collector();
    const result = resolveTableRef(
      { reference: '@sales', transform: [{ join: { with: '@targets', on: 'region' } }] },
      prepared.registry,
      prepared.cache,
      options(),
      diag,
    );
    expect(diag.diagnostics).toHaveLength(0);
    expect(col(result.table, 'target')).toEqual([500, 400, 500]);
  });
});

import { describe, expect, it } from 'vitest';
import { createCollector } from '../src/data/diag.js';
import { effectiveLimits } from '../src/data/limits.js';
import {
  applyPipeline,
  applyStep,
  pipelineKey,
  stepNamesOf,
  type TransformContext,
} from '../src/transform/index.js';
import type { Column, DataType, Table, TransformStep, Value } from '../src/types/data.js';

const BUILD_TIME = new Date('2026-08-10T12:00:00Z');

function context(overrides: Partial<TransformContext> = {}): TransformContext {
  return {
    diag: createCollector('data'),
    zone: 'UTC',
    buildTime: BUILD_TIME,
    format: { locale: 'en-US', timezone: 'UTC', buildTime: BUILD_TIME },
    limits: effectiveLimits(),
    ...overrides,
  };
}

/** A table from a header list and row tuples; types are inferred loosely. */
function table(
  names: readonly string[],
  rows: readonly Value[][],
  types?: readonly DataType[],
): Table {
  const fields: Column[] = names.map((name, i) => ({ name, type: types?.[i] ?? 'unknown' }));
  return { fields, rows: rows.map((row) => [...row]) };
}

/** Run a pipeline and return the result plus the diagnostic codes it produced. */
function run(
  input: Table,
  pipeline: readonly TransformStep[],
  overrides: Partial<TransformContext> = {},
): { out: Table; codes: string[]; messages: string[] } {
  const ctx = context(overrides);
  const out = applyPipeline(input, pipeline, ctx);
  return {
    out,
    codes: ctx.diag.diagnostics.map((d) => d.code),
    messages: ctx.diag.diagnostics.map((d) => d.message),
  };
}

const names = (out: Table): string[] => out.fields.map((field) => field.name);
const column = (out: Table, name: string): Value[] => {
  const at = out.fields.findIndex((field) => field.name === name);
  return out.rows.map((row) => row[at] ?? null);
};

const SALES = table(
  ['region', 'month', 'revenue', 'units'],
  [
    ['east', '2026-01', 100, 3],
    ['west', '2026-01', 200, 4],
    ['east', '2026-02', 150, 5],
    ['west', '2026-02', 50, 1],
    ['east', '2026-03', null, 2],
  ],
  ['category', 'category', 'number', 'integer'],
);

describe('the pipeline itself (SPEC 6.7)', () => {
  it('returns the input for an absent or empty pipeline', () => {
    const ctx = context();
    expect(applyPipeline(SALES, undefined, ctx)).toBe(SALES);
    expect(applyPipeline(SALES, [], ctx)).toBe(SALES);
    expect(ctx.diag.diagnostics).toHaveLength(0);
  });

  it('applies steps in order, feeding each the previous result', () => {
    const { out } = run(SALES, [
      { filter: 'revenue > 60' },
      { derive: { double: 'revenue * 2' } },
      { select: ['region', 'double'] },
    ]);
    expect(names(out)).toEqual(['region', 'double']);
    expect(column(out, 'double')).toEqual([200, 400, 300]);
  });

  it('never mutates its input', () => {
    const input = table(['a'], [[1], [2]]);
    const snapshot = JSON.stringify(input);
    run(input, [{ sort: '-a' }, { derive: { b: 'a + 1' } }, { limit: 1 }]);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('rejects an unknown step with MDV2500 and keeps the table', () => {
    const { out, codes } = run(SALES, [{ smooth: 'revenue' } as unknown as TransformStep]);
    expect(codes).toEqual(['MDV2500']);
    expect(out.rows).toHaveLength(SALES.rows.length);
  });

  it('reports MDV2501 when one entry declares two steps, and applies the first', () => {
    const { out, codes } = run(SALES, [
      { select: ['region'], limit: 1 } as unknown as TransformStep,
    ]);
    expect(codes).toEqual(['MDV2501']);
    expect(names(out)).toEqual(['region']);
    expect(out.rows).toHaveLength(5);
  });

  it('caps the pipeline at maxTransformSteps with MDV4031', () => {
    const limits = { ...effectiveLimits(), maxTransformSteps: 2 };
    const pipeline: TransformStep[] = [
      { derive: { a: '1' } },
      { derive: { b: '2' } },
      { derive: { c: '3' } },
    ];
    const { out, codes } = run(table(['x'], [[1]]), pipeline, { limits });
    expect(codes).toEqual(['MDV4031']);
    expect(names(out)).toEqual(['x', 'a', 'b']);
  });

  it('reports the step names of a pipeline', () => {
    expect(stepNamesOf([{ filter: 'a > 1' }, { limit: 2 }])).toEqual(['filter', 'limit']);
  });
});

describe('filter', () => {
  it('keeps truthy rows and treats null as false', () => {
    const { out, codes } = run(SALES, [{ filter: 'revenue > 100' }]);
    expect(codes).toEqual([]);
    expect(column(out, 'region')).toEqual(['west', 'east']);
  });

  it('reports MDV2111 for an unknown field and keeps every row', () => {
    const { out, codes } = run(SALES, [{ filter: 'profit > 0' }]);
    expect(codes).toEqual(['MDV2111']);
    expect(out.rows).toHaveLength(5);
  });

  it('reports a malformed expression once, through MDV2200', () => {
    const { codes } = run(SALES, [{ filter: 'revenue >' }]);
    expect(codes).toEqual(['MDV2200']);
  });

  it('rejects a non-string parameter with MDV2501', () => {
    const { codes, messages } = run(SALES, [{ filter: 12 } as unknown as TransformStep]);
    expect(codes).toEqual(['MDV2501']);
    expect(messages[0]).toContain('`filter` needs an expression string');
  });
});

describe('derive', () => {
  it('adds a field and infers its type', () => {
    const { out } = run(SALES, [{ derive: { perUnit: 'revenue / units' } }]);
    expect(names(out)).toEqual(['region', 'month', 'revenue', 'units', 'perUnit']);
    expect(column(out, 'perUnit')).toEqual([100 / 3, 50, 30, 50, null]);
    expect(out.fields[4]?.type).toBe('number');
  });

  it('lets a later entry see an earlier one', () => {
    const { out } = run(table(['x'], [[2]]), [{ derive: { a: 'x * 2', b: 'a + 1' } }]);
    expect(column(out, 'a')).toEqual([4]);
    expect(column(out, 'b')).toEqual([5]);
  });

  it('replaces a column in place, keeping its title', () => {
    const input: Table = {
      fields: [{ name: 'revenue', type: 'number', title: 'Revenue (USD)' }],
      rows: [[10], [20]],
    };
    const { out } = run(input, [{ derive: { revenue: 'revenue * 2' } }]);
    expect(names(out)).toEqual(['revenue']);
    expect(out.fields[0]?.title).toBe('Revenue (USD)');
    expect(column(out, 'revenue')).toEqual([20, 40]);
  });

  it('reports MDV2111 when an entry references a field derived later', () => {
    const { out, codes } = run(table(['x'], [[1]]), [{ derive: { b: 'a + 1', a: 'x' } }]);
    expect(codes).toEqual(['MDV2111']);
    expect(names(out)).toEqual(['x', 'a']);
  });

  it('rejects a non-map parameter with MDV2501', () => {
    const { codes } = run(SALES, [{ derive: ['revenue'] } as unknown as TransformStep]);
    expect(codes).toEqual(['MDV2501']);
  });
});

describe('sort', () => {
  it('sorts ascending, descending, and by several keys', () => {
    expect(column(run(SALES, [{ sort: 'revenue' }]).out, 'revenue')).toEqual([
      50,
      100,
      150,
      200,
      null,
    ]);
    expect(column(run(SALES, [{ sort: '-revenue' }]).out, 'revenue')).toEqual([
      200,
      150,
      100,
      50,
      null,
    ]);
    const multi = run(SALES, [{ sort: ['region', '-revenue'] }]).out;
    expect(column(multi, 'region')).toEqual(['east', 'east', 'east', 'west', 'west']);
    expect(column(multi, 'revenue')).toEqual([150, 100, null, 200, 50]);
  });

  it('puts nulls last in both directions', () => {
    const input = table(['a'], [[null], [2], [1]]);
    expect(column(run(input, [{ sort: 'a' }]).out, 'a')).toEqual([1, 2, null]);
    expect(column(run(input, [{ sort: '-a' }]).out, 'a')).toEqual([2, 1, null]);
  });

  it('is stable', () => {
    const input = table(
      ['key', 'id'],
      [
        ['b', 1],
        ['a', 2],
        ['b', 3],
        ['a', 4],
      ],
    );
    expect(column(run(input, [{ sort: 'key' }]).out, 'id')).toEqual([2, 4, 1, 3]);
  });

  it('orders strings by code unit, not by locale', () => {
    const input = table(['a'], [['Z'], ['a'], ['B']]);
    expect(column(run(input, [{ sort: 'a' }]).out, 'a')).toEqual(['B', 'Z', 'a']);
  });

  it('reports MDV2111 for an unknown key and leaves the order alone', () => {
    const { out, codes } = run(SALES, [{ sort: 'profit' }]);
    expect(codes).toEqual(['MDV2111']);
    expect(column(out, 'revenue')).toEqual([100, 200, 150, 50, null]);
  });
});

describe('limit', () => {
  it('slices with a bare count and with an offset', () => {
    expect(run(SALES, [{ limit: 2 }]).out.rows).toHaveLength(2);
    const offset = run(SALES, [{ limit: { n: 2, offset: 3 } }]).out;
    expect(column(offset, 'region')).toEqual(['west', 'east']);
  });

  it('rejects a negative count with MDV2501', () => {
    const { out, codes } = run(SALES, [{ limit: -1 }]);
    expect(codes).toEqual(['MDV2501']);
    expect(out.rows).toHaveLength(5);
  });

  it('rejects a mapping without `n` with MDV2501', () => {
    const { codes } = run(SALES, [{ limit: { offset: 1 } } as unknown as TransformStep]);
    expect(codes).toEqual(['MDV2501']);
  });
});

describe('select and rename', () => {
  it('projects in the listed order', () => {
    const { out } = run(SALES, [{ select: ['units', 'region'] }]);
    expect(names(out)).toEqual(['units', 'region']);
    expect(out.rows[0]).toEqual([3, 'east']);
  });

  it('skips an unknown field with MDV2111 but keeps the rest', () => {
    const { out, codes } = run(SALES, [{ select: ['region', 'profit'] }]);
    expect(codes).toEqual(['MDV2111']);
    expect(names(out)).toEqual(['region']);
  });

  it('leaves the table alone when nothing matched (MDV2501)', () => {
    const { out, codes } = run(SALES, [{ select: ['nope'] }]);
    expect(codes).toEqual(['MDV2111', 'MDV2501']);
    expect(names(out)).toEqual(['region', 'month', 'revenue', 'units']);
  });

  it('renames without moving fields', () => {
    const { out, codes } = run(SALES, [{ rename: { revenue: 'sales' } }]);
    expect(codes).toEqual([]);
    expect(names(out)).toEqual(['region', 'month', 'sales', 'units']);
  });

  it('reports a rename collision with MDV2110 and disambiguates', () => {
    const { out, codes } = run(SALES, [{ rename: { revenue: 'units' } }]);
    expect(codes).toEqual(['MDV2110']);
    expect(names(out)).toEqual(['region', 'month', 'units_2', 'units']);
  });

  it('reports an unknown rename source with MDV2111', () => {
    const { codes } = run(SALES, [{ rename: { profit: 'p' } }]);
    expect(codes).toEqual(['MDV2111']);
  });
});

describe('aggregate', () => {
  it('groups and reduces, keeping first-appearance group order', () => {
    const { out, codes } = run(SALES, [
      { aggregate: { group: ['region'], sum: ['revenue'], count: true } },
    ]);
    expect(codes).toEqual([]);
    expect(names(out)).toEqual(['region', 'revenue', 'count']);
    expect(column(out, 'region')).toEqual(['east', 'west']);
    expect(column(out, 'revenue')).toEqual([250, 250]);
    expect(column(out, 'count')).toEqual([3, 2]);
  });

  it('renames outputs through the map form', () => {
    const { out } = run(SALES, [{ aggregate: { group: ['region'], mean: { avg: 'revenue' } } }]);
    expect(names(out)).toEqual(['region', 'avg']);
    expect(column(out, 'avg')).toEqual([125, 125]);
  });

  it('orders outputs canonically, not by mapping order', () => {
    const byOneOrder = run(SALES, [
      { aggregate: { p95: ['revenue'], count: true, sum: ['revenue'], p50: ['units'] } },
    ]).out;
    const byAnother = run(SALES, [
      { aggregate: { p50: ['units'], sum: ['revenue'], p95: ['revenue'], count: true } },
    ]).out;
    expect(names(byOneOrder)).toEqual(['revenue', 'count', 'units', 'revenue_2']);
    expect(names(byAnother)).toEqual(names(byOneOrder));
  });

  it('computes every aggregator', () => {
    const input = table(
      ['g', 'v'],
      [
        ['a', 1],
        ['a', 2],
        ['a', 3],
        ['a', 4],
      ],
    );
    const { out } = run(input, [
      {
        aggregate: {
          group: ['g'],
          sum: { s: 'v' },
          mean: { m: 'v' },
          median: { md: 'v' },
          min: { lo: 'v' },
          max: { hi: 'v' },
          first: { f: 'v' },
          last: { l: 'v' },
          stddev: { sd: 'v' },
        },
      },
    ]);
    expect(column(out, 's')).toEqual([10]);
    expect(column(out, 'm')).toEqual([2.5]);
    expect(column(out, 'md')).toEqual([2.5]);
    expect(column(out, 'lo')).toEqual([1]);
    expect(column(out, 'hi')).toEqual([4]);
    expect(column(out, 'f')).toEqual([1]);
    expect(column(out, 'l')).toEqual([4]);
    // Sample standard deviation (n − 1): sqrt(5/3).
    expect(column(out, 'sd')[0]).toBeCloseTo(Math.sqrt(5 / 3), 12);
  });

  it('ignores nulls and produces null for an all-null group', () => {
    const input = table(
      ['g', 'v'],
      [
        ['a', null],
        ['a', null],
        ['b', 2],
      ],
    );
    const { out } = run(input, [{ aggregate: { group: ['g'], sum: ['v'], count: true } }]);
    expect(column(out, 'v')).toEqual([null, 2]);
    expect(column(out, 'count')).toEqual([2, 1]);
  });

  it('summarises the whole table when there is no group', () => {
    const { out } = run(SALES, [{ aggregate: { sum: ['revenue'] } }]);
    expect(out.rows).toHaveLength(1);
    expect(column(out, 'revenue')).toEqual([500]);
  });

  it('still produces one summary row for an empty ungrouped table', () => {
    const { out } = run(table(['v'], []), [{ aggregate: { count: true, sum: ['v'] } }]);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toEqual([null, 0]);
  });

  it('produces no rows for an empty grouped table', () => {
    const { out } = run(table(['g', 'v'], []), [{ aggregate: { group: ['g'], count: true } }]);
    expect(out.rows).toHaveLength(0);
  });

  it('reports MDV2502 once per non-numeric field', () => {
    const input = table(
      ['g', 'v'],
      [
        ['a', 'x'],
        ['a', 'y'],
        ['a', 3],
      ],
    );
    const { out, codes } = run(input, [{ aggregate: { group: ['g'], sum: ['v'] } }]);
    expect(codes).toEqual(['MDV2502']);
    expect(column(out, 'v')).toEqual([3]);
  });

  it('types count as integer and min/max from the source column', () => {
    const { out } = run(SALES, [
      { aggregate: { group: ['region'], count: true, min: ['month'], mean: ['revenue'] } },
    ]);
    const typeOf = (name: string): DataType =>
      out.fields.find((field) => field.name === name)?.type ?? 'unknown';
    expect(typeOf('count')).toBe('integer');
    expect(typeOf('month')).toBe('category');
    expect(typeOf('revenue')).toBe('number');
  });

  it('reports MDV2111 for an unknown group or input field', () => {
    expect(run(SALES, [{ aggregate: { group: ['nope'], count: true } }]).codes).toEqual([
      'MDV2111',
    ]);
    expect(run(SALES, [{ aggregate: { group: ['region'], sum: ['nope'] } }]).codes).toEqual([
      'MDV2111',
    ]);
  });

  it('reports MDV2501 when the step does nothing at all', () => {
    const { out, codes } = run(SALES, [{ aggregate: {} }]);
    expect(codes).toEqual(['MDV2501']);
    expect(out.rows).toHaveLength(5);
  });

  it('computes percentiles', () => {
    const input = table(['v'], [[1], [2], [3], [4], [5], [6], [7], [8], [9], [10]]);
    const { out } = run(input, [{ aggregate: { p50: { median: 'v' }, p90: { top: 'v' } } }]);
    expect(column(out, 'median')).toEqual([5.5]);
    expect(column(out, 'top')[0]).toBeCloseTo(9.1, 12);
  });
});

describe('pivot and unpivot', () => {
  it('pivots long to wide with sorted, value-ordered column names', () => {
    const input = table(
      ['g', 'k', 'v'],
      [
        ['a', 10, 1],
        ['a', 2, 2],
        ['b', 10, 3],
      ],
    );
    const { out, codes } = run(input, [{ pivot: { key: 'k', value: 'v', group: 'g' } }]);
    expect(codes).toEqual([]);
    // 2 before 10: sorted by value, not by the rendered name.
    expect(names(out)).toEqual(['g', '2', '10']);
    expect(out.rows).toEqual([
      ['a', 2, 1],
      ['b', null, 3],
    ]);
  });

  it('lets the last row win when a group repeats a key', () => {
    const input = table(
      ['g', 'k', 'v'],
      [
        ['a', 'x', 1],
        ['a', 'x', 2],
      ],
    );
    const { out } = run(input, [{ pivot: { key: 'k', value: 'v', group: 'g' } }]);
    expect(out.rows).toEqual([['a', 2]]);
  });

  it('pivots without a group into a single row', () => {
    const input = table(
      ['k', 'v'],
      [
        ['x', 1],
        ['y', 2],
      ],
    );
    const { out } = run(input, [{ pivot: { key: 'k', value: 'v' } }]);
    expect(names(out)).toEqual(['x', 'y']);
    expect(out.rows).toEqual([[1, 2]]);
  });

  it('reports MDV2111 for unknown pivot fields', () => {
    expect(run(SALES, [{ pivot: { key: 'nope', value: 'revenue' } }]).codes).toEqual(['MDV2111']);
    expect(
      run(SALES, [{ pivot: { key: 'month', value: 'revenue', group: 'nope' } }]).codes,
    ).toEqual(['MDV2111']);
  });

  it('unpivots wide to long with default key and value names', () => {
    const input = table(
      ['id', 'jan', 'feb'],
      [
        ['a', 1, 2],
        ['b', 3, 4],
      ],
    );
    const { out } = run(input, [{ unpivot: { fields: ['jan', 'feb'] } }]);
    expect(names(out)).toEqual(['id', 'key', 'value']);
    expect(out.rows).toEqual([
      ['a', 'jan', 1],
      ['a', 'feb', 2],
      ['b', 'jan', 3],
      ['b', 'feb', 4],
    ]);
  });

  it('honours custom key and value names', () => {
    const input = table(['id', 'jan'], [['a', 1]]);
    const { out } = run(input, [{ unpivot: { fields: ['jan'], key: 'month', value: 'amount' } }]);
    expect(names(out)).toEqual(['id', 'month', 'amount']);
  });

  it('leaves the table alone when unpivot matches nothing', () => {
    const { out, codes } = run(SALES, [{ unpivot: { fields: ['nope'] } }]);
    expect(codes).toEqual(['MDV2111', 'MDV2501']);
    expect(names(out)).toEqual(['region', 'month', 'revenue', 'units']);
  });

  it('rejects a malformed pivot or unpivot with MDV2501', () => {
    expect(run(SALES, [{ pivot: { key: 'month' } } as unknown as TransformStep]).codes).toEqual([
      'MDV2501',
    ]);
    expect(
      run(SALES, [{ unpivot: { fields: 'revenue' } } as unknown as TransformStep]).codes,
    ).toEqual(['MDV2501']);
  });
});

describe('bin', () => {
  it('bins by step, anchored at the minimum, writing the lower edge', () => {
    const input = table(['v'], [[10], [12], [17], [25]]);
    const { out } = run(input, [{ bin: { field: 'v', step: 5 } }]);
    expect(names(out)).toEqual(['v', 'v_bin']);
    expect(column(out, 'v_bin')).toEqual([10, 10, 15, 25]);
  });

  it('prefers `step` over `count`', () => {
    const input = table(['v'], [[0], [10]]);
    const byBoth = run(input, [{ bin: { field: 'v', step: 5, count: 2 } }]).out;
    expect(column(byBoth, 'v_bin')).toEqual([0, 10]);
  });

  it('derives a step from `count`', () => {
    const input = table(['v'], [[0], [5], [9]]);
    const { out } = run(input, [{ bin: { field: 'v', count: 3, output: 'b' } }]);
    expect(column(out, 'b')).toEqual([0, 3, 9]);
  });

  it('keeps fractional edges clean', () => {
    const input = table(['v'], [[0.1], [0.35], [0.7]]);
    const { out } = run(input, [{ bin: { field: 'v', step: 0.1 } }]);
    expect(column(out, 'v_bin')).toEqual([0.1, 0.3, 0.7]);
  });

  it('bins temporal values back into dates', () => {
    const input: Table = {
      fields: [{ name: 't', type: 'datetime' }],
      rows: [
        [new Date('2026-01-01T00:00:00Z')],
        [new Date('2026-01-01T00:00:30Z')],
        [new Date('2026-01-01T00:02:00Z')],
      ],
    };
    const { out } = run(input, [{ bin: { field: 't', step: 60_000 } }]);
    const edges = column(out, 't_bin').map((value) => (value as Date).toISOString());
    expect(edges).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:02:00.000Z',
    ]);
  });

  it('passes nulls through as nulls', () => {
    const input = table(['v'], [[1], [null]]);
    expect(column(run(input, [{ bin: { field: 'v', step: 1 } }]).out, 'v_bin')).toEqual([1, null]);
  });

  it('reports MDV2502 when there is nothing numeric to bin', () => {
    const input = table(['v'], [['a'], ['b']]);
    const { out, codes } = run(input, [{ bin: { field: 'v', step: 1 } }]);
    expect(codes).toEqual(['MDV2502']);
    expect(names(out)).toEqual(['v']);
  });

  it('reports MDV2501 without a positive step or count, and MDV2111 for a bad field', () => {
    expect(run(table(['v'], [[1]]), [{ bin: { field: 'v' } }]).codes).toEqual(['MDV2501']);
    expect(run(table(['v'], [[1]]), [{ bin: { field: 'nope', step: 1 } }]).codes).toEqual([
      'MDV2111',
    ]);
  });
});

describe('window', () => {
  const series = table(
    ['g', 'v'],
    [
      ['a', 1],
      ['a', 2],
      ['a', 3],
      ['b', 10],
      ['b', 20],
    ],
  );

  const windowed = (op: string, size = 2, partition?: string): Value[] => {
    const { out } = run(series, [
      {
        window: {
          op: op as 'sum',
          field: 'v',
          size,
          output: 'w',
          ...(partition !== undefined ? { partition } : {}),
        },
      },
    ]);
    return column(out, 'w');
  };

  it('computes a trailing sum, mean and count', () => {
    expect(windowed('sum')).toEqual([1, 3, 5, 13, 30]);
    expect(windowed('mean')).toEqual([1, 1.5, 2.5, 6.5, 15]);
    expect(windowed('count')).toEqual([1, 2, 2, 2, 2]);
  });

  it('computes trailing min and max', () => {
    expect(windowed('min')).toEqual([1, 1, 2, 3, 10]);
    expect(windowed('max')).toEqual([1, 2, 3, 10, 20]);
  });

  it('partitions, so a running total restarts per group', () => {
    expect(windowed('cumsum', 1, 'g')).toEqual([1, 3, 6, 10, 30]);
    expect(windowed('sum', 2, 'g')).toEqual([1, 3, 5, 10, 30]);
  });

  it('computes delta, pct_change, lag and lead', () => {
    expect(windowed('delta', 1, 'g')).toEqual([null, 1, 1, null, 10]);
    expect(windowed('pct_change', 1, 'g')).toEqual([null, 1, 0.5, null, 1]);
    expect(windowed('lag', 1, 'g')).toEqual([null, 1, 2, null, 10]);
    expect(windowed('lead', 1, 'g')).toEqual([2, 3, null, 20, null]);
  });

  it('ranks with ties sharing a place and nulls unranked', () => {
    const input = table(['v'], [[5], [1], [5], [null], [3]]);
    const { out } = run(input, [{ window: { op: 'rank', field: 'v', size: 1, output: 'r' } }]);
    expect(column(out, 'r')).toEqual([3, 1, 3, null, 2]);
  });

  it('replaces the output column when it already exists', () => {
    const input = table(['v'], [[1], [2]]);
    const { out } = run(input, [{ window: { op: 'cumsum', field: 'v', size: 1, output: 'v' } }]);
    expect(names(out)).toEqual(['v']);
    expect(column(out, 'v')).toEqual([1, 3]);
  });

  it('reports a size below 1 with MDV2501 and uses 1', () => {
    const input = table(['v'], [[1], [2]]);
    const { out, codes } = run(input, [
      { window: { op: 'sum', field: 'v', size: 0, output: 'w' } },
    ]);
    expect(codes).toEqual(['MDV2501']);
    expect(column(out, 'w')).toEqual([1, 2]);
  });

  it('reports MDV2111 for an unknown field or partition', () => {
    expect(
      run(series, [{ window: { op: 'sum', field: 'nope', size: 1, output: 'w' } }]).codes,
    ).toEqual(['MDV2111']);
    expect(
      run(series, [{ window: { op: 'sum', field: 'v', size: 1, output: 'w', partition: 'nope' } }])
        .codes,
    ).toEqual(['MDV2111']);
  });

  it('rejects an unknown op with MDV2501', () => {
    const { codes } = run(series, [
      { window: { op: 'ewma', field: 'v', size: 1, output: 'w' } } as unknown as TransformStep,
    ]);
    expect(codes).toEqual(['MDV2501']);
  });
});

describe('join', () => {
  const targets = table(
    ['region', 'target'],
    [
      ['east', 500],
      ['west', 400],
    ],
  );
  const lookup = (reference: string): Table | undefined =>
    reference === '@targets' ? targets : undefined;

  it('left-joins by default, padding unmatched rows with null', () => {
    const left = table(['region'], [['east'], ['north']]);
    const { out, codes } = run(left, [{ join: { with: '@targets', on: 'region' } }], { lookup });
    expect(codes).toEqual([]);
    expect(names(out)).toEqual(['region', 'target']);
    expect(out.rows).toEqual([
      ['east', 500],
      ['north', null],
    ]);
  });

  it('drops unmatched rows for an inner join', () => {
    const left = table(['region'], [['east'], ['north']]);
    const { out } = run(left, [{ join: { with: '@targets', on: 'region', how: 'inner' } }], {
      lookup,
    });
    expect(out.rows).toEqual([['east', 500]]);
  });

  it('joins on differently named keys and drops the right key column', () => {
    const left = table(['area'], [['west']]);
    const { out } = run(
      left,
      [{ join: { with: '@targets', on: { left: 'area', right: 'region' } } }],
      { lookup },
    );
    expect(names(out)).toEqual(['area', 'target']);
    expect(out.rows).toEqual([['west', 400]]);
  });

  it('multiplies rows when the right side has duplicates', () => {
    const many = table(
      ['region', 'rep'],
      [
        ['east', 'a'],
        ['east', 'b'],
      ],
    );
    const left = table(['region'], [['east']]);
    const { out } = run(left, [{ join: { with: '@many', on: 'region' } }], {
      lookup: (reference) => (reference === '@many' ? many : undefined),
    });
    expect(out.rows).toEqual([
      ['east', 'a'],
      ['east', 'b'],
    ]);
  });

  it('disambiguates a colliding right-hand field name', () => {
    const right = table(['region', 'units'], [['east', 9]]);
    const left = table(['region', 'units'], [['east', 1]]);
    const { out } = run(left, [{ join: { with: '@r', on: 'region' } }], {
      lookup: (reference) => (reference === '@r' ? right : undefined),
    });
    expect(names(out)).toEqual(['region', 'units', 'units_2']);
    expect(out.rows).toEqual([['east', 1, 9]]);
  });

  it('reports MDV2142 without a registry or for an unresolved reference', () => {
    const left = table(['region'], [['east']]);
    expect(run(left, [{ join: { with: '@targets', on: 'region' } }]).codes).toEqual(['MDV2142']);
    expect(run(left, [{ join: { with: '@absent', on: 'region' } }], { lookup }).codes).toEqual([
      'MDV2142',
    ]);
  });

  it('reports MDV2111 when a key is missing on either side', () => {
    const left = table(['region'], [['east']]);
    expect(run(left, [{ join: { with: '@targets', on: 'nope' } }], { lookup }).codes).toEqual([
      'MDV2111',
    ]);
    expect(
      run(left, [{ join: { with: '@targets', on: { left: 'region', right: 'nope' } } }], { lookup })
        .codes,
    ).toEqual(['MDV2111']);
  });

  it('rejects a malformed join with MDV2501', () => {
    const left = table(['region'], [['east']]);
    expect(run(left, [{ join: { with: '@targets' } } as unknown as TransformStep]).codes).toEqual([
      'MDV2501',
    ]);
  });
});

describe('resource limits (SPEC 13.6)', () => {
  it('truncates rows past maxRowsPerBlock with MDV4031', () => {
    const limits = { ...effectiveLimits(), maxRowsPerBlock: 2 };
    const input = table(['v'], [[1], [2], [3], [4]]);
    const { out, codes } = run(input, [{ sort: 'v' }], { limits });
    expect(codes).toEqual(['MDV4031']);
    expect(out.rows).toHaveLength(2);
  });

  it('truncates fields past maxFieldsPerTable with MDV4031', () => {
    const limits = { ...effectiveLimits(), maxFieldsPerTable: 2 };
    const input = table(['a', 'b'], [[1, 2]]);
    const { out, codes } = run(input, [{ derive: { c: 'a + b' } }], { limits });
    expect(codes).toEqual(['MDV4031']);
    expect(names(out)).toEqual(['a', 'b']);
  });

  it('truncates on the cell budget with MDV4031', () => {
    const limits = { ...effectiveLimits(), maxCellsPerTable: 4 };
    const input = table(
      ['a', 'b'],
      [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    );
    const { out, codes } = run(input, [{ sort: 'a' }], { limits });
    expect(codes).toEqual(['MDV4031']);
    expect(out.rows).toHaveLength(2);
  });
});

describe('pipelineKey (SPEC 6.7 memoisation)', () => {
  it('is empty for an absent or empty pipeline', () => {
    expect(pipelineKey(undefined)).toBe('');
    expect(pipelineKey([])).toBe('');
  });

  it('is stable across mapping key order but sensitive to step order', () => {
    const a: TransformStep[] = [{ aggregate: { group: ['g'], sum: ['v'], count: true } }];
    const b: TransformStep[] = [{ aggregate: { count: true, sum: ['v'], group: ['g'] } }];
    expect(pipelineKey(a)).toBe(pipelineKey(b));
    expect(pipelineKey([{ limit: 1 }, { sort: 'v' }])).not.toBe(
      pipelineKey([{ sort: 'v' }, { limit: 1 }]),
    );
  });

  it('separates pipelines that differ in a value', () => {
    expect(pipelineKey([{ limit: 1 }])).not.toBe(pipelineKey([{ limit: 2 }]));
    expect(pipelineKey([{ filter: 'a > 1' }])).not.toBe(pipelineKey([{ filter: 'a > 2' }]));
  });

  it('ignores explicit undefined members', () => {
    // Deliberately explicit `undefined` — models a JS/JSON caller. Cast is required
    // under exactOptionalPropertyTypes; the tolerance being asserted is a runtime one.
    expect(
      pipelineKey([
        { bin: { field: 'v', step: 1, output: undefined } } as unknown as TransformStep,
      ]),
    ).toBe(pipelineKey([{ bin: { field: 'v', step: 1 } }]));
  });
});

describe('determinism (SPEC 24.3)', () => {
  it('produces identical output for identical input, twice', () => {
    const pipeline: TransformStep[] = [
      { derive: { perUnit: 'revenue / units' } },
      { filter: 'perUnit != null' },
      { aggregate: { group: ['region'], mean: { avg: 'perUnit' }, count: true } },
      { sort: ['-avg', 'region'] },
    ];
    const first = run(SALES, pipeline).out;
    const second = run(SALES, pipeline).out;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not depend on the insertion order of derive keys for the values it computes', () => {
    const input = table(['x'], [[1], [2]]);
    const { out } = run(input, [{ derive: { a: 'x + 1', b: 'x + 2' } }]);
    expect(out.rows).toEqual([
      [1, 2, 3],
      [2, 3, 4],
    ]);
  });

  it('applies a single step directly, for embedders that drive the pipeline themselves', () => {
    const ctx = context();
    const out = applyStep(SALES, { limit: 1 }, ctx);
    expect(out.rows).toHaveLength(1);
    expect(ctx.diag.diagnostics).toHaveLength(0);
  });
});

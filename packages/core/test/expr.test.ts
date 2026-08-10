import { describe, expect, it } from 'vitest';
import { createCollector } from '../src/data/diag.js';
import {
  compileExpression,
  createFieldIndex,
  groupScope,
  rowScope,
  runExpression,
  runExpressionOnce,
  type ExprValue,
} from '../src/expr/index.js';
import type { RunContext } from '../src/expr/index.js';
import type { Table, Value } from '../src/types/data.js';

const BUILD_TIME = new Date('2026-08-10T12:00:00Z');

function context(diag = createCollector('data')): RunContext {
  return {
    diag,
    zone: 'UTC',
    buildTime: BUILD_TIME,
    aggregate: false,
    format: { locale: 'en-US', timezone: 'UTC', buildTime: BUILD_TIME },
  };
}

/** Compile and evaluate against one row given as a plain record. */
function evaluate(
  source: string,
  row: Readonly<Record<string, Value>> = {},
  options: { aggregate?: boolean } = {},
): { value: ExprValue; codes: string[] } {
  const diag = createCollector('data');
  const compiled = compileExpression(source, diag, options);
  if (compiled === undefined) {
    return { value: null, codes: diag.diagnostics.map((d) => d.code) };
  }
  const names = Object.keys(row);
  const table: Table = {
    fields: names.map((name) => ({ name, type: 'unknown' as const })),
    rows: [names.map((name) => row[name] ?? null)],
  };
  const [value] = runExpression(compiled, table, { ...context(diag) });
  return { value: value ?? null, codes: diag.diagnostics.map((d) => d.code) };
}

const value = (source: string, row?: Readonly<Record<string, Value>>): ExprValue =>
  evaluate(source, row).value;

describe('grammar and precedence (SPEC 6.8.1)', () => {
  it('parses literals', () => {
    expect(value('1')).toBe(1);
    expect(value('1.5e2')).toBe(150);
    expect(value("'hi'")).toBe('hi');
    expect(value('"hi"')).toBe('hi');
    expect(value('true')).toBe(true);
    expect(value('false')).toBe(false);
    expect(value('null')).toBeNull();
  });

  it('applies arithmetic precedence', () => {
    expect(value('1 + 2 * 3')).toBe(7);
    expect(value('(1 + 2) * 3')).toBe(9);
    expect(value('10 - 2 - 3')).toBe(5);
    expect(value('7 % 3')).toBe(1);
  });

  it('makes `**` right-associative and tighter than unary minus', () => {
    expect(value('2 ** 3 ** 2')).toBe(512);
    expect(value('-2 ** 2')).toBe(-4);
  });

  it('binds comparison below arithmetic and logic below comparison', () => {
    expect(value('1 + 1 == 2')).toBe(true);
    expect(value('1 < 2 && 3 > 2')).toBe(true);
    expect(value('false || 1 < 2')).toBe(true);
  });

  it('parses a ternary, including nesting on the right', () => {
    expect(value("1 < 2 ? 'a' : 'b'")).toBe('a');
    expect(value("false ? 'a' : true ? 'b' : 'c'")).toBe('b');
  });

  it('reads bracketed field names with spaces and punctuation', () => {
    expect(value('[Net revenue (USD)] * 2', { 'Net revenue (USD)': 21 })).toBe(42);
  });

  it('builds list literals and tests membership', () => {
    expect(value("'a' in ['a', 'b']")).toBe(true);
    expect(value("'c' in ['a', 'b']")).toBe(false);
    expect(value("['a', 'b'] contains 'b'")).toBe(true);
    expect(value("'ell' in 'hello'")).toBe(true);
  });

  it('reports a malformed expression as MDV2200 rather than throwing', () => {
    expect(evaluate('1 +').codes).toEqual(['MDV2200']);
    expect(evaluate("'unterminated").codes).toEqual(['MDV2200']);
    expect(evaluate('1 @ 2').codes).toEqual(['MDV2200']);
    expect(evaluate('(1').codes).toEqual(['MDV2200']);
  });
});

describe('null propagation and coercion (SPEC 6.8.3)', () => {
  it('propagates null through arithmetic and comparison', () => {
    expect(value('x + 1', { x: null })).toBeNull();
    expect(value('x * 2', { x: null })).toBeNull();
    expect(value('x < 1', { x: null })).toBeNull();
    expect(value('-x', { x: null })).toBeNull();
  });

  it('treats null as falsy, and `==` on two nulls as true', () => {
    expect(value('x ? 1 : 2', { x: null })).toBe(2);
    expect(value('x == null', { x: null })).toBe(true);
    expect(value('x != null', { x: 1 })).toBe(true);
  });

  it("refuses '1' + 1 with MDV2210 and yields null", () => {
    const result = evaluate("'1' + 1");
    expect(result.value).toBeNull();
    expect(result.codes).toEqual(['MDV2210']);
  });

  it('concatenates two strings with +', () => {
    expect(value("'a' + 'b'")).toBe('ab');
  });

  it('refuses to order a string against a number', () => {
    const result = evaluate("'a' < 1");
    expect(result.value).toBeNull();
    expect(result.codes).toEqual(['MDV2210']);
  });

  it('emits one diagnostic per expression, not per row', () => {
    const diag = createCollector('data');
    const compiled = compileExpression("a + 'x'", diag);
    expect(compiled).toBeDefined();
    const table: Table = {
      fields: [{ name: 'a', type: 'number' }],
      rows: Array.from({ length: 500 }, (_, i) => [i]),
    };
    const out = runExpression(compiled!, table, context(diag));
    expect(out).toHaveLength(500);
    expect(out.every((v) => v === null)).toBe(true);
    expect(diag.diagnostics.filter((d) => d.code === 'MDV2210')).toHaveLength(1);
    expect(diag.diagnostics[0]?.detail).toContain('500 values became null');
  });

  it('yields null rather than Infinity for division by zero', () => {
    expect(value('1 / 0')).toBeNull();
    expect(value('1 % 0')).toBeNull();
  });

  it('reports an unknown field once, as MDV2111', () => {
    const result = evaluate('missing + 1', { present: 1 });
    expect(result.value).toBeNull();
    expect(result.codes).toContain('MDV2111');
  });
});

describe('function whitelist (SPEC 6.8.2)', () => {
  it('rejects an unknown function with MDV2220', () => {
    expect(evaluate('danger(1)').codes).toEqual(['MDV2220']);
  });

  it('cannot reach a host object', () => {
    // No member access exists in the grammar, so these are field names at most.
    expect(evaluate('constructor("return 1")').codes).toEqual(['MDV2220']);
    expect(evaluate('eval("1")').codes).toEqual(['MDV2220']);
    expect(value('constructor')).toBeNull();
    expect(evaluate('a.b').codes).toEqual(['MDV2200']);
  });

  it('checks arity at compile time', () => {
    expect(evaluate('abs()').codes).toEqual(['MDV2200']);
    expect(evaluate('abs(1, 2)').codes).toEqual(['MDV2200']);
  });

  it('computes math functions with null propagation', () => {
    expect(value('abs(-3)')).toBe(3);
    expect(value('round(2.5)')).toBe(3);
    expect(value('round(-2.5)')).toBe(-3);
    expect(value('clamp(11, 0, 10)')).toBe(10);
    expect(value('pow(2, 10)')).toBe(1024);
    expect(value('min(3, 1, 2)')).toBe(1);
    expect(value('max(3, 1, 2)')).toBe(3);
    expect(value('sqrt(x)', { x: null })).toBeNull();
    expect(value('sqrt(-1)')).toBeNull();
  });

  it('computes string functions', () => {
    expect(value("upper('ab')")).toBe('AB');
    expect(value("trim('  a ')")).toBe('a');
    expect(value("len('abc')")).toBe(3);
    expect(value("startsWith('abc', 'ab')")).toBe(true);
    expect(value("endsWith('abc', 'bc')")).toBe(true);
    expect(value("contains('abc', 'b')")).toBe(true);
    expect(value("replace('a-b-c', '-', '+')")).toBe('a+b+c');
    expect(value("split('a,b', ',')")).toEqual(['a', 'b']);
    expect(value("substr('abcdef', 1, 3)")).toBe('bcd');
    expect(value("concat('a', 'b', 'c')")).toBe('abc');
    expect(value("pad('7', 3, '0')")).toBe('007');
    expect(value("pad('7', -3, '0')")).toBe('700');
  });

  it('never lets `replace` be a regular expression', () => {
    expect(value("replace('a.b.c', '.', '-')")).toBe('a-b-c');
  });

  it('computes logic functions', () => {
    expect(value("if(1 < 2, 'yes', 'no')")).toBe('yes');
    expect(value('coalesce(x, y, 3)', { x: null, y: null })).toBe(3);
    expect(value('isNull(x)', { x: null })).toBe(true);
    expect(value('isNumber(x)', { x: 1 })).toBe(true);
    expect(value('isString(x)', { x: 'a' })).toBe(true);
    expect(value("toNumber('1 234.5')")).toBe(1234.5);
    expect(value("toNumber('nope')")).toBeNull();
    expect(value('toString(12)')).toBe('12');
  });

  it('parses ISO 8601 in toDate and refuses other layouts', () => {
    const parsed = value("toDate('2026-03-01')");
    expect(parsed).toBeInstanceOf(Date);
    expect((parsed as Date).toISOString()).toBe('2026-03-01T00:00:00.000Z');
    expect(value("toDate('01/03/2026')")).toBeNull();
  });

  it('formats through the built-in formatter', () => {
    expect(value("format(1240, ',.0f')")).toBe('1,240');
    expect(value("format(0.124, '.1%')")).toBe('12.4%');
  });
});

describe('temporal functions (SPEC 6.8.2)', () => {
  const row = { d: new Date('2026-03-09T15:30:45.500Z') };

  it('extracts components in the document zone', () => {
    expect(value('year(d)', row)).toBe(2026);
    expect(value('quarter(d)', row)).toBe(1);
    expect(value('month(d)', row)).toBe(3);
    expect(value('day(d)', row)).toBe(9);
    expect(value('hour(d)', row)).toBe(15);
    expect(value('minute(d)', row)).toBe(30);
    expect(value('second(d)', row)).toBe(45);
    expect(value('dayOfWeek(d)', row)).toBe(1);
    expect(value('week(d)', row)).toBe(11);
  });

  it('truncates and adds on the calendar', () => {
    const month = value("dateTrunc('month', d)", row) as Date;
    expect(month.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    const week = value("dateTrunc('week', d)", row) as Date;
    expect(week.toISOString()).toBe('2026-03-09T00:00:00.000Z');
    const quarter = value("dateTrunc('quarter', d)", row) as Date;
    expect(quarter.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('clamps the day when adding months', () => {
    const jan31 = { d: new Date('2026-01-31T00:00:00Z') };
    const feb = value("dateAdd(d, 'month', 1)", jan31) as Date;
    expect(feb.toISOString()).toBe('2026-02-28T00:00:00.000Z');
  });

  it('counts whole units in dateDiff', () => {
    const both = { a: new Date('2026-01-31T00:00:00Z'), b: new Date('2026-02-28T00:00:00Z') };
    expect(value("dateDiff('month', a, b)", both)).toBe(0);
    expect(value("dateDiff('day', a, b)", both)).toBe(28);
  });

  it('returns the build time from now(), never the clock', () => {
    const first = value('now()') as Date;
    const second = value('now()') as Date;
    expect(first.toISOString()).toBe(BUILD_TIME.toISOString());
    expect(second.getTime()).toBe(first.getTime());
  });
});

describe('aggregate context (SPEC 6.8.2)', () => {
  const table: Table = {
    fields: [
      { name: 'region', type: 'category' },
      { name: 'revenue', type: 'number' },
    ],
    rows: [
      ['APAC', 10],
      ['APAC', 20],
      ['EMEA', 30],
      ['EMEA', null],
    ],
  };

  function aggregate(source: string): ExprValue {
    const diag = createCollector('data');
    const compiled = compileExpression(source, diag, { aggregate: true });
    expect(compiled, diag.diagnostics.map((d) => d.code).join(',')).toBeDefined();
    const scope = groupScope(createFieldIndex(table.fields), table.rows);
    return runExpressionOnce(compiled!, scope, { ...context(diag), aggregate: true });
  }

  it('reads a field as the whole column', () => {
    expect(aggregate('sum(revenue)')).toBe(60);
    expect(aggregate('mean(revenue)')).toBe(20);
    expect(aggregate('median(revenue)')).toBe(20);
    expect(aggregate('count(revenue)')).toBe(3);
    expect(aggregate('countDistinct(region)')).toBe(2);
    expect(aggregate('mode(region)')).toBe('APAC');
    expect(aggregate('p50(revenue)')).toBe(20);
  });

  it('computes a sample standard deviation', () => {
    expect(aggregate('stddev(revenue)')).toBeCloseTo(10, 10);
    expect(aggregate('variance(revenue)')).toBeCloseTo(100, 10);
  });

  it('refuses a stats function in a row context', () => {
    expect(evaluate('sum(revenue)', { revenue: 1 }).codes).toEqual(['MDV2200']);
  });
});

describe('limits (SPEC 13.6)', () => {
  it('rejects an over-long expression with MDV4030', () => {
    const long = `1 + ${'1 + '.repeat(400)}1`;
    expect(long.length).toBeGreaterThan(1024);
    expect(evaluate(long).codes).toEqual(['MDV4030']);
  });

  it('rejects an over-deep expression with MDV4030', () => {
    // Parentheses only group; nesting has to be real to count against the limit.
    const deep = `${'-'.repeat(40)}1`;
    expect(evaluate(deep).codes).toEqual(['MDV4030']);
    expect(evaluate(`${'-'.repeat(4)}1`).codes).toEqual([]);
  });

  it('rejects too many calls with MDV4030', () => {
    const calls = Array.from({ length: 70 }, () => 'abs(1)').join(' + ');
    expect(evaluate(calls).codes).toEqual(['MDV4030']);
  });

  it('honours a lowered embedder limit', () => {
    const diag = createCollector('data');
    const compiled = compileExpression('1 + 1', diag, {
      limits: { maxExpressionChars: 3, maxExpressionDepth: 32, maxExpressionCalls: 64 },
    });
    expect(compiled).toBeUndefined();
    expect(diag.diagnostics[0]?.code).toBe('MDV4030');
  });
});

describe('determinism', () => {
  it('evaluates identically twice over the same table', () => {
    const table: Table = {
      fields: [
        { name: 'a', type: 'number' },
        { name: 'b', type: 'number' },
      ],
      rows: [
        [1, 2],
        [3, 4],
      ],
    };
    const diag = createCollector('data');
    const compiled = compileExpression('a * 10 + b', diag);
    const first = runExpression(compiled!, table, context(diag));
    const second = runExpression(compiled!, table, context(diag));
    expect(first).toEqual(second);
    expect(first).toEqual([12, 34]);
  });

  it('exposes the fields an expression reads, in order', () => {
    const diag = createCollector('data');
    const compiled = compileExpression('b + a + b', diag);
    expect(compiled?.fields).toEqual(['b', 'a']);
  });

  it('reads a row scope by field name', () => {
    const index = createFieldIndex([
      { name: 'a', type: 'number' },
      { name: 'b', type: 'number' },
    ]);
    const scope = rowScope(index, [1, 2]);
    expect(scope.read('b')).toBe(2);
    expect(scope.read('missing')).toBeUndefined();
  });
});

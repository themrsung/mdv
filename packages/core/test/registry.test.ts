import { describe, expect, it } from 'vitest';
import { createChartRegistry, createDiagnostic, STATUS_PALETTE } from '@mdv/core';
import type { ChartType, EncodeResult, Rect } from '@mdv/core';

/** A minimal stand-in for a real chart type; @mdv/charts supplies the real ones. */
function stubType(name: string, aliases?: readonly string[]): ChartType {
  const type: ChartType = {
    name,
    level: 1,
    family: 'mark',
    channels: [],
    defaultEncoding: {},
    validate: () => [],
    encode: () => ({ marks: [], series: [], scales: {}, axes: [] }),
    layout: (_encoded: EncodeResult, _frame: Rect) => ({ nodes: [], hits: [] }),
  };
  return aliases === undefined ? type : { ...type, aliases };
}

describe('chart type registry', () => {
  it('registers, gets and reports membership', () => {
    const registry = createChartRegistry([stubType('bar')]);
    expect(registry.has('bar')).toBe(true);
    expect(registry.get('bar')?.name).toBe('bar');
    expect(registry.get('nope')).toBeUndefined();
  });

  it('resolves aliases', () => {
    const registry = createChartRegistry([stubType('ohlcv', ['candlestick'])]);
    expect(registry.get('candlestick')?.name).toBe('ohlcv');
  });

  it('lists deterministically, sorted by name', () => {
    const registry = createChartRegistry([stubType('scatter'), stubType('area'), stubType('bar')]);
    expect(registry.list().map((t) => t.name)).toEqual(['area', 'bar', 'scatter']);
  });

  it('lets a later registration override an earlier one (SPEC 26.2)', () => {
    const registry = createChartRegistry([stubType('bar')]);
    const override = { ...stubType('bar'), level: 3 as const };
    registry.register(override);
    expect(registry.get('bar')?.level).toBe(3);
  });

  it('isolates child registries from the parent (SPEC 17.3 invariant 4)', () => {
    const parent = createChartRegistry([stubType('bar')]);
    const child = parent.extend();
    child.register(stubType('sankey'));
    expect(child.has('sankey')).toBe(true);
    expect(parent.has('sankey')).toBe(false);
    expect(child.has('bar')).toBe(true);
  });

  it('refuses registration once frozen', () => {
    const registry = createChartRegistry();
    registry.freeze();
    expect(registry.frozen).toBe(true);
    expect(() => registry.register(stubType('bar'))).toThrow(/frozen/);
  });
});

describe('diagnostics', () => {
  it('takes severity and fallback text from the Appendix C table', () => {
    const d = createDiagnostic('MDV3021', {
      range: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 1, line: 1, column: 2 } },
      source: 'encode',
    });
    expect(d.severity).toBe('warning');
    expect(d.message).toContain('does not include zero');
    expect(d.detail).toBeUndefined();
  });
});

describe('theme constants', () => {
  it('pins the status palette (SPEC 11.3.1)', () => {
    expect(STATUS_PALETTE.good).toBe('#0ca30c');
    expect(STATUS_PALETTE.critical).toBe('#d03b3b');
  });
});

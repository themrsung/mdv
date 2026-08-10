/**
 * `metric` — the stat tile (SPEC 8.13), asserted numerically.
 *
 * Every coordinate below is recomputable from the harness theme and the stub
 * text metrics, so nothing here is a golden file:
 *
 * - the stub measures `width = length × size × 0.6`, `ascent = 0.8 × size`,
 *   `descent = 0.2 × size`;
 * - the label font is `tickScale` of the base: `13 × 0.85 = 11.05`;
 * - a normal figure is `max(13 × 1.2 × 1.2, 20) = 20`, a hero one
 *   `max(48, 13 × 1.2 × 1.6) = 48` — the ≥ 48 px floor of SPEC 8.13;
 * - text is laid on the alphabetic baseline, so each line's `y` is the running
 *   cursor plus that line's ascent, and the gap between lines is 4.
 *
 * For the `Revenue / 1,400,000 / -8.2% vs. last month` tile on the standard
 * 400 × 200 frame that gives label baseline 8.84, figure baseline 31.05, and a
 * delta set beside the figure at x = 108 + 8 = 116.
 */

import { describe, expect, it } from 'vitest';
import { metricChart } from '../src/metric.js';
import { EMPTY_TABLE, attrsOf, codesOf, makeTable, nodesOfKind, nonFiniteNumbers, noRows, runChart } from './harness.js';

/** Four months of revenue, so `last`, `sum` and friends all differ. */
function months() {
  return makeTable(
    [
      ['month', 'string'],
      ['revenue', 'number'],
    ],
    [
      ['Jan', 100],
      ['Feb', 200],
      ['Mar', 300],
      ['Apr', 400],
    ],
  );
}

function texts(run: ReturnType<typeof runChart>) {
  return nodesOfKind(run.laid.nodes, 'text');
}

function textOf(run: ReturnType<typeof runChart>, cls: string) {
  return texts(run).find((node) => node.cls === cls);
}

describe('metric: the figure', () => {
  it('takes a literal number and compacts it for reading', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1_400_000 } });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('1,400,000');
  });

  it('honours an explicit format over the automatic one', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: attrsOf({ value: 1_400_000, format: '.2s' }) });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('1.4M');
  });

  it('reads a bound column as "where it stands now", not as a total', () => {
    const run = runChart(metricChart, months(), { encoding: { value: { field: 'revenue' } } });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('400');
  });

  it('aggregates when asked, in the spelling authors actually write', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['sum(revenue)', '1,000'],
      ['mean(revenue)', '250'],
      ['avg(revenue)', '250'],
      ['min(revenue)', '100'],
      ['max(revenue)', '400'],
      ['count(revenue)', '4'],
      ['first(revenue)', '100'],
      ['last(revenue)', '400'],
    ];
    for (const [expression, expected] of cases) {
      const run = runChart(metricChart, months(), { attrs: { value: expression } });
      expect(textOf(run, 'mdv-metric-value')?.text, expression).toBe(expected);
    }
  });

  it('takes the aggregate from the channel too', () => {
    const run = runChart(metricChart, months(), { encoding: { value: { field: 'revenue', aggregate: 'sum' } } });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('1,000');
  });

  it('shows an em dash rather than NaN when the number cannot be found', () => {
    const run = runChart(metricChart, months(), { attrs: { value: 'nonesuch' } });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('—');
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('insists on a value: a tile with no number is not a tile (MDV3000)', () => {
    expect(codesOf(runChart(metricChart, months(), {}).validation)).toEqual(['MDV3000']);
  });

  it('says so when the named column is not there', () => {
    const run = runChart(metricChart, months(), { encoding: { value: { field: 'profit' } } });
    expect(codesOf(run.validation)).toEqual(['MDV3000']);
  });
});

describe('metric: the label', () => {
  it('drops a trailing colon, because the tile is not a form field (SPEC 8.13)', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, label: 'Revenue:' } });
    expect(textOf(run, 'mdv-metric-label')?.text).toBe('Revenue');
  });

  it('falls back to the block title', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, title: 'Monthly revenue' } });
    expect(textOf(run, 'mdv-metric-label')?.text).toBe('Monthly revenue');
  });

  it('renders nothing at all when there is no label', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1 } });
    expect(textOf(run, 'mdv-metric-label')).toBeUndefined();
  });

  it('sets the label in the secondary text token, never in a data colour', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, label: 'Revenue' } });
    expect(textOf(run, 'mdv-metric-label')?.fill).toEqual({ kind: 'solid', color: '#4a4a4a' });
  });
});

describe('metric: layout arithmetic', () => {
  const run = runChart(metricChart, EMPTY_TABLE, {
    attrs: { value: 1_400_000, label: 'Revenue', delta: -0.082, deltaOf: 'vs. last month' },
  });

  it('stacks label, figure and delta in reading order', () => {
    expect(texts(run).map((node) => node.cls)).toEqual([
      'mdv-metric-label',
      'mdv-metric-value',
      'mdv-metric-delta',
    ]);
  });

  it('puts each baseline exactly one ascent below the running cursor', () => {
    expect(textOf(run, 'mdv-metric-label')?.y).toBe(8.84); // 11.05 × 0.8
    expect(textOf(run, 'mdv-metric-value')?.y).toBe(31.05); // 8.84 + 2.21 + 4 + 16
  });

  it('measures each line so a backend never has to guess its width', () => {
    expect(textOf(run, 'mdv-metric-label')?.width).toBe(46.41); // 7 × 11.05 × 0.6
    expect(textOf(run, 'mdv-metric-value')?.width).toBe(108); // 9 × 20 × 0.6
  });

  it('sets the delta beside the figure while it fits', () => {
    const delta = textOf(run, 'mdv-metric-delta');
    expect(delta?.x).toBe(116); // 108 + 8
    expect(delta?.y).toBe(31.05); // shares the figure's baseline
  });

  it('drops the delta under the figure when it does not fit', () => {
    const narrow = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 1_400_000, label: 'Revenue', delta: -0.082, deltaOf: 'vs. last month' },
      frame: { x: 0, y: 0, width: 140, height: 200 },
    });
    const delta = textOf(narrow, 'mdv-metric-delta');
    expect(delta?.x).toBe(0);
    expect(delta?.y).toBe(47.89); // 31.05 + 4 (descent) + 4 (gap) + 8.84 (ascent)
  });

  it('gives a hero figure at least 48 px (SPEC 8.13)', () => {
    const hero = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, size: 'hero' } });
    expect(textOf(hero, 'mdv-metric-value')?.font.size).toBeGreaterThanOrEqual(48);
  });

  it('uses proportional figures, not tabular: one number has no column to align to', () => {
    // A table cell sets `tabular` so digits line up down a column; a lone figure
    // has no column, and tabular figures read worse at display size (SPEC 11.5).
    expect(textOf(run, 'mdv-metric-value')?.tabular).toBeUndefined();
  });

  it('degrades an unrecognised size to `normal` and says so (MDV1502)', () => {
    const odd = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, size: 'enormous' } });
    expect(codesOf(odd)).toContain('MDV1502');
    expect(textOf(odd, 'mdv-metric-value')?.font.size).toBe(20);
  });
});

describe('metric: the delta (SPEC 8.13)', () => {
  const withDelta = (attrs: Record<string, unknown>) =>
    runChart(metricChart, EMPTY_TABLE, { attrs: { value: 100, deltaOf: 'vs. Q3', ...attrs } });

  it('reads a fraction as a signed percentage', () => {
    expect(textOf(withDelta({ delta: 0.124 }), 'mdv-metric-delta')?.text).toBe('+12.4% vs. Q3');
  });

  it('reads a larger number as a signed count', () => {
    expect(textOf(withDelta({ delta: 1234 }), 'mdv-metric-delta')?.text).toBe('+1,234 vs. Q3');
  });

  it('colours a rise green when up is good', () => {
    expect(textOf(withDelta({ delta: 0.1 }), 'mdv-metric-delta')?.fill).toEqual({ kind: 'solid', color: '#0ca30c' });
  });

  it('colours a rise red when up is bad — churn going up is not good news', () => {
    const node = textOf(withDelta({ delta: 0.1, goodDirection: 'down' }), 'mdv-metric-delta');
    expect(node?.fill).toEqual({ kind: 'solid', color: '#d03b3b' });
  });

  it('colours a fall green when down is good', () => {
    const node = textOf(withDelta({ delta: -0.1, goodDirection: 'down' }), 'mdv-metric-delta');
    expect(node?.fill).toEqual({ kind: 'solid', color: '#0ca30c' });
  });

  it('stays in a text token when no direction is better', () => {
    const node = textOf(withDelta({ delta: 0.1, goodDirection: 'none' }), 'mdv-metric-delta');
    expect(node?.fill).toEqual({ kind: 'solid', color: '#4a4a4a' });
  });

  it('treats no change as neutral whatever the goodDirection', () => {
    expect(textOf(withDelta({ delta: 0 }), 'mdv-metric-delta')?.fill).toEqual({ kind: 'solid', color: '#4a4a4a' });
  });

  it('uses status colour, never a categorical slot: a bad quarter is not "series 4"', () => {
    const node = textOf(withDelta({ delta: -0.1 }), 'mdv-metric-delta');
    expect(node?.fill).not.toEqual({ kind: 'solid', color: '#111180' });
  });

  it('demands the comparison period, because a bare -8% means nothing (MDV1501)', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 100, delta: -0.08 } });
    expect(codesOf(run)).toContain('MDV1501');
  });

  it('stays quiet once the period is named', () => {
    expect(codesOf(withDelta({ delta: -0.08 }))).not.toContain('MDV1501');
  });

  it('renders no delta at all when none was given', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 100 } });
    expect(textOf(run, 'mdv-metric-delta')).toBeUndefined();
  });
});

describe('metric: the trend sparkline (SPEC 8.13)', () => {
  const run = runChart(metricChart, EMPTY_TABLE, {
    attrs: { value: 1_400_000, label: 'Revenue', delta: -0.082, deltaOf: 'vs. last month', trend: [1, 2, 3, 4] },
  });

  it('draws the sparkline across the foot of the tile', () => {
    // Strip height min(28, max(16, 200 × 0.22)) = 28, so its top is y = 172;
    // the domain [1, 4] spans that 28 px and the step is 400 / 3.
    expect(nodesOfKind(run.laid.nodes, 'path')[0]?.d).toEqual([
      { c: 'M', x: 0, y: 200 },
      { c: 'L', x: 133.3333, y: 190.6667 },
      { c: 'L', x: 266.6667, y: 181.3333 },
      { c: 'L', x: 400, y: 172 },
    ]);
  });

  it('keeps the sparkline in the de-emphasis hue and thinner than a line mark', () => {
    const stroke = nodesOfKind(run.laid.nodes, 'path')[0]?.stroke;
    expect(stroke?.paint).toEqual({ kind: 'solid', color: '#767676' });
    expect(stroke?.width).toBe(1.5);
  });

  it('accents the current period, which is the one the figure reports', () => {
    const dot = nodesOfKind(run.laid.nodes, 'circle')[0];
    expect({ cx: dot?.cx, cy: dot?.cy }).toEqual({ cx: 400, cy: 172 });
    expect(dot?.fill).toEqual({ kind: 'solid', color: '#1a1a1a' });
  });

  it('keeps at most twelve periods, taking the most recent', () => {
    const long = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 1, trend: Array.from({ length: 20 }, (_, i) => i + 1) },
    });
    const d = nodesOfKind(long.laid.nodes, 'path')[0]?.d ?? [];
    expect(d).toHaveLength(12);
    expect(d[0]).toEqual({ c: 'M', x: 0, y: 200 }); // the 9th value, now the minimum
  });

  it('takes the tail of a bound column when `trend` names one', () => {
    const bound = runChart(metricChart, months(), {
      attrs: { value: 'last(revenue)', trend: 'revenue' },
    });
    expect(nodesOfKind(bound.laid.nodes, 'path')[0]?.d).toHaveLength(4);
  });

  it('flat-lines a constant series through the middle instead of dividing by zero', () => {
    const flat = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 5, trend: [5, 5, 5] } });
    expect(nodesOfKind(flat.laid.nodes, 'path')[0]?.d).toEqual([
      { c: 'M', x: 0, y: 186 },
      { c: 'L', x: 200, y: 186 },
      { c: 'L', x: 400, y: 186 },
    ]);
  });

  it('draws no sparkline for a single period: one point is not a trend', () => {
    const one = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 5, trend: [5] } });
    expect(nodesOfKind(one.laid.nodes, 'path')).toHaveLength(0);
    expect(nodesOfKind(one.laid.nodes, 'circle')).toHaveLength(0);
  });

  it('ignores unusable entries rather than plotting them', () => {
    const messy = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 5, trend: [1, 'x', 3] } });
    expect(nodesOfKind(messy.laid.nodes, 'path')[0]?.d).toHaveLength(2);
    expect(nonFiniteNumbers(messy.laid)).toEqual([]);
  });
});

describe('metric: focus and hover', () => {
  it('makes the whole tile one target', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 100, label: 'Revenue' } });
    expect(run.laid.hits).toHaveLength(1);
    expect(run.laid.hits[0]).toMatchObject({ x: 0, y: 0, w: 400, h: 200 });
  });

  it('reads out the figure first, emphasised, then the change', () => {
    const run = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 100, label: 'Revenue', delta: 0.1, deltaOf: 'vs. Q3' },
    });
    expect(run.laid.hits[0]?.readout).toEqual([
      { label: 'Revenue', value: '100', emphasis: true },
      { label: 'vs. Q3', value: '+10.0%' },
    ]);
  });
});

describe('metric: degenerate input', () => {
  it('renders a tile over an empty table', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 42 } });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('42');
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('shows an em dash when the column exists but holds no rows', () => {
    const run = runChart(metricChart, noRows([['revenue', 'number']]), {
      encoding: { value: { field: 'revenue' } },
    });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('—');
    expect(codesOf(run.validation)).toEqual([]);
  });

  it('reports the single row as the answer', () => {
    const run = runChart(metricChart, makeTable([['revenue', 'number']], [[7]]), {
      encoding: { value: { field: 'revenue' } },
    });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('7');
  });

  it('shows an em dash for an all-null column rather than 0', () => {
    const run = runChart(metricChart, makeTable([['revenue', 'number']], [[null], [null]]), {
      encoding: { value: { field: 'revenue' } },
    });
    expect(textOf(run, 'mdv-metric-value')?.text).toBe('—');
  });

  it('emits nothing at all, rather than NaN, in a frame with no room', () => {
    for (const frame of [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 400, height: 0 },
      { x: 0, y: 0, width: Number.NaN, height: 200 },
    ]) {
      const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1, trend: [1, 2, 3] }, frame });
      expect(run.laid.nodes).toEqual([]);
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('emits no NaN at extreme aspect ratios', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 4, height: 2000 },
    ]) {
      const run = runChart(metricChart, EMPTY_TABLE, {
        attrs: { value: 1_400_000, label: 'Revenue', delta: 0.1, deltaOf: 'vs. Q3', trend: [1, 2, 3] },
        frame,
      });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('has no axes to tick and no series to colour', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 1 } });
    expect(run.encoded.axes).toEqual([]);
    expect(run.encoded.series).toEqual([]);
  });
});

describe('metric: accessibility', () => {
  it('describes label, figure, direction and trend in one sentence each', () => {
    const run = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 1_400_000, label: 'Revenue', delta: -0.082, deltaOf: 'vs. last month', trend: [1, 2, 3, 4] },
    });
    expect(run.description).toBe(
      'Stat tile. Revenue: 1,400,000. worsened by -8.2% vs. last month. Trend over 4 periods.',
    );
  });

  it('says "improved" when the delta went the good way', () => {
    const run = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 10, label: 'Revenue', delta: 0.1, deltaOf: 'vs. Q3' },
    });
    expect(run.description).toBe('Stat tile. Revenue: 10. improved by +10.0% vs. Q3.');
  });

  it('falls back to "Value" with no label', () => {
    expect(runChart(metricChart, EMPTY_TABLE, { attrs: { value: 10 } }).description).toBe('Stat tile. Value 10.');
  });

  it('offers the figure, its delta and every period as a table', () => {
    const run = runChart(metricChart, EMPTY_TABLE, {
      attrs: { value: 1_400_000, label: 'Revenue', delta: -0.082, deltaOf: 'vs. last month', trend: [1, 2] },
    });
    expect(run.encoded.a11yTable?.caption).toBe('Revenue');
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).toEqual(['Measure', 'Value']);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Revenue', '1,400,000'],
      ['vs. last month', '-8.2%'],
      ['Period 1', '1'],
      ['Period 2', '2'],
    ]);
  });
});

describe('metric: the contract', () => {
  it('registers as a level 1 type with no hit family of its own', () => {
    expect(metricChart.level).toBe(1);
    // The number is already the whole message; there is nothing to hover *over*.
    expect(metricChart.family).toBe('none');
  });

  it('stays legible far below a plot minimum, because it is one number', () => {
    expect(metricChart.minWidth).toBeLessThan(240);
  });

  it('produces exactly one mark, in data space', () => {
    const run = runChart(metricChart, EMPTY_TABLE, { attrs: { value: 5 } });
    expect(run.encoded.marks).toEqual([{ mark: 'text', seriesId: '', datum: 0, x: 0, y: 0, text: '5' }]);
  });

  it('never throws for document content, however wrong', () => {
    expect(() =>
      runChart(metricChart, EMPTY_TABLE, {
        attrs: { value: {}, delta: 'soon', trend: { nope: true }, size: 42, goodDirection: 7 },
      }),
    ).not.toThrow();
  });
});

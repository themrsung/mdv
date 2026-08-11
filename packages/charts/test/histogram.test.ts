/**
 * `histogram` (SPEC 8.7), asserted numerically.
 *
 * The fixture is ten observations of one measure, chosen so that four bins over
 * `[0, 4]` fall out with counts `4, 3, 2, 1` — arithmetic a reader can redo by
 * hand, and a strictly descending shape so the "most common" sentence and the
 * extremes have only one right answer.
 *
 * The frame is 400 × 200, so with a bin domain of `[0, 4]` each bin is 100 px of
 * value axis, and with a count domain that nices to `[0, 4]` each unit of count
 * is 50 px tall. Two facts are *not* data-derived and are the point of the
 * geometry suite:
 *
 * - the bins **tile**: touching bars share one 2 px surface gap (SPEC 11.4), so
 *   an interior bar is 98 px wide and the two outermost are 99 px — never a
 *   `barPadding` band, and never a stroke;
 * - the outermost edges sit exactly on the frame, because a histogram's axis is
 *   continuous and has no band to inset into.
 */

import { describe, expect, it } from 'vitest';
import type { RectNode } from '@mdv/core';
import { histogramChart } from '../src/histogram.js';
import {
  EMPTY_TABLE,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const X = { x: { field: 'value' } };

const FIELDS = [['value', 'number']] as const;

/**
 * Ten observations: four in `[0, 1)`, three in `[1, 2)`, two in `[2, 3)` and the
 * lone `4`, which the closed last bin has to catch.
 */
function values(): ReturnType<typeof makeTable> {
  return makeTable(FIELDS, [[0], [0.25], [0.5], [0.75], [1], [1.5], [1.75], [2], [2.5], [4]]);
}

function rects(nodes: ReturnType<typeof nodesOfKind>): RectNode[] {
  return nodes as RectNode[];
}

describe('histogram: the bin grid', () => {
  const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });

  it('counts every observation exactly once', () => {
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([4, 3, 2, 1]);
    expect(run.encoded.marks.reduce((sum, m) => sum + m.y1, 0)).toBe(10);
  });

  it('closes the last bin, so the maximum is not its own bin', () => {
    // `4` is the domain's upper bound: a half-open rule would file it in a fifth
    // bin, or drop it. It belongs in `[3, 4]`.
    expect(run.encoded.marks).toHaveLength(4);
    expect(run.encoded.marks[3]?.y1).toBe(1);
  });

  it('lays the bins on the data extent, evenly, with no gap to divide', () => {
    expect(run.encoded.marks.map((m) => m.x)).toEqual([0, 1, 2, 3]);
    expect(run.encoded.scales.x?.domain).toEqual([0, 4]);
  });

  it('starts the counts at zero, so the shape is honest (SPEC 7.2)', () => {
    expect(run.encoded.scales.y?.domain).toEqual([0, 4]);
    expect(run.encoded.marks.map((m) => m.y0)).toEqual([0, 0, 0, 0]);
  });

  it('measures the bins on a continuous axis, never a band', () => {
    expect(run.encoded.scales.x?.type).toBe('linear');
    expect(run.encoded.scales.x?.bandwidth).toBeUndefined();
  });

  it('titles the axes for what they carry', () => {
    // The bin axis titles itself from the *field*, as every cartesian type does;
    // the count axis has no column behind it, so the histogram names it.
    expect(run.encoded.axes?.map((a) => a.title)).toEqual(['value', 'Count']);
  });
});

describe('histogram: mark geometry', () => {
  const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });
  const bars = rects(nodesOfKind(run.laid.nodes, 'rect'));

  it('tiles the frame: touching bars share one 2 px gap', () => {
    expect(bars).toHaveLength(4);
    // 100 px per bin, less half of the 2 px surface gap on each *shared* edge.
    expect(bars.map((b) => b.x)).toEqual([0, 101, 201, 301]);
    expect(bars.map((b) => b.w)).toEqual([99, 98, 98, 99]);
    for (let i = 1; i < bars.length; i += 1) {
      const left = bars[i - 1];
      const right = bars[i];
      if (left === undefined || right === undefined) throw new Error('four bars expected');
      expect(right.x - (left.x + left.w)).toBe(2);
    }
  });

  it('runs the outermost edges out to the frame, having no band to inset into', () => {
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (first === undefined || last === undefined) throw new Error('four bars expected');
    expect(first.x).toBe(0);
    expect(last.x + last.w).toBe(400);
  });

  it('grows each bar down from its count to the zero baseline', () => {
    expect(bars.map((b) => b.h)).toEqual([200, 150, 100, 50]);
    expect(bars.map((b) => b.y)).toEqual([0, 50, 100, 150]);
    for (const bar of bars) expect(bar.y + bar.h).toBe(200);
  });

  it('rounds the count end only, square at the baseline (SPEC 11.4)', () => {
    expect(bars[0]?.r).toEqual([4, 4, 0, 0]);
  });

  it('never strokes a bar, because the surface gap is what separates them', () => {
    for (const bar of bars) expect(bar.stroke).toBeUndefined();
  });

  it('keeps an empty bin in the distribution but draws nothing for it', () => {
    const gapped = runChart(histogramChart, makeTable(FIELDS, [[0], [0], [3], [3]]), {
      encoding: X,
      attrs: { bins: 3 },
    });
    expect(gapped.encoded.marks.map((m) => m.y1)).toEqual([2, 0, 2]);
    expect(rects(nodesOfKind(gapped.laid.nodes, 'rect'))).toHaveLength(2);
  });

  it('produces no NaN geometry', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(nonFiniteNumbers(run.encoded)).toEqual([]);
  });
});

describe('histogram: hit regions', () => {
  const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });

  it('points every region back at a row that landed in the bin', () => {
    expect(run.laid.hits).toHaveLength(4);
    expect(run.laid.hits.map((h) => h.datumIndex)).toEqual([0, 4, 7, 9]);
  });

  it('reads out the bin interval and the count, the count emphasised (SPEC 12.4)', () => {
    const rows = run.laid.hits[0]?.readout;
    expect(rows?.map((r) => [r.label, r.value])).toEqual([
      ['Value', '0–1'],
      ['Count', '4'],
    ]);
    expect(rows?.[1]?.emphasis).toBe(true);
  });
});

describe('histogram: normalize (SPEC 8.7)', () => {
  // Two bins over `[0, 4]`: step 2, counts 7 and 3.
  const two = { encoding: X, attrs: { bins: 2 } };

  it('counts by default', () => {
    const run = runChart(histogramChart, values(), two);
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([7, 3]);
  });

  it('reads frequency as a share of the sample, labelled as a percentage', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 2, normalize: 'frequency' },
    });
    expect(run.encoded.marks[0]?.y1).toBeCloseTo(0.7, 10);
    expect(run.encoded.marks[1]?.y1).toBeCloseTo(0.3, 10);
    expect(run.encoded.axes?.[1]?.title).toBe('Frequency');
    expect(run.encoded.scales.y?.format(0.7)).toBe('70.0%');
  });

  it('divides density by the bin width, so the areas sum to one', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 2, normalize: 'density' },
    });
    const step = 2;
    expect(run.encoded.marks[0]?.y1).toBeCloseTo(0.35, 10);
    expect(run.encoded.marks[1]?.y1).toBeCloseTo(0.15, 10);
    expect(run.encoded.marks.reduce((sum, m) => sum + m.y1 * step, 0)).toBeCloseTo(1, 10);
    expect(run.encoded.axes?.[1]?.title).toBe('Density');
  });

  it('accumulates to the sample size when asked, and says so on the axis', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 4, cumulative: true },
    });
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([4, 7, 9, 10]);
    expect(run.encoded.scales.y?.domain).toEqual([0, 10]);
    expect(run.encoded.axes?.[1]?.title).toBe('Cumulative count');
  });
});

describe('histogram: bin count', () => {
  it('honours an explicit `bins`', () => {
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 8 } });
    expect(run.encoded.marks).toHaveLength(8);
  });

  it('lets `binStep` fix the width, and win over `bins`', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 3, binStep: 1 },
    });
    expect(run.encoded.marks.map((m) => m.x)).toEqual([0, 1, 2, 3]);
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([4, 3, 2, 1]);
  });

  it('grows the domain rather than understating the last bin', () => {
    // Step 3 over an extent of 4 needs two bins, and the second overhangs.
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { binStep: 3 } });
    expect(run.encoded.scales.x?.domain).toEqual([0, 6]);
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([9, 1]);
  });

  it('stays inside the automatic range when nothing is asked for', () => {
    const run = runChart(histogramChart, values(), { encoding: X });
    expect(run.encoded.marks.length).toBeGreaterThanOrEqual(5);
    expect(run.encoded.marks.length).toBeLessThanOrEqual(500);
  });

  it('caps a runaway request rather than hanging the render', () => {
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 100000 } });
    expect(run.encoded.marks).toHaveLength(500);
  });

  it('pins an explicit `domain` over the data extent', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 2, domain: [0, 10] },
    });
    expect(run.encoded.scales.x?.domain).toEqual([0, 10]);
    // Everything lands in `[0, 5)`.
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([10, 0]);
  });
});

describe('histogram: diagnostics', () => {
  it('reports MDV3000 when `x` is not bound', () => {
    const run = runChart(histogramChart, values(), { encoding: {} });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3000 when `x` names something that is not a column', () => {
    const run = runChart(histogramChart, values(), { encoding: { x: { field: 'missing' } } });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('reports MDV3001 when the measure is not quantitative', () => {
    const table = makeTable([['value', 'category']], [['a'], ['b']]);
    const run = runChart(histogramChart, table, { encoding: X });
    expect(codesOf(run.validation)).toContain('MDV3001');
  });

  it('reports MDV1501 when `bins` and `binStep` both set the grid', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 3, binStep: 1 },
    });
    expect(codesOf(run.validation)).toContain('MDV1501');
  });

  it('reports MDV1501 for a `domain` that is not an ascending pair', () => {
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { domain: [4, 0] } });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1501');
  });

  it('reports MDV1502 for an unknown `normalize` and falls back to the count', () => {
    const run = runChart(histogramChart, values(), {
      encoding: X,
      attrs: { bins: 4, normalize: 'sideways' },
    });
    expect(codesOf(run.encodeDiagnostics)).toContain('MDV1502');
    expect(run.encoded.marks.map((m) => m.y1)).toEqual([4, 3, 2, 1]);
  });

  it('has no MDV3021 to report: the baseline is never suppressible', () => {
    const run = runChart(histogramChart, values(), {
      encoding: { x: { field: 'value', scale: { zero: false } } },
      attrs: { bins: 4 },
    });
    expect(codesOf(run.encodeDiagnostics)).not.toContain('MDV3021');
    expect(run.encoded.scales.y?.domain).toEqual([0, 4]);
  });
});

describe('histogram: degenerate input', () => {
  it('draws nothing for an empty table and does not throw', () => {
    const run = runChart(histogramChart, EMPTY_TABLE, { encoding: X });
    expect(run.laid.nodes).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('draws nothing when the column exists but has no rows', () => {
    const run = runChart(histogramChart, noRows(FIELDS), { encoding: X });
    expect(run.encoded.marks).toEqual([]);
    expect(nodesOfKind(run.laid.nodes, 'rect')).toEqual([]);
  });

  it('survives an all-null column', () => {
    const run = runChart(histogramChart, makeTable(FIELDS, [[null], [null]]), { encoding: X });
    expect(run.encoded.marks).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('skips the rows it cannot read and bins the rest', () => {
    const table = makeTable(FIELDS, [[0], [null], [1], [3]]);
    const run = runChart(histogramChart, table, { encoding: X, attrs: { bins: 3 } });
    expect(run.encoded.marks.reduce((sum, m) => sum + m.y1, 0)).toBe(3);
  });

  it('gives a single observation a bin of its own, not a zero-wide domain', () => {
    const run = runChart(histogramChart, makeTable(FIELDS, [[3]]), { encoding: X });
    const [lo, hi] = run.encoded.scales.x?.domain as [number, number];
    expect(hi).toBeGreaterThan(lo);
    expect(run.encoded.marks.reduce((sum, m) => sum + m.y1, 0)).toBe(1);
    expect(rects(nodesOfKind(run.laid.nodes, 'rect'))).toHaveLength(1);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives extreme aspect ratios in both directions', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 900 },
      { x: 0, y: 0, width: 2000, height: 1 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 }, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
      for (const rect of rects(nodesOfKind(run.laid.nodes, 'rect'))) {
        expect(rect.w).toBeGreaterThanOrEqual(0);
        expect(rect.h).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('histogram: description (SPEC 12.2)', () => {
  it('names the measure, the bins and the extremes', () => {
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });
    expect(run.description).toBe(
      'Histogram. Value, 4 bins. Bin counts range from 1 in 3–4 to 4 in 0–1. Most common: 0–1.',
    );
  });

  it('describes an empty chart without inventing data', () => {
    const run = runChart(histogramChart, EMPTY_TABLE, { encoding: X });
    expect(run.description).toBe('Histogram with no data.');
  });
});

describe('histogram: a11y table', () => {
  const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });

  it('carries the observations, not the bins: the bins are on screen', () => {
    const view = run.encoded.a11yTable;
    expect(view?.columns.map((c) => c.name)).toEqual(['Value']);
    expect(view?.rows).toHaveLength(10);
    expect(view?.rows[0]).toEqual(['0']);
    expect(view?.rows[9]).toEqual(['4']);
  });
});

describe('histogram: marks are data space', () => {
  it('never puts a pixel in a mark', () => {
    const run = runChart(histogramChart, values(), { encoding: X, attrs: { bins: 4 } });
    const values_ = run.encoded.marks.flatMap((m) => [m.x, m.y0, m.y1]);
    expect(values_).toEqual([0, 0, 4, 1, 0, 3, 2, 0, 2, 3, 0, 1]);
  });
});

/**
 * `pie` and `donut` (SPEC 8.5), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame: the pie is
 * centred at (200, 100) and its outer radius is min(400, 200) / 2 = 100. A
 * donut's inner radius is 0.6 of that, so 60. Angles run clockwise from 12
 * o'clock, which is the SPEC default `startAngle: -90`.
 *
 * The rules under test are the ones that keep a pie honest: the slices sum to
 * one whole turn, slivers fold into "Other" rather than each taking a palette
 * slot, slices under 5 % carry no label, negative values are refused outright,
 * and more than six slices is `MDV3050`.
 */

import { describe, expect, it } from 'vitest';
import type { PathCommand, PathNode, TextNode } from '@mdv/core';
import { donutChart, pieChart } from '../src/pie.js';
import { EMPTY_TABLE, codesOf, makeTable, nodesOfKind, nonFiniteNumbers, noRows, runChart } from './harness.js';

const XY = { category: { field: 'fruit' }, value: { field: 'count' } };

/** Four shares of 1000: 40 %, 30 %, 20 %, 10 %. */
function fruit() {
  return makeTable(
    [
      ['fruit', 'category'],
      ['count', 'number'],
    ],
    [
      ['Apple', 100],
      ['Banana', 200],
      ['Cherry', 300],
      ['Damson', 400],
    ],
  );
}

/** Shares small enough to fold: three of them are 0.1 % each. */
function withSlivers() {
  return makeTable(
    [
      ['fruit', 'category'],
      ['count', 'number'],
    ],
    [
      ['Apple', 500],
      ['Banana', 497],
      ['Cherry', 1],
      ['Damson', 1],
      ['Elder', 1],
    ],
  );
}

function arcs(nodes: readonly unknown[]): PathNode[] {
  return nodesOfKind(nodes as never, 'path');
}

/** Distance of a command's endpoint from the pie's centre. */
function radius(command: PathCommand | undefined): number {
  if (command === undefined || command.c === 'Z') return Number.NaN;
  return Math.hypot(command.x - 200, command.y - 100);
}

describe('pie: slice geometry', () => {
  const run = runChart(pieChart, fruit(), { encoding: XY });

  it('emits one arc mark per category with exact fractions', () => {
    // Sorted descending by value, which is the SPEC 8.5 default.
    expect(run.encoded.marks.map((m) => m.category)).toEqual(['Damson', 'Cherry', 'Banana', 'Apple']);
    expect(run.encoded.marks.map((m) => m.fraction)).toEqual([0.4, 0.3, 0.2, 0.1]);
  });

  it('sums to one whole turn', () => {
    // Shares are `value / total`, so the sum is 1 to within a float ulp; the
    // residue is ~1e-16 of a turn, which is well under a nanometre of arc.
    expect(run.encoded.marks.reduce((total, m) => total + m.fraction, 0)).toBeCloseTo(1, 12);
  });

  it('draws each slice as an arc closed through the centre', () => {
    const slices = arcs(run.laid.nodes);
    expect(slices).toHaveLength(4);
    for (const slice of slices) {
      expect(slice.d.map((c) => c.c)).toEqual(['M', 'A', 'L', 'Z']);
      // The wedge closes at the centre, exactly.
      expect(slice.d[2]).toEqual({ c: 'L', x: 200, y: 100 });
      expect(radius(slice.d[0])).toBeCloseTo(100, 3);
    }
  });

  it('starts the first slice at 12 o’clock, less half the pad', () => {
    const first = arcs(run.laid.nodes)[0]?.d[0];
    // padAngle defaults to 1°, so the leading edge sits half a degree clockwise.
    const halfPad = Math.PI / 360;
    expect(first?.c).toBe('M');
    expect((first as { x: number }).x).toBeCloseTo(200 + 100 * Math.sin(halfPad), 3);
    expect((first as { y: number }).y).toBeCloseTo(100 - 100 * Math.cos(halfPad), 3);
  });

  it('takes the large-arc flag only for slices past a half turn', () => {
    const big = runChart(pieChart, makeTable([['fruit', 'category'], ['count', 'number']], [['Apple', 9], ['Banana', 1]]), {
      encoding: XY,
    });
    const [major, minor] = arcs(big.laid.nodes);
    expect((major?.d[1] as { largeArc: boolean }).largeArc).toBe(true);
    expect((minor?.d[1] as { largeArc: boolean }).largeArc).toBe(false);
  });

  it('gives every slice a hit region anchored on the slice itself', () => {
    expect(run.laid.hits).toHaveLength(4);
    for (const hit of run.laid.hits) {
      expect(Math.hypot(hit.anchor.x - 200, hit.anchor.y - 100)).toBeCloseTo(50, 3);
    }
  });

  it('emits no NaN anywhere', () => {
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });
});

describe('pie: ordering and start angle', () => {
  it('keeps document order for `sort: none`', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY, attrs: { sort: 'none' } });
    expect(run.encoded.marks.map((m) => m.category)).toEqual(['Apple', 'Banana', 'Cherry', 'Damson']);
  });

  it('reverses for `sort: asc`', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY, attrs: { sort: 'asc' } });
    expect(run.encoded.marks.map((m) => m.fraction)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it('rotates the whole pie for an explicit startAngle', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY, attrs: { startAngle: 0, padAngle: 0 } });
    // 0° in the document convention is 3 o'clock: the first edge is due right.
    const first = arcs(run.laid.nodes)[0]?.d[0] as { x: number; y: number };
    expect(first.x).toBeCloseTo(300, 6);
    expect(first.y).toBeCloseTo(100, 6);
  });

  it('sums duplicate categories into one slice', () => {
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      [
        ['Apple', 30],
        ['Banana', 20],
        ['Apple', 50],
      ],
    );
    const run = runChart(pieChart, table, { encoding: XY, attrs: { sort: 'none' } });
    expect(run.encoded.marks.map((m) => [m.category, m.value])).toEqual([
      ['Apple', 80],
      ['Banana', 20],
    ]);
  });
});

describe('pie: small slices (SPEC 8.5)', () => {
  it('folds everything under 2 % into a single trailing "Other"', () => {
    const run = runChart(pieChart, withSlivers(), { encoding: XY });
    expect(run.encoded.marks.map((m) => m.category)).toEqual(['Apple', 'Banana', 'Other']);
    expect(run.encoded.marks.at(-1)?.value).toBe(3);
    expect(run.encoded.series.at(-1)?.isOther).toBe(true);
  });

  it('keeps every sliver when the author turns the fold off', () => {
    const run = runChart(pieChart, withSlivers(), { encoding: XY, attrs: { other: false } });
    expect(run.encoded.marks).toHaveLength(5);
  });

  it('respects a custom `other` threshold', () => {
    // 20 % folds everything but the two big shares of ~50 %.
    const run = runChart(pieChart, fruit(), { encoding: XY, attrs: { other: 0.2 } });
    expect(run.encoded.marks.map((m) => m.category)).toEqual(['Damson', 'Cherry', 'Banana', 'Other']);
  });

  it('labels only the slices at or above 5 % under `label: auto`', () => {
    const run = runChart(pieChart, withSlivers(), { encoding: XY, attrs: { other: false } });
    const labelled = (run.laid.labels ?? []).map((label) => label.seriesId);
    expect(labelled).toEqual(['Apple', 'Banana']);
  });

  it('labels every slice when the author insists', () => {
    const run = runChart(pieChart, withSlivers(), { encoding: XY, attrs: { other: false, label: 'outside' } });
    expect(run.laid.labels).toHaveLength(5);
  });

  it('emits no labels at all for `label: none`', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY, attrs: { label: 'none' } });
    expect(run.laid.labels).toBeUndefined();
  });

  it('formats the default label as "category: value (percent)"', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY });
    expect(run.laid.labels?.[0]?.text).toBe('Damson: 400 (40%)');
  });

  it('ranks label priority by share, so the big slices win the space', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY });
    const priorities = (run.laid.labels ?? []).map((label) => label.priority);
    expect(priorities).toEqual([40, 30, 20, 10]);
  });
});

describe('pie: refusals', () => {
  it('rejects negative values outright (MDV3001)', () => {
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      [
        ['Apple', 5],
        ['Banana', -2],
      ],
    );
    expect(codesOf(runChart(pieChart, table, { encoding: XY }))).toContain('MDV3001');
  });

  it('counts a zero row as dropped rather than drawing a zero-width wedge', () => {
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      [
        ['Apple', 5],
        ['Banana', 0],
      ],
    );
    const run = runChart(pieChart, table, { encoding: XY });
    expect(run.encoded.marks).toHaveLength(1);
    expect(run.encoded.droppedRows).toBe(1);
  });

  it('suggests a bar chart past six slices (MDV3050)', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name, i) => [name, 10 + i] as const);
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      rows,
    );
    expect(codesOf(runChart(pieChart, table, { encoding: XY }))).toContain('MDV3050');
  });

  it('says nothing at exactly six slices', () => {
    const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((name, i) => [name, 10 + i] as const);
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      rows,
    );
    expect(codesOf(runChart(pieChart, table, { encoding: XY }))).not.toContain('MDV3050');
  });

  it('reports the missing channels rather than throwing', () => {
    const codes = codesOf(pieChart.validate(runChart(pieChart, fruit(), { encoding: {} }).block, fruit()));
    expect(codes).toEqual(['MDV3000', 'MDV3000']);
  });
});

describe('donut', () => {
  const run = runChart(donutChart, fruit(), { encoding: XY });

  it('punches a hole at 0.6 of the outer radius by default', () => {
    const slice = arcs(run.laid.nodes)[0];
    expect(slice?.d.map((c) => c.c)).toEqual(['M', 'A', 'L', 'A', 'Z']);
    expect(radius(slice?.d[0])).toBeCloseTo(100, 3);
    expect(radius(slice?.d[2])).toBeCloseTo(60, 3);
  });

  it('honours an explicit innerRadius fraction', () => {
    const thin = runChart(donutChart, fruit(), { encoding: XY, attrs: { innerRadius: 0.25 } });
    expect(radius(arcs(thin.laid.nodes)[0]?.d[2])).toBeCloseTo(25, 3);
  });

  it('is a plain pie when the hole is closed', () => {
    const closed = runChart(donutChart, fruit(), { encoding: XY, attrs: { innerRadius: 0 } });
    expect(arcs(closed.laid.nodes)[0]?.d.map((c) => c.c)).toEqual(['M', 'A', 'L', 'Z']);
  });

  it('renders centre content, title above value', () => {
    const centred = runChart(donutChart, fruit(), {
      encoding: XY,
      attrs: { center: { title: 'Total', value: 'sum(count)' } },
    });
    const texts: TextNode[] = nodesOfKind(centred.laid.nodes, 'text');
    expect(texts.map((t) => t.text)).toEqual(['Total', '1,000']);
    expect(texts.every((t) => t.x === 200 && t.anchor === 'middle')).toBe(true);
    expect((texts[0]?.y ?? 0) < (texts[1]?.y ?? 0)).toBe(true);
  });

  it('renders a literal centre string verbatim', () => {
    const centred = runChart(donutChart, fruit(), { encoding: XY, attrs: { center: 'Q3' } });
    expect(nodesOfKind(centred.laid.nodes, 'text').map((t) => t.text)).toEqual(['Q3']);
  });

  it('leaves an unrecognised centre expression alone rather than guessing', () => {
    const centred = runChart(donutChart, fruit(), {
      encoding: XY,
      attrs: { center: { value: 'median(count)' } },
    });
    expect(nodesOfKind(centred.laid.nodes, 'text').map((t) => t.text)).toEqual(['median(count)']);
  });

  it('draws no centre content when there is no hole to put it in', () => {
    const centred = runChart(donutChart, fruit(), {
      encoding: XY,
      attrs: { innerRadius: 0, center: { title: 'Total' } },
    });
    expect(nodesOfKind(centred.laid.nodes, 'text')).toHaveLength(0);
  });
});

describe('pie: degenerate data', () => {
  it('survives the empty table', () => {
    const run = runChart(pieChart, EMPTY_TABLE, { encoding: XY });
    expect(run.laid.nodes).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives columns with no rows', () => {
    const run = runChart(
      pieChart,
      noRows([
        ['fruit', 'category'],
        ['count', 'number'],
      ]),
      { encoding: XY },
    );
    expect(run.laid.nodes).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('draws a single row as one full turn, split into two half arcs', () => {
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      [['Apple', 7]],
    );
    const run = runChart(pieChart, table, { encoding: XY });
    expect(run.encoded.marks[0]?.fraction).toBe(1);
    // The 1° pad keeps it just short of a turn, so it is one large arc.
    expect(arcs(run.laid.nodes)[0]?.d.map((c) => c.c)).toEqual(['M', 'A', 'L', 'Z']);
    expect((arcs(run.laid.nodes)[0]?.d[1] as { largeArc: boolean }).largeArc).toBe(true);
    // With no pad it is a genuine full turn, which one SVG arc cannot express.
    const unpadded = runChart(pieChart, table, { encoding: XY, attrs: { padAngle: 0 } });
    expect(arcs(unpadded.laid.nodes)[0]?.d.map((c) => c.c)).toEqual(['M', 'A', 'A', 'Z']);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives an all-null value column', () => {
    const table = makeTable(
      [
        ['fruit', 'category'],
        ['count', 'number'],
      ],
      [
        ['Apple', null],
        ['Banana', null],
      ],
    );
    const run = runChart(pieChart, table, { encoding: XY });
    expect(run.encoded.marks).toHaveLength(0);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN at any extreme aspect ratio', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 4, height: 2000 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(pieChart, fruit(), { encoding: XY, frame });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });
});

describe('pie: accessibility', () => {
  it('describes itself through the registry contract', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY });
    expect(run.description).toBe('Pie chart. Count by fruit, 4 slices. Largest: Damson at 40%.');
  });

  it('names itself a donut when it is one', () => {
    const run = runChart(donutChart, fruit(), { encoding: XY });
    expect(run.description?.startsWith('Donut chart.')).toBe(true);
  });

  it('says so plainly when there is nothing to describe', () => {
    expect(runChart(pieChart, EMPTY_TABLE, { encoding: XY }).description).toBe('Pie chart with no data.');
  });

  it('offers the data as a table through `a11yTable`', () => {
    const run = runChart(pieChart, fruit(), { encoding: XY });
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).toEqual(['Fruit', 'Count']);
    expect(run.encoded.a11yTable?.rows[0]).toEqual(['Apple', '100']);
  });
});

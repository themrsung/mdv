/**
 * Annotations (SPEC 8.14) — a shared concern, tested across the types that carry
 * them rather than once against one of them.
 *
 * The rule the suite exists to defend is the ink rule:
 *
 * > Annotation ink is chrome, not data — text and border tokens, never a series
 * > color, so an annotation can never be mistaken for a series.
 *
 * Geometry is checked against the `quarters()` fixture on the 400 × 200 frame.
 * A line chart puts its four quarters on a point scale at x = 50/150/250/350 and
 * its `[0, 400]` domain over the full height, so 1 unit is ½ px and y = 1500 on
 * the `twoSeries()`-scale fixtures is off the top; the numbers below all follow
 * from those two facts.
 */

import { describe, expect, it } from 'vitest';
import type { SceneNode } from '@mdv/core';
import { areaChart } from '../src/area.js';
import { barChart } from '../src/bar.js';
import { lineChart } from '../src/line.js';
import { scatterChart } from '../src/scatter.js';
import { parseAnnotations } from '../src/internal/annotations.js';
import {
  makeTable,
  makeTheme,
  nodesOfKind,
  nonFiniteNumbers,
  quarters,
  runChart,
} from './harness.js';

const QUARTERLY = { x: { field: 'quarter' }, y: { field: 'revenue' } };

/** Points on a numeric x, so annotations can be placed at arbitrary positions. */
function numericXY() {
  return makeTable(
    [
      ['spend', 'number'],
      ['revenue', 'number'],
    ],
    [
      [0, 0],
      [10, 100],
      [20, 200],
    ],
  );
}

function annotationsOf(nodes: readonly SceneNode[]) {
  return [
    ...nodesOfKind(nodes, 'line'),
    ...nodesOfKind(nodes, 'rect'),
    ...nodesOfKind(nodes, 'circle'),
    ...nodesOfKind(nodes, 'text'),
  ].filter((node) => node.cls?.startsWith('mdv-annotation') === true);
}

describe('annotations: parsing (SPEC 8.14)', () => {
  it('reads the four forms', () => {
    const parsed = parseAnnotations({
      annotations: [
        { type: 'line', y: 1500 },
        { type: 'band', x: ['a', 'b'] },
        { type: 'point', x: 1, y: 2 },
        { type: 'text', x: 1, y: 2, text: 'Peak' },
      ],
    } as never);
    expect(parsed.map((a) => a.kind)).toEqual(['line', 'band', 'point', 'text']);
  });

  it('defaults an unnamed annotation to a line, which is the common case', () => {
    expect(parseAnnotations({ annotations: [{ y: 10 }] } as never)[0]?.kind).toBe('line');
  });

  it('folds an unrecognised type to a line rather than dropping the annotation', () => {
    expect(parseAnnotations({ annotations: [{ type: 'arrow', y: 10 }] } as never)[0]?.kind).toBe(
      'line',
    );
  });

  it('drops an entry that names no position at all', () => {
    // There is nowhere to put it; keeping it would mean inventing a location.
    expect(parseAnnotations({ annotations: [{ type: 'line', label: 'Target' }] } as never)).toEqual(
      [],
    );
  });

  it('drops junk entries without taking the rest with them (SPEC 14.1)', () => {
    const parsed = parseAnnotations({ annotations: ['nope', null, 7, [1, 2], { y: 10 }] } as never);
    expect(parsed).toHaveLength(1);
  });

  it('ignores the attribute entirely when it is not a list', () => {
    expect(parseAnnotations({ annotations: { y: 10 } } as never)).toEqual([]);
  });

  it('reads `style: dashed`, and treats anything else as solid', () => {
    const parsed = parseAnnotations({
      annotations: [{ y: 1, style: 'dashed' }, { y: 2, style: 'wiggly' }, { y: 3 }],
    } as never);
    expect(parsed.map((a) => a.dashed)).toEqual([true, false, false]);
  });

  it('reads the text anchor, defaulting to middle', () => {
    const parsed = parseAnnotations({
      annotations: [
        { y: 1, anchor: 'start' },
        { y: 2, anchor: 'end' },
        { y: 3, anchor: 'sideways' },
        { y: 4 },
      ],
    } as never);
    expect(parsed.map((a) => a.anchor)).toEqual(['start', 'end', 'middle', 'middle']);
  });
});

describe('annotations: the ink rule (SPEC 8.14)', () => {
  const run = runChart(lineChart, quarters(), {
    encoding: QUARTERLY,
    attrs: { annotations: [{ type: 'line', y: 200, label: 'Target' }] },
  });

  it('draws the rule in the border token, never in a series colour', () => {
    const rule = nodesOfKind(run.laid.nodes, 'line').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect(rule?.stroke?.paint).toEqual({ kind: 'solid', color: '#d4d4d4' });
  });

  it('sets the label in the secondary text token', () => {
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect(label?.fill).toEqual({ kind: 'solid', color: '#4a4a4a' });
  });

  it('uses no categorical slot anywhere in the annotation layer', () => {
    const slots = new Set<string>(makeTheme().categorical);
    for (const node of annotationsOf(run.laid.nodes)) {
      const paints = [
        node.kind === 'text' || node.kind === 'rect' || node.kind === 'circle'
          ? node.fill
          : undefined,
        'stroke' in node ? node.stroke?.paint : undefined,
      ];
      for (const paint of paints) {
        if (paint !== undefined && paint.kind === 'solid')
          expect(slots.has(paint.color)).toBe(false);
      }
    }
  });

  it('marks every annotation node so a stylesheet can tell chrome from data', () => {
    expect(annotationsOf(run.laid.nodes).length).toBeGreaterThan(0);
    for (const node of annotationsOf(run.laid.nodes)) expect(node.cls).toContain('mdv-annotation');
  });
});

describe('annotations: line', () => {
  it('rules right across the plot at the value it names', () => {
    const run = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', y: 200 }] },
    });
    const rule = nodesOfKind(run.laid.nodes, 'line').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    // Domain [100, 400] over 200 px puts 200 two-thirds of the way up.
    expect({ x1: rule?.x1, x2: rule?.x2, y1: rule?.y1, y2: rule?.y2 }).toEqual({
      x1: 0,
      x2: 400,
      y1: 133.3333,
      y2: 133.3333,
    });
  });

  it('rules vertically when it names an x instead', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'line', x: 10 }] },
    });
    const rule = nodesOfKind(run.laid.nodes, 'line').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x1: rule?.x1, x2: rule?.x2, y1: rule?.y1, y2: rule?.y2 }).toEqual({
      x1: 200,
      x2: 200,
      y1: 0,
      y2: 200,
    });
  });

  it('places a horizontal rule at a category on a band scale', () => {
    const run = runChart(barChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', x: 'Q2' }] },
    });
    const rule = nodesOfKind(run.laid.nodes, 'line').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect(rule?.x1).toBeGreaterThan(0);
    expect(rule?.x1).toBe(rule?.x2);
  });

  it('dashes the rule when asked, and leaves it solid otherwise', () => {
    const dashed = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', y: 200, style: 'dashed' }] },
    });
    const solidRun = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', y: 200 }] },
    });
    const strokeOf = (run: typeof dashed) =>
      nodesOfKind(run.laid.nodes, 'line').find(
        (node) => node.cls?.includes('mdv-annotation') === true,
      )?.stroke;
    expect(strokeOf(dashed)?.dash?.length).toBeGreaterThan(0);
    expect(strokeOf(solidRun)?.dash).toBeUndefined();
  });

  it('sets the label at the far end of the rule, clear of it', () => {
    const run = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', y: 200, label: 'Target' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: label?.x, y: label?.y, anchor: label?.anchor }).toEqual({
      x: 400,
      y: 129.3333,
      anchor: 'end',
    });
    expect(label?.text).toBe('Target');
  });

  it('draws nothing when the position lands nowhere on the scale', () => {
    const run = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { annotations: [{ type: 'line', x: 'Q9' }] },
    });
    expect(annotationsOf(run.laid.nodes)).toEqual([]);
  });
});

describe('annotations: band', () => {
  it('shades the extent it names, from the top of the plot to the bottom', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'band', x: [5, 15], label: 'Outage' }] },
    });
    const band = nodesOfKind(run.laid.nodes, 'rect').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: band?.x, y: band?.y, w: band?.w, h: band?.h }).toEqual({
      x: 100,
      y: 0,
      w: 200,
      h: 200,
    });
  });

  it('shades a horizontal band when the extent is on y', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'band', y: [50, 150] }] },
    });
    const band = nodesOfKind(run.laid.nodes, 'rect').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: band?.x, y: band?.y, w: band?.w, h: band?.h }).toEqual({
      x: 0,
      y: 50,
      w: 400,
      h: 100,
    });
  });

  it('accepts an extent written backwards, rather than drawing a negative box', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'band', x: [15, 5] }] },
    });
    const band = nodesOfKind(run.laid.nodes, 'rect').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: band?.x, w: band?.w }).toEqual({ x: 100, w: 200 });
  });

  it('ignores a band with only one end', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'band', x: [5] }] },
    });
    expect(annotationsOf(run.laid.nodes)).toEqual([]);
  });

  it('centres the band label over it', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'band', x: [5, 15], label: 'Outage' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: label?.x, anchor: label?.anchor }).toEqual({ x: 200, anchor: 'middle' });
  });
});

describe('annotations: point and text', () => {
  it('rings the point in surface so it reads as a callout, not as a datum', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'point', x: 10, y: 100, label: 'Launch' }] },
    });
    const dot = nodesOfKind(run.laid.nodes, 'circle').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ cx: dot?.cx, cy: dot?.cy, r: dot?.r }).toEqual({ cx: 200, cy: 100, r: 4 });
    expect(dot?.fill).toEqual({ kind: 'solid', color: '#ffffff' });
    expect(dot?.stroke?.paint).toEqual({ kind: 'solid', color: '#4a4a4a' });
  });

  it('lifts the point label clear of the marker', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'point', x: 10, y: 100, label: 'Launch' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: label?.x, y: label?.y }).toEqual({ x: 200, y: 92 });
  });

  it('needs both coordinates: half a position is no position', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'point', x: 10 }] },
    });
    expect(annotationsOf(run.laid.nodes)).toEqual([]);
  });

  it('sets free text exactly where it was asked for', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'text', x: 10, y: 100, text: 'Peak', anchor: 'start' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect({ x: label?.x, y: label?.y, anchor: label?.anchor, text: label?.text }).toEqual({
      x: 200,
      y: 100,
      anchor: 'start',
      text: 'Peak',
    });
  });

  it('falls back to `label` when no `text` was given', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'text', x: 10, y: 100, label: 'Peak' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect(label?.text).toBe('Peak');
  });

  it('draws nothing for text with no words in it', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'text', x: 10, y: 100 }] },
    });
    expect(annotationsOf(run.laid.nodes)).toEqual([]);
  });

  it('measures every label so a backend can reason about collisions', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'text', x: 10, y: 100, text: 'Peak' }] },
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    expect(label?.width).toBe(26.52); // 4 × 11.05 × 0.6
  });
});

describe('annotations: available on every cartesian type', () => {
  const attrs = {
    annotations: [
      { type: 'line', y: 200, label: 'Target' },
      { type: 'point', x: 'Q2', y: 200, label: 'Launch' },
    ],
  };

  it('draws on a bar chart', () => {
    const run = runChart(barChart, quarters(), { encoding: QUARTERLY, attrs });
    expect(annotationsOf(run.laid.nodes).length).toBeGreaterThan(0);
  });

  it('draws on a line chart', () => {
    const run = runChart(lineChart, quarters(), { encoding: QUARTERLY, attrs });
    expect(annotationsOf(run.laid.nodes).length).toBeGreaterThan(0);
  });

  it('draws on an area chart', () => {
    const run = runChart(areaChart, quarters(), { encoding: QUARTERLY, attrs });
    expect(annotationsOf(run.laid.nodes).length).toBeGreaterThan(0);
  });

  it('draws on a scatter chart', () => {
    const run = runChart(scatterChart, numericXY(), {
      encoding: { x: { field: 'spend' }, y: { field: 'revenue' } },
      attrs: { annotations: [{ type: 'line', y: 100, label: 'Target' }] },
    });
    expect(annotationsOf(run.laid.nodes).length).toBeGreaterThan(0);
  });

  it('follows the axes round on a horizontal bar chart', () => {
    const run = runChart(barChart, quarters(), {
      encoding: QUARTERLY,
      attrs: { orientation: 'horizontal', annotations: [{ type: 'line', x: 200 }] },
    });
    const rule = nodesOfKind(run.laid.nodes, 'line').find(
      (node) => node.cls?.includes('mdv-annotation') === true,
    );
    // With the axes swapped, the value 200 is an *x* position and the rule is vertical.
    expect(rule?.x1).toBe(rule?.x2);
    expect(rule?.y1).not.toBe(rule?.y2);
  });

  it('draws annotations over the marks, never under them', () => {
    const run = runChart(lineChart, quarters(), { encoding: QUARTERLY, attrs });
    const nodes = run.laid.nodes;
    const lastMark = nodes
      .map((node) => node.cls?.startsWith('mdv-mark') === true)
      .lastIndexOf(true);
    const firstAnnotation = nodes.findIndex(
      (node) => node.cls?.startsWith('mdv-annotation') === true,
    );
    expect(firstAnnotation).toBeGreaterThan(lastMark);
  });
});

describe('annotations: degenerate input', () => {
  it('emits no NaN for positions off the end of the scale', () => {
    const run = runChart(lineChart, quarters(), {
      encoding: QUARTERLY,
      attrs: {
        annotations: [
          { type: 'line', y: 1e12 },
          { type: 'line', y: -1e12 },
          { type: 'band', y: [Number.NaN, 5] },
          { type: 'point', x: 'Q1', y: Number.POSITIVE_INFINITY },
        ],
      },
    });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN over an empty chart', () => {
    const run = runChart(
      lineChart,
      makeTable(
        [
          ['quarter', 'string'],
          ['revenue', 'number'],
        ],
        [],
      ),
      {
        encoding: QUARTERLY,
        attrs: { annotations: [{ type: 'line', y: 100, label: 'Target' }] },
      },
    );
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('emits no NaN in a frame with no room', () => {
    for (const frame of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 2000, height: 4 },
      { x: 0, y: 0, width: 0, height: 0 },
    ]) {
      const run = runChart(lineChart, quarters(), {
        encoding: QUARTERLY,
        attrs: { annotations: [{ type: 'band', y: [100, 300], label: 'Range' }] },
        frame,
      });
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('never throws, whatever the document says', () => {
    expect(() =>
      runChart(lineChart, quarters(), {
        encoding: QUARTERLY,
        attrs: { annotations: [{ type: 42, x: {}, y: [], label: 7, style: null }] },
      }),
    ).not.toThrow();
  });
});

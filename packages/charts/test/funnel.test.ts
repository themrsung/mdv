/**
 * `funnel` (SPEC 8.12), asserted numerically.
 *
 * The fixture is one four-stage funnel whose numbers are chosen so that every
 * pixel this suite names is a whole one:
 *
 *   - the frame is the harness's 400 × 200. Four stages over 200 px give a band
 *     of 50, and the theme's 2 px surface gap insets each stage by 1 px at both
 *     ends (`min(gap / 2, band / 4)`), so the stages occupy y 1‥49, 51‥99,
 *     101‥149 and 151‥199 — adjacent silhouettes are separated by the gap, not
 *     by band padding, which stays zero;
 *   - the counts 1000 / 600 / 300 / 120 are read against a domain pinned to
 *     `[0, 1000]` across the full 400 px width, so a stage's width in pixels is
 *     its count in units of 2.5: 400, 240, 120 and 48.
 *
 * What the suite leans on:
 *
 *   - a funnel is a *sequence*, not a distribution: rows are drawn in document
 *     order, there is no value axis, and the width is the whole claim. A test
 *     that only measured heights would pass on a chart drawn as bars;
 *   - the silhouette is continuous across a seam — a stage's trailing edge is
 *     its successor's leading edge — which is what makes the shape read as one
 *     narrowing pipe rather than four detached trapezoids;
 *   - the numbers reach the reader through labels and the a11y table, because
 *     there is no axis to read them off, and the share and the change are
 *     *derived*: they are what the shape shows, not columns the document holds;
 *   - a sign has to survive a greyscale print (SPEC 11.6), so a stage that grew
 *     says `+12 %` in words rather than relying on the direction of a colour.
 */

import { describe, expect, it } from 'vitest';
import { type BarMark, type Rect, type Table } from '@mdv/core';
import { funnelChart, type FunnelEncodeResult } from '../src/funnel.js';
import {
  EMPTY_TABLE,
  type ChartRun,
  attrsOf,
  codesOf,
  makeTable,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const FIELDS = [
  ['stage', 'category'],
  ['people', 'number'],
] as const;

/** 400 × 200 at the origin — the same frame the rest of the suite uses. */
const FRAME: Rect = { x: 0, y: 0, width: 400, height: 200 };

const ENCODING = { category: { field: 'stage' }, value: { field: 'people' } };

/** Visits → Signups → Trial → Purchase: 60 %, 50 %, 40 % of what came before. */
function walk(): Table {
  return makeTable(FIELDS, [
    ['Visits', 1000],
    ['Signups', 600],
    ['Trial', 300],
    ['Purchase', 120],
  ]);
}

function runFunnel(
  table: Table = walk(),
  options: Parameters<typeof runChart>[2] = {},
): ChartRun<BarMark> {
  return runChart(funnelChart, table, { encoding: ENCODING, frame: FRAME, ...options });
}

/** The per-mark state a funnel carries from `encode` to `layout`. */
function planOf(run: ChartRun<BarMark>): FunnelEncodeResult['state'] {
  return (run.encoded as FunnelEncodeResult).state;
}

/** Every drawn silhouette, in document order. */
function silhouettes(run: ChartRun<BarMark>): readonly Record<string, unknown>[] {
  return nodesOfKind(run.laid.nodes, 'path').filter(
    (node) => node.cls === 'mdv-mark mdv-mark-funnel',
  ) as unknown as readonly Record<string, unknown>[];
}

/** `M0,1 L400,1 L320,49 L80,49 Z` — a path written the way a reader checks it. */
function pathOf(node: Record<string, unknown>): string {
  const commands = node['d'] as readonly Record<string, number | string>[];
  return commands
    .map((command) =>
      command['c'] === 'Z' ? 'Z' : `${command['c']}${command['x']},${command['y']}`,
    )
    .join(' ');
}

function pathsOf(run: ChartRun<BarMark>): string[] {
  return silhouettes(run).map(pathOf);
}

describe('funnel geometry (SPEC 8.12)', () => {
  it('draws one silhouette per stage, in document order', () => {
    const run = runFunnel();
    expect(silhouettes(run)).toHaveLength(4);
    expect(planOf(run).entries.map((entry) => entry.label)).toEqual([
      'Visits',
      'Signups',
      'Trial',
      'Purchase',
    ]);
  });

  it('scales width against the first stage, not against the frame', () => {
    // 1000 / 600 / 300 / 120 over a 400 px width: 400, 240, 120, 48.
    const run = runFunnel();
    expect(pathsOf(run)).toEqual([
      'M0,1 L400,1 L320,49 L80,49 Z',
      'M80,51 L320,51 L260,99 L140,99 Z',
      'M140,101 L260,101 L224,149 L176,149 Z',
      'M176,151 L224,151 L224,199 L176,199 Z',
    ]);
  });

  it('hands each stage the leading edge its predecessor left', () => {
    // The seam is the claim: stage n's trailing width is stage n+1's leading
    // width, so the outline is one pipe. Read the paths as pairs of x's.
    const run = runFunnel();
    const paths = pathsOf(run);
    for (let index = 0; index + 1 < paths.length; index += 1) {
      const trailing = (paths[index] ?? '').split(' ').slice(2, 4);
      const leading = (paths[index + 1] ?? '').split(' ').slice(0, 2);
      expect(trailing.map((point) => point.slice(1).split(',')[0]).sort()).toEqual(
        leading.map((point) => point.slice(1).split(',')[0]).sort(),
      );
    }
  });

  it('closes the last stage square, because nothing follows it to taper to', () => {
    const run = runFunnel();
    expect(pathsOf(run).at(-1)).toBe('M176,151 L224,151 L224,199 L176,199 Z');
  });

  it('draws every stage as a rectangle when the author asks for one', () => {
    const run = runFunnel(walk(), { attrs: attrsOf({ shape: 'rect' }) });
    expect(pathsOf(run)).toEqual([
      'M0,1 L400,1 L400,49 L0,49 Z',
      'M80,51 L320,51 L320,99 L80,99 Z',
      'M140,101 L260,101 L260,149 L140,149 Z',
      'M176,151 L224,151 L224,199 L176,199 Z',
    ]);
  });

  it('runs the flow left to right when the orientation is horizontal', () => {
    // Same numbers, transposed: the stages step across x and the widths become
    // heights, centred on the frame's vertical middle.
    const run = runFunnel(walk(), { attrs: attrsOf({ orientation: 'horizontal' }) });
    expect(pathsOf(run)).toEqual([
      'M1,0 L1,200 L99,160 L99,40 Z',
      'M101,40 L101,160 L199,130 L199,70 Z',
      'M201,70 L201,130 L299,112 L299,88 Z',
      'M301,88 L301,112 L399,112 L399,88 Z',
    ]);
  });

  it('still draws a stage nobody reached, one pixel wide', () => {
    // Zero is the most important fact a funnel can carry. Dropping the row
    // would close the gap in the sequence and hide it.
    const run = runFunnel(
      makeTable(FIELDS, [
        ['Visits', 1000],
        ['Signups', 0],
        ['Trial', 0],
        ['Purchase', 0],
      ]),
    );
    expect(pathsOf(run)).toEqual([
      'M0,1 L400,1 L200.5,49 L199.5,49 Z',
      'M199.5,51 L200.5,51 L200.5,99 L199.5,99 Z',
      'M199.5,101 L200.5,101 L200.5,149 L199.5,149 Z',
      'M199.5,151 L200.5,151 L200.5,199 L199.5,199 Z',
    ]);
  });

  it('draws nothing at all in a frame with no usable area', () => {
    const run = runFunnel(walk(), { frame: { x: 0, y: 0, width: 400, height: 0 } });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('gives every stage a hit region that covers its band, not its trapezoid', () => {
    // A pointer near a tapering edge is still pointing at that stage.
    const run = runFunnel();
    expect(run.laid.hits.map((hit) => [hit.x, hit.y, hit.w, hit.h])).toEqual([
      [0, 1, 400, 48],
      [80, 51, 240, 48],
      [140, 101, 120, 48],
      [176, 151, 48, 48],
    ]);
  });
});

describe('funnel colour and labels (SPEC 11.3, 11.5)', () => {
  it('deepens one ramp along the flow rather than spending a palette slot', () => {
    const run = runFunnel();
    const colors = planOf(run).entries.map((entry) => entry.color);
    expect(new Set(colors).size).toBe(4);
    expect(run.encoded.series).toHaveLength(1);
  });

  it('never tints the label, whatever the stage is filled with', () => {
    const run = runFunnel();
    for (const label of run.laid.labels ?? []) {
      expect(label).not.toHaveProperty('fill');
    }
  });

  it('puts the value inside the stage while the stage is wide enough to hold it', () => {
    const run = runFunnel();
    const inside = (run.laid.labels ?? []).filter((label) => label.placement === 'inside');
    expect(inside.map((label) => label.text)).toEqual(['1,000', '600', '300', '120']);
  });
});

describe('funnel readout and words (SPEC 8.12, 12.3)', () => {
  it('reads each stage as a share of the first and a change from the last', () => {
    const run = runFunnel();
    expect(run.encoded.a11yTable?.columns.map((column) => column.name)).toEqual([
      'Stage',
      'People',
      'Share of first',
      'Change',
    ]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Visits', '1,000', '100.0%', ''],
      ['Signups', '600', '60.0%', '-40.0%'],
      ['Trial', '300', '30.0%', '-50.0%'],
      ['Purchase', '120', '12.0%', '-60.0%'],
    ]);
  });

  it('spells a rise with its sign, so the direction survives a greyscale print', () => {
    const run = runFunnel(
      makeTable(FIELDS, [
        ['Visits', 100],
        ['Signups', 112],
      ]),
    );
    expect(run.encoded.a11yTable?.rows.at(-1)).toEqual(['Signups', '112', '112.0%', '+12.0%']);
  });

  it('leaves the share undefined when nobody arrived to be a share of', () => {
    // Zero cannot be divided into. The stage is still drawn and still read.
    const run = runFunnel(
      makeTable(FIELDS, [
        ['Visits', 0],
        ['Signups', 0],
      ]),
    );
    expect(planOf(run).entries.map((entry) => entry.share)).toEqual([undefined, undefined]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Visits', '0', '', ''],
      ['Signups', '0', '', ''],
    ]);
  });

  it('names the flow, its length, and where it fell hardest', () => {
    const run = runFunnel();
    expect(run.description).toContain('Funnel chart');
    expect(run.description).toContain('4 stages');
    // The sentence rounds where it is spoken and keeps the decimal where it is
    // read: `12%` here, `12.0%` in the table above.
    expect(run.description).toContain(
      '1,000 at Visits falls to 120 at Purchase, 12% of the first stage',
    );
    expect(run.description).toContain('Steepest fall at Purchase, -60%');
  });

  it('says nothing about a steepest fall when nothing ever fell', () => {
    const run = runFunnel(
      makeTable(FIELDS, [
        ['Visits', 100],
        ['Signups', 112],
      ]),
    );
    expect(run.description).not.toContain('Steepest fall');
  });
});

describe('funnel degradation (SPEC 15.2, 6.5)', () => {
  it('asks for the two channels it cannot draw without', () => {
    const run = runChart(funnelChart, walk(), { frame: FRAME });
    expect(codesOf(run.validation)).toEqual(['MDV3000', 'MDV3000']);
  });

  it('names a field that is not a column', () => {
    const run = runFunnel(walk(), {
      encoding: { category: { field: 'stage' }, value: { field: 'profit' } },
    });
    expect(codesOf(run.validation)).toContain('MDV3000');
  });

  it('refuses a value channel it cannot measure', () => {
    // A funnel counts what is left of a population; a category cannot be
    // counted, and the message says what the channel does accept.
    const run = runFunnel(walk(), {
      encoding: { category: { field: 'people' }, value: { field: 'stage' } },
    });
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
    expect(run.validation[0]?.message).toBe('`value` is bound to `stage`, which is category');
  });

  it('drops a row that counts fewer than nobody, and says how many', () => {
    const run = runFunnel(
      makeTable(FIELDS, [
        ['Visits', 1000],
        ['Signups', -5],
        ['Trial', 300],
      ]),
    );
    expect(codesOf(run.validation)).toContain('MDV3001');
    expect(run.encoded.droppedRows).toBe(1);
    expect(silhouettes(run)).toHaveLength(2);
  });

  it('tells an author that a value scale is inert here', () => {
    const run = runFunnel(walk(), {
      encoding: {
        category: { field: 'stage' },
        value: { field: 'people', scale: { domain: [0, 5000], type: 'log' } },
      },
    });
    expect(codesOf(run.validation)).toContain('MDV1501');
    expect(run.validation.map((diagnostic) => diagnostic.message).join(' ')).toContain(
      '`value.scale.type` and `value.scale.domain` have no effect on a funnel',
    );
    // Inert means inert: the widths are unchanged.
    expect(pathsOf(run)).toEqual(pathsOf(runFunnel()));
  });

  it('survives a table with columns but no rows', () => {
    const run = runFunnel(noRows(FIELDS));
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Funnel chart with no data.');
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('survives the empty table', () => {
    const run = runChart(funnelChart, EMPTY_TABLE, { frame: FRAME });
    expect(run.laid.nodes).toEqual([]);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
  });

  it('never produces a number that is not a number', () => {
    expect(nonFiniteNumbers(runFunnel().laid)).toEqual([]);
    expect(
      nonFiniteNumbers(runFunnel(walk(), { attrs: attrsOf({ orientation: 'horizontal' }) }).laid),
    ).toEqual([]);
  });
});

/**
 * `sankey` (SPEC 8.12), asserted numerically.
 *
 * Three fixtures, all built from the same three columns — `source`, `target`,
 * `energy` — because a sankey has no table of its own: the nodes are whatever
 * the flows happen to name, and that derivation is half of what these tests are
 * for. The two ends reach the chart as *attributes* and the magnitude as a
 * channel, which is the split the cascade actually produces; see {@link ENDS}.
 *
 *   - **grid** — two fuels into one grid and the grid out to two uses: Coal 100
 *     and Gas 100 in, Homes 150 and Industry 50 out. 200 enters, 200 leaves, and
 *     `Grid` balances. In the harness's 400 × 200 frame the three columns sit at
 *     x = 0, 192 and 384, each 16 px wide, and one scale of 0.94 px per unit
 *     falls out of the fullest column: 200 units of band plus one 12 px gap in
 *     200 px of height. Every band and every ribbon this suite names is a whole
 *     pixel because of it;
 *   - **refinery** — the same shape with slack in it: Wells 60 to Refinery and
 *     20 to Flare, Refinery 50 on to Petrol, Import 40 straight to Petrol.
 *     `Flare` is terminal but early, `Import` is a source but late, and
 *     `Refinery` loses 10 on the way through — so the four `align` modes put the
 *     nodes in four different places, and one node has an `In` that is not its
 *     `Out`;
 *   - **crossing** — Alpha and Bravo both feeding Xray and Yankee, written in an
 *     order the columns disagree with, so that the ribbon ordering has something
 *     to get wrong.
 *
 * What the suite leans on:
 *
 *   - **a node is worth the larger of what enters and what leaves**, never the
 *     sum. A band that added its two sides would double-count every unit that
 *     passes through, and the ribbons either side of it would no longer fit;
 *   - **conservation is visible in the geometry**. A ribbon is the same
 *     thickness at both ends, and the offsets stack so that the ribbons leaving
 *     a band exactly fill it. Both are checked against `value × scale` rather
 *     than against a remembered rectangle, so a layout that drifted fails on the
 *     arithmetic;
 *   - **ribbons leave in the order they land** (and arrive in the order they
 *     left), which is why `crossing` exists: two flows between the same pair of
 *     columns must cross only when the data crosses, never because of the order
 *     someone typed the rows in;
 *   - **a loop is refused, not drawn** (`MDV3070`), once, and the rest of the
 *     diagram still renders — a sankey runs one way, and a cycle has no order to
 *     draw it in;
 *   - **a name is drawn only where it fits, uncropped** (SPEC 11.5): outside the
 *     band, on the other side in the last column, and not at all when the band
 *     is too short to own a line or the frame too narrow to hold the word;
 *   - the numbers reach the reader through the table view and the description,
 *     since a sankey has no axis to read anything off (SPEC 12.3).
 */

import { describe, expect, it } from 'vitest';
import { type LinkMark, type Table } from '@mdv/core';
import { sankeyChart, type SankeyEncodeResult } from '../src/sankey.js';
import {
  EMPTY_TABLE,
  FRAME,
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
  ['source', 'category'],
  ['target', 'category'],
  ['energy', 'number'],
] as const;

/**
 * The two ends, written the way an author writes them.
 *
 * SPEC 8.12 lists `source`, `target` and `value`, but the channel vocabulary of
 * SPEC 7.1 is shared and closed and neither end is in it, so the two halves
 * arrive through different doors: the ends are attributes the cascade leaves in
 * the header, and only `value` is promoted into `encoding`. The fixtures spell
 * that split out rather than handing `encode` a tidier encoding it could never
 * have been given — a suite that hands itself `source:` as a channel is a suite
 * that passes for a document nobody can write.
 */
const ENDS = { source: 'source', target: 'target' } as const;

const ENCODING = { value: { field: 'energy' } };

/** Two fuels into one grid, and the grid out to two uses. 200 in, 200 out. */
function grid(): Table {
  return makeTable(FIELDS, [
    ['Coal', 'Grid', 100],
    ['Gas', 'Grid', 100],
    ['Grid', 'Homes', 150],
    ['Grid', 'Industry', 50],
  ]);
}

/** Slack in three directions: an early sink, a late source, and a lossy middle. */
function refinery(): Table {
  return makeTable(FIELDS, [
    ['Wells', 'Refinery', 60],
    ['Refinery', 'Petrol', 50],
    ['Wells', 'Flare', 20],
    ['Import', 'Petrol', 40],
  ]);
}

/** Two sources into two targets, in a row order the columns disagree with. */
function crossing(): Table {
  return makeTable(FIELDS, [
    ['Alpha', 'Xray', 10],
    ['Bravo', 'Yankee', 10],
    ['Alpha', 'Yankee', 10],
    ['Bravo', 'Xray', 10],
  ]);
}

function runSankey(
  table: Table = grid(),
  options: Parameters<typeof runChart>[2] = {},
): ChartRun<LinkMark> {
  const { attrs, ...rest } = options;
  return runChart(sankeyChart, table, {
    encoding: ENCODING,
    attrs: attrsOf({ ...ENDS, ...attrs }),
    frame: FRAME,
    ...rest,
  });
}

/** The per-mark state a sankey carries from `encode` to `layout`. */
function planOf(run: ChartRun<LinkMark>): SankeyEncodeResult['state'] {
  return (run.encoded as SankeyEncodeResult).state;
}

/** Every band, in paint order, as `[x, y, w, h]`. */
function bands(run: ChartRun<LinkMark>): number[][] {
  return nodesOfKind(run.laid.nodes, 'rect').map((node) => [node.x, node.y, node.w, node.h]);
}

/** Every ribbon, in paint order, as its path commands. */
function ribbons(run: ChartRun<LinkMark>): unknown[][] {
  return nodesOfKind(run.laid.nodes, 'path').map((node) => [...node.d]);
}

function labelsOf(run: ChartRun<LinkMark>): string[] {
  return nodesOfKind(run.laid.nodes, 'text').map((node) => node.text);
}

/** `[label, value]` for a readout, so a test says what it means about colour. */
function readoutOf(rows: readonly { label: string; value: string }[]): string[][] {
  return rows.map((row) => [row.label, row.value]);
}

// ─────────────────────────────────────────────────────────────────────────────

describe('sankey graph (SPEC 8.12)', () => {
  it('derives its nodes from the flows, in first-appearance order', () => {
    // Nothing in the table says `Grid` is a node: it is one because two rows
    // named it, and it is second because the first row named it second.
    const plan = planOf(runSankey());
    expect(plan.nodes.map((node) => node.label)).toEqual([
      'Coal',
      'Grid',
      'Gas',
      'Homes',
      'Industry',
    ]);
    expect(plan.links.map((link) => [link.source, link.target, link.value])).toEqual([
      [0, 1, 100],
      [2, 1, 100],
      [1, 3, 150],
      [1, 4, 50],
    ]);
  });

  it('makes a node worth the larger of what enters and what leaves', () => {
    // The sum would double-count every unit that passes through, and the band
    // would then be too tall for the ribbons on either side of it.
    const plan = planOf(runSankey());
    expect(plan.nodes.map((node) => [node.incoming, node.outgoing, node.value])).toEqual([
      [0, 100, 100],
      [200, 200, 200],
      [0, 100, 100],
      [150, 0, 150],
      [50, 0, 50],
    ]);
  });

  it('counts what enters the diagram once, at the bands nothing flows into', () => {
    // 200, not 400: Grid's 200 is Coal's and Gas's 200 seen a second time.
    expect(planOf(runSankey()).total).toBe(200);
    expect(planOf(runSankey(refinery())).total).toBe(120);
  });

  it('reads its two ends from the header, which is where the cascade leaves them', () => {
    // `source` and `target` are outside the shared vocabulary of SPEC 7.1, so
    // the cascade never promotes them and `encoding` cannot carry them at all.
    // A header that names them draws; the same block with only `value` bound is
    // told which two columns are missing and draws nothing.
    expect(planOf(runSankey()).nodes.map((node) => node.label)).toEqual([
      'Coal',
      'Grid',
      'Gas',
      'Homes',
      'Industry',
    ]);
    const endless = runChart(sankeyChart, grid(), { encoding: ENCODING, frame: FRAME });
    expect(codesOf(endless.validation)).toEqual(['MDV3000', 'MDV3000']);
    expect(endless.laid.nodes).toEqual([]);
  });
});

describe('sankey columns (SPEC 8.12)', () => {
  const depths = (align?: string): (string | number)[][] =>
    planOf(
      runSankey(refinery(), align === undefined ? {} : { attrs: attrsOf({ align }) }),
    ).nodes.map((node) => [node.label, node.depth]);

  it('puts every node in the earliest column it can reach when aligned left', () => {
    expect(depths('left')).toEqual([
      ['Wells', 0],
      ['Refinery', 1],
      ['Petrol', 2],
      ['Flare', 1],
      ['Import', 0],
    ]);
  });

  it('hangs every node off the latest column it feeds when aligned right', () => {
    // Import has only one customer and it is in the last column, so right-align
    // pushes it up against Petrol rather than leaving it at the left edge.
    expect(depths('right')).toEqual([
      ['Wells', 0],
      ['Refinery', 1],
      ['Petrol', 2],
      ['Flare', 2],
      ['Import', 1],
    ]);
  });

  it('lines the terminal states up at the right edge by default', () => {
    // `justify` is the default because "how much ended here rather than there"
    // is the comparison a sankey is usually read for, and it needs one edge.
    const justified = [
      ['Wells', 0],
      ['Refinery', 1],
      ['Petrol', 2],
      ['Flare', 2],
      ['Import', 0],
    ];
    expect(depths('justify')).toEqual(justified);
    expect(depths()).toEqual(justified);
  });

  it('sits a source against the earliest thing it feeds when centred', () => {
    expect(depths('center')).toEqual([
      ['Wells', 0],
      ['Refinery', 1],
      ['Petrol', 2],
      ['Flare', 1],
      ['Import', 1],
    ]);
  });

  it('names an alignment it does not know and justifies instead', () => {
    const run = runSankey(refinery(), { attrs: attrsOf({ align: 'middle' }) });
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV1502']);
    expect(run.encodeDiagnostics[0]?.message).toBe(
      '`align: middle` is not a recognised value; using `justify`',
    );
    expect(planOf(run).nodes.map((node) => node.depth)).toEqual([0, 1, 2, 2, 0]);
  });

  it('stacks the flows so they leave in the order they land', () => {
    // Bravo's rows were written Yankee first, but Xray is the upper target, so
    // Bravo's ribbons leave in the order Xray, Yankee — the order they arrive.
    const plan = planOf(runSankey(crossing()));
    expect(plan.nodes.map((node) => [node.label, node.depth])).toEqual([
      ['Alpha', 0],
      ['Xray', 1],
      ['Bravo', 0],
      ['Yankee', 1],
    ]);
    expect(plan.links.map((link) => [link.sourceOffset, link.targetOffset])).toEqual([
      [0, 0],
      [10, 10],
      [10, 0],
      [0, 10],
    ]);
  });

  it('stacks a band full: every ribbon leaving it is accounted for', () => {
    const plan = planOf(runSankey());
    expect(plan.links.map((link) => [link.sourceOffset, link.targetOffset])).toEqual([
      [0, 0],
      [0, 100],
      [0, 0],
      [150, 0],
    ]);
    // Grid's two outgoing offsets plus the second flow's value reach its total.
    const grid = plan.nodes[1];
    const last = plan.links[3];
    expect((last?.sourceOffset ?? 0) + (last?.value ?? 0)).toBe(grid?.value);
  });
});

describe('sankey geometry (SPEC 8.12)', () => {
  it('gives every band a height that is its share of one scale', () => {
    // 200 units and one 12 px gap in 200 px of height is 0.94 px per unit, and
    // every band in the diagram is that scale times its own value.
    const run = runSankey();
    const plan = planOf(run);
    const heights = bands(run).map((box) => box[3]);
    expect(heights).toEqual(plan.nodes.map((node) => node.value * 0.94));
    expect(bands(run)).toEqual([
      [0, 0, 16, 94],
      [192, 6, 16, 188],
      [0, 106, 16, 94],
      [384, 0, 16, 141],
      [384, 153, 16, 47],
    ]);
  });

  it('spaces the columns across the frame and centres each one vertically', () => {
    // Three 16 px bands at 0, 192 and 384. The middle column has no gap in it,
    // so it is 12 px shorter than the others and hangs 6 px from the top.
    const run = runSankey();
    expect(bands(run).map((box) => box[0])).toEqual([0, 192, 0, 384, 384]);
    expect(bands(run).map((box) => box[1])).toEqual([0, 6, 106, 0, 153]);
  });

  it('draws a ribbon the same thickness at both ends', () => {
    // The claim the whole picture rests on: what leaves is what arrives.
    const run = runSankey();
    const plan = planOf(run);
    for (const [index, d] of ribbons(run).entries()) {
      const [start, out, across, back] = d as {
        x?: number;
        y?: number;
      }[];
      const thickness = (plan.links[index]?.value ?? 0) * 0.94;
      expect((back?.y ?? 0) - (start?.y ?? 0)).toBeCloseTo(thickness, 9);
      expect((across?.y ?? 0) - (out?.y ?? 0)).toBeCloseTo(thickness, 9);
      expect(across?.x).toBe(out?.x);
    }
  });

  it('leaves and arrives horizontally, with both control points on the halfway line', () => {
    // A ribbon that met its band at a slant would read as a change in quantity.
    expect(ribbons(runSankey())[0]).toEqual([
      { c: 'M', x: 16, y: 0 },
      { c: 'C', x1: 104, y1: 0, x2: 104, y2: 6, x: 192, y: 6 },
      { c: 'L', x: 192, y: 100 },
      { c: 'C', x1: 104, y1: 100, x2: 104, y2: 94, x: 16, y: 94 },
      { c: 'Z' },
    ]);
  });

  it('stacks the ribbons into the band in column order', () => {
    // Gas is the lower band in the first column, so its ribbon meets Grid below
    // Coal's — 94 px down, which is exactly Coal's thickness.
    const [, gas, homes, industry] = ribbons(runSankey());
    expect(gas?.[0]).toEqual({ c: 'M', x: 16, y: 106 });
    expect(gas?.[1]).toEqual({ c: 'C', x1: 104, y1: 106, x2: 104, y2: 100, x: 192, y: 100 });
    expect(homes?.[0]).toEqual({ c: 'M', x: 208, y: 6 });
    expect(industry?.[0]).toEqual({ c: 'M', x: 208, y: 147 });
  });

  it('paints the ribbons first, so the bands they meet cover their ends', () => {
    expect(runSankey().laid.nodes.map((node) => node.kind)).toEqual([
      'path',
      'path',
      'path',
      'path',
      'rect',
      'text',
      'rect',
      'text',
      'rect',
      'text',
      'rect',
      'text',
      'rect',
      'text',
    ]);
  });

  it('narrows the bands rather than the gaps when the frame is tight', () => {
    // Six band-widths is the floor: below it the diagram is bands, not flows.
    const run = runSankey(grid(), { frame: { x: 0, y: 0, width: 60, height: 200 } });
    expect(bands(run).map((box) => box[2])).toEqual([10, 10, 10, 10, 10]);
    expect(bands(run).map((box) => box[0])).toEqual([0, 25, 0, 50, 50]);
  });

  it('lets the author set the band width and the ribbon opacity', () => {
    const run = runSankey(grid(), { attrs: attrsOf({ nodeWidth: 30, linkOpacity: 1 }) });
    expect(bands(run).map((box) => box[2])).toEqual([30, 30, 30, 30, 30]);
    expect(nodesOfKind(run.laid.nodes, 'path')[0]?.fill).toEqual({
      kind: 'solid',
      color: '#111180',
      opacity: 1,
    });
    expect(nodesOfKind(runSankey().laid.nodes, 'path')[0]?.fill).toEqual({
      kind: 'solid',
      color: '#111180',
      opacity: 0.45,
    });
  });

  it('caps the gaps at half the height so the bands keep something to be', () => {
    const run = runSankey(grid(), { attrs: attrsOf({ nodePadding: 200 }) });
    // 100 px of gap, 100 px left for 200 units: half a pixel each.
    expect(bands(run).map((box) => box[3])).toEqual([50, 100, 50, 75, 25]);
  });

  it('takes no ink for a flow of nothing, and still lists it', () => {
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Grid', 'Homes', 100],
        ['Grid', 'Waste', 0],
      ]),
    );
    expect(ribbons(run)).toHaveLength(2);
    expect(bands(run)).toHaveLength(3);
    expect(planOf(run).nodes.map((node) => node.label)).toEqual(['Coal', 'Grid', 'Homes', 'Waste']);
    expect(run.encoded.a11yTable?.rows[2]).toEqual(['Grid', 'Waste', '0', '0.0%']);
  });
});

describe('sankey targets (SPEC 12.1)', () => {
  it('gives every band and every ribbon something to point at', () => {
    const run = runSankey();
    expect(run.laid.hits).toHaveLength(9);
    expect(run.laid.hits.slice(0, 4).map((hit) => hit.datumIndex)).toEqual([0, 1, 2, 3]);
  });

  it('targets the middle third of a ribbon, where it is unambiguously itself', () => {
    // Over its whole span it would swallow every ribbon it crosses.
    const hit = runSankey().laid.hits[0];
    expect([hit?.x, hit?.y, hit?.w, hit?.h]).toEqual([74.6667, 3, 58.6667, 94]);
    expect(hit?.anchor).toEqual({ x: 104, y: 50 });
  });

  it('targets a band over the rectangle it drew', () => {
    const run = runSankey();
    const hit = run.laid.hits[4];
    expect([hit?.x, hit?.y, hit?.w, hit?.h]).toEqual([0, 0, 16, 94]);
    expect(hit?.markNodeId).toBe(nodesOfKind(run.laid.nodes, 'rect')[0]?.id);
  });

  it('tells a band both sides only when they disagree', () => {
    // Repeating one number under two headings tells a reader nothing.
    const balanced = planOf(runSankey()).nodes[1];
    expect(readoutOf(balanced?.readout ?? [])).toEqual([
      ['Grid', '200'],
      ['Share of total', '100.0%'],
    ]);
    const lossy = planOf(runSankey(refinery())).nodes[1];
    expect(readoutOf(lossy?.readout ?? [])).toEqual([
      ['Refinery', '60'],
      ['In', '60'],
      ['Out', '50'],
      ['Share of total', '50.0%'],
    ]);
  });

  it('tells a ribbon what fraction of each end it is', () => {
    const plan = planOf(runSankey());
    expect(readoutOf(plan.links[0]?.readout ?? [])).toEqual([
      ['Coal → Grid', '100'],
      ['Share of Grid', '50.0%'],
      ['Share of total', '50.0%'],
    ]);
    // Homes takes all of Grid's 150, so there is no share of Homes to report.
    expect(readoutOf(plan.links[2]?.readout ?? [])).toEqual([
      ['Grid → Homes', '150'],
      ['Share of Grid', '75.0%'],
      ['Share of total', '75.0%'],
    ]);
  });
});

describe('sankey colour (SPEC 11.2)', () => {
  it('gives every node a slot, in the order the flows named them', () => {
    const run = runSankey();
    expect(run.encoded.series.map((series) => [series.id, series.slot])).toEqual([
      ['Coal', 0],
      ['Grid', 1],
      ['Gas', 2],
      ['Homes', 3],
      ['Industry', 4],
    ]);
    expect(run.encoded.series.every((series) => series.source === 'source')).toBe(true);
  });

  it('paints a ribbon in the colour of the node it came from', () => {
    const plan = planOf(runSankey());
    for (const link of plan.links) {
      expect(link.color).toBe(plan.nodes[link.source]?.color);
      expect(link.seriesId).toBe(plan.nodes[link.source]?.seriesId);
    }
  });
});

describe('sankey labels (SPEC 11.5)', () => {
  it('writes each name outside its band, and inside it in the last column', () => {
    const run = runSankey();
    const texts = nodesOfKind(run.laid.nodes, 'text');
    expect(texts.map((node) => [node.text, node.x, node.y, node.anchor])).toEqual([
      ['Coal', 18, 47, 'start'],
      ['Grid', 210, 100, 'start'],
      ['Gas', 18, 153, 'start'],
      ['Homes', 382, 70.5, 'end'],
      ['Industry', 382, 176.5, 'end'],
    ]);
  });

  it('refuses a name a band is too short to own', () => {
    // With no padding there is nothing under the band to lend it, and one line
    // of the tick font is 11.05 px.
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Gas', 'Grid', 100],
        ['Grid', 'Homes', 199],
        ['Grid', 'Industry', 1],
      ]),
      { attrs: attrsOf({ nodePadding: 0 }) },
    );
    expect(bands(run)).toHaveLength(5);
    expect(labelsOf(run)).toEqual(['Coal', 'Grid', 'Gas', 'Homes']);
  });

  it('refuses a name that would not fit on either side of its band', () => {
    // Half a word beside a band is worse than none, and the table view has
    // every name anyway.
    const run = runSankey(makeTable(FIELDS, [['Extraordinarily Long Source Name', 'B', 100]]), {
      frame: { x: 0, y: 0, width: 60, height: 200 },
    });
    expect(bands(run)).toHaveLength(2);
    expect(labelsOf(run)).toEqual(['B']);
  });

  it('leaves the bands bare when the author turns labels off', () => {
    expect(
      nodesOfKind(runSankey(grid(), { attrs: attrsOf({ label: false }) }).laid.nodes, 'text'),
    ).toEqual([]);
  });
});

describe('sankey words (SPEC 12.3)', () => {
  it('lists every flow as the author wrote it', () => {
    const run = runSankey();
    expect(run.encoded.a11yTable?.columns.map((column) => [column.name, column.align])).toEqual([
      ['Source', 'left'],
      ['Target', 'left'],
      ['Energy', 'right'],
      ['Share', 'right'],
    ]);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Coal', 'Grid', '100', '50.0%'],
      ['Gas', 'Grid', '100', '50.0%'],
      ['Grid', 'Homes', '150', '75.0%'],
      ['Grid', 'Industry', '50', '25.0%'],
    ]);
  });

  it('counts the flows, the nodes, the stages, and the biggest ribbon', () => {
    expect(runSankey().description).toBe(
      'Sankey diagram. Energy by source, 4 flows between 5 nodes in 3 stages. ' +
        '200 enters the diagram. Largest flow: Grid to Homes, 150.',
    );
    expect(runSankey(refinery()).description).toBe(
      'Sankey diagram. Energy by source, 4 flows between 5 nodes in 3 stages. ' +
        '120 enters the diagram. Largest flow: Wells to Refinery, 60.',
    );
  });
});

describe('sankey degradation (SPEC 15.2, 6.5)', () => {
  it('asks for the three columns it cannot draw without', () => {
    const run = runChart(sankeyChart, grid(), { encoding: {}, frame: FRAME });
    expect(codesOf(run.validation)).toEqual(['MDV3000', 'MDV3000', 'MDV3000']);
    expect(run.validation.map((diagnostic) => diagnostic.detail)).toEqual([
      'Bind `source` to a column: where each flow leaves',
      'Bind `target` to a column: where each flow arrives',
      'Bind `value` to a column: how much flows',
    ]);
    expect(run.laid.nodes).toEqual([]);
  });

  it('names a field that is not a column, for each of the three it reads', () => {
    const run = runChart(sankeyChart, grid(), {
      attrs: attrsOf({ source: 'a', target: 'b' }),
      encoding: { value: { field: 'c' } },
      frame: FRAME,
    });
    expect(codesOf(run.validation)).toEqual(['MDV3000', 'MDV3000', 'MDV3000']);
    expect(run.validation.map((diagnostic) => diagnostic.message)).toEqual([
      '`source` names `a`, which is not a column',
      '`target` names `b`, which is not a column',
      '`value` names `c`, which is not a column',
    ]);
  });

  it('refuses a value channel it cannot measure', () => {
    const run = runSankey(grid(), { encoding: { value: { field: 'target' } } });
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
    expect(run.validation[0]?.message).toBe('`value` is bound to `target`, which is category');
  });

  it('sends a negative flow back to its author, and draws the rest', () => {
    // A ribbon has no direction to run backwards in: a negative flow is two
    // names in the wrong order.
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Gas', 'Grid', -50],
        ['Grid', 'Homes', 100],
      ]),
    );
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
    expect(run.validation[0]?.message).toBe('`energy` contains negative values');
    expect(run.validation[0]?.detail).toBe(
      'A flow cannot be negative. Drop the sign, or swap `source` and `target`.',
    );
    // Said once, and `Gas` never becomes a band at all.
    expect(run.encoded.droppedRows).toBe(1);
    expect(planOf(run).nodes.map((node) => node.label)).toEqual(['Coal', 'Grid', 'Homes']);
  });

  it('cuts a loop rather than drawing one, and says so once', () => {
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Grid', 'Homes', 100],
        ['Homes', 'Coal', 100],
      ]),
    );
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV3070']);
    expect(run.encodeDiagnostics[0]?.message).toBe(
      'One row sends a flow back into what it came from',
    );
    expect(run.encodeDiagnostics[0]?.detail).toBe(
      'A sankey runs one way, so a loop has no order to draw it in. Those rows are left out.',
    );
    expect(run.encoded.droppedRows).toBe(1);
    expect(planOf(run).links).toHaveLength(2);
  });

  it('counts a flow into its own source as the shortest loop there is', () => {
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Grid', 'Grid', 10],
        ['Grid', 'Homes', 100],
        ['Homes', 'Coal', 100],
      ]),
    );
    expect(codesOf(run.encodeDiagnostics)).toEqual(['MDV3070']);
    expect(run.encodeDiagnostics[0]?.message).toBe(
      '2 rows send a flow back into what it came from',
    );
    expect(run.encoded.droppedRows).toBe(2);
    // The self-loop conjured no band that nothing else names.
    expect(planOf(run).nodes.map((node) => node.label)).toEqual(['Coal', 'Grid', 'Homes']);
  });

  it('drops a row whose value is not a number, and one that names nothing', () => {
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        ['Gas', 'Grid', 'lots'],
        ['', 'Grid', 50],
        ['Grid', 'Homes', 100],
      ]),
    );
    expect(run.encoded.droppedRows).toBe(2);
    expect(planOf(run).nodes.map((node) => node.label)).toEqual(['Coal', 'Grid', 'Homes']);
  });

  it('does not turn a missing endpoint into a node called "—"', () => {
    // `formatValue` renders an empty cell as an em dash because a table view has
    // to put something in the gap. Keying off that would collect every row that
    // forgot to say where the energy came from into one band named after the
    // dash, sized by their total, and count it among what enters the diagram.
    const run = runSankey(
      makeTable(FIELDS, [
        ['Coal', 'Grid', 100],
        [null, 'Grid', 50],
        ['Grid', null, 30],
        ['Grid', 'Homes', 100],
      ]),
    );
    expect(planOf(run).nodes.map((node) => node.label)).toEqual(['Coal', 'Grid', 'Homes']);
    expect(run.encoded.droppedRows).toBe(2);
    expect(planOf(run).total).toBe(100);
  });

  it('survives a table with columns but no rows', () => {
    const run = runSankey(noRows(FIELDS));
    expect(run.laid.nodes).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.description).toBe('Sankey diagram with no data.');
  });

  it('survives the empty table', () => {
    const run = runSankey(EMPTY_TABLE);
    expect(run.validation).toEqual([]);
    expect(run.laid.nodes).toEqual([]);
    expect(run.description).toBe('Sankey diagram with no data.');
  });

  it('draws nothing at all when every column sums to nothing', () => {
    const run = runSankey(makeTable(FIELDS, [['Coal', 'Grid', 0]]));
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('never produces a number that is not a number', () => {
    expect(nonFiniteNumbers(runSankey().laid)).toEqual([]);
    expect(nonFiniteNumbers(runSankey(refinery()).laid)).toEqual([]);
    expect(nonFiniteNumbers(runSankey(crossing()).laid)).toEqual([]);
    expect(nonFiniteNumbers(runSankey(noRows(FIELDS)).laid)).toEqual([]);
    expect(nonFiniteNumbers(runSankey(makeTable(FIELDS, [['Coal', 'Grid', 0]])).laid)).toEqual([]);
    expect(
      nonFiniteNumbers(runSankey(grid(), { frame: { x: 0, y: 0, width: 0, height: 0 } }).laid),
    ).toEqual([]);
  });
});

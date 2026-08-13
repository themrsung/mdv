/**
 * `radar` (SPEC 8.12), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame: the web is
 * centred at (200, 100), and `fitCircle` reserves room for the axis labels
 * before it picks a radius — half a line of leading plus one line of text
 * vertically, and the widest label (capped at a fifth of the width) plus the
 * same leading horizontally. With the harness metric (width = length × size ×
 * 0.6) and a tick font of 13 × 0.85 = 11.05, height is what binds every fixture
 * here: 100 − 1.5 × 11.05 = 83.425. {@link OUTER} recomputes that from the
 * theme rather than hard-coding it, so a theme change moves the expectation
 * with the code.
 *
 * Angles run clockwise from 12 o'clock, so axis *i* of *n* sits at
 * `i / n` of a turn: the first spoke always points straight up, which is what
 * makes two radars of the same fields comparable by silhouette.
 *
 * The rules under test are the ones that keep a radar honest: the axis order is
 * the data's own and never a sorted one, the ninth axis is drawn rather than
 * hidden, a null breaks the outline instead of being interpolated across, an
 * incomplete outline is not filled, and the radius is the value because the
 * domain floor sits at the centre.
 */

import { describe, expect, it } from 'vitest';
import type { CircleNode, LineNode, PathNode, SceneNode, TextNode } from '@mdv/core';
import { radarChart } from '../src/radar.js';
import {
  EMPTY_TABLE,
  attrsOf,
  codesOf,
  makeBlock,
  makeTable,
  makeTheme,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const XY = { category: { field: 'skill' }, value: { field: 'score' } };

const CENTRE = { x: 200, y: 100 } as const;

/** The radius `fitCircle` lands on for {@link FRAME}, derived from the theme. */
const OUTER = (() => {
  const theme = makeTheme();
  const font = theme.type.fontSize * theme.type.tickScale;
  return 200 / 2 - font * 0.5 - font;
})();

/** The wash opacity the theme asks for (SPEC 11.4). */
const WASH = makeTheme().marks.area.fillOpacity;

/**
 * Decimal places to compare a *derived* radius to.
 *
 * Scene coordinates are rounded to four places before they leave `layout`, so a
 * radius recovered with `Math.hypot` carries a few units in the fifth. Three
 * places is far tighter than a pixel and still immune to that rounding; the
 * numbers the chart states outright — domains, ranges, circle radii — are still
 * asserted exactly.
 */
const PLACES = 3;

function opacityOf(node: PathNode | undefined): number | undefined {
  const fill = node?.fill;
  return fill === undefined || typeof fill === 'string' ? undefined : fill.opacity;
}

/** Four spokes, written in an order no sort would produce. */
function skills() {
  return makeTable(
    [
      ['skill', 'category'],
      ['score', 'number'],
    ],
    [
      ['Speed', 80],
      ['Power', 60],
      ['Range', 40],
      ['Guile', 20],
    ],
  );
}

/** Two outlines over the same three spokes, long form. */
function squads() {
  return makeTable(
    [
      ['skill', 'category'],
      ['score', 'number'],
      ['squad', 'category'],
    ],
    [
      ['Speed', 3, 'Red'],
      ['Power', 5, 'Red'],
      ['Range', 1, 'Red'],
      ['Speed', 2, 'Blue'],
      ['Power', 1, 'Blue'],
      ['Range', 4, 'Blue'],
    ],
  );
}

/** `n` spokes named A, B, C…, each carrying its own index plus one. */
function spokes(n: number) {
  const rows: (string | number)[][] = [];
  for (let i = 0; i < n; i += 1) rows.push([String.fromCharCode(65 + i), i + 1]);
  return makeTable(
    [
      ['skill', 'category'],
      ['score', 'number'],
    ],
    rows,
  );
}

function withClass(nodes: readonly SceneNode[], token: string): SceneNode[] {
  const out: SceneNode[] = [];
  for (const node of nodesOfKind(nodes, 'path'))
    if (node.cls?.includes(token) === true) out.push(node);
  for (const node of nodesOfKind(nodes, 'line'))
    if (node.cls?.includes(token) === true) out.push(node);
  for (const node of nodesOfKind(nodes, 'circle'))
    if (node.cls?.includes(token) === true) out.push(node);
  for (const node of nodesOfKind(nodes, 'text'))
    if (node.cls?.includes(token) === true) out.push(node);
  return out;
}

function rings(nodes: readonly SceneNode[]): SceneNode[] {
  return withClass(nodes, 'mdv-radar-ring').filter((n) => n.kind !== 'text');
}

function spokeLines(nodes: readonly SceneNode[]): LineNode[] {
  return withClass(nodes, 'mdv-radar-spoke') as LineNode[];
}

function axisLabels(nodes: readonly SceneNode[]): TextNode[] {
  return withClass(nodes, 'mdv-radar-axis-label') as TextNode[];
}

function ringLabels(nodes: readonly SceneNode[]): TextNode[] {
  return withClass(nodes, 'mdv-radar-ring-label') as TextNode[];
}

function outlines(nodes: readonly SceneNode[]): PathNode[] {
  return nodesOfKind(nodes, 'path').filter((p) => p.cls?.includes('mdv-mark-line') === true);
}

function washes(nodes: readonly SceneNode[]): PathNode[] {
  return nodesOfKind(nodes, 'path').filter((p) => p.cls?.includes('mdv-mark-area') === true);
}

function vertices(nodes: readonly SceneNode[]): CircleNode[] {
  return nodesOfKind(nodes, 'circle').filter((c) => c.cls?.includes('mdv-mark-point') === true);
}

/** Distance of a point from the web's centre. */
function radius(point: { x: number; y: number }): number {
  return Math.hypot(point.x - CENTRE.x, point.y - CENTRE.y);
}

/** Clockwise angle from 12 o'clock, in turns. */
function turn(point: { x: number; y: number }): number {
  const raw = Math.atan2(point.x - CENTRE.x, CENTRE.y - point.y) / (Math.PI * 2);
  return raw < 0 ? raw + 1 : raw;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('radar: the registered type', () => {
  it('declares the channels and defaults SPEC 8.12 gives it', () => {
    expect(radarChart.name).toBe('radar');
    expect(radarChart.level).toBe(2);
    expect(radarChart.family).toBe('mark');
    const required = radarChart.channels.filter((c) => c.required === true).map((c) => c.name);
    expect(required).toEqual(['category', 'value']);
    expect(radarChart.channels.map((c) => c.name)).toContain('series');
    expect(radarChart.defaults).toEqual({ gridShape: 'polygon', fill: true });
  });

  it('publishes no cartesian axes, because there is no polar axis model', () => {
    // Core owns the frame and the axes; a polar chart has neither to hand it,
    // exactly as `pie` reports. The rings and spokes are marks drawn here.
    const run = runChart(radarChart, skills(), { encoding: XY });
    expect(run.encoded.axes).toEqual([]);
  });
});

describe('radar: channel validation', () => {
  function validate(encoding: Record<string, unknown>, attrs: Record<string, unknown> = {}) {
    const block = makeBlock(skills(), {
      blockType: 'radar',
      encoding,
      attrs: attrsOf(attrs),
    });
    return radarChart
      .validate(block, skills())
      .map((d) => ({ code: d.code, severity: d.severity }));
  }

  it('requires `category`', () => {
    expect(validate({ value: { field: 'score' } })).toEqual([
      { code: 'MDV3000', severity: 'error' },
    ]);
  });

  it('requires `value`', () => {
    expect(validate({ category: { field: 'skill' } })).toEqual([
      { code: 'MDV3000', severity: 'error' },
    ]);
  });

  it('reports a `category` that names no column', () => {
    const found = validate({ category: { field: 'nope' }, value: { field: 'score' } });
    expect(found).toEqual([{ code: 'MDV3000', severity: 'error' }]);
  });

  it('refuses a non-quantitative `value`', () => {
    const found = validate({ category: { field: 'skill' }, value: { field: 'skill' } });
    expect(found).toEqual([{ code: 'MDV3001', severity: 'error' }]);
  });

  it('refuses wide form and `series` together', () => {
    // Both split the data into outlines, so together there is no answer to
    // "which field is this outline of" (SPEC 7.1).
    const table = squads();
    const block = makeBlock(table, {
      blockType: 'radar',
      encoding: {
        category: { field: 'skill' },
        value: [{ field: 'score' }],
        series: { field: 'squad' },
      },
    });
    expect(codesOf(radarChart.validate(block, table))).toEqual(['MDV3010']);
  });

  it('accepts the `x`/`y` and `label` spellings of the same encoding', () => {
    expect(validate({ x: { field: 'skill' }, y: { field: 'score' } })).toEqual([]);
    expect(validate({ label: { field: 'skill' }, value: { field: 'score' } })).toEqual([]);
  });

  it('passes a well-formed block silently', () => {
    expect(validate(XY)).toEqual([]);
  });

  it('encodes the aliases into the same chart as the canonical spelling', () => {
    const canonical = runChart(radarChart, skills(), { encoding: XY });
    const aliased = runChart(radarChart, skills(), {
      encoding: { x: { field: 'skill' }, y: { field: 'score' } },
    });
    expect(aliased.encoded.marks).toEqual(canonical.encoded.marks);
    expect(aliased.laid.nodes).toEqual(canonical.laid.nodes);
  });
});

describe('radar: axis order and geometry', () => {
  const run = runChart(radarChart, skills(), { encoding: XY });

  it('takes the axis order from the data, never from a sort', () => {
    // The fixture is deliberately neither alphabetical nor value-ordered, so a
    // stray `sort()` anywhere in the pipeline would show up here.
    expect(axisLabels(run.laid.nodes).map((t) => t.text)).toEqual([
      'Speed',
      'Power',
      'Range',
      'Guile',
    ]);
    expect(run.encoded.marks[0]?.points.map((p) => p.x)).toEqual([
      'Speed',
      'Power',
      'Range',
      'Guile',
    ]);
  });

  it('spaces the spokes evenly, clockwise from 12 o’clock', () => {
    const lines = spokeLines(run.laid.nodes);
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      expect(line.x1).toBeCloseTo(CENTRE.x, 10);
      expect(line.y1).toBeCloseTo(CENTRE.y, 10);
      expect(radius({ x: line.x2, y: line.y2 })).toBeCloseTo(OUTER, PLACES);
    }
    expect(lines.map((l) => turn({ x: l.x2, y: l.y2 }))).toEqual([
      expect.closeTo(0, PLACES),
      expect.closeTo(0.25, PLACES),
      expect.closeTo(0.5, PLACES),
      expect.closeTo(0.75, PLACES),
    ]);
  });

  it('makes the radius the value, with the domain floor at the centre', () => {
    // 80 is the top of the domain, so it sits on the outer ring; 20 is a
    // quarter of it, so it sits a quarter of the way out. Nothing is truncated,
    // because there is no baseline to truncate to.
    const points = vertices(run.laid.nodes);
    expect(points.map((c) => radius({ x: c.cx, y: c.cy }))).toEqual([
      expect.closeTo(OUTER, PLACES),
      expect.closeTo(OUTER * 0.75, PLACES),
      expect.closeTo(OUTER * 0.5, PLACES),
      expect.closeTo(OUTER * 0.25, PLACES),
    ]);
    expect(run.encoded.scales.value?.domain).toEqual([0, 80]);
    expect(run.encoded.scales.value?.range).toEqual([0, OUTER]);
  });

  it('paints fills under strokes under vertices', () => {
    const order = run.laid.nodes
      .map((n) => (n as { cls?: string }).cls ?? '')
      .filter((cls) => cls.startsWith('mdv-mark'));
    expect(order).toEqual([
      'mdv-mark mdv-mark-area',
      'mdv-mark mdv-mark-line',
      'mdv-mark mdv-mark-point',
      'mdv-mark mdv-mark-point',
      'mdv-mark mdv-mark-point',
      'mdv-mark mdv-mark-point',
    ]);
  });

  it('closes a complete outline', () => {
    const path = outlines(run.laid.nodes)[0];
    expect(path?.d.at(-1)).toEqual({ c: 'Z' });
    expect(path?.d.filter((c) => c.c !== 'Z')).toHaveLength(4);
  });

  it('gives every vertex a hit region carrying the reading', () => {
    expect(run.laid.hits).toHaveLength(4);
    expect(run.laid.hits[0]?.readout).toEqual([
      { label: 'Skill', value: 'Speed' },
      { label: 'Score', value: '80', swatch: expect.any(String), emphasis: true },
    ]);
    expect(run.laid.hits.map((h) => h.datumIndex)).toEqual([0, 1, 2, 3]);
  });

  it('produces no non-finite geometry', () => {
    expect(nonFiniteNumbers(run.laid.nodes)).toEqual([]);
    expect(nonFiniteNumbers(run.laid.hits)).toEqual([]);
  });
});

describe('radar: gridShape', () => {
  it('draws polygon rings as closed paths through the spokes', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ gridShape: 'polygon' }),
    });
    const ring = rings(run.laid.nodes).at(-1);
    expect(ring?.kind).toBe('path');
    const path = ring as PathNode;
    // One vertex per spoke, each on the outer ring, and closed.
    expect(path.d.filter((c) => c.c !== 'Z')).toHaveLength(4);
    expect(path.d.at(-1)).toEqual({ c: 'Z' });
    for (const command of path.d) {
      if (command.c === 'Z') continue;
      expect(radius(command)).toBeCloseTo(OUTER, PLACES);
    }
  });

  it('draws circular rings as circles instead', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ gridShape: 'circle' }),
    });
    const ring = rings(run.laid.nodes);
    expect(ring.every((n) => n.kind === 'circle')).toBe(true);
    const outermost = ring.at(-1) as CircleNode;
    expect(outermost.cx).toBeCloseTo(CENTRE.x, 10);
    expect(outermost.cy).toBeCloseTo(CENTRE.y, 10);
    expect(outermost.r).toBe(OUTER);
    // The grid shape changes the grid and nothing else: the readings sit in the
    // same places either way.
    const polygon = runChart(radarChart, skills(), { encoding: XY });
    expect(vertices(run.laid.nodes)).toEqual(vertices(polygon.laid.nodes));
  });

  it('polygon is the default, and an unknown shape falls back to it with MDV1502', () => {
    const fallback = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ gridShape: 'hexagon' }),
    });
    expect(codesOf(fallback)).toEqual(['MDV1502']);
    const bare = runChart(radarChart, skills(), { encoding: XY });
    expect(rings(fallback.laid.nodes)).toEqual(rings(bare.laid.nodes));
  });
});

describe('radar: the eight-axis rule', () => {
  it('says nothing at all at exactly eight', () => {
    const run = runChart(radarChart, spokes(8), { encoding: XY });
    expect(codesOf(run)).toEqual([]);
    expect(spokeLines(run.laid.nodes)).toHaveLength(8);
  });

  it('reports MDV3050 as advice at nine, and still draws all nine', () => {
    // Nothing is dropped. Hiding the ninth spoke would close the outline over a
    // hole and misstate the profile — strictly worse than an over-full chart
    // the reader can see is over-full. This follows `pie` past six slices and
    // `scatter` past three series: render everything, file an `info`.
    const run = runChart(radarChart, spokes(9), { encoding: XY });
    const diagnostic = run.diagnostics.find((d) => d.code === 'MDV3050');
    expect(diagnostic?.severity).toBe('info');
    expect(diagnostic?.message).toContain('9 axes');
    expect(diagnostic?.detail).toContain('nothing was dropped');

    expect(spokeLines(run.laid.nodes)).toHaveLength(9);
    expect(axisLabels(run.laid.nodes)).toHaveLength(9);
    expect(vertices(run.laid.nodes)).toHaveLength(9);
    expect(run.encoded.marks[0]?.points).toHaveLength(9);
    expect(run.encoded.a11yTable?.rows).toHaveLength(9);
    expect(run.description).toContain('9 axes');
  });

  it('reports once per block, not once per surplus axis', () => {
    const run = runChart(radarChart, spokes(12), { encoding: XY });
    expect(codesOf(run).filter((c) => c === 'MDV3050')).toHaveLength(1);
    expect(spokeLines(run.laid.nodes)).toHaveLength(12);
  });
});

describe('radar: maxValue', () => {
  const data = () =>
    makeTable(
      [
        ['skill', 'category'],
        ['score', 'number'],
      ],
      [
        ['A', 3],
        ['B', 5],
        ['C', 1],
      ],
    );

  it('pins the outer ring so two radars can be compared', () => {
    const run = runChart(radarChart, data(), {
      encoding: XY,
      attrs: attrsOf({ maxValue: 10 }),
    });
    expect(run.encoded.scales.value?.domain).toEqual([0, 10]);
    // The largest reading is 5, so it now sits halfway out rather than on the rim.
    const points = vertices(run.laid.nodes);
    expect(radius({ x: points[1]?.cx ?? 0, y: points[1]?.cy ?? 0 })).toBeCloseTo(
      OUTER * 0.5,
      PLACES,
    );
  });

  it('raises the rim but never lowers it under the data, and says when it did not', () => {
    // The radius *is* the reading, so a cap below the data has nowhere to put
    // the surplus: pinning 5 to a rim that means 2 would draw a series 2.5×
    // over the cap exactly like one sitting on it. The reading wins, the
    // attribute is reported, and the outline stays inside the web.
    const run = runChart(radarChart, data(), {
      encoding: XY,
      attrs: attrsOf({ maxValue: 2 }),
    });
    expect(run.encoded.scales.value?.domain).toEqual([0, 5]);
    const reported = run.diagnostics.find((d) => d.code === 'MDV1502');
    expect(reported?.severity).toBe('warning');
    expect(reported?.message).toContain('maxValue: 2');
    for (const point of vertices(run.laid.nodes)) {
      expect(radius({ x: point.cx, y: point.cy })).toBeLessThanOrEqual(OUTER + 1e-3);
    }
  });

  it('says nothing when the cap merely sits inside a nicened top', () => {
    // 5 is the largest reading and the domain is already [0, 5]; a cap of
    // exactly 5 crops nothing, so there is nothing to report.
    const run = runChart(radarChart, data(), {
      encoding: XY,
      attrs: attrsOf({ maxValue: 5 }),
    });
    expect(codesOf(run)).toEqual([]);
    expect(run.encoded.scales.value?.domain).toEqual([0, 5]);
  });

  it('labels the rings off the pinned domain', () => {
    const run = runChart(radarChart, data(), {
      encoding: XY,
      attrs: attrsOf({ maxValue: 10 }),
    });
    expect(ringLabels(run.laid.nodes).map((t) => t.text)).toEqual(['2', '4', '6', '8', '10', '0']);
  });
});

describe('radar: several outlines', () => {
  const run = runChart(radarChart, squads(), {
    encoding: { ...XY, series: { field: 'squad' } },
  });

  it('draws one outline per series, in first-appearance order', () => {
    expect(run.encoded.series.map((s) => s.id)).toEqual(['Red', 'Blue']);
    expect(run.encoded.marks.map((m) => m.seriesId)).toEqual(['Red', 'Blue']);
    expect(outlines(run.laid.nodes)).toHaveLength(2);
    expect(washes(run.laid.nodes)).toHaveLength(2);
  });

  it('shares one radial scale, so the outlines are on the same footing', () => {
    expect(run.encoded.scales.value?.domain).toEqual([0, 5]);
    const points = vertices(run.laid.nodes);
    expect(points).toHaveLength(6);
    expect(points.map((c) => radius({ x: c.cx, y: c.cy }))).toEqual([
      expect.closeTo(OUTER * 0.6, PLACES),
      expect.closeTo(OUTER, PLACES),
      expect.closeTo(OUTER * 0.2, PLACES),
      expect.closeTo(OUTER * 0.4, PLACES),
      expect.closeTo(OUTER * 0.2, PLACES),
      expect.closeTo(OUTER * 0.8, PLACES),
    ]);
  });

  it('offers a legend, because the title cannot name two outlines', () => {
    expect(run.encoded.legend?.entries.map((e) => e.label)).toEqual(['Red', 'Blue']);
    expect(run.encoded.legend?.entries[0]?.symbol).toBe('area');
  });

  it('gives each outline its own colour and no two the same slot', () => {
    const slots = run.encoded.series.map((s) => s.slot);
    expect(new Set(slots).size).toBe(slots.length);
  });

  it('reads wide form as series too', () => {
    const table = makeTable(
      [
        ['skill', 'category'],
        ['ios', 'number'],
        ['android', 'number'],
      ],
      [
        ['A', 3, 2],
        ['B', 5, 1],
        ['C', 1, 4],
      ],
    );
    const wide = runChart(radarChart, table, {
      encoding: {
        category: { field: 'skill' },
        value: [{ field: 'ios' }, { field: 'android' }],
      },
    });
    expect(wide.encoded.series.map((s) => s.id)).toEqual(['ios', 'android']);
    expect(outlines(wide.laid.nodes)).toHaveLength(2);
    expect(codesOf(wide)).toEqual([]);
  });
});

describe('radar: fill', () => {
  it('washes a complete outline by default, at the theme opacity', () => {
    const run = runChart(radarChart, skills(), { encoding: XY });
    const wash = washes(run.laid.nodes)[0];
    expect(wash).toBeDefined();
    expect(opacityOf(wash)).toBe(WASH);
    expect(run.encoded.marks[0]?.fill).toBe(true);
  });

  it('drops the wash entirely for `fill: false`', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ fill: false }),
    });
    expect(washes(run.laid.nodes)).toHaveLength(0);
    expect(outlines(run.laid.nodes)).toHaveLength(1);
    expect(run.encoded.legend).toBeUndefined();
  });

  it('takes a number as an explicit opacity', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ fill: 0.4 }),
    });
    expect(opacityOf(washes(run.laid.nodes)[0])).toBe(0.4);
  });

  it('rejects an unparseable `fill` with MDV1502 and keeps the default', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      attrs: attrsOf({ fill: 'sort of' }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(opacityOf(washes(run.laid.nodes)[0])).toBe(WASH);
  });
});

describe('radar: degenerate input', () => {
  it('draws nothing at all for an empty table', () => {
    const run = runChart(radarChart, EMPTY_TABLE, { encoding: XY });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.description).toBe('Radar chart with no data.');
  });

  it('draws nothing for a typed table with no rows', () => {
    const run = runChart(
      radarChart,
      noRows([
        ['skill', 'category'],
        ['score', 'number'],
      ]),
      { encoding: XY },
    );
    expect(run.laid.nodes).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.description).toBe('Radar chart with no data.');
  });

  it('survives a single axis without dividing by zero', () => {
    const run = runChart(
      radarChart,
      makeTable(
        [
          ['skill', 'category'],
          ['score', 'number'],
        ],
        [['Only', 4]],
      ),
      { encoding: XY },
    );
    expect(spokeLines(run.laid.nodes)).toHaveLength(1);
    expect(vertices(run.laid.nodes)).toHaveLength(1);
    expect(nonFiniteNumbers(run.laid.nodes)).toEqual([]);
    expect(run.description).toContain('1 axis');
  });

  it('opens a domain for an all-zero column instead of collapsing to a point', () => {
    const run = runChart(
      radarChart,
      makeTable(
        [
          ['skill', 'category'],
          ['score', 'number'],
        ],
        [
          ['A', 0],
          ['B', 0],
          ['C', 0],
        ],
      ),
      { encoding: XY },
    );
    // A zero-width domain would put every ring on top of every other and make
    // the scale non-invertible, so the floor keeps its own top.
    expect(run.encoded.scales.value?.domain).toEqual([0, 1]);
    for (const point of vertices(run.laid.nodes)) {
      expect(radius({ x: point.cx, y: point.cy })).toBeCloseTo(0, 9);
    }
    expect(nonFiniteNumbers(run.laid.nodes)).toEqual([]);
  });

  it('breaks the outline at a null rather than interpolating across it', () => {
    const run = runChart(
      radarChart,
      makeTable(
        [
          ['skill', 'category'],
          ['score', 'number'],
        ],
        [
          ['A', 3],
          ['B', null],
          ['C', 1],
          ['D', 2],
        ],
      ),
      { encoding: XY },
    );
    // The spoke stays — a missing reading is not a missing axis — but the
    // outline is cut into the runs either side of it, and an outline with a
    // break is not filled, because a wash would assert a boundary that is not
    // there.
    expect(spokeLines(run.laid.nodes)).toHaveLength(4);
    expect(axisLabels(run.laid.nodes).map((t) => t.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(washes(run.laid.nodes)).toHaveLength(0);
    expect(vertices(run.laid.nodes)).toHaveLength(3);
    const runs = outlines(run.laid.nodes);
    expect(runs).toHaveLength(2);
    expect(runs.every((p) => p.d.every((c) => c.c !== 'Z'))).toBe(true);
    expect(run.encoded.marks[0]?.fill).toBe(false);
  });

  it('leaves a hole for a series that is missing one axis', () => {
    const table = makeTable(
      [
        ['skill', 'category'],
        ['score', 'number'],
        ['squad', 'category'],
      ],
      [
        ['Speed', 3, 'Red'],
        ['Power', 5, 'Red'],
        ['Range', 1, 'Red'],
        ['Speed', 2, 'Blue'],
        ['Power', 1, 'Blue'],
      ],
    );
    const run = runChart(radarChart, table, {
      encoding: { ...XY, series: { field: 'squad' } },
    });
    // Blue never mentions Range. That is a gap, not a zero: filling it in would
    // invent a reading, and closing over it would claim a shape Blue never had.
    expect(run.encoded.marks[1]?.points.map((p) => p.y)).toEqual([2, 1, null]);
    expect(washes(run.laid.nodes)).toHaveLength(1);
  });

  it('does not fall over on a frame too small for a web', () => {
    const run = runChart(radarChart, skills(), {
      encoding: XY,
      frame: { x: 0, y: 0, width: 8, height: 8 },
    });
    expect(run.laid.nodes).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('takes the last row when one series names an axis twice', () => {
    const table = makeTable(
      [
        ['skill', 'category'],
        ['score', 'number'],
      ],
      [
        ['A', 1],
        ['B', 2],
        ['A', 9],
      ],
    );
    const run = runChart(radarChart, table, { encoding: XY });
    expect(axisLabels(run.laid.nodes).map((t) => t.text)).toEqual(['A', 'B']);
    expect(run.encoded.marks[0]?.points.map((p) => p.y)).toEqual([9, 2]);
  });
});

describe('radar: accessibility', () => {
  it('describes the subject, the count and the extremes', () => {
    const run = runChart(radarChart, skills(), { encoding: XY });
    expect(run.description).toBe(
      'Radar chart. Score by skill, 4 axes. Values range from 20 in Guile to 80 in Speed. Highest: Speed.',
    );
  });

  it('names the outline as well as the spoke when there are several', () => {
    const run = runChart(radarChart, squads(), {
      encoding: { ...XY, series: { field: 'squad' } },
    });
    // Without the outline's name, "Highest" would name a place and not a thing.
    expect(run.description).toBe(
      'Radar chart. Score by skill, 2 series across 3 axes. Values range from 1 in Range (Red) to 5 in Power (Red). Highest: Power (Red).',
    );
  });

  it('gets the singular right for one axis', () => {
    const run = runChart(radarChart, spokes(1), { encoding: XY });
    expect(run.description).toContain('1 axis');
    expect(run.description).not.toContain('1 axes');
  });

  it('publishes the table view as a spoke-by-outline matrix', () => {
    const run = runChart(radarChart, squads(), {
      encoding: { ...XY, series: { field: 'squad' } },
    });
    expect(run.encoded.a11yTable).toEqual({
      caption: 'Chart data',
      columns: [
        { name: 'Skill', type: 'category', align: 'left' },
        { name: 'Red', type: 'number', align: 'right' },
        { name: 'Blue', type: 'number', align: 'right' },
      ],
      rows: [
        ['Speed', '3', '2'],
        ['Power', '5', '1'],
        ['Range', '1', '4'],
      ],
      presentation: 'details',
    });
  });

  it('leaves a missing reading blank in the table rather than writing a zero', () => {
    const table = makeTable(
      [
        ['skill', 'category'],
        ['score', 'number'],
        ['squad', 'category'],
      ],
      [
        ['Speed', 3, 'Red'],
        ['Power', 5, 'Red'],
        ['Speed', 2, 'Blue'],
      ],
    );
    const run = runChart(radarChart, table, {
      encoding: { ...XY, series: { field: 'squad' } },
    });
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Speed', '3', '2'],
      ['Power', '5', ''],
    ]);
  });

  it('names the single measure as the value column for one outline', () => {
    const run = runChart(radarChart, skills(), { encoding: XY });
    expect(run.encoded.a11yTable?.columns.map((c) => c.name)).toEqual(['Skill', 'Score']);
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Speed', '80'],
      ['Power', '60'],
      ['Range', '40'],
      ['Guile', '20'],
    ]);
  });

  it('reports the columns it bound, category first', () => {
    const run = runChart(radarChart, squads(), {
      encoding: { ...XY, series: { field: 'squad' } },
    });
    expect(run.encoded.boundColumns?.map((c) => c.name)).toEqual(['skill', 'score', 'squad']);
  });
});

describe('radar: determinism (SPEC 24.3)', () => {
  it('produces identical output for identical input', () => {
    const once = runChart(radarChart, squads(), {
      encoding: { ...XY, series: { field: 'squad' } },
      attrs: attrsOf({ gridShape: 'circle', maxValue: 6, labels: true }),
    });
    const twice = runChart(radarChart, squads(), {
      encoding: { ...XY, series: { field: 'squad' } },
      attrs: attrsOf({ gridShape: 'circle', maxValue: 6, labels: true }),
    });
    expect(JSON.stringify(twice.laid)).toBe(JSON.stringify(once.laid));
    expect(JSON.stringify(twice.encoded.marks)).toBe(JSON.stringify(once.encoded.marks));
    expect(twice.description).toBe(once.description);
    expect(codesOf(twice)).toEqual(codesOf(once));
  });

  it('numbers its ids from the block index, so two blocks never collide', () => {
    const first = runChart(radarChart, skills(), { encoding: XY, index: 0 });
    const second = runChart(radarChart, skills(), { encoding: XY, index: 3 });
    expect(first.laid.nodes[0]?.id).toMatch(/^mdv-0-/);
    expect(second.laid.nodes[0]?.id).toMatch(/^mdv-3-/);
    const ids = second.laid.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not reorder axes when the rows arrive in a different order', () => {
    // Same readings, different row order: the axis order must follow the
    // document, so the two charts are legitimately different pictures rather
    // than the same one drawn twice.
    const forward = runChart(radarChart, spokes(4), { encoding: XY });
    const reversed = runChart(
      radarChart,
      makeTable(
        [
          ['skill', 'category'],
          ['score', 'number'],
        ],
        [
          ['D', 4],
          ['C', 3],
          ['B', 2],
          ['A', 1],
        ],
      ),
      { encoding: XY },
    );
    expect(axisLabels(forward.laid.nodes).map((t) => t.text)).toEqual(['A', 'B', 'C', 'D']);
    expect(axisLabels(reversed.laid.nodes).map((t) => t.text)).toEqual(['D', 'C', 'B', 'A']);
  });
});

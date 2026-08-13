/**
 * `gauge` (SPEC 8.12), asserted numerically.
 *
 * Geometry to check the numbers against, for the 400 × 200 frame. `fitDial`
 * reserves room for the two end labels before it picks a radius — half a line of
 * leading plus one line of text vertically, and the wider of `min`/`max` (capped
 * at a quarter of the width) plus the same leading horizontally — then fits the
 * unit *sector* into what is left. With the harness metric (width = length ×
 * size × 0.6) and a tick font of 13 × 0.85 = 11.05, height binds every fixture
 * here. {@link expectedDial} recomputes that from the theme rather than
 * hard-coding it, so a theme change moves the expectation with the code.
 *
 * Angles run clockwise from 12 o'clock and the sweep is centred there, so a
 * default 180° dial runs from 9 o'clock to 3 o'clock through the top: the
 * reading grows left to right, which is the direction a reader already expects a
 * magnitude to grow.
 *
 * The rules under test are the ones that keep a gauge honest: many rows still
 * make one number and it says so, a reading outside `min`/`max` moves the bound
 * rather than being pinned to the rim, the track is a step of the fill's own
 * ramp that clears 2:1 on both surfaces, and a threshold band never rests on hue
 * alone.
 */

import { describe, expect, it } from 'vitest';
import type { LineNode, PathNode, SceneNode, TextNode, Theme } from '@mdv/core';
import { gaugeChart } from '../src/gauge.js';
import { relativeLuminance } from '../src/internal/paint.js';
import {
  EMPTY_TABLE,
  FRAME,
  attrsOf,
  codesOf,
  makeLayoutContext,
  makeTable,
  makeTheme,
  nodesOfKind,
  nonFiniteNumbers,
  noRows,
  runChart,
} from './harness.js';

const VALUE = { value: { field: 'load' } };

/** One reading, the ordinary case. */
function reading(value = 25) {
  return makeTable([['load', 'number']], [[value]]);
}

/** Several readings, so the one-number reduction has something to reduce. */
function series(...values: readonly number[]) {
  return makeTable(
    [['load', 'number']],
    values.map((v) => [v]),
  );
}

/**
 * The dial `fitDial` lands on for {@link FRAME} at the default 180° sweep,
 * derived from the theme so the expectation is not a magic number.
 *
 * The unit sector of a half turn is 2 wide and 1 tall, so width never binds at
 * this frame and the radius is the usable height outright.
 */
function expectedDial(minText: string, maxText: string) {
  const theme = makeTheme();
  const font = theme.type.fontSize * theme.type.tickScale;
  const gap = font * 0.5;
  const widest = Math.max(minText.length, maxText.length) * font * 0.6;
  const padX = gap + Math.min(widest, FRAME.width * 0.25);
  const padY = gap + font;
  const usableW = FRAME.width - padX * 2;
  const usableH = FRAME.height - padY * 2;
  const outer = Math.min(usableW / 2, usableH / 1);
  const inner = outer - Math.min(theme.marks.bar.maxThickness, outer * 0.22);
  return {
    outer,
    inner,
    cx: padX + (usableW - outer * 2) / 2 + outer,
    cy: padY + (usableH - outer) / 2 + outer,
  };
}

/** WCAG contrast, the statistic SPEC 16.4's validator computes. */
function contrast(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * The default blue ramp and the two surfaces, quoted from SPEC 11.3.
 *
 * The harness theme is deliberately a *different*, hand-made palette on a white
 * surface, which is the right default for every other assertion here but cannot
 * answer "does the track work on a dark surface" — its surface is white in both
 * schemes. These two fixtures are the spec's own worked example, so the track
 * assertions are checked against the colours SPEC 11.3 actually names.
 */
const SEQUENTIAL_BLUE = [
  '#cde2fb',
  '#b7d3f6',
  '#9ec5f4',
  '#86b6ef',
  '#6da7ec',
  '#5598e7',
  '#3987e5',
  '#2a78d6',
  '#256abf',
  '#1c5cab',
  '#184f95',
  '#104281',
  '#0d366b',
];

function blueTheme(scheme: 'light' | 'dark'): Theme {
  const base = makeTheme(scheme);
  return {
    ...base,
    tokens: { ...base.tokens, surface: scheme === 'dark' ? '#1a1a19' : '#fcfcfb' },
    sequential: {
      hue: '#3987e5',
      steps: SEQUENTIAL_BLUE,
      // The indices `@mdv/themes` derives for these two surfaces: step 250 on
      // light, step 600 on dark, exactly as SPEC 11.3 states.
      ordinalFloor: scheme === 'dark' ? 0 : 3,
      ordinalCeiling: scheme === 'dark' ? 10 : 12,
    },
  };
}

/**
 * Re-run `layout` under a different theme.
 *
 * `encode` never reads a colour (registry.ts), so the encoded result is
 * theme-independent and only the geometry pass has to be repeated.
 */
function layoutWith(theme: Theme, value = 25) {
  const run = runChart(gaugeChart, reading(value), {
    encoding: VALUE,
    attrs: attrsOf({ min: 0, max: 100 }),
  });
  const harness = makeLayoutContext();
  return gaugeChart.layout(run.encoded, FRAME, {
    ...harness.ctx,
    theme,
    colorScheme: theme.scheme,
  });
}

function fillOf(node: SceneNode | undefined): string | undefined {
  if (node === undefined || !('fill' in node)) return undefined;
  const paint = node.fill;
  return paint !== undefined && paint.kind === 'solid' ? paint.color : undefined;
}

/** The track is drawn first, the reading's own arc second (paint order). */
function arcs(nodes: readonly SceneNode[]): PathNode[] {
  return nodesOfKind(nodes, 'path').filter((n) => (n.cls ?? '').includes('mdv-gauge-'));
}

function trackNode(nodes: readonly SceneNode[]): PathNode | undefined {
  return nodesOfKind(nodes, 'path').find((n) => (n.cls ?? '').includes('mdv-gauge-track'));
}

function fillNode(nodes: readonly SceneNode[]): PathNode | undefined {
  return nodesOfKind(nodes, 'path').find((n) => (n.cls ?? '').includes('mdv-gauge-fill'));
}

function valueText(nodes: readonly SceneNode[]): TextNode | undefined {
  return nodesOfKind(nodes, 'text').find((n) => (n.cls ?? '').includes('mdv-gauge-value'));
}

function endLabels(nodes: readonly SceneNode[]): TextNode[] {
  return nodesOfKind(nodes, 'text').filter((n) => (n.cls ?? '').includes('mdv-gauge-end-label'));
}

function thresholdLines(nodes: readonly SceneNode[]): LineNode[] {
  return nodesOfKind(nodes, 'line').filter((n) => (n.cls ?? '').includes('mdv-gauge-threshold'));
}

/** The band marker, whichever node kind it took: a circle is a circle node. */
function bandIcon(nodes: readonly SceneNode[]): SceneNode | undefined {
  return [...nodesOfKind(nodes, 'path'), ...nodesOfKind(nodes, 'circle')].find((n) =>
    (n.cls ?? '').includes('mdv-gauge-band-icon'),
  );
}

/**
 * A marker's shape, independent of where it sits.
 *
 * Every icon is drawn beside its own band label, so the absolute coordinates
 * move with the label's width and two placements of one shape would compare
 * unequal. Translating each path to its own first point leaves only the
 * silhouette — which is the thing SPEC 12.6 asks to be distinct.
 */
function silhouette(node: SceneNode | undefined): string {
  if (node === undefined) return 'none';
  if (node.kind === 'circle') return 'circle';
  const commands = node.kind === 'path' ? node.d : [];
  const first = commands[0];
  const ox = first !== undefined && 'x' in first ? first.x : 0;
  const oy = first !== undefined && 'y' in first ? first.y : 0;
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return JSON.stringify(
    commands.map((command) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(command)) {
        if (typeof value !== 'number') out[key] = value;
        else if (key === 'x' || key === 'x1' || key === 'x2') out[key] = round(value - ox);
        else if (key === 'y' || key === 'y1' || key === 'y2') out[key] = round(value - oy);
        else out[key] = round(value);
      }
      return out;
    }),
  );
}

/** The plan `layout` was handed, for the numbers `encode` settled on. */
function planOf(run: { encoded: { state?: unknown } }) {
  return run.encoded.state as {
    value: number | null;
    min: number;
    max: number;
    fraction: number | null;
    sweep: number;
    bands: readonly { from: number; to: number; status: string; label: string }[];
    band: { status: string; label: string } | undefined;
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('gauge: channels (SPEC 8.12)', () => {
  it('registers at Level 2 as a mark-targeted type', () => {
    expect(gaugeChart.name).toBe('gauge');
    expect(gaugeChart.level).toBe(2);
    expect(gaugeChart.family).toBe('mark');
  });

  it('requires `value`, and says so rather than drawing an empty dial', () => {
    const run = runChart(gaugeChart, EMPTY_TABLE);
    expect(codesOf(run.validation)).toEqual(['MDV3000']);
  });

  it('accepts a bare number, the way a stat tile does (SPEC 8.13)', () => {
    // `value: 72` is the most natural way to write a gauge and binds no channel,
    // which is why the requirement is enforced here rather than by core's
    // required-channel check.
    const run = runChart(gaugeChart, EMPTY_TABLE, { attrs: attrsOf({ value: 72, max: 100 }) });
    expect(codesOf(run)).toEqual([]);
    expect(planOf(run).value).toBe(72);
  });

  it('reports a `value` that names no column', () => {
    const run = runChart(gaugeChart, reading(), { encoding: { value: { field: 'nope' } } });
    expect(codesOf(run.validation)).toEqual(['MDV3000']);
  });

  it('rejects a `value` bound to a field it cannot measure', () => {
    const run = runChart(gaugeChart, makeTable([['load', 'string']], [['high']]), {
      encoding: VALUE,
    });
    expect(codesOf(run.validation)).toEqual(['MDV3001']);
  });

  it('accepts `y` as a spelling of `value`', () => {
    const run = runChart(gaugeChart, reading(40), {
      encoding: { y: { field: 'load' } },
      attrs: attrsOf({ max: 100 }),
    });
    expect(codesOf(run)).toEqual([]);
    expect(planOf(run).value).toBe(40);
  });

  it('has no series and no legend: one reading needs no identity (SPEC 7.4)', () => {
    const run = runChart(gaugeChart, reading(), { encoding: VALUE });
    expect(run.encoded.series).toEqual([]);
    expect(run.encoded.legend).toBeUndefined();
  });

  it('has no cartesian axis to hand core (SPEC 7.3.1)', () => {
    const run = runChart(gaugeChart, reading(), { encoding: VALUE });
    expect(run.encoded.axes).toEqual([]);
    expect(run.encoded.scales.value?.domain).toBeDefined();
  });
});

describe('gauge: one number from many rows (SPEC 8.13)', () => {
  it('takes the last row, as a tile does, and says that it did', () => {
    const run = runChart(gaugeChart, series(10, 20, 90), {
      encoding: VALUE,
      attrs: attrsOf({ max: 100 }),
    });
    expect(planOf(run).value).toBe(90);
    expect(codesOf(run)).toEqual(['MDV3050']);
    expect(run.encodeDiagnostics[0]?.message).toContain('3 rows reduced to one reading');
  });

  it('emits exactly one mark, whatever the row count', () => {
    const run = runChart(gaugeChart, series(1, 2, 3, 4, 5), {
      encoding: VALUE,
      attrs: attrsOf({ max: 10 }),
    });
    expect(run.encoded.marks).toHaveLength(1);
    expect(run.encoded.marks[0]?.mark).toBe('arc');
    expect(run.encoded.marks[0]?.value).toBe(5);
    // The mark points at the row the reading came from, not at row 0.
    expect(run.encoded.marks[0]?.datum).toBe(4);
  });

  it('honours a declared `aggregate` instead, and then stays quiet', () => {
    const run = runChart(gaugeChart, series(10, 20, 30), {
      encoding: { value: { field: 'load', aggregate: 'mean' } },
      attrs: attrsOf({ max: 100 }),
    });
    expect(planOf(run).value).toBe(20);
    expect(codesOf(run)).toEqual([]);
  });

  it('reduces with every aggregate the channel offers', () => {
    const of = (aggregate: 'sum' | 'min' | 'max' | 'median' | 'count' | 'first') =>
      planOf(
        runChart(gaugeChart, series(10, 30, 20), {
          encoding: { value: { field: 'load', aggregate } },
          attrs: attrsOf({ max: 100 }),
        }),
      ).value;
    expect(of('sum')).toBe(60);
    expect(of('min')).toBe(10);
    expect(of('max')).toBe(30);
    expect(of('median')).toBe(20);
    expect(of('count')).toBe(3);
    expect(of('first')).toBe(10);
  });

  it('says nothing at all about a single row', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ max: 100 }),
    });
    expect(codesOf(run)).toEqual([]);
  });

  it('keeps every reading in the table view, which is why the notice is info', () => {
    const run = runChart(gaugeChart, series(10, 20, 90), {
      encoding: VALUE,
      attrs: attrsOf({ max: 100 }),
    });
    expect(run.encoded.a11yTable?.rows).toEqual([
      ['Load', '90'],
      ['Minimum', '0'],
      ['Maximum', '100'],
      ['Reading 1', '10'],
      ['Reading 2', '20'],
      ['Reading 3', '90'],
    ]);
  });
});

describe('gauge: the range (SPEC 8.12 `min`, `max`)', () => {
  it('starts at zero, because arc length is the magnitude', () => {
    const run = runChart(gaugeChart, reading(80), { encoding: VALUE });
    expect(planOf(run).min).toBe(0);
  });

  it('takes `min` and `max` as the scale, and the fraction from them', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const plan = planOf(run);
    expect([plan.min, plan.max]).toEqual([0, 100]);
    expect(plan.fraction).toBe(0.25);
    expect(run.encoded.marks[0]?.fraction).toBe(0.25);
    expect(run.encoded.scales.value?.domain).toEqual([0, 100]);
  });

  it('places a non-zero floor exactly: 30 of 20…40 is half the arc', () => {
    const run = runChart(gaugeChart, reading(30), {
      encoding: VALUE,
      attrs: attrsOf({ min: 20, max: 40 }),
    });
    expect(planOf(run).fraction).toBe(0.5);
  });

  it('lets the reading beat `max` rather than pinning it to the rim', () => {
    // The rule `radar` applies to `maxValue`: a reading pinned to the end of the
    // arc says "exactly at the maximum", which is a different and false number.
    const run = runChart(gaugeChart, reading(130), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const plan = planOf(run);
    expect(plan.max).toBe(130);
    expect(plan.fraction).toBe(1);
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(run.encodeDiagnostics[0]?.message).toContain('is below the reading');
  });

  it('lets the reading beat `min` the same way', () => {
    const run = runChart(gaugeChart, reading(-5), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const plan = planOf(run);
    expect(plan.min).toBe(-5);
    expect(plan.fraction).toBe(0);
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(run.encodeDiagnostics[0]?.message).toContain('is above the reading');
  });

  it('refuses an inverted range and falls back to one with width', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 100, max: 10 }),
    });
    const plan = planOf(run);
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(plan.max).toBeGreaterThan(plan.min);
    expect(Number.isFinite(plan.fraction ?? Number.NaN)).toBe(true);
  });

  it('refuses a zero-width range too', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 50, max: 50 }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(planOf(run).max).toBeGreaterThan(planOf(run).min);
  });

  it('never produces a fraction outside 0…1', () => {
    for (const value of [-1000, 0, 50, 1000]) {
      const plan = planOf(
        runChart(gaugeChart, reading(value), {
          encoding: VALUE,
          attrs: attrsOf({ min: 0, max: 100 }),
        }),
      );
      expect(plan.fraction).toBeGreaterThanOrEqual(0);
      expect(plan.fraction).toBeLessThanOrEqual(1);
    }
  });
});

describe('gauge: the arc (SPEC 8.12 `arc`)', () => {
  it('defaults to the half dial, fitted to the frame exactly', () => {
    const run = runChart(gaugeChart, reading(0), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const expected = expectedDial('0', '100');
    expect(planOf(run).sweep).toBeCloseTo(Math.PI, 12);

    // `arcPath` opens with a moveTo at the outer radius on the start angle,
    // which for a half dial is 9 o'clock: (cx − outer, cy).
    const track = trackNode(run.laid.nodes);
    const start = track?.d[0];
    expect(start?.c).toBe('M');
    expect(start).toMatchObject({
      x: Math.round((expected.cx - expected.outer) * 10000) / 10000,
      y: Math.round(expected.cy * 10000) / 10000,
    });
    // Symmetric sweep ⇒ the dial is centred horizontally in the frame.
    expect(expected.cx).toBe(FRAME.width / 2);
  });

  it('widens the sweep when asked, and the fill scales with it', () => {
    const half = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const wide = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, arc: 270 }),
    });
    expect(planOf(wide).sweep).toBeCloseTo((270 * Math.PI) / 180, 12);
    expect(planOf(wide).sweep).toBeGreaterThan(planOf(half).sweep);
    expect(fillNode(wide.laid.nodes)).toBeDefined();
  });

  it('clamps a sweep it cannot draw and reports the substitution', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, arc: 720 }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(planOf(run).sweep).toBeCloseTo(Math.PI * 2, 12);
  });

  it('falls back to the default sweep for a value that is not a number', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, arc: 'wide' }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(planOf(run).sweep).toBeCloseTo(Math.PI, 12);
  });

  it('draws no fill at all at the floor, rather than a zero-width sliver', () => {
    const run = runChart(gaugeChart, reading(0), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    expect(fillNode(run.laid.nodes)).toBeUndefined();
    expect(trackNode(run.laid.nodes)).toBeDefined();
    // A zero reading is still a reading, so it still has a readout to focus.
    expect(run.laid.hits).toHaveLength(1);
  });

  it('labels both ends of the range, in tabular figures (SPEC 11.5)', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const labels = endLabels(run.laid.nodes);
    expect(labels.map((n) => n.text)).toEqual(['0', '100']);
    for (const label of labels) {
      expect(label.tabular).toBe(true);
      expect(label.fill).toEqual({ kind: 'solid', color: makeTheme().tokens['text-muted'] });
    }
  });
});

describe('gauge: the reading in the middle (SPEC 8.12 `showValue`)', () => {
  it('draws the figure at the centre of the frame, in proportional figures', () => {
    const run = runChart(gaugeChart, reading(72), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const text = valueText(run.laid.nodes);
    expect(text?.text).toBe('72');
    expect(text?.x).toBe(FRAME.width / 2);
    expect(text?.y).toBe(FRAME.height / 2);
    expect(text?.anchor).toBe('middle');
    expect(text?.baseline).toBe('middle');
    // SPEC 11.5: large standalone figures are proportional, not tabular.
    expect(text?.tabular).toBeUndefined();
  });

  it('honours the block `format` when it writes the figure', () => {
    const run = runChart(gaugeChart, reading(0.42), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 1, format: '.0%' }),
    });
    expect(valueText(run.laid.nodes)?.text).toBe('42%');
  });

  it('draws nothing in the middle when `showValue: false`', () => {
    const run = runChart(gaugeChart, reading(72), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, showValue: false }),
    });
    expect(valueText(run.laid.nodes)).toBeUndefined();
    // The dial itself is untouched.
    expect(trackNode(run.laid.nodes)).toBeDefined();
    expect(fillNode(run.laid.nodes)).toBeDefined();
  });
});

describe('gauge: the track (SPEC 8.12, 11.3, 16.4)', () => {
  const theme = makeTheme();

  it('is a step of the fill’s own ramp, never a grey', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const track = fillOf(trackNode(run.laid.nodes));
    expect(theme.sequential.steps).toContain(track);
  });

  it('lands on the step SPEC 11.3 names, on the real light and dark surfaces', () => {
    // The ramp and the two surfaces are quoted from SPEC 11.3 outright, so this
    // pins the module to the spec's own worked example: "on light, start no
    // lighter than step 250 (`#86b6ef`); on dark, go no darker than step 600
    // (`#184f95`)".
    expect(fillOf(trackNode(layoutWith(blueTheme('light')).nodes))).toBe('#86b6ef');
    expect(fillOf(trackNode(layoutWith(blueTheme('dark')).nodes))).toBe('#184f95');
  });

  it('clears the 2:1 floor SPEC 16.4’s validator enforces, on both surfaces', () => {
    // Computed against the colour the chart actually chose, never eyeballed —
    // and against the surface that scheme really uses.
    for (const scheme of ['light', 'dark'] as const) {
      const t = blueTheme(scheme);
      const track = fillOf(trackNode(layoutWith(t).nodes)) ?? '';
      expect(contrast(track, t.tokens.surface), `${scheme} track ${track}`).toBeGreaterThanOrEqual(
        2,
      );
    }
  });

  it('recomputes the floor rather than trusting a theme that declared one', () => {
    // SPEC 11.6 lets an author hand-write a palette, and the harness theme is
    // exactly such a theme: it declares `ordinalFloor: 1`, whose step is only
    // 1.37:1 on its surface. The chart must not take that on trust.
    const declared = theme.sequential.steps[theme.sequential.ordinalFloor] ?? '';
    expect(contrast(declared, theme.tokens.surface)).toBeLessThan(2);

    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const track = fillOf(trackNode(run.laid.nodes)) ?? '';
    expect(track).not.toBe(declared);
    expect(theme.sequential.steps).toContain(track);
    expect(contrast(track, theme.tokens.surface)).toBeGreaterThanOrEqual(2);
    // The *first* step that clears it, not merely some step that does: the track
    // stays as recessive as the contrast floor allows.
    const index = theme.sequential.steps.indexOf(track);
    const previous = theme.sequential.steps[index - 1] ?? '';
    expect(contrast(previous, theme.tokens.surface)).toBeLessThan(2);
  });

  it('is not the fill, so the arc still reads as filled and unfilled', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const track = fillOf(trackNode(run.laid.nodes));
    const fill = fillOf(fillNode(run.laid.nodes));
    expect(fill).not.toBe(track);
    expect(fill).toBe(theme.sequential.hue);
  });

  it('paints the track under the reading, so the fill reads on top', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const painted = arcs(run.laid.nodes).map((n) => n.cls ?? '');
    expect(painted[0]).toContain('mdv-gauge-track');
    expect(painted[1]).toContain('mdv-gauge-fill');
  });

  it('does not tint the fill by the reading: magnitude is already the length', () => {
    const low = runChart(gaugeChart, reading(5), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    const high = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    expect(fillOf(fillNode(high.laid.nodes))).toBe(fillOf(fillNode(low.laid.nodes)));
  });
});

describe('gauge: thresholds (SPEC 11.3.1)', () => {
  const theme = makeTheme();

  it('uses the reserved status palette, not a categorical slot or a ramp step', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    expect(fillOf(fillNode(run.laid.nodes))).toBe(theme.status.serious);
    expect(theme.sequential.steps).not.toContain(fillOf(fillNode(run.laid.nodes)));
  });

  it('reads bare numbers as an ascending alert ladder', () => {
    const bands = planOf(
      runChart(gaugeChart, reading(50), {
        encoding: VALUE,
        attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
      }),
    ).bands;
    expect(bands.map((b) => [b.from, b.to, b.status])).toEqual([
      [0, 70, 'good'],
      [70, 90, 'warning'],
      [90, 100, 'serious'],
    ]);
  });

  it('sorts the boundaries with a comparator, whatever order they arrive in', () => {
    const bands = planOf(
      runChart(gaugeChart, reading(50), {
        encoding: VALUE,
        attrs: attrsOf({ min: 0, max: 100, thresholds: [90, 70] }),
      }),
    ).bands;
    expect(bands.map((b) => b.from)).toEqual([0, 70, 90]);
  });

  it('lets the author name the role, which is the only way to say “higher is better”', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({
        min: 0,
        max: 100,
        // An edge at the floor cuts nothing, so it names the one band that has no
        // edge of its own — without it there is no way to colour the bottom.
        thresholds: [
          { at: 90, status: 'good', label: 'Healthy' },
          { at: 50, status: 'warning' },
          { at: 0, status: 'critical' },
        ],
      }),
    });
    const plan = planOf(run);
    expect(codesOf(run)).toEqual([]);
    expect(plan.bands.map((b) => [b.from, b.to, b.status])).toEqual([
      [0, 50, 'critical'],
      [50, 90, 'warning'],
      [90, 100, 'good'],
    ]);
    expect(plan.band?.label).toBe('Healthy');
    expect(fillOf(fillNode(run.laid.nodes))).toBe(theme.status.good);
  });

  it('picks the band the reading is actually in, upper edges exclusive', () => {
    const bandAt = (value: number) =>
      planOf(
        runChart(gaugeChart, reading(value), {
          encoding: VALUE,
          attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
        }),
      ).band?.status;
    expect(bandAt(0)).toBe('good');
    expect(bandAt(69.9)).toBe('good');
    expect(bandAt(70)).toBe('warning');
    expect(bandAt(90)).toBe('serious');
    // The very top of the range still lands somewhere: the last edge is closed.
    expect(bandAt(100)).toBe('serious');
  });

  it('ships an icon and a label, so meaning never rests on hue', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    const label = nodesOfKind(run.laid.nodes, 'text').find((n) =>
      (n.cls ?? '').includes('mdv-gauge-band-label'),
    );
    const icon = bandIcon(run.laid.nodes);
    expect(label?.text).toBe('Serious');
    expect(silhouette(icon)).not.toBe('none');
    // The label wears a text token; the marker beside it carries the hue.
    expect(label?.fill).toEqual({ kind: 'solid', color: theme.tokens['text-secondary'] });
    expect(fillOf(icon)).toBe(theme.status.serious);
  });

  it('gives each role its own silhouette, so four bands are four shapes', () => {
    const shapeFor = (value: number) => {
      const run = runChart(gaugeChart, reading(value), {
        encoding: VALUE,
        attrs: attrsOf({ min: 0, max: 100, thresholds: [25, 50, 75] }),
      });
      return silhouette(bandIcon(run.laid.nodes));
    };
    const shapes = [shapeFor(10), shapeFor(30), shapeFor(60), shapeFor(90)];
    expect(shapes).not.toContain('none');
    expect(new Set(shapes).size).toBe(4);
  });

  it('draws one boundary per interior edge, in the surface colour (SPEC 11.4)', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    const ticks = thresholdLines(run.laid.nodes);
    expect(ticks).toHaveLength(2);
    for (const tick of ticks) {
      expect(tick.stroke.paint).toEqual({ kind: 'solid', color: theme.tokens.surface });
      expect(tick.stroke.width).toBe(theme.marks.spacer.surfaceGap);
    }
  });

  it('drops a threshold the arc can never reach, and says which', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 150] }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(run.encodeDiagnostics[0]?.message).toContain('1 of 2 thresholds');
    expect(planOf(run).bands.map((b) => b.from)).toEqual([0, 70]);
  });

  it('falls back to the ramp when every threshold is out of range', () => {
    const run = runChart(gaugeChart, reading(50), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [500] }),
    });
    expect(planOf(run).bands).toEqual([]);
    expect(fillOf(fillNode(run.laid.nodes))).toBe(theme.sequential.hue);
  });

  it('reports a status spelling it does not know, and keeps the ladder', () => {
    const run = runChart(gaugeChart, reading(80), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [{ at: 70, status: 'panic' }] }),
    });
    expect(codesOf(run)).toEqual(['MDV1502']);
    expect(planOf(run).band?.status).toBe('warning');
  });

  it('leaves the track on the ramp: the whole arc does not repaint on a crossing', () => {
    const calm = runChart(gaugeChart, reading(10), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    const alarmed = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    expect(fillOf(trackNode(alarmed.laid.nodes))).toBe(fillOf(trackNode(calm.laid.nodes)));
  });
});

describe('gauge: degenerate input (SPEC 14, 15.2)', () => {
  it('survives the empty table without a single NaN', () => {
    const run = runChart(gaugeChart, EMPTY_TABLE);
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(run.encoded.marks).toEqual([]);
    expect(run.laid.hits).toEqual([]);
  });

  it('survives a table with columns and no rows', () => {
    const run = runChart(gaugeChart, noRows([['load', 'number']]), { encoding: VALUE });
    expect(nonFiniteNumbers(run.laid)).toEqual([]);
    expect(planOf(run).value).toBeNull();
    // The dial is still drawn, so the reader sees an empty gauge, not a hole.
    expect(trackNode(run.laid.nodes)).toBeDefined();
    expect(fillNode(run.laid.nodes)).toBeUndefined();
  });

  it('counts an all-null column as dropped rather than reading zero', () => {
    const run = runChart(gaugeChart, makeTable([['load', 'number']], [[null], [null]]), {
      encoding: VALUE,
    });
    expect(run.encoded.droppedRows).toBe(2);
    expect(planOf(run).value).toBeNull();
    expect(run.encoded.marks).toEqual([]);
  });

  it('skips null rows but still reads the last number', () => {
    const run = runChart(gaugeChart, makeTable([['load', 'number']], [[10], [null], [30]]), {
      encoding: VALUE,
      attrs: attrsOf({ max: 100 }),
    });
    expect(planOf(run).value).toBe(30);
    expect(run.encoded.droppedRows).toBe(1);
  });

  it('draws nothing in a frame with no room, rather than inverting the geometry', () => {
    for (const frame of [
      { x: 0, y: 0, width: 0, height: 0 },
      { x: 0, y: 0, width: 400, height: 4 },
      { x: 0, y: 0, width: 8, height: 200 },
    ]) {
      const run = runChart(gaugeChart, reading(50), {
        encoding: VALUE,
        attrs: attrsOf({ min: 0, max: 100 }),
        frame,
      });
      expect(run.laid.nodes, JSON.stringify(frame)).toEqual([]);
      expect(nonFiniteNumbers(run.laid)).toEqual([]);
    }
  });

  it('stays finite across every awkward reading', () => {
    for (const value of [0, -0, 1e-12, -1e6, 1e12]) {
      const run = runChart(gaugeChart, reading(value), { encoding: VALUE });
      expect(nonFiniteNumbers(run.laid), String(value)).toEqual([]);
      expect(nonFiniteNumbers(run.encoded.marks), String(value)).toEqual([]);
    }
  });
});

describe('gauge: accessible name and description (SPEC 12.1, 12.2)', () => {
  it('names the reading, the range it sits in, and how full the arc is', () => {
    const run = runChart(gaugeChart, reading(25), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100 }),
    });
    expect(run.description).toBe('Gauge. Load, 25 of 0 to 100. 25% of the range.');
  });

  it('names the band when there is one, so the status is not colour-only', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    expect(run.description).toContain('Band: Serious');
  });

  it('says so plainly when there is nothing to read', () => {
    const run = runChart(gaugeChart, EMPTY_TABLE);
    expect(run.description).toBe('Gauge with no reading.');
  });

  it('never leaks a placeholder into the description', () => {
    for (const table of [EMPTY_TABLE, noRows([['load', 'number']]), reading(3)]) {
      const run = runChart(gaugeChart, table, { encoding: VALUE });
      expect(run.description).not.toContain('NaN');
      expect(run.description).not.toContain('undefined');
      expect(run.description).not.toContain('[object Object]');
    }
  });
});

describe('gauge: the table view (SPEC 12.3)', () => {
  it('states the reading against its range, captioned by the title', () => {
    const run = runChart(gaugeChart, reading(72), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, title: 'CPU load' }),
    });
    const view = run.encoded.a11yTable;
    expect(view?.caption).toBe('CPU load');
    expect(view?.columns.map((c) => c.name)).toEqual(['Measure', 'Value']);
    expect(view?.rows).toEqual([
      ['Load', '72'],
      ['Minimum', '0'],
      ['Maximum', '100'],
    ]);
  });

  it('adds the band, so a screen reader gets the status as words', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    expect(run.encoded.a11yTable?.rows).toContainEqual(['Band', 'Serious']);
  });

  it('carries the `table` attribute through to the presentation (SPEC 8.1)', () => {
    const run = runChart(gaugeChart, reading(72), {
      encoding: VALUE,
      attrs: attrsOf({ table: 'visible' }),
    });
    expect(run.encoded.a11yTable?.presentation).toBe('visible');
  });

  it('reports the column it bound, so core does not have to guess', () => {
    const run = runChart(gaugeChart, reading(72), { encoding: VALUE });
    expect(run.encoded.boundColumns?.map((c) => c.name)).toEqual(['load']);
  });

  it('offers a readout identical to what a pointer would show (SPEC 12.4)', () => {
    const run = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    expect(run.laid.hits).toHaveLength(1);
    expect(run.laid.hits[0]?.readout).toEqual([
      { label: 'Load', value: '95', emphasis: true },
      { label: 'Range', value: '0 – 100' },
      { label: 'Band', value: 'Serious' },
    ]);
  });
});

describe('gauge: determinism (SPEC 24.3)', () => {
  it('produces identical output for identical input', () => {
    const options = {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, arc: 240, thresholds: [70, 90], title: 'CPU load' }),
    };
    const once = runChart(gaugeChart, series(10, 20, 95), options);
    const twice = runChart(gaugeChart, series(10, 20, 95), options);
    expect(JSON.stringify(twice.laid)).toBe(JSON.stringify(once.laid));
    expect(JSON.stringify(twice.encoded.marks)).toBe(JSON.stringify(once.encoded.marks));
    expect(JSON.stringify(twice.encoded.a11yTable)).toBe(JSON.stringify(once.encoded.a11yTable));
    expect(twice.description).toBe(once.description);
    expect(codesOf(twice)).toEqual(codesOf(once));
  });

  it('numbers its ids from the block index, so two blocks never collide', () => {
    const first = runChart(gaugeChart, reading(50), { encoding: VALUE, index: 0 });
    const second = runChart(gaugeChart, reading(50), { encoding: VALUE, index: 3 });
    expect(first.laid.nodes[0]?.id).toMatch(/^mdv-0-/);
    expect(second.laid.nodes[0]?.id).toMatch(/^mdv-3-/);
    const ids = second.laid.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not depend on the order the thresholds were written', () => {
    const ascending = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [70, 90] }),
    });
    const descending = runChart(gaugeChart, reading(95), {
      encoding: VALUE,
      attrs: attrsOf({ min: 0, max: 100, thresholds: [90, 70] }),
    });
    expect(JSON.stringify(descending.laid)).toBe(JSON.stringify(ascending.laid));
  });
});

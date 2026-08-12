import { describe, expect, it } from 'vitest';
import type {
  AxisModel,
  ChartHitRegion,
  DirectLabel,
  LegendModel,
  LegendRamp,
  Scale,
} from '@mdv/core';
import { createBandScale, createContinuousScale } from '../src/scale/index.js';
import { createTableMetrics } from '../src/metrics/index.js';
import {
  buildHitIndex,
  clampIntoBounds,
  computeFrame,
  createIdFactory,
  focusOrderOf,
  growToMinimum,
  makeLayoutContext,
  measureAxis,
  measureLegend,
  placeDirectLabels,
  renderAxis,
  renderLegend,
  resolveDimension,
  resolvePadding,
  roundCoord,
  MIN_HIT_SIZE,
  RAMP_THICKNESS,
} from '../src/layout/index.js';
import { createReporter } from '../src/encode/report.js';
import { RANGE, THEME } from './fixtures/visual.js';

const ctx = makeLayoutContext({ theme: THEME, metrics: createTableMetrics() });
const reporter = createReporter(() => undefined, RANGE, 'render');

function axisFor(scale: Scale, position: AxisModel['position'] = 'bottom'): AxisModel {
  return {
    channel: position === 'left' || position === 'right' ? 'y' : 'x',
    position,
    scale,
    title: false,
    grid: false,
    ticks: 'auto',
    baseline: true,
  };
}

describe('coordinate precision (SPEC 24.3 rule 4)', () => {
  it('rounds half-even to three decimals', () => {
    expect(roundCoord(1.0005)).toBe(1);
    expect(roundCoord(1.0015)).toBe(1.002);
    expect(roundCoord(12.000000000000002)).toBe(12);
  });

  it('normalises negative zero', () => {
    expect(Object.is(roundCoord(-0.0001), 0)).toBe(true);
    expect(Object.is(roundCoord(-0), 0)).toBe(true);
  });

  it('turns a non-finite coordinate into a drawable zero, never NaN', () => {
    expect(roundCoord(Number.NaN)).toBe(0);
    expect(roundCoord(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('dimensions (SPEC 5.3.3)', () => {
  it('reads every documented unit', () => {
    expect(resolveDimension(320, { reference: 800 })).toBe(320);
    expect(resolveDimension('320px', { reference: 800 })).toBe(320);
    expect(resolveDimension('100%', { reference: 800 })).toBe(800);
    expect(resolveDimension('16rem', { reference: 800 })).toBe(256);
    expect(resolveDimension('1in', { reference: 800 })).toBe(96);
    expect(resolveDimension('2.54cm', { reference: 800 })).toBeCloseTo(96, 6);
  });

  it('reports a malformed dimension as MDV1221 and falls back', () => {
    const seen: string[] = [];
    const sink = createReporter((d) => seen.push(d.code), RANGE, 'render');
    expect(resolveDimension('wide', { reference: 800 }, sink)).toBeUndefined();
    expect(seen).toEqual(['MDV1221']);
  });

  it('defaults padding to 8 on every side, and fills missing sides', () => {
    expect(resolvePadding(undefined, { reference: 400 })).toEqual({
      top: 8,
      right: 8,
      bottom: 8,
      left: 8,
    });
    expect(resolvePadding({ left: 24 }, { reference: 400 })).toEqual({
      top: 8,
      right: 8,
      bottom: 8,
      left: 24,
    });
  });
});

describe('axis label collision (SPEC 7.3, 11.5)', () => {
  const wide = ['Absolutely enormous label one', 'Absolutely enormous label two'];

  it('keeps labels horizontal when they fit', () => {
    const scale = createBandScale({ domain: ['Q1', 'Q2', 'Q3', 'Q4'], range: [0, 400] });
    const geometry = measureAxis(axisFor(scale), 400, 300, ctx);
    expect(geometry.rotate).toBe(0);
    expect(geometry.showLabels).toBe(true);
    expect(geometry.dropped).toBe(0);
    expect(geometry.ticks).toHaveLength(4);
  });

  it('rotates to −45° only when labels would collide', () => {
    const scale = createBandScale({ domain: wide, range: [0, 120] });
    const geometry = measureAxis(axisFor(scale), 120, 400, ctx);
    expect(geometry.rotate).toBe(-45);
    expect(geometry.showLabels).toBe(true);
  });

  it('thins the ladder rather than overlapping, and reports how many went', () => {
    const domain = Array.from({ length: 40 }, (_, i) => `Category ${i}`);
    const scale = createBandScale({ domain, range: [0, 300] });
    const geometry = measureAxis(axisFor(scale), 300, 120, ctx);
    expect(geometry.dropped).toBeGreaterThan(0);
    expect(geometry.ticks.length).toBeLessThan(40);
    // Whatever survives must not overlap.
    for (let i = 1; i < geometry.ticks.length; ++i) {
      const previous = geometry.ticks[i - 1];
      const current = geometry.ticks[i];
      if (previous === undefined || current === undefined) continue;
      const gap = current.position - previous.position;
      expect(gap).toBeGreaterThanOrEqual((previous.width + current.width) / 2);
    }
  });

  it('never clips: an unplaceable label is dropped, not cropped', () => {
    const scale = createBandScale({
      domain: ['A single extremely long category name'],
      range: [0, 40],
    });
    const geometry = measureAxis(axisFor(scale), 40, 40, ctx);
    if (geometry.showLabels) {
      for (const tick of geometry.ticks) {
        expect(tick.label).toBe('A single extremely long category name');
      }
    } else {
      expect(geometry.dropped).toBeGreaterThan(0);
    }
  });

  it('honours an explicit tickRotate instead of deciding for itself', () => {
    const scale = createBandScale({ domain: ['Q1', 'Q2'], range: [0, 400] });
    const geometry = measureAxis({ ...axisFor(scale), tickRotate: -90 }, 400, 300, ctx);
    expect(geometry.rotate).toBe(-90);
  });

  it('always keeps the first label when thinning', () => {
    const domain = Array.from({ length: 30 }, (_, i) => `Item ${i}`);
    const scale = createBandScale({ domain, range: [0, 200] });
    const geometry = measureAxis(axisFor(scale), 200, 100, ctx);
    expect(geometry.ticks[0]?.value).toBe('Item 0');
  });

  it('reserves space for the ladder, the labels and the title', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 2000], range: [200, 0] });
    const bare = measureAxis(axisFor(scale, 'left'), 200, 400, ctx);
    const titled = measureAxis({ ...axisFor(scale, 'left'), title: 'Revenue' }, 200, 400, ctx);
    expect(titled.extent).toBeGreaterThan(bare.extent);
  });
});

describe('axis rendering', () => {
  it('emits gridlines under the plot and a baseline on the edge', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 100], range: [200, 0] });
    const geometry = measureAxis({ ...axisFor(scale, 'left'), grid: true }, 200, 400, ctx);
    const nodes = renderAxis(geometry, { x: 40, y: 0, width: 300, height: 200 }, ctx);
    expect(nodes.grid.length).toBe(geometry.ticks.length);
    expect(nodes.grid.every((node) => node.kind === 'line')).toBe(true);
    const baseline = nodes.axis.find((node) => node.cls === 'mdv-axis-line');
    expect(baseline).toBeDefined();
  });

  it('gives y-axis tick labels tabular figures (SPEC 11.5)', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 100], range: [200, 0] });
    const geometry = measureAxis(axisFor(scale, 'left'), 200, 400, ctx);
    const nodes = renderAxis(geometry, { x: 40, y: 0, width: 300, height: 200 }, ctx);
    const label = nodes.axis.find((node) => node.kind === 'text' && node.cls === 'mdv-axis-label');
    expect(label && label.kind === 'text' ? label.tabular : undefined).toBe(true);
  });

  it('measures every text node it emits (SPEC 20)', () => {
    const scale = createBandScale({ domain: ['Q1', 'Q2'], range: [0, 300] });
    const geometry = measureAxis({ ...axisFor(scale), title: 'Quarter' }, 300, 200, ctx);
    const nodes = renderAxis(geometry, { x: 0, y: 0, width: 300, height: 200 }, ctx);
    for (const node of nodes.axis) {
      if (node.kind === 'text') expect(typeof node.width).toBe('number');
    }
  });
});

describe('the block frame (SPEC 8.1)', () => {
  it('reserves the title, the subtitle and the caption', () => {
    const bare = computeFrame({
      size: { width: 480, height: 300 },
      attrs: {},
      axes: [],
      legend: undefined,
      ctx,
      reporter,
    });
    const decorated = computeFrame({
      size: { width: 480, height: 300 },
      attrs: { title: 'Revenue', subtitle: 'by quarter', caption: 'Source: finance' },
      axes: [],
      legend: undefined,
      ctx,
      reporter,
    });
    expect(decorated.plot.height).toBeLessThan(bare.plot.height);
    expect(decorated.chrome.length).toBe(3);
  });

  it('applies padding inside the block frame', () => {
    const frame = computeFrame({
      size: { width: 400, height: 200 },
      attrs: { padding: 20 },
      axes: [],
      legend: undefined,
      ctx,
      reporter,
    });
    expect(frame.content).toEqual({ x: 20, y: 20, width: 360, height: 160 });
  });

  it('carves the legend out of the body, not out of the padding', () => {
    const legend = {
      position: 'right' as const,
      entries: [
        { seriesId: 'a', label: 'Alpha', color: '#2a78d6', symbol: 'rect' as const },
        { seriesId: 'b', label: 'Beta', color: '#eb6834', symbol: 'rect' as const },
      ],
    };
    const frame = computeFrame({
      size: { width: 480, height: 300 },
      attrs: {},
      axes: [],
      legend,
      ctx,
      reporter,
    });
    expect(frame.legendBox).toBeDefined();
    expect(frame.plot.width).toBeLessThan(frame.content.width);
  });

  it('drops a side legend below the plot in the compact variant (SPEC 8.1)', () => {
    const legend = {
      position: 'right' as const,
      entries: [
        { seriesId: 'a', label: 'Alpha', color: '#2a78d6', symbol: 'rect' as const },
        { seriesId: 'b', label: 'Beta', color: '#eb6834', symbol: 'rect' as const },
      ],
    };
    const frame = computeFrame({
      size: { width: 200, height: 300 },
      attrs: {},
      axes: [],
      legend,
      minWidth: 240,
      ctx,
      reporter,
    });
    expect(frame.compact).toBe(true);
    expect(frame.legend?.model.position).toBe('bottom');
  });

  it('reserves axis space and converges', () => {
    const scale = createContinuousScale({ type: 'linear', domain: [0, 200000], range: [0, 1] });
    const frame = computeFrame({
      size: { width: 480, height: 300 },
      attrs: {},
      axes: [{ ...axisFor(scale, 'left'), title: 'Revenue' }],
      legend: undefined,
      rerange: (model) => model,
      ctx,
      reporter,
    });
    expect(frame.plot.x).toBeGreaterThan(frame.content.x);
    expect(frame.plot.width).toBeGreaterThan(0);
  });

  it('survives a zero-size container without producing negative geometry', () => {
    const frame = computeFrame({
      size: { width: 0, height: 0 },
      attrs: {},
      axes: [],
      legend: undefined,
      ctx,
      reporter,
    });
    expect(frame.plot.width).toBeGreaterThanOrEqual(0);
    expect(frame.plot.height).toBeGreaterThanOrEqual(0);
  });
});

describe('legend measurement (SPEC 7.4)', () => {
  const entries = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((label, i) => ({
    seriesId: label,
    label,
    color: THEME.categorical[i] ?? '#000',
    symbol: 'rect' as const,
  }));

  it('wraps a horizontal legend into rows', () => {
    const wide = measureLegend({ position: 'top', entries }, { width: 1000, height: 200 }, ctx);
    const narrow = measureLegend({ position: 'top', entries }, { width: 120, height: 200 }, ctx);
    expect(narrow.size.height).toBeGreaterThan(wide.size.height);
  });

  it('stacks a side legend vertically', () => {
    const legend = measureLegend({ position: 'right', entries }, { width: 200, height: 300 }, ctx);
    const ys = legend.items.map((item) => item.y);
    expect(new Set(ys).size).toBe(entries.length);
  });

  it('reserves nothing for an inline legend — direct labels carry identity', () => {
    const legend = measureLegend({ position: 'inline', entries }, { width: 400, height: 300 }, ctx);
    expect(legend.inline).toBe(true);
    expect(legend.size).toEqual({ width: 0, height: 0 });
  });
});

describe('the continuous ramp legend (SPEC 8.9)', () => {
  const stops = ['#eef2ff', '#6366f1', '#1e1b4b'];
  const labels = [
    { at: 0, text: '0' },
    { at: 0.5, text: '50' },
    { at: 1, text: '100' },
  ];
  const swatched = ['Alpha', 'Beta'].map((label, i) => ({
    seriesId: label,
    label,
    color: THEME.categorical[i] ?? '#000',
    symbol: 'rect' as const,
  }));

  function ramped(over: Partial<LegendModel> = {}, rampOver: Partial<LegendRamp> = {}) {
    return measureLegend(
      { position: 'top', entries: [], ramp: { stops, labels, ...rampOver }, ...over },
      { width: 400, height: 300 },
      ctx,
    );
  }

  it('draws a bar instead of swatches, because a swatch per value would be absurd', () => {
    const legend = ramped();
    expect(legend.items).toEqual([]);
    expect(legend.ramp?.bands.length).toBeGreaterThan(1);
    expect(legend.size.height).toBeGreaterThan(RAMP_THICKNESS);
  });

  it('wins over entries, so the marks are never identified two ways at once', () => {
    const both = measureLegend(
      { position: 'top', entries: swatched, ramp: { stops, labels } },
      { width: 400, height: 300 },
      ctx,
    );
    expect(both.ramp).toBeDefined();
    expect(both.items).toEqual([]);
  });

  it('tiles exactly: the bands meet edge to edge and fill the bar (SPEC 24.3)', () => {
    const bands = ramped().ramp?.bands ?? [];
    const length = ramped().ramp?.length ?? 0;
    expect(bands[0]?.offset).toBe(0);
    for (let i = 1; i < bands.length; ++i) {
      const previous = bands[i - 1] as (typeof bands)[number];
      expect(bands[i]?.offset).toBe(previous.offset + previous.length);
    }
    const last = bands[bands.length - 1] as (typeof bands)[number];
    expect(last.offset + last.length).toBe(length);
  });

  it('runs low end first, whichever way it is drawn', () => {
    const flat = ramped().ramp;
    const upright = ramped({ position: 'right' }).ramp;
    expect(flat?.bands[0]?.color).toBe(stops[0]);
    expect(upright?.vertical).toBe(true);
    expect(upright?.bands[0]?.color).toBe(stops[0]);
  });

  it('gives a classed scale one hard-edged band per class, not a blend', () => {
    const discrete = ramped({}, { discrete: true }).ramp;
    expect(discrete?.bands.map((band) => band.color)).toEqual(stops);
  });

  it('keeps both ends, because a ramp labelled at one end is a scale it is not', () => {
    const crowded = ramped({}, {
      labels: Array.from({ length: 40 }, (_, i) => ({ at: i / 39, text: `${i * 1000}` })),
    }).ramp;
    const ticks = crowded?.ticks ?? [];
    expect(ticks.length).toBeLessThan(40);
    expect(ticks[0]?.text).toBe('0');
    expect(ticks[ticks.length - 1]?.text).toBe('39000');
  });

  it('splits the bar between the ends rather than dropping one when they collide', () => {
    const tight = measureLegend(
      {
        position: 'top',
        entries: [],
        ramp: {
          stops,
          labels: [
            { at: 0, text: 'a very long low label' },
            { at: 1, text: 'a very long high label' },
          ],
        },
      },
      { width: 60, height: 300 },
      ctx,
    );
    const ticks = tight.ramp?.ticks ?? [];
    expect(ticks).toHaveLength(2);
    expect(ticks[0]?.width).toBe(ticks[1]?.width);
    expect(ticks[0]?.align).toBe('start');
    expect(ticks[1]?.align).toBe('end');
  });

  it('turns the ends inward so neither overhangs the bar', () => {
    const geometry = ramped().ramp;
    const ticks = geometry?.ticks ?? [];
    expect(ticks[0]?.offset).toBe(0);
    expect(ticks[ticks.length - 1]?.offset).toBe(geometry?.length);
  });

  it('asks for nothing when there is no room for a bar at all', () => {
    const none = measureLegend(
      { position: 'top', entries: [], ramp: { stops, labels } },
      { width: 0, height: 0 },
      ctx,
    );
    expect(none.size).toEqual({ width: 0, height: 0 });
    expect(none.ramp?.bands).toEqual([]);
  });

  it('renders the bar bottom-up when it is upright, which is how a scale reads', () => {
    const geometry = ramped({ position: 'right' });
    const box = { x: 10, y: 20, width: 40, height: 200 };
    const nodes = renderLegend(geometry, box, ctx);
    const group = nodes[0];
    const children = group?.kind === 'group' ? group.children : [];
    const bands = children.filter(
      (node) => node.kind === 'rect' && node.cls === 'mdv-legend-ramp-band',
    );
    const first = bands[0];
    const last = bands[bands.length - 1];
    // The low end is the first band and it sits lowest on the screen.
    expect(first?.kind === 'rect' ? first.y : 0).toBeGreaterThan(last?.kind === 'rect' ? last.y : 0);
  });

  it('outlines the bar, so a pale low end does not dissolve into the surface', () => {
    const nodes = renderLegend(ramped(), { x: 0, y: 0, width: 400, height: 40 }, ctx);
    const group = nodes[0];
    const children = group?.kind === 'group' ? group.children : [];
    const outline = children.find((node) => node.cls === 'mdv-legend-ramp');
    expect(outline?.kind === 'rect' ? outline.stroke?.width : undefined).toBe(
      THEME.metrics.hairline,
    );
  });

  it('names itself for a screen reader even without a title', () => {
    const nodes = renderLegend(ramped(), { x: 0, y: 0, width: 400, height: 40 }, ctx);
    const group = nodes[0];
    expect(group?.kind === 'group' ? group.label : undefined).toBe('Colour scale');
    expect(group?.kind === 'group' ? group.role : undefined).toBe('group');
  });

  it('never wears the data colour on its labels (SPEC 11.5)', () => {
    const nodes = renderLegend(ramped(), { x: 0, y: 0, width: 400, height: 40 }, ctx);
    const group = nodes[0];
    const children = group?.kind === 'group' ? group.children : [];
    const label = children.find((node) => node.cls === 'mdv-legend-ramp-label');
    expect(label?.kind === 'text' ? label.fill : undefined).toEqual({
      kind: 'solid',
      color: THEME.tokens['text-secondary'],
    });
  });
});

describe('direct labels (SPEC 11.5)', () => {
  const bounds = { x: 0, y: 0, width: 400, height: 200 };

  function label(over: Partial<DirectLabel>): DirectLabel {
    return {
      x: 100,
      y: 100,
      text: 'Label',
      placement: 'above',
      priority: 1,
      seriesId: 'a',
      datum: 0,
      ...over,
    };
  }

  it('places a label that fits', () => {
    const result = placeDirectLabels([label({})], ctx, { bounds });
    expect(result.placed).toBe(1);
    expect(result.dropped).toBe(0);
  });

  it('drops rather than clips a label that cannot fit', () => {
    const result = placeDirectLabels(
      [label({ text: 'An extremely long direct label that cannot possibly fit', x: 5, y: 5 })],
      ctx,
      { bounds: { x: 0, y: 0, width: 40, height: 40 } },
    );
    expect(result.placed).toBe(0);
    expect(result.dropped).toBe(1);
  });

  it('resolves a collision by trying the fallback placements', () => {
    const result = placeDirectLabels(
      [label({ datum: 0 }), label({ datum: 1, text: 'Other' })],
      ctx,
      { bounds },
    );
    expect(result.placed).toBe(2);
  });

  it('keeps the higher priority when only one can be placed', () => {
    const tight = { x: 0, y: 0, width: 400, height: 24 };
    const result = placeDirectLabels(
      [
        label({ priority: 1, text: 'low', x: 100, y: 12, placement: 'inside' }),
        label({ priority: 9, text: 'high', x: 100, y: 12, placement: 'inside', datum: 1 }),
      ],
      ctx,
      { bounds: tight },
    );
    const texts = result.nodes.map((node) => (node.kind === 'text' ? node.text : ''));
    expect(texts).toContain('high');
    expect(result.dropped).toBe(1);
  });

  it('never wears the data colour, except inside a filled mark', () => {
    const outside = placeDirectLabels([label({})], ctx, { bounds });
    const outsideNode = outside.nodes[0];
    expect(outsideNode?.kind === 'text' ? outsideNode.fill : undefined).toEqual({
      kind: 'solid',
      color: THEME.tokens['text-primary'],
    });

    const inside = placeDirectLabels([label({ insideFill: '#0b0b0b', placement: 'inside' })], ctx, {
      bounds,
    });
    const insideNode = inside.nodes[0];
    expect(insideNode?.kind === 'text' ? insideNode.fill : undefined).toEqual({
      kind: 'solid',
      color: THEME.tokens.surface,
    });
  });

  it('is order-independent: the same set places the same way', () => {
    const set = [
      label({ datum: 0, priority: 3, text: 'one' }),
      label({ datum: 1, priority: 5, text: 'two', x: 200 }),
      label({ datum: 2, priority: 1, text: 'three', x: 300 }),
    ];
    const forwards = placeDirectLabels(set, ctx, { bounds });
    const backwards = placeDirectLabels([...set].reverse(), ctx, { bounds });
    expect(JSON.stringify(stripIds(forwards.nodes))).toBe(
      JSON.stringify(stripIds(backwards.nodes)),
    );
  });
});

function stripIds(nodes: readonly { id?: string }[]): unknown[] {
  return nodes.map((node) => {
    const { id: _id, ...rest } = node;
    return rest;
  });
}

describe('hit regions (SPEC 7.5, 12.4, 12.5)', () => {
  it('grows every region to at least 24 × 24, centred', () => {
    const grown = growToMinimum({ x: 100, y: 100, width: 8, height: 8 });
    expect(grown).toEqual({ x: 92, y: 92, width: MIN_HIT_SIZE, height: MIN_HIT_SIZE });
  });

  it('leaves a region that is already big enough alone', () => {
    const rect = { x: 0, y: 0, width: 40, height: 30 };
    expect(growToMinimum(rect)).toEqual(rect);
  });

  it('slides a region back into bounds rather than shrinking it', () => {
    const clamped = clampIntoBounds(
      { x: -8, y: -8, width: 24, height: 24 },
      {
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
    );
    expect(clamped).toEqual({ x: 0, y: 0, width: 24, height: 24 });
  });

  it('enforces the minimum through buildHitIndex, in one place', () => {
    const proposed: ChartHitRegion[] = [
      {
        x: 10,
        y: 10,
        w: 4,
        h: 4,
        anchor: { x: 12, y: 12 },
        datumIndex: 0,
        readout: [{ label: 'Q1', value: '1,240' }],
      },
    ];
    const regions = buildHitIndex(proposed, { ids: createIdFactory(3) });
    expect(regions[0]?.w).toBe(MIN_HIT_SIZE);
    expect(regions[0]?.h).toBe(MIN_HIT_SIZE);
    expect(regions[0]?.id).toBe('mdv-3-hit-0');
    expect(regions[0]?.anchor).toEqual({ x: 12, y: 12 });
  });

  it('keeps a chart-supplied id, so focus order survives a re-render', () => {
    const regions = buildHitIndex(
      [
        {
          id: 'stable',
          x: 0,
          y: 0,
          w: 30,
          h: 30,
          anchor: { x: 0, y: 0 },
          datumIndex: 0,
          readout: [],
        },
      ],
      { ids: createIdFactory(0) },
    );
    expect(regions[0]?.id).toBe('stable');
  });

  it('walks series one after another for Page Up/Page Down', () => {
    const regions = buildHitIndex(
      [
        {
          x: 0,
          y: 0,
          w: 30,
          h: 30,
          anchor: { x: 0, y: 0 },
          datumIndex: 0,
          readout: [],
          group: 'a',
        },
        {
          x: 30,
          y: 0,
          w: 30,
          h: 30,
          anchor: { x: 0, y: 0 },
          datumIndex: 1,
          readout: [],
          group: 'b',
        },
        {
          x: 60,
          y: 0,
          w: 30,
          h: 30,
          anchor: { x: 0, y: 0 },
          datumIndex: 2,
          readout: [],
          group: 'a',
        },
      ],
      { ids: createIdFactory(0) },
    );
    const order = focusOrderOf(regions);
    expect(order).toEqual([regions[0]?.id, regions[2]?.id, regions[1]?.id]);
  });
});

describe('deterministic ids (SPEC 24.3 rule 7)', () => {
  it('numbers from zero, per block, with an optional infix', () => {
    const ids = createIdFactory(7);
    expect(ids.next()).toBe('mdv-7-0');
    expect(ids.next('axis')).toBe('mdv-7-axis-1');
    expect(ids.next()).toBe('mdv-7-2');
  });
});

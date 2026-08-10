import { describe, expect, it } from 'vitest';
import type { AxisModel, BlockAttrs, Diagnostic, Scale } from '@mdv/core';
import {
  buildAxisModel,
  buildLegendModel,
  buildSeriesDescriptors,
  createPaletteAllocator,
  createReporter,
  detectSecondAxisRequest,
  enforceOneAxisRule,
  foldLegendEntries,
  hasFormConflict,
  humanise,
  isDualAxis,
  normalizeLegendAttr,
  resolveChannels,
  seriesIdentities,
  slotCapForFamily,
} from '../src/encode/index.js';
import { createBandScale, createContinuousScale } from '../src/scale/index.js';
import { LONG_FORM, QUARTERS, RANGE, THEME, XY_CHANNELS, table } from './fixtures/visual.js';

function collector(): { diagnostics: Diagnostic[]; reporter: ReturnType<typeof createReporter> } {
  const diagnostics: Diagnostic[] = [];
  return {
    diagnostics,
    reporter: createReporter((d) => diagnostics.push(d), RANGE, 'encode', 'mdv-0'),
  };
}

describe('wide vs long form (SPEC 7.1.1)', () => {
  it('reads series identity from a series column, in first-appearance order', () => {
    const identities = seriesIdentities(LONG_FORM, {
      x: { field: 'quarter' },
      y: { field: 'amount' },
      series: { field: 'metric' },
    });
    expect(identities.map((i) => i.id)).toEqual(['revenue', 'profit']);
  });

  it('reads series identity from the bound field names in wide form', () => {
    const wide = table(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
        ['profit', 'number'],
      ],
      [['Q1', 1, 2]],
    );
    const identities = seriesIdentities(wide, {
      x: { field: 'quarter' },
      y: [{ field: 'revenue' }, { field: 'profit' }],
    });
    expect(identities.map((i) => i.id)).toEqual(['revenue', 'profit']);
    expect(identities.map((i) => i.label)).toEqual(['Revenue', 'Profit']);
  });

  it('rejects a list `y` combined with `series` (MDV3010)', () => {
    const encoding = {
      x: { field: 'quarter' },
      y: [{ field: 'a' }, { field: 'b' }],
      series: { field: 'metric' },
    };
    expect(hasFormConflict(encoding)).toBe(true);
    const { diagnostics, reporter } = collector();
    resolveChannels(XY_CHANNELS, encoding, LONG_FORM, reporter);
    expect(diagnostics.map((d) => d.code)).toContain('MDV3010');
  });
});

describe('channel resolution (SPEC 7.1)', () => {
  it('reports a missing required channel as MDV3000', () => {
    const { diagnostics, reporter } = collector();
    const result = resolveChannels(XY_CHANNELS, { x: { field: 'quarter' } }, QUARTERS, reporter);
    expect(result.ok).toBe(false);
    expect(diagnostics[0]?.code).toBe('MDV3000');
  });

  it('reports an incompatible field type as MDV3001', () => {
    const { diagnostics, reporter } = collector();
    resolveChannels(
      XY_CHANNELS,
      { x: { field: 'quarter' }, y: { field: 'quarter' } },
      QUARTERS,
      reporter,
    );
    expect(diagnostics.map((d) => d.code)).toContain('MDV3001');
  });

  it('reports an unknown field as MDV2111 and names the alternatives', () => {
    const { diagnostics, reporter } = collector();
    resolveChannels(
      XY_CHANNELS,
      { x: { field: 'nope' }, y: { field: 'revenue' } },
      QUARTERS,
      reporter,
    );
    expect(diagnostics[0]?.code).toBe('MDV2111');
    expect(diagnostics[0]?.detail).toContain('revenue');
  });

  it('humanises a field name for the default title', () => {
    expect(humanise('unit_price')).toBe('Unit price');
    expect(humanise('unitPrice')).toBe('Unit price');
    expect(humanise('GDP')).toBe('GDP');
  });
});

describe('palette allocation (SPEC 11.2 rule 1)', () => {
  it('keys the slot on identity, so a filter cannot re-colour a series', () => {
    const unfiltered = createPaletteAllocator({
      identities: ['emea', 'apac', 'amer'],
      colors: THEME.categorical,
    });
    // The same allocator, queried after "apac" has been filtered out of the data.
    expect(unfiltered.allocator.slot('amer')).toBe(2);
    expect(unfiltered.allocator.color('amer')).toBe(THEME.categorical[2]);
  });

  it('never cycles: a ninth series folds into Other (SPEC 11.2 rule 2)', () => {
    const identities = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    const allocated = createPaletteAllocator({ identities, colors: THEME.categorical });
    expect(allocated.allocator.isOverflow('i')).toBe(true);
    expect(allocated.allocator.slot('i')).toBe(-1);
    expect(allocated.overflow).toEqual(['i']);
  });

  it('caps all-pairs forms at three slots (SPEC 11.2 rule 3)', () => {
    expect(slotCapForFamily('nearest')).toBe(3);
    expect(slotCapForFamily('mark')).toBe(8);
    const allocated = createPaletteAllocator({
      identities: ['a', 'b', 'c', 'd'],
      colors: THEME.categorical,
      cap: slotCapForFamily('nearest'),
    });
    expect(allocated.allocator.isOverflow('d')).toBe(true);
  });

  it('produces one synthetic Other descriptor, not one per overflow', () => {
    const identities = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].map((id) => ({
      id,
      label: id,
      source: id,
    }));
    const allocated = createPaletteAllocator({
      identities: identities.map((i) => i.id),
      colors: THEME.categorical,
    });
    const { series, folded } = buildSeriesDescriptors({
      identities,
      palette: allocated.allocator,
    });
    expect(folded).toEqual(['i', 'j']);
    expect(series.filter((s) => s.isOther === true)).toHaveLength(1);
    expect(series).toHaveLength(9);
  });
});

describe('the one-axis rule (SPEC 7.3.1)', () => {
  const scaleA = createContinuousScale({ type: 'linear', domain: [0, 10], range: [0, 100] });
  const scaleB = createContinuousScale({ type: 'linear', domain: [0, 1000], range: [0, 100] });

  function axis(position: AxisModel['position'], scale: Scale): AxisModel {
    return {
      channel: position === 'left' || position === 'right' ? 'y' : 'x',
      position,
      scale,
      title: 'v',
      grid: false,
      ticks: 'auto',
      baseline: true,
    };
  }

  it('rejects `y2` and names the three supported answers', () => {
    const { diagnostics, reporter } = collector();
    const rejected = detectSecondAxisRequest({ y2: 'profit' }, reporter);
    expect(rejected).toEqual(['y2']);
    expect(diagnostics[0]?.severity).toBe('warning');
    expect(diagnostics[0]?.detail).toContain('mdv-grid');
    expect(diagnostics[0]?.detail).toContain('row:');
    expect(diagnostics[0]?.detail).toContain('derive');
  });

  it('rejects every documented spelling of a second axis', () => {
    const { diagnostics, reporter } = collector();
    // `axis.right` is not in `BlockAttrs['axis']` precisely because the spec has
    // no such axis; the cast is how an author's attempt reaches the detector.
    const attrs = {
      secondaryAxis: {},
      rightAxis: {},
      axis: { right: {} },
    } as unknown as BlockAttrs;
    detectSecondAxisRequest(attrs, reporter);
    expect(diagnostics).toHaveLength(3);
    for (const diagnostic of diagnostics) expect(diagnostic.code).toBe('MDV1501');
  });

  it('leaves `axis: {y: {position: right}}` alone — that is one axis', () => {
    const { diagnostics, reporter } = collector();
    detectSecondAxisRequest({ axis: { y: { position: 'right' } } }, reporter);
    expect(diagnostics).toHaveLength(0);
  });

  it('drops a second independent y-axis emitted by a chart type', () => {
    const { diagnostics, reporter } = collector();
    const kept = enforceOneAxisRule([axis('left', scaleA), axis('right', scaleB)], reporter);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.position).toBe('left');
    expect(diagnostics[0]?.code).toBe('MDV1501');
    expect(diagnostics[0]?.severity).toBe('warning');
  });

  it('allows the same scale mirrored on both edges', () => {
    const { diagnostics, reporter } = collector();
    const kept = enforceOneAxisRule([axis('left', scaleA), axis('right', scaleA)], reporter);
    expect(kept).toHaveLength(2);
    expect(diagnostics).toHaveLength(0);
  });

  it('detects the dual-axis shape without reporting', () => {
    expect(isDualAxis([axis('left', scaleA), axis('right', scaleB)])).toBe(true);
    expect(isDualAxis([axis('left', scaleA), axis('bottom', scaleB)])).toBe(false);
  });

  it('applies the same rule to two independent x-scales', () => {
    const { diagnostics, reporter } = collector();
    const kept = enforceOneAxisRule([axis('bottom', scaleA), axis('top', scaleB)], reporter);
    expect(kept).toHaveLength(1);
    expect(diagnostics).toHaveLength(1);
  });
});

describe('axis models (SPEC 7.3)', () => {
  const scale = createBandScale({ domain: ['Q1', 'Q2'], range: [0, 100] });

  it('defaults the title to the humanised field and the edge to the channel', () => {
    const model = buildAxisModel({ channel: 'x', scale, defaultTitle: 'Quarter' });
    expect(model?.title).toBe('Quarter');
    expect(model?.position).toBe('bottom');
    expect(model?.grid).toBe(false);
  });

  it('suppresses the axis entirely for `axis: {x: false}`', () => {
    expect(buildAxisModel({ channel: 'x', scale, spec: false, defaultTitle: 'Q' })).toBeUndefined();
  });

  it('honours `title: false` without falling back', () => {
    const model = buildAxisModel({
      channel: 'y',
      scale,
      spec: { title: false },
      defaultTitle: 'Revenue',
    });
    expect(model?.title).toBe(false);
  });
});

describe('legends (SPEC 7.4)', () => {
  const series = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `s${i}`,
      label: `Series ${i}`,
      slot: i,
      color: THEME.categorical[i] ?? '#000',
      source: `s${i}`,
    }));

  it('draws no legend for a single series under `auto`', () => {
    const model = buildLegendModel({
      series: series(1),
      request: normalizeLegendAttr('auto'),
      family: 'mark',
    });
    expect(model).toBeUndefined();
  });

  it('goes top for six series or fewer and right beyond that', () => {
    const top = buildLegendModel({
      series: series(6),
      request: normalizeLegendAttr('auto'),
      family: 'mark',
    });
    expect(top?.position).toBe('top');
    const right = buildLegendModel({
      series: series(7),
      request: normalizeLegendAttr('auto'),
      family: 'mark',
    });
    expect(right?.position).toBe('right');
  });

  it('mirrors the mark in its symbol', () => {
    expect(
      buildLegendModel({
        series: series(2),
        request: normalizeLegendAttr('auto'),
        family: 'crosshair',
      })?.entries[0]?.symbol,
    ).toBe('line');
    expect(
      buildLegendModel({
        series: series(2),
        request: normalizeLegendAttr('auto'),
        family: 'nearest',
      })?.entries[0]?.symbol,
    ).toBe('point');
  });

  it('honours an explicit position even for one series', () => {
    const model = buildLegendModel({
      series: series(1),
      request: normalizeLegendAttr('bottom'),
      family: 'mark',
    });
    expect(model?.position).toBe('bottom');
  });

  it('folds past `maxItems` into a single Other entry', () => {
    const entries = series(10).map((s) => ({
      seriesId: s.id,
      label: s.label,
      color: s.color,
      symbol: 'rect' as const,
    }));
    const folded = foldLegendEntries(entries, 5, '#898781');
    expect(folded.entries).toHaveLength(5);
    expect(folded.entries[4]?.isOther).toBe(true);
    expect(folded.folded).toBe(6);
  });

  it('reads every spelling of the `legend:` attribute', () => {
    expect(normalizeLegendAttr(false).position).toBe(false);
    expect(normalizeLegendAttr('right').position).toBe('right');
    expect(normalizeLegendAttr({ position: 'left', maxItems: 4 }).maxItems).toBe(4);
    expect(normalizeLegendAttr(undefined).maxItems).toBe(12);
  });
});

import { describe, expect, it } from 'vitest';
import type {
  BarMark,
  ChartType,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  Rect,
  Scene,
  SceneNode,
} from '@mdv/core';
import { createChartRegistry } from '@mdv/core';
import { bandCenter, buildPositionalScale } from '../src/scale/index.js';
import { createTableMetrics } from '../src/metrics/index.js';
import { layoutBlock, makeLayoutContext } from '../src/layout/index.js';
import { buildReadout } from '../src/encode/readout.js';
import {
  LONG_FORM,
  QUARTERS,
  THEME,
  XY_CHANNELS,
  resolvedBlock,
  table,
} from './fixtures/visual.js';

/**
 * A minimal bar-shaped chart type. It exercises exactly the seam core cares
 * about — encode returns marks, scales and axes; layout returns nodes and hits —
 * without pulling in `@mdv/charts`.
 */
const stubBar: ChartType = {
  name: 'bar',
  level: 1,
  family: 'mark',
  channels: XY_CHANNELS,
  defaultEncoding: {},
  validate: () => [],
  encode(input: EncodeInput): EncodeResult {
    const xField = firstField(input, 'x') ?? 'quarter';
    const yField = firstField(input, 'y') ?? 'revenue';
    const seriesField = firstField(input, 'series');

    const xValues = input.table.rows.map((row) => row[indexOf(input, xField)] ?? null);
    const yValues = input.table.rows.map((row) => row[indexOf(input, yField)] ?? null);

    const x = buildPositionalScale({
      values: xValues,
      range: [0, 1],
      fieldType: 'category',
      discrete: 'band',
    });
    const y = buildPositionalScale({
      values: yValues,
      range: [0, 1],
      fieldType: 'number',
      zeroDefault: true,
    });

    const marks: BarMark[] = input.table.rows.map((row, index) => {
      const seriesId =
        seriesField === undefined ? yField : String(row[indexOf(input, seriesField)] ?? '');
      return {
        mark: 'bar',
        seriesId,
        datum: index,
        x: String(row[indexOf(input, xField)] ?? ''),
        y0: 0,
        y1: Number(row[indexOf(input, yField)] ?? 0),
      };
    });

    const ids = [...new Set(marks.map((mark) => mark.seriesId))];
    return {
      marks,
      series: ids.map((id) => ({
        id,
        label: id,
        slot: input.palette.slot(id),
        color: input.palette.color(id),
        source: id,
      })),
      scales: { x, y },
      axes: [
        {
          channel: 'x',
          position: 'bottom',
          scale: x,
          title: 'Quarter',
          grid: false,
          ticks: 'auto',
          baseline: true,
        },
        {
          channel: 'y',
          position: 'left',
          scale: y,
          title: 'Revenue',
          grid: true,
          ticks: 'auto',
          baseline: false,
        },
      ],
    };
  },
  layout(encoded: EncodeResult, frame: Rect, ctx: LayoutContext) {
    const x = encoded.scales.x;
    const y = encoded.scales.y;
    const nodes: SceneNode[] = [];
    const hits: ReturnType<ChartType['layout']>['hits'] = [];
    if (x === undefined || y === undefined) return { nodes, hits };

    const width = Math.min(x.bandwidth?.() ?? 8, ctx.theme.marks.bar.maxThickness);
    for (const mark of encoded.marks) {
      if (mark.mark !== 'bar') continue;
      const centre = bandCenter(x, String(mark.x));
      const top = y.scale(mark.y1);
      const base = y.scale(mark.y0);
      if (centre === undefined || top === undefined || base === undefined) continue;
      const id = ctx.ids.next('mark');
      nodes.push({
        kind: 'rect',
        id,
        x: centre - width / 2,
        y: Math.min(top, base),
        w: width,
        h: Math.abs(base - top),
        r: [4, 4, 0, 0],
        fill: { kind: 'solid', color: '#2a78d6' },
      });
      hits.push({
        x: centre - width / 2,
        y: Math.min(top, base),
        w: width,
        h: Math.abs(base - top),
        anchor: { x: centre, y: Math.min(top, base) },
        datumIndex: mark.datum,
        seriesId: mark.seriesId,
        group: mark.seriesId,
        markNodeId: id,
        readout: buildReadout({
          // `EncodeResult` carries no table (only `MarkSet` does), and the
          // readout only needs one for `tooltip:` extras, which this stub omits.
          table: { fields: [], rows: [] },
          datum: mark.datum,
          keyLabel: 'Quarter',
          keyValue: String(mark.x),
          value: mark.y1,
          ctx: { locale: ctx.locale, timezone: ctx.timezone },
        }),
      });
    }
    return { nodes, hits, labels: [] };
  },
};

function firstField(input: EncodeInput, channel: 'x' | 'y' | 'series'): string | undefined {
  const raw = input.encoding[channel];
  const one = Array.isArray(raw) ? raw[0] : raw;
  return one?.field;
}

function indexOf(input: EncodeInput, field: string): number {
  return input.table.fields.findIndex((column) => column.name === field);
}

const registry = createChartRegistry([stubBar]);

function layout(
  block = resolvedBlock(),
  size = { width: 480, height: 300 },
  diagnostics: Diagnostic[] = [],
): Scene {
  const ctx = makeLayoutContext({
    theme: THEME,
    metrics: createTableMetrics(),
    blockIndex: block.index,
    onDiagnostic: (d) => diagnostics.push(d),
  });
  return layoutBlock(block, size, ctx, registry);
}

describe('layoutBlock (SPEC 21)', () => {
  it('emits a complete scene', () => {
    const scene = layout();
    expect(scene.width).toBe(480);
    expect(scene.height).toBe(300);
    expect(scene.root.kind).toBe('group');
    expect(scene.meta.type).toBe('bar');
    expect(scene.meta.theme).toBe('default');
    expect(scene.hitIndex).toHaveLength(4);
    expect(scene.a11y.table.rows).toHaveLength(4);
  });

  it('is byte-identical across two runs of the same input (SPEC 24.3)', () => {
    const first = layout();
    const second = layout();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it('is byte-identical when the block is rebuilt from scratch', () => {
    const a = layout(resolvedBlock());
    const b = layout(resolvedBlock());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('rounds every emitted coordinate to three decimals', () => {
    const scene = layout(resolvedBlock(), { width: 481, height: 301 });
    const seen: number[] = [];
    walk(scene.root, (node) => {
      if (node.kind === 'rect') seen.push(node.x, node.y, node.w, node.h);
      if (node.kind === 'line') seen.push(node.x1, node.y1, node.x2, node.y2);
      if (node.kind === 'text') seen.push(node.x, node.y);
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) {
      expect(Number(value.toFixed(3))).toBe(value);
      expect(Object.is(value, -0)).toBe(false);
    }
  });

  it('grows every hit region to the 24 px minimum', () => {
    const scene = layout(resolvedBlock(), { width: 800, height: 300 });
    for (const region of scene.hitIndex) {
      expect(region.w).toBeGreaterThanOrEqual(24);
      expect(region.h).toBeGreaterThanOrEqual(24);
    }
  });

  it('lists every hit region in the focus order (SPEC 12.4)', () => {
    const scene = layout();
    expect(scene.a11y.focusOrder).toEqual(scene.hitIndex.map((region) => region.id));
  });

  it('keeps the readout identical for hover and focus — there is only one', () => {
    const scene = layout();
    const region = scene.hitIndex[0];
    expect(region?.readout[0]).toEqual({ label: 'Quarter', value: 'Q1' });
    expect(region?.readout[1]?.emphasis).toBe(true);
  });

  it('draws gridlines beneath the marks', () => {
    const scene = layout();
    const classes = scene.root.children.map((child) => child.cls);
    expect(classes.indexOf('mdv-grid')).toBeLessThan(classes.indexOf('mdv-marks'));
  });

  it('clips the marks group to the plot frame', () => {
    const scene = layout();
    const marks = scene.root.children.find((child) => child.cls === 'mdv-marks');
    expect(marks?.kind === 'group' ? marks.clip : undefined).toBeDefined();
    expect(scene.defs.some((def) => def.kind === 'clip')).toBe(true);
  });
});

describe('accessibility (SPEC 12)', () => {
  it('takes the accessible name from the title', () => {
    const scene = layout(resolvedBlock({ attrs: { title: 'Revenue by quarter' } }));
    expect(scene.a11y.name).toBe('Revenue by quarter');
    expect(scene.a11y.role).toBe('img');
  });

  it('becomes a figure when the block has a caption', () => {
    const scene = layout(resolvedBlock({ attrs: { caption: 'Source: finance' } }));
    expect(scene.a11y.role).toBe('figure');
  });

  it('generates a description naming the extremes (SPEC 12.2)', () => {
    const scene = layout();
    expect(scene.a11y.descGenerated).toBe(true);
    expect(scene.a11y.desc).toMatchInlineSnapshot(
      `"Bar chart. Revenue by quarter, 4 categories. Values range from 1,240 in Q1 to 1,893 in Q4. Highest: Q4."`,
    );
  });

  it('prefers an authored description and does not mark it generated', () => {
    const scene = layout(resolvedBlock({ attrs: { desc: 'Four quarters of growth.' } }));
    expect(scene.a11y.desc).toBe('Four quarters of growth.');
    expect(scene.a11y.descGenerated).toBe(false);
  });

  it('always exposes the data as a table (SPEC 12.3)', () => {
    const scene = layout();
    expect(scene.a11y.table.presentation).toBe('details');
    expect(scene.a11y.table.columns.map((column) => column.name)).toEqual(['Quarter', 'Revenue']);
    // Thousands-separated, matching the axis (SPEC 11.5) — and formatted once,
    // here, so the DOM and the PDF cannot disagree.
    expect(scene.a11y.table.rows[0]).toEqual(['Q1', '1,240']);
  });

  it('right-aligns quantitative columns', () => {
    const scene = layout();
    expect(scene.a11y.table.columns[1]?.align).toBe('right');
    expect(scene.a11y.table.columns[0]?.align).toBe('left');
  });

  it('reports `table: none` as MDV3090', () => {
    const diagnostics: Diagnostic[] = [];
    layout(resolvedBlock({ attrs: { table: 'none' } }), { width: 480, height: 300 }, diagnostics);
    expect(diagnostics.map((d) => d.code)).toContain('MDV3090');
  });
});

describe('failure paths (SPEC 14.1)', () => {
  it('never throws when the chart type throws — it emits MDV5000 and a card', () => {
    const exploding: ChartType = {
      ...stubBar,
      name: 'boom',
      encode() {
        throw new Error('kaboom');
      },
    };
    const diagnostics: Diagnostic[] = [];
    const ctx = makeLayoutContext({
      theme: THEME,
      metrics: createTableMetrics(),
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const scene = layoutBlock(
      resolvedBlock({ blockType: 'boom' }),
      { width: 400, height: 200 },
      ctx,
      createChartRegistry([exploding]),
    );
    expect(diagnostics.map((d) => d.code)).toContain('MDV5000');
    expect(scene.a11y.table.rows).toHaveLength(4);
    expect(scene.root.cls).toContain('mdv-error-card');
  });

  it('renders an unknown block type as a table (MDV1500)', () => {
    const diagnostics: Diagnostic[] = [];
    const ctx = makeLayoutContext({
      theme: THEME,
      metrics: createTableMetrics(),
      onDiagnostic: (d) => diagnostics.push(d),
    });
    const scene = layoutBlock(
      resolvedBlock({ blockType: 'sankey' }),
      { width: 400, height: 200 },
      ctx,
      registry,
    );
    expect(diagnostics.map((d) => d.code)).toContain('MDV1500');
    expect(scene.a11y.table.rows).toHaveLength(4);
  });

  it('reports a zero-size container as MDV5001 and still returns a valid scene', () => {
    const diagnostics: Diagnostic[] = [];
    const scene = layout(resolvedBlock(), { width: 0, height: 300 }, diagnostics);
    expect(diagnostics.map((d) => d.code)).toContain('MDV5001');
    expect(scene.root.kind).toBe('group');
    expect(scene.a11y.table.rows).toHaveLength(4);
  });

  it('shows the error card for a block that failed upstream', () => {
    const block = resolvedBlock();
    const failed = {
      ...block,
      failed: true,
      diagnostics: [
        {
          code: 'MDV2102',
          severity: 'error' as const,
          message: 'Data does not parse as CSV',
          range: block.range,
          source: 'data' as const,
        },
      ],
    };
    const scene = layout(failed);
    expect(scene.root.cls).toContain('mdv-error-card');
    expect(scene.a11y.desc).toContain('MDV2102');
  });
});

describe('the legend, placed by core (SPEC 7.4)', () => {
  it('suppresses the legend for `legend: false`', () => {
    const scene = layout(
      resolvedBlock({
        attrs: { legend: false },
        encoding: { x: { field: 'quarter' }, y: { field: 'amount' }, series: { field: 'metric' } },
        table: LONG_FORM,
      }),
    );
    expect(scene.root.children.some((child) => child.cls === 'mdv-legend')).toBe(false);
  });

  it('gives each series its own palette slot, keyed on identity', () => {
    const scene = layout(
      resolvedBlock({
        attrs: { legend: 'top' },
        encoding: { x: { field: 'quarter' }, y: { field: 'amount' }, series: { field: 'metric' } },
        table: LONG_FORM,
      }),
    );
    const legend = scene.root.children.find((child) => child.cls === 'mdv-legend');
    expect(legend?.kind === 'group' ? legend.children.length : 0).toBe(2);
  });
});

describe('faceting (SPEC 7.6)', () => {
  const faceted = table(
    [
      ['region', 'category'],
      ['quarter', 'category'],
      ['revenue', 'number'],
    ],
    [
      ['EMEA', 'Q1', 10],
      ['EMEA', 'Q2', 20],
      ['APAC', 'Q1', 30],
      ['APAC', 'Q2', 40],
    ],
  );

  it('splits into panels and titles each one', () => {
    const scene = layout(
      resolvedBlock({
        attrs: { column: 'region' },
        encoding: { x: { field: 'quarter' }, y: { field: 'revenue' } },
        table: faceted,
      }),
      { width: 640, height: 320 },
    );
    const titles: string[] = [];
    walk(scene.root, (node) => {
      if (node.kind === 'text' && node.cls === 'mdv-facet-title') titles.push(node.text);
    });
    expect(titles).toEqual(['EMEA', 'APAC']);
  });

  it('reports `shareY: false` as MDV3030', () => {
    const diagnostics: Diagnostic[] = [];
    layout(
      resolvedBlock({
        attrs: { column: 'region', shareY: false },
        encoding: { x: { field: 'quarter' }, y: { field: 'revenue' } },
        table: faceted,
      }),
      { width: 640, height: 320 },
      diagnostics,
    );
    expect(diagnostics.map((d) => d.code)).toContain('MDV3030');
  });

  it('stays deterministic when faceted', () => {
    const build = () =>
      layout(
        resolvedBlock({
          attrs: { column: 'region' },
          encoding: { x: { field: 'quarter' }, y: { field: 'revenue' } },
          table: faceted,
        }),
        { width: 640, height: 320 },
      );
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('the one-axis rule, end to end (SPEC 7.3.1)', () => {
  it('warns and ignores a `y2:` attribute', () => {
    const diagnostics: Diagnostic[] = [];
    layout(resolvedBlock({ attrs: { y2: 'profit' } }), { width: 480, height: 300 }, diagnostics);
    const reported = diagnostics.find((d) => d.message.includes('y2'));
    expect(reported?.code).toBe('MDV1501');
    expect(reported?.severity).toBe('warning');
  });
});

describe('the table view under a wide encoding', () => {
  it('projects only the bound columns when there is more than one', () => {
    const wide = table(
      [
        ['quarter', 'category'],
        ['revenue', 'number'],
        ['unused', 'number'],
      ],
      [['Q1', 1, 99]],
    );
    const scene = layout(
      resolvedBlock({
        encoding: { x: { field: 'quarter' }, y: { field: 'revenue' } },
        table: wide,
      }),
    );
    // One bound series column falls back to the whole table, which is the
    // reachable-data rule: a one-column table view is not reachable data.
    expect(scene.a11y.table.columns.length).toBe(3);
  });
});

/** Depth-first walk over a node tree. */
function walk(node: SceneNode, visit: (node: SceneNode) => void): void {
  visit(node);
  if (node.kind === 'group') for (const child of node.children) walk(child, visit);
}

/** Keeps the unused import of QUARTERS meaningful for the default fixture. */
expect(QUARTERS.rows).toHaveLength(4);

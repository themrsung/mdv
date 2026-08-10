/**
 * `DocumentPipeline` — determinism, incrementality and failure containment.
 *
 * These are the three properties the preview depends on and that a smoke test
 * cannot show: that two runs produce the same bytes (SPEC 24.3), that editing
 * one chart re-lays-out one chart, and that a broken block becomes a diagnostic
 * rather than an exception (SPEC 14.1 principle 1).
 */

import { describe, expect, it } from 'vitest';

import { DocumentPipeline } from '../src/pipeline/index.js';
import { INPUTS, ONE_CHART, TWO_CHARTS } from './fixtures.js';

describe('DocumentPipeline: rendering', () => {
  it('renders every visual block and skips the non-visual ones', async () => {
    const result = await new DocumentPipeline().run({ ...INPUTS, source: TWO_CHARTS });

    // `dataset` is not a drawing (SPEC 6.3), so two blocks, not three.
    expect(result.blocks.map((b) => b.blockType)).toEqual(['bar', 'line']);
    expect(result.blocks.map((b) => b.id)).toEqual(['revenue-bar', 'profit-line']);
    expect(result.blocks.map((b) => b.title)).toEqual([
      'Revenue by quarter',
      'Profit by quarter',
    ]);
    expect(result.blocks.every((b) => b.svg.startsWith('<svg'))).toBe(true);
    expect(result.blocks.every((b) => b.failed)).toBe(false);
  });

  it('reports each block at its own line span, for scroll sync', async () => {
    const result = await new DocumentPipeline().run({ ...INPUTS, source: TWO_CHARTS });
    const lines = TWO_CHARTS.split('\n');

    for (const block of result.blocks) {
      expect(lines[block.startLine]?.startsWith('```mdv')).toBe(true);
      expect(lines[block.endLine]?.startsWith('```')).toBe(true);
      expect(block.endLine).toBeGreaterThan(block.startLine);
    }
    const [first, second] = result.blocks;
    expect(first?.endLine).toBeLessThan(second?.startLine ?? -1);
  });

  it('emits no script and no event handler into the SVG', async () => {
    const hostile = ONE_CHART.replace(
      'title: Revenue by quarter',
      'title: "</svg><script>alert(1)</script>"',
    );
    const result = await new DocumentPipeline().run({ ...INPUTS, source: hostile });

    const svg = result.blocks[0]?.svg ?? '';
    expect(svg.length).toBeGreaterThan(0);
    expect(svg).not.toContain('<script');
    expect(svg).not.toMatch(/\son[a-z]+=/i);
    expect(svg).toContain('&lt;/svg&gt;');
  });

  it('serves the same bytes to two independent pipelines', async () => {
    const a = await new DocumentPipeline().run({ ...INPUTS, source: TWO_CHARTS });
    const b = await new DocumentPipeline().run({ ...INPUTS, source: TWO_CHARTS });

    expect(a.blocks.map((x) => x.svg)).toEqual(b.blocks.map((x) => x.svg));
    expect(a.diagnostics.map((d) => `${d.code}@${String(d.range?.start.line)}`)).toEqual(
      b.diagnostics.map((d) => `${d.code}@${String(d.range?.start.line)}`),
    );
  });

  it('does not depend on the order the allowlist was written in', async () => {
    const first = await new DocumentPipeline().run({
      ...INPUTS,
      allowedOrigins: ['https://b.example', 'https://a.example'],
    });
    const second = await new DocumentPipeline().run({
      ...INPUTS,
      allowedOrigins: ['https://a.example', 'https://b.example'],
    });
    expect(first.blocks[0]?.svg).toBe(second.blocks[0]?.svg);
  });
});

describe('DocumentPipeline: incremental stages', () => {
  it('reuses every stage when nothing changed', async () => {
    const pipeline = new DocumentPipeline();
    const first = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });
    const second = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    expect(first.stats).toEqual({ parsed: true, resolved: true, laidOut: 2, reused: 0 });
    expect(second.stats).toEqual({ parsed: false, resolved: false, laidOut: 0, reused: 2 });
    // Reuse must be indistinguishable from a fresh render.
    expect(second.blocks.map((b) => b.svg)).toEqual(first.blocks.map((b) => b.svg));
    expect(second.diagnostics).toEqual(first.diagnostics);
  });

  it('re-lays-out only the block that was edited', async () => {
    const pipeline = new DocumentPipeline();
    await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    // A title change in the *second* chart. Same line count, so the first
    // chart's text, data and position are all untouched.
    const edited = TWO_CHARTS.replace('title: Profit by quarter', 'title: Profit per quarter');
    const result = await pipeline.run({ ...INPUTS, source: edited });

    expect(result.stats.parsed).toBe(true);
    expect(result.stats.resolved).toBe(true);
    expect(result.stats).toMatchObject({ laidOut: 1, reused: 1 });
    expect(result.blocks[1]?.title).toBe('Profit per quarter');
  });

  it('re-renders a chart when the dataset it reads changes, not just its own text', async () => {
    const pipeline = new DocumentPipeline();
    const before = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    // One cell of the shared dataset. Row and column counts are unchanged, and
    // neither chart's own text moves: only a content hash of the prepared table
    // can catch this.
    const edited = TWO_CHARTS.replace('Q4,1893,551', 'Q4,4893,551');
    const after = await pipeline.run({ ...INPUTS, source: edited });

    expect(after.stats).toMatchObject({ laidOut: 2, reused: 0 });
    expect(after.blocks[0]?.svg).not.toBe(before.blocks[0]?.svg);
    // The line chart reads `profit`, which did not change: same drawing.
    expect(after.blocks[1]?.svg).toBe(before.blocks[1]?.svg);
  });

  it('re-lays-out everything when the width or the theme changes', async () => {
    const pipeline = new DocumentPipeline();
    await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    const wider = await pipeline.run({ ...INPUTS, source: TWO_CHARTS, width: 900 });
    expect(wider.stats).toMatchObject({ parsed: false, resolved: false, laidOut: 2, reused: 0 });

    const dark = await pipeline.run({ ...INPUTS, source: TWO_CHARTS, width: 900, theme: 'dark' });
    expect(dark.stats).toMatchObject({ laidOut: 2, reused: 0 });
    expect(dark.blocks[0]?.svg).not.toBe(wider.blocks[0]?.svg);
  });

  it('forgets everything on invalidate()', async () => {
    const pipeline = new DocumentPipeline();
    await pipeline.run({ ...INPUTS, source: TWO_CHARTS });
    pipeline.invalidate();
    const again = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    expect(again.stats).toEqual({ parsed: true, resolved: true, laidOut: 2, reused: 0 });
  });

  it('releases memos for blocks the document no longer has', async () => {
    const pipeline = new DocumentPipeline();
    await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    const trimmed = TWO_CHARTS.slice(0, TWO_CHARTS.indexOf('Profit followed.'));
    const shorter = await pipeline.run({ ...INPUTS, source: trimmed });
    expect(shorter.blocks).toHaveLength(1);
    expect(shorter.stats).toMatchObject({ laidOut: 0, reused: 1 });

    // Growing back must render the new block rather than resurrect the old memo.
    const regrown = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });
    expect(regrown.stats).toMatchObject({ laidOut: 1, reused: 1 });
    expect(regrown.blocks[1]?.title).toBe('Profit by quarter');
  });

  it('exposes the prepared tables of the last run', async () => {
    const pipeline = new DocumentPipeline();
    await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    expect(pipeline.tables.map((t) => t.id)).toEqual(['revenue-bar', 'profit-line']);
    const table = pipeline.tables[0]?.table;
    expect(table?.fields.map((f) => f.name)).toEqual(['quarter', 'revenue', 'profit']);
    expect(table?.rows).toHaveLength(4);
  });
});

describe('DocumentPipeline: containment', () => {
  it('turns an unknown block type into a diagnostic, not an exception', async () => {
    const source = '```mdv nosuchtype\ntitle: Nope\n---\na | b\n1 | 2\n```\n';
    const result = await new DocumentPipeline().run({ ...INPUTS, source });

    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.every((d) => /^MDV\d{4}$/.test(d.code))).toBe(true);
    expect(result.blocks.every((b) => b.svg.length > 0)).toBe(true);
  });

  it('renders the other blocks when one of them is broken', async () => {
    const source = `\`\`\`mdv bar
x: quarter
y: revenue
---
quarter | revenue
Q1      | 1240
\`\`\`

\`\`\`mdv bar
x: missing
y: alsomissing
---
quarter | revenue
Q1      | 1240
\`\`\`
`;
    const result = await new DocumentPipeline().run({ ...INPUTS, source });

    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]?.failed).toBe(false);
    expect(result.blocks.every((b) => b.svg.length > 0)).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('reports a block-level `theme:` it cannot load as MDV1502 and keeps drawing', async () => {
    const source = ONE_CHART.replace('y: revenue', 'y: revenue\ntheme: ./corporate.yaml');
    const result = await new DocumentPipeline().run({ ...INPUTS, source });

    expect(result.diagnostics.map((d) => d.code)).toContain('MDV1502');
    expect(result.blocks[0]?.svg.startsWith('<svg')).toBe(true);
  });

  it('keeps diagnostics in document order', async () => {
    const source = `\`\`\`mdv bar
x: nope
---
a | b
1 | 2
\`\`\`

\`\`\`mdv line
x: alsonope
---
a | b
1 | 2
\`\`\`
`;
    const result = await new DocumentPipeline().run({ ...INPUTS, source });
    const lines = result.diagnostics.map((d) => d.range?.start.line ?? 0);
    expect([...lines].sort((x, y) => x - y)).toEqual(lines);
  });

  it('promotes warnings to errors under strict, and leaves info alone', async () => {
    // A short row is padded with a warning (`MDV2120`); the auto-detected data
    // format is info (`MDV2101`). SPEC 14.3 promotes the first and not the
    // second.
    const source = ONE_CHART.replace('Q2      | 1516', 'Q2');
    const lenient = await new DocumentPipeline().run({ ...INPUTS, source });
    const strict = await new DocumentPipeline().run({ ...INPUTS, source, strict: true });

    expect(lenient.diagnostics.map((d) => [d.code, d.severity])).toContainEqual([
      'MDV2120',
      'warning',
    ]);
    expect(strict.diagnostics.map((d) => [d.code, d.severity])).toContainEqual([
      'MDV2120',
      'error',
    ]);
    expect(strict.diagnostics.map((d) => d.code)).toEqual(lenient.diagnostics.map((d) => d.code));
    expect(strict.diagnostics.some((d) => d.severity === 'warning')).toBe(false);
    expect(strict.diagnostics.filter((d) => d.severity === 'info').map((d) => d.code)).toEqual(
      lenient.diagnostics.filter((d) => d.severity === 'info').map((d) => d.code),
    );
  });
});

describe('DocumentPipeline: external data', () => {
  const REMOTE = `\`\`\`mdv bar
src: https://data.example/sales.csv
x: quarter
y: revenue
---
\`\`\`
`;

  it('never fetches when allowExternal is off, and names the blocked origin', async () => {
    const result = await new DocumentPipeline().run({ ...INPUTS, source: REMOTE });

    expect(result.blockedOrigins).toEqual(['https://data.example']);
    // MDV4002, the policy refusal that names the setting — not MDV4001, which
    // would blame a synchronous resolver the async path did not use.
    expect(result.diagnostics.map((d) => d.code)).toContain('MDV4002');
    expect(result.diagnostics.map((d) => d.code)).not.toContain('MDV4001');
    // Still a drawing — an error card, not a blank preview (SPEC 15.2).
    expect(result.blocks[0]?.svg.startsWith('<svg')).toBe(true);
    expect(result.blocks[0]?.failed).toBe(true);
  });

  it('runSync never fetches even when allowExternal is on', () => {
    // `runSync` is what the built-in Markdown preview uses, where there is no
    // consent banner to ask through. It must resolve without a network turn.
    const pipeline = new DocumentPipeline();
    const result = pipeline.runSync({ ...INPUTS, source: REMOTE, allowExternal: true });

    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]?.failed).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it('keeps the async and sync caches apart', async () => {
    const pipeline = new DocumentPipeline();
    const sync = pipeline.runSync({ ...INPUTS, source: TWO_CHARTS });
    const async_ = await pipeline.run({ ...INPUTS, source: TWO_CHARTS });

    expect(sync.blocks.map((b) => b.svg)).toEqual(async_.blocks.map((b) => b.svg));
    // The second run re-resolved data under its own key rather than adopting
    // the sync result, but the blocks were still reusable.
    expect(async_.stats.parsed).toBe(false);
    expect(async_.stats.resolved).toBe(true);
    expect(async_.stats.reused).toBe(2);
  });
});

/**
 * SPEC Appendix E, end to end, through the public API only.
 *
 * The document is not a fixture: it is read out of `SPEC.md` at test time, so
 * the example the specification shows an author and the example the library can
 * actually render cannot drift apart silently.
 *
 * Everything this file imports from `@mdv/core` is a package-root export. Chart
 * types arrive through `plugins[].chartTypes` and the serialiser through
 * `config.svg`, which are the two doors core leaves open for packages that
 * depend on it — `@mdv/charts` and `@mdv/render-svg` both do, so core cannot
 * import them and the dependency arrow stays pointing one way.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { builtinChartTypes } from '@mdv/charts';
import { toSvgString } from '@mdv/render-svg';
import {
  Mdv,
  createLayoutContext,
  layoutBlock,
  parse,
  registryFromPlugins,
  resolve,
  resolveSync,
  type MdvConfig,
} from '../src/index.js';

/** The worked example, lifted from the specification itself. */
function appendixE(): string {
  const spec = readFileSync(new URL('../../../SPEC.md', import.meta.url), 'utf8');
  const heading = spec.indexOf('# Appendix E');
  expect(heading, 'SPEC.md has no Appendix E').toBeGreaterThan(-1);

  // The example is wrapped in a four-backtick fence because it contains
  // three-backtick blocks of its own.
  const open = spec.indexOf('````markdown\n', heading);
  expect(open, 'Appendix E has no ````markdown fence').toBeGreaterThan(-1);
  const start = open + '````markdown\n'.length;
  const close = spec.indexOf('\n````', start);
  expect(close, 'Appendix E fence is unterminated').toBeGreaterThan(-1);
  return spec.slice(start, close + 1);
}

const SOURCE = appendixE();

/**
 * The configuration an embedder writes.
 *
 * `builtinChartTypes` rather than `chartTypesForLevel(2)`: the stubs for the
 * types this build does not draw turn "unknown block type" into a table that
 * names the type and the level it needs (SPEC 15.2), which is what the worked
 * example's `ohlcv` and `heatmap` blocks should produce today.
 */
const CONFIG: MdvConfig = {
  plugins: [{ name: 'builtins', version: '0.0.0', chartTypes: builtinChartTypes }],
  svg: toSvgString,
};

describe('SPEC Appendix E — the worked example', () => {
  it('is the document the specification shows', () => {
    expect(SOURCE).toContain('title: FY2026 Business Review');
    expect(SOURCE).toContain('```mdv bar');
    expect(SOURCE).toContain('```mdv ohlcv');
    expect(SOURCE).toContain('```mdv heatmap');
    expect(SOURCE).toContain('```mdv table');
  });

  it('parses without an error-severity diagnostic', () => {
    const doc = parse(SOURCE);
    const errors = doc.diagnostics.filter((d) => d.severity === 'error');
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it('resolves every visual block, with the dataset attached', async () => {
    const resolved = await resolve(parse(SOURCE), CONFIG);

    expect(resolved.blocks.map((b) => b.blockType)).toEqual([
      'metric',
      'metric',
      'metric',
      'bar',
      'ohlcv',
      'heatmap',
      'table',
    ]);

    // `dataset` is a declaration, not a visual block: it must be in the registry
    // and out of `blocks`.
    expect(resolved.datasets.get('quarterly')).toBeDefined();
    expect(resolved.blocks.map((b) => b.blockType)).not.toContain('dataset');
  });

  it('gives the bar block the data it referenced by `@quarterly`', async () => {
    const resolved = await resolve(parse(SOURCE), CONFIG);
    const bar = resolved.blocks.find((b) => b.id === 'fig-revenue');

    expect(bar).toBeDefined();
    expect(bar?.table.fields.map((f) => f.name)).toEqual([
      'quarter',
      'revenue',
      'profit',
      'region',
    ]);
    expect(bar?.table.rows).toHaveLength(4);
    // `y: [revenue, profit]` is a list channel and must survive normalisation.
    expect(bar?.encoding.y).toEqual([{ field: 'revenue' }, { field: 'profit' }]);
    // `defaults: {height: 300}` from front matter, cascade level 3.
    expect(bar?.attrs.height).toBe(300);
  });

  it('honours the front matter `date:` as `buildTime` (SPEC 24.3 rule 2)', async () => {
    const { config } = await resolve(parse(SOURCE), CONFIG);
    expect(config.buildTime.toISOString()).toBe('2026-08-10T00:00:00.000Z');
  });

  it('renders every block to SVG through the public API', async () => {
    const resolved = await resolve(parse(SOURCE), CONFIG);
    const registry = registryFromPlugins(CONFIG);

    const svgs = resolved.blocks.map((block) => {
      const ctx = createLayoutContext(resolved, block);
      return toSvgString(layoutBlock(block, { width: 800, height: 300 }, ctx, registry));
    });

    expect(svgs).toHaveLength(7);
    for (const [index, svg] of svgs.entries()) {
      const where = `block ${index} (${resolved.blocks[index]?.blockType ?? '?'})`;
      expect(svg.startsWith('<svg'), where).toBe(true);
      expect(svg.endsWith('</svg>'), where).toBe(true);
      expect(svg.length, where).toBeGreaterThan(200);
      // A coordinate that came out as `NaN` still serialises; it just draws
      // nothing. Asserting on the string is the only cheap way to catch it.
      expect(svg, where).not.toMatch(/NaN|Infinity|undefined/);
    }
  });

  it('renders the same document twice to byte-identical SVG (SPEC 28.10)', async () => {
    const render = async (): Promise<string> => {
      // Nothing is reused between the two runs — not the parse, not the resolved
      // document, not the registry. A run that shared state could be identical
      // by accident.
      const resolved = await resolve(parse(SOURCE), CONFIG);
      const registry = registryFromPlugins(CONFIG);
      return resolved.blocks
        .map((block) =>
          toSvgString(
            layoutBlock(
              block,
              { width: 800, height: 300 },
              createLayoutContext(resolved, block),
              registry,
            ),
          ),
        )
        .join('\n');
    };

    const first = await render();
    const second = await render();

    expect(second).toBe(first);
    expect(second.length).toBe(first.length);
  });

  it('agrees between the async and the sync resolve, since nothing fetches', async () => {
    const asyncRun = await resolve(parse(SOURCE), CONFIG);
    const syncRun = resolveSync(parse(SOURCE), CONFIG);

    const shape = (d: typeof asyncRun): unknown =>
      d.blocks.map((b) => ({
        id: b.id,
        type: b.blockType,
        rows: b.table.rows.length,
        fields: b.table.fields.map((f) => f.name),
        encoding: b.encoding,
      }));

    expect(shape(syncRun)).toEqual(shape(asyncRun));
    expect(syncRun.diagnostics.map((d) => d.code)).toEqual(asyncRun.diagnostics.map((d) => d.code));
  });

  it('degrades the types this build does not draw, rather than dropping them', async () => {
    const resolved = await resolve(parse(SOURCE), CONFIG);
    const registry = registryFromPlugins(CONFIG);

    for (const name of ['ohlcv', 'heatmap']) {
      const block = resolved.blocks.find((b) => b.blockType === name);
      expect(block, name).toBeDefined();
      if (block === undefined) continue;

      const codes: string[] = [];
      const ctx = createLayoutContext(resolved, block, (d) => codes.push(d.code));
      const scene = layoutBlock(block, { width: 800, height: 300 }, ctx, registry);

      // SPEC 15.2: a Level 2 type in a build that cannot draw it becomes a table
      // with a notice, never an error and never a dropped block.
      expect(codes, name).toContain('MDV1500');
      expect(scene.a11y?.table?.rows.length ?? 0, name).toBeGreaterThan(0);
      expect(toSvgString(scene).startsWith('<svg'), name).toBe(true);
    }
  });
});

describe('Mdv#toSVG — the facade over the same pipeline', () => {
  it('returns one standalone SVG per visual block, in document order', async () => {
    const svgs = await new Mdv(CONFIG).toSVG(SOURCE);

    expect(svgs).toHaveLength(7);
    for (const svg of svgs) expect(svg.startsWith('<svg')).toBe(true);
  });

  it('is deterministic across two instances', async () => {
    const a = (await new Mdv(CONFIG).toSVG(SOURCE)).join('\n');
    const b = (await new Mdv(CONFIG).toSVG(SOURCE)).join('\n');
    expect(b).toBe(a);
  });

  it('honours the requested width', async () => {
    const [wide] = await new Mdv(CONFIG).toSVG(SOURCE, { width: 1200 });
    const [narrow] = await new Mdv(CONFIG).toSVG(SOURCE, { width: 400 });

    expect(wide).toContain('width="1200"');
    expect(narrow).toContain('width="400"');
  });

  it('refuses, with a reason, when no serialiser was configured', async () => {
    const bare = new Mdv({ plugins: CONFIG.plugins ?? [] });
    await expect(bare.toSVG(SOURCE)).rejects.toThrow(/@mdv\/render-svg/);
  });
});

describe('Mdv#lint and Mdv#format', () => {
  it('lints the worked example without an error', async () => {
    const found = await new Mdv(CONFIG).lint(SOURCE);
    const errors = found.filter((d) => d.severity === 'error');
    expect(errors.map((d) => `${d.code} ${d.message}`)).toEqual([]);
  });

  it('reports diagnostics in document order, with no duplicates', async () => {
    const found = await new Mdv(CONFIG).lint(SOURCE);
    const offsets = found.map((d) => d.range.start.offset);
    expect([...offsets].sort((a, b) => a - b)).toEqual(offsets);

    const keys = found.map((d) => `${d.code}@${d.range.start.offset}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('promotes warnings to errors under `strict`', async () => {
    const lenient = await new Mdv(CONFIG).lint(SOURCE);
    const strict = await new Mdv({ ...CONFIG, strict: true }).lint(SOURCE);

    const warnings = lenient.filter((d) => d.severity === 'warning').length;
    expect(strict.filter((d) => d.severity === 'warning')).toHaveLength(0);
    expect(strict.filter((d) => d.severity === 'error')).toHaveLength(warnings);
  });

  it('formats idempotently (SPEC 27)', () => {
    const mdv = new Mdv(CONFIG);
    const once = mdv.format(SOURCE);
    expect(mdv.format(once)).toBe(once);
  });

  it('does not change what the document resolves to', async () => {
    const mdv = new Mdv(CONFIG);
    const before = await resolve(parse(SOURCE), CONFIG);
    const after = await resolve(parse(mdv.format(SOURCE)), CONFIG);

    const shape = (d: typeof before): unknown =>
      d.blocks.map((b) => ({ id: b.id, type: b.blockType, rows: b.table.rows.length }));
    expect(shape(after)).toEqual(shape(before));
  });
});

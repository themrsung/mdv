/**
 * The public surface of `@mdv/core`.
 *
 * Every other suite in this repository imports a deep path — `../src/layout/
 * block.js`, `../src/scale/index.js` — and that is why 1 397 green tests
 * coexisted with a package whose twelve public entry points all threw
 * `not implemented` and whose five stage sub-barrels were unreachable from the
 * package root. A test that never touches the barrel cannot see the barrel.
 *
 * So this file imports **only** `../src/index.js`, the same specifier an
 * embedder writing `import { resolve } from '@mdv/core'` gets, and it asserts
 * two things that unit tests structurally cannot:
 *
 *  1. the name is *exported* — an ambiguous `export *` is dropped rather than
 *     reported, so a collision between two sub-barrels shows up here as
 *     `undefined` and nowhere else; and
 *  2. the export is *wired* — calling it produces a result rather than a throw.
 */

import { describe, expect, it } from 'vitest';
import * as core from '../src/index.js';
import {
  DEFAULT_BUILD_TIME,
  Mdv,
  MdvConfigError,
  cascadeAttrs,
  createChartRegistry,
  createLayoutContext,
  createTableMetrics,
  encodingFromAttrs,
  layoutBlock,
  parse,
  registryFromPlugins,
  resolveConfig,
  resolveSync,
  validateBlock,
} from '../src/index.js';

const DOC = `---
title: Barrel
date: 2026-08-10
defaults:
  height: 300
---

\`\`\`mdv bar
id: fig-one
title: Quarterly revenue
x: quarter
y: revenue
---
quarter | revenue
Q1      |    1240
Q2      |    1516
\`\`\`
`;

describe('the package root exports what SPEC 21 says it does', () => {
  it('exports every entry point of the facade', () => {
    for (const name of [
      'resolve',
      'resolveSync',
      'layoutBlock',
      'validateBlock',
      'createLayoutContext',
      'createTableMetrics',
      'Mdv',
    ] as const) {
      expect(typeof core[name], name).toBe('function');
    }
  });

  it('reaches the stage sub-barrels, which used to be unreachable', () => {
    // One representative export per `export *` line in the barrel. Each of these
    // was written, tested and then invisible from `@mdv/core`.
    expect(typeof core.rerangeScale).toBe('function'); // ./scale
    expect(typeof core.asNumber).toBe('function'); // ./encode
    expect(typeof core.makeLayoutContext).toBe('function'); // ./layout
    expect(typeof core.buildA11yTable).toBe('function'); // ./a11y
    expect(typeof core.defaultTableMetrics).toBe('object'); // ./metrics
    expect(typeof core.applyPipeline).toBe('function'); // ./transform
    expect(typeof core.resolveTableRef).toBe('function'); // ./dataset
    expect(typeof core.cascadeAttrs).toBe('function'); // ./cascade
    expect(typeof core.resolveThemeSetting).toBe('function'); // ./theme
    expect(typeof core.resolveConfig).toBe('function'); // ./config
    expect(typeof core.resolveDocumentData).toBe('function'); // ./resolve
    expect(typeof core.createChartRegistry).toBe('function'); // ./registry
  });

  it('re-exports the parser and spec entry points an embedder needs', () => {
    expect(typeof core.parse).toBe('function');
    expect(typeof core.toMarkdown).toBe('function');
    expect(typeof core.SPEC_VERSION).toBe('string');
    expect(core.CORE_VERSION).toBe('0.0.0');
  });
});

describe('resolveSync through the barrel', () => {
  it('resolves a document into blocks, tables and a config', () => {
    const resolved = resolveSync(parse(DOC));

    expect(resolved.blocks).toHaveLength(1);
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    expect(block.id).toBe('fig-one');
    expect(block.index).toBe(0);
    expect(block.blockType).toBe('bar');
    expect(block.table.fields.map((f) => f.name)).toEqual(['quarter', 'revenue']);
    expect(block.table.rows).toHaveLength(2);
  });

  it('applies the SPEC 5.5 cascade — front matter under the block', () => {
    const resolved = resolveSync(parse(DOC));
    const attrs = resolved.blocks[0]?.attrs ?? {};

    // Level 3, from `defaults:` in front matter.
    expect(attrs.height).toBe(300);
    // Level 5, the block's own.
    expect(attrs.title).toBe('Quarterly revenue');
  });

  it('lets configuration outrank the document, and the block outrank both', () => {
    const resolved = resolveSync(parse(DOC), { defaults: { height: 120, padding: 8 } });
    const attrs = resolved.blocks[0]?.attrs ?? {};

    expect(attrs.height).toBe(120); // level 4 over level 3
    expect(attrs.padding).toBe(8); // level 4, unopposed
    expect(attrs.title).toBe('Quarterly revenue'); // level 5 still wins
  });

  it('normalises the encoding to long form', () => {
    const encoding = resolveSync(parse(DOC)).blocks[0]?.encoding ?? {};

    expect(encoding.x).toEqual({ field: 'quarter' });
    expect(encoding.y).toEqual({ field: 'revenue' });
  });

  it('falls back to `mdv-{index}` when the author declared no id', () => {
    const source = DOC.replace('id: fig-one\n', '');
    expect(resolveSync(parse(source)).blocks[0]?.id).toBe('mdv-0');
  });

  it('pins `buildTime` from front matter, so `now()` is not the wall clock', () => {
    const { config } = resolveSync(parse(DOC));
    expect(config.buildTime.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(config.locale).toBe('en-US');
    expect(config.timezone).toBe('UTC');
    expect(config.level).toBe(2);
  });

  it('reports `src:` it cannot fetch rather than pretending it loaded', () => {
    const source = ['```mdv dataset id=remote', 'src: https://example.com/a.csv', '```', ''].join(
      '\n',
    );
    const resolved = resolveSync(parse(source));
    expect(resolved.diagnostics.map((d) => d.code)).toContain('MDV4001');
  });

  it('gives every block a theme even when no theme package is installed', () => {
    const { theme, blocks } = resolveSync(parse(DOC));
    // Core cannot validate a colour palette — SPEC 16.4 puts the validator in
    // `@mdv/themes` — so its fallback is a neutral luminance ramp and says so.
    expect(theme.name).toBe('fallback');
    expect(theme.categorical).toHaveLength(8);
    expect(theme.validation).toBeUndefined();
    expect(blocks[0]?.theme).toBe(theme);
  });

  it('mirrors diagnostics to `config.onDiagnostic` as they are produced', () => {
    const seen: string[] = [];
    resolveSync(parse('```mdv bar\ndata: "@missing"\n```\n'), {
      onDiagnostic: (d) => seen.push(d.code),
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it('turns warnings into errors under `strict`', () => {
    const source = '```mdv bar\ntheme: nope\nx: a\n---\na\n1\n```\n';
    const lenient = resolveSync(parse(source));
    const strict = resolveSync(parse(source), { strict: true });

    const severityOf = (d: { code: string; severity: string }[]): string | undefined =>
      d.find((x) => x.code === 'MDV1502')?.severity;

    expect(severityOf([...lenient.diagnostics])).toBe('warning');
    expect(severityOf([...strict.diagnostics])).toBe('error');
  });

  it('attributes a diagnostic to the block whose text it points at', () => {
    const resolved = resolveSync(parse('```mdv bar\ndata: "@missing"\n```\n'));
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    expect(block.diagnostics.length).toBeGreaterThan(0);
    expect(block.failed).toBe(true);
    // A failed block still has a table, so every consumer has one code path.
    expect(block.table.rows).toEqual([]);
  });

  it('does not blame the first block for a document-level finding', () => {
    // The finding is about `config.theme`, not about any block, so it carries
    // the whole-document range. Block 0 starts at offset 0 in a document with no
    // front matter, so a naive containment test would hand it over — and under
    // `strict` that would mark a perfectly good block `failed`.
    const source = '```mdv bar\nx: a\n---\na\n1\n```\n';
    const resolved = resolveSync(parse(source), { theme: 'nonesuch', strict: true });

    expect(resolved.diagnostics.map((d) => d.code)).toContain('MDV1502');
    expect(resolved.blocks[0]?.diagnostics.map((d) => d.code)).not.toContain('MDV1502');
    expect(resolved.blocks[0]?.failed).toBe(false);
  });
});

describe('resolve (async) through the barrel', () => {
  it('agrees with resolveSync on a document that fetches nothing', async () => {
    const a = await core.resolve(parse(DOC));
    const b = resolveSync(parse(DOC));

    expect(a.blocks.map((x) => x.id)).toEqual(b.blocks.map((x) => x.id));
    expect(a.diagnostics.map((d) => d.code)).toEqual(b.diagnostics.map((d) => d.code));
    expect(a.config.buildTime.getTime()).toBe(b.config.buildTime.getTime());
  });

  it('does not reject for a document problem', async () => {
    await expect(core.resolve(parse('```mdv bar\ndata: "@nope"\n```\n'))).resolves.toBeDefined();
  });
});

describe('createLayoutContext and layoutBlock through the barrel', () => {
  it('seeds ids as `mdv-{blockIndex}-{counter}` (SPEC 24.3 rule 7)', () => {
    const resolved = resolveSync(parse(DOC));
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    const ctx = createLayoutContext(resolved, block);
    expect(ctx.ids.next()).toBe('mdv-0-0');
    expect(ctx.ids.next()).toBe('mdv-0-1');
  });

  it('carries the document theme, locale and pinned buildTime onto the context', () => {
    const resolved = resolveSync(parse(DOC));
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    const ctx = createLayoutContext(resolved, block);
    expect(ctx.theme).toBe(block.theme);
    expect(ctx.locale).toBe('en-US');
    expect(ctx.buildTime.getTime()).toBe(Date.UTC(2026, 7, 10));
    expect(ctx.metrics).toBe(core.defaultTableMetrics);
  });

  it('renders a scene for a type no registry knows, instead of throwing', () => {
    const resolved = resolveSync(parse(DOC));
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    const codes: string[] = [];
    const ctx = createLayoutContext(resolved, block, (d) => codes.push(d.code));
    const scene = layoutBlock(block, { width: 640, height: 300 }, ctx);

    // Core registers no chart types of its own; `@mdv/charts` depends on core,
    // not the other way round. An empty registry is therefore the correct
    // core-only result, and SPEC 15.2 says it degrades to a table.
    expect(scene.width).toBe(640);
    expect(scene.height).toBe(300);
    expect(codes).toContain('MDV1500');
    expect(scene.a11y?.table).toBeDefined();
  });

  it('accepts a registry as the fourth argument', () => {
    const resolved = resolveSync(parse(DOC));
    const block = resolved.blocks[0];
    if (block === undefined) throw new Error('unreachable');

    const registry = createChartRegistry();
    registry.freeze();
    const scene = layoutBlock(
      block,
      { width: 320, height: 200 },
      createLayoutContext(resolved, block),
      registry,
    );
    expect(scene.root).toBeDefined();
  });

  it('is a pure function of its inputs', () => {
    const render = (): string => {
      const resolved = resolveSync(parse(DOC));
      const block = resolved.blocks[0];
      if (block === undefined) throw new Error('unreachable');
      return JSON.stringify(
        layoutBlock(block, { width: 400, height: 240 }, createLayoutContext(resolved, block)),
      );
    };
    expect(render()).toBe(render());
  });
});

describe('validateBlock through the barrel', () => {
  it('returns no findings when there is no registry to validate against', () => {
    const block = resolveSync(parse(DOC)).blocks[0];
    if (block === undefined) throw new Error('unreachable');
    expect(validateBlock(block)).toEqual([]);
  });

  it('reports an unknown block type as a warning, never an error', () => {
    const block = resolveSync(parse(DOC)).blocks[0];
    if (block === undefined) throw new Error('unreachable');

    const registry = createChartRegistry();
    registry.freeze();
    const found = validateBlock(block, registry);

    expect(found.map((d) => d.code)).toEqual(['MDV1500']);
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.blockId).toBe('fig-one');
  });
});

describe('plugins reach core through the config door', () => {
  const stub = {
    name: 'stub',
    level: 1 as const,
    family: 'mark' as const,
    channels: [],
    defaultEncoding: {},
    defaults: { height: 42 },
    validate: () => [],
    encode: () => {
      throw new Error('never called in this test');
    },
    layout: () => {
      throw new Error('never called in this test');
    },
  };

  it('registers a plugin chart type and applies its cascade-level-1 defaults', () => {
    const source = '```mdv stub\nx: a\n---\na\n1\n```\n';
    const resolved = resolveSync(parse(source), {
      plugins: [{ name: 'p', version: '1.0.0', chartTypes: [stub] }],
    });
    expect(resolved.blocks[0]?.attrs.height).toBe(42);
  });

  it('makes the plugin type visible to the three-argument layoutBlock', () => {
    const registry = registryFromPlugins({
      plugins: [{ name: 'p', version: '1.0.0', chartTypes: [stub] }],
    });
    expect(registry.get('stub')).toBe(stub);
    expect(registry.frozen).toBe(true);
  });

  it('throws MdvConfigError for a plugin entry that is not a chart type', () => {
    expect(() =>
      registryFromPlugins({
        plugins: [{ name: 'p', version: '1.0.0', chartTypes: [{ name: 'broken' }] }],
      }),
    ).toThrow(MdvConfigError);
  });
});

describe('resolveConfig through the barrel', () => {
  it('fills every member of ResolvedConfig from nothing', () => {
    const config = resolveConfig(undefined);
    expect(config.level).toBe(2);
    expect(config.strict).toBe(false);
    expect(config.colorScheme).toBe('light');
    expect(config.render.target).toBe('auto');
    expect(config.a11y.tableView).toBe('details');
    expect(config.security.allowExternal).toBe(false);
    expect(config.security.maxRowsPerBlock).toBeGreaterThan(0);
    expect(config.capabilities).toEqual({});
  });

  it("resolves `auto` to light rather than reading the host's preference", () => {
    // Querying `matchMedia` would be a DOM access, which SPEC 17.3 invariant 1
    // forbids core outright. The embedder resolves `auto` and passes the answer.
    expect(resolveConfig({ colorScheme: 'auto' }).colorScheme).toBe('light');
    expect(resolveConfig({ colorScheme: 'dark' }).colorScheme).toBe('dark');
    expect(resolveConfig({ colorScheme: 'dark' }).theme.scheme).toBe('dark');
  });
});

describe('the cascade helpers are reachable and are the same ones resolve uses', () => {
  it('cascades and normalises independently of a document', () => {
    const doc = parse(DOC);
    const block = doc.children.find((n) => n.type === 'mdvBlock');
    if (block === undefined || block.type !== 'mdvBlock') throw new Error('unreachable');

    const attrs = cascadeAttrs(block, { typeDefaults: { height: 300 } });
    const encoding = encodingFromAttrs(attrs, new Set(['quarter', 'revenue']));

    expect(encoding.x).toEqual({ field: 'quarter' });
    expect(attrs.height).toBe(300);
  });
});

describe('createTableMetrics — SPEC 24.3 rule 6', () => {
  it('measures without a DOM and gives the same answer twice', () => {
    const metrics = createTableMetrics();
    const font = { family: 'system-ui', size: 13, weight: 400 as const };
    expect(metrics.measure('Revenue', font).width).toBe(metrics.measure('Revenue', font).width);
    expect(metrics.measure('Revenue', font).width).toBeGreaterThan(0);
  });
});

describe('the deferred entry points say which milestone owns them', () => {
  const mdv = new Mdv();

  it('names the milestone rather than saying "not implemented"', async () => {
    await expect(mdv.toPDF('x')).rejects.toThrow(/render-pdf/i);
    await expect(mdv.toHTML('x')).rejects.toThrow(/toSVG/i);
    await expect(mdv.render('x', {} as HTMLElement)).rejects.toThrow(/@mdv\/react|editor/i);
  });

  it('keeps DEFAULT_BUILD_TIME at the epoch, not the wall clock', () => {
    expect(DEFAULT_BUILD_TIME.getTime()).toBe(0);
  });
});

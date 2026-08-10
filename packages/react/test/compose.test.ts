/**
 * The composed resolve: data + cascade + theme → `ResolvedDocument`.
 *
 * This is `@mdv/core`'s facade in everything but location (see the header of
 * `internal/compose.ts`), so it is tested as the facade would be: against the
 * cascade of SPEC 5.5, the theme rules of SPEC 11.6/11.7, the diagnostic
 * attribution of SPEC 14.4 and the strictness rule of SPEC 14.3.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@mdv/parser';
import { composeSync, needsFetch } from '../src/index.js';
import { isPending } from '../src/internal/compose.js';
import { EXTERNAL, GOOD, MALFORMED, TWO_BLOCKS } from './fixtures.js';

describe('the resolved document', () => {
  const doc = composeSync(parse(GOOD));

  it('has one resolved block per visual block, in document order', () => {
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0]?.blockType).toBe('bar');
    expect(doc.blocks[0]?.index).toBe(0);
    expect(doc.blocks[0]?.id).toBe('mdv-0');
  });

  it('prepared the table', () => {
    const table = doc.blocks[0]?.table;
    expect(table?.fields.map((f) => f.name)).toEqual(['quarter', 'revenue']);
    expect(table?.rows).toHaveLength(4);
    expect(table?.rows[0]).toEqual(['Q1', 1240]);
  });

  it('normalised the encoding to the object form (SPEC 7.1.2)', () => {
    expect(doc.blocks[0]?.encoding.x).toEqual({ field: 'quarter' });
    expect(doc.blocks[0]?.encoding.y).toEqual({ field: 'revenue' });
    // The channels are gone from the attribute map.
    expect(doc.blocks[0]?.attrs['x']).toBeUndefined();
  });

  it('carries the front matter and a fully defaulted config (SPEC 25)', () => {
    expect(doc.frontmatter?.title).toBe('Quarterly');
    expect(doc.config.locale).toBe('en');
    expect(doc.config.timezone).toBe('UTC');
    expect(doc.config.level).toBe(2);
    expect(doc.config.render.renderPolicy).toBe('lazy');
    expect(doc.config.security.allowExternal).toBe(false);
  });

  it('pins the build time rather than reading the clock (SPEC 24.3 rule 2)', () => {
    expect(doc.config.buildTime.getTime()).toBe(0);
    const pinned = composeSync(parse(GOOD), { config: { buildTime: new Date(86_400_000) } });
    expect(pinned.config.buildTime.getTime()).toBe(86_400_000);
  });
});

describe('the attribute cascade in place (SPEC 5.5)', () => {
  const source = `---
defaults: {height: 320, palette: doc}
---

\`\`\`mdv bar
title: T
height: 200
---
a,b
1,2
\`\`\`
`;

  it('lets the block outrank the document defaults', () => {
    const doc = composeSync(parse(source));
    expect(doc.blocks[0]?.attrs.height).toBe(200);
  });

  it('lets the document defaults fill what the block omitted', () => {
    const doc = composeSync(parse(source));
    expect(doc.blocks[0]?.attrs.palette).toBe('doc');
  });

  it('lets the embedder outrank the document', () => {
    const doc = composeSync(parse(source), { config: { defaults: { palette: ['#111111'] } } });
    expect(doc.blocks[0]?.attrs.palette).toEqual(['#111111']);
  });

  it('supplies the built-in defaults nobody set', () => {
    const doc = composeSync(parse(source));
    expect(doc.blocks[0]?.attrs.width).toBe('100%');
  });
});

describe('themes (SPEC 11.6, 11.7)', () => {
  it('defaults to the light built-in', () => {
    expect(composeSync(parse(GOOD)).theme.name).toBe('default');
  });

  it('follows the host when the embedder says auto', () => {
    const dark = composeSync(parse(GOOD), { config: { colorScheme: 'auto' }, prefersDark: true });
    expect(dark.theme.scheme).toBe('dark');
    const light = composeSync(parse(GOOD), { config: { colorScheme: 'auto' }, prefersDark: false });
    expect(light.theme.scheme).toBe('light');
  });

  it('lets the embedder overrule the host', () => {
    const forced = composeSync(parse(GOOD), {
      config: { colorScheme: 'light' },
      prefersDark: true,
    });
    expect(forced.theme.scheme).toBe('light');
  });

  it('honours a document theme name', () => {
    const doc = composeSync(parse('---\ntheme: dark\n---\n\nx\n'));
    expect(doc.theme.name).toBe('dark');
  });

  it('never lets a document crash its reader with an unknown theme', () => {
    const doc = composeSync(parse('---\ntheme: {extends: nonsuch}\n---\n\nx\n'));
    expect(doc.theme.name).toBe('default');
  });

  it('throws for an embedder-supplied unknown theme — host programmer error', () => {
    expect(() => composeSync(parse(GOOD), { config: { theme: 'nonsuch' } })).toThrow(
      /Unknown theme/,
    );
  });

  it('applies a per-block theme override', () => {
    const doc = composeSync(parse('```mdv bar\ntheme: dark\nx: a\n---\na,b\n1,2\n```\n'));
    expect(doc.blocks[0]?.theme.name).toBe('dark');
    expect(doc.theme.name).toBe('default');
  });
});

describe('diagnostics', () => {
  it('attributes a block’s diagnostics to that block (SPEC 14.4)', () => {
    const doc = composeSync(parse('```mdv bar\nx: a\n---\n```\n'));
    const block = doc.blocks[0];
    expect(block).toBeDefined();
    for (const d of block?.diagnostics ?? []) {
      expect(d.range.start.offset).toBeGreaterThanOrEqual(block?.range.start.offset ?? 0);
      expect(d.range.start.offset).toBeLessThan(block?.range.end.offset ?? 0);
    }
  });

  it('orders the document list by source position', () => {
    const doc = composeSync(parse(MALFORMED));
    const offsets = doc.diagnostics.map((d) => d.range.start.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('promotes warnings to errors under strict (SPEC 14.3)', () => {
    // A ragged row is `MDV2121` (warning) — a real one, so the test cannot pass
    // vacuously on a document that had no warnings to promote.
    const ragged = '```mdv bar\nx: a\n---\na,b\n1,2,3\n```\n';

    const lenient = composeSync(parse(ragged));
    expect(lenient.diagnostics.some((d) => d.code === 'MDV2121' && d.severity === 'warning')).toBe(
      true,
    );
    expect(lenient.blocks[0]?.failed).toBe(false);

    const strict = composeSync(parse(ragged), { config: { strict: true } });
    expect(strict.diagnostics.some((d) => d.code === 'MDV2121' && d.severity === 'error')).toBe(
      true,
    );
    expect(strict.diagnostics.every((d) => d.severity !== 'warning')).toBe(true);
    // Promotion is not cosmetic: the block now cannot render as specified.
    expect(strict.blocks[0]?.failed).toBe(true);
  });

  it('leaves info alone under strict — a suggestion is not a failure', () => {
    const strict = composeSync(parse(GOOD), { config: { strict: true } });
    expect(strict.diagnostics.some((d) => d.severity === 'info')).toBe(true);
    expect(strict.blocks[0]?.failed).toBe(false);
  });

  it('mirrors every data diagnostic to config.onDiagnostic as it is produced', () => {
    const seen: string[] = [];
    const doc = composeSync(parse(MALFORMED), {
      config: { onDiagnostic: (d) => seen.push(d.code) },
    });
    // Every diagnostic the *data* stage produced reached the sink. Parse
    // diagnostics arrive on the AST and were never routed through it.
    const fromData = doc.diagnostics.filter((d) => d.source === 'data').map((d) => d.code);
    expect(fromData.length).toBeGreaterThan(0);
    expect(seen.sort()).toEqual([...fromData].sort());
  });
});

describe('external data', () => {
  it('is detected before anything is fetched', () => {
    expect(needsFetch(parse(EXTERNAL))).toBe(true);
    expect(needsFetch(parse(GOOD))).toBe(false);
    expect(needsFetch(parse(TWO_BLOCKS))).toBe(false);
  });

  it('fails with MDV4001 on a plain synchronous resolve', () => {
    const doc = composeSync(parse(EXTERNAL));
    expect(doc.diagnostics.some((d) => d.code === 'MDV4001')).toBe(true);
    expect(doc.blocks[0]?.failed).toBe(true);
    expect(isPending(doc.blocks[0]!)).toBe(false);
  });

  it('is pending, not failed, when the async pass is already running', () => {
    const doc = composeSync(parse(EXTERNAL), { externalPending: true });
    expect(doc.diagnostics.some((d) => d.code === 'MDV4001')).toBe(false);
    expect(doc.blocks[0]?.failed).toBe(false);
    expect(isPending(doc.blocks[0]!)).toBe(true);
  });

  it('leaves a local block alone in a document that also fetches', () => {
    const doc = composeSync(parse(`${EXTERNAL}\n${GOOD}`), { externalPending: true });
    expect(doc.blocks).toHaveLength(2);
    expect(isPending(doc.blocks[0]!)).toBe(true);
    expect(isPending(doc.blocks[1]!)).toBe(false);
    expect(doc.blocks[1]?.table.rows).toHaveLength(4);
  });
});

describe('failed blocks', () => {
  it('are marked, and their siblings are not', () => {
    const doc = composeSync(parse(MALFORMED));
    expect(doc.blocks).toHaveLength(2);
    expect(doc.blocks[1]?.failed).toBe(false);
    expect(doc.blocks[1]?.table.rows).toHaveLength(2);
  });
});

describe('an empty document', () => {
  it('resolves to nothing at all, without special-casing', () => {
    const doc = composeSync(parse(''));
    expect(doc.blocks).toEqual([]);
    expect(doc.diagnostics.every((d) => d.severity !== 'error')).toBe(true);
    expect(doc.theme.name).toBe('default');
  });
});

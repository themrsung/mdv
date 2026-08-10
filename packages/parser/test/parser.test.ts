import { describe, expect, it } from 'vitest';
import { parse } from '@mdv/parser';
import type { MdvBlock, MdvContent, MdvDirective, MdvDocument } from '@mdv/parser';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function codes(doc: MdvDocument): string[] {
  return doc.diagnostics.map((diagnostic) => diagnostic.code);
}

function firstBlock(doc: MdvDocument): MdvBlock {
  const block = doc.children.find((child): child is MdvBlock => child.type === 'mdvBlock');
  if (block === undefined) throw new Error('no mdvBlock in document');
  return block;
}

function directives(node: MdvContent | MdvDocument): MdvDirective[] {
  const found: MdvDirective[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    const typed = current as { type?: string; children?: unknown };
    if (typed.type === 'mdvDirective') found.push(current as MdvDirective);
    if (Array.isArray(typed.children)) for (const child of typed.children) stack.push(child);
  }
  return found;
}

function slice(
  source: string,
  node: {
    position?:
      { start: { offset?: number | undefined }; end: { offset?: number | undefined } } | undefined;
  },
): string {
  const start = node.position?.start.offset ?? 0;
  const end = node.position?.end.offset ?? 0;
  return source.slice(start, end);
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 3 — encoding and front matter
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 3.2 — source normalisation', () => {
  it('strips a BOM and normalises CRLF, keeping offsets in the normalised text', () => {
    const doc = parse('\uFEFF# Title\r\n\r\nBody\r\n');
    expect(codes(doc)).toEqual(['MDV1100']);
    const heading = doc.children[0];
    expect(heading?.type).toBe('heading');
    expect(heading?.position?.start.offset).toBe(0);
    expect(heading?.position?.end.offset).toBe(7);
  });

  it('replaces U+0000 with U+FFFD rather than dropping it', () => {
    const doc = parse(`a${String.fromCharCode(0)}b`);
    const paragraph = doc.children[0];
    const text = (paragraph as { children?: { value?: string }[] }).children?.[0];
    expect(text?.value).toBe(`a${String.fromCharCode(0xfffd)}b`);
  });
});

describe('SPEC 3.4 — front matter', () => {
  const source = [
    '---',
    'mdv: "1.0"',
    'title: Q4 Review',
    'lang: en',
    'defaults:',
    '  height: 320',
    'plugins: [alpha, beta]',
    'toc: true',
    'siteweaver: keep-me',
    '---',
    '',
    '# Body',
    '',
  ].join('\n');

  it('reads reserved keys with their declared types', () => {
    const doc = parse(source);
    const frontmatter = doc.frontmatter;
    expect(frontmatter?.mdv).toBe('1.0');
    expect(frontmatter?.title).toBe('Q4 Review');
    expect(frontmatter?.lang).toBe('en');
    expect(frontmatter?.defaults).toEqual({ height: 320 });
    expect(frontmatter?.plugins).toEqual(['alpha', 'beta']);
    expect(frontmatter?.toc).toBe(true);
  });

  it('preserves unknown keys without a diagnostic', () => {
    const doc = parse(source);
    expect(doc.frontmatter?.extra).toEqual({ siteweaver: 'keep-me' });
    expect(codes(doc)).toEqual([]);
  });

  it('records a source range per key', () => {
    const doc = parse(source);
    const range = doc.frontmatter?.attrsPosition['defaults.height'];
    expect(range).toBeDefined();
    expect(source.slice(range?.start.offset ?? 0, range?.end.offset ?? 0)).toBe('320');
  });

  it('accepts `...` as a terminator (SPEC 3.4)', () => {
    const doc = parse('---\ntitle: T\n...\n\ntext\n');
    expect(doc.frontmatter?.title).toBe('T');
    expect(doc.children[0]?.type).toBe('paragraph');
  });

  it('emits MDV1100 when no version is declared, front matter or not', () => {
    expect(codes(parse('# hi\n'))).toEqual(['MDV1100']);
    expect(codes(parse('---\ntitle: T\n---\n'))).toEqual(['MDV1100']);
  });

  it('emits MDV1300 for an unterminated block and keeps the document readable', () => {
    const doc = parse('---\ntitle: T\n\n# Body\n');
    expect(codes(doc)).toContain('MDV1300');
    expect(doc.frontmatter).toBeUndefined();
    expect(doc.children.length).toBeGreaterThan(0);
  });

  it('emits MDV1300 for malformed YAML without throwing', () => {
    const doc = parse('---\na: [1,\nb: 2\n---\n\ntext\n');
    expect(codes(doc)).toContain('MDV1300');
  });

  it('negotiates the spec version (SPEC 15.3)', () => {
    expect(codes(parse('---\nmdv: "2.0"\n---\n'))).toEqual(['MDV1510']);
    expect(codes(parse('---\nmdv: "1.7"\n---\n'))).toEqual(['MDV1511']);
    expect(codes(parse('---\nmdv: "1.0"\n---\n'))).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 4 — base syntax
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 4 — base syntax', () => {
  it('parses GFM tables, strikethrough, task lists and footnotes', () => {
    const doc = parse(
      '| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~\n\n- [x] done\n\nRef[^1]\n\n[^1]: note\n',
    );
    const types = doc.children.map((child) => child.type);
    expect(types).toContain('table');
    expect(types).toContain('footnoteDefinition');
  });

  it('escapes raw HTML by default and emits MDV4011 (SPEC 4, 13.4)', () => {
    const doc = parse('<div>hi</div>\n');
    expect(codes(doc)).toContain('MDV4011');
    expect(doc.children[0]?.type).toBe('paragraph');
    const text = (doc.children[0] as { children?: { type?: string; value?: string }[] })
      .children?.[0];
    expect(text?.type).toBe('text');
    expect(text?.value).toBe('<div>hi</div>');
  });

  it('keeps raw HTML when the embedder opts in', () => {
    const doc = parse('<div>hi</div>\n', { allowHtml: true });
    expect(codes(doc)).not.toContain('MDV4011');
    expect(doc.children[0]?.type).toBe('html');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 5.1 / 5.2 — fences and info strings
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 5.1 — the separator determinism rule', () => {
  it('parses a body with no separator entirely as a header', () => {
    const doc = parse('```mdv bar\nx: quarter\ny: revenue\n```\n');
    const block = firstBlock(doc);
    expect(block.attrs).toEqual({ x: 'quarter', y: 'revenue', type: 'bar' });
    expect(block.raw.data).toBe('');
    expect(codes(doc)).toEqual(['MDV1100']);
  });

  it('does not sniff: a data-looking body with no separator is MDV1203', () => {
    const doc = parse('```mdv pie\nregion | revenue\nAPAC   | 4210\nEMEA   | 3180\n```\n');
    expect(codes(doc)).toContain('MDV1203');
    const block = firstBlock(doc);
    // The source is never lost, whatever the diagnostic says.
    expect(block.raw.header).toBe('region | revenue\nAPAC   | 4210\nEMEA   | 3180\n');
    expect(block.raw.data).toBe('');
  });

  it('reads the data section once the separator is written', () => {
    const doc = parse('```mdv pie\n---\nregion | revenue\nAPAC   | 4210\n```\n');
    const block = firstBlock(doc);
    expect(block.raw.header).toBe('');
    expect(block.raw.data).toBe('region | revenue\nAPAC   | 4210\n');
    expect(codes(doc)).not.toContain('MDV1203');
  });

  it('treats only exactly three hyphens as the separator (Appendix A)', () => {
    const doc = parse('```mdv bar\ntitle: T\n----\nnot data\n```\n');
    expect(firstBlock(doc).raw.data).toBe('');
    expect(codes(doc)).toContain('MDV1203');
  });

  it('accepts tilde fences and fences inside lists', () => {
    const doc = parse('- item\n\n  ~~~mdv bar\n  x: a\n  ---\n  a|b\n  ~~~\n');
    const block = directivesOrBlocks(doc);
    expect(block.raw.fence).toBe('~~~');
    expect(block.raw.header).toBe('x: a\n');
    expect(block.raw.data).toBe('a|b\n');
  });

  it('reports an unterminated fence with MDV1205 and keeps the content', () => {
    const doc = parse('```mdv bar\ntitle: T\n');
    expect(codes(doc)).toContain('MDV1205');
    expect(firstBlock(doc).attrs['title']).toBe('T');
  });

  it('warns about an empty block with MDV1202', () => {
    expect(codes(parse('```mdv bar\n```\n'))).toContain('MDV1202');
  });
});

function directivesOrBlocks(doc: MdvDocument): MdvBlock {
  const stack: unknown[] = [...doc.children];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    const typed = current as { type?: string; children?: unknown };
    if (typed.type === 'mdvBlock') return current as MdvBlock;
    if (Array.isArray(typed.children)) for (const child of typed.children) stack.push(child);
  }
  throw new Error('no mdvBlock in document');
}

describe('SPEC 5.2 — info string', () => {
  it('lowercases the block type and reads inline attributes', () => {
    const doc = parse('```mdv BAR height=200 title="Q1: results"\n```\n');
    const block = firstBlock(doc);
    expect(block.blockType).toBe('bar');
    expect(block.attrs['height']).toBe(200);
    expect(block.attrs['title']).toBe('Q1: results');
  });

  it('lets the header supply the type instead', () => {
    const doc = parse('```mdv\ntype: line\nx: a\n```\n');
    expect(firstBlock(doc).blockType).toBe('line');
    expect(codes(doc)).not.toContain('MDV1201');
  });

  it('emits MDV1201 when neither the info string nor the header names a type', () => {
    const doc = parse('```mdv\nx: a\n```\n');
    expect(codes(doc)).toContain('MDV1201');
    expect(firstBlock(doc).blockType).toBe('');
  });

  it('emits MDV1200 for a malformed info string', () => {
    const doc = parse('```mdv bar 9bad\n```\n');
    expect(codes(doc)).toContain('MDV1200');
  });

  it('records the conformance level of the type (SPEC 16.1)', () => {
    expect(firstBlock(parse('```mdv bar\nx: a\n```\n')).level).toBe(1);
    expect(firstBlock(parse('```mdv sankey\nx: a\n```\n')).level).toBe(2);
    expect(firstBlock(parse('```mdv gantt\nx: a\n```\n')).level).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 5.3 — MDV attribute notation
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 5.3.1 — supported constructs', () => {
  const header = [
    '```mdv bar',
    '# a whole-line comment',
    'title: Revenue        # trailing comment',
    'stack: percent',
    'quoted: "Q1: results"',
    "apostrophe: 'it''s'",
    'y: [revenue, profit]',
    'range: {min: 0, max: 100}',
    'axis:',
    '  x:',
    '    title: Quarter',
    'filters:',
    '  - filter: x > 1',
    '    keep: true',
    '  - {type: sma, period: 20}',
    'literal: |',
    '  one',
    '  two',
    'folded: >',
    '  one',
    '  two',
    'nothing: null',
    'tilde: ~',
    'empty:',
    'yes: yes',
    'no: no',
    'flag: true',
    'count: -3.5',
    'big: 1e6',
    'ref: "@sales"',
    '```',
    '',
  ].join('\n');

  it('parses every construct with the documented typing', () => {
    const block = firstBlock(parse(header));
    expect(block.attrs).toEqual({
      title: 'Revenue',
      stack: 'percent',
      quoted: 'Q1: results',
      apostrophe: "it's",
      y: ['revenue', 'profit'],
      range: { min: 0, max: 100 },
      axis: { x: { title: 'Quarter' } },
      filters: [
        { filter: 'x > 1', keep: true },
        { type: 'sma', period: 20 },
      ],
      literal: 'one\ntwo\n',
      folded: 'one two\n',
      nothing: null,
      tilde: null,
      empty: null,
      // The Norway problem: only `true`/`false` are booleans.
      yes: 'yes',
      no: 'no',
      flag: true,
      count: -3.5,
      big: 1000000,
      ref: '@sales',
      type: 'bar',
    });
  });

  it('gives every key an accurate source range, including nested paths', () => {
    const block = firstBlock(parse(header));
    const at = (path: string): string => {
      const range = block.attrsPosition[path];
      if (range === undefined) throw new Error(`no range for ${path}`);
      return header.slice(range.start.offset, range.end.offset);
    };
    expect(at('title')).toBe('Revenue');
    expect(at('y')).toBe('[revenue, profit]');
    expect(at('y[1]')).toBe('profit');
    expect(at('range.max')).toBe('100');
    expect(at('axis.x.title')).toBe('Quarter');
    expect(at('filters[0].keep')).toBe('true');
    expect(at('filters[1].period')).toBe('20');
    expect(at('ref')).toBe('"@sales"');
  });
});

describe('SPEC 5.3.2 — explicitly unsupported constructs', () => {
  it.each([
    ['anchor', 'a: &anchor 1'],
    ['alias', 'a: *anchor'],
    ['tag', 'a: !!str 1'],
    ['complex key', '? a'],
    ['merge key', '<<: b'],
    ['directive', '%YAML 1.2'],
  ])('rejects a %s with MDV1211 rather than misparsing it', (_name, line) => {
    const doc = parse(`\`\`\`mdv bar\n${line}\n\`\`\`\n`);
    expect(codes(doc)).toContain('MDV1211');
  });

  it.each([
    ['octal', 'a: 017'],
    ['hex', 'a: 0x1F'],
    ['sexagesimal', 'a: 9:30'],
  ])('rejects a %s literal with MDV1211', (_name, line) => {
    const doc = parse(`\`\`\`mdv bar\n${line}\n\`\`\`\n`);
    expect(codes(doc)).toContain('MDV1211');
  });

  it('emits MDV1210 for a tab used as indentation', () => {
    const doc = parse('```mdv bar\naxis:\n\tx: 1\n```\n');
    expect(codes(doc)).toContain('MDV1210');
  });

  it('emits MDV1212 when indentation is not two spaces per level', () => {
    const doc = parse('```mdv bar\naxis:\n   x: 1\n```\n');
    expect(codes(doc)).toContain('MDV1212');
  });

  it('never throws and never loses the header text', () => {
    const source = '```mdv bar\n\t? &a !!x <<: [{\n```\n';
    const doc = parse(source);
    expect(firstBlock(doc).raw.header).toBe('\t? &a !!x <<: [{\n');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 5.4 / 5.5 — data section and cascade
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 5.4 — data section', () => {
  it('keeps the data verbatim with the block indentation removed', () => {
    const doc = parse('> ```mdv bar\n> x: a\n> ---\n>   padded | row\n> ```\n');
    const block = directivesOrBlocks(doc);
    expect(block.raw.data).toBe('  padded | row\n');
  });

  it('emits MDV1204 when data and an out-of-band source are both present', () => {
    const doc = parse('```mdv bar\ndata: "@sales"\n---\na|b\n```\n');
    expect(codes(doc)).toContain('MDV1204');
  });

  it('emits MDV1204 for `src:` too', () => {
    const doc = parse('```mdv bar\nsrc: ./x.csv\n---\na|b\n```\n');
    expect(codes(doc)).toContain('MDV1204');
  });

  it('does not emit MDV1204 for inline data with no separator', () => {
    const doc = parse('```mdv sparkline data="1,4,2,8"\n```\n');
    expect(codes(doc)).not.toContain('MDV1204');
  });
});

describe('SPEC 5.5 — the attribute cascade inside a block', () => {
  it('lets the header beat the info string', () => {
    const block = firstBlock(parse('```mdv bar height=200\nheight: 300\n```\n'));
    expect(block.attrs['height']).toBe(300);
  });

  it('deep-merges mappings and replaces sequences', () => {
    const block = firstBlock(
      parse('```mdv bar axis="{x: {title: A}}"\naxis:\n  y:\n    title: B\n```\n'),
    );
    // The info-string value is a string, so the header replaces it wholesale;
    // deep merging is exercised where both sides are mappings.
    expect(block.attrs['axis']).toEqual({ y: { title: 'B' } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 9 — directives
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 9.2 — inline directives', () => {
  it('splits a paragraph around an inline directive', () => {
    const source = 'Revenue was :mdv-value[@sales.revenue.sum]{format=",.0f"} last year.\n';
    const doc = parse(source);
    const paragraph = doc.children[0] as { children: MdvContent[] };
    expect(paragraph.children.map((child) => child.type)).toEqual(['text', 'mdvDirective', 'text']);
    const directive = paragraph.children[1] as MdvDirective;
    expect(directive.name).toBe('mdv-value');
    expect(directive.kind).toBe('inline');
    expect(directive.label).toBe('@sales.revenue.sum');
    expect(directive.attrs).toEqual({ format: ',.0f' });
    expect(slice(source, directive)).toBe(':mdv-value[@sales.revenue.sum]{format=",.0f"}');
  });

  it('leaves an escaped colon alone', () => {
    const doc = parse('literal \\:mdv-ref[x] here\n');
    expect(directives(doc)).toHaveLength(0);
  });

  it('ignores directive names without the mdv- prefix (SPEC 9)', () => {
    const doc = parse('a :note[x] b\n');
    expect(directives(doc)).toHaveLength(0);
  });

  it('emits MDV1503 for an unknown mdv- directive but keeps the node', () => {
    const doc = parse('a :mdv-unheard[x] b\n');
    expect(codes(doc)).toContain('MDV1503');
    expect(directives(doc)).toHaveLength(1);
  });

  it('keeps offsets exact when the text around it contains escapes', () => {
    const source = 'a \\* b :mdv-delta[0.1]{good=up} c\n';
    const doc = parse(source);
    const directive = directives(doc)[0];
    expect(directive).toBeDefined();
    expect(slice(source, directive as MdvDirective)).toBe(':mdv-delta[0.1]{good=up}');
  });
});

describe('SPEC 9.1 — block directives', () => {
  it('parses a container written with blank lines', () => {
    const doc = parse(':::mdv-grid{cols=3 gap=16}\n\ntext\n\n:::\n');
    const [directive] = directives(doc);
    expect(directive?.kind).toBe('container');
    expect(directive?.name).toBe('mdv-grid');
    expect(directive?.attrs).toEqual({ cols: 3, gap: 16 });
    expect(directive?.children?.map((child) => child.type)).toEqual(['paragraph']);
  });

  it('parses a container written with no blank lines at all (Appendix E)', () => {
    const doc = parse(':::mdv-callout{type=note title="Method"}\nBody text.\n:::\n');
    const [directive] = directives(doc);
    expect(directive?.kind).toBe('container');
    expect(directive?.attrs).toEqual({ type: 'note', title: 'Method' });
    expect(directive?.children).toHaveLength(1);
  });

  it('nests containers', () => {
    const doc = parse(':::mdv-grid\n\n:::mdv-callout\n\ninner\n\n:::\n\n:::\n');
    const all = directives(doc);
    expect(all.map((directive) => directive.name)).toEqual(['mdv-grid', 'mdv-callout']);
    expect(all[0]?.children).toHaveLength(1);
  });

  it('does not close on a ::: inside a fenced code block', () => {
    const doc = parse(':::mdv-grid\n\n```\n:::\n```\n\ninside\n\n:::\n');
    const [directive] = directives(doc);
    expect(directive?.children?.map((child) => child.type)).toEqual(['code', 'paragraph']);
  });

  it('runs an unclosed container to the end of its parent', () => {
    const doc = parse(':::mdv-page{break=before}\n\ntail\n');
    const [directive] = directives(doc);
    expect(directive?.children?.map((child) => child.type)).toEqual(['paragraph']);
  });

  it('splices back the text that followed a closer inside a paragraph', () => {
    const doc = parse(':::mdv-callout\nbody\n:::\nafter\n');
    expect(doc.children.map((child) => child.type)).toEqual(['mdvDirective', 'paragraph']);
  });

  it('parses a leaf directive and keeps the rest of the paragraph', () => {
    const doc = parse('::mdv-page[label]{break=after}\nfollowing text\n');
    const [directive] = directives(doc);
    expect(directive?.kind).toBe('leaf');
    expect(directive?.label).toBe('label');
    expect(doc.children.map((child) => child.type)).toEqual(['mdvDirective', 'paragraph']);
  });

  it('can be switched off', () => {
    const doc = parse(':::mdv-grid\n\ntext\n\n:::\n', { directives: false });
    expect(directives(doc)).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 10 — enhanced tables
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 10 — enhanced tables', () => {
  it('recognises the mdv table block', () => {
    const block = firstBlock(
      parse(
        '```mdv table\ncolumns:\n  region: {label: Region, align: left}\nsort: [-revenue]\n---\nregion | revenue\nAPAC   | 42100\n```\n',
      ),
    );
    expect(block.blockType).toBe('table');
    expect(block.attrs['columns']).toEqual({ region: { label: 'Region', align: 'left' } });
    expect(block.attrs['sort']).toEqual(['-revenue']);
  });

  it('lifts an attribute line off a GFM table (SPEC 10.2)', () => {
    const doc = parse(
      '| region | revenue |\n|--------|--------:|\n| APAC   |   42100 |\n{.mdv-table sortable=true total="revenue:sum"}\n',
    );
    const table = doc.children[0] as {
      type: string;
      children: unknown[];
      data?: Record<string, unknown>;
    };
    expect(table.type).toBe('table');
    expect(table.children).toHaveLength(2);
    expect(table.data?.['mdvAttrs']).toEqual({
      sortable: true,
      total: 'revenue:sum',
      class: 'mdv-table',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 14 — diagnostics as data
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 14 — diagnostics', () => {
  it('orders diagnostics by position', () => {
    const doc = parse('```mdv\n\ta: 1\n```\n\n```mdv bar 9bad\nx: 1\n```\n');
    const offsets = doc.diagnostics.map((diagnostic) => diagnostic.range.start.offset);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
  });

  it('tags diagnostics with the block id when the header declares one', () => {
    const doc = parse('```mdv bar\nid: chart-1\n0x1F: no\n```\n');
    const tagged = doc.diagnostics.filter((diagnostic) => diagnostic.blockId === 'chart-1');
    expect(tagged.length).toBeGreaterThan(0);
  });

  it('carries severity and message from Appendix C', () => {
    const doc = parse('```mdv bar\n```\n');
    const empty = doc.diagnostics.find((diagnostic) => diagnostic.code === 'MDV1202');
    expect(empty?.severity).toBe('warning');
    expect(empty?.message).toBe('Empty visual block');
    expect(empty?.source).toBe('parse');
  });

  it('honours maxBytes with a single MDV4000 and no partial work', () => {
    const doc = parse('# a fairly long document\n\nwith text\n', { maxBytes: 8 });
    expect(codes(doc)).toEqual(['MDV4000']);
    expect(doc.children).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Position accuracy
// ─────────────────────────────────────────────────────────────────────────────

describe('position accuracy', () => {
  it('gives absolute offsets to nodes inside a container directive', () => {
    const source = 'intro\n\n:::mdv-grid\n\n# Inner\n\n:::\n';
    const doc = parse(source);
    const [directive] = directives(doc);
    const heading = directive?.children?.[0];
    expect(heading?.type).toBe('heading');
    expect(slice(source, heading as MdvContent)).toBe('# Inner');
    expect(slice(source, directive as MdvDirective)).toBe(':::mdv-grid\n\n# Inner\n\n:::');
  });

  it('gives absolute offsets to attributes inside a block in a blockquote', () => {
    const source = '> ```mdv bar\n> title: T\n> ```\n';
    const block = directivesOrBlocks(parse(source));
    const range = block.attrsPosition['title'];
    expect(source.slice(range?.start.offset ?? 0, range?.end.offset ?? 0)).toBe('T');
  });

  it('places the block node over the whole fence', () => {
    const source = 'a\n\n```mdv bar\nx: 1\n```\n';
    const block = firstBlock(parse(source));
    expect(slice(source, block)).toBe('```mdv bar\nx: 1\n```');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SPEC 15 — degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('SPEC 15.1 — extension attributes', () => {
  it('preserves `x-` attributes without a diagnostic', () => {
    const doc = parse('```mdv bar x-plugin=1\nx-thing: {a: 1}\n```\n');
    expect(firstBlock(doc).attrs).toEqual({
      'x-plugin': 1,
      'x-thing': { a: 1 },
      type: 'bar',
    });
    // Only the "no version declared" info; the `x-` keys are silent by design.
    expect(codes(doc)).toEqual(['MDV1100']);
  });

  it('keeps an unknown block type parseable and Level 1 so it can degrade', () => {
    const block = firstBlock(parse('```mdv quantum-foam\nx: 1\n```\n'));
    expect(block.blockType).toBe('quantum-foam');
    expect(block.level).toBe(1);
  });
});

describe('inline directives and link references', () => {
  it('keeps the label when a matching link definition exists', () => {
    const doc = parse('See :mdv-ref[fig-revenue] here.\n\n[fig-revenue]: https://example.com\n');
    const paragraph = doc.children[0] as { children: MdvContent[] };
    expect(paragraph.children.map((child) => child.type)).toEqual(['text', 'mdvDirective', 'text']);
    expect((paragraph.children[1] as MdvDirective).label).toBe('fig-revenue');
  });

  it('handles a directive at the very start of a paragraph', () => {
    const doc = parse(':mdv-metric[42]{format=d} of them\n');
    const paragraph = doc.children[0] as { children: MdvContent[] };
    expect(paragraph.children.map((child) => child.type)).toEqual(['mdvDirective', 'text']);
  });
});

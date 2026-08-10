import { describe, expect, it } from 'vitest';

import { createIdFactory } from '../ids.js';
import type { Block, MdvDocument } from '../model.js';
import { read } from '../io/read.js';
import { write } from '../io/write.js';
import { CORPUS } from './corpus.js';

/** Read with a fresh, deterministic id factory so two reads compare equal. */
function parse(text: string): MdvDocument {
  return read(text, { ids: createIdFactory('n') });
}

function collectRaw(blocks: readonly Block[], out: string[] = []): string[] {
  for (const block of blocks) {
    if (block.kind === 'raw') out.push(block.text);
    if (block.kind === 'blockquote') collectRaw(block.children, out);
    if (block.kind === 'list') for (const item of block.items) collectRaw(item.blocks, out);
  }
  return out;
}

describe('read / write round trip', () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    it(`is stable for ${name}`, () => {
      const once = parse(source);
      const text = write(once);
      const twice = parse(text);
      expect(twice).toEqual(once);
      // And idempotent at the text level after the first normalising pass.
      expect(write(twice)).toBe(text);
    });
  }

  it('preserves raw blocks byte for byte', () => {
    const doc = parse(CORPUS.RAW ?? '');
    const before = collectRaw(doc.blocks);
    expect(before.length).toBeGreaterThan(0);
    const after = collectRaw(parse(write(doc)).blocks);
    expect(after).toEqual(before);
  });

  it('reproduces the Appendix E front matter verbatim', () => {
    const doc = parse(CORPUS.APPENDIX_E ?? '');
    expect(doc.frontMatter?.terminator).toBe('---');
    expect(doc.frontMatter?.source).toContain('mdv: "1.0"');
    expect(doc.frontMatter?.source).toContain('  footer: {center: "{page} / {pages}"}');
    expect(write(doc).startsWith('---\nmdv: "1.0"')).toBe(true);
  });

  it('normalises CRLF and strips the BOM (SPEC 3.2)', () => {
    const doc = parse(CORPUS.BOM_AND_CRLF ?? '');
    expect(write(doc)).toBe('# Title\n\nBody text.\n');
  });

  it('writes an empty document as the empty string', () => {
    expect(write(parse(''))).toBe('');
  });
});

describe('visual blocks', () => {
  it('honours the SPEC 5.1 separator determinism rule', () => {
    const doc = parse('```mdv pie\nregion | revenue\nAPAC | 1\n```\n');
    const block = doc.blocks[0];
    expect(block?.kind).toBe('visual');
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    // No separator line, so the whole body is header and there is no data.
    expect(block.data).toBeNull();
    expect(block.header).toBe('region | revenue\nAPAC | 1');
    expect(write(doc)).toBe('```mdv pie\nregion | revenue\nAPAC | 1\n```\n');
  });

  it('emits a bare separator when there are data but no attributes', () => {
    const doc = parse('```mdv pie\n---\nregion | revenue\nAPAC | 4210\n```\n');
    const block = doc.blocks[0];
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    expect(block.header).toBe('');
    expect(block.data).toBe('region | revenue\nAPAC | 4210');
    expect(write(doc)).toBe('```mdv pie\n---\nregion | revenue\nAPAC | 4210\n```\n');
  });

  it('keeps an empty data section distinguishable from no data section', () => {
    const withEmptyData = parse('```mdv pie\nx: a\n---\n```\n');
    const noData = parse('```mdv pie\nx: a\n```\n');
    const a = withEmptyData.blocks[0];
    const b = noData.blocks[0];
    if (a?.kind !== 'visual' || b?.kind !== 'visual') throw new Error('expected visual blocks');
    expect(a.data).toBe('');
    expect(b.data).toBeNull();
    expect(write(withEmptyData)).toBe('```mdv pie\nx: a\n---\n```\n');
  });

  it('parses info-string attributes and preserves their quoting', () => {
    const doc = parse('```mdv sparkline data="1,4,2,8" width=40 label=\'a b\'\n```\n');
    const block = doc.blocks[0];
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    expect(block.blockType).toBe('sparkline');
    expect(block.infoAttributes).toEqual([
      { key: 'data', value: '1,4,2,8', quote: 'double' },
      { key: 'width', value: '40', quote: 'none' },
      { key: 'label', value: 'a b', quote: 'single' },
    ]);
    expect(write(doc)).toBe('```mdv sparkline data="1,4,2,8" width=40 label=\'a b\'\n```\n');
  });

  it('switches to tildes when the info string contains a backtick', () => {
    const doc = parse('~~~mdv bar title="a `b` c"\nx: q\n~~~\n');
    const text = write(doc);
    expect(text.startsWith('~~~mdv bar')).toBe(true);
  });

  it('lengthens the fence past any backtick run in the body', () => {
    const doc = parse('````mdv raw\nheader\n---\n```\nnested\n```\n````\n');
    const block = doc.blocks[0];
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    expect(block.data).toBe('```\nnested\n```');
    expect(write(doc)).toBe('````mdv raw\nheader\n---\n```\nnested\n```\n````\n');
  });

  it('treats a non-mdv fence as a plain code block', () => {
    const doc = parse('```mdvx\nnot a visual block\n```\n');
    expect(doc.blocks[0]?.kind).toBe('code');
  });
});

/**
 * Reader/writer fidelity.
 *
 * The existing round-trip suite proves the pair is *stable*: reading twice
 * gives the same document. That is necessary but nowhere near sufficient — a
 * reader that silently drops every emphasis mark is perfectly stable, and one
 * did, for a while. These tests prove *fidelity*: canonical source must survive
 * `write(read(text)) === text` exactly, and no visible character may go missing
 * from any input at all.
 */

import { describe, expect, it } from 'vitest';

import { createIdFactory } from '../ids.js';
import type { Block, MdvDocument } from '../model.js';
import { read } from '../io/read.js';
import { write } from '../io/write.js';
import { CORPUS } from './corpus.js';

function parse(text: string): MdvDocument {
  return read(text, { ids: createIdFactory('n') });
}

/** Sources already in the writer's canonical form: these must survive exactly. */
const CANONICAL: Readonly<Record<string, string>> = {
  emphasis: '*one* and **two** and ***three***\n',
  intraword: 'a**b**c and x*y*z\n',
  adjacent: '**a**b\n',
  code_span: 'call `read(text)` first\n',
  strikethrough: '~~gone~~ but not forgotten\n',
  mixed: '**bold with *nested* inside**\n',
  link: 'see [the docs](https://example.com) for more\n',
  link_title: 'see [docs](https://example.com "Title") now\n',
  autolink: 'mail <someone@example.com> now\n',
  image: '![alt text](picture.png)\n',
  image_title: '![alt](picture.png "A title")\n',
  heading: '# One\n\n## Two\n\n###### Six\n',
  blockquote: '> quoted text\n>\n> second paragraph\n',
  bullet_list: '- one\n- two\n- three\n',
  ordered_list: '1. one\n2. two\n3. three\n',
  nested_list: '- outer\n  - inner\n  - inner two\n- outer two\n',
  task_list: '- [ ] todo\n- [x] done\n',
  code_block: '```ts\nconst x: number = 1;\n```\n',
  code_block_bare: '```\nplain\n```\n',
  thematic_break: 'before\n\n---\n\nafter\n',
  // The writer pads cells to a common width; that padded form is canonical.
  table: '| a   | b   |\n| --- | --- |\n| 1   | 2   |\n',
  table_aligned: '| a   | b   | c   |\n| :-- | :-: | --: |\n| 1   | 2   | 3   |\n',
  visual_header_only: '```mdv chart\ntype: bar\n```\n',
  visual_with_data: '```mdv chart\ntype: bar\n---\nx,y\n1,2\n```\n',
  visual_attributes: '```mdv chart id=one width="40%"\ntype: bar\n```\n',
  escaped: 'a \\* not emphasis and a \\_ too\n',
  front_matter: '---\ntitle: "Doc"\n---\n\nBody.\n',
};

describe('canonical source survives a round trip byte for byte', () => {
  for (const [name, text] of Object.entries(CANONICAL)) {
    it(name, () => {
      expect(write(parse(text))).toBe(text);
    });
  }
});

/** Every visible character of a document, marks and syntax stripped. */
function visibleText(blocks: readonly Block[], out: string[] = []): string[] {
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading':
        out.push(block.runs.map((run) => run.text).join(''));
        break;
      case 'code':
      case 'raw':
        out.push(block.text);
        break;
      case 'blockquote':
        visibleText(block.children, out);
        break;
      case 'list':
        for (const item of block.items) visibleText(item.blocks, out);
        break;
      case 'table':
        for (const row of block.rows) {
          for (const cell of row.cells) out.push(cell.runs.map((run) => run.text).join(''));
        }
        break;
      case 'image':
        out.push(block.alt);
        break;
      case 'visual':
        out.push(block.header, block.data ?? '');
        break;
      default:
        break;
    }
  }
  return out;
}

describe('no visible text is lost', () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    it(`preserves every character of ${name}`, () => {
      const once = parse(source);
      const twice = parse(write(once));
      expect(visibleText(twice.blocks)).toEqual(visibleText(once.blocks));
    });
  }

  it('keeps emphasis marks rather than dropping them silently', () => {
    const doc = parse('**strong** and *weak* and `code`\n');
    const paragraph = doc.blocks[0];
    expect(paragraph?.kind).toBe('paragraph');
    if (paragraph?.kind !== 'paragraph') return;

    const types = paragraph.runs.map((run) =>
      run.kind === 'text' ? run.marks.map((mark) => mark.type) : [],
    );
    expect(types.flat()).toContain('strong');
    expect(types.flat()).toContain('emphasis');
    expect(types.flat()).toContain('code');
    expect(paragraph.runs.map((run) => run.text).join('')).toBe('strong and weak and code');
  });

  it('leaves an unmatched delimiter as literal text', () => {
    const doc = parse('a ** b\n');
    const paragraph = doc.blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
    expect(paragraph.runs.map((run) => run.text).join('')).toBe('a ** b');
    expect(write(doc)).toBe('a \\*\\* b\n');
  });
});

describe('the SPEC 5.1 separator rule is deterministic', () => {
  it('treats a body with no separator as header-only', () => {
    const doc = parse('```mdv chart\ntype: bar\nvalue: 1\n```\n');
    const block = doc.blocks[0];
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    expect(block.data).toBeNull();
    expect(block.header).toBe('type: bar\nvalue: 1');
  });

  it('keeps an empty data section distinct from no data section', () => {
    const withData = parse('```mdv chart\ntype: bar\n---\n```\n');
    const block = withData.blocks[0];
    if (block?.kind !== 'visual') throw new Error('expected a visual block');
    expect(block.data).toBe('');
    expect(write(withData)).toContain('\n---\n');
  });
});

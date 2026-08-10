/**
 * Clipboard: normalisation in, three flavours out.
 *
 * The HTML fixtures below are not tidied. They are the shape of what Google
 * Docs, Word and web pages actually put on the clipboard — unclosed tags,
 * `<b style="font-weight:normal">`, eleven CSS declarations per span, bullet
 * glyphs baked in as literal text, `&nbsp;` where a space was meant. A paste
 * pipeline that is only tested against markup someone hand-wrote for the test
 * is not tested at all.
 *
 * The bar for each fixture is the same: no visible character is lost, no
 * formatting is invented, nothing executable survives, and every table comes
 * out rectangular.
 */

import { describe, expect, it } from 'vitest';

import {
  blocksFromHtml,
  blocksFromText,
  blocksToHtml,
  clipboardEntries,
  copyDocument,
  copySelection,
  decodeEntities,
  escapeHtml,
  fragmentOf,
  gridFromBlocks,
  gridFromText,
  HTML_CLIPBOARD_TYPE,
  imagesFrom,
  inlineToHtml,
  isImageOnly,
  MDV_CLIPBOARD_TYPE,
  parseHtml,
  paste,
  pasteAsMarkdown,
  pasteWithoutFormatting,
  readClipboardPayload,
  safeUrl,
  TEXT_CLIPBOARD_TYPE,
  textFromHtml,
} from '../clipboard/index.js';
import type { ClipboardPayload, DataTransferLike } from '../clipboard/index.js';
import { createIdFactory } from '../ids.js';
import type { IdFactory } from '../ids.js';
import type { Block } from '../model.js';
import { writeBlocks } from '../io/write.js';
import { blockAt, caretAt, editorFor, rangeIn, tableText } from './helpers.js';

function ids(): IdFactory {
  return createIdFactory('p');
}

/** Blocks from HTML, with deterministic ids. */
function fromHtml(html: string): readonly Block[] {
  return blocksFromHtml(html, ids());
}

/**
 * The `.mdv` source that pasting `html` would contribute.
 *
 * `writeBlocks` serialises a *fragment*, which — unlike a whole document — does
 * not end with a newline, because it is spliced into surrounding content rather
 * than saved as a file. The newline is restored here so the expectations below
 * read like the `.mdv` they describe.
 */
function sourceFromHtml(html: string): string {
  return asFile(writeBlocks(fromHtml(html)));
}

/** A fragment's source as it would look if it were the whole file. */
function asFile(source: string): string {
  return source === '' ? '' : `${source}\n`;
}

/** Every visible character of a block list, for no-loss assertions. */
function visible(blocks: readonly Block[]): string {
  const out: string[] = [];
  const walk = (list: readonly Block[]): void => {
    for (const block of list) {
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
          walk(block.children);
          break;
        case 'list':
          for (const item of block.items) walk(item.blocks);
          break;
        case 'table':
          for (const row of block.rows) {
            for (const cell of row.cells) out.push(cell.runs.map((run) => run.text).join(''));
          }
          break;
        case 'image':
          out.push(block.alt);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return out.join('\u0001');
}

/* -------------------------------------------------------------------------- */
/* The HTML parser                                                             */
/* -------------------------------------------------------------------------- */

describe('the HTML parser', () => {
  it('closes an unclosed <p> at the next block element', () => {
    const nodes = parseHtml('<p>one<p>two<p>three');
    expect(nodes.filter((node) => node.kind === 'element')).toHaveLength(3);
    expect(textFromHtml('<p>one<p>two')).toContain('one');
    expect(textFromHtml('<p>one<p>two')).toContain('two');
  });

  it('treats void elements as self-closing', () => {
    const blocks = fromHtml('<p>a<br>b<hr><p>c');
    expect(visible(blocks)).toContain('a');
    expect(visible(blocks)).toContain('c');
  });

  it('does not parse tags inside <script> or <style>', () => {
    const blocks = fromHtml('<style>p { content: "<b>x</b>" }</style><p>real</p>');
    expect(visible(blocks)).toBe('real');
  });

  it('drops comments, including the fragment markers everyone emits', () => {
    const blocks = fromHtml('<!--StartFragment--><p>kept</p><!--EndFragment-->');
    expect(visible(blocks)).toBe('kept');
  });

  it('decodes the entities that matter', () => {
    expect(decodeEntities('a&nbsp;b')).toBe('a b');
    expect(decodeEntities('&lt;tag&gt; &amp; &quot;quoted&quot;')).toBe('<tag> & "quoted"');
    expect(decodeEntities('&#65;&#x42;')).toBe('AB');
    // An unknown entity is left alone rather than mangled.
    expect(decodeEntities('&notarealentity;')).toContain('notarealentity');
  });

  it('escapes on the way back out', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });

  it('survives markup that never closes anything', () => {
    expect(() => fromHtml('<div><p><span><b>text')).not.toThrow();
    expect(visible(fromHtml('<div><p><span><b>text'))).toBe('text');
  });

  it('survives a stray closing tag with no opener', () => {
    expect(visible(fromHtml('</p></div>text<p>more</p>'))).toContain('more');
  });
});

/* -------------------------------------------------------------------------- */
/* Google Docs                                                                 */
/* -------------------------------------------------------------------------- */

const GOOGLE_DOCS = `<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-9f3e2a1b-7fff-4a2c-9d1e-000000000000"><p dir="ltr" style="line-height:1.38;margin-top:0pt;margin-bottom:0pt;"><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">Plain sentence with a </span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:700;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">bold</span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"> word and an </span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:italic;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;">italic</span><span style="font-size:11pt;font-family:Arial;color:#000000;background-color:transparent;font-weight:400;font-style:normal;font-variant:normal;text-decoration:none;vertical-align:baseline;white-space:pre;white-space:pre-wrap;"> one.</span></p></b>`;

describe('pasting from Google Docs', () => {
  it('does not bold the entire document', () => {
    // The outer <b style="font-weight:normal"> is the classic trap.
    const blocks = fromHtml(GOOGLE_DOCS);
    expect(blocks).toHaveLength(1);
    const paragraph = blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');

    const bolded = paragraph.runs.filter((run) =>
      run.kind === 'text' ? run.marks.some((mark) => mark.type === 'strong') : false,
    );
    expect(bolded.map((run) => run.text)).toEqual(['bold']);
  });

  it('keeps the emphasis that is really there', () => {
    const source = sourceFromHtml(GOOGLE_DOCS);
    expect(source).toBe('Plain sentence with a **bold** word and an *italic* one.\n');
  });

  it('loses no characters to the span soup', () => {
    expect(visible(fromHtml(GOOGLE_DOCS))).toBe(
      'Plain sentence with a bold word and an italic one.',
    );
  });

  it('unwraps the docs-internal-guid wrapper rather than making a block of it', () => {
    expect(fromHtml(GOOGLE_DOCS)).toHaveLength(1);
  });

  it('reads a Google Docs list as a real list', () => {
    const html =
      '<ul style="margin-top:0;margin-bottom:0;padding-inline-start:48px;">' +
      '<li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1"><p dir="ltr" style="line-height:1.38;"><span style="font-size:11pt;">first</span></p></li>' +
      '<li dir="ltr" style="list-style-type:disc;font-size:11pt;" aria-level="1"><p dir="ltr" style="line-height:1.38;"><span style="font-size:11pt;">second</span></p></li>' +
      '</ul>';
    const blocks = fromHtml(html);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('list');
    expect(sourceFromHtml(html)).toBe('- first\n- second\n');
  });
});

/* -------------------------------------------------------------------------- */
/* Microsoft Word                                                              */
/* -------------------------------------------------------------------------- */

const WORD_LIST = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta name=Generator content="Microsoft Word 15"><style><!-- p.MsoNormal { margin:0cm; font-size:11.0pt; } --></style></head><body lang=EN-GB><p class=MsoListParagraphCxSpFirst style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1'><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><span>First item<o:p></o:p></span></p><p class=MsoListParagraphCxSpMiddle style='margin-left:36.0pt;text-indent:-18.0pt;mso-list:l0 level1 lfo1'><span style='font-family:Symbol'><span style='mso-list:Ignore'>·<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><span>Second item<o:p></o:p></span></p><p class=MsoListParagraphCxSpLast style='margin-left:72.0pt;text-indent:-18.0pt;mso-list:l0 level2 lfo1'><span style='font-family:"Courier New"'><span style='mso-list:Ignore'>o<span style='font:7.0pt "Times New Roman"'>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; </span></span></span><span>Nested item<o:p></o:p></span></p></body></html>`;

describe('pasting from Word', () => {
  it('reassembles mso-list paragraphs into a list', () => {
    const blocks = fromHtml(WORD_LIST);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.kind).toBe('list');
  });

  it('throws away the literal bullet glyphs', () => {
    const text = visible(fromHtml(WORD_LIST));
    expect(text).not.toContain('·');
    expect(text).not.toContain('o ');
    expect(text).toContain('First item');
    expect(text).toContain('Nested item');
  });

  it('nests the second level', () => {
    expect(sourceFromHtml(WORD_LIST)).toBe('- First item\n- Second item\n  - Nested item\n');
  });

  it('drops the <o:p> and <style> noise', () => {
    const source = sourceFromHtml(WORD_LIST);
    expect(source).not.toContain('MsoNormal');
    expect(source).not.toContain('o:p');
  });

  it('reads a Word table with a merged header cell as a rectangle', () => {
    const html =
      "<table class=MsoTableGrid border=1 cellspacing=0 cellpadding=0 style='border-collapse:collapse'>" +
      "<tr><td colspan=2 valign=top style='width:200pt'><p class=MsoNormal>Merged header</p></td></tr>" +
      '<tr><td><p class=MsoNormal>a</p></td><td><p class=MsoNormal>b</p></td></tr>' +
      '</table>';
    const blocks = fromHtml(html);
    const table = blocks[0];
    if (table?.kind !== 'table') throw new Error('expected a table');

    expect(table.align).toHaveLength(2);
    for (const row of table.rows) expect(row.cells).toHaveLength(2);
    // Unmerging puts the content in the first cell and leaves the second empty,
    // exactly as a spreadsheet does — nothing is duplicated and nothing is lost.
    expect(tableText(table)).toEqual([
      ['Merged header', ''],
      ['a', 'b'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Generic web HTML                                                            */
/* -------------------------------------------------------------------------- */

describe('pasting from a web page', () => {
  it('maps semantic tags to block kinds', () => {
    const html =
      '<h2>Title</h2><p>Body text.</p><blockquote><p>Quoted.</p></blockquote>' +
      '<ol start="3"><li>three</li><li>four</li></ol><hr><pre><code class="language-ts">const x = 1;</code></pre>';
    expect(sourceFromHtml(html)).toBe(
      '## Title\n\nBody text.\n\n> Quoted.\n\n3. three\n4. four\n\n---\n\n```ts\nconst x = 1;\n```\n',
    );
  });

  it('collapses whitespace the way a browser would', () => {
    const blocks = fromHtml('<p>  lots   of\n\n   space  </p>');
    expect(visible(blocks)).toBe('lots of space');
  });

  it('keeps whitespace inside <pre> exactly', () => {
    const blocks = fromHtml('<pre><code>  indented\n\n    more</code></pre>');
    const code = blocks[0];
    if (code?.kind !== 'code') throw new Error('expected a code block');
    expect(code.text).toBe('  indented\n\n    more');
  });

  it('turns &nbsp; into an ordinary space', () => {
    expect(visible(fromHtml('<p>a&nbsp;b</p>'))).toBe('a b');
  });

  it('reads a link with its title', () => {
    expect(sourceFromHtml('<p><a href="https://example.com" title="T">text</a></p>')).toBe(
      '[text](https://example.com "T")\n',
    );
  });

  it('believes computed style over tag name in both directions', () => {
    expect(sourceFromHtml('<p><b style="font-weight:normal">not bold</b></p>')).toBe('not bold\n');
    expect(sourceFromHtml('<p><span style="font-weight:700">bold</span></p>')).toBe('**bold**\n');
    expect(sourceFromHtml('<p><span style="font-style:italic">it</span></p>')).toBe('*it*\n');
    expect(sourceFromHtml('<p><span style="text-decoration:line-through">gone</span></p>')).toBe(
      '~~gone~~\n',
    );
  });

  it('recognises a monospace font as code', () => {
    expect(
      sourceFromHtml('<p><span style="font-family:Consolas, monospace">x = 1</span></p>'),
    ).toBe('`x = 1`\n');
  });

  it('ends a paragraph at <br> rather than inventing a hard break', () => {
    // The model has no hard break, and a fabricated one would not survive a
    // round trip. Two paragraphs lose no characters and do round-trip.
    const blocks = fromHtml('<p>first<br>second</p>');
    expect(blocks).toHaveLength(2);
    expect(visible(blocks)).toBe('first\u0001second');
  });

  it('reads a checkbox list as a task list', () => {
    const html =
      '<ul><li><input type="checkbox" checked disabled>done</li><li><input type="checkbox" disabled>todo</li></ul>';
    expect(sourceFromHtml(html)).toBe('- [x] done\n- [ ] todo\n');
  });

  it('reads an image', () => {
    const html = '<p><img src="https://example.com/a.png" alt="A picture" title="T"></p>';
    expect(sourceFromHtml(html)).toContain('https://example.com/a.png');
    expect(sourceFromHtml(html)).toContain('A picture');
  });

  it('produces nothing rather than an empty paragraph for empty markup', () => {
    expect(fromHtml('')).toEqual([]);
    expect(fromHtml('   ')).toEqual([]);
    expect(fromHtml('<div><span> </span></div>')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Safety                                                                      */
/* -------------------------------------------------------------------------- */

describe('nothing executable survives a paste', () => {
  const hostile: readonly string[] = [
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    '  javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    'jAvAsCrIpT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:application/javascript,alert(1)',
  ];

  for (const url of hostile) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(safeUrl(url)).toBeUndefined();
    });
  }

  const allowed: readonly string[] = [
    'https://example.com/a',
    'http://example.com/a',
    'mailto:someone@example.com',
    '/relative/path',
    '#anchor',
    'data:image/png;base64,AAAA',
  ];

  for (const url of allowed) {
    it(`allows ${JSON.stringify(url)}`, () => {
      expect(safeUrl(url)).toBe(url.trim());
    });
  }

  it('keeps the link text when the href is rejected', () => {
    const source = sourceFromHtml('<p><a href="javascript:alert(1)">click me</a></p>');
    expect(source).toBe('click me\n');
    expect(source).not.toContain('javascript');
  });

  it('drops a script element entirely, contents included', () => {
    const source = sourceFromHtml('<p>before</p><script>alert("boom")</script><p>after</p>');
    expect(source).toBe('before\n\nafter\n');
  });

  it('does not carry an event handler attribute anywhere', () => {
    const source = sourceFromHtml('<p onclick="alert(1)">text</p>');
    expect(source).toBe('text\n');
    expect(source).not.toContain('onclick');
  });

  it('refuses a non-image data: URL on an <img>', () => {
    const blocks = fromHtml('<p><img src="data:text/html;base64,PHNjcmlwdD4=" alt="x"></p>');
    expect(writeBlocks(blocks)).not.toContain('data:text/html');
  });
});

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

describe('pasted tables are always rectangular', () => {
  const fixtures: readonly (readonly [string, string])[] = [
    ['ragged rows', '<table><tr><td>a</td><td>b</td><td>c</td></tr><tr><td>1</td></tr></table>'],
    [
      'colspan',
      '<table><tr><td colspan="3">wide</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    ],
    [
      'rowspan',
      '<table><tr><td rowspan="2">tall</td><td>a</td></tr><tr><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
    ],
    [
      'thead and tbody',
      '<table><thead><tr><th>H1</th><th>H2</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>',
    ],
    [
      'nested markup in cells',
      '<table><tr><td><p><b>x</b></p><p>y</p></td><td><ul><li>z</li></ul></td></tr></table>',
    ],
  ];

  for (const [name, html] of fixtures) {
    it(`handles ${name}`, () => {
      const table = fromHtml(html)[0];
      if (table?.kind !== 'table') throw new Error(`expected a table for ${name}`);
      const width = table.align.length;
      expect(width).toBeGreaterThan(0);
      for (const row of table.rows) expect(row.cells).toHaveLength(width);
    });
  }

  it('expands a colspan into empty cells rather than duplicating content', () => {
    const table = fromHtml(
      '<table><tr><td colspan="3">wide</td></tr><tr><td>1</td><td>2</td><td>3</td></tr></table>',
    )[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(tableText(table)).toEqual([
      ['wide', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('expands a rowspan downwards', () => {
    const table = fromHtml(
      '<table><tr><td rowspan="2">tall</td><td>a</td></tr><tr><td>b</td></tr></table>',
    )[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(tableText(table)).toEqual([
      ['tall', 'a'],
      ['', 'b'],
    ]);
  });

  it('caps a hostile colspan instead of allocating a huge grid', () => {
    const table = fromHtml('<table><tr><td colspan="100000">x</td></tr></table>')[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align.length).toBeLessThanOrEqual(64);
  });

  it('promotes a <thead> row that is not first to the top', () => {
    const html =
      '<table><tbody><tr><td>1</td><td>2</td></tr></tbody><thead><tr><th>H1</th><th>H2</th></tr></thead></table>';
    const table = fromHtml(html)[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(tableText(table)[0]).toEqual(['H1', 'H2']);
  });

  it('uses the first row as the header when nothing is marked', () => {
    const table = fromHtml(
      '<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>',
    )[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(tableText(table)[0]).toEqual(['a', 'b']);
    expect(table.rows).toHaveLength(2);
  });

  it('reads column alignment from style or attribute', () => {
    const html =
      '<table><tr><th align="right">r</th><th style="text-align:center">c</th><th>n</th></tr>' +
      '<tr><td>1</td><td>2</td><td>3</td></tr></table>';
    const table = fromHtml(html)[0];
    if (table?.kind !== 'table') throw new Error('expected a table');
    expect(table.align).toEqual(['right', 'center', 'none']);
  });
});

/* -------------------------------------------------------------------------- */
/* Plain text                                                                  */
/* -------------------------------------------------------------------------- */

describe('plain text', () => {
  it('becomes one paragraph per line', () => {
    const blocks = blocksFromText('one\ntwo\nthree', ids());
    expect(blocks).toHaveLength(3);
    expect(asFile(writeBlocks(blocks))).toBe('one\n\ntwo\n\nthree\n');
  });

  it('is not parsed as markdown by default', () => {
    const blocks = blocksFromText('# not a heading\n- not a list', ids());
    expect(blocks.every((block) => block.kind === 'paragraph')).toBe(true);
    expect(visible(blocks)).toBe('# not a heading\u0001- not a list');
  });

  it('is parsed as markdown when asked', () => {
    const blocks = blocksFromText('# heading\n\n- item', ids(), { parseMarkdown: true });
    expect(blocks[0]?.kind).toBe('heading');
    expect(blocks[1]?.kind).toBe('list');
  });

  it('normalises CRLF and strips a BOM', () => {
    const blocks = blocksFromText('﻿one\r\ntwo\r', ids());
    expect(visible(blocks)).toBe('one\u0001two');
  });

  it('drops blank lines rather than making empty paragraphs', () => {
    expect(blocksFromText('a\n\n\n\nb', ids())).toHaveLength(2);
  });
});

describe('tab-separated text', () => {
  it('is recognised as a grid', () => {
    const grid = gridFromText('a\tb\tc\n1\t2\t3\n', ids());
    expect(grid).toBeDefined();
    expect(grid).toHaveLength(2);
    expect(grid?.[0]).toHaveLength(3);
  });

  it('is not recognised when the shape is ragged', () => {
    expect(gridFromText('a\tb\tc\n1\t2\n', ids())).toBeUndefined();
  });

  it('is not recognised for a single column', () => {
    expect(gridFromText('just prose\nwith lines\n', ids())).toBeUndefined();
  });

  it('is not fooled by one stray tab in prose', () => {
    expect(gridFromText('a sentence\twith a tab\nand another line\n', ids())).toBeUndefined();
  });

  it('keeps an empty cell empty rather than dropping the column', () => {
    const grid = gridFromText('a\t\tc', ids());
    expect(grid?.[0]).toHaveLength(3);
    expect(grid?.[0]?.[1]).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Flavour selection                                                           */
/* -------------------------------------------------------------------------- */

describe('choosing a flavour', () => {
  const payload: ClipboardPayload = {
    mdv: '# from mdv\n',
    html: '<h1>from html</h1>',
    text: 'from text',
    images: [],
  };

  it('prefers our own source when it is there', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(paste(payload));
    expect(editor.toText()).toContain('# from mdv');
  });

  it('falls back to HTML', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(paste({ html: payload.html ?? '', text: payload.text ?? '', images: [] }));
    expect(editor.toText()).toContain('# from html');
  });

  it('falls back to plain text', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(paste({ text: '# from text', images: [] }));
    // Literal, not a heading: the text joins the paragraph it was dropped into
    // instead of being re-parsed as markdown.
    expect(editor.getDocument().blocks).toHaveLength(1);
    expect(blockAt(editor.getDocument(), 0).kind).toBe('paragraph');
    expect(editor.toText()).toBe('start# from text\n');
  });

  it('escapes a plain-text paste that would otherwise become markdown', () => {
    const editor = editorFor('start\n');
    // At the head of the block the `#` would start a heading if written raw.
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 0));
    editor.dispatch(paste({ text: '# from text', images: [] }));
    expect(blockAt(editor.getDocument(), 0).kind).toBe('paragraph');
    expect(editor.toText()).toBe('\\# from textstart\n');
  });

  it('honours paste-without-formatting', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(pasteWithoutFormatting(payload));
    expect(editor.toText()).toContain('from text');
    expect(editor.toText()).not.toContain('# from mdv');
  });

  it('honours paste-as-markdown', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(pasteAsMarkdown({ text: '## real heading', images: [] }));
    expect(editor.toText()).toContain('## real heading');
  });

  it('does not apply when there is nothing usable', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    expect(editor.dispatch(paste({ images: [] }))).toBeNull();
    expect(editor.toText()).toBe('start\n');
  });

  it('replaces the selection it was pasted over', () => {
    const editor = editorFor('keep DROP keep\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(rangeIn(editor.getDocument(), id, 5, 9));
    editor.dispatch(paste({ text: 'NEW', images: [] }));
    expect(editor.toText()).toBe('keep NEW keep\n');
  });

  it('is undoable in one step however many blocks it inserted', () => {
    const editor = editorFor('start\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
    editor.dispatch(paste({ html: '<h1>a</h1><p>b</p><ul><li>c</li></ul>', images: [] }));
    expect(editor.getDocument().blocks.length).toBeGreaterThan(1);

    editor.undo();
    expect(editor.toText()).toBe('start\n');
  });
});

describe('pasting into a table', () => {
  const GRID = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';

  it('fills cells from tab-separated text instead of inserting blocks', () => {
    const editor = editorFor(GRID);
    const table = blockAt(editor.getDocument(), 0);
    if (table.kind !== 'table') throw new Error('expected a table');
    editor.select({
      kind: 'cells',
      tableId: table.id,
      anchor: { row: 1, col: 0 },
      focus: { row: 1, col: 0 },
    });
    editor.dispatch(paste({ text: 'x\ty', images: [] }));

    const after = blockAt(editor.getDocument(), 0);
    if (after.kind !== 'table') throw new Error('expected a table');
    expect(tableText(after)[1]).toEqual(['x', 'y']);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('fills cells from a copied HTML table', () => {
    const editor = editorFor(GRID);
    const table = blockAt(editor.getDocument(), 0);
    if (table.kind !== 'table') throw new Error('expected a table');
    editor.select({
      kind: 'cells',
      tableId: table.id,
      anchor: { row: 1, col: 0 },
      focus: { row: 1, col: 0 },
    });
    editor.dispatch(paste({ html: '<table><tr><td>p</td><td>q</td></tr></table>', images: [] }));

    const after = blockAt(editor.getDocument(), 0);
    if (after.kind !== 'table') throw new Error('expected a table');
    expect(tableText(after)[1]).toEqual(['p', 'q']);
  });

  it('reads a grid back out of a single pasted table block', () => {
    const blocks = fromHtml('<table><tr><td>a</td><td>b</td></tr></table>');
    const grid = gridFromBlocks(blocks);
    expect(grid).toHaveLength(1);
    expect(grid?.[0]).toHaveLength(2);
  });

  it('does not mistake several blocks for a grid', () => {
    expect(gridFromBlocks(fromHtml('<p>a</p><table><tr><td>b</td></tr></table>'))).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

describe('copying', () => {
  it('offers three flavours, with .mdv source as text/plain', () => {
    const editor = editorFor('# Title\n\nSome **bold** text.\n');
    const result = copyDocument(editor.getDocument());
    const entries = clipboardEntries(result);

    expect(entries[MDV_CLIPBOARD_TYPE]).toBe('# Title\n\nSome **bold** text.\n');
    expect(entries[TEXT_CLIPBOARD_TYPE]).toBe(entries[MDV_CLIPBOARD_TYPE]);
    expect(entries[HTML_CLIPBOARD_TYPE]).toContain('<h1>Title</h1>');
    expect(entries[HTML_CLIPBOARD_TYPE]).toContain('<strong>bold</strong>');
  });

  it('returns null for a collapsed caret rather than clearing the clipboard', () => {
    const editor = editorFor('text\n');
    const id = blockAt(editor.getDocument(), 0).id;
    expect(copySelection(editor.getDocument(), caretAt(editor.getDocument(), id, 2))).toBeNull();
  });

  it('trims a partially covered block down to what was selected', () => {
    const editor = editorFor('# A long heading\n');
    const id = blockAt(editor.getDocument(), 0).id;
    // Offsets are relative to the block's inline content, so 2..6 of the
    // heading `# A long heading` is `long` — the `# ` marker is syntax, not text.
    const result = copySelection(editor.getDocument(), rangeIn(editor.getDocument(), id, 2, 6));
    expect(result?.mdv).toBe('long');
    // Half a heading is not a heading.
    expect(result?.blocks[0]?.kind).toBe('paragraph');
  });

  it('keeps a fully covered block as itself', () => {
    const editor = editorFor('# Heading\n');
    const id = blockAt(editor.getDocument(), 0).id;
    const result = copySelection(editor.getDocument(), rangeIn(editor.getDocument(), id, 0, 7));
    expect(result?.blocks[0]?.kind).toBe('heading');
  });

  it('gives the fragment fresh ids so it can be pasted back into itself', () => {
    const editor = editorFor('one\n\ntwo\n');
    const doc = editor.getDocument();
    const fragment = fragmentOf(doc, rangeIn(doc, blockAt(doc, 0).id, 0, 3));
    const originals = new Set(doc.blocks.map((block) => block.id));
    for (const block of fragment) expect(originals.has(block.id)).toBe(false);
  });

  it('round-trips through its own HTML flavour', () => {
    const source = '# Title\n\nSome **bold** and *italic* text.\n\n- one\n- two\n';
    const editor = editorFor(source);
    const html = copyDocument(editor.getDocument()).html;
    expect(asFile(writeBlocks(fromHtml(html)))).toBe(source);
  });

  it('round-trips a table through its own HTML flavour', () => {
    const source = '| a   | b   |\n| :-- | --: |\n| 1   | 2   |\n';
    const editor = editorFor(source);
    const html = copyDocument(editor.getDocument()).html;
    expect(asFile(writeBlocks(fromHtml(html)))).toBe(source);
  });

  it('round-trips a visual block through data-mdv-source', () => {
    // Nothing else understands a visual block, so the HTML carries the source
    // verbatim and the reader takes it back as a raw block that writes the same
    // bytes out again.
    const source = '```mdv chart id=one\ntype: bar\n---\nx,y\n1,2\n```\n';
    const editor = editorFor(source);
    const html = copyDocument(editor.getDocument()).html;
    expect(html).toContain('data-mdv-source');
    expect(asFile(writeBlocks(fromHtml(html)))).toBe(source);
  });

  it('marks its own output so a paste back in can recognise it', () => {
    const editor = editorFor('text\n');
    expect(copyDocument(editor.getDocument()).html).toContain('data-mdv-fragment');
  });

  it('can emit unwrapped HTML for embedding', () => {
    const blocks = fromHtml('<p>x</p>');
    expect(blocksToHtml(blocks, { wrap: false })).toBe('<p>x</p>');
  });

  it('nests marks so that code is innermost', () => {
    const blocks = fromHtml('<p><a href="https://e.com"><strong><code>x</code></strong></a></p>');
    const paragraph = blocks[0];
    if (paragraph?.kind !== 'paragraph') throw new Error('expected a paragraph');
    const html = inlineToHtml(paragraph.runs);
    expect(html).toBe('<a href="https://e.com"><strong><code>x</code></strong></a>');
  });

  it('escapes user content in every attribute it writes', () => {
    const editor = editorFor('[x](https://e.com/?a=1&b="2")\n');
    const html = copyDocument(editor.getDocument()).html;
    expect(html).not.toContain('&b="2"');
    expect(html).toContain('&amp;b=&quot;2&quot;');
  });
});

/* -------------------------------------------------------------------------- */
/* DataTransfer                                                                */
/* -------------------------------------------------------------------------- */

describe('reading a DataTransfer', () => {
  function transfer(
    data: Record<string, string>,
    extra: Partial<DataTransferLike> = {},
  ): DataTransferLike {
    return {
      types: Object.keys(data),
      getData: (type) => data[type] ?? '',
      ...extra,
    };
  }

  it('picks up every flavour it knows', () => {
    const payload = readClipboardPayload(
      transfer({
        [MDV_CLIPBOARD_TYPE]: 'mdv source',
        [HTML_CLIPBOARD_TYPE]: '<p>html</p>',
        [TEXT_CLIPBOARD_TYPE]: 'plain',
      }),
    );

    expect(payload.mdv).toBe('mdv source');
    expect(payload.html).toBe('<p>html</p>');
    expect(payload.text).toBe('plain');
    expect(payload.images).toEqual([]);
  });

  it('copes with a transfer that has no getData at all', () => {
    expect(() => readClipboardPayload({})).not.toThrow();
    expect(readClipboardPayload({}).images).toEqual([]);
  });

  it('finds an image in files', () => {
    const file = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    const payload = readClipboardPayload(transfer({}, { files: [file] }));
    expect(payload.images).toHaveLength(1);
  });

  it('finds an image in items when files is empty', () => {
    const file = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    const payload = readClipboardPayload(
      transfer(
        {},
        { files: [], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      ),
    );
    expect(payload.images).toHaveLength(1);
  });

  it('does not report the same image twice when both are populated', () => {
    const file = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    const payload = readClipboardPayload(
      transfer(
        {},
        { files: [file], items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] },
      ),
    );
    expect(payload.images).toHaveLength(1);
  });

  it('ignores non-image files', () => {
    const file = {
      type: 'application/pdf',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    expect(imagesFrom(transfer({}, { files: [file] }))).toEqual([]);
  });

  it('recognises an image-only paste', () => {
    const file = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    expect(isImageOnly({ images: [file] })).toBe(true);
    expect(isImageOnly({ images: [file], text: 'caption' })).toBe(false);
    expect(isImageOnly({ images: [] })).toBe(false);
  });

  it('treats the HTML wrapper Chrome adds around a copied image as image-only', () => {
    // Chrome puts `<img src="...">` in text/html next to the real blob. Treating
    // that as content would insert the image twice, once as a remote link.
    const file = {
      type: 'image/png',
      size: 4,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(4)),
    };
    expect(isImageOnly({ images: [file], html: '<img src="https://example.com/a.png">' })).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* No loss                                                                     */
/* -------------------------------------------------------------------------- */

describe('no visible character is lost by any fixture', () => {
  const fixtures: Readonly<Record<string, string>> = {
    google_docs: GOOGLE_DOCS,
    word_list: WORD_LIST,
    nested: '<div><div><p>a<span>b<em>c</em></span>d</p></div></div>',
    table:
      '<table><tr><td>1</td><td colspan=2>2</td></tr><tr><td>a</td><td>b</td><td>c</td></tr></table>',
    mixed: '<h1>H</h1><p>p</p><ul><li>l1<ul><li>l2</li></ul></li></ul><pre><code>code</code></pre>',
    entities: '<p>&lt;kept&gt;&nbsp;&amp;&nbsp;&quot;quoted&quot;</p>',
  };

  for (const [name, html] of Object.entries(fixtures)) {
    it(name, () => {
      const blocks = fromHtml(html);
      const text = visible(blocks);
      // Every non-space character of the source text must appear in the output.
      const expected = textFromHtml(html).replace(/[\s\u00a0]+/gu, '');
      // The engine's own soft marker (U+0001) is stripped here on purpose.
      // eslint-disable-next-line no-control-regex
      const actual = text.replace(/[\s\u00a0\u0001]+/gu, '');
      for (const character of new Set(expected)) {
        if (character === '·' || character === 'o') continue; // Word bullet glyphs
        expect(actual).toContain(character);
      }
    });
  }

  it('is idempotent: pasting our own HTML twice gives the same blocks', () => {
    const once = fromHtml(GOOGLE_DOCS);
    const twice = fromHtml(blocksToHtml(once));
    expect(writeBlocks(twice)).toBe(writeBlocks(once));
  });
});

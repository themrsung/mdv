/**
 * Regressions found by authoring a document through the editor UI.
 *
 * Each case here is a gesture a writer actually made — select all, Enter,
 * Backspace, the quote button, a click below the last block — that the engine
 * answered in a way that left no way forward except editing the source by
 * hand. They live together rather than in the suite for the command each one
 * happens to exercise, because what they have in common is not the command: it
 * is that the keyboard was the only way in, and it was a dead end.
 */

import { describe, expect, it } from 'vitest';
import {
  appendParagraph,
  deleteBackward,
  insertParagraphAfter,
  insertText,
  outdent,
  setBlockType,
  setCodeInfo,
  splitBlock,
  toggleMark,
} from '../commands/index.js';
import type { Editor } from '../editor.js';
import { wholeDocument } from '../selection.js';
import { blockAt, caretAt, editorFor, source } from './helpers.js';

/** Ctrl/Cmd+A, as the surface performs it. */
function selectAll(editor: Editor): void {
  const selection = wholeDocument(editor.getDocument());
  expect(selection).toBeDefined();
  if (selection) editor.select(selection);
}

/** The last child of a blockquote, which is what Enter is aimed at. */
function lastQuotedChild(editor: Editor, index = 0) {
  const quote = blockAt(editor.getDocument(), index);
  if (quote.kind !== 'blockquote') throw new Error(`block ${index} is a ${quote.kind}`);
  const child = quote.children[quote.children.length - 1];
  if (!child) throw new Error('empty blockquote');
  return child;
}

const TOUR = `# Tour

Intro paragraph.

| Quarter | Revenue |
| ------- | ------- |
| Q1      | 1200    |
| Q2      | 1810    |
`;

const FENCE = '```ts\nconst a = 1;\n```\n';

const METRIC = `Intro.

\`\`\`mdv metric
label: X
value: 1
\`\`\`
`;

describe('select all then Backspace', () => {
  it('empties a document that ends in a table', () => {
    const editor = editorFor(TOUR);
    selectAll(editor);
    editor.dispatch(deleteBackward());

    const doc = editor.getDocument();
    expect(doc.blocks).toHaveLength(1);
    expect(blockAt(doc, 0).kind).toBe('paragraph');
    expect(source(doc)).toBe('');
  });

  it('empties a document that ends in a visual block', () => {
    const editor = editorFor(METRIC);
    selectAll(editor);
    editor.dispatch(deleteBackward());

    const doc = editor.getDocument();
    expect(doc.blocks).toHaveLength(1);
    expect(blockAt(doc, 0).kind).toBe('paragraph');
    expect(source(doc)).toBe('');
  });

  it('undoes to the byte-identical document', () => {
    const editor = editorFor(TOUR);
    const before = source(editor.getDocument());
    selectAll(editor);
    editor.dispatch(deleteBackward());
    editor.undo();

    expect(source(editor.getDocument())).toBe(before);
  });

  it('leaves the heading level behind rather than blanking into a heading', () => {
    const editor = editorFor('# Title\n\nBody.\n');
    selectAll(editor);
    editor.dispatch(deleteBackward());

    expect(blockAt(editor.getDocument(), 0).kind).toBe('paragraph');
  });
});

describe('Enter in a blockquote', () => {
  it('leaves the quote from an empty trailing paragraph', () => {
    const editor = editorFor('> Quoted.\n');
    editor.select(caretAt(editor.getDocument(), lastQuotedChild(editor).id, 7));

    // Enter once to open the empty paragraph, Enter again to leave: the gesture
    // every editor shares for getting out of a container.
    expect(editor.dispatch(splitBlock())).not.toBeNull();
    expect(editor.dispatch(splitBlock())).not.toBeNull();

    const doc = editor.getDocument();
    expect(doc.blocks.map((block) => block.kind)).toEqual(['blockquote', 'paragraph']);
    const quote = blockAt(doc, 0);
    if (quote.kind !== 'blockquote') throw new Error('the quote vanished');
    expect(quote.children).toHaveLength(1);
    expect(source(doc)).toBe('> Quoted.\n');
  });

  it('undoes both keystrokes back to the original quote', () => {
    const editor = editorFor('> Quoted.\n');
    const before = source(editor.getDocument());
    editor.select(caretAt(editor.getDocument(), lastQuotedChild(editor).id, 7));
    editor.dispatch(splitBlock());
    editor.dispatch(splitBlock());
    editor.undo();
    editor.undo();

    expect(source(editor.getDocument())).toBe(before);
  });

  it('splits the quote when the paragraph left behind is not its last', () => {
    const editor = editorFor('> One.\n>\n> Two.\n');
    const doc = editor.getDocument();
    const quote = blockAt(doc, 0);
    if (quote.kind !== 'blockquote') throw new Error('not a quote');
    const first = quote.children[0];
    if (!first) throw new Error('no child');
    editor.select(caretAt(doc, first.id, 4));
    editor.dispatch(splitBlock());
    editor.dispatch(splitBlock());

    // The children after the caret keep their quoting; only the paragraph the
    // writer is standing in comes out, between the two halves.
    const kinds = editor.getDocument().blocks.map((block) => block.kind);
    expect(kinds).toEqual(['blockquote', 'paragraph', 'blockquote']);
    // The empty paragraph between them is a blank line either way, so the
    // source cannot show it; the block kinds above are the real assertion.
    expect(source(editor.getDocument())).toBe('> One.\n\n> Two.\n');
  });
});

describe('outdent in a blockquote', () => {
  it('lifts the paragraph out when there is no list to outdent', () => {
    const editor = editorFor('> Quoted.\n');
    editor.select(caretAt(editor.getDocument(), lastQuotedChild(editor).id, 0));

    expect(editor.dispatch(outdent())).not.toBeNull();
    expect(source(editor.getDocument())).toBe('Quoted.\n');
  });

  it('still refuses when there is nothing to outdent at all', () => {
    const editor = editorFor('Plain.\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 0));

    expect(editor.dispatch(outdent())).toBeNull();
  });
});

describe('the quote button', () => {
  it('unquotes only the paragraph the caret is in', () => {
    const editor = editorFor('> One.\n>\n> Two.\n\nAfter.\n');
    const doc = editor.getDocument();
    const quote = blockAt(doc, 0);
    if (quote.kind !== 'blockquote') throw new Error('not a quote');
    const first = quote.children[0];
    if (!first) throw new Error('no child');
    editor.select(caretAt(doc, first.id, 0));
    editor.dispatch(setBlockType({ kind: 'quote' }));

    expect(source(editor.getDocument())).toBe('One.\n\n> Two.\n\nAfter.\n');
  });

  it('unquotes the whole quote when the selection covers it', () => {
    const editor = editorFor('> One.\n>\n> Two.\n');
    selectAll(editor);
    editor.dispatch(setBlockType({ kind: 'quote' }));

    expect(source(editor.getDocument())).toBe('One.\n\nTwo.\n');
  });
});

describe('appendParagraph', () => {
  it('opens a paragraph after a trailing table', () => {
    const editor = editorFor(TOUR);
    expect(editor.dispatch(appendParagraph())).not.toBeNull();

    const doc = editor.getDocument();
    const last = blockAt(doc, doc.blocks.length - 1);
    expect(last.kind).toBe('paragraph');

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    if (selection.kind === 'text') expect(selection.focus.blockId).toBe(last.id);
  });

  it('refuses when the document already ends in an empty paragraph', () => {
    const editor = editorFor(TOUR);
    editor.dispatch(appendParagraph());

    expect(editor.dispatch(appendParagraph())).toBeNull();
  });

  it('undoes to the byte-identical document', () => {
    const editor = editorFor(TOUR);
    const before = source(editor.getDocument());
    editor.dispatch(appendParagraph());
    editor.undo();

    expect(source(editor.getDocument())).toBe(before);
  });

  it('opens a paragraph after a trailing code fence', () => {
    // Enter inside a fence is a newline, so the keyboard cannot reach the space
    // after it either; the click below the fence is the only way out.
    const editor = editorFor(FENCE);
    expect(editor.dispatch(appendParagraph())).not.toBeNull();

    const doc = editor.getDocument();
    expect(doc.blocks.map((block) => block.kind)).toEqual(['code', 'paragraph']);
    // An empty trailing paragraph is a blank line, which the source cannot
    // show; that it is there to be typed into is the whole of the fix.
    expect(source(doc)).toBe(FENCE);

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    const last = blockAt(doc, doc.blocks.length - 1);
    if (selection.kind === 'text') expect(selection.focus.blockId).toBe(last.id);
  });
});

/**
 * Bug 10: a selected block was a keyboard trap. Every key was a no-op on it
 * except Backspace, so a document that ended in a chart could be left only by
 * destroying the chart. Enter is the way out that keeps it.
 */
describe('insertParagraphAfter', () => {
  it('opens a paragraph after a selected visual block', () => {
    const editor = editorFor(METRIC);
    const metric = blockAt(editor.getDocument(), 1);
    expect(editor.dispatch(insertParagraphAfter(metric.id))).not.toBeNull();

    const doc = editor.getDocument();
    expect(doc.blocks.map((block) => block.kind)).toEqual(['paragraph', 'visual', 'paragraph']);
    // The block the writer was standing on is still there: this is Enter, not
    // a replacement.
    expect(blockAt(doc, 1).id).toBe(metric.id);

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    if (selection.kind === 'text') expect(selection.focus.blockId).toBe(blockAt(doc, 2).id);
  });

  it('opens the paragraph in the middle, not at the end', () => {
    const editor = editorFor(TOUR);
    const heading = blockAt(editor.getDocument(), 0);
    editor.dispatch(insertParagraphAfter(heading.id));

    const doc = editor.getDocument();
    expect(doc.blocks.map((block) => block.kind)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'table',
    ]);
    expect(source(doc)).toBe(TOUR);
  });

  it('writes inside the container the block lives in', () => {
    const editor = editorFor('> Quoted.\n');
    const quote = blockAt(editor.getDocument(), 0);
    if (quote.kind !== 'blockquote') throw new Error(`block 0 is a ${quote.kind}`);
    const quoted = quote.children[0];
    expect(quoted).toBeDefined();
    if (!quoted) return;
    editor.dispatch(insertParagraphAfter(quoted.id));

    const doc = editor.getDocument();
    expect(doc.blocks).toHaveLength(1);
    const after = blockAt(doc, 0);
    if (after.kind !== 'blockquote') throw new Error(`block 0 is a ${after.kind}`);
    expect(after.children).toHaveLength(2);

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    const second = after.children[1];
    if (selection.kind === 'text' && second) expect(selection.focus.blockId).toBe(second.id);
  });

  it('refuses a block that is not in the document', () => {
    const editor = editorFor(TOUR);
    expect(editor.dispatch(insertParagraphAfter('mdv-nope'))).toBeNull();
  });

  it('undoes to the byte-identical document', () => {
    const editor = editorFor(METRIC);
    const before = source(editor.getDocument());
    editor.dispatch(insertParagraphAfter(blockAt(editor.getDocument(), 1).id));
    editor.undo();

    expect(source(editor.getDocument())).toBe(before);
  });
});

describe('setCodeInfo', () => {
  it('names the language of a fence that had none', () => {
    const editor = editorFor('```\nconst a = 1;\n```\n');
    const code = blockAt(editor.getDocument(), 0);
    expect(editor.dispatch(setCodeInfo(code.id, 'ts'))).not.toBeNull();

    expect(source(editor.getDocument())).toBe('```ts\nconst a = 1;\n```\n');
  });

  it('replaces a language the fence already had', () => {
    const editor = editorFor(FENCE);
    const code = blockAt(editor.getDocument(), 0);
    editor.dispatch(setCodeInfo(code.id, 'tsx'));

    const block = blockAt(editor.getDocument(), 0);
    expect(block.kind).toBe('code');
    if (block.kind === 'code') expect(block.info).toBe('tsx');
  });

  it('clears the language when the field is emptied', () => {
    const editor = editorFor(FENCE);
    const code = blockAt(editor.getDocument(), 0);
    editor.dispatch(setCodeInfo(code.id, '   '));

    // Trimmed to nothing, and written as a bare fence rather than one with a
    // trailing space: the round trip has to land on the document it started at.
    expect(source(editor.getDocument())).toBe('```\nconst a = 1;\n```\n');
  });

  it('refuses a block that is not a fence', () => {
    const editor = editorFor('Plain.\n');
    const paragraph = blockAt(editor.getDocument(), 0);

    expect(editor.dispatch(setCodeInfo(paragraph.id, 'ts'))).toBeNull();
  });

  it('refuses an info string the fence already carries', () => {
    const editor = editorFor(FENCE);
    const code = blockAt(editor.getDocument(), 0);

    expect(editor.dispatch(setCodeInfo(code.id, 'ts'))).toBeNull();
  });

  it('coalesces a typed language into one undo step', () => {
    const editor = editorFor('```\nconst a = 1;\n```\n');
    const before = source(editor.getDocument());
    const id = blockAt(editor.getDocument(), 0).id;
    // Keystroke by keystroke, the way a controlled input reports itself.
    for (const info of ['t', 'ty', 'typ', 'type', 'types', 'typesc']) {
      editor.dispatch(setCodeInfo(id, info));
    }
    editor.undo();

    expect(source(editor.getDocument())).toBe(before);
  });
});

describe('typing at the end of a link', () => {
  const LINK = 'See [docs](https://example.com/mdv)\n';
  /** The offset just past the link text, where the caret lands after clicking. */
  const AFTER = 'See docs'.length;

  it('leaves the punctuation that follows outside the link', () => {
    const editor = editorFor(LINK);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, AFTER));
    editor.dispatch(insertText('.'));

    // The sentence a writer means: the period is theirs, not the anchor's.
    expect(source(editor.getDocument())).toBe('See [docs](https://example.com/mdv).\n');
  });

  it('still extends the link from inside it', () => {
    const editor = editorFor(LINK);
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, AFTER - 1));
    editor.dispatch(insertText('e'));

    expect(source(editor.getDocument())).toBe('See [doces](https://example.com/mdv)\n');
  });

  it('does not link what is typed in front of one', () => {
    const editor = editorFor('[docs](https://example.com/mdv) it\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 0));
    editor.dispatch(insertText('Read '));

    expect(source(editor.getDocument())).toBe('Read [docs](https://example.com/mdv) it\n');
  });

  it('keeps the other marks the link was wearing', () => {
    // Bold *is* inclusive: the writer emboldened a word and kept typing. Only
    // the link drops away, so the tail is bold and outside the anchor.
    const editor = editorFor('[**docs**](https://example.com/mdv)\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 'docs'.length));
    editor.dispatch(insertText(' too'));

    expect(source(editor.getDocument())).toBe('[**docs**](https://example.com/mdv)** too**\n');
  });

  it('honours a link the writer asked for by hand', () => {
    // pendingMarks beats inheritance: "make a link, then type it" must work,
    // which is the one gesture the non-inclusive rule must not break.
    const editor = editorFor('Word\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 4));
    editor.dispatch(toggleMark({ type: 'link', href: 'https://example.com/mdv', title: null }));
    editor.dispatch(insertText('ing'));

    expect(source(editor.getDocument())).toBe('Word[ing](https://example.com/mdv)\n');
  });
});

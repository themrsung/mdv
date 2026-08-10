/**
 * Commands, and their inverses under undo.
 *
 * The recurring shape here is: capture the source, run a command, assert the
 * new source, undo, assert the source is byte-identical to what we started
 * with. That second half is the one that catches real bugs — it is easy to
 * write a command that produces the right document and a broken history entry,
 * and impossible to notice until a user loses work.
 */

import { describe, expect, it } from 'vitest';
import {
  deleteBackward,
  deleteForward,
  indent,
  insertImage,
  insertTable,
  insertText,
  insertThematicBreak,
  insertVisualBlock,
  mergeBackward,
  outdent,
  setBlockType,
  splitBlock,
  toggleMark,
} from '../commands/index.js';
import { at, blockAt, caretAt, editorFor, rangeAcross, rangeIn, source, textOf } from './helpers.js';
import { caret } from '../selection.js';

describe('insertText', () => {
  it('inserts at a caret and undoes exactly', () => {
    const editor = editorFor('Hello world.\n');
    const before = editor.toText();
    const paragraph = blockAt(editor.getDocument(), 0);

    editor.select(caretAt(editor.getDocument(), paragraph.id, 5));
    editor.dispatch(insertText(','));

    expect(editor.toText()).toBe('Hello, world.\n');
    expect(editor.undo()).toBe(true);
    expect(editor.toText()).toBe(before);
  });

  it('replaces a ranged selection', () => {
    const editor = editorFor('Hello world.\n');
    const paragraph = blockAt(editor.getDocument(), 0);

    editor.select(rangeIn(editor.getDocument(), paragraph.id, 6, 11));
    editor.dispatch(insertText('there'));

    expect(editor.toText()).toBe('Hello there.\n');
  });

  it('leaves the caret after the inserted text', () => {
    const editor = editorFor('ab\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 1));
    editor.dispatch(insertText('XYZ'));

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    if (selection.kind !== 'text') return;
    expect(editor.toText()).toBe('aXYZb\n');
    // Typing again must continue from where we stopped, not jump.
    editor.dispatch(insertText('!'));
    expect(editor.toText()).toBe('aXYZ!b\n');
  });

  it('carries marks from the character to the left', () => {
    const editor = editorFor('**bold** tail\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 4));
    editor.dispatch(insertText('er'));

    expect(editor.toText()).toBe('**bolder** tail\n');
  });

  it('inserts literally inside a code block', () => {
    const editor = editorFor('```js\nconst a = 1;\n```\n');
    const code = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), code.id, 0));
    editor.dispatch(insertText('// '));

    expect(editor.toText()).toBe('```js\n// const a = 1;\n```\n');
  });
});

describe('splitBlock', () => {
  it('splits a paragraph in two and undoes', () => {
    const editor = editorFor('one two\n');
    const before = editor.toText();
    const paragraph = blockAt(editor.getDocument(), 0);

    editor.select(caretAt(editor.getDocument(), paragraph.id, 3));
    editor.dispatch(splitBlock());

    expect(editor.toText()).toBe('one\n\n two\n');
    expect(editor.getDocument().blocks).toHaveLength(2);

    editor.undo();
    expect(editor.toText()).toBe(before);
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('starts a paragraph after a heading rather than a second heading', () => {
    const editor = editorFor('# Title\n');
    const headingBlock = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), headingBlock.id, 5));
    editor.dispatch(splitBlock());

    const blocks = editor.getDocument().blocks;
    expect(blocks[0]?.kind).toBe('heading');
    expect(blocks[1]?.kind).toBe('paragraph');
    expect(editor.toText()).toBe('# Title\n');
  });

  it('adds a newline inside a code block instead of a new block', () => {
    const editor = editorFor('```\nab\n```\n');
    const code = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), code.id, 1));
    editor.dispatch(splitBlock());

    expect(editor.getDocument().blocks).toHaveLength(1);
    expect(editor.toText()).toBe('```\na\nb\n```\n');
  });

  it('makes a new list item when splitting at the end of one', () => {
    const editor = editorFor('- one\n- two\n');
    const list = blockAt(editor.getDocument(), 0);
    if (list.kind !== 'list') throw new Error('expected a list');
    const firstItem = list.items[0]?.blocks[0];
    if (!firstItem) throw new Error('expected an item');

    editor.select(caretAt(editor.getDocument(), firstItem.id, 3));
    editor.dispatch(splitBlock());

    const after = blockAt(editor.getDocument(), 0);
    if (after.kind !== 'list') throw new Error('expected a list');
    expect(after.items).toHaveLength(3);
  });

  it('outdents an empty list item rather than nesting forever', () => {
    const editor = editorFor('- one\n- two\n');
    const list = blockAt(editor.getDocument(), 0);
    if (list.kind !== 'list') throw new Error('expected a list');
    const second = list.items[1]?.blocks[0];
    if (!second) throw new Error('expected a second item');

    // Empty the second item, then press Enter in it.
    editor.select(rangeIn(editor.getDocument(), second.id, 0, 3));
    editor.dispatch(deleteBackward());
    editor.dispatch(splitBlock());

    const blocks = editor.getDocument().blocks;
    const remaining = blocks[0];
    expect(remaining?.kind).toBe('list');
    if (remaining?.kind !== 'list') return;
    expect(remaining.items).toHaveLength(1);
    expect(blocks[1]?.kind).toBe('paragraph');
  });
});

describe('deleteBackward and deleteForward', () => {
  it('deletes one character and undoes', () => {
    const editor = editorFor('abc\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 2));

    editor.dispatch(deleteBackward());
    expect(editor.toText()).toBe('ac\n');
    editor.undo();
    expect(editor.toText()).toBe('abc\n');
  });

  it('deleteForward removes the character to the right', () => {
    const editor = editorFor('abc\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 1));

    editor.dispatch(deleteForward());
    expect(editor.toText()).toBe('ac\n');
  });

  it('merges into the previous paragraph at the start of a block', () => {
    const editor = editorFor('one\n\ntwo\n');
    const second = blockAt(editor.getDocument(), 1);
    editor.select(caretAt(editor.getDocument(), second.id, 0));

    editor.dispatch(deleteBackward());
    expect(editor.getDocument().blocks).toHaveLength(1);
    expect(editor.toText()).toBe('onetwo\n');

    editor.undo();
    expect(editor.toText()).toBe('one\n\ntwo\n');
  });

  it('turns a heading into a paragraph before merging it away', () => {
    const editor = editorFor('# Title\n');
    const headingBlock = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), headingBlock.id, 0));

    editor.dispatch(mergeBackward());
    expect(blockAt(editor.getDocument(), 0).kind).toBe('paragraph');
    expect(editor.toText()).toBe('Title\n');
  });

  it('deletes a selection spanning two blocks', () => {
    const editor = editorFor('alpha\n\nbeta\n');
    const first = blockAt(editor.getDocument(), 0);
    const second = blockAt(editor.getDocument(), 1);
    editor.select(rangeAcross(editor.getDocument(), first.id, 2, second.id, 2));

    editor.dispatch(deleteBackward());
    expect(editor.toText()).toBe('alta\n');
    editor.undo();
    expect(editor.toText()).toBe('alpha\n\nbeta\n');
  });

  it('does nothing at the very start of the document', () => {
    const editor = editorFor('abc\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 0));

    expect(editor.dispatch(deleteBackward())).toBeNull();
    expect(editor.toText()).toBe('abc\n');
  });

  it('selects an atomic block before deleting it', () => {
    const editor = editorFor('---\n\ntext\n');
    const paragraph = blockAt(editor.getDocument(), 1);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 0));

    editor.dispatch(deleteBackward());
    expect(editor.getSelection().kind).toBe('node');
    expect(editor.getDocument().blocks).toHaveLength(2);

    editor.dispatch(deleteBackward());
    expect(editor.getDocument().blocks).toHaveLength(1);
    expect(editor.toText()).toBe('text\n');
  });
});

describe('setBlockType', () => {
  it('promotes a paragraph to a heading and back', () => {
    const editor = editorFor('Title\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 0));

    editor.dispatch(setBlockType({ kind: 'heading', level: 2 }));
    expect(editor.toText()).toBe('## Title\n');

    editor.dispatch(setBlockType({ kind: 'paragraph' }));
    expect(editor.toText()).toBe('Title\n');
  });

  it('toggles a blockquote on and off', () => {
    const editor = editorFor('quoted\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 0));

    editor.dispatch(setBlockType({ kind: 'quote' }));
    expect(editor.toText()).toBe('> quoted\n');

    editor.dispatch(setBlockType({ kind: 'quote' }));
    expect(editor.toText()).toBe('quoted\n');
  });

  it('wraps contiguous paragraphs into one list', () => {
    const editor = editorFor('one\n\ntwo\n');
    const first = blockAt(editor.getDocument(), 0);
    const second = blockAt(editor.getDocument(), 1);
    editor.select(rangeAcross(editor.getDocument(), first.id, 0, second.id, 3));

    editor.dispatch(setBlockType({ kind: 'bulletList' }));
    expect(editor.toText()).toBe('- one\n- two\n');
    expect(editor.getDocument().blocks).toHaveLength(1);
  });

  it('splits a code block into one paragraph per line', () => {
    const editor = editorFor('```\na\nb\n```\n');
    const code = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), code.id, 0));

    editor.dispatch(setBlockType({ kind: 'paragraph' }));
    expect(editor.getDocument().blocks).toHaveLength(2);
    expect(editor.toText()).toBe('a\n\nb\n');
  });
});

describe('toggleMark', () => {
  it('bolds a range and unbolds it again', () => {
    const editor = editorFor('make me bold\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(rangeIn(editor.getDocument(), paragraph.id, 8, 12));

    editor.dispatch(toggleMark('strong'));
    expect(editor.toText()).toBe('make me **bold**\n');

    editor.dispatch(toggleMark('strong'));
    expect(editor.toText()).toBe('make me bold\n');
  });

  it('removes the mark only when every character has it', () => {
    const editor = editorFor('**a**b\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(rangeIn(editor.getDocument(), paragraph.id, 0, 2));

    // Half the range is bold, so the toggle must add rather than remove.
    editor.dispatch(toggleMark('strong'));
    expect(editor.toText()).toBe('**ab**\n');
  });

  it('parks a mark on the caret for the next keystroke', () => {
    const editor = editorFor('x\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 1));

    editor.dispatch(toggleMark('emphasis'));
    expect(editor.getState().pendingMarks).toHaveLength(1);
    expect(editor.toText()).toBe('x\n');

    editor.dispatch(insertText('y'));
    expect(editor.toText()).toBe('x*y*\n');
  });

  it('applies a link with an href even over already-linked text', () => {
    const editor = editorFor('click\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(rangeIn(editor.getDocument(), paragraph.id, 0, 5));

    editor.dispatch(toggleMark({ type: 'link', href: 'https://example.com', title: null }));
    expect(editor.toText()).toBe('[click](https://example.com)\n');

    editor.dispatch(toggleMark({ type: 'link', href: 'https://other.example', title: null }));
    expect(editor.toText()).toBe('[click](https://other.example)\n');
  });

  it('undoes formatting exactly', () => {
    const editor = editorFor('plain text\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(rangeIn(editor.getDocument(), paragraph.id, 0, 5));

    editor.dispatch(toggleMark('strikethrough'));
    expect(editor.toText()).toBe('~~plain~~ text\n');
    editor.undo();
    expect(editor.toText()).toBe('plain text\n');
  });
});

describe('indent and outdent', () => {
  it('nests a list item and restores it', () => {
    const editor = editorFor('- one\n- two\n');
    const list = blockAt(editor.getDocument(), 0);
    if (list.kind !== 'list') throw new Error('expected a list');
    const second = list.items[1]?.blocks[0];
    if (!second) throw new Error('expected a second item');

    editor.select(caretAt(editor.getDocument(), second.id, 0));
    editor.dispatch(indent());
    expect(editor.toText()).toBe('- one\n  - two\n');

    editor.dispatch(outdent());
    expect(editor.toText()).toBe('- one\n- two\n');
  });

  it('refuses to indent the first item of a list', () => {
    const editor = editorFor('- only\n');
    const list = blockAt(editor.getDocument(), 0);
    if (list.kind !== 'list') throw new Error('expected a list');
    const first = list.items[0]?.blocks[0];
    if (!first) throw new Error('expected an item');

    editor.select(caretAt(editor.getDocument(), first.id, 0));
    expect(editor.dispatch(indent())).toBeNull();
  });

  it('outdents a top-level item out of its list', () => {
    const editor = editorFor('- one\n');
    const list = blockAt(editor.getDocument(), 0);
    if (list.kind !== 'list') throw new Error('expected a list');
    const first = list.items[0]?.blocks[0];
    if (!first) throw new Error('expected an item');

    editor.select(caretAt(editor.getDocument(), first.id, 0));
    editor.dispatch(outdent());
    expect(editor.toText()).toBe('one\n');
  });
});

describe('insertion commands', () => {
  it('inserts an image with its dimensions', () => {
    const editor = editorFor('text\n');
    const paragraph = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), paragraph.id, 4));

    editor.dispatch(insertImage('pic.png', { alt: 'a picture', width: 100, height: 50 }));
    const image = blockAt(editor.getDocument(), 1);
    expect(image.kind).toBe('image');
    if (image.kind !== 'image') return;
    expect(image.width).toBe(100);
    expect(image.height).toBe(50);
  });

  it('inserts a rectangular table with the caret in the first cell', () => {
    const editor = editorFor('intro\n');
    editor.select(caret(at(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5)));
    editor.dispatch(insertTable(3, 2));

    const table = editor.getDocument().blocks.find((block) => block.kind === 'table');
    expect(table).toBeDefined();
    if (table?.kind !== 'table') return;
    expect(table.align).toHaveLength(3);
    expect(table.rows).toHaveLength(3);
    for (const row of table.rows) expect(row.cells).toHaveLength(3);

    const selection = editor.getSelection();
    expect(selection.kind).toBe('text');
    if (selection.kind !== 'text') return;
    expect(selection.anchor.path.slice(0, 2)).toEqual([0, 0]);
  });

  it('inserts a visual block that is header-only when no data is given', () => {
    const editor = editorFor('text\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 4));

    editor.dispatch(insertVisualBlock('chart', { header: 'type: bar' }));
    expect(editor.toText()).toBe('text\n\n```mdv chart\ntype: bar\n```\n');
  });

  it('emits the separator when a visual block has an empty data section', () => {
    const editor = editorFor('text\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 4));

    editor.dispatch(insertVisualBlock('chart', { header: 'type: bar', data: '' }));
    expect(editor.toText()).toContain('---');
  });

  it('inserts a thematic break and undoes it', () => {
    const editor = editorFor('a\n');
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 1));

    editor.dispatch(insertThematicBreak());
    expect(editor.getDocument().blocks).toHaveLength(2);
    editor.undo();
    expect(editor.getDocument().blocks).toHaveLength(1);
  });
});

describe('every command survives a round trip through the writer', () => {
  it('keeps the document readable after a long sequence of edits', () => {
    const editor = editorFor('# Doc\n\nBody text.\n');
    const heading = blockAt(editor.getDocument(), 0);

    editor.select(caretAt(editor.getDocument(), heading.id, 5));
    editor.dispatch(insertText('ument'));
    editor.dispatch(splitBlock());
    editor.dispatch(insertText('New paragraph'));
    editor.dispatch(setBlockType({ kind: 'bulletList' }));
    editor.dispatch(insertTable(2, 1));

    const text = editor.toText();
    const reread = editorFor(text);
    expect(reread.toText()).toBe(text);
    expect(textOf(blockAt(editor.getDocument(), 0))).toBe('Document');
    expect(source(editor.getDocument())).toBe(text);
  });
});

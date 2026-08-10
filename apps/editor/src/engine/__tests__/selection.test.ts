/**
 * Selection normalisation and mapping.
 *
 * Two separate guarantees are tested here.
 *
 * *Normalisation* is a safety property: no matter what a caller hands the
 * engine — a stale point, an offset past the end, a range that starts after it
 * ends — what gets committed addresses real content. The UI is going to produce
 * garbage selections from time to time; this is where they are neutralised.
 *
 * *Mapping* is a quality property: after an edit, the caret must be where the
 * user's finger expects, not merely somewhere legal. Clamping satisfies
 * normalisation and fails mapping, which is why the engine records edit steps
 * instead of re-deriving positions.
 */

import { describe, expect, it } from 'vitest';

import { deleteBackward, insertText, mergeBackward, splitBlock } from '../commands/index.js';
import { MappingBuilder, mapSelection } from '../mapping.js';
import {
  caret,
  isCollapsed,
  isNormalized,
  normalizeSelection,
  orderedPoints,
  point,
  range,
} from '../selection.js';
import {
  absoluteOf,
  at,
  blockAt,
  caretAt,
  editorFor,
  inCell,
  rangeAcross,
  rangeIn,
} from './helpers.js';

describe('normalisation', () => {
  it('clamps an offset past the end of a block', () => {
    const editor = editorFor('abc\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;

    const wild = caret(point(id, [0], 999));
    const fixed = normalizeSelection(doc, wild);
    expect(isNormalized(doc, fixed)).toBe(true);
    if (fixed.kind !== 'text') throw new Error('expected a text selection');
    expect(fixed.anchor.offset).toBe(3);
  });

  it('rescues a point that names a block which no longer exists', () => {
    const editor = editorFor('abc\n');
    const doc = editor.getDocument();
    const fixed = normalizeSelection(doc, caret(point('ghost', [0], 0)));
    expect(isNormalized(doc, fixed)).toBe(true);
  });

  it('orders the endpoints of a backwards selection', () => {
    const editor = editorFor('alpha\n\nbeta\n');
    const doc = editor.getDocument();
    const first = blockAt(doc, 0).id;
    const second = blockAt(doc, 1).id;

    const backwards = range(at(doc, second, 2), at(doc, first, 1));
    const [start, end] = orderedPoints(doc, backwards);
    expect(start.blockId).toBe(first);
    expect(end.blockId).toBe(second);
  });

  it('turns a selection across two cells into a cell selection', () => {
    const editor = editorFor('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    const doc = editor.getDocument();
    const table = blockAt(doc, 0);
    if (table.kind !== 'table') throw new Error('expected a table');

    const across = range(inCell(doc, table.id, 0, 0, 0), inCell(doc, table.id, 1, 1, 1));
    const fixed = normalizeSelection(doc, across);
    expect(fixed.kind).toBe('cells');
  });

  it('never commits a selection that is not normalised', () => {
    const editor = editorFor('abc\n');
    editor.select(caret(point('ghost', [7], 42)));
    expect(isNormalized(editor.getDocument(), editor.getSelection())).toBe(true);
  });
});

describe('mapping across a split', () => {
  it('carries the caret into the new block', () => {
    const editor = editorFor('onetwo\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 3));
    editor.dispatch(splitBlock());

    const selection = editor.getSelection();
    if (selection.kind !== 'text') throw new Error('expected a text selection');
    expect(isCollapsed(selection)).toBe(true);
    // The caret belongs at the start of the tail, not the end of the head.
    expect(selection.anchor.blockId).toBe(blockAt(editor.getDocument(), 1).id);
    expect(absoluteOf(editor.getDocument(), selection.anchor)).toBe(0);
  });

  it('keeps typing continuous across a split', () => {
    const editor = editorFor('onetwo\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 3));
    editor.dispatch(splitBlock());
    editor.dispatch(insertText('X'));

    expect(editor.toText()).toBe('one\n\nXtwo\n');
  });

  it('maps a point after the split position into the tail block', () => {
    const editor = editorFor('abcdef\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    const observer = caretAt(doc, id, 5);

    editor.select(caretAt(doc, id, 3));
    const transaction = editor.dispatch(splitBlock());
    if (!transaction) throw new Error('split did not apply');

    const moved = mapSelection(transaction.after.doc, observer, transaction.mapPoint);
    if (moved.kind !== 'text') throw new Error('expected a text selection');
    expect(moved.anchor.blockId).toBe(blockAt(transaction.after.doc, 1).id);
    expect(absoluteOf(transaction.after.doc, moved.anchor)).toBe(2);
  });
});

describe('mapping across a merge', () => {
  it('places the caret at the join', () => {
    const editor = editorFor('one\n\ntwo\n');
    const second = blockAt(editor.getDocument(), 1).id;
    editor.select(caretAt(editor.getDocument(), second, 0));
    editor.dispatch(mergeBackward());

    const selection = editor.getSelection();
    if (selection.kind !== 'text') throw new Error('expected a text selection');
    expect(absoluteOf(editor.getDocument(), selection.anchor)).toBe(3);

    // And typing continues at the seam.
    editor.dispatch(insertText('-'));
    expect(editor.toText()).toBe('one-two\n');
  });

  it('maps a point in the absorbed block to its new offset', () => {
    const editor = editorFor('one\n\ntwo\n');
    const doc = editor.getDocument();
    const second = blockAt(doc, 1).id;
    const observer = caretAt(doc, second, 2);

    editor.select(caretAt(doc, second, 0));
    const transaction = editor.dispatch(mergeBackward());
    if (!transaction) throw new Error('merge did not apply');

    const moved = mapSelection(transaction.after.doc, observer, transaction.mapPoint);
    if (moved.kind !== 'text') throw new Error('expected a text selection');
    expect(moved.anchor.blockId).toBe(blockAt(transaction.after.doc, 0).id);
    expect(absoluteOf(transaction.after.doc, moved.anchor)).toBe(5);
  });
});

describe('mapping across a deletion', () => {
  it('pulls a caret inside the deleted range back to its start', () => {
    const editor = editorFor('abcdefgh\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    const observer = caretAt(doc, id, 5);

    editor.select(rangeIn(doc, id, 2, 6));
    const transaction = editor.dispatch(deleteBackward());
    if (!transaction) throw new Error('delete did not apply');

    const moved = mapSelection(transaction.after.doc, observer, transaction.mapPoint);
    if (moved.kind !== 'text') throw new Error('expected a text selection');
    expect(absoluteOf(transaction.after.doc, moved.anchor)).toBe(2);
  });

  it('shifts a caret after the deleted range by the amount removed', () => {
    const editor = editorFor('abcdefgh\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    const observer = caretAt(doc, id, 7);

    editor.select(rangeIn(doc, id, 2, 6));
    const transaction = editor.dispatch(deleteBackward());
    if (!transaction) throw new Error('delete did not apply');

    const moved = mapSelection(transaction.after.doc, observer, transaction.mapPoint);
    if (moved.kind !== 'text') throw new Error('expected a text selection');
    expect(absoluteOf(transaction.after.doc, moved.anchor)).toBe(3);
  });

  it('rescues a caret whose block was deleted entirely', () => {
    const editor = editorFor('one\n\ntwo\n\nthree\n');
    const doc = editor.getDocument();
    const middle = blockAt(doc, 1).id;
    const observer = caretAt(doc, middle, 1);

    editor.select(rangeAcross(doc, blockAt(doc, 0).id, 3, blockAt(doc, 2).id, 0));
    const transaction = editor.dispatch(deleteBackward());
    if (!transaction) throw new Error('delete did not apply');

    const moved = mapSelection(transaction.after.doc, observer, transaction.mapPoint);
    expect(isNormalized(transaction.after.doc, moved)).toBe(true);
  });
});

describe('MappingBuilder', () => {
  it('is the identity when nothing was recorded but runs were re-split', () => {
    const editor = editorFor('hello\n');
    const doc = editor.getDocument();
    const id = blockAt(doc, 0).id;
    const map = new MappingBuilder(doc).build(doc);

    const original = at(doc, id, 3);
    const mapped = map(original);
    expect(mapped).toBeDefined();
    expect(mapped?.blockId).toBe(id);
    expect(mapped?.offset).toBe(3);
  });

  it('reports emptiness honestly', () => {
    const editor = editorFor('hello\n');
    const builder = new MappingBuilder(editor.getDocument());
    expect(builder.isEmpty).toBe(true);
    builder.drop(blockAt(editor.getDocument(), 0).id);
    expect(builder.isEmpty).toBe(false);
  });
});

/**
 * Undo and redo.
 *
 * Two things make an undo stack feel right, and both are tested here.
 *
 * *Granularity*: one press of Ctrl-Z should remove the word you just typed, not
 * one letter of it — and it should stop at the point where you last did
 * something deliberate, like moving the caret or pressing space. That is the
 * coalescing rule.
 *
 * *Exactness*: after undoing, the document must be what it was, character for
 * character, and the caret must be back where your hands expect it. The strong
 * form of this — every command's inverse restores the exact prior text — is
 * asserted below over the whole command surface, because a command that
 * corrupts state only on undo is the kind of bug that reaches users.
 */

import { describe, expect, it } from 'vitest';

import {
  deleteBackward,
  deleteColumns,
  indent,
  insertTable,
  insertText,
  insertThematicBreak,
  mergeBackward,
  selectCells,
  setBlockType,
  splitBlock,
  toggleMark,
} from '../commands/index.js';
import { createEditor } from '../editor.js';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  createHistory,
  record,
  redo,
  redoLabel,
  undo,
  undoLabel,
} from '../history.js';
import type { History } from '../history.js';
import { createIdFactory } from '../ids.js';
import { caret, point } from '../selection.js';
import type { EditorState, Transaction } from '../state.js';
import { createState } from '../state.js';
import { document } from '../builders.js';
import { blockAt, caretAt, editorFor, flatBlocks, rangeIn, textOf } from './helpers.js';

describe('coalescing a run of typing', () => {
  it('collapses consecutive characters into one step', () => {
    const editor = editorFor('​\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 0));
    for (const character of 'hello') editor.dispatch(insertText(character));

    expect(editor.toText()).toBe('hello​\n');
    editor.undo();
    expect(editor.toText()).toBe('​\n');
    expect(editor.canUndo()).toBe(false);
  });

  it('starts a new step at a space, so undo removes one word', () => {
    const editor = editorFor('x\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    for (const character of 'one two') editor.dispatch(insertText(character));

    expect(editor.toText()).toBe('xone two\n');
    editor.undo();
    expect(editor.toText()).toBe('xone \n');
    editor.undo();
    expect(editor.toText()).toBe('xone\n');
    editor.undo();
    expect(editor.toText()).toBe('x\n');
  });

  it('is broken by moving the caret', () => {
    const editor = editorFor('abcdef\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 6));
    editor.dispatch(insertText('1'));
    editor.dispatch(insertText('2'));

    // The user clicks somewhere else, then types again.
    editor.select(caretAt(editor.getDocument(), id, 0));
    editor.dispatch(insertText('9'));

    expect(editor.toText()).toBe('9abcdef12\n');
    editor.undo();
    expect(editor.toText()).toBe('abcdef12\n');
    editor.undo();
    expect(editor.toText()).toBe('abcdef\n');
  });

  it('is broken explicitly by breakUndo', () => {
    const editor = editorFor('x\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('a'));
    editor.breakUndo();
    editor.dispatch(insertText('b'));

    editor.undo();
    expect(editor.toText()).toBe('xa\n');
    editor.undo();
    expect(editor.toText()).toBe('x\n');
  });

  it('does not span two blocks even when the keys are otherwise alike', () => {
    const editor = editorFor('one\n\ntwo\n');
    const doc = editor.getDocument();
    editor.select(caretAt(doc, blockAt(doc, 0).id, 3));
    editor.dispatch(insertText('!'));
    editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 1).id, 3));
    editor.dispatch(insertText('!'));

    expect(editor.toText()).toBe('one!\n\ntwo!\n');
    editor.undo();
    expect(editor.toText()).toBe('one!\n\ntwo\n');
  });

  it('collapses a run of backspaces but not backspace-then-typing', () => {
    const editor = editorFor('abcdef\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 6));
    editor.dispatch(deleteBackward());
    editor.dispatch(deleteBackward());
    editor.dispatch(deleteBackward());
    expect(editor.toText()).toBe('abc\n');

    editor.dispatch(insertText('Z'));
    editor.undo();
    expect(editor.toText()).toBe('abc\n');
    editor.undo();
    expect(editor.toText()).toBe('abcdef\n');
  });
});

describe('structural edits are never coalesced', () => {
  const structural: readonly (readonly [string, () => ReturnType<typeof editorFor>])[] = [
    [
      'split',
      () => {
        const editor = editorFor('onetwothree\n');
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 3));
        editor.dispatch(splitBlock());
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 1).id, 3));
        editor.dispatch(splitBlock());
        return editor;
      },
    ],
    [
      'block type',
      () => {
        const editor = editorFor('title\n');
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 0));
        editor.dispatch(setBlockType({ kind: 'heading', level: 1 }));
        editor.dispatch(setBlockType({ kind: 'heading', level: 2 }));
        return editor;
      },
    ],
    [
      'formatting',
      () => {
        const editor = editorFor('word here\n');
        const id = blockAt(editor.getDocument(), 0).id;
        editor.select(rangeIn(editor.getDocument(), id, 0, 4));
        editor.dispatch(toggleMark({ type: 'strong' }));
        editor.dispatch(toggleMark({ type: 'emphasis' }));
        return editor;
      },
    ],
  ];

  for (const [name, build] of structural) {
    it(`keeps two ${name} operations as two steps`, () => {
      const editor = build();
      const twice = editor.toText();
      editor.undo();
      const once = editor.toText();
      expect(once).not.toBe(twice);
      expect(editor.canUndo()).toBe(true);
    });
  }
});

describe('every command is exactly reversible', () => {
  /**
   * The paragraph containing `needle`, wherever it is nested.
   *
   * List items and quotes hold their own paragraphs, so a top-level index will
   * not reach them; `blockAt(doc, 1)` names the *list*, which is not an inline
   * container and cannot hold a caret.
   */
  function paragraphWith(editor: ReturnType<typeof editorFor>, needle: string) {
    const found = flatBlocks(editor.getDocument()).find(
      (block) => block.kind === 'paragraph' && textOf(block).includes(needle),
    );
    if (!found) throw new Error(`no paragraph containing ${needle}`);
    return found;
  }

  /** Each case edits the same starting document in a different way. */
  const cases: readonly (readonly [string, (editor: ReturnType<typeof editorFor>) => void])[] = [
    [
      'insertText',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 2));
        editor.dispatch(insertText('inserted'));
      },
    ],
    [
      'deleteBackward over a range',
      (editor) => {
        editor.select(rangeIn(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 1, 4));
        editor.dispatch(deleteBackward());
      },
    ],
    [
      'splitBlock',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 2));
        editor.dispatch(splitBlock());
      },
    ],
    [
      'mergeBackward',
      (editor) => {
        // The quote's paragraph is the last leaf, so merging it backwards pulls
        // it out of the quote and onto the end of the previous list item — a
        // genuinely structural change to undo.
        editor.select(caretAt(editor.getDocument(), paragraphWith(editor, 'quoted').id, 0));
        editor.dispatch(mergeBackward());
      },
    ],
    [
      'setBlockType',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 0));
        editor.dispatch(setBlockType({ kind: 'heading', level: 3 }));
      },
    ],
    [
      'toggleMark',
      (editor) => {
        editor.select(rangeIn(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 0, 5));
        editor.dispatch(toggleMark({ type: 'strong' }));
      },
    ],
    [
      'indent',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), paragraphWith(editor, 'item two').id, 0));
        editor.dispatch(indent());
      },
    ],
    [
      'insertTable',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
        editor.dispatch(insertTable(2, 3));
      },
    ],
    [
      'insertThematicBreak',
      (editor) => {
        editor.select(caretAt(editor.getDocument(), blockAt(editor.getDocument(), 0).id, 5));
        editor.dispatch(insertThematicBreak());
      },
    ],
  ];

  const START = 'alpha beta\n\n- item one\n- item two\n\n> quoted\n';

  for (const [name, apply] of cases) {
    it(`${name} then undo restores the source exactly`, () => {
      const editor = editorFor(START);
      const before = editor.toText();
      apply(editor);
      const after = editor.toText();
      expect(after).not.toBe(before);

      expect(editor.undo()).toBe(true);
      expect(editor.toText()).toBe(before);

      // And redo puts it back, so the pair is a true inverse in both directions.
      expect(editor.redo()).toBe(true);
      expect(editor.toText()).toBe(after);
    });
  }

  it('restores the selection the user had before the edit', () => {
    const editor = editorFor('hello world\n');
    const id = blockAt(editor.getDocument(), 0).id;
    const before = rangeIn(editor.getDocument(), id, 0, 5);
    editor.select(before);
    editor.dispatch(insertText('X'));
    editor.undo();

    const restored = editor.getSelection();
    if (restored.kind !== 'text' || before.kind !== 'text')
      throw new Error('expected text selections');
    expect(restored.anchor.blockId).toBe(before.anchor.blockId);
    expect(restored.focus.offset).toBe(before.focus.offset);

    // The caret is live: typing again replaces the same range.
    editor.dispatch(insertText('Y'));
    expect(editor.toText()).toBe('Y world\n');
  });
});

describe('redo', () => {
  it('is discarded by a new edit', () => {
    const editor = editorFor('a\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('b'));
    editor.undo();
    expect(editor.canRedo()).toBe(true);

    editor.dispatch(insertText('c'));
    expect(editor.canRedo()).toBe(false);
    expect(editor.toText()).toBe('ac\n');
  });

  it('replays a whole coalesced run at once', () => {
    const editor = editorFor('x\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    for (const character of 'abcd') editor.dispatch(insertText(character));

    editor.undo();
    expect(editor.toText()).toBe('x\n');
    editor.redo();
    expect(editor.toText()).toBe('xabcd\n');
  });

  it('reports nothing to do on an untouched editor', () => {
    const editor = editorFor('x\n');
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);
    expect(editor.undoLabel()).toBeNull();
    expect(editor.redoLabel()).toBeNull();
  });
});

describe('labels', () => {
  it('name the operation an undo menu would show', () => {
    const editor = editorFor('word\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 4));
    editor.dispatch(insertText('s'));
    expect(editor.undoLabel()).toBe('typing');

    editor.dispatch(splitBlock());
    expect(editor.undoLabel()).toBe('split');

    editor.undo();
    expect(editor.redoLabel()).toBe('split');
    expect(editor.undoLabel()).toBe('typing');
  });

  it('keep the first label when steps coalesce', () => {
    const editor = editorFor('x\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('a'));
    editor.dispatch(insertText('b'));
    expect(editor.undoLabel()).toBe('typing');
  });
});

describe('a long session', () => {
  it('unwinds to the original document and rewinds to the final one', () => {
    const editor = editorFor('alpha\n\nbeta\n');
    const original = editor.toText();

    const steps = 40;
    for (let i = 0; i < steps; i += 1) {
      const doc = editor.getDocument();
      const target = blockAt(doc, i % doc.blocks.length);
      if (target.kind !== 'paragraph' && target.kind !== 'heading') continue;
      editor.select(caretAt(doc, target.id, 0));
      editor.dispatch(insertText(String(i % 10)));
      if (i % 7 === 0) editor.dispatch(splitBlock());
      if (i % 11 === 0) editor.dispatch(toggleMark({ type: 'emphasis' }));
    }

    const final = editor.toText();
    expect(final).not.toBe(original);

    let guard = 0;
    while (editor.canUndo() && guard < 500) {
      editor.undo();
      guard += 1;
    }
    expect(editor.toText()).toBe(original);

    guard = 0;
    while (editor.canRedo() && guard < 500) {
      editor.redo();
      guard += 1;
    }
    expect(editor.toText()).toBe(final);
  });
});

describe('the history stack itself', () => {
  /** A transaction that changes nothing but carries the given key and label. */
  function fakeTransaction(
    key: string | null,
    before: EditorState,
    after: EditorState,
  ): Transaction {
    return {
      label: 'typing',
      before,
      after,
      coalesceKey: key,
      mapPoint: (p) => p,
    };
  }

  function states(count: number): readonly EditorState[] {
    const doc = document(createIdFactory('h'));
    const base = createState(doc);
    return Array.from({ length: count }, () => base);
  }

  it('evicts the oldest step past its limit', () => {
    const [state] = states(1);
    if (!state) throw new Error('unreachable');

    let history: History = createHistory(3);
    for (let i = 0; i < 10; i += 1) history = record(history, fakeTransaction(null, state, state));

    expect(history.undo).toHaveLength(3);
  });

  it('refuses a limit below one', () => {
    expect(createHistory(0).limit).toBe(1);
    expect(createHistory(-5).limit).toBe(1);
  });

  it('does not coalesce when the selection moved in between', () => {
    const doc = document(createIdFactory('h'));
    const first = createState(doc);
    const second: EditorState = { ...first, selection: caret(point('elsewhere', [0], 0)) };

    let history = createHistory();
    history = record(history, fakeTransaction('k', first, first));
    // Second transaction starts from a different selection than the first ended at.
    history = record(history, fakeTransaction('k', second, second));
    expect(history.undo).toHaveLength(2);
  });

  it('reports labels and availability without mutating anything', () => {
    const doc = document(createIdFactory('h'));
    const state = createState(doc);
    const empty = createHistory();
    expect(canUndo(empty)).toBe(false);
    expect(canRedo(empty)).toBe(false);
    expect(undoLabel(empty)).toBeNull();
    expect(redoLabel(empty)).toBeNull();
    expect(undo(empty)).toBeNull();
    expect(redo(empty)).toBeNull();

    const one = record(empty, fakeTransaction(null, state, state));
    expect(empty.undo).toHaveLength(0); // the original is untouched
    expect(canUndo(one)).toBe(true);
    expect(undoLabel(one)).toBe('typing');
  });

  it('is unchanged by breaking coalescing on an empty or already-closed stack', () => {
    const empty = createHistory();
    expect(breakCoalescing(empty)).toBe(empty);

    const doc = document(createIdFactory('h'));
    const state = createState(doc);
    const closed = record(empty, fakeTransaction(null, state, state));
    expect(breakCoalescing(closed)).toBe(closed);
  });
});

describe('clearing and replacing', () => {
  it('clearHistory forgets everything without touching the document', () => {
    const editor = editorFor('x\n');
    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('y'));
    editor.clearHistory();

    expect(editor.toText()).toBe('xy\n');
    expect(editor.canUndo()).toBe(false);
    expect(editor.canRedo()).toBe(false);
  });

  it('setText is itself undoable', () => {
    const editor = editorFor('before\n');
    editor.setText('after\n');
    expect(editor.toText()).toBe('after\n');
    expect(editor.undo()).toBe(true);
    expect(editor.toText()).toBe('before\n');
  });
});

describe('subscribers', () => {
  it('are notified once per applied transaction and not for a no-op', () => {
    const editor = createEditor({ text: 'x\n', context: { ids: createIdFactory('t') } });
    let notifications = 0;
    const stop = editor.subscribe(() => {
      notifications += 1;
    });

    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    const afterSelect = notifications;

    editor.dispatch(insertText('a'));
    expect(notifications).toBe(afterSelect + 1);

    // A command that does not apply must not fire a notification.
    editor.dispatch(() => null);
    expect(notifications).toBe(afterSelect + 1);

    stop();
    editor.dispatch(insertText('b'));
    expect(notifications).toBe(afterSelect + 1);
    expect(editor.toText()).toBe('xab\n');
  });

  it('lets a listener unsubscribe itself during notification', () => {
    const editor = editorFor('x\n');
    let calls = 0;
    const stop = editor.subscribe(() => {
      calls += 1;
      stop();
    });

    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('a'));
    editor.dispatch(insertText('b'));
    expect(calls).toBe(1);
  });

  it('give a snapshot that is stable between edits and fresh after one', () => {
    const editor = editorFor('x\n');
    const first = editor.getSnapshot();
    expect(editor.getSnapshot()).toBe(first);

    const id = blockAt(editor.getDocument(), 0).id;
    editor.select(caretAt(editor.getDocument(), id, 1));
    editor.dispatch(insertText('a'));
    const second = editor.getSnapshot();
    expect(second).not.toBe(first);
    expect(second.revision).toBeGreaterThan(first.revision);
  });
});

describe('undo restores structure, not just text', () => {
  it('brings back a deleted column with its alignment intact', () => {
    const editor = editorFor('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
    const before = editor.toText();
    const table = blockAt(editor.getDocument(), 0);
    if (table.kind !== 'table') throw new Error('expected a table');
    const alignment = table.align;

    editor.dispatch(selectCells(table.id, { row: 0, col: 1 }, { row: 1, col: 1 }));
    editor.dispatch(deleteColumns());

    const shrunk = blockAt(editor.getDocument(), 0);
    if (shrunk.kind !== 'table') throw new Error('expected a table');
    expect(shrunk.align).toHaveLength(2);

    editor.undo();
    const restored = blockAt(editor.getDocument(), 0);
    if (restored.kind !== 'table') throw new Error('expected a table again');
    // Alignment is per column, so losing it on undo would silently reflow the
    // whole grid — the kind of damage that only shows up on the next save.
    expect(restored.align).toEqual(alignment);
    expect(editor.toText()).toBe(before);
  });

  it('brings back a code block with its language', () => {
    const editor = editorFor('```ts\nconst x = 1;\n```\n');
    const before = editor.toText();
    const code = blockAt(editor.getDocument(), 0);
    expect(textOf(code)).toBe('const x = 1;');

    editor.select(caretAt(editor.getDocument(), code.id, 0));
    editor.dispatch(setBlockType({ kind: 'paragraph' }));
    editor.undo();

    expect(editor.toText()).toBe(before);
  });
});

/**
 * Commands the UI needs that the engine does not expose.
 *
 * A `Command` is just `(state, ctx) => CommandResult | null`, so a host can add
 * one without forking the engine. Everything here is written against the
 * engine's own public primitives — `findBlock`, `replaceBlockWith` — so it goes
 * through the same normalisation, mapping and undo machinery as a built-in.
 *
 * These are workarounds, and each says what it is working around.
 */

import type { Command, ListBlock, NodeId } from '../../engine/index.js';
import { findBlock, replaceBlockWith } from '../../engine/index.js';

/**
 * Toggle a task-list item's checkbox.
 *
 * `ListItem.checked` is part of the model and round-trips through the reader
 * and writer, but `commands/` has no setter for it. Without this a task list is
 * read-only in a WYSIWYG editor, which is the one place a checkbox is supposed
 * to be clickable.
 */
export function toggleTask(listId: NodeId, itemId: NodeId): Command {
  return (state) => {
    const location = findBlock(state.doc, listId);
    if (location?.block.kind !== 'list') return null;
    const list = location.block;

    let changed = false;
    const items = list.items.map((item) => {
      if (item.id !== itemId || item.checked === null) return item;
      changed = true;
      return { ...item, checked: !item.checked };
    });
    if (!changed) return null;

    const next: ListBlock = list.ordered ? { ...list, items } : { ...list, items };
    return {
      state: {
        doc: replaceBlockWith(state.doc, listId, [next]),
        selection: state.selection,
        pendingMarks: null,
      },
      label: 'block type',
    };
  };
}

/**
 * Turn the paragraph at `blockId` into a task-list item, or a task item back
 * into a plain one.
 *
 * `setBlockType` knows `bulletList` and `orderedList` but has no `taskList`
 * spelling, so the slash menu would otherwise be unable to offer the one list
 * kind people ask for by name.
 */
export function setTaskState(listId: NodeId, itemId: NodeId, checked: boolean | null): Command {
  return (state) => {
    const location = findBlock(state.doc, listId);
    if (location?.block.kind !== 'list') return null;
    const list = location.block;

    let changed = false;
    const items = list.items.map((item) => {
      if (item.id !== itemId || item.checked === checked) return item;
      changed = true;
      return { ...item, checked };
    });
    if (!changed) return null;

    const next: ListBlock = list.ordered ? { ...list, items } : { ...list, items };
    return {
      state: {
        doc: replaceBlockWith(state.doc, listId, [next]),
        selection: state.selection,
        pendingMarks: null,
      },
      label: 'block type',
    };
  };
}

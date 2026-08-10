/**
 * Text commands: typing and the two delete keys.
 *
 * Deletion is **grapheme-aware**. A code unit is not a character, a code point
 * is not a character either, and Backspace over "👩‍👩‍👧‍👦" or "e" + U+0301 must
 * remove one thing the user can see. All three delete paths therefore go
 * through the injected {@link EditContext.segment}, never through `slice(-1)`.
 */

import { textParagraph } from '../builders.js';
import { marksAt, runsLength, runsText, spliceRuns, textRun } from '../inline.js';
import { MappingBuilder, addressOf } from '../mapping.js';
import type { Mark, Run } from '../model.js';
import { nextBoundary, previousBoundary } from '../grapheme.js';
import type { Command } from '../state.js';
import {
  caret,
  cellRect,
  comparePoints,
  containerPath,
  fromAbsolute,
  requireContainer,
  resolveContainer,
  startOfBlock,
  toAbsolute,
  writeContainer,
} from '../selection.js';
import { findBlock, replaceBlockWith } from '../tree.js';
import { clearCells } from '../table.js';
import { deleteSelection } from './shared.js';
import { mergeBackward, mergeForward } from './structure.js';

/** Coalescing key for a run of typing in one container. */
function typingKey(blockId: string, path: readonly number[], whitespace: boolean): string {
  return `${whitespace ? 'typing-space' : 'typing'}:${blockId}:${path.join('.')}`;
}

/**
 * Insert text at the selection, replacing whatever it covers.
 *
 * The inserted text carries the state's pending marks when there are any, and
 * otherwise inherits from the character to the left — so typing after a bold
 * word continues bold, which is what the user asked for by putting the caret
 * there.
 *
 * Consecutive insertions coalesce into one undo step, but whitespace starts a
 * new one, giving word-granular undo without a timer.
 */
export function insertText(text: string): Command {
  return (state, ctx) => {
    if (text === '') return null;
    const builder = new MappingBuilder(state.doc);
    let doc = state.doc;
    let selection = state.selection;

    const cleared = deleteSelection(doc, selection, builder);
    if (cleared) {
      doc = cleared.doc;
      selection = cleared.selection;
    }

    if (selection.kind === 'cells') {
      const at = { row: cellRect(selection).top, col: cellRect(selection).left };
      const point = { blockId: selection.tableId, path: [at.row, at.col, 0], offset: 0 };
      selection = caret(point);
    }

    if (selection.kind === 'node') {
      // Typing over a selected image or visual block replaces it.
      const block = textParagraph(ctx.ids, text);
      builder.drop(selection.blockId);
      const next = replaceBlockWith(doc, selection.blockId, [block]);
      const point = startOfBlock(block);
      const end = point ? { ...point, offset: text.length } : undefined;
      return {
        state: { doc: next, selection: end ? caret(end) : state.selection, pendingMarks: null },
        label: 'typing',
        mapPoint: builder.build(next),
      };
    }

    const at = selection.anchor;
    const container = requireContainer(doc, at);
    const abs = toAbsolute(container, at);
    const marks: readonly Mark[] =
      container.storage === 'text' ? [] : (state.pendingMarks ?? marksAt(container.runs, abs));
    const replacement: readonly Run[] = [textRun(ctx.ids(), text, marks)];

    const runs = spliceRuns(container.runs, abs, abs, replacement);
    builder.splice(addressOf(at), abs, abs, text.length);
    const next = writeContainer(doc, container, runs);
    const after = resolveContainer(next, at);
    const point = after ? fromAbsolute(after, abs + text.length) : at;

    return {
      state: { doc: next, selection: caret(point), pendingMarks: null },
      label: 'typing',
      coalesceKey: typingKey(at.blockId, containerPath(at), /^\s+$/u.test(text)),
      mapPoint: builder.build(next),
    };
  };
}

/**
 * Delete backwards — Backspace.
 *
 * With a range selection this deletes the range. With a caret it removes one
 * grapheme, and at the very start of a block it becomes a structural edit:
 * outdent a list item, leave a block quote, or merge into the block above.
 */
export function deleteBackward(): Command {
  return (state, ctx) => {
    const builder = new MappingBuilder(state.doc);
    const cleared = deleteSelection(state.doc, state.selection, builder);
    if (cleared) {
      return {
        state: { doc: cleared.doc, selection: cleared.selection, pendingMarks: null },
        label: 'delete',
        mapPoint: builder.build(cleared.doc),
      };
    }
    if (state.selection.kind !== 'text') return null;

    const at = state.selection.anchor;
    const container = requireContainer(state.doc, at);
    const abs = toAbsolute(container, at);
    if (abs <= 0) {
      if (containerPath(at).length > 0) return null; // start of a table cell: nothing to do
      return mergeBackward()(state, ctx);
    }

    const text = runsText(container.runs);
    const from = previousBoundary(text, abs, ctx.segment);
    if (from === abs) return null;
    const runs = spliceRuns(container.runs, from, abs, []);
    builder.splice(addressOf(at), from, abs, 0);
    const next = writeContainer(state.doc, container, runs);
    const after = resolveContainer(next, at);
    const point = after ? fromAbsolute(after, from) : at;
    return {
      state: { doc: next, selection: caret(point), pendingMarks: null },
      label: 'delete',
      coalesceKey: `delete-back:${at.blockId}:${containerPath(at).join('.')}`,
      mapPoint: builder.build(next),
    };
  };
}

/** Delete forwards — the Delete key. The mirror image of {@link deleteBackward}. */
export function deleteForward(): Command {
  return (state, ctx) => {
    const builder = new MappingBuilder(state.doc);
    const cleared = deleteSelection(state.doc, state.selection, builder);
    if (cleared) {
      return {
        state: { doc: cleared.doc, selection: cleared.selection, pendingMarks: null },
        label: 'delete',
        mapPoint: builder.build(cleared.doc),
      };
    }
    if (state.selection.kind !== 'text') return null;

    const at = state.selection.anchor;
    const container = requireContainer(state.doc, at);
    const abs = toAbsolute(container, at);
    const text = runsText(container.runs);
    if (abs >= text.length) {
      if (containerPath(at).length > 0) return null; // end of a table cell
      return mergeForward()(state, ctx);
    }

    const to = nextBoundary(text, abs, ctx.segment);
    if (to === abs) return null;
    const runs = spliceRuns(container.runs, abs, to, []);
    builder.splice(addressOf(at), abs, to, 0);
    const next = writeContainer(state.doc, container, runs);
    const after = resolveContainer(next, at);
    const point = after ? fromAbsolute(after, abs) : at;
    return {
      state: { doc: next, selection: caret(point), pendingMarks: null },
      label: 'delete',
      coalesceKey: `delete-fwd:${at.blockId}:${containerPath(at).join('.')}`,
      mapPoint: builder.build(next),
    };
  };
}

/**
 * Empty everything the selection covers without removing any block.
 *
 * The "clear" a spreadsheet does, and what Delete should do to a rectangular
 * cell selection.
 */
export function clearSelection(): Command {
  return (state) => {
    if (state.selection.kind !== 'cells') return null;
    const location = findBlock(state.doc, state.selection.tableId);
    if (location?.block.kind !== 'table') return null;
    const cleared = clearCells(location.block, cellRect(state.selection));
    if (cleared === location.block) return null;
    return {
      state: {
        doc: replaceBlockWith(state.doc, location.block.id, [cleared]),
        selection: state.selection,
        pendingMarks: null,
      },
      label: 'delete',
    };
  };
}

/** Replace the whole of one inline container — used by paste and by tests. */
export function setContainerText(blockId: string, path: readonly number[], text: string): Command {
  return (state, ctx) => {
    const probe = { blockId, path: [...path, 0], offset: 0 };
    const container = resolveContainer(state.doc, probe);
    if (!container) return null;
    const total = runsLength(container.runs);
    const builder = new MappingBuilder(state.doc);
    builder.splice({ blockId, path }, 0, total, text.length);
    const runs = text === '' ? [] : [textRun(ctx.ids(), text)];
    const next = writeContainer(state.doc, container, runs);
    const after = resolveContainer(next, probe);
    const point = after ? fromAbsolute(after, text.length) : probe;
    return {
      state: { doc: next, selection: caret(point), pendingMarks: null },
      label: 'replace',
      mapPoint: builder.build(next),
    };
  };
}

/** Re-exported so a key handler can ask "is this selection empty?" cheaply. */
export { comparePoints };

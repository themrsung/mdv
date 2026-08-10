/**
 * The undo stack.
 *
 * Two entirely uncontroversial rules, which together are the whole design:
 *
 * 1. **Typing coalesces, structure does not.** A run of characters is one undo
 *    step; pressing Enter is its own step, and so is every table edit. This is
 *    expressed with a per-transaction {@link Transaction.coalesceKey}: equal
 *    non-null keys merge, anything else starts a new step.
 * 2. **Moving the caret breaks the run.** If the selection the user is editing
 *    from is not where the previous edit left them, they went somewhere else,
 *    and that is a new step even if they are still typing.
 *
 * The stack stores whole states rather than inverse patches. Documents here are
 * persistent structures that share everything untouched, so a hundred undo
 * steps of a large document cost a hundred spines, not a hundred documents.
 */

import type { CommandLabel, EditorState, Transaction } from './state.js';
import { selectionsEqual } from './selection.js';

/** One reversible step. */
export interface HistoryEntry {
  readonly label: CommandLabel;
  readonly before: EditorState;
  readonly after: EditorState;
  /** Non-null while the step is still open to coalescing. */
  readonly coalesceKey: string | null;
}

/** An undo/redo stack. Immutable: every operation returns a new one. */
export interface History {
  readonly undo: readonly HistoryEntry[];
  readonly redo: readonly HistoryEntry[];
  /** Maximum number of undo steps kept. Older steps fall off the bottom. */
  readonly limit: number;
}

/** An empty history. `limit` defaults to 200 steps. */
export function createHistory(limit = 200): History {
  return { undo: [], redo: [], limit: Math.max(1, Math.trunc(limit)) };
}

/**
 * Record a transaction.
 *
 * Merges into the previous step when both carry the same coalescing key *and*
 * the transaction starts from where the previous one ended. Recording anything
 * clears the redo stack, which is the standard linear-undo model.
 */
export function record(history: History, transaction: Transaction): History {
  const top = history.undo[history.undo.length - 1];
  const canCoalesce =
    top !== undefined &&
    top.coalesceKey !== null &&
    transaction.coalesceKey !== null &&
    top.coalesceKey === transaction.coalesceKey &&
    selectionsEqual(top.after.selection, transaction.before.selection);

  if (canCoalesce && top) {
    const merged: HistoryEntry = {
      label: top.label,
      before: top.before,
      after: transaction.after,
      coalesceKey: transaction.coalesceKey,
    };
    return { ...history, undo: [...history.undo.slice(0, -1), merged], redo: [] };
  }

  const entry: HistoryEntry = {
    label: transaction.label,
    before: transaction.before,
    after: transaction.after,
    coalesceKey: transaction.coalesceKey,
  };
  const undo = [...history.undo, entry];
  return {
    ...history,
    undo: undo.length > history.limit ? undo.slice(undo.length - history.limit) : undo,
    redo: [],
  };
}

/**
 * Close the current coalescing run.
 *
 * Call this when something happened that the history cannot see — the user
 * clicked elsewhere, the window lost focus, a save completed — so the next
 * keystroke starts a fresh undo step.
 */
export function breakCoalescing(history: History): History {
  const top = history.undo[history.undo.length - 1];
  if (!top || top.coalesceKey === null) return history;
  return {
    ...history,
    undo: [...history.undo.slice(0, -1), { ...top, coalesceKey: null }],
  };
}

/** The label an "Undo" menu item should show, or `null` when there is nothing. */
export function undoLabel(history: History): CommandLabel | null {
  return history.undo[history.undo.length - 1]?.label ?? null;
}

/** The label a "Redo" menu item should show, or `null` when there is nothing. */
export function redoLabel(history: History): CommandLabel | null {
  return history.redo[history.redo.length - 1]?.label ?? null;
}

/** True when there is a step to undo. */
export function canUndo(history: History): boolean {
  return history.undo.length > 0;
}

/** True when there is a step to redo. */
export function canRedo(history: History): boolean {
  return history.redo.length > 0;
}

/** The result of stepping the history. */
export interface HistoryStep {
  readonly state: EditorState;
  readonly history: History;
}

/**
 * Undo one step.
 *
 * The restored selection is the one the user had *before* the edit, not after
 * it — undoing a paste should leave the caret where the paste started.
 */
export function undo(history: History): HistoryStep | null {
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return null;
  return {
    state: entry.before,
    history: {
      ...history,
      undo: history.undo.slice(0, -1),
      redo: [...history.redo, { ...entry, coalesceKey: null }],
    },
  };
}

/** Redo one step. */
export function redo(history: History): HistoryStep | null {
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return null;
  return {
    state: entry.after,
    history: {
      ...history,
      undo: [...history.undo, { ...entry, coalesceKey: null }],
      redo: history.redo.slice(0, -1),
    },
  };
}

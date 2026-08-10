/**
 * Editor state and the transaction protocol.
 *
 * The engine has exactly one mutable concept — the {@link EditorState} you are
 * currently showing — and exactly one way to change it: run a {@link Command}
 * and get a {@link Transaction} back. A transaction is a *value*: the state
 * before, the state after, a selection map, and enough metadata for the undo
 * stack to decide whether this edit belongs with the previous one. Nothing in
 * this file mutates anything, which is what makes undo trivial (keep the
 * `before`) and collaboration possible later (ship the transaction).
 *
 * Commands return `null` when they do not apply. That is not an error: Tab in a
 * paragraph, Enter in a table cell and "outdent" at the outermost level are all
 * perfectly reasonable keystrokes that should simply do nothing, and a
 * key handler that has to try/catch every binding is a bad key handler.
 */

import type { GraphemeSegmenter } from './grapheme.js';
import { defaultSegmenter } from './grapheme.js';
import type { IdFactory } from './ids.js';
import { createIdFactory } from './ids.js';
import type { PointMap } from './mapping.js';
import { clampingMap } from './mapping.js';
import type { Mark, MdvDocument } from './model.js';
import type { Selection } from './selection.js';
import { normalizeSelection, startOfBlock, caret } from './selection.js';

/**
 * Everything an editing surface needs to render a frame.
 *
 * `pendingMarks` is the "type bold next" state: a collapsed caret that has been
 * toggled bold carries no document change yet, but the next character must be
 * bold. It is `null` when the caret simply inherits from its neighbours, and it
 * is cleared by any command that moves or changes text.
 */
export interface EditorState {
  readonly doc: MdvDocument;
  readonly selection: Selection;
  readonly pendingMarks: readonly Mark[] | null;
}

/** Ambient services a command needs. Injected so tests stay deterministic. */
export interface EditContext {
  /** Allocates ids for newly created nodes. */
  readonly ids: IdFactory;
  /** Splits text into user-perceived characters for the delete commands. */
  readonly segment: GraphemeSegmenter;
}

/** Build an {@link EditContext}; both services default to the engine's own. */
export function createContext(options: Partial<EditContext> = {}): EditContext {
  return {
    ids: options.ids ?? createIdFactory('e'),
    segment: options.segment ?? defaultSegmenter,
  };
}

/**
 * Names of the built-in commands.
 *
 * The label is what an undo UI shows ("Undo typing") and what tests assert on;
 * it is deliberately coarse — several commands share one label when a user
 * would call them one action.
 */
export type CommandLabel =
  | 'typing'
  | 'delete'
  | 'split'
  | 'merge'
  | 'formatting'
  | 'block type'
  | 'indent'
  | 'outdent'
  | 'insert image'
  | 'insert table'
  | 'insert visual block'
  | 'insert'
  | 'paste'
  | 'table edit'
  | 'replace';

/** What a command produces when it applies. */
export interface CommandResult {
  readonly state: EditorState;
  readonly label: CommandLabel;
  /**
   * Two consecutive transactions with the same non-null key collapse into one
   * undo step. Typing uses `typing:<container>` so a run of characters is one
   * step but moving the caret starts a new one; structural edits omit it.
   */
  readonly coalesceKey?: string;
  /** How positions in the old document map into the new one. */
  readonly mapPoint?: PointMap;
}

/** A command: a pure function from state to a described new state. */
export type Command = (state: EditorState, ctx: EditContext) => CommandResult | null;

/** The record of one applied command. */
export interface Transaction {
  readonly label: CommandLabel;
  readonly before: EditorState;
  readonly after: EditorState;
  readonly coalesceKey: string | null;
  /** Maps a point valid in `before.doc` into `after.doc`. */
  readonly mapPoint: PointMap;
}

/** Build a state, normalising the selection so it can never start out invalid. */
export function createState(doc: MdvDocument, selection?: Selection): EditorState {
  const initial =
    selection ??
    (() => {
      const first = doc.blocks[0];
      const at = first ? startOfBlock(first) : undefined;
      return at
        ? caret(at)
        : ({ kind: 'text', anchor: { blockId: doc.id, path: [0], offset: 0 }, focus: { blockId: doc.id, path: [0], offset: 0 } } satisfies Selection);
    })();
  return { doc, selection: normalizeSelection(doc, initial), pendingMarks: null };
}

/** Replace the selection, normalising it and dropping any pending marks. */
export function withSelection(state: EditorState, selection: Selection): EditorState {
  const next = normalizeSelection(state.doc, selection);
  return { doc: state.doc, selection: next, pendingMarks: null };
}

/**
 * Run a command.
 *
 * The result's selection is normalised here rather than in every command, so a
 * command that computes a slightly-off caret cannot corrupt the state; the
 * worst it can do is put the caret somewhere unhelpful.
 */
export function applyCommand(
  state: EditorState,
  ctx: EditContext,
  command: Command,
): Transaction | null {
  const result = command(state, ctx);
  if (result === null) return null;
  const after: EditorState = {
    doc: result.state.doc,
    selection: normalizeSelection(result.state.doc, result.state.selection),
    pendingMarks: result.state.pendingMarks,
  };
  return {
    label: result.label,
    before: state,
    after,
    coalesceKey: result.coalesceKey ?? null,
    mapPoint: result.mapPoint ?? clampingMap(after.doc),
  };
}

/** Run several commands as one transaction, keeping the last one's label. */
export function sequence(...commands: readonly Command[]): Command {
  return (state, ctx) => {
    let current = state;
    let result: CommandResult | null = null;
    for (const command of commands) {
      const next = command(current, ctx);
      if (next === null) continue;
      result = next;
      current = next.state;
    }
    if (result === null) return null;
    // Composed edits are structural by construction: never coalesce them.
    return { state: current, label: result.label };
  };
}

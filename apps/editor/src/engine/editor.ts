/**
 * The editor store.
 *
 * A tiny observable box around {@link EditorState} and {@link History}. This is
 * the only stateful thing in the engine and the only thing a UI needs to hold:
 * everything else is a pure function you can call from a test.
 *
 * The subscription shape is deliberately the one `useSyncExternalStore` wants —
 * `subscribe(listener) => unsubscribe` plus a `getSnapshot` that returns a value
 * which is reference-stable until something actually changes. A command that
 * returns `null` changes nothing and notifies nobody, so a no-op keystroke will
 * not re-render the document.
 *
 * @example
 * ```ts
 * const editor = createEditor({ text: '# Hello\n' });
 * editor.dispatch(insertText(' world'));
 * editor.toText(); // '# Hello world\n'
 * editor.undo();
 * ```
 */

import type { Command, EditContext, EditorState, Transaction } from './state.js';
import { applyCommand, createContext, createState, withSelection } from './state.js';
import type { History } from './history.js';
import {
  breakCoalescing,
  canRedo,
  canUndo,
  createHistory,
  record,
  redo as redoHistory,
  redoLabel,
  undo as undoHistory,
  undoLabel,
} from './history.js';
import type { MdvDocument } from './model.js';
import type { Selection } from './selection.js';
import { normalizeSelection } from './selection.js';
import { read } from './io/read.js';
import { write } from './io/write.js';
import type { WriteOptions } from './io/write.js';
import { createIdFactory } from './ids.js';
import { withMinimumContent } from './builders.js';

/** Everything an observer of the editor can see. */
export interface EditorSnapshot {
  readonly state: EditorState;
  readonly history: History;
  /** Increments on every notification; handy as a React key or a dirty flag. */
  readonly revision: number;
}

/** How to start an editor. Give it `doc`, or `text`, or neither for an empty one. */
export interface EditorOptions {
  /** An existing document. Takes precedence over `text`. */
  readonly doc?: MdvDocument;
  /** `.mdv` source to read. Ignored when `doc` is given. */
  readonly text?: string;
  /** Where the caret starts. Defaults to the start of the first block. */
  readonly selection?: Selection;
  /**
   * Id factory and grapheme segmenter. Defaults are deterministic apart from
   * the id prefix, which is `'e'`; pass your own to keep ids stable in tests.
   */
  readonly context?: Partial<EditContext>;
  /** Undo depth. Defaults to 200 steps. */
  readonly historyLimit?: number;
  /** Serialisation options used by {@link Editor.toText}. */
  readonly write?: WriteOptions;
}

/** A listener notified after every change. Takes no arguments by design. */
export type EditorListener = () => void;

/** The store. */
export interface Editor {
  /** The current snapshot. Reference-stable between changes. */
  getSnapshot(): EditorSnapshot;
  /** The current state. Shorthand for `getSnapshot().state`. */
  getState(): EditorState;
  /** The current document. */
  getDocument(): MdvDocument;
  /** The current selection. */
  getSelection(): Selection;
  /** The shared edit context (id factory, segmenter). */
  getContext(): EditContext;

  /**
   * Run a command.
   *
   * Returns the transaction it produced, or `null` when the command did not
   * apply — an unapplicable command is not an error, it is a key the editor
   * does not handle in this position and the caller may fall through to the
   * browser's default.
   */
  dispatch(command: Command): Transaction | null;
  /** Run several commands as one undo step. Returns the fused transaction. */
  dispatchAll(...commands: readonly Command[]): Transaction | null;

  /**
   * Move the selection without touching the document.
   *
   * Not undoable, and it closes the current typing run, so typing after a click
   * starts a new undo step.
   */
  select(selection: Selection): void;

  /** Replace the whole document. Undoable, labelled `replace`. */
  setDocument(doc: MdvDocument, selection?: Selection): Transaction | null;
  /** Read `.mdv` source and replace the document with it. Undoable. */
  setText(text: string): Transaction | null;

  /** Serialise the current document back to `.mdv` source. */
  toText(options?: WriteOptions): string;

  /** Undo one step. Returns false when the stack is empty. */
  undo(): boolean;
  /** Redo one step. Returns false when the stack is empty. */
  redo(): boolean;
  /** True when there is something to undo. */
  canUndo(): boolean;
  /** True when there is something to redo. */
  canRedo(): boolean;
  /** The label of the next undo step, for a menu item. */
  undoLabel(): string | null;
  /** The label of the next redo step, for a menu item. */
  redoLabel(): string | null;
  /** End the current typing run so the next edit starts a fresh undo step. */
  breakUndo(): void;
  /** Throw the history away, keeping the document. */
  clearHistory(): void;

  /** Subscribe to changes. Returns the unsubscribe function. */
  subscribe(listener: EditorListener): () => void;
}

/**
 * Every document the store holds must be editable.
 *
 * `read('')` yields zero blocks, which is the honest parse of an empty file but
 * leaves the surface with no `contenteditable` host: the caret has nowhere to
 * land, so `New` would produce a document you cannot type into. The paragraph
 * added here is not serialised, so `toText()` still round-trips to ''.
 */
function editable(doc: MdvDocument): MdvDocument {
  return withMinimumContent(doc, createIdFactory('r'));
}

/** Create an editor. */
export function createEditor(options: EditorOptions = {}): Editor {
  const ctx = createContext(options.context ?? {});
  const doc = editable(options.doc ?? read(options.text ?? '', { ids: createIdFactory('r') }));
  const writeOptions = options.write;

  let state = options.selection
    ? withSelection(createState(doc), normalizeSelection(doc, options.selection))
    : createState(doc);
  let history = createHistory(options.historyLimit);
  let revision = 0;
  let snapshot: EditorSnapshot = { state, history, revision };

  const listeners = new Set<EditorListener>();

  const notify = (): void => {
    revision += 1;
    snapshot = { state, history, revision };
    // Copy first: a listener is allowed to unsubscribe itself while running.
    for (const listener of [...listeners]) listener();
  };

  const run = (command: Command): Transaction | null => {
    const transaction = applyCommand(state, ctx, command);
    if (!transaction) return null;
    state = transaction.after;
    history = record(history, transaction);
    notify();
    return transaction;
  };

  return {
    getSnapshot: () => snapshot,
    getState: () => state,
    getDocument: () => state.doc,
    getSelection: () => state.selection,
    getContext: () => ctx,

    dispatch: run,

    dispatchAll(...commands) {
      let fused: Transaction | null = null;
      for (const command of commands) {
        const transaction = run(command);
        if (!transaction) continue;
        fused =
          fused === null
            ? transaction
            : { ...transaction, before: fused.before, label: fused.label };
      }
      return fused;
    },

    select(selection) {
      const normalized = normalizeSelection(state.doc, selection);
      if (state.selection === normalized) return;
      state = withSelection(state, normalized);
      history = breakCoalescing(history);
      notify();
    },

    setDocument(next, selection) {
      return run((current) => {
        const doc = editable(next);
        if (doc === current.doc) return null;
        const target = selection ?? createState(doc).selection;
        return {
          state: { doc, selection: normalizeSelection(doc, target), pendingMarks: null },
          label: 'replace',
        };
      });
    },

    setText(text) {
      return this.setDocument(read(text, { ids: createIdFactory('r') }));
    },

    toText: (overrides) => write(state.doc, overrides ?? writeOptions ?? {}),

    undo() {
      const step = undoHistory(history);
      if (!step) return false;
      state = step.state;
      history = step.history;
      notify();
      return true;
    },

    redo() {
      const step = redoHistory(history);
      if (!step) return false;
      state = step.state;
      history = step.history;
      notify();
      return true;
    },

    canUndo: () => canUndo(history),
    canRedo: () => canRedo(history),
    undoLabel: () => undoLabel(history),
    redoLabel: () => redoLabel(history),

    breakUndo() {
      const next = breakCoalescing(history);
      if (next === history) return;
      history = next;
      notify();
    },

    clearHistory() {
      history = createHistory(options.historyLimit);
      notify();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

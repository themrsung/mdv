/**
 * The React binding for the editing engine.
 *
 * The engine is an external store with a `subscribe`/`getSnapshot` pair, which
 * is exactly the shape `useSyncExternalStore` wants, so there is no state
 * mirror to keep in sync and no possibility of a render that shows a document
 * one edit behind its own selection. Nothing here copies engine state into
 * React state; components read the snapshot and re-render when the revision
 * changes.
 */

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import type {
  Command,
  Editor,
  EditorSnapshot,
  Mark,
  MdvDocument,
  Selection,
} from '../../engine/index.js';
import { commands } from '../../engine/index.js';

/** What every part of the editor can do to the document. */
export interface EditorApi {
  readonly editor: Editor;
  readonly doc: MdvDocument;
  readonly selection: Selection;
  /** Increments on every engine notification; the render key for the document. */
  readonly revision: number;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Marks that would apply to text typed right now. */
  readonly activeMarks: readonly Mark[];
  /** Run a command. Returns false when it did not apply. */
  run(command: Command): boolean;
  /** Move the selection without editing. */
  select(selection: Selection): void;
}

const MISSING: EditorApi = {
  get editor(): never {
    throw new Error('useEditorApi() used outside <EditorProvider>');
  },
} as unknown as EditorApi;

export const EditorContext = createContext<EditorApi>(MISSING);

/** Access the editor. Throws when used outside the provider. */
export function useEditorApi(): EditorApi {
  return useContext(EditorContext);
}

/** Subscribe to the engine and build the API object. */
export function useEditorStore(editor: Editor): EditorApi {
  const subscribe = useCallback(
    (listener: () => void) => editor.subscribe(listener),
    [editor],
  );
  const snapshot: EditorSnapshot = useSyncExternalStore(
    subscribe,
    () => editor.getSnapshot(),
    () => editor.getSnapshot(),
  );

  const run = useCallback(
    (command: Command): boolean => editor.dispatch(command) !== null,
    [editor],
  );
  const select = useCallback(
    (selection: Selection): void => {
      editor.select(selection);
    },
    [editor],
  );

  return useMemo<EditorApi>(() => {
    const { state, revision } = snapshot;
    return {
      editor,
      doc: state.doc,
      selection: state.selection,
      revision,
      canUndo: editor.canUndo(),
      canRedo: editor.canRedo(),
      activeMarks: commands.activeMarks(state.doc, state.selection, state.pendingMarks),
      run,
      select,
    };
  }, [editor, snapshot, run, select]);
}

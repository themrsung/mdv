/**
 * The application: one editor, the panes around it, and the file it edits.
 *
 * This is the only component that owns mutable application state. Everything
 * below it either reads the engine through `useEditorApi()` or is handed exactly
 * what it needs as props, which is what keeps the interesting parts — the
 * surface, the offset mapping, the input layer — testable without mounting an
 * application.
 *
 * Three pieces of state are genuinely *not* the engine's, and live here:
 *
 * - **The file.** Its name, its handle if the File System Access API gave us
 *   one, and the text as last written to disk. Dirtiness is derived by
 *   comparing that text with the document's current serialisation rather than
 *   tracked with a flag, so an undo back to the saved state correctly clears
 *   the dot rather than leaving a document that claims to be modified.
 * - **The draft.** A copy in `localStorage`, refreshed on a timer, offered back
 *   after a crash. It is deliberately not a save: it never touches the user's
 *   file, and it is cleared the moment a real save succeeds.
 * - **The view.** Which panes are showing, and the colour scheme.
 *
 * The document itself is never mirrored into React state. `useEditorStore`
 * subscribes to the engine and re-renders on its revision, so there is no
 * ordering in which the panes can disagree about what the document says.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { ImageEnvironment } from '../../engine/image/index.js';
import type { LinkMark } from '../../engine/index.js';
import { commands, createEditor } from '../../engine/index.js';
import { browserImageEnvironment } from '../../engine/image/index.js';
import type { ImageAlign } from '../blocks/image-align.js';
import { detectModKey } from '../input/keymap.js';
import type { KeyAction } from '../input/keymap.js';
import type { ImageNotice } from '../input/images.js';
import { LinkDialog } from '../menus/LinkDialog.js';
import { SourcePane } from '../source/SourcePane.js';
import type { FileHandle } from '../state/files.js';
import { UNTITLED, openFile, saveText, withMdvExtension } from '../state/files.js';
import type { DraftRecord, StorageLike } from '../state/persistence.js';
import {
  clearDraft,
  describeAge,
  loadDraft,
  saveDraft,
  shouldOfferRecovery,
} from '../state/persistence.js';
import { EditorContext, useEditorStore } from '../state/store.js';
import { useTheme } from '../state/theme.js';
import type { ViewPrefs } from '../state/view-prefs.js';
import { ViewPrefsContext } from '../state/view-prefs.js';
import { EditorSurface } from '../surface/EditorSurface.js';
import type { ViewMode } from '../shell/TopBar.js';
import { TopBar } from '../shell/TopBar.js';
import { Toolbar } from '../toolbar/Toolbar.js';
import '../styles/app.css';

/** How long the document must sit still before a draft is written. */
const DRAFT_DEBOUNCE_MS = 800;

export interface EditorAppProps {
  /** Document to open with. Defaults to a short introduction. */
  readonly initialText?: string;
  /** Injected in tests; defaults to the browser's canvas-based decoder. */
  readonly imageEnv?: ImageEnvironment;
  /** Injected in tests; `null` disables draft recovery. */
  readonly storage?: StorageLike | null;
}

interface FileState {
  readonly name: string;
  readonly handle: FileHandle | null;
  /** The text as it exists on disk, for the dirty comparison. */
  readonly savedText: string;
}

export function EditorApp(props: EditorAppProps): ReactElement {
  const { initialText = WELCOME } = props;
  const imageEnv = useMemo(() => props.imageEnv ?? browserImageEnvironment(), [props.imageEnv]);
  const storage = props.storage === undefined ? browserStorage() : props.storage;

  const editor = useMemo(() => createEditor({ text: initialText }), [initialText]);
  const api = useEditorStore(editor);
  const { revision } = api;

  const mod = useMemo(() => detectModKey(hostPlatform()), []);
  const theme = useTheme(storage);

  const [view, setView] = useState<ViewMode>('document');
  const [sourceEditable, setSourceEditable] = useState(false);
  // Seeded from the editor's *own* serialisation, not from `initialText`. The
  // writer is canonical — it re-pads table pipes, normalises setext headings —
  // so a hand-written file almost never round-trips byte-for-byte, and
  // comparing against the raw input would light the unsaved-changes dot before
  // the user has touched anything. Dirty means "edited since it was loaded".
  const [file, setFile] = useState<FileState>(() => ({
    name: UNTITLED,
    handle: null,
    savedText: editor.toText(),
  }));
  const [notices, setNotices] = useState<readonly ImageNotice[]>([]);
  const [linkOpen, setLinkOpen] = useState(false);
  const [recovery, setRecovery] = useState<DraftRecord | null>(null);
  const [imageAlign, setImageAlignState] = useState<ReadonlyMap<string, ImageAlign>>(
    () => new Map(),
  );

  // Serialising on every revision is what the source pane and the dirty flag
  // both need, and documents are small enough that doing it once here is
  // cheaper than the bookkeeping to avoid it.
  const text = useMemo(() => editor.toText(), [editor, revision]);
  const dirty = text !== file.savedText;

  /* ---------------------------------------------------------------------- */
  /* Draft: autosave, and the offer to restore one                           */
  /* ---------------------------------------------------------------------- */

  // Checked once, against the document as it was loaded: a draft is only
  // interesting before the user has typed anything of their own. The ref is
  // what keeps that true under StrictMode's double-invoked effects.
  const draftChecked = useRef(false);
  useEffect(() => {
    if (draftChecked.current || storage === null) return;
    draftChecked.current = true;
    const draft = loadDraft(storage);
    if (shouldOfferRecovery(draft, text)) setRecovery(draft);
  }, [storage, text]);

  useEffect(() => {
    if (storage === null || !dirty) return;
    const timer = setTimeout(() => {
      saveDraft(storage, {
        version: 1,
        text,
        savedAt: Date.now(),
        fileName: file.handle?.name ?? null,
      });
    }, DRAFT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [dirty, file.handle, storage, text]);

  const restoreDraft = useCallback((): void => {
    const draft = recovery;
    setRecovery(null);
    if (draft === null) return;
    editor.setText(draft.text);
  }, [editor, recovery]);

  const discardDraft = useCallback((): void => {
    setRecovery(null);
    if (storage !== null) clearDraft(storage);
  }, [storage]);

  /* ---------------------------------------------------------------------- */
  /* Notices                                                                 */
  /* ---------------------------------------------------------------------- */

  const pushNotice = useCallback((notice: ImageNotice): void => {
    // Newest first, and bounded: a folder of unreadable files must not bury the
    // document under a hundred toasts.
    setNotices((current) => [notice, ...current].slice(0, 4));
  }, []);

  const dismissNotice = useCallback((id: string): void => {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  /* ---------------------------------------------------------------------- */
  /* File commands                                                           */
  /* ---------------------------------------------------------------------- */

  const doOpen = useCallback((): void => {
    void (async () => {
      let opened;
      try {
        opened = await openFile();
      } catch {
        pushNotice({
          id: `open-${String(Date.now())}`,
          tone: 'error',
          message: 'That file could not be read.',
        });
        return;
      }
      if (opened === null) return;
      editor.setText(opened.text);
      editor.clearHistory();
      // As above: the baseline is what the editor would write, so opening a
      // file that is merely formatted differently is not an unsaved change.
      setFile({ name: opened.name, handle: opened.handle, savedText: editor.toText() });
      if (storage !== null) clearDraft(storage);
    })();
  }, [editor, pushNotice, storage]);

  const doSave = useCallback(
    (forcePicker: boolean): void => {
      void (async () => {
        const current = editor.toText();
        let result;
        try {
          result = await saveText(current, withMdvExtension(file.name), file.handle, {
            forcePicker,
          });
        } catch {
          pushNotice({
            id: `save-${String(Date.now())}`,
            tone: 'error',
            message: 'Saving failed.',
          });
          return;
        }
        if (result.kind === 'cancelled') return;

        setFile({
          name: result.name,
          handle: result.kind === 'saved' ? result.handle : file.handle,
          savedText: current,
        });
        if (storage !== null) clearDraft(storage);
        if (result.kind === 'downloaded') {
          pushNotice({
            id: `save-${String(Date.now())}`,
            tone: 'info',
            message: `Downloaded ${result.name}.`,
          });
        }
      })();
    },
    [editor, file.handle, file.name, pushNotice, storage],
  );

  const doNew = useCallback((): void => {
    editor.setText('');
    editor.clearHistory();
    setFile({ name: UNTITLED, handle: null, savedText: editor.toText() });
    if (storage !== null) clearDraft(storage);
  }, [editor, storage]);

  /* ---------------------------------------------------------------------- */
  /* Links                                                                   */
  /* ---------------------------------------------------------------------- */

  const activeLink = useMemo(
    () => api.activeMarks.find((mark): mark is LinkMark => mark.type === 'link') ?? null,
    [api.activeMarks],
  );

  const applyLink = useCallback(
    (href: string, title: string | null): void => {
      setLinkOpen(false);
      // Retargeting is remove-then-add: `toggleMark` compares marks by value, so
      // adding a second link to a span that already has one would leave both.
      if (activeLink !== null) api.run(commands.toggleMark(activeLink));
      api.run(commands.toggleMark({ type: 'link', href, title }));
    },
    [activeLink, api],
  );

  const removeLink = useCallback((): void => {
    setLinkOpen(false);
    if (activeLink !== null) api.run(commands.toggleMark(activeLink));
  }, [activeLink, api]);

  /* ---------------------------------------------------------------------- */
  /* Shortcuts the shell owns                                                */
  /* ---------------------------------------------------------------------- */

  const onShellAction = useCallback(
    (action: KeyAction): void => {
      switch (action.kind) {
        case 'save':
          doSave(false);
          return;
        case 'saveAs':
          doSave(true);
          return;
        case 'open':
          doOpen();
          return;
        case 'link':
          setLinkOpen(true);
          return;
        case 'toggleSource':
          setView((current) => (current === 'source' ? 'document' : 'source'));
          return;
        default:
          // Every other action is handled inside the surface; this callback only
          // ever receives the shell's own.
          return;
      }
    },
    [doOpen, doSave],
  );

  /* ---------------------------------------------------------------------- */
  /* Leaving with unsaved work                                               */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      // The string is ignored by every current browser; calling preventDefault
      // is what actually produces the prompt.
      event.preventDefault();
    };
    globalThis.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      globalThis.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);

  /* ---------------------------------------------------------------------- */
  /* View preferences                                                        */
  /* ---------------------------------------------------------------------- */

  const setImageAlign = useCallback((blockId: string, align: ImageAlign): void => {
    setImageAlignState((current) => {
      const next = new Map(current);
      next.set(blockId, align);
      return next;
    });
  }, []);

  const viewPrefs = useMemo<ViewPrefs>(
    () => ({ scheme: theme.scheme, imageAlign, setImageAlign }),
    [imageAlign, setImageAlign, theme.scheme],
  );

  const nowRef = useRef(Date.now());

  return (
    <EditorContext.Provider value={api}>
      <ViewPrefsContext.Provider value={viewPrefs}>
        <div className={`mdv-app mdv-app--${view}`}>
          <TopBar
            fileName={file.name}
            dirty={dirty}
            canOverwrite={file.handle !== null}
            mod={mod}
            view={view}
            theme={theme.choice}
            onOpen={doOpen}
            onSave={() => {
              doSave(false);
            }}
            onSaveAs={() => {
              doSave(true);
            }}
            onNew={doNew}
            onView={setView}
            onTheme={theme.setChoice}
          />

          {recovery !== null ? (
            <div className="mdv-banner" role="alert">
              <span>
                An unsaved draft from {describeAge(recovery.savedAt, nowRef.current)} is available.
              </span>
              <span className="mdv-banner__actions">
                <button type="button" className="mdv-btn" onClick={restoreDraft}>
                  Restore it
                </button>
                <button type="button" className="mdv-btn" onClick={discardDraft}>
                  Discard
                </button>
              </span>
            </div>
          ) : null}

          {view === 'source' ? null : (
            <Toolbar
              mod={mod}
              onLink={() => {
                setLinkOpen(true);
              }}
            />
          )}

          <div className="mdv-panes">
            {view === 'source' ? null : (
              <main className="mdv-pane mdv-pane--document" aria-label="Document">
                <EditorSurface
                  imageEnv={imageEnv}
                  onNotice={pushNotice}
                  onShellAction={onShellAction}
                />
              </main>
            )}
            {view === 'document' ? null : (
              <aside className="mdv-pane mdv-pane--source" aria-label="Source">
                <SourcePane
                  text={text}
                  editable={sourceEditable}
                  onToggleEditable={setSourceEditable}
                />
              </aside>
            )}
          </div>

          {notices.length > 0 ? (
            <div className="mdv-notices" role="status" aria-live="polite">
              {notices.map((notice) => (
                <div key={notice.id} className={`mdv-notice mdv-notice--${notice.tone}`}>
                  <span>{notice.message}</span>
                  <button
                    type="button"
                    className="mdv-notice__close"
                    aria-label="Dismiss"
                    onClick={() => {
                      dismissNotice(notice.id);
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ) : null}

          <LinkDialog
            open={linkOpen}
            initialHref={activeLink?.href ?? ''}
            initialTitle={activeLink?.title ?? ''}
            editing={activeLink !== null}
            onCancel={() => {
              setLinkOpen(false);
            }}
            onApply={applyLink}
            onRemove={removeLink}
          />
        </div>
      </ViewPrefsContext.Provider>
    </EditorContext.Provider>
  );
}

function hostPlatform(): string {
  const scope = globalThis as { navigator?: { platform?: string; userAgent?: string } };
  return scope.navigator?.platform ?? scope.navigator?.userAgent ?? '';
}

function browserStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    /* c8 ignore next -- storage blocked by policy; drafts are simply off. */
    return null;
  }
}

const WELCOME = `# MDV

A **visual** editor for Markdown with data. Type \`/\` for blocks, or start writing.

| Quarter | Revenue |
| ------- | ------: |
| Q1      |    1200 |
| Q2      |    1810 |
`;

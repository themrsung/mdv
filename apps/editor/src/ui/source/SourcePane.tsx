/**
 * The `.mdv` source pane.
 *
 * Read-only by default and live: it is `editor.toText()`, recomputed from the
 * engine on every revision, so it is the actual bytes that would be written to
 * disk rather than an approximation of them. That makes it the fastest way to
 * check what the WYSIWYG side just did to the file — which is the reason to
 * have a split view at all.
 *
 * Editing is opt-in and commits on blur. A source pane that re-parsed on every
 * keystroke would rebuild the document — and therefore every node id and the
 * whole undo stack — while the user was still halfway through typing a fence.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { useEditorApi } from '../state/store.js';

export interface SourcePaneProps {
  readonly text: string;
  readonly editable: boolean;
  readonly onToggleEditable: (editable: boolean) => void;
}

export function SourcePane({ text, editable, onToggleEditable }: SourcePaneProps): ReactElement {
  const { editor } = useEditorApi();
  const [draft, setDraft] = useState<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // Leaving edit mode with an uncommitted draft throws it away rather than
  // applying it silently; the user did not press anything that means "apply".
  useEffect(() => {
    if (!editable) setDraft(null);
  }, [editable]);

  const lines = useMemo(() => text.split('\n').length, [text]);
  const bytes = useMemo(() => new TextEncoder().encode(text).length, [text]);

  return (
    <section className="mdv-source" aria-label="MDV source">
      <header className="mdv-source__head">
        <h2 className="mdv-source__title">Source</h2>
        <span className="mdv-source__meta">
          {lines} line{lines === 1 ? '' : 's'} · {bytes.toLocaleString('en-US')} bytes
        </span>
        <label className="mdv-check mdv-check--tight">
          <input
            type="checkbox"
            checked={editable}
            onChange={(event) => {
              onToggleEditable(event.target.checked);
            }}
          />
          <span>Edit</span>
        </label>
        <button
          type="button"
          className="mdv-btn"
          onClick={() => {
            void navigator.clipboard?.writeText(text);
          }}
        >
          Copy
        </button>
      </header>

      <textarea
        ref={areaRef}
        className="mdv-source__text"
        aria-label="MDV source text"
        spellCheck={false}
        wrap="off"
        readOnly={!editable}
        value={draft ?? text}
        onChange={(event) => {
          if (editable) setDraft(event.target.value);
        }}
        onBlur={() => {
          if (draft !== null && draft !== text) editor.setText(draft);
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (draft !== null) editor.setText(draft);
            setDraft(null);
          }
        }}
      />

      {editable ? (
        <p className="mdv-source__hint">
          Applied on blur, or with {navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'}Enter.
          Re-reading the source rebuilds the document, which clears the undo history.
        </p>
      ) : null}
    </section>
  );
}

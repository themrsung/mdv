/**
 * The link editor.
 *
 * A `<dialog>` rather than a hand-rolled overlay: the browser supplies the
 * focus trap, the Escape handling, the inert backdrop and the restoration of
 * focus to whatever opened it — four accessibility requirements that hand-rolled
 * modals routinely get wrong.
 *
 * URLs are not sanitised here beyond rejecting the empty string. The engine's
 * clipboard layer already rejects dangerous schemes on the way in
 * (`clipboard.safeUrl`), and the rendered link is a `span`, not an `a`, so a
 * `javascript:` destination typed by the document's own author is inert until
 * it reaches a renderer that has its own allowlist.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';

export interface LinkDialogProps {
  readonly open: boolean;
  readonly initialHref: string;
  readonly initialTitle: string;
  /** True when the caret sits inside an existing link. */
  readonly editing: boolean;
  readonly onCancel: () => void;
  readonly onApply: (href: string, title: string | null) => void;
  readonly onRemove: () => void;
}

export function LinkDialog(props: LinkDialogProps): ReactElement {
  const { open, initialHref, initialTitle, editing, onCancel, onApply, onRemove } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [href, setHref] = useState(initialHref);
  const [title, setTitle] = useState(initialTitle);

  useEffect(() => {
    setHref(initialHref);
    setTitle(initialTitle);
  }, [initialHref, initialTitle, open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      className="mdv-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClose={onCancel}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          const destination = href.trim();
          if (destination === '') return;
          onApply(destination, title.trim() === '' ? null : title.trim());
        }}
      >
        <h2 className="mdv-dialog__title">{editing ? 'Edit link' : 'Add link'}</h2>

        <label className="mdv-field">
          <span className="mdv-field__label">Destination</span>
          <input
            className="mdv-field__input"
            type="text"
            autoFocus
            spellCheck={false}
            placeholder="https://example.com"
            value={href}
            onChange={(event) => {
              setHref(event.target.value);
            }}
          />
        </label>

        <label className="mdv-field">
          <span className="mdv-field__label">Title (optional)</span>
          <input
            className="mdv-field__input"
            type="text"
            value={title}
            onChange={(event) => {
              setTitle(event.target.value);
            }}
          />
        </label>

        <div className="mdv-dialog__actions">
          {editing ? (
            <button type="button" className="mdv-btn mdv-btn--danger" onClick={onRemove}>
              Remove link
            </button>
          ) : null}
          <span className="mdv-spacer" />
          <button type="button" className="mdv-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="mdv-btn mdv-btn--primary" disabled={href.trim() === ''}>
            {editing ? 'Update' : 'Add'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

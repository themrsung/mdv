/**
 * The application bar: the file, the view, and the theme.
 */

import type { ReactElement } from 'react';
import type { ModKey } from '../input/keymap.js';
import { shortcutLabel } from '../input/keymap.js';
import type { ThemeChoice } from '../state/theme.js';

/** Which panes are showing. */
export type ViewMode = 'split' | 'document' | 'source';

export interface TopBarProps {
  readonly fileName: string;
  readonly dirty: boolean;
  /** True when Save overwrites a real file rather than producing a download. */
  readonly canOverwrite: boolean;
  readonly mod: ModKey;
  readonly view: ViewMode;
  readonly theme: ThemeChoice;
  readonly onOpen: () => void;
  readonly onSave: () => void;
  readonly onSaveAs: () => void;
  readonly onNew: () => void;
  readonly onView: (view: ViewMode) => void;
  readonly onTheme: (theme: ThemeChoice) => void;
}

const VIEWS: readonly { readonly id: ViewMode; readonly label: string }[] = [
  { id: 'document', label: 'Document' },
  { id: 'split', label: 'Split' },
  { id: 'source', label: 'Source' },
];

const THEMES: readonly {
  readonly id: ThemeChoice;
  readonly label: string;
  readonly glyph: string;
}[] = [
  { id: 'light', label: 'Light', glyph: '☀' },
  { id: 'system', label: 'Follow system', glyph: '◐' },
  { id: 'dark', label: 'Dark', glyph: '☾' },
];

export function TopBar(props: TopBarProps): ReactElement {
  const { fileName, dirty, canOverwrite, mod, view, theme } = props;

  return (
    <header className="mdv-topbar">
      <div className="mdv-topbar__identity">
        <span className="mdv-wordmark" aria-hidden="true">
          MDV
        </span>
        <h1 className="mdv-topbar__file">
          {fileName}
          {dirty ? (
            <span className="mdv-dot" title="Unsaved changes" aria-label="Unsaved changes">
              •
            </span>
          ) : null}
        </h1>
      </div>

      <div className="mdv-topbar__actions">
        <button type="button" className="mdv-btn" onClick={props.onNew}>
          New
        </button>
        <button
          type="button"
          className="mdv-btn"
          onClick={props.onOpen}
          title={`Open (${shortcutLabel(mod, { key: 'o' })})`}
        >
          Open…
        </button>
        <button
          type="button"
          className="mdv-btn mdv-btn--primary"
          onClick={props.onSave}
          title={`${canOverwrite ? 'Save' : 'Download'} (${shortcutLabel(mod, { key: 's' })})`}
        >
          {canOverwrite ? 'Save' : 'Download'}
        </button>
        <button
          type="button"
          className="mdv-btn"
          onClick={props.onSaveAs}
          title={`Save as (${shortcutLabel(mod, { shift: true, key: 's' })})`}
        >
          Save as…
        </button>
      </div>

      <div className="mdv-topbar__view">
        <div className="mdv-segmented" role="group" aria-label="View">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={view === entry.id ? 'is-active' : undefined}
              aria-pressed={view === entry.id}
              onClick={() => {
                props.onView(entry.id);
              }}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <div className="mdv-segmented" role="group" aria-label="Colour theme">
          {THEMES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={theme === entry.id ? 'is-active' : undefined}
              aria-pressed={theme === entry.id}
              title={entry.label}
              onClick={() => {
                props.onTheme(entry.id);
              }}
            >
              <span aria-hidden="true">{entry.glyph}</span>
              <span className="mdv-sr">{entry.label}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}

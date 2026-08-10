/**
 * The application root.
 *
 * Deliberately one line of substance: everything the editor is lives in
 * `src/ui/`, assembled by `EditorApp`, and everything it does to a document
 * lives in `src/engine/`. Keeping this file thin means the app can be mounted
 * somewhere else — a VS Code webview, a test — by importing `EditorApp`
 * directly, with no shell-level state to reproduce.
 */
import type { ReactElement } from 'react';
import { EditorApp } from './ui/app/EditorApp.js';

export function App(): ReactElement {
  return <EditorApp />;
}

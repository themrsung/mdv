/**
 * The `mdv.reader` custom editor (SPEC 29.2).
 *
 * ```jsonc
 * "customEditors": [{
 *   "viewType": "mdv.reader",
 *   "displayName": "MDV Reader",
 *   "selector": [{ "filenamePattern": "*.mdv" }],
 *   "priority": "option"
 * }]
 * ```
 *
 * `priority: "option"` matters: the default way to open a `.mdv` file stays the
 * text editor, and the reader is something the user chooses ("Reopen Editor
 * With…"). An `.mdv` file is source; silently hiding the source behind a
 * rendered view would be wrong for a *text* format.
 *
 * The reader is a {@link CustomTextEditorProvider} rather than a
 * {@link vscode.CustomEditorProvider}: the document is plain text that VS Code
 * already knows how to load, save and undo, and the reader neither owns nor
 * mutates it. Everything the reader does is what the preview panel already does,
 * so it *is* the preview panel — same pipeline, same webview, same CSP, same
 * scroll-sync messages (which no-op harmlessly when no text editor for the
 * document is visible).
 */

import * as vscode from 'vscode';
import type { PreviewManager } from './preview/manager.js';

/** `viewType` of the custom editor; must match `package.json`. */
export const READER_VIEW_TYPE = 'mdv.reader';

class MdvReaderProvider implements vscode.CustomTextEditorProvider {
  readonly #previews: PreviewManager;

  constructor(previews: PreviewManager) {
    this.#previews = previews;
  }

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    token: vscode.CancellationToken,
  ): void {
    // `attach` wires the panel's own `onDidDispose` to the preview's teardown,
    // so a closed tab releases the listeners and the timer.
    const preview = this.#previews.attach(webviewPanel, document.uri);
    if (token.isCancellationRequested) {
      preview.dispose();
      return;
    }
    token.onCancellationRequested(() => {
      preview.dispose();
    });
  }
}

/** Register the reader. Returns the disposable to hold on the context. */
export function registerReader(previews: PreviewManager): vscode.Disposable {
  return vscode.window.registerCustomEditorProvider(
    READER_VIEW_TYPE,
    new MdvReaderProvider(previews),
    {
      // The reader is a rendered view of an unchanged document; keeping the
      // webview alive across tab switches avoids a full re-render every time,
      // and the pipeline memo makes the cost of *not* doing so small anyway.
      webviewOptions: { retainContextWhenHidden: true },
      // Two reader tabs on one document would each hold their own pipeline
      // entry and re-render independently for no benefit.
      supportsMultipleEditorsPerDocument: false,
    },
  );
}

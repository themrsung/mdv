/**
 * Preview panel lifecycle: at most one panel per document, plus the
 * `WebviewPanelSerializer` that brings them back after a window reload
 * (SPEC 29.3).
 */

import * as vscode from 'vscode';
import { logError } from '../log.js';
import type { SettingsStore } from '../settings.js';
import type { PipelineStore } from '../documents.js';
import { PreviewPanel, PREVIEW_VIEW_TYPE, type PreviewState } from './panel.js';

export class PreviewManager implements vscode.Disposable {
  readonly #panels = new Map<string, PreviewPanel>();
  /** Panels VS Code owns (the `mdv.reader` custom editor). */
  readonly #attached = new Set<PreviewPanel>();
  readonly #extensionUri: vscode.Uri;
  readonly #settings: SettingsStore;
  readonly #pipelines: PipelineStore;

  constructor(extensionUri: vscode.Uri, settings: SettingsStore, pipelines: PipelineStore) {
    this.#extensionUri = extensionUri;
    this.#settings = settings;
    this.#pipelines = pipelines;
  }

  /** Open (or focus) the preview for `uri`. */
  show(uri: vscode.Uri, column: vscode.ViewColumn): PreviewPanel {
    const key = uri.toString();
    const existing = this.#panels.get(key);
    if (existing !== undefined) {
      existing.reveal(column);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      PREVIEW_VIEW_TYPE,
      `Preview ${uri.path.split('/').pop() ?? ''}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    );
    return this.#adopt(panel, uri, undefined);
  }

  /** `true` when a preview is open for `uri`. */
  has(uri: vscode.Uri): boolean {
    return this.#panels.has(uri.toString());
  }

  /**
   * Drive a panel VS Code created for us — the `mdv.reader` custom editor
   * (SPEC 29.2).
   *
   * Deliberately *not* recorded in the per-URI map: a custom editor is an editor
   * for the document, not "the preview of" it, so opening the side preview for
   * the same file must still work and must not steal or close the reader tab.
   * It is tracked separately only so that disposing the manager disposes it too.
   */
  attach(panel: vscode.WebviewPanel, uri: vscode.Uri): PreviewPanel {
    const preview = new PreviewPanel({
      panel,
      uri,
      extensionUri: this.#extensionUri,
      settings: this.#settings,
      pipelines: this.#pipelines,
    });
    this.#attached.add(preview);
    preview.onDidDispose(() => {
      this.#attached.delete(preview);
    });
    return preview;
  }

  /** Re-render every open preview. Used when a setting changes globally. */
  refreshAll(): void {
    for (const panel of this.#panels.values()) panel.schedule(0);
    for (const panel of this.#attached) panel.schedule(0);
  }

  #adopt(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    restore: PreviewState | undefined,
  ): PreviewPanel {
    const preview = new PreviewPanel({
      panel,
      uri,
      extensionUri: this.#extensionUri,
      settings: this.#settings,
      pipelines: this.#pipelines,
      restore,
    });
    const key = uri.toString();
    this.#panels.set(key, preview);
    preview.onDidDispose(() => {
      // Only forget it if it is still the panel we recorded: `retarget` could
      // have moved another panel onto this key.
      if (this.#panels.get(key) === preview) this.#panels.delete(key);
    });
    return preview;
  }

  /**
   * The serialiser of SPEC 29.3.
   *
   * VS Code hands back the state the webview persisted with `setState`, which is
   * where the scroll position lives; the document URI is carried alongside it so
   * the panel knows what to re-render.
   */
  serializer(): vscode.WebviewPanelSerializer {
    return {
      deserializeWebviewPanel: async (
        panel: vscode.WebviewPanel,
        state: unknown,
      ): Promise<void> => {
        const restored = readState(state);
        if (restored === undefined) {
          panel.dispose();
          return;
        }
        try {
          const uri = vscode.Uri.parse(restored.uri, true);
          this.#adopt(panel, uri, restored);
        } catch (error) {
          logError('preview deserialize', error);
          panel.dispose();
        }
        await Promise.resolve();
      },
    };
  }

  dispose(): void {
    for (const panel of [...this.#panels.values()]) panel.dispose();
    this.#panels.clear();
    for (const panel of [...this.#attached]) panel.dispose();
    this.#attached.clear();
  }
}

function readState(state: unknown): PreviewState | undefined {
  if (typeof state !== 'object' || state === null) return undefined;
  const candidate = state as Partial<PreviewState>;
  if (typeof candidate.uri !== 'string' || candidate.uri.length === 0) return undefined;
  return {
    uri: candidate.uri,
    scrollTop: typeof candidate.scrollTop === 'number' ? candidate.scrollTop : 0,
  };
}

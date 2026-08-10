/**
 * One live preview panel (SPEC 29.3).
 *
 * Responsibilities, in the order they matter:
 *
 * - **Survive rapid editing.** Every re-render is debounced by
 *   `mdv.preview.debounceMs` (150 ms by default) *and* serialised: while a run
 *   is in flight, a further edit sets a "dirty" flag rather than starting a
 *   second run. Without that, a fast typist starts a run per keystroke and the
 *   panel receives them out of order. With it, the panel does at most one run at
 *   a time and always ends on the newest text.
 * - **Patch, don't replace.** After the first render the panel diffs the block
 *   list against what the webview already has and posts only the blocks whose
 *   SVG string differs. Combined with the pipeline's per-block memo, editing one
 *   chart in a fifty-chart document re-lays-out one block and posts one patch.
 * - **Bidirectional scroll sync**, on by default, off when
 *   `mdv.preview.scrollSync` is false. Both directions are guarded so they
 *   cannot chase each other: the host ignores an editor scroll it caused itself.
 * - **Never take the host down.** Every listener and every timer goes through
 *   `safe`, and a pipeline failure leaves the last good picture on screen.
 */

import * as vscode from 'vscode';
import { logError, safe, warn } from '../log.js';
import type { SettingsStore } from '../settings.js';
import type { PipelineStore } from '../documents.js';
import { themeNameFor, type EditorKind, type RenderedBlock } from '../pipeline/index.js';
import { getPreviewHtml } from './html.js';
import type { BlockPayload, HostMessage, WebviewMessage } from './protocol.js';

/** `viewType` for the preview panel and for its serialiser (SPEC 29.3). */
export const PREVIEW_VIEW_TYPE = 'mdv.preview';

/** What survives serialisation (SPEC 29.3). */
export interface PreviewState {
  readonly uri: string;
  readonly scrollTop: number;
}

/** The editor colour-theme kind, reduced to what MDV distinguishes. */
export function editorKind(): EditorKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Dark:
      return 'dark';
    case vscode.ColorThemeKind.HighContrast:
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast';
    default:
      return 'light';
  }
}

function toPayload(block: RenderedBlock): BlockPayload {
  return {
    id: block.id,
    index: block.index,
    blockType: block.blockType,
    title: block.title,
    startLine: block.startLine,
    endLine: block.endLine,
    svg: block.svg,
    failed: block.failed,
    family: block.family,
  };
}

/** `true` when two block lists differ in anything but SVG content. */
function structureChanged(
  previous: readonly RenderedBlock[],
  next: readonly RenderedBlock[],
): boolean {
  if (previous.length !== next.length) return true;
  for (let i = 0; i < next.length; i += 1) {
    const a = previous[i];
    const b = next[i];
    if (a === undefined || b === undefined) return true;
    if (a.index !== b.index || a.id !== b.id || a.blockType !== b.blockType) return true;
  }
  return false;
}

export class PreviewPanel implements vscode.Disposable {
  readonly panel: vscode.WebviewPanel;
  readonly #settings: SettingsStore;
  readonly #pipelines: PipelineStore;
  readonly #extensionUri: vscode.Uri;
  readonly #subscriptions: vscode.Disposable[] = [];
  readonly #onDidDispose = new vscode.EventEmitter<PreviewPanel>();

  #uri: vscode.Uri;
  #width = 720;
  #lastBlocks: readonly RenderedBlock[] = [];
  #scrollTop = 0;
  /** `true` once the webview has said `ready`; before that, nothing is posted. */
  #ready = false;
  #running = false;
  /** Set while a run is in flight if another edit arrives. */
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** Set while we are scrolling the editor ourselves. */
  #suppressEditorScroll = false;
  #disposed = false;

  get uri(): vscode.Uri {
    return this.#uri;
  }

  get onDidDispose(): vscode.Event<PreviewPanel> {
    return this.#onDidDispose.event;
  }

  constructor(options: {
    panel: vscode.WebviewPanel;
    uri: vscode.Uri;
    extensionUri: vscode.Uri;
    settings: SettingsStore;
    pipelines: PipelineStore;
    restore?: PreviewState | undefined;
  }) {
    this.panel = options.panel;
    this.#uri = options.uri;
    this.#extensionUri = options.extensionUri;
    this.#settings = options.settings;
    this.#pipelines = options.pipelines;
    this.#scrollTop = options.restore?.scrollTop ?? 0;

    this.panel.webview.options = {
      enableScripts: true,
      // SPEC 29.3: the extension bundle and the document's own folder, nothing
      // more. A document cannot reach a sibling project's files through the
      // preview.
      localResourceRoots: this.#resourceRoots(),
    };
    this.panel.title = `Preview ${this.#basename()}`;
    this.panel.webview.html = this.#html();

    this.#subscriptions.push(
      this.panel.webview.onDidReceiveMessage(
        safe('preview message', (message: WebviewMessage) => {
          this.#onMessage(message);
        }),
      ),
      vscode.workspace.onDidChangeTextDocument(
        safe('preview change', (event: vscode.TextDocumentChangeEvent) => {
          if (event.document.uri.toString() !== this.#uri.toString()) return;
          if (event.contentChanges.length === 0) return;
          this.schedule();
        }),
      ),
      vscode.window.onDidChangeTextEditorVisibleRanges(
        safe('preview scroll sync', (event: vscode.TextEditorVisibleRangesChangeEvent) => {
          if (!this.#settings.current.preview.scrollSync) return;
          if (this.#suppressEditorScroll) return;
          if (event.textEditor.document.uri.toString() !== this.#uri.toString()) return;
          const first = event.visibleRanges[0];
          if (first === undefined) return;
          this.#post({ kind: 'revealLine', line: first.start.line });
        }),
      ),
      vscode.window.onDidChangeTextEditorSelection(
        safe('preview selection sync', (event: vscode.TextEditorSelectionChangeEvent) => {
          if (!this.#settings.current.preview.scrollSync) return;
          if (event.textEditor.document.uri.toString() !== this.#uri.toString()) return;
          const line = event.selections[0]?.active.line;
          if (line === undefined) return;
          const block = this.#lastBlocks.find((b) => line >= b.startLine && line <= b.endLine);
          if (block !== undefined) this.#post({ kind: 'highlightBlock', index: block.index });
        }),
      ),
      vscode.window.onDidChangeActiveColorTheme(
        safe('preview theme change', () => {
          // The theme is not part of the per-block cache key by name alone —
          // `auto` resolves through the editor kind — so drop every memo.
          this.#pipelines.get(this.#uri).invalidate();
          this.#lastBlocks = [];
          this.schedule(0);
        }),
      ),
      this.#settings.onDidChange(
        safe('preview settings change', () => {
          this.#post({ kind: 'settings', scrollSync: this.#settings.current.preview.scrollSync });
          this.#pipelines.get(this.#uri).invalidate();
          this.#lastBlocks = [];
          this.schedule(0);
        }),
      ),
      this.panel.onDidDispose(() => {
        this.dispose();
      }),
    );
  }

  /** The panel's persisted state, for the serialiser. */
  state(): PreviewState {
    return { uri: this.#uri.toString(), scrollTop: this.#scrollTop };
  }

  /** Point an existing panel at another document (used by `showPreview`). */
  retarget(uri: vscode.Uri): void {
    if (uri.toString() === this.#uri.toString()) return;
    this.#uri = uri;
    this.#lastBlocks = [];
    this.#scrollTop = 0;
    this.panel.title = `Preview ${this.#basename()}`;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: this.#resourceRoots(),
    };
    this.#ready = false;
    this.panel.webview.html = this.#html();
  }

  reveal(column?: vscode.ViewColumn): void {
    this.panel.reveal(column, true);
  }

  /** Queue a render. Coalesces; safe to call on every keystroke. */
  schedule(delayOverride?: number): void {
    if (this.#disposed) return;
    if (this.#running) {
      this.#dirty = true;
      return;
    }
    const delay = delayOverride ?? this.#settings.current.preview.debounceMs;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#render();
    }, delay);
  }

  #resourceRoots(): vscode.Uri[] {
    const roots = [vscode.Uri.joinPath(this.#extensionUri, 'dist')];
    const folder = this.#uri.with({ path: this.#uri.path.replace(/\/[^/]*$/, '') });
    if (folder.path.length > 0) roots.push(folder);
    return roots;
  }

  #basename(): string {
    const segments = this.#uri.path.split('/');
    return segments[segments.length - 1] ?? 'document';
  }

  #html(): string {
    const script = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, 'dist', 'webview.js'),
    );
    return getPreviewHtml(this.panel.webview, script);
  }

  #post(message: HostMessage): void {
    if (this.#disposed || !this.#ready) return;
    void this.panel.webview.postMessage(message).then(undefined, (error: unknown) => {
      // Posting to a disposed webview rejects; that is not an error worth
      // surfacing, but it must not escape as an unhandled rejection.
      logError('preview postMessage', error);
    });
  }

  #onMessage(message: WebviewMessage): void {
    switch (message.kind) {
      case 'ready':
        this.#ready = true;
        this.#width = message.width;
        this.#lastBlocks = [];
        this.schedule(0);
        break;
      case 'resize': {
        if (message.width === this.#width) break;
        this.#width = message.width;
        // Only stages 6–7 depend on the width; the pipeline's per-block key
        // carries it, so this re-lays-out and does not re-parse.
        this.schedule(0);
        break;
      }
      case 'scrolled':
        this.#revealInEditor(message.line, false);
        break;
      case 'revealSource':
        this.#revealInEditor(message.line, true);
        break;
      case 'requestExternal':
        void vscode.commands.executeCommand('mdv.allowExternalForWorkspace');
        break;
      case 'state':
        this.#scrollTop = message.scrollTop;
        break;
      case 'error':
        warn(`preview webview: ${message.message}`);
        break;
    }
  }

  /** Scroll (and optionally focus) the source editor to `line`. */
  #revealInEditor(line: number, focus: boolean): void {
    const editor = vscode.window.visibleTextEditors.find(
      (candidate) => candidate.document.uri.toString() === this.#uri.toString(),
    );
    if (editor === undefined) return;
    const clamped = Math.max(0, Math.min(line, editor.document.lineCount - 1));
    const range = new vscode.Range(clamped, 0, clamped, 0);
    this.#suppressEditorScroll = true;
    try {
      editor.revealRange(
        range,
        focus
          ? vscode.TextEditorRevealType.InCenterIfOutsideViewport
          : vscode.TextEditorRevealType.AtTop,
      );
      if (focus) editor.selection = new vscode.Selection(range.start, range.start);
    } finally {
      // Released on the next tick: `revealRange` fires its visible-range event
      // asynchronously, and clearing synchronously would let it through.
      setTimeout(() => {
        this.#suppressEditorScroll = false;
      }, 0);
    }
  }

  async #render(): Promise<void> {
    if (this.#disposed || !this.#ready) return;
    this.#running = true;
    try {
      const document = await this.#openDocument();
      if (document === undefined || this.#disposed) return;

      const settings = this.#settings.current;
      const pipeline = this.#pipelines.get(this.#uri);
      const result = await pipeline.run({
        source: document.getText(),
        uri: this.#uri.toString(),
        width: this.#width,
        theme: themeNameFor(settings.preview.theme, editorKind()),
        level: settings.validate.level,
        strict: settings.validate.strict,
        allowExternal: settings.security.allowExternal,
        allowedOrigins: settings.security.allowedOrigins,
      });
      if (this.#disposed) return;

      let errorCount = 0;
      let warningCount = 0;
      for (const diagnostic of result.diagnostics) {
        if (diagnostic.severity === 'error') errorCount += 1;
        else if (diagnostic.severity === 'warning') warningCount += 1;
      }

      const previous = this.#lastBlocks;
      if (previous.length === 0 || structureChanged(previous, result.blocks)) {
        this.#post({
          kind: 'render',
          blocks: result.blocks.map(toPayload),
          documentUri: this.#uri.toString(),
          documentTitle: this.#basename(),
          errorCount,
          warningCount,
          blockedOrigins: result.blockedOrigins,
          scrollSync: settings.preview.scrollSync,
        });
      } else {
        const changed = result.blocks.filter((block, i) => previous[i]?.svg !== block.svg);
        // An unchanged document still refreshes the counts and the banner, which
        // are cheap; the block list is what we avoid re-sending.
        this.#post({
          kind: 'patch',
          blocks: changed.map(toPayload),
          errorCount,
          warningCount,
          blockedOrigins: result.blockedOrigins,
        });
      }
      this.#lastBlocks = result.blocks;

      if (settings.trace !== 'off') {
        warn(
          `preview ${this.#basename()}: parsed=${String(result.stats.parsed)} ` +
            `resolved=${String(result.stats.resolved)} laidOut=${String(result.stats.laidOut)} ` +
            `reused=${String(result.stats.reused)}`,
        );
      }
    } catch (error) {
      // Leave the previous picture up. A blank panel tells the author nothing;
      // the last good render plus a log line tells them something.
      logError(`preview render ${this.#uri.toString()}`, error);
      this.#post({ kind: 'status', text: 'Preview failed — see the MDV output channel' });
    } finally {
      this.#running = false;
      if (this.#dirty) {
        this.#dirty = false;
        this.schedule(0);
      }
    }
  }

  /** The open document, or the file on disk if it is not open in an editor. */
  async #openDocument(): Promise<vscode.TextDocument | undefined> {
    const open = vscode.workspace.textDocuments.find(
      (candidate) => candidate.uri.toString() === this.#uri.toString(),
    );
    if (open !== undefined) return open;
    try {
      return await vscode.workspace.openTextDocument(this.#uri);
    } catch (error) {
      logError(`open ${this.#uri.toString()}`, error);
      return undefined;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    for (const item of this.#subscriptions) item.dispose();
    this.#subscriptions.length = 0;
    this.#onDidDispose.fire(this);
    this.#onDidDispose.dispose();
    this.panel.dispose();
  }
}

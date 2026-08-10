/**
 * In-process diagnostics: the stand-in for `@mdv/lsp` (SPEC 29.4).
 *
 * Behaviour matches the LSP row of SPEC 29.4's capability table as far as
 * diagnostics go: **full pipeline validation on change (debounced 300 ms), on
 * save, and on open**, with ranges from SPEC 14.4. What it does not do is any of
 * the other twelve capabilities in that table — see `service.ts`.
 *
 * Two details worth stating, because both are easy to get wrong:
 *
 * 1. **Debounce per document, not globally.** A single shared timer means typing
 *    in file A postpones the validation of file B indefinitely.
 * 2. **Stale results are dropped.** `run()` is `async` (the data stage may fetch
 *    when `mdv.security.allowExternal` is on), so by the time it resolves the
 *    document may have changed again. Each run stamps the document version it
 *    started from and refuses to publish if the version has moved — otherwise
 *    fast typing leaves the squiggles a revision behind.
 */

import * as vscode from 'vscode';
import { logError, warn } from '../log.js';
import type { SettingsStore } from '../settings.js';
import type { PipelineStore } from '../documents.js';
import { isPreviewable } from '../documents.js';
import { themeNameFor, type EditorKind } from '../pipeline/index.js';
import { activeThemeFiles } from '../themefiles.js';
import { toVsDiagnostics } from './convert.js';
import type { DiagnosticEngineKind, DiagnosticService } from './service.js';

/** SPEC 29.4: "Full pipeline validation on change (debounced 300 ms)". */
const VALIDATE_DEBOUNCE_MS = 300;

/** The editor kind, for the theme a block is judged under. */
function editorKind(): EditorKind {
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

export class InProcessDiagnosticService implements DiagnosticService {
  readonly kind: DiagnosticEngineKind = 'in-process';

  readonly #collection: vscode.DiagnosticCollection;
  readonly #settings: SettingsStore;
  readonly #pipelines: PipelineStore;
  readonly #subscriptions: vscode.Disposable[] = [];
  /** Pending debounce timers, keyed by URI. */
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The document version each in-flight run started from. */
  readonly #inFlight = new Map<string, number>();
  #disposed = false;

  constructor(settings: SettingsStore, pipelines: PipelineStore) {
    this.#settings = settings;
    this.#pipelines = pipelines;
    this.#collection = vscode.languages.createDiagnosticCollection('mdv');

    this.#subscriptions.push(
      this.#collection,
      vscode.workspace.onDidOpenTextDocument((document) => {
        this.#schedule(document, 0);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        this.#schedule(event.document, VALIDATE_DEBOUNCE_MS);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        this.#schedule(document, 0);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        this.#cancel(document.uri.toString());
        this.#collection.delete(document.uri);
      }),
    );

    // Everything already open when the extension activated.
    for (const document of vscode.workspace.textDocuments) this.#schedule(document, 0);
  }

  revalidate(document: vscode.TextDocument): void {
    this.#schedule(document, 0);
  }

  revalidateAll(): void {
    if (!this.#settings.current.validate.enable) {
      this.#collection.clear();
      return;
    }
    for (const document of vscode.workspace.textDocuments) this.#schedule(document, 0);
  }

  #cancel(key: string): void {
    const timer = this.#timers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(key);
    }
  }

  #schedule(document: vscode.TextDocument, delay: number): void {
    if (this.#disposed) return;
    if (!isPreviewable(document)) return;

    const key = document.uri.toString();
    if (!this.#settings.current.validate.enable) {
      this.#cancel(key);
      this.#collection.delete(document.uri);
      return;
    }

    this.#cancel(key);
    if (delay === 0) {
      void this.#validate(document);
      return;
    }
    this.#timers.set(
      key,
      setTimeout(() => {
        this.#timers.delete(key);
        void this.#validate(document);
      }, delay),
    );
  }

  async #validate(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const version = document.version;
    // Two runs for one document would race to publish; the later one wins by
    // being scheduled after, so drop this one if a newer one already started.
    const running = this.#inFlight.get(key);
    if (running !== undefined && running >= version) return;
    this.#inFlight.set(key, version);

    const settings = this.#settings.current;
    try {
      const pipeline = this.#pipelines.get(document.uri);
      const result = await pipeline.run({
        source: document.getText(),
        uri: document.uri.toString(),
        // Validation does not depend on the container width, but layout does,
        // and the diagnostics of stage 6 (tick collision, `MDV5011`) are real
        // diagnostics. A fixed nominal width keeps them reproducible rather
        // than making the Problems panel depend on how wide a panel happens
        // to be.
        width: 720,
        theme: themeNameFor(settings.preview.theme, editorKind()),
        level: settings.validate.level,
        strict: settings.validate.strict,
        allowExternal: settings.security.allowExternal,
        allowedOrigins: settings.security.allowedOrigins,
        themeFiles: activeThemeFiles(),
      });

      if (this.#disposed) return;
      // The document moved on while we were away: a newer run will publish.
      if (document.version !== version) return;

      this.#collection.set(document.uri, toVsDiagnostics(document, result.diagnostics));
      if (settings.trace !== 'off') {
        warn(
          `validate ${document.uri.fsPath}: ${result.diagnostics.length} diagnostic(s), ` +
            `parsed=${String(result.stats.parsed)} resolved=${String(result.stats.resolved)} ` +
            `laidOut=${String(result.stats.laidOut)} reused=${String(result.stats.reused)}`,
        );
      }
    } catch (error) {
      // A pipeline that throws is a bug in MDV, not in the document. Keep the
      // previous squiggles rather than blanking them: stale is more useful than
      // absent, and the output channel carries the truth.
      logError(`diagnostics for ${document.uri.toString()}`, error);
    } finally {
      if (this.#inFlight.get(key) === version) this.#inFlight.delete(key);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#inFlight.clear();
    for (const item of this.#subscriptions) item.dispose();
    this.#subscriptions.length = 0;
  }
}

/**
 * The MDV VS Code extension entry point (SPEC 29).
 *
 * ## Activation budget (SPEC 29.8: "target ≤ 50 ms")
 *
 * `activate` constructs objects and registers providers. It does not parse a
 * document, does not build a scene and does not touch the filesystem. The first
 * real work happens when the diagnostics service's own `onDidOpenTextDocument`
 * pass runs, or when a preview is opened — both after `activate` has returned.
 * The heavy imports (`@mdv/core`, `@mdv/charts`, `@mdv/render-svg`) are pulled in
 * by `pipeline/`, which is imported statically because esbuild bundles the whole
 * extension into one file anyway; the cost is a module evaluation, not any work.
 *
 * ## The language server
 *
 * SPEC 29.4 describes a full LSP in `@mdv/lsp`. **It is not implemented in this
 * tree.** Diagnostics are computed in-process behind the `DiagnosticService`
 * interface (see `diagnostics/service.ts`), and the smaller language features
 * that setting names in SPEC 29.6 refer to — code lenses, column-name
 * completion, formatting — are likewise in-process. Everything else in SPEC
 * 29.4's table (hover, signature help, code actions, symbols, folding,
 * definition/references, rename, inlay hints, semantic tokens) is absent, and
 * `README.md` says so.
 *
 * ## Never crashing the host
 *
 * Every command handler, event listener and timer callback in this extension is
 * wrapped in `safe`/`safeCommand` from `log.ts`. There is no `await` in this
 * file that is not inside such a wrapper.
 */

import * as vscode from 'vscode';
import { createLogChannel, disposeLogChannel } from './channel.js';
import { log, safe } from './log.js';
import { SettingsStore } from './settings.js';
import { PipelineStore, isPreviewable } from './documents.js';
import { detectHost, publishHostContext } from './host.js';
import { InProcessDiagnosticService, type DiagnosticService } from './diagnostics/index.js';
import { PreviewManager } from './preview/manager.js';
import { PREVIEW_VIEW_TYPE } from './preview/panel.js';
import { registerCommands } from './commands/index.js';
import { registerFormatter } from './format.js';
import { registerCodeLens } from './codelens.js';
import { registerCompletion } from './completion.js';
import { registerReader } from './reader.js';
import { createMarkdownItExtension, type MarkdownItLike } from './markdownit.js';
import { editorKind } from './preview/panel.js';

/**
 * What `activate` resolves to.
 *
 * VS Code's built-in Markdown preview looks for `extendMarkdownIt` on the
 * exported API of any extension contributing `markdown.markdownItPlugins`
 * (SPEC 29.2), and calls it with its own markdown-it instance.
 */
export interface MdvExtensionApi {
  extendMarkdownIt(md: MarkdownItLike): MarkdownItLike;
}

/** Called by VS Code on `onLanguage:mdv` or `onLanguage:markdown`. */
export function activate(context: vscode.ExtensionContext): MdvExtensionApi {
  const channel = createLogChannel();
  context.subscriptions.push(channel);

  const host = detectHost();
  const settings = new SettingsStore();
  const pipelines = new PipelineStore();
  const previews = new PreviewManager(context.extensionUri, settings, pipelines);

  // The LSP swap point. Replacing this one line with a `LanguageClient`-backed
  // service is the whole of adopting SPEC 29.4.
  const diagnostics: DiagnosticService = new InProcessDiagnosticService(settings, pipelines);

  context.subscriptions.push(
    settings,
    pipelines,
    previews,
    diagnostics,
    registerCommands({ extension: context, settings, pipelines, previews, diagnostics, host }),
    registerFormatter(settings),
    registerCodeLens(settings, pipelines),
    registerCompletion(settings, pipelines),
    registerReader(previews),
    vscode.window.registerWebviewPanelSerializer(PREVIEW_VIEW_TYPE, previews.serializer()),
  );

  // `mdv.validate.*` and `mdv.security.*` change what the diagnostics say, so a
  // settings change has to re-validate rather than wait for the next keystroke.
  context.subscriptions.push(
    settings.onDidChange(
      safe('settings change', () => {
        pipelines.invalidateAll();
        diagnostics.revalidateAll();
        previews.refreshAll();
      }),
    ),
    // A new editor colour theme changes `auto`, which changes every rendered
    // block; the previews handle themselves, the diagnostics need telling.
    vscode.window.onDidChangeActiveColorTheme(
      safe('color theme change', () => {
        pipelines.invalidateAll();
        diagnostics.revalidateAll();
      }),
    ),
  );

  // Everything below happens after `activate` returns.
  queueMicrotask(
    safe('post-activation', () => {
      void publishHostContext(host);
      log(
        `activated — node host: ${String(host.node)}, workspace trusted: ${String(host.trusted)}, ` +
          `diagnostics: ${diagnostics.kind} (the SPEC 29.4 language server is not implemented)`,
      );
      if (settings.current.preview.openOnStartup) openStartupPreview(previews);
    }),
  );

  // Returned synchronously: VS Code's Markdown preview reads it off the resolved
  // activation value, and building it is a closure allocation, not work.
  return {
    extendMarkdownIt: createMarkdownItExtension(() => settings.current, editorKind),
  };
}

/** `mdv.preview.openOnStartup` (SPEC 29.6). */
function openStartupPreview(previews: PreviewManager): void {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || !isPreviewable(editor.document)) return;
  const column = editor.viewColumn;
  previews.show(
    editor.document.uri,
    column === undefined || column === vscode.ViewColumn.Three
      ? vscode.ViewColumn.Beside
      : column + 1,
  );
}

/** Called by VS Code on shutdown. Disposables registered on the context are automatic. */
export function deactivate(): void {
  disposeLogChannel();
}

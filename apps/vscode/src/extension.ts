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
 * SPEC 29.4's language server lives in `@mdv/lsp` and runs out of process. This
 * module does not know which host it is in and does not import either half of
 * `vscode-languageclient`: it takes a {@link LanguageClientFactory} and lets
 * `extension-node.ts` or `extension-web.ts` decide. That is also the engine
 * switch — a factory means the server, no factory means the in-process
 * diagnostics of `diagnostics/inprocess.ts` — because SPEC 29.6's settings list
 * is closed and a user-facing toggle is not one of the settings on it.
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
import { LanguageServerDiagnosticService, type LanguageClientFactory } from './lsp/client.js';
import { PreviewManager } from './preview/manager.js';
import { PREVIEW_VIEW_TYPE } from './preview/panel.js';
import { registerCommands } from './commands/index.js';
import { registerFormatter } from './format.js';
import { registerCodeLens } from './codelens.js';
import { registerCompletion } from './completion.js';
import { registerReader } from './reader.js';
import { WorkspaceThemeFiles, setActiveThemeFiles } from './themefiles.js';
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

/**
 * Activation, minus the one thing the two hosts disagree about.
 *
 * Called from `extension-node.ts` and `extension-web.ts`, which are what VS Code
 * actually loads; neither adds anything but the factory.
 *
 * @param createClient How to build a language client, or `undefined` to compute
 *   diagnostics in this process. Nothing else in the extension changes shape
 *   between the two — see {@link DiagnosticService}.
 */
export function activateWith(
  context: vscode.ExtensionContext,
  createClient?: LanguageClientFactory,
): MdvExtensionApi {
  const channel = createLogChannel();
  context.subscriptions.push(channel);

  const host = detectHost();
  const settings = new SettingsStore();
  const pipelines = new PipelineStore();
  const previews = new PreviewManager(context.extensionUri, settings, pipelines);

  // SPEC 11.6: `theme:` may name a file. Constructing the store reads nothing —
  // the first read is triggered by the first block that names a file.
  const themeFiles = new WorkspaceThemeFiles();
  setActiveThemeFiles(themeFiles);

  // The LSP swap point (SPEC 29.4). Constructing the service starts nothing
  // synchronously — the client queues its own start — so the budget above holds
  // either way.
  const diagnostics: DiagnosticService =
    createClient === undefined
      ? new InProcessDiagnosticService(settings, pipelines)
      : new LanguageServerDiagnosticService(() => settings.current, createClient);

  context.subscriptions.push(
    settings,
    pipelines,
    previews,
    diagnostics,
    themeFiles,
    new vscode.Disposable(() => setActiveThemeFiles(undefined)),
    registerCommands({ extension: context, settings, pipelines, previews, diagnostics, host }),
    ...inProcessProviders(diagnostics, settings, pipelines),
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
    // A theme file landed, changed, or became readable when trust was granted.
    // The store has already bumped its revision, so the blocks that name the
    // file miss their cache; the ones that don't still hit it.
    themeFiles.onDidChange(
      safe('theme file change', () => {
        diagnostics.revalidateAll();
        previews.refreshAll();
      }),
    ),
  );

  // Everything below happens after `activate` returns.
  queueMicrotask(
    safe('post-activation', () => {
      void publishHostContext(host);
      log(
        `activated — node host: ${String(host.node)}, workspace trusted: ${String(host.trusted)}, ` +
          `language features: ${diagnostics.kind}`,
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

/**
 * The language features this process answers itself.
 *
 * Formatting, completion and code lenses are not diagnostics, but they are in
 * `@mdv/lsp`'s advertised capabilities (`mdvFeatures`, SPEC 29.4), so when the
 * server is running these three registrations are not a fallback — they are a
 * duplicate. VS Code merges providers rather than choosing between them: every
 * completion item would appear twice and every lens row would render twice.
 *
 * The diagnostics engine is the thing asked, rather than `createClient`,
 * because the question is which process is answering, and `kind` is that answer.
 */
function inProcessProviders(
  diagnostics: DiagnosticService,
  settings: SettingsStore,
  pipelines: PipelineStore,
): vscode.Disposable[] {
  if (diagnostics.kind !== 'in-process') return [];
  return [
    registerFormatter(settings),
    registerCodeLens(settings, pipelines),
    registerCompletion(settings, pipelines),
  ];
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

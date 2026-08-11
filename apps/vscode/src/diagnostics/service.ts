/**
 * The diagnostics seam (SPEC 29.4).
 *
 * SPEC 29.4 specifies a full language server in `@mdv/lsp`: diagnostics,
 * completion, hover, code actions, formatting, symbols, folding, rename, inlay
 * hints, code lenses and semantic tokens, over stdio on the desktop and a web
 * worker in the browser. Both ends exist — `lsp/server-node.ts` and
 * `lsp/server-worker.ts` — but the extension still computes diagnostics
 * in-process by default, by calling `@mdv/core` directly.
 *
 * This file is the interface that makes the substitution cheap. Everything
 * outside `diagnostics/` sees only {@link DiagnosticService}: construct it,
 * hold it in the subscription list, call {@link DiagnosticService.revalidateAll}
 * when settings change, and dispose it. Whether the diagnostics came from an
 * in-process call or from a `vscode-languageclient` publishing over LSP is not
 * visible from the outside, and the swap is one line in `extension.ts`:
 *
 * ```ts
 * const diagnostics: DiagnosticService = useLsp
 *   ? new LanguageServerDiagnosticService(() => settings.current, createClient)
 *   : new InProcessDiagnosticService(settings, pipelines);
 * ```
 *
 * The LSP variant (`lsp/client.ts`) owns the `LanguageClient` and lets the
 * *server* publish into VS Code's diagnostic store; `revalidate` becomes a
 * `workspace/didChangeConfiguration` nudge, and a settings change that moves the
 * server's payload becomes a restart. Neither the preview nor the commands
 * change either way.
 */

import type * as vscode from 'vscode';

/** How diagnostics are being produced right now. */
export type DiagnosticEngineKind = 'in-process' | 'language-server';

/**
 * The whole of the extension's contract with its diagnostics engine.
 *
 * Deliberately tiny: the engine owns its own `DiagnosticCollection`, its own
 * debouncing and its own document lifecycle. The rest of the extension only ever
 * needs to say "settings changed, look again".
 */
export interface DiagnosticService extends vscode.Disposable {
  readonly kind: DiagnosticEngineKind;
  /** Re-validate one document now, cancelling any pending debounce for it. */
  revalidate(document: vscode.TextDocument): void;
  /** Re-validate every open MDV document — used after a settings change. */
  revalidateAll(): void;
}

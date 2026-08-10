/**
 * The diagnostics seam (SPEC 29.4, deferred).
 *
 * SPEC 29.4 specifies a full language server in `@mdv/lsp`: diagnostics,
 * completion, hover, code actions, formatting, symbols, folding, rename, inlay
 * hints, code lenses and semantic tokens, over stdio on the desktop and a web
 * worker in the browser. **That server is milestone M7 and is not implemented in
 * this tree.** The extension therefore computes diagnostics in-process, by
 * calling `@mdv/core` directly.
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
 *   ? new LanguageServerDiagnosticService(context, settings)   // future
 *   : new InProcessDiagnosticService(settings, pipelines);     // today
 * ```
 *
 * The LSP variant would own a `LanguageClient` and let the *server* publish into
 * VS Code's diagnostic store; `revalidate` would become a no-op or a
 * `textDocument/diagnostic` refresh request. Neither the preview nor the
 * commands would change.
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

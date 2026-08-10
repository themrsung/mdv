/**
 * Quick fixes (SPEC 14.2, 29.4).
 *
 * The server invents nothing here. `Diagnostic.fixes` is a channel the pipeline
 * already fills — "a machine-applicable fix, surfaced by the LSP as a code
 * action" — and this feature is the surfacing: it re-runs the pipeline, keeps
 * the diagnostics the client's range touches, and turns each of their fixes into
 * a `CodeAction` carrying a `WorkspaceEdit`. A fix this server offers is one the
 * CLI prints under the same diagnostic, because both read the same field.
 *
 * Two consequences of that division, both deliberate:
 *
 *   - There are no `source.*` actions. A "fix all in file" would have to decide
 *     which fixes compose, and that is a judgement about MDV, which lives in
 *     `@mdv/core` or nowhere. When the pipeline offers one, this feature will
 *     pass it on.
 *   - Every action is a literal `CodeAction` with its edit attached. Nothing is
 *     computed lazily behind a `command`, so there is no `codeAction/resolve`
 *     and no `workspace/executeCommand` for a client to route.
 *
 * The re-run is the same trade the other request features make: a fix is asked
 * for once, by a human, after a pause, and a stale cache would hand that human
 * an edit against text they have since changed.
 */

import { Mdv } from '@mdv/core';
import { CodeActionKind } from '../protocol/types.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import { throwIfCancelled } from '../protocol/connection.js';
import { toLspDiagnostic, toLspEdit, toLspRange } from '../convert.js';
import { configFor, type BlockSettings } from './site.js';
import type { TextDocument } from '../documents.js';
import type { CancellationToken } from '../protocol/connection.js';
import type { Feature, ServerContext } from '../server.js';
import type {
  CodeAction,
  CodeActionParams,
  Range as LspRange,
  ServerCapabilities,
} from '../protocol/types.js';
import type { CodeFix, Diagnostic as MdvDiagnostic } from '@mdv/parser';

/**
 * Named against the grain of the protocol's `CodeActionOptions`, which is the
 * shape that goes in `ServerCapabilities`.
 */
export type CodeActionSettings = BlockSettings;

/** What went wrong, as a string, whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the client asked for this kind.
 *
 * `only` is a list of *prefixes*, matched a dot-separated segment at a time:
 * `refactor` selects `refactor.extract`, but `quickfix.mdv` does not select the
 * plain `quickfix` these actions carry. An absent list means "everything"; an
 * empty one is a client asking for nothing, and gets it.
 */
function wanted(only: readonly string[] | undefined, kind: string): boolean {
  if (only === undefined) return true;
  return only.some((filter) => kind === filter || kind.startsWith(`${filter}.`));
}

/**
 * Whether two ranges meet, touching included.
 *
 * A cursor resting against either end of a squiggle is the commonest way to ask
 * for its fix — the author has just finished typing the word — so an empty
 * request range that abuts a diagnostic still counts as inside it.
 */
function meets(a: LspRange, b: LspRange): boolean {
  return !(before(a.end, b.start) || before(b.end, a.start));
}

function before(left: LspRange['start'], right: LspRange['start']): boolean {
  return left.line < right.line || (left.line === right.line && left.character < right.character);
}

class CodeActions {
  readonly #context: ServerContext;
  readonly #options: CodeActionSettings;

  constructor(context: ServerContext, options: CodeActionSettings) {
    this.#context = context;
    this.#options = options;
  }

  listen(): void {
    this.#context.onRequest('textDocument/codeAction', (params, token) =>
      this.#actions(params as CodeActionParams, token),
    );
  }

  async #actions(params: CodeActionParams, token: CancellationToken): Promise<CodeAction[]> {
    // Answered before the document is even looked up: a client filtering for
    // `source.organizeImports` on every keystroke is not worth a parse.
    if (!wanted(params.context?.only, CodeActionKind.quickFix)) return [];

    const { uri } = params.textDocument;
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      // The same answer formatting gives: a client may only act on what it has
      // opened, and an edit against a document this server never saw would be
      // an edit against a guess.
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }

    const found = await this.#lint(document);
    throwIfCancelled(token);
    if (found === undefined) return [];

    const actions: CodeAction[] = [];
    for (const diagnostic of found) {
      if (diagnostic.fixes === undefined || diagnostic.fixes.length === 0) continue;
      // The published range, not the raw one: what the author sees underlined is
      // what they can put a cursor in, and `toLspRange` is what published it.
      if (!meets(params.range, toLspRange(document, diagnostic.range))) continue;
      for (const fix of diagnostic.fixes) {
        actions.push(this.#action(document, diagnostic, fix));
      }
    }
    return actions;
  }

  /** One fix, as the client applies it. */
  #action(document: TextDocument, diagnostic: MdvDiagnostic, fix: CodeFix): CodeAction {
    return {
      title: fix.title,
      kind: CodeActionKind.quickFix,
      // The diagnostic this answers, so the client can group the action under
      // it and clear the squiggle the moment the edit lands.
      diagnostics: [toLspDiagnostic(document, diagnostic)],
      ...(fix.preferred === true ? { isPreferred: true } : {}),
      edit: {
        changes: { [document.uri]: fix.edits.map((edit) => toLspEdit(document, edit)) },
      },
    };
  }

  /**
   * The document's diagnostics, or `undefined` when the run failed.
   *
   * `Mdv#lint` rejects only on capability failures — a host that promised a
   * `src:` fetcher and then threw — so a rejection is the host's bug and the
   * author's answer is an empty menu rather than a broken request.
   */
  async #lint(document: TextDocument): Promise<readonly MdvDiagnostic[] | undefined> {
    const source = document.text;
    try {
      return await new Mdv(configFor(this.#options.config, document)).lint(source);
    } catch (error) {
      this.#context.logger.error(`Code actions for ${document.uri} failed: ${reasonOf(error)}`);
      return undefined;
    }
  }
}

/**
 * Install code actions.
 *
 * ```ts
 * createServer(transport, { features: [codeActions({ config })] });
 * ```
 */
export function codeActions(options: CodeActionSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new CodeActions(context, options);
    feature.listen();
    // The kinds are declared so that a client with a `source.fixAll` keybinding
    // can skip this server instead of waiting on a parse to be told "none".
    return { codeActionProvider: { codeActionKinds: [CodeActionKind.quickFix] } };
  };
}

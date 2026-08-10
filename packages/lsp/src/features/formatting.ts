/**
 * Canonical formatting, whole and in part (SPEC 29.4).
 *
 * SPEC 29.4 asks for "document and range formatting via `mdv fmt` (§27);
 * `formatOnSave` supported". The "via `mdv fmt`" is the whole design: this
 * feature runs the same `parse` → `toMarkdown` pass the CLI runs, with the same
 * refusal rule, so a file formatted on save and a file formatted in CI are
 * byte-identical. A formatter that disagrees with its own linter is worse than
 * no formatter.
 *
 * `formatOnSave` is not a server capability — it is a client setting that turns
 * a save into a `textDocument/formatting` request. There is nothing to
 * implement; there is only the requirement that the request be fast and never
 * destructive, because it now runs on a keystroke the author didn't think of as
 * a formatting command.
 *
 * ## The refusal
 *
 * A formatter that changes the meaning of a document is a bug, and the only
 * safe response to it is to write nothing (SPEC 27). So the result is re-parsed
 * and compared with {@link sameDocument} before any edit is offered. If they
 * differ the request answers `null` — "no edits" — and logs. The author keeps
 * their file; the alternative is silently rewriting a document into a different
 * one at the moment they pressed save.
 *
 * ## Ranges
 *
 * A Markdown document does not decompose. A table's column widths depend on
 * every row, a heading's canonical indent depends on its ancestors, and a
 * reference is resolved against the whole file. So range formatting formats the
 * document and then discards every edit that falls outside the selection
 * ({@link editsWithin}). The author gets exactly what they selected, computed
 * with the context the formatter actually needs.
 *
 * ## The client's `FormattingOptions`
 *
 * `tabSize` and `insertSpaces` are ignored, deliberately. SPEC 5.3.1 fixes
 * header indentation at exactly two spaces per level, and anything else is
 * `MDV1212` on re-parse — honouring an editor's `tabSize: 4` would produce a
 * file this project's own linter rejects. `trimTrailingWhitespace` and
 * `insertFinalNewline` are ignored for the opposite reason: canonical
 * formatting already does both, unconditionally, and there is no way to ask it
 * not to.
 */

import { parse, sameDocument, toMarkdown } from '@mdv/parser';
import { editsWithin, textEdits } from '../edits.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { FormatOptions } from '@mdv/parser';
import type { TextDocument } from '../documents.js';
import type { CancellationToken } from '../protocol/connection.js';
import type {
  DocumentFormattingParams,
  DocumentRangeFormattingParams,
  ServerCapabilities,
  TextEdit,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';

/**
 * How this feature is configured. Not LSP's `FormattingOptions`, which is what
 * the *client* sends with each request and which this server ignores — see the
 * note at the top of the file.
 */
export interface FormatterOptions {
  /**
   * How to format, or a function of the document being formatted. A function
   * is what a host with per-workspace-folder settings needs; it is called on
   * every request rather than cached, because a setting can change between two
   * saves and nobody would think to restart the server.
   *
   * @defaultValue canonical formatting — {@link FormatOptions} defaults
   */
  readonly format?: FormatOptions | ((document: TextDocument) => FormatOptions);
}

/** What went wrong, as a string, whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Formatting {
  readonly #context: ServerContext;
  readonly #options: FormatterOptions;

  constructor(context: ServerContext, options: FormatterOptions) {
    this.#context = context;
    this.#options = options;
  }

  listen(): void {
    this.#context.onRequest('textDocument/formatting', (params, token) =>
      this.whole(params as DocumentFormattingParams, token),
    );
    this.#context.onRequest('textDocument/rangeFormatting', (params, token) =>
      this.part(params as DocumentRangeFormattingParams, token),
    );
  }

  /** The document the request names, or the error LSP expects when it is gone. */
  #document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      // A client may only format what it has opened. Reading the file from disk
      // instead would format text the author cannot see and has not consented
      // to have rewritten.
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }

  /**
   * Format, or decide not to.
   *
   * `undefined` means "no edits, and the reason is already logged" — either the
   * document is already canonical, or formatting it would have changed it.
   */
  #format(document: TextDocument): string | undefined {
    const source = document.text;
    const chosen = this.#options.format;
    const format = typeof chosen === 'function' ? chosen(document) : (chosen ?? {});

    const before = parse(source);
    let formatted: string;
    try {
      formatted = toMarkdown(before, format);
    } catch (error) {
      // `toMarkdown` throwing is a bug in this package, not in the document —
      // but the author is mid-save and should lose nothing over it.
      this.#context.logger.error(`Formatting ${document.uri} failed: ${reasonOf(error)}`);
      return undefined;
    }
    if (formatted === source) return undefined;

    if (!sameDocument(parse(formatted), before)) {
      this.#context.logger.error(
        `Refusing to format ${document.uri}: the formatted document does not parse back to the same AST. ` +
          'This is a bug in @mdv/parser toMarkdown. Please report it with the file attached.',
      );
      return undefined;
    }
    return formatted;
  }

  /** `textDocument/formatting`. */
  whole(params: DocumentFormattingParams, token: CancellationToken): TextEdit[] | null {
    const document = this.#document(params.textDocument.uri);
    const formatted = this.#format(document);
    throwIfCancelled(token);
    if (formatted === undefined) return null;
    // The document cannot have moved: a request is handled to completion before
    // the next message is read, and formatting does not await.
    return textEdits(document, formatted);
  }

  /** `textDocument/rangeFormatting`. */
  part(params: DocumentRangeFormattingParams, token: CancellationToken): TextEdit[] | null {
    const document = this.#document(params.textDocument.uri);
    const formatted = this.#format(document);
    throwIfCancelled(token);
    if (formatted === undefined) return null;
    const within = editsWithin(textEdits(document, formatted), params.range);
    // An empty list and `null` both mean "nothing to do", but a client that
    // shows "formatted" on a non-empty response should not be told it happened.
    return within.length === 0 ? null : within;
  }
}

/**
 * Install formatting.
 *
 * ```ts
 * createServer(transport, { features: [formatting()] });
 * ```
 */
export function formatting(options: FormatterOptions = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    new Formatting(context, options).listen();
    return { documentFormattingProvider: true, documentRangeFormattingProvider: true };
  };
}

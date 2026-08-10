/**
 * Validation, in both directions (SPEC 29.4).
 *
 * SPEC 29.4 asks for "full pipeline validation on change (debounced 300 ms), on
 * save, and on open. Ranges from §14.4." That is the **push** half: the server
 * volunteers `textDocument/publishDiagnostics` as the author types. LSP 3.17
 * added a **pull** half — the client asks `textDocument/diagnostic` when it
 * wants an answer, which is how a client can validate the file the user is
 * looking at first, and stop asking about the ones they closed.
 *
 * Both are implemented, and exactly one is used per session: a client that
 * announces `textDocument.diagnostic` gets no pushes. Doing both would show
 * every problem twice in clients that merge the two channels, and fight over
 * ownership in the ones that don't.
 *
 * What is validated is `Mdv#lint` — "parse, resolve and validate without
 * rendering", the same call `mdv lint` makes, so a squiggle and a CI failure can
 * never disagree about a document.
 *
 * ## Debouncing
 *
 * A keystroke is not a request to validate; a pause is. Every change restarts a
 * 300 ms timer and only the last one survives, so a burst of typing costs one
 * pipeline run. `open` and `save` skip the wait — both are moments where the
 * author has stopped and is looking at the file.
 *
 * ## Staleness
 *
 * Validation is asynchronous and the mirror is mutable, so between the start of
 * a run and its result the document may have moved on. Every run captures the
 * version it was started for and drops its result if the mirror has changed
 * since — publishing ranges computed against text the client has already
 * replaced is how a language server ends up underlining the wrong word.
 */

import { Mdv } from '@mdv/core';
import { toLspDiagnostics } from '../convert.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { MdvConfig } from '@mdv/core';
import type { Diagnostic as MdvDiagnostic } from '@mdv/parser';
import type { TextDocument } from '../documents.js';
import type { CancellationToken } from '../protocol/connection.js';
import type {
  Diagnostic as LspDiagnostic,
  DocumentDiagnosticParams,
  DocumentDiagnosticReport,
  ServerCapabilities,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';

/** How long a burst of keystrokes runs before the pipeline does (SPEC 29.4). */
export const VALIDATE_DEBOUNCE_MS = 300;

/** Undoes a {@link Schedule}. Calling it after the callback ran does nothing. */
export type Cancel = () => void;

/** `setTimeout`, narrowed to what the debounce needs. */
export type Schedule = (callback: () => void, delayMs: number) => Cancel;

/**
 * The timer functions, read off `globalThis`.
 *
 * `@mdv/lsp` compiles against `ES2022` alone — no `DOM`, no `@types/node` —
 * because it has to be true in a stdio process and in a web worker, and the two
 * disagree about what `setTimeout` returns. Nobody needs to know: the handle is
 * opaque and only travels from one call to the other. A host with a different
 * clock replaces the pair through {@link DiagnosticsOptions.schedule}.
 */
const timers = globalThis as unknown as {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const defaultSchedule: Schedule = (callback, delayMs) => {
  const handle = timers.setTimeout(callback, delayMs);
  return () => {
    timers.clearTimeout(handle);
  };
};

export interface DiagnosticsOptions {
  /**
   * The configuration to validate against (SPEC 25), or a function of the
   * document for a host that scopes config per workspace folder. The host owns
   * this: the server has no filesystem to find an `mdv.config` in.
   */
  readonly config?: MdvConfig | ((document: TextDocument) => MdvConfig | undefined);
  /** Defaults to {@link VALIDATE_DEBOUNCE_MS}. */
  readonly debounceMs?: number;
  /** Defaults to `globalThis.setTimeout`. Tests hand in a clock they control. */
  readonly schedule?: Schedule;
}

/** What went wrong, as a string, whatever was thrown. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class Diagnostics {
  readonly #context: ServerContext;
  readonly #options: DiagnosticsOptions;
  readonly #schedule: Schedule;
  readonly #debounceMs: number;
  /** Pending debounce per document. */
  readonly #timers = new Map<string, Cancel>();
  /** The tail of the run queue per document, so two runs cannot interleave. */
  readonly #runs = new Map<string, Promise<void>>();
  /**
   * Bumped when the configuration changes. It rides in every `resultId`, so a
   * client holding a report from the old configuration cannot be told
   * "unchanged" — the text is the same but the answer is not.
   */
  #generation = 0;

  constructor(context: ServerContext, options: DiagnosticsOptions) {
    this.#context = context;
    this.#options = options;
    this.#schedule = options.schedule ?? defaultSchedule;
    this.#debounceMs = options.debounceMs ?? VALIDATE_DEBOUNCE_MS;
  }

  /**
   * Whether this client is pushed to.
   *
   * Asked on every event rather than cached at `initialize`, because a feature
   * is installed before the handshake — there are no client capabilities to read
   * yet when this class is constructed.
   */
  #pushes(): boolean {
    return this.#context.client().textDocument?.diagnostic === undefined;
  }

  listen(): void {
    this.#context.documents.onDidChangeContent((event) => {
      if (!this.#pushes()) return;
      if (event.reason === 'change') this.#later(event.document);
      else this.#now(event.document);
    });

    this.#context.documents.onDidClose((uri) => {
      this.#cancel(uri);
      this.#runs.delete(uri);
      // The document is gone; so must its problems be. A client that keeps
      // showing errors for a file the server no longer mirrors is showing
      // errors nobody can fix.
      if (this.#pushes()) this.#publish(uri, undefined, []);
    });

    this.#context.onNotification('workspace/didChangeConfiguration', () => {
      this.#invalidate();
    });

    this.#context.onRequest('textDocument/diagnostic', (params, token) =>
      this.pull(params as DocumentDiagnosticParams, token),
    );
  }

  /** Validate after the author stops typing. */
  #later(document: TextDocument): void {
    const { uri } = document;
    this.#cancel(uri);
    this.#timers.set(
      uri,
      this.#schedule(() => {
        this.#timers.delete(uri);
        // Re-read: between the keystroke and the timer the document may have
        // been closed, and the object handed to the listener would be a ghost.
        const current = this.#context.documents.get(uri);
        if (current !== undefined) this.#now(current);
      }, this.#debounceMs),
    );
  }

  /** Validate now, superseding anything the debounce was waiting to do. */
  #now(document: TextDocument): void {
    const { uri, version } = document;
    this.#cancel(uri);
    this.#enqueue(uri, async () => {
      const found = await this.#lint(document);
      if (found === undefined) return;
      const current = this.#context.documents.get(uri);
      if (current === undefined || current.version !== version) return;
      this.#publish(uri, version, toLspDiagnostics(current, found));
    });
  }

  #cancel(uri: string): void {
    this.#timers.get(uri)?.();
    this.#timers.delete(uri);
  }

  /**
   * Run `work` after whatever is already running for this document.
   *
   * Two pipeline runs for one file racing each other would publish in whichever
   * order they happened to finish, and the loser would win.
   */
  #enqueue(uri: string, work: () => Promise<void>): void {
    const queued = (this.#runs.get(uri) ?? Promise.resolve()).then(work, work).catch((error) => {
      this.#context.logger.error(`Publishing diagnostics for ${uri} failed: ${reasonOf(error)}`);
    });
    this.#runs.set(uri, queued);
    void queued.then(() => {
      if (this.#runs.get(uri) === queued) this.#runs.delete(uri);
    });
  }

  #publish(uri: string, version: number | undefined, diagnostics: readonly LspDiagnostic[]): void {
    this.#context.connection.sendNotification('textDocument/publishDiagnostics', {
      uri,
      ...(version === undefined ? {} : { version }),
      diagnostics,
    });
  }

  /**
   * One pipeline run.
   *
   * `Mdv#lint` "rejects only on capability failures" — a host that promised a
   * `src:` fetcher and then threw. Document problems come back as diagnostics,
   * so a rejection here is the host's bug, not the author's: it is logged and
   * the last good answer is left standing rather than replaced by a confident
   * empty list.
   */
  async #lint(document: TextDocument): Promise<readonly MdvDiagnostic[] | undefined> {
    // Snapshot first: the mirror is mutated in place by the next `didChange`,
    // and a run must lint one consistent text.
    const source = document.text;
    const { config } = this.#options;
    const resolved = typeof config === 'function' ? config(document) : config;
    try {
      return await new Mdv(resolved).lint(source);
    } catch (error) {
      this.#context.logger.error(`Validating ${document.uri} failed: ${reasonOf(error)}`);
      return undefined;
    }
  }

  /**
   * A report is identified by the configuration and the document version that
   * produced it. Both are cheap to compare and neither can change without
   * changing the answer, so no cache of previous results is needed to say
   * "unchanged".
   */
  #resultId(document: TextDocument): string {
    return `${this.#generation}.${document.version}`;
  }

  /** `textDocument/diagnostic`: the client asks. */
  async pull(
    params: DocumentDiagnosticParams,
    token: CancellationToken,
  ): Promise<DocumentDiagnosticReport> {
    const { uri } = params.textDocument;
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      // `workspaceDiagnostics` and `interFileDependencies` are both false, so a
      // conforming client only pulls for documents it has opened. Answering an
      // empty report for anything else would claim a clean bill of health for a
      // file this server has never read.
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }

    const resultId = this.#resultId(document);
    if (params.previousResultId === resultId) return { kind: 'unchanged', resultId };

    const found = await this.#lint(document);
    throwIfCancelled(token);
    if (found === undefined) {
      // Nothing to say. Hold the client's previous report rather than clear it.
      return params.previousResultId === undefined
        ? { kind: 'full', items: [] }
        : { kind: 'unchanged', resultId: params.previousResultId };
    }
    return { kind: 'full', resultId, items: toLspDiagnostics(document, found) };
  }

  /**
   * The configuration changed, so every answer already given is suspect.
   *
   * A pushed client is simply re-validated. A pulling client is asked to come
   * back through `workspace/diagnostic/refresh` — the server may not interrupt
   * to hand it a result it did not ask for. A client that supports neither will
   * catch up on its next edit.
   */
  #invalidate(): void {
    this.#generation += 1;
    if (this.#pushes()) {
      for (const document of this.#context.documents.all()) this.#now(document);
      return;
    }
    if (this.#context.client().workspace?.diagnostics?.refreshSupport !== true) return;
    void this.#context.connection
      .sendRequest('workspace/diagnostic/refresh')
      .catch((error: unknown) => {
        this.#context.logger.error(`Refresh request refused: ${reasonOf(error)}`);
      });
  }
}

/**
 * Install validation.
 *
 * ```ts
 * createServer(transport, { features: [diagnostics({ config })] });
 * ```
 */
export function diagnostics(options: DiagnosticsOptions = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Diagnostics(context, options);
    feature.listen();
    return {
      diagnosticProvider: {
        identifier: 'mdv',
        interFileDependencies: false,
        workspaceDiagnostics: false,
      },
    };
  };
}

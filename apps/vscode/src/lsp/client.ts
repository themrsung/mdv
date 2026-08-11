/**
 * The extension as a language *client* (SPEC 29.4).
 *
 * `server-node.ts` and `server-worker.ts` are the two ends `@mdv/lsp` runs in.
 * This file is the other side of the wire: a {@link DiagnosticService} that owns
 * a `vscode-languageclient` client, hands it the settings payload
 * `lsp/settings.ts` writes, and then gets out of the way — the *server* pushes
 * `textDocument/publishDiagnostics`, and the client library drops them into a
 * `vscode.DiagnosticCollection` it created and owns. Nothing in the extension
 * converts a diagnostic any more; `diagnostics/convert.ts` is the in-process
 * path's business alone.
 *
 * ## Why this file does not import `vscode-languageclient`
 *
 * The client class differs per host — `vscode-languageclient/node` spawns
 * `dist/server.cjs` as a process, `vscode-languageclient/browser` starts
 * `dist/web/server.js` as a `Worker` — and their constructors take different
 * arguments. A single module that imported either one would pull `node:child_process`
 * into the browser bundle or a `Worker` into the desktop one.
 *
 * So the construction is a parameter: {@link LanguageClientFactory}. This file
 * holds the half that is identical in both hosts (when to start, when to
 * restart, what to tell the server) and knows the concrete client only through
 * {@link LanguageClientLike}, the four members of `BaseLanguageClient` it
 * actually uses. That also makes the lifecycle testable in a plain Node process,
 * which is the whole of `test/lsp-client.test.ts`.
 *
 * ## Why a settings change is a restart
 *
 * `@mdv/lsp` is configured once, at construction: `featureSettings(payload)`
 * bakes the `MdvConfig` into every feature, and the server's
 * `workspace/didChangeConfiguration` handler only *invalidates* — it re-runs the
 * pipeline, it does not re-read the settings. So the notification is right for a
 * change that leaves the payload alone (a theme file landed, the colour theme
 * flipped, a document needs looking at again) and wrong for one that does not.
 * When the five payload fields actually move, the honest answer is a new server
 * started with new argv, and {@link LanguageServerDiagnosticService} tells the
 * two cases apart by comparing payloads rather than by trusting the caller.
 *
 * ## Failure
 *
 * A server that will not start must not take the extension host with it: every
 * lifecycle step is queued and wrapped, and a failure leaves the service alive
 * with no client, logging why. Choosing to fall back to the in-process engine is
 * `extension.ts`'s decision, not this file's.
 */

import type * as vscode from 'vscode';

import type { DiagnosticEngineKind, DiagnosticService } from '../diagnostics/service.js';
import { log, logError } from '../log.js';
import type { MdvSettings } from '../settings.js';
import { serverSettings, type ServerSettings } from './settings.js';

/**
 * The client id, and the reason it is not free to change.
 *
 * `vscode-languageclient` reads its trace level from the configuration section
 * `${id}.trace.server`. SPEC 29.6 spells that setting `mdv.trace.server`, so the
 * id has to be `mdv` for the setting the manifest contributes to be the setting
 * the client obeys. There is no second place to configure it.
 */
export const CLIENT_ID = 'mdv';

/** The human-readable client name; also names the client's output channel. */
export const CLIENT_NAME = 'MDV Language Server';

/**
 * The name of the collection the client publishes into.
 *
 * The same name the in-process engine gives its own collection, so the two
 * engines cannot both be showing squiggles for the same file under different
 * headings, and so a swap does not change what the Problems panel groups.
 */
export const DIAGNOSTIC_COLLECTION = 'mdv';

/** The notification that asks a running server to look at everything again. */
export const DID_CHANGE_CONFIGURATION = 'workspace/didChangeConfiguration';

/**
 * The documents the server is told about.
 *
 * In-process, `isPreviewable` accepts the `mdv` language plus any Markdown
 * document that *contains* an `mdv` fence. A `DocumentSelector` cannot ask that
 * question, so the selector is the widest thing that cannot be wrong: all
 * Markdown. A Markdown file with no MDV block parses to no blocks and publishes
 * no diagnostics, which is the same answer the in-process engine gives it.
 *
 * The two language ids are written out rather than imported from `documents.ts`,
 * which imports `vscode` — see the header.
 */
export const MDV_DOCUMENT_SELECTOR: readonly DocumentFilterLike[] = Object.freeze([
  { language: 'mdv' },
  { language: 'markdown' },
]);

/** The `DocumentFilter` shape this file produces. */
export interface DocumentFilterLike {
  readonly language: string;
}

/**
 * The slice of `vscode-languageclient`'s `LanguageClientOptions` this file owns.
 *
 * Only the parts that must be identical in both hosts. A host adapter spreads
 * this into the real options object and adds what only it can express — the
 * `RevealOutputChannelOn.Never` enum member, an `outputChannel` shared with the
 * extension's own — without either host being able to disagree about the
 * document selector or the collection name.
 */
export interface MdvClientOptions {
  readonly documentSelector: readonly DocumentFilterLike[];
  readonly diagnosticCollectionName: string;
  readonly outputChannelName: string;
  /**
   * Sent with `initialize`. The server also receives the payload out of band —
   * argv on the desktop, `?settings=` in the worker's script URL — because it
   * must be configured before the handshake it answers. This copy is what makes
   * the configuration visible to anything reading the initialize params.
   */
  readonly initializationOptions: ServerSettings;
}

/** The options every host builds, given the payload it is starting a server with. */
export function clientOptions(payload: ServerSettings): MdvClientOptions {
  return {
    documentSelector: MDV_DOCUMENT_SELECTOR,
    diagnosticCollectionName: DIAGNOSTIC_COLLECTION,
    outputChannelName: CLIENT_NAME,
    initializationOptions: payload,
  };
}

/**
 * The four members of `BaseLanguageClient` this file uses.
 *
 * Structural on purpose: `new LanguageClient(...)` from either
 * `vscode-languageclient/node` or `/browser` satisfies it as-is, and a test can
 * satisfy it with an object literal.
 */
export interface LanguageClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendNotification(method: string, params?: unknown): Promise<void>;
}

/**
 * How a host builds its client.
 *
 * `payload` is passed alongside `options` because the two hosts need it in a
 * form the options cannot carry: the node adapter turns it into `serverArgv`,
 * the worker adapter into `serverQuery`.
 */
export type LanguageClientFactory = (
  payload: ServerSettings,
  options: MdvClientOptions,
) => LanguageClientLike;

/**
 * Diagnostics from `@mdv/lsp`, over LSP (SPEC 29.4).
 *
 * The counterpart to `InProcessDiagnosticService`, and the reason
 * `diagnostics/service.ts` exists. Note what is *absent*: no debounce (the
 * server's own `VALIDATE_DEBOUNCE_MS` owns it), no document lifecycle (the
 * client library's document sync owns it), no `DiagnosticCollection` (the client
 * library owns it). Everything this class does is lifecycle.
 */
export class LanguageServerDiagnosticService implements DiagnosticService {
  readonly kind: DiagnosticEngineKind = 'language-server';

  readonly #read: () => MdvSettings;
  readonly #create: LanguageClientFactory;

  /** The payload the running client was started with. */
  #payload: ServerSettings;
  /** The running client, or `undefined` before the first start and after a failure. */
  #client: LanguageClientLike | undefined;
  /**
   * Every lifecycle step, serialised.
   *
   * `start`, `restart` and `dispose` are all async and all triggered by events
   * that do not wait for each other — a settings change during startup is
   * ordinary. A chain makes "stop the old one, then start the new one" mean
   * that even when two changes arrive a millisecond apart.
   */
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(read: () => MdvSettings, create: LanguageClientFactory) {
    this.#read = read;
    this.#create = create;
    this.#payload = serverSettings(read());
    // Queued, not awaited: `activate` has a 50 ms budget (SPEC 29.8) and
    // spawning a process is not part of it.
    this.#step('language server start', () => this.#start(this.#payload));
  }

  /**
   * Look at one document again.
   *
   * There is no per-document nudge in the protocol for a server that pushes, and
   * inventing one would put MDV semantics in the wire format. The global
   * notification costs a re-validation of the open set, which is what a settings
   * change asks for anyway; the `document` is accepted to satisfy the seam and
   * to keep the call sites of the two engines identical.
   */
  revalidate(_document: vscode.TextDocument): void {
    this.revalidateAll();
  }

  /** Re-read the settings; restart if they changed the payload, nudge if not. */
  revalidateAll(): void {
    const next = serverSettings(this.#read());
    this.#step('language server revalidate', async () => {
      if (samePayload(next, this.#payload)) {
        await this.#client?.sendNotification(DID_CHANGE_CONFIGURATION, { settings: next });
        return;
      }
      this.#payload = next;
      await this.#stop();
      await this.#start(next);
    });
  }

  /**
   * Stop the server.
   *
   * Queued behind whatever is in flight rather than racing it, so a dispose that
   * lands mid-restart still stops the client the restart is about to create.
   */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue = this.#queue.then(async () => {
      try {
        await this.#stop();
      } catch (error) {
        logError('language server shutdown', error);
      }
    });
  }

  /**
   * Resolves when every step queued so far has run.
   *
   * The lifecycle is deliberately fire-and-forget, which leaves a test with
   * nothing to await. This is that handle, and `deactivate` may use it too.
   */
  whenIdle(): Promise<void> {
    return this.#queue;
  }

  #step(context: string, run: () => Promise<void>): void {
    this.#queue = this.#queue.then(async () => {
      if (this.#disposed) return;
      try {
        await run();
      } catch (error) {
        logError(context, error);
      }
    });
  }

  async #start(payload: ServerSettings): Promise<void> {
    const client = this.#create(payload, clientOptions(payload));
    this.#client = client;
    try {
      await client.start();
    } catch (error) {
      // A half-started client is not something to stop later: drop it, so the
      // next settings change tries a clean start instead of stopping a ghost.
      this.#client = undefined;
      throw error;
    }
    log(
      `language server started — level ${String(payload.level)}, ` +
        `strict ${String(payload.strict)}, allowExternal ${String(payload.allowExternal)}`,
    );
  }

  async #stop(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    if (client === undefined) return;
    await client.stop();
  }
}

/**
 * Whether two payloads would produce the same server.
 *
 * Field by field rather than `JSON.stringify`, because the question is about
 * the five values and not about the order `serverSettings` happened to write
 * them in.
 */
export function samePayload(a: ServerSettings, b: ServerSettings): boolean {
  return (
    a.level === b.level &&
    a.strict === b.strict &&
    a.allowExternal === b.allowExternal &&
    a.attributeOrder === b.attributeOrder &&
    a.allowedOrigins.length === b.allowedOrigins.length &&
    a.allowedOrigins.every((origin, at) => origin === b.allowedOrigins[at])
  );
}

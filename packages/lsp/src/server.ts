/**
 * The server's lifecycle: `initialize`, `initialized`, `shutdown`, `exit`, and
 * the document-sync notifications underneath every other capability.
 *
 * LSP's lifecycle has rules that look pedantic until a client trips one, so
 * they are enforced here rather than trusted:
 *
 * - a request before `initialize` is answered `ServerNotInitialized`, never
 *   served, because the server does not yet know what the client can render;
 * - a second `initialize` is an error, not a re-configuration;
 * - after `shutdown`, requests are refused but the process stays up, waiting
 *   for `exit`;
 * - `exit` without a preceding `shutdown` is a crash, and the specification
 *   says to leave with status 1 so a supervisor can tell the difference.
 *
 * Features are installed as functions over a {@link ServerContext} and each
 * returns the slice of {@link ServerCapabilities} it is prepared to honour, so
 * a capability cannot be advertised without a handler behind it.
 */

import { DocumentStore } from './documents.js';
import { MessageConnection } from './protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from './protocol/jsonrpc.js';
import { TextDocumentSyncKind } from './protocol/types.js';
import type { CancellationToken, ConnectionLogger, Disposable } from './protocol/connection.js';
import type { MessageTransport } from './protocol/jsonrpc.js';
import type {
  ClientCapabilities,
  DidChangeTextDocumentParams,
  DidCloseTextDocumentParams,
  DidOpenTextDocumentParams,
  DidSaveTextDocumentParams,
  InitializeParams,
  InitializeResult,
  MessageTypeValue,
  ServerCapabilities,
} from './protocol/types.js';

/** Server name and version, reported in `initialize` and in the log. */
export const SERVER_NAME = 'mdv-language-server';

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

/**
 * What a feature is handed. Every incoming request is lifecycle-guarded by the
 * connection itself, so `onRequest` here is a convenience rather than a
 * safeguard; `connection` is exposed for the outbound direction — a progress or
 * telemetry feature has to send as well as answer.
 */
export interface ServerContext {
  readonly connection: MessageConnection;
  readonly documents: DocumentStore;
  readonly logger: Logger;
  /** The client's own capabilities, available from `initialize` onwards. */
  client(): ClientCapabilities;
  onRequest(
    method: string,
    handler: (params: unknown, token: CancellationToken) => unknown,
  ): Disposable;
  onNotification(method: string, handler: (params: unknown) => unknown): Disposable;
}

/** Install one capability. Returns what it is now safe to advertise. */
export type Feature = (context: ServerContext) => Partial<ServerCapabilities>;

export interface ServerOptions {
  /** Extra capabilities beyond the built-in document sync. */
  readonly features?: readonly Feature[];
  readonly logger?: Logger;
  /** Called on `exit` with LSP's own status convention. */
  readonly onExit?: (code: number) => void;
  readonly version?: string;
}

export interface MdvServer {
  /** Begin reading the transport. Handlers are already registered. */
  listen(): void;
  readonly documents: DocumentStore;
  readonly connection: MessageConnection;
  /** For tests and for a host that wants to know before `exit` arrives. */
  readonly state: () => 'starting' | 'running' | 'shuttingDown' | 'exited';
  dispose(): void;
}

const NULL_LOGGER: Logger = { info: () => {}, error: () => {} };

export function createServer(transport: MessageTransport, options: ServerOptions = {}): MdvServer {
  const logger = options.logger ?? NULL_LOGGER;
  const documents = new DocumentStore();
  const connectionLogger: ConnectionLogger = { error: (message) => logger.error(message) };
  const connection = new MessageConnection(transport, connectionLogger);

  let state: 'starting' | 'running' | 'shuttingDown' | 'exited' = 'starting';
  let client: ClientCapabilities = {};

  // The lifecycle check sits on the connection rather than on each handler,
  // because it has to speak for methods this server does not implement too: a
  // `textDocument/documentSymbol` that arrives before `initialize` must be told
  // the server is not initialized, not that the method does not exist. Only
  // `initialize` itself is exempt — its own handler owns the "already
  // initialized" case, which is a different error from either of these.
  connection.setRequestGuard((method) => {
    if (method === 'initialize') return undefined;
    if (state === 'starting') {
      return {
        code: ErrorCodes.serverNotInitialized,
        message: `\`${method}\` arrived before \`initialize\``,
      };
    }
    if (state !== 'running') {
      return {
        code: ErrorCodes.invalidRequest,
        message: `\`${method}\` arrived after \`shutdown\``,
      };
    }
    return undefined;
  });

  // A notification cannot be answered, so one that arrives out of the running
  // state is dropped rather than reported. Clients legitimately race `didClose`
  // against `shutdown`.
  const guardedNotification = (method: string, handler: (params: unknown) => unknown): Disposable =>
    connection.onNotification(method, (params) =>
      state === 'running' ? handler(params) : undefined,
    );

  const context: ServerContext = {
    connection,
    documents,
    logger,
    client: () => client,
    onRequest: (method, handler) => connection.onRequest(method, handler),
    onNotification: guardedNotification,
  };

  // ── Features ───────────────────────────────────────────────────────────────
  //
  // Installed before the handshake is registered, because `initialize` answers
  // with what they claim: a capability with no handler behind it is a promise
  // the client will call.

  let featureCapabilities: Partial<ServerCapabilities> = {};
  for (const feature of options.features ?? []) {
    featureCapabilities = { ...featureCapabilities, ...feature(context) };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  connection.onRequest('initialize', (params) => {
    if (state !== 'starting') {
      throw new ResponseErrorException(
        ErrorCodes.invalidRequest,
        'The server is already initialized',
      );
    }
    const initialize = (params ?? {}) as InitializeParams;
    client = initialize.capabilities ?? {};
    state = 'running';
    logger.info(`Initialized for ${initialize.clientInfo?.name ?? 'an unnamed client'}`);
    const result: InitializeResult = {
      capabilities: { ...syncCapabilities(), ...featureCapabilities },
      serverInfo:
        options.version === undefined
          ? { name: SERVER_NAME }
          : { name: SERVER_NAME, version: options.version },
    };
    return result;
  });

  connection.onNotification('initialized', () => {
    // Nothing is registered dynamically: every capability this server has is
    // static, so there is no `client/registerCapability` round trip to make.
  });

  connection.onRequest('shutdown', () => {
    state = 'shuttingDown';
    // Diagnostics published for documents that are about to close would
    // outlive the session in some clients' problem panels.
    for (const document of documents.all()) {
      connection.sendNotification('textDocument/publishDiagnostics', {
        uri: document.uri,
        diagnostics: [],
      });
    }
    return null;
  });

  connection.onNotification('exit', () => {
    const code = state === 'shuttingDown' ? 0 : 1;
    state = 'exited';
    connection.dispose();
    options.onExit?.(code);
  });

  connection.onNotification('$/setTrace', () => {
    // Accepted and ignored: this server's verbosity is the host's log level,
    // and answering `$/logTrace` for every message would drown it.
  });

  // ── Document synchronisation ───────────────────────────────────────────────

  guardedNotification('textDocument/didOpen', (params) => {
    const open = params as DidOpenTextDocumentParams;
    documents.open(open.textDocument);
  });

  guardedNotification('textDocument/didChange', (params) => {
    const change = params as DidChangeTextDocumentParams;
    if (documents.change(change) === undefined) {
      logger.error(`Change for a document that was never opened: ${change.textDocument.uri}`);
    }
  });

  guardedNotification('textDocument/didSave', (params) => {
    const save = params as DidSaveTextDocumentParams;
    documents.save(save.textDocument.uri, save.text);
  });

  guardedNotification('textDocument/didClose', (params) => {
    const close = params as DidCloseTextDocumentParams;
    documents.close(close.textDocument.uri);
  });

  connection.onClose(() => {
    if (state !== 'exited') {
      // The client vanished without `shutdown`/`exit` — a crash on its side, or
      // a user killing the window. Nothing to answer; just stop.
      state = 'exited';
      options.onExit?.(1);
    }
  });

  return {
    listen: () => connection.listen(),
    documents,
    connection,
    state: () => state,
    dispose: () => connection.dispose(),
  };
}

/** Publish a message to the client's window log (`window/logMessage`). */
export function logToClient(
  connection: MessageConnection,
  type: MessageTypeValue,
  message: string,
): void {
  connection.sendNotification('window/logMessage', { type, message });
}

function syncCapabilities(): Partial<ServerCapabilities> {
  return {
    positionEncoding: 'utf-16',
    textDocumentSync: {
      openClose: true,
      change: TextDocumentSyncKind.incremental,
      // `includeText: false`: the mirror is already correct, and asking for the
      // whole file on every save doubles the traffic of a large document.
      save: { includeText: false },
    },
  };
}

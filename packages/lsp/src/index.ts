/**
 * `@mdv/lsp` — the MDV language server (SPEC 29.4).
 *
 * The server is a thin adapter. It owns no MDV semantics: it translates between
 * LSP types and `@mdv/core`/`@mdv/parser` types, and every answer it gives comes
 * from running the same pipeline the CLI and the VS Code extension run. If a
 * behaviour here cannot be traced back to a call into another `@mdv` package, it
 * is in the wrong file.
 *
 * The transport is supplied by the host — stdio in a desktop editor, a
 * `MessagePort` in a web worker — so nothing in this package imports `node:*`.
 *
 * @packageDocumentation
 */

export { DocumentStore, TextDocument, type DocumentEvent } from './documents.js';

export {
  MessageConnection,
  NEVER_CANCELLED,
  throwIfCancelled,
  type CancellationToken,
  type ConnectionLogger,
  type Disposable,
  type NotificationHandler,
  type RequestGuard,
  type RequestHandler,
} from './protocol/connection.js';

export {
  ErrorCodes,
  JSONRPC_VERSION,
  MessageBuffer,
  ResponseErrorException,
  encodeMessage,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
  type DecodeResult,
  type ErrorCode,
  type Message,
  type MessageTransport,
  type NotificationMessage,
  type RequestId,
  type RequestMessage,
  type ResponseError,
  type ResponseMessage,
} from './protocol/jsonrpc.js';

export * from './protocol/types.js';

export {
  SERVER_NAME,
  createServer,
  logToClient,
  type Feature,
  type Logger,
  type MdvServer,
  type ServerContext,
  type ServerOptions,
} from './server.js';

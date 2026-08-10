/**
 * JSON-RPC 2.0 and the LSP base protocol: message shapes, error codes, and the
 * `Content-Length` framing that carries them (SPEC 29.4).
 *
 * This file is written against bytes rather than strings, and against no
 * dependency at all, for one reason each:
 *
 * - `Content-Length` counts **UTF-8 bytes**, not characters. A server that
 *   measures `string.length` truncates the first message containing an em dash
 *   and then desynchronises the stream forever — every subsequent frame is read
 *   from the wrong offset. Framing therefore happens over `Uint8Array`, with
 *   `TextEncoder`/`TextDecoder`, which both Node and a web worker have.
 * - SPEC 29.4 puts the server on stdio in the desktop host and in a web worker
 *   in the browser host. Nothing here may assume either, so there is no
 *   `node:stream` import and no `self` reference; transports are supplied from
 *   outside as {@link MessageTransport}.
 */

/** Every JSON-RPC message carries this, and a peer that omits it is broken. */
export const JSONRPC_VERSION = '2.0';

/** JSON-RPC ids are numbers or strings; LSP uses numbers, but must accept both. */
export type RequestId = number | string;

export interface RequestMessage {
  readonly jsonrpc: string;
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

export interface NotificationMessage {
  readonly jsonrpc: string;
  readonly method: string;
  readonly params?: unknown;
}

export interface ResponseError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

export interface ResponseMessage {
  readonly jsonrpc: string;
  /** `null` when the request could not be parsed well enough to have an id. */
  readonly id: RequestId | null;
  readonly result?: unknown;
  readonly error?: ResponseError;
}

export type Message = RequestMessage | NotificationMessage | ResponseMessage;

/**
 * JSON-RPC's own codes, plus the three LSP adds (§3.16 of the LSP 3.17 spec).
 *
 * `requestCancelled` and `contentModified` are the two a language server sends
 * most: the first when `$/cancelRequest` arrived mid-answer, the second when the
 * document changed underneath a request whose answer would now describe text
 * the client has already replaced.
 */
export const ErrorCodes = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverNotInitialized: -32002,
  unknownErrorCode: -32001,
  requestFailed: -32803,
  serverCancelled: -32802,
  contentModified: -32801,
  requestCancelled: -32800,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * An error a handler can throw to choose the response code the client sees.
 *
 * Anything else thrown becomes {@link ErrorCodes.internalError} with its
 * message — a handler bug must still produce a well-formed response, because a
 * client that never hears back from a request waits forever.
 */
export class ResponseErrorException extends Error {
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ResponseErrorException';
    this.code = code;
    this.data = data;
  }

  toResponseError(): ResponseError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message classification
// ─────────────────────────────────────────────────────────────────────────────

export function isRequestMessage(message: Message): message is RequestMessage {
  return 'method' in message && 'id' in message && message.id !== null;
}

export function isNotificationMessage(message: Message): message is NotificationMessage {
  return 'method' in message && !('id' in message);
}

export function isResponseMessage(message: Message): message is ResponseMessage {
  return !('method' in message) && 'id' in message;
}

// ─────────────────────────────────────────────────────────────────────────────
// Framing
// ─────────────────────────────────────────────────────────────────────────────

const CR = 0x0d;
const LF = 0x0a;

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: false });

/** Frame one message: an ASCII header block, a blank line, then UTF-8 JSON. */
export function encodeMessage(message: Message): Uint8Array {
  const body = encoder.encode(JSON.stringify(message));
  const header = encoder.encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

/** What {@link MessageBuffer.take} found: a message, or a reason it could not. */
export type DecodeResult =
  | { readonly kind: 'message'; readonly message: Message }
  /** The frame arrived intact but its body was not JSON: answer, stay in sync. */
  | { readonly kind: 'invalid'; readonly reason: string }
  /** The stream itself is unreadable; there is no offset to resume from. */
  | { readonly kind: 'corrupt'; readonly reason: string };

/**
 * Reassembles frames from arbitrary chunk boundaries.
 *
 * A transport hands over whatever the OS gave it: half a header, three messages
 * at once, or a single byte. The buffer keeps unread bytes and yields whole
 * messages only, so no caller ever sees a partial one.
 */
export class MessageBuffer {
  #bytes: Uint8Array = new Uint8Array(0);
  /** Byte length promised by a header already read but whose body is still short. */
  #expecting: number | null = null;

  append(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    const grown = new Uint8Array(this.#bytes.length + chunk.length);
    grown.set(this.#bytes, 0);
    grown.set(chunk, this.#bytes.length);
    this.#bytes = grown;
  }

  /** Bytes held back for want of the rest of their frame. */
  get pending(): number {
    return this.#bytes.length;
  }

  /** Take the next complete message, or `undefined` while one is still arriving. */
  take(): DecodeResult | undefined {
    if (this.#expecting === null) {
      const headerEnd = findHeaderEnd(this.#bytes);
      if (headerEnd === -1) return undefined;
      const header = decoder.decode(this.#bytes.subarray(0, headerEnd));
      const length = contentLength(header);
      if (length === null) {
        // Without a length there is no way to know where this frame ends, so
        // every byte after it is suspect. Report and let the caller close.
        this.#bytes = new Uint8Array(0);
        return { kind: 'corrupt', reason: 'A message header declared no `Content-Length`' };
      }
      this.#bytes = this.#bytes.subarray(headerEnd + 4);
      this.#expecting = length;
    }

    if (this.#bytes.length < this.#expecting) return undefined;
    const body = this.#bytes.subarray(0, this.#expecting);
    this.#bytes = this.#bytes.subarray(this.#expecting);
    this.#expecting = null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(body));
    } catch (error) {
      return { kind: 'invalid', reason: error instanceof Error ? error.message : String(error) };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // JSON-RPC batches are legal JSON-RPC but not legal LSP, and neither is a
      // bare scalar. Refuse rather than guess at a method name.
      return { kind: 'invalid', reason: 'A message body was not a JSON-RPC object' };
    }
    return { kind: 'message', message: parsed as Message };
  }
}

/** Index of the `\r\n\r\n` that ends the header block, or -1 while it is short. */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index + 3 < bytes.length; index += 1) {
    if (
      bytes[index] === CR &&
      bytes[index + 1] === LF &&
      bytes[index + 2] === CR &&
      bytes[index + 3] === LF
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Read `Content-Length` from a header block.
 *
 * Header names are case-insensitive (LSP inherits HTTP's rule here), and
 * `Content-Type` may precede or follow; it is read and ignored, because the
 * only charset the base protocol still permits is UTF-8.
 */
function contentLength(header: string): number | null {
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
    const value = Number(line.slice(colon + 1).trim());
    if (!Number.isInteger(value) || value < 0) return null;
    return value;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The byte pipe under the connection.
 *
 * Deliberately smaller than a stream: `onData` for bytes in, `write` for bytes
 * out, `onClose` for the far end going away, `dispose` for this end doing so.
 * A stdio transport, a worker `MessagePort` and an in-memory test double all
 * implement it in a dozen lines.
 */
export interface MessageTransport {
  onData(listener: (chunk: Uint8Array) => void): void;
  onClose(listener: () => void): void;
  write(chunk: Uint8Array): void;
  dispose(): void;
}

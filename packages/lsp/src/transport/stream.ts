/**
 * The desktop host's transport: bytes over a pair of streams (SPEC 29.4).
 *
 * ```ts
 * const server = createServer(streamTransport(process.stdin, process.stdout));
 * server.listen();
 * ```
 *
 * The streams are taken as arguments rather than read off `process`, because
 * this package compiles without `@types/node` and has to keep working in a
 * worker (see `transport/port.ts`). What is described here is the *shape* of a
 * Node stream and nothing more: `on('data')` in, `write` out.
 *
 * Two warnings that belong with stdio rather than in a README, because getting
 * either wrong produces a language server that half-works:
 *
 * - **Nothing else may write to the same sink.** A `console.log` anywhere in the
 *   process puts its bytes in the middle of a frame and the client's parser
 *   never recovers. The server logs through `window/logMessage` (see
 *   `logToClient`) or to stderr, never to stdout.
 * - **The client may be talking before the server is listening.** An editor
 *   spawns the process and writes `initialize` immediately, which on Node
 *   arrives as soon as a `data` listener exists — and this attaches one in the
 *   constructor, so those bytes exist before `MessageConnection.listen` asks
 *   for them. They are kept and handed over on the first {@link onData} rather
 *   than dropped, which is the difference between a server that starts and one
 *   that hangs on a handshake that already happened.
 */

import type { MessageTransport } from '../protocol/jsonrpc.js';

const encoder = new TextEncoder();

/**
 * The readable half, as much of it as this needs.
 *
 * `error` is here for one reason: an `EPIPE` on a stream with no error listener
 * is an uncaught exception in Node, so an editor that dies mid-message would
 * take the server down with a stack trace instead of the clean exit LSP asks
 * for. The error itself is not interesting — the far end has gone either way.
 */
export interface ByteSource {
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
}

/** The writable half. `process.stdout` satisfies it; so does an array-backed fake. */
export interface ByteSink {
  write(chunk: Uint8Array): unknown;
}

class StreamTransport implements MessageTransport {
  readonly #output: ByteSink;
  #dataListeners: ((chunk: Uint8Array) => void)[] = [];
  #closeListeners: (() => void)[] = [];
  /** Chunks that arrived before anyone was listening. See the note above. */
  #backlog: Uint8Array[] = [];
  /** The far end went away. */
  #closed = false;
  /** This end went away, which is a different thing (see {@link dispose}). */
  #disposed = false;

  constructor(input: ByteSource, output: ByteSink) {
    this.#output = output;
    input.on('data', (chunk) => {
      this.#receive(chunk);
    });
    // `end` is the stream running out and `close` is the handle going; a killed
    // editor produces one, both, or neither in that order, so all three roads
    // lead to the same one-shot.
    input.on('end', () => {
      this.#close();
    });
    input.on('close', () => {
      this.#close();
    });
    input.on('error', () => {
      this.#close();
    });
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener);
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const chunk of backlog) listener(chunk);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
    // A listener registered after the stream already ended is still owed the
    // event: closing is a fact about the transport, not a moment in it.
    if (this.#closed) listener();
  }

  write(chunk: Uint8Array): void {
    if (this.#closed || this.#disposed) return;
    this.#output.write(chunk);
  }

  /**
   * Stop talking and stop listening.
   *
   * This does not fire the close listeners. `onClose` means the far end went
   * away — the connection reacts to it by failing everything in flight — and a
   * server that disposed on its own `exit` has not lost a client, it has
   * finished with one.
   */
  dispose(): void {
    this.#disposed = true;
    this.#dataListeners = [];
    this.#backlog = [];
    this.#closeListeners = [];
  }

  #receive(chunk: Uint8Array | string): void {
    if (this.#disposed) return;
    // A host that set an encoding on the stream hands over strings. Node's
    // decoder holds back a split multi-byte character, so re-encoding gives
    // back the bytes that were sent and the `Content-Length` still counts.
    const bytes = typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
    if (bytes.length === 0) return;
    if (this.#dataListeners.length === 0) {
      this.#backlog.push(bytes);
      return;
    }
    for (const listener of this.#dataListeners) listener(bytes);
  }

  #close(): void {
    if (this.#closed || this.#disposed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

/**
 * A transport over `input` and `output` — on a desktop host, stdin and stdout.
 *
 * The two are separate arguments because they are separate streams: reading
 * where the client writes and writing where the client reads is the whole of
 * stdio, and a host that wants a socket passes both halves of that instead.
 */
export function streamTransport(input: ByteSource, output: ByteSink): MessageTransport {
  return new StreamTransport(input, output);
}

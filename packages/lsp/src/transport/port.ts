/**
 * The browser host's transport: messages over a worker port (SPEC 29.4).
 *
 * ```ts
 * // inside the worker
 * const server = createServer(portTransport(self));
 * server.listen();
 * ```
 *
 * A port is not a stream, and the difference is the whole of this file. There
 * are no bytes on it and no chunk boundaries: `postMessage` delivers one
 * structured-cloned value, whole, in order. The browser LSP clients take that
 * literally and post the JSON-RPC *object* — no `Content-Length`, no JSON text
 * — so that is what this speaks.
 *
 * Which leaves a seam, because everything below {@link MessageTransport} is
 * byte-oriented: outgoing frames are unframed here so the object can be posted,
 * and incoming objects are framed here so the connection's buffer can read
 * them. Encoding something in order to decode it immediately looks like work
 * for nothing until you price the alternative — a second connection
 * implementation that speaks objects, which would double the number of places
 * the ordering, cancellation and lifecycle rules live. A `JSON.stringify` per
 * message, on a channel that is already deep-copying the same object, is not
 * the cost worth that.
 *
 * Bytes are passed straight through if a peer does send them, which is how two
 * ends of this package talk to each other over a `MessageChannel` without
 * either of them pretending to be an editor.
 */

import { MessageBuffer, encodeMessage } from '../protocol/jsonrpc.js';
import type { Message, MessageTransport } from '../protocol/jsonrpc.js';

/**
 * As much of `MessagePort` as this needs, which `DedicatedWorkerGlobalScope`
 * also satisfies — in a worker the "port" is the global scope itself.
 *
 * `start` is optional for that reason: a `MessagePort` obtained from a
 * `MessageChannel` delivers nothing until it is started, and a worker global
 * has no such method because it was never stopped.
 */
export interface MessagePortLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void;
  start?(): void;
}

class PortTransport implements MessageTransport {
  readonly #port: MessagePortLike;
  /** Unframes what the connection writes, so whole messages can be posted. */
  readonly #outgoing = new MessageBuffer();
  #dataListeners: ((chunk: Uint8Array) => void)[] = [];
  #closeListeners: (() => void)[] = [];
  /** Messages that arrived before anyone was listening. */
  #backlog: Uint8Array[] = [];
  #disposed = false;

  constructor(port: MessagePortLike) {
    this.#port = port;
    port.addEventListener('message', (event) => {
      this.#receive(event.data);
    });
    port.start?.();
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener);
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const chunk of backlog) listener(chunk);
  }

  /**
   * Registered, and never called.
   *
   * A port has no close event. The client end of a worker goes away by
   * terminating the worker, and nothing in the worker runs afterwards to
   * notice — there is no moment at which this could fire. Saying so here is
   * better than a listener the caller assumes covers them.
   */
  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  write(chunk: Uint8Array): void {
    if (this.#disposed) return;
    this.#outgoing.append(chunk);
    for (;;) {
      const result = this.#outgoing.take();
      if (result === undefined) return;
      // The frame came from this package's own encoder a moment ago, so
      // `invalid` and `corrupt` are unreachable. There is also nobody to tell:
      // a parse error about our own output would be sent down the same broken
      // pipe. Skipping keeps the loop draining whatever else arrived with it.
      if (result.kind !== 'message') continue;
      this.#port.postMessage(result.message);
    }
  }

  /** As on a stream: this end stopping is not the far end going away. */
  dispose(): void {
    this.#disposed = true;
    this.#dataListeners = [];
    this.#backlog = [];
    this.#closeListeners = [];
  }

  #receive(data: unknown): void {
    if (this.#disposed) return;
    const bytes = frame(data);
    if (bytes === undefined || bytes.length === 0) return;
    if (this.#dataListeners.length === 0) {
      this.#backlog.push(bytes);
      return;
    }
    for (const listener of this.#dataListeners) listener(bytes);
  }
}

/**
 * Whatever arrived, as bytes the connection can read — or nothing.
 *
 * An object is framed unvalidated on purpose. Whether it is a request, a
 * response, or a `{}` that answers to neither is the connection's question, and
 * it already has an answer for each; a second opinion here would be a second
 * place to keep the protocol.
 */
function frame(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof data !== 'object' || data === null) return undefined;
  try {
    return encodeMessage(data as Message);
  } catch {
    // Structured clone preserves cycles and `JSON.stringify` refuses them, so
    // a peer can post a value that cannot be serialised. That is a broken peer
    // rather than a broken connection: drop the one message and keep reading.
    return undefined;
  }
}

/**
 * A transport over `port` — in the browser host, the worker's global scope.
 *
 * Disposing stops this end talking; it does not close the port. In a worker
 * that "port" is the global scope, and closing it terminates everything the
 * host might still want to do on the way out.
 */
export function portTransport(port: MessagePortLike): MessageTransport {
  return new PortTransport(port);
}

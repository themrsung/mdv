/**
 * An in-memory client, so the server can be driven without a real editor.
 *
 * The pair is deliberately byte-accurate rather than object-passing: messages
 * are framed, written as `Uint8Array`, and re-parsed on the far side. A test
 * double that handed objects across would pass while the framing was broken,
 * which is precisely the bug that is hardest to see in a real client.
 *
 * Delivery is asynchronous (a resolved promise, not a synchronous call) because
 * that is what a socket does, and it is the only way the ordering rules in
 * `protocol/connection.ts` are actually exercised.
 */

import {
  JSONRPC_VERSION,
  MessageBuffer,
  encodeMessage,
  isNotificationMessage,
  isResponseMessage,
} from '../src/protocol/jsonrpc.js';
import type {
  Message,
  MessageTransport,
  NotificationMessage,
  RequestId,
  ResponseMessage,
} from '../src/protocol/jsonrpc.js';

/** One end of a byte pipe. */
export class PipeEnd implements MessageTransport {
  #dataListeners: ((chunk: Uint8Array) => void)[] = [];
  #closeListeners: (() => void)[] = [];
  #peer: PipeEnd | undefined;
  #closed = false;
  /** Chunks that arrived before anyone was listening. */
  #backlog: Uint8Array[] = [];

  connect(peer: PipeEnd): void {
    this.#peer = peer;
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener);
    const backlog = this.#backlog;
    this.#backlog = [];
    for (const chunk of backlog) listener(chunk);
  }

  onClose(listener: () => void): void {
    this.#closeListeners.push(listener);
  }

  write(chunk: Uint8Array): void {
    if (this.#closed) return;
    this.#peer?.receive(chunk);
  }

  receive(chunk: Uint8Array): void {
    if (this.#closed) return;
    if (this.#dataListeners.length === 0) {
      this.#backlog.push(chunk);
      return;
    }
    for (const listener of this.#dataListeners) listener(chunk);
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
    this.#peer?.remoteClosed();
  }

  remoteClosed(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const listener of this.#closeListeners) listener();
  }
}

/** Give the connection's microtask queue a chance to drain. */
export async function settle(times = 4): Promise<void> {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A client that speaks the wire protocol: it frames what it sends and parses
 * what it receives, so every assertion is about bytes the server really wrote.
 */
export class TestClient {
  readonly transport: PipeEnd;
  readonly #buffer = new MessageBuffer();
  readonly #pending = new Map<
    string,
    { resolve: (message: ResponseMessage) => void; reject: (error: Error) => void }
  >();
  readonly received: Message[] = [];
  readonly notifications: NotificationMessage[] = [];
  #nextId = 1;

  constructor(transport: PipeEnd) {
    this.transport = transport;
    transport.onData((chunk) => {
      this.#buffer.append(chunk);
      for (;;) {
        const result = this.#buffer.take();
        if (result === undefined) return;
        if (result.kind !== 'message') {
          throw new Error(`The server wrote something unreadable: ${result.reason}`);
        }
        this.#accept(result.message);
      }
    });
    transport.onClose(() => {
      for (const entry of this.#pending.values()) {
        entry.reject(new Error('The server closed the connection'));
      }
      this.#pending.clear();
    });
  }

  /** Send a request and wait for the response message, error or not. */
  request(method: string, params?: unknown): Promise<ResponseMessage> {
    const id = this.#nextId;
    this.#nextId += 1;
    const promise = new Promise<ResponseMessage>((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
    });
    this.#write({
      jsonrpc: JSONRPC_VERSION,
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
    return promise;
  }

  /** Send a request and unwrap `result`, failing loudly on an error response. */
  async call(method: string, params?: unknown): Promise<unknown> {
    const response = await this.request(method, params);
    if (response.error !== undefined) {
      throw new Error(`\`${method}\` failed: ${response.error.message}`);
    }
    return response.result;
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: JSONRPC_VERSION, method, ...(params === undefined ? {} : { params }) });
  }

  cancel(id: RequestId): void {
    this.notify('$/cancelRequest', { id });
  }

  /** Write bytes the framing layer will have to cope with as-is. */
  writeRaw(bytes: Uint8Array | string): void {
    this.transport.write(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
  }

  /** Every notification of one method the server has sent so far. */
  notificationsOf(method: string): NotificationMessage[] {
    return this.notifications.filter((entry) => entry.method === method);
  }

  #write(message: Message): void {
    this.transport.write(encodeMessage(message));
  }

  #accept(message: Message): void {
    this.received.push(message);
    if (isNotificationMessage(message)) {
      this.notifications.push(message);
      return;
    }
    if (!isResponseMessage(message)) return;
    if (message.id === null) return;
    const pending = this.#pending.get(String(message.id));
    if (pending === undefined) return;
    this.#pending.delete(String(message.id));
    pending.resolve(message);
  }
}

/** A connected client/server pair over one in-memory pipe. */
export function duplex(): { client: TestClient; server: MessageTransport } {
  const clientEnd = new PipeEnd();
  const serverEnd = new PipeEnd();
  clientEnd.connect(serverEnd);
  serverEnd.connect(clientEnd);
  return { client: new TestClient(clientEnd), server: serverEnd };
}

/** The `initialize` params a modern client sends, trimmed to what we read. */
export const INITIALIZE_PARAMS = {
  processId: null,
  clientInfo: { name: 'test-client', version: '1.0.0' },
  rootUri: null,
  capabilities: {
    textDocument: {
      synchronization: { dynamicRegistration: false },
      publishDiagnostics: { relatedInformation: true, codeDescriptionSupport: true },
    },
  },
};

/** A minimal `textDocument/didOpen` payload. */
export function openParams(uri: string, text: string, version = 1): unknown {
  return { textDocument: { uri, languageId: 'mdv', version, text } };
}

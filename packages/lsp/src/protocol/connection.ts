/**
 * The message pump: routing, cancellation, and the ordering rules a language
 * server has to keep (SPEC 29.4).
 *
 * Three rules decide the shape of this file, and they pull against each other:
 *
 * 1. **Requests and notifications are answered in arrival order.** A
 *    `textDocument/completion` that overtook the `didChange` before it would
 *    complete against text the client has already replaced. So handlers run one
 *    at a time, each awaited before the next message is dispatched.
 * 2. **`$/cancelRequest` must not queue.** Cancellation that waits behind the
 *    request it cancels is not cancellation. It is applied the moment it
 *    arrives, out of band.
 * 3. **Responses to our own requests must not queue either.** A handler that
 *    awaits `workspace/configuration` while holding the queue would wait for a
 *    reply the queue is what stops it from reading: deadlock.
 *
 * Everything else is bookkeeping to make sure that every request receives
 * exactly one response, including the ones whose handler threw.
 */

import {
  ErrorCodes,
  JSONRPC_VERSION,
  MessageBuffer,
  ResponseErrorException,
  encodeMessage,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
} from './jsonrpc.js';
import type {
  Message,
  MessageTransport,
  NotificationMessage,
  RequestId,
  RequestMessage,
  ResponseError,
  ResponseMessage,
} from './jsonrpc.js';

export interface Disposable {
  dispose(): void;
}

/**
 * A one-shot flag a long-running handler is expected to poll.
 *
 * There is no way to interrupt a running function in JavaScript, so a
 * cancellable handler must look — between blocks, between files — and give up
 * on its own. {@link throwIfCancelled} is the polite way to do that.
 */
export interface CancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): Disposable;
}

export const NEVER_CANCELLED: CancellationToken = {
  isCancellationRequested: false,
  onCancellationRequested: () => ({ dispose: () => {} }),
};

/**
 * The writable side of a token. Handlers receive it as {@link CancellationToken},
 * which has no `cancel`, so only the connection can flip one.
 */
class MutableToken implements CancellationToken {
  #cancelled = false;
  #listeners: (() => void)[] = [];

  get isCancellationRequested(): boolean {
    return this.#cancelled;
  }

  onCancellationRequested(listener: () => void): Disposable {
    if (this.#cancelled) {
      // Late subscribers still hear it once: a handler that registers after the
      // cancellation landed would otherwise wait for an event already past.
      listener();
      return { dispose: () => {} };
    }
    this.#listeners.push(listener);
    return {
      dispose: () => {
        this.#listeners = this.#listeners.filter((entry) => entry !== listener);
      },
    };
  }

  cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    const listeners = this.#listeners;
    this.#listeners = [];
    for (const listener of listeners) listener();
  }
}

/** Give up on a cancelled request in the way the client asked to hear it. */
export function throwIfCancelled(token: CancellationToken): void {
  if (token.isCancellationRequested) {
    throw new ResponseErrorException(ErrorCodes.requestCancelled, 'Request cancelled');
  }
}

export type RequestHandler = (params: unknown, token: CancellationToken) => unknown;
export type NotificationHandler = (params: unknown) => unknown;

/**
 * A check run before every incoming request, ahead of handler lookup.
 *
 * Returning an error answers the request with it and no handler runs. LSP's
 * lifecycle rules need exactly this: a request that arrives before `initialize`
 * must be refused with `ServerNotInitialized` **whether or not** the method is
 * one we implement, and a per-handler check could only ever speak for the
 * methods that already have a handler — an unimplemented one would answer
 * `MethodNotFound`, which tells the client the wrong thing about its own bug.
 */
export type RequestGuard = (method: string) => ResponseError | undefined;

/** Where a server says what went wrong when there is no client to answer. */
export interface ConnectionLogger {
  error(message: string): void;
}

const SILENT: ConnectionLogger = { error: () => {} };

export class MessageConnection {
  readonly #transport: MessageTransport;
  readonly #buffer = new MessageBuffer();
  readonly #logger: ConnectionLogger;

  readonly #requestHandlers = new Map<string, RequestHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();

  /** In-flight incoming requests, so `$/cancelRequest` can find their token. */
  readonly #running = new Map<string, MutableToken>();
  /** Cancellations that arrived before the request left the queue. */
  readonly #cancelledEarly = new Set<string>();
  /** Outgoing requests waiting for the client's response. */
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  #guard: RequestGuard | undefined;
  #queue: Message[] = [];
  #pumping = false;
  #nextId = 1;
  #closed = false;
  #closeListeners: (() => void)[] = [];

  constructor(transport: MessageTransport, logger: ConnectionLogger = SILENT) {
    this.#transport = transport;
    this.#logger = logger;
  }

  /** Start reading. Separate from the constructor so handlers can register first. */
  listen(): void {
    this.#transport.onData((chunk) => {
      this.#buffer.append(chunk);
      for (;;) {
        const result = this.#buffer.take();
        if (result === undefined) return;
        if (result.kind === 'corrupt') {
          this.#logger.error(`Closing the connection: ${result.reason}`);
          this.dispose();
          return;
        }
        if (result.kind === 'invalid') {
          this.#send({
            jsonrpc: JSONRPC_VERSION,
            id: null,
            error: { code: ErrorCodes.parseError, message: result.reason },
          });
          continue;
        }
        this.#receive(result.message);
      }
    });
    this.#transport.onClose(() => {
      this.#fail(new Error('The connection closed before the response arrived'));
      this.#closed = true;
      for (const listener of this.#closeListeners) listener();
    });
  }

  onRequest(method: string, handler: RequestHandler): Disposable {
    this.#requestHandlers.set(method, handler);
    return { dispose: () => this.#requestHandlers.delete(method) };
  }

  onNotification(method: string, handler: NotificationHandler): Disposable {
    this.#notificationHandlers.set(method, handler);
    return { dispose: () => this.#notificationHandlers.delete(method) };
  }

  /** Install the {@link RequestGuard}. There is at most one. */
  setRequestGuard(guard: RequestGuard | undefined): void {
    this.#guard = guard;
  }

  /** Fires when the far end goes away — for stdio, when the client exits. */
  onClose(listener: () => void): Disposable {
    this.#closeListeners.push(listener);
    return {
      dispose: () => {
        this.#closeListeners = this.#closeListeners.filter((entry) => entry !== listener);
      },
    };
  }

  sendNotification(method: string, params?: unknown): void {
    const message: NotificationMessage =
      params === undefined
        ? { jsonrpc: JSONRPC_VERSION, method }
        : { jsonrpc: JSONRPC_VERSION, method, params };
    this.#send(message);
  }

  sendRequest(method: string, params?: unknown): Promise<unknown> {
    const id = this.#nextId;
    this.#nextId += 1;
    const message: RequestMessage =
      params === undefined
        ? { jsonrpc: JSONRPC_VERSION, id, method }
        : { jsonrpc: JSONRPC_VERSION, id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      if (this.#closed) {
        reject(new Error('The connection is closed'));
        return;
      }
      this.#pending.set(String(id), { resolve, reject });
      this.#send(message);
    });
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#queue = [];
    this.#fail(new Error('The connection was disposed'));
    this.#transport.dispose();
    for (const listener of this.#closeListeners) listener();
  }

  // ───────────────────────────────────────────────────────────────────────────

  #receive(message: Message): void {
    // Rule 3: a response is what someone is already awaiting. Never queue it.
    if (isResponseMessage(message)) {
      this.#settle(message);
      return;
    }
    // Rule 2: cancellation is meaningless once it has waited its turn.
    if (isNotificationMessage(message) && message.method === '$/cancelRequest') {
      this.#cancel(message.params);
      return;
    }
    this.#queue.push(message);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const message = this.#queue.shift();
        if (message === undefined) return;
        if (isRequestMessage(message)) await this.#handleRequest(message);
        else if (isNotificationMessage(message)) await this.#handleNotification(message);
      }
    } finally {
      this.#pumping = false;
    }
  }

  async #handleRequest(message: RequestMessage): Promise<void> {
    const key = String(message.id);
    const refusal = this.#guard?.(message.method);
    if (refusal !== undefined) {
      this.#cancelledEarly.delete(key);
      this.#respondError(message.id, refusal);
      return;
    }
    const handler = this.#requestHandlers.get(message.method);
    if (handler === undefined) {
      this.#cancelledEarly.delete(key);
      this.#respondError(message.id, {
        code: ErrorCodes.methodNotFound,
        message: `Unhandled method \`${message.method}\``,
      });
      return;
    }

    const token = new MutableToken();
    if (this.#cancelledEarly.delete(key)) token.cancel();
    this.#running.set(key, token);
    try {
      const result = await handler(message.params, token);
      // `undefined` is not a legal JSON-RPC result; LSP models "nothing to say"
      // as an explicit `null`, which is what a client's optional-result types
      // expect to receive.
      this.#send({
        jsonrpc: JSONRPC_VERSION,
        id: message.id,
        result: result === undefined ? null : result,
      });
    } catch (error) {
      this.#respondError(message.id, toResponseError(error));
    } finally {
      this.#running.delete(key);
    }
  }

  async #handleNotification(message: NotificationMessage): Promise<void> {
    const handler = this.#notificationHandlers.get(message.method);
    if (handler === undefined) {
      // A notification has no reply, so an unknown one can only be dropped. The
      // `$/` space is explicitly allowed to be ignored; anything else is worth
      // a line in the log, because it usually means a stale capability.
      if (!message.method.startsWith('$/')) {
        this.#logger.error(`No handler for notification \`${message.method}\``);
      }
      return;
    }
    try {
      await handler(message.params);
    } catch (error) {
      this.#logger.error(
        `\`${message.method}\` failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  #cancel(params: unknown): void {
    const id = (params as { id?: RequestId } | undefined)?.id;
    if (id === undefined) return;
    const key = String(id);
    const running = this.#running.get(key);
    if (running !== undefined) {
      running.cancel();
      return;
    }
    // Still in the queue: remember, so the handler starts already cancelled and
    // can decline before doing the work.
    this.#cancelledEarly.add(key);
  }

  #settle(message: ResponseMessage): void {
    if (message.id === null) {
      this.#logger.error(
        `The client reported a request it could not read: ${message.error?.message ?? 'unknown'}`,
      );
      return;
    }
    const key = String(message.id);
    const pending = this.#pending.get(key);
    if (pending === undefined) {
      this.#logger.error(`A response arrived for unknown request ${key}`);
      return;
    }
    this.#pending.delete(key);
    if (message.error !== undefined) {
      pending.reject(new ResponseErrorException(message.error.code, message.error.message));
      return;
    }
    pending.resolve(message.result ?? null);
  }

  #respondError(id: RequestId, error: ResponseError): void {
    this.#send({ jsonrpc: JSONRPC_VERSION, id, error });
  }

  #send(message: Message): void {
    if (this.#closed) return;
    this.#transport.write(encodeMessage(message));
  }

  #fail(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const entry of pending) entry.reject(error);
  }
}

function toResponseError(error: unknown): ResponseError {
  if (error instanceof ResponseErrorException) return error.toResponseError();
  return {
    code: ErrorCodes.internalError,
    message: error instanceof Error ? error.message : String(error),
  };
}

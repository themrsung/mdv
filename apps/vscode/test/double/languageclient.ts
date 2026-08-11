/**
 * A runtime double of `vscode-languageclient` (SPEC 29.4).
 *
 * The real package is a CommonJS module that requires `vscode` at load time
 * and, once started, forks a process or spins up a worker. Neither is
 * available under vitest, and neither is what these tests are about: the code
 * under test is the *wiring* - which module gets forked, which transport,
 * which options, and whether a settings change really restarts the client.
 *
 * So the two host adapters get this instead, and every construction is
 * recorded. The real package's types still check the call sites, because
 * `tsc` resolves `vscode-languageclient` to the real declarations; only the
 * runtime is swapped.
 */

export enum TransportKind {
  stdio = 0,
  ipc = 1,
  pipe = 2,
  socket = 3,
}

export enum RevealOutputChannelOn {
  Debug = 0,
  Info = 1,
  Warn = 2,
  Error = 3,
  Never = 4,
}

/** One `new LanguageClient(...)`, as the adapter built it. */
export interface ClientRecord {
  readonly host: 'node' | 'browser';
  readonly id: string;
  readonly name: string;
  /** `ServerOptions` for the node client; `undefined` for the browser one. */
  readonly serverOptions: unknown;
  readonly clientOptions: unknown;
  /** The `Worker` the browser client was handed. */
  readonly worker: unknown;
  starts: number;
  stops: number;
  readonly notifications: { method: string; params: unknown }[];
}

const clients: ClientRecord[] = [];

/** Every client any adapter has built, oldest first. */
export const builtClients: readonly ClientRecord[] = clients;

/** Forget every recorded client. Call this alongside the `vscode` reset. */
export function resetClients(): void {
  clients.length = 0;
  failNextStart = undefined;
}

let failNextStart: Error | undefined;

/** Make the next `start()` reject, the way a missing server module would. */
export function failNextClientStart(error: Error): void {
  failNextStart = error;
}

abstract class BaseClient {
  readonly record: ClientRecord;

  protected constructor(record: Omit<ClientRecord, 'starts' | 'stops' | 'notifications'>) {
    this.record = { ...record, starts: 0, stops: 0, notifications: [] };
    clients.push(this.record);
  }

  start(): Promise<void> {
    this.record.starts += 1;
    const failure = failNextStart;
    if (failure !== undefined) {
      failNextStart = undefined;
      return Promise.reject(failure);
    }
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.record.stops += 1;
    return Promise.resolve();
  }

  sendNotification(method: string, params?: unknown): Promise<void> {
    this.record.notifications.push({ method, params });
    return Promise.resolve();
  }

  onNotification(): { dispose(): void } {
    return { dispose: () => {} };
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

/** `new LanguageClient(id, name, serverOptions, clientOptions)`. */
export class NodeLanguageClient extends BaseClient {
  constructor(id: string, name: string, serverOptions: unknown, clientOptions: unknown) {
    super({ host: 'node', id, name, serverOptions, clientOptions, worker: undefined });
  }
}

/** `new LanguageClient(id, name, clientOptions, worker)`. */
export class BrowserLanguageClient extends BaseClient {
  constructor(id: string, name: string, clientOptions: unknown, worker: unknown) {
    super({ host: 'browser', id, name, serverOptions: undefined, clientOptions, worker });
  }
}

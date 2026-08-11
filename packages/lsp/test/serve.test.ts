/**
 * Starting the server the way the two hosts SPEC 29.4 names start it.
 *
 * The features are tested a file each, the transports are tested in
 * `transport.test.ts`, and the feature set is tested in `preset.test.ts`. What
 * is left is the wiring between them, which is small and asymmetric — the two
 * hosts differ over exactly the things that are invisible until a user hits
 * them: a log line that lands in the protocol and desynchronises an editor, a
 * process that stays up after its client is gone, a worker thread that outlives
 * the tab's interest in it.
 *
 * So the assertions below are about the channels rather than the answers: what
 * reached stdout, what reached stderr, and who was told about `exit`.
 */

import { describe, expect, it } from 'vitest';
import { MessageBuffer, encodeMessage } from '../src/protocol/jsonrpc.js';
import type { Message } from '../src/protocol/jsonrpc.js';
import { MessageType } from '../src/protocol/types.js';
import { mdvFeatures } from '../src/preset.js';
import { serve, serveStdio, serveWorker } from '../src/serve.js';
import { createServer } from '../src/server.js';
import type { ByteSink, ByteSource } from '../src/transport/stream.js';
import type { MessagePortLike } from '../src/transport/port.js';
import type { CodeLens, InitializeResult, LogMessageParams } from '../src/protocol/types.js';
import type { MdvFeatureSettings } from '../src/preset.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';

const URI = 'file:///a.mdv';

const SOURCE = [
  '```mdv bar',
  'x: quarter',
  'y: revenue',
  '---',
  'quarter | revenue',
  'Q1 | 1240',
  '```',
  '',
].join('\n');

/**
 * Diagnostics run on a timer, and a real one outlives the test that started it.
 * Nothing here waits for a diagnostic, so the timer that never fires is the
 * whole of what these tests need from a clock.
 */
const NEVER: MdvFeatureSettings = { schedule: () => () => {} };

/** A Node-shaped readable, driven by hand. */
class FakeSource implements ByteSource {
  readonly #listeners = new Map<string, ((argument: never) => void)[]>();

  on(event: string, listener: (argument: never) => void): unknown {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  /** What a client writing a request looks like from in here. */
  send(message: Message): void {
    for (const listener of this.#listeners.get('data') ?? []) {
      (listener as (value: unknown) => void)(encodeMessage(message));
    }
  }
}

class FakeSink implements ByteSink {
  readonly chunks: Uint8Array[] = [];

  write(chunk: Uint8Array): unknown {
    this.chunks.push(chunk);
    return true;
  }

  /** Everything written, read back as whole messages. */
  messages(): Message[] {
    const buffer = new MessageBuffer();
    for (const chunk of this.chunks) buffer.append(chunk);
    const found: Message[] = [];
    for (;;) {
      const result = buffer.take();
      if (result === undefined) return found;
      if (result.kind === 'message') found.push(result.message);
    }
  }
}

class FakeStderr {
  readonly lines: string[] = [];

  write(chunk: string): unknown {
    this.lines.push(chunk);
    return true;
  }
}

/** A worker global, driven by hand. */
class FakeScope implements MessagePortLike {
  readonly posted: Message[] = [];
  closed = 0;
  #listener: ((event: { readonly data: unknown }) => void) | undefined;

  postMessage(message: unknown): void {
    this.posted.push(message as Message);
  }

  addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
    this.#listener = listener;
  }

  close(): void {
    this.closed += 1;
  }

  send(message: Message): void {
    this.#listener?.({ data: message });
  }
}

const INITIALIZE: Message = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: INITIALIZE_PARAMS,
};

/** A change to a document nobody opened: the shortest route to a logged error. */
const ORPHAN_CHANGE: Message = {
  jsonrpc: '2.0',
  method: 'textDocument/didChange',
  params: { textDocument: { uri: URI, version: 2 }, contentChanges: [{ text: 'x' }] },
};

/** Notifications the server sent down `window/logMessage`, in order. */
function logged(posted: readonly Message[]): LogMessageParams[] {
  return posted
    .filter((message) => 'method' in message && message.method === 'window/logMessage')
    .map((message) => (message as { params: LogMessageParams }).params);
}

describe('serve', () => {
  it('installs the set, not a list the host had to keep', async () => {
    const mine = duplex();
    serve(mine.server, { settings: NEVER }).listen();
    const control = duplex();
    createServer(control.server, { features: mdvFeatures(NEVER) }).listen();

    const [answer, expected] = await Promise.all([
      mine.client.request('initialize', INITIALIZE_PARAMS),
      control.client.request('initialize', INITIALIZE_PARAMS),
    ]);

    const capabilities = (answer.result as InitializeResult).capabilities;
    // Both empty would pass the comparison below; the last feature added to the
    // preset is here to say they are not.
    expect(capabilities.semanticTokensProvider).toBeDefined();
    expect(capabilities).toEqual((expected.result as InitializeResult).capabilities);
  });

  it('carries a setting through to the feature that owns it', async () => {
    const { client, server } = duplex();
    serve(server, { settings: { ...NEVER, commands: { preview: 'acme.preview' } } }).listen();
    await client.request('initialize', INITIALIZE_PARAMS);
    client.notify('textDocument/didOpen', openParams(URI, SOURCE));
    await settle();

    const response = await client.request('textDocument/codeLens', { textDocument: { uri: URI } });
    const commands = (response.result as CodeLens[]).map((lens) => lens.command?.command);
    expect(commands).toContain('acme.preview');
  });
});

describe('serveStdio', () => {
  it('keeps stdout for the protocol and puts the log on stderr', async () => {
    const stdin = new FakeSource();
    const stdout = new FakeSink();
    const stderr = new FakeStderr();
    serveStdio({ stdin, stdout, stderr }, { settings: NEVER }).listen();

    stdin.send(INITIALIZE);
    await settle();
    stdin.send(ORPHAN_CHANGE);
    await settle();

    // One request in, one response out: both log lines took the other channel,
    // where the prefix says which is a note and which is a complaint.
    expect(stdout.messages()).toHaveLength(1);
    expect(stderr.lines).toEqual([
      '[mdv-language-server] Initialized for test-client\n',
      expect.stringMatching(/^\[mdv-language-server] error: Change for a document/),
    ]);
  });

  it('goes quiet rather than corrupting a frame when there is no stderr', async () => {
    const stdin = new FakeSource();
    const stdout = new FakeSink();
    serveStdio({ stdin, stdout }, { settings: NEVER }).listen();

    stdin.send(INITIALIZE);
    await settle();
    stdin.send(ORPHAN_CHANGE);
    await settle();

    expect(stdout.messages()).toHaveLength(1);
  });

  it('takes the host over its own logger', async () => {
    const stdin = new FakeSource();
    const stderr = new FakeStderr();
    const errors: string[] = [];
    serveStdio(
      { stdin, stdout: new FakeSink(), stderr },
      { settings: NEVER, logger: { info: () => {}, error: (message) => errors.push(message) } },
    ).listen();

    stdin.send(INITIALIZE);
    await settle();
    stdin.send(ORPHAN_CHANGE);
    await settle();

    expect(errors).toHaveLength(1);
    expect(stderr.lines).toEqual([]);
  });

  it('exits 0 for a shutdown that was asked for and 1 for a client that vanished', async () => {
    const asked = new FakeSource();
    const askedCodes: number[] = [];
    serveStdio(
      { stdin: asked, stdout: new FakeSink(), exit: (code) => askedCodes.push(code) },
      { settings: NEVER },
    ).listen();
    asked.send(INITIALIZE);
    await settle();
    asked.send({ jsonrpc: '2.0', id: 2, method: 'shutdown' });
    await settle();
    asked.send({ jsonrpc: '2.0', method: 'exit' });
    await settle();

    const abrupt = new FakeSource();
    const abruptCodes: number[] = [];
    serveStdio(
      { stdin: abrupt, stdout: new FakeSink(), exit: (code) => abruptCodes.push(code) },
      { settings: NEVER },
    ).listen();
    abrupt.send(INITIALIZE);
    await settle();
    abrupt.send({ jsonrpc: '2.0', method: 'exit' });
    await settle();

    expect(askedCodes).toEqual([0]);
    expect(abruptCodes).toEqual([1]);
  });

  it('tells the host before the process goes', async () => {
    const stdin = new FakeSource();
    const order: string[] = [];
    serveStdio(
      { stdin, stdout: new FakeSink(), exit: () => order.push('exit') },
      { settings: NEVER, onExit: () => order.push('onExit') },
    ).listen();

    stdin.send(INITIALIZE);
    await settle();
    stdin.send({ jsonrpc: '2.0', method: 'exit' });
    await settle();

    expect(order).toEqual(['onExit', 'exit']);
  });

  it('serves a document, so the wiring is a server and not just a socket', async () => {
    const stdin = new FakeSource();
    const stdout = new FakeSink();
    serveStdio({ stdin, stdout }, { settings: NEVER }).listen();

    stdin.send(INITIALIZE);
    stdin.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: openParams(URI, SOURCE) });
    await settle();
    stdin.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'textDocument/documentSymbol',
      params: { textDocument: { uri: URI } },
    });
    await settle();

    const answer = stdout.messages().at(-1) as { result: unknown[] };
    expect(answer.result.length).toBeGreaterThan(0);
  });
});

describe('serveWorker', () => {
  it('logs down the client channel, the only one a worker has', async () => {
    const scope = new FakeScope();
    serveWorker(scope, { settings: NEVER }).listen();

    scope.send(INITIALIZE);
    await settle();
    scope.send(ORPHAN_CHANGE);
    await settle();

    const messages = logged(scope.posted);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ type: MessageType.log, message: 'Initialized for test-client' });
    expect(messages[1]?.type).toBe(MessageType.error);
    expect(messages[1]?.message).toMatch(/^Change for a document/);
  });

  it('takes the host over its own logger', async () => {
    const scope = new FakeScope();
    const errors: string[] = [];
    serveWorker(scope, {
      settings: NEVER,
      logger: { info: () => {}, error: (message) => errors.push(message) },
    }).listen();

    scope.send(INITIALIZE);
    await settle();
    scope.send(ORPHAN_CHANGE);
    await settle();

    expect(errors).toHaveLength(1);
    expect(logged(scope.posted)).toEqual([]);
  });

  it('stops the worker when the client has gone', async () => {
    const scope = new FakeScope();
    const order: string[] = [];
    serveWorker(scope, { settings: NEVER, onExit: () => order.push('onExit') }).listen();

    scope.send(INITIALIZE);
    await settle();
    scope.send({ jsonrpc: '2.0', method: 'exit' });
    await settle();

    expect(scope.closed).toBe(1);
    expect(order).toEqual(['onExit']);
  });

  it('answers over the port, whole objects rather than bytes', async () => {
    const scope = new FakeScope();
    serveWorker(scope, { settings: NEVER }).listen();

    scope.send(INITIALIZE);
    await settle();

    const answer = scope.posted.find((message) => 'id' in message) as {
      id: number;
      result: InitializeResult;
    };
    expect(answer.id).toBe(1);
    expect(answer.result.serverInfo?.name).toBe('mdv-language-server');
  });
});

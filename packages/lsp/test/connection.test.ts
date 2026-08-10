/**
 * The three ordering rules of `protocol/connection.ts`, tested as behaviour.
 *
 * Each of them is a deadlock or a corruption when it is broken, and none of them
 * shows up in a type. They are asserted here against a byte-accurate in-memory
 * client, so the framing is exercised at the same time.
 */

import { describe, expect, it } from 'vitest';

import { MessageConnection } from '../src/protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../src/protocol/jsonrpc.js';
import { duplex, settle } from './harness.js';
import type { CancellationToken } from '../src/protocol/connection.js';

function connected(): { client: ReturnType<typeof duplex>['client']; server: MessageConnection } {
  const { client, server } = duplex();
  const connection = new MessageConnection(server, { error: () => {} });
  return { client, server: connection };
}

describe('requests', () => {
  it("answers a handler's result", async () => {
    const { client, server } = connected();
    server.onRequest('math/double', (params) => (params as { n: number }).n * 2);
    server.listen();
    expect(await client.call('math/double', { n: 21 })).toBe(42);
  });

  it('answers `undefined` as `null`, which is what the protocol allows', async () => {
    const { client, server } = connected();
    server.onRequest('nothing', () => undefined);
    server.listen();
    const response = await client.request('nothing');
    expect(response.result).toBeNull();
    expect(response.error).toBeUndefined();
  });

  it('awaits an asynchronous handler', async () => {
    const { client, server } = connected();
    server.onRequest('slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'done';
    });
    server.listen();
    expect(await client.call('slow')).toBe('done');
  });

  it('reports an unknown method rather than going silent', async () => {
    const { client, server } = connected();
    server.listen();
    const response = await client.request('textDocument/nonsense');
    expect(response.error?.code).toBe(ErrorCodes.methodNotFound);
    expect(response.error?.message).toBe('Unhandled method `textDocument/nonsense`');
  });

  it('turns a thrown ResponseErrorException into its own code', async () => {
    const { client, server } = connected();
    server.onRequest('picky', () => {
      throw new ResponseErrorException(ErrorCodes.invalidParams, 'No `uri`');
    });
    server.listen();
    const response = await client.request('picky');
    expect(response.error).toEqual({ code: ErrorCodes.invalidParams, message: 'No `uri`' });
  });

  it('turns any other throw into an internal error, never into silence', async () => {
    // A client that never hears back from a request waits forever, so a handler
    // bug must still produce a well-formed response.
    const { client, server } = connected();
    server.onRequest('buggy', () => {
      throw new TypeError('cannot read properties of undefined');
    });
    server.listen();
    const response = await client.request('buggy');
    expect(response.error?.code).toBe(ErrorCodes.internalError);
    expect(response.error?.message).toContain('cannot read properties');
  });

  it('runs handlers one at a time, in arrival order', async () => {
    // Rule 1. A completion that overtook the `didChange` before it would answer
    // against text the client has already replaced.
    const { client, server } = connected();
    const order: string[] = [];
    server.onRequest('slow', async () => {
      order.push('slow:start');
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push('slow:end');
      return 1;
    });
    server.onRequest('fast', () => {
      order.push('fast');
      return 2;
    });
    server.listen();
    const first = client.request('slow');
    const second = client.request('fast');
    await Promise.all([first, second]);
    expect(order).toEqual(['slow:start', 'slow:end', 'fast']);
  });
});

describe('notifications', () => {
  it('delivers params to a registered handler', async () => {
    const { client, server } = connected();
    const seen: unknown[] = [];
    server.onNotification('textDocument/didSave', (params) => seen.push(params));
    server.listen();
    client.notify('textDocument/didSave', { uri: 'file:///a.mdv' });
    await settle();
    expect(seen).toEqual([{ uri: 'file:///a.mdv' }]);
  });

  it('logs an unknown notification but keeps going', async () => {
    const logged: string[] = [];
    const { client, server } = duplex();
    const connection = new MessageConnection(server, { error: (message) => logged.push(message) });
    let reached = false;
    connection.onNotification('after', () => {
      reached = true;
    });
    connection.listen();
    client.notify('workspace/didChangeWatchedFiles');
    client.notify('after');
    await settle();
    expect(logged).toEqual(['No handler for notification `workspace/didChangeWatchedFiles`']);
    expect(reached).toBe(true);
  });

  it('ignores an unknown `$/` notification silently, as the spec permits', async () => {
    const logged: string[] = [];
    const { client, server } = duplex();
    new MessageConnection(server, { error: (message) => logged.push(message) }).listen();
    client.notify('$/progress', { token: 1 });
    await settle();
    expect(logged).toEqual([]);
  });

  it('swallows a throwing notification handler into the log', async () => {
    const logged: string[] = [];
    const { client, server } = duplex();
    const connection = new MessageConnection(server, { error: (message) => logged.push(message) });
    connection.onNotification('boom', () => {
      throw new Error('handler bug');
    });
    connection.listen();
    client.notify('boom');
    await settle();
    expect(logged).toEqual(['`boom` failed: handler bug']);
  });
});

describe('cancellation', () => {
  it('reaches a running handler instead of queueing behind it', async () => {
    // Rule 2. Cancellation that waits its turn is not cancellation.
    const { client, server } = connected();
    let observed = false;
    server.onRequest('long', async (_params, token: CancellationToken) => {
      for (let step = 0; step < 50; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (token.isCancellationRequested) {
          observed = true;
          throw new ResponseErrorException(ErrorCodes.requestCancelled, 'Request cancelled');
        }
      }
      return 'finished';
    });
    server.listen();
    const pending = client.request('long');
    await settle();
    client.cancel(1);
    const response = await pending;
    expect(observed).toBe(true);
    expect(response.error?.code).toBe(ErrorCodes.requestCancelled);
  });

  it('notifies a listener registered before the cancellation', async () => {
    const { client, server } = connected();
    let notified = false;
    server.onRequest('long', async (_params, token: CancellationToken) => {
      token.onCancellationRequested(() => {
        notified = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    });
    server.listen();
    const pending = client.request('long');
    await settle();
    client.cancel(1);
    await pending;
    expect(notified).toBe(true);
  });

  it('starts an already-cancelled request cancelled, when the cancel overtook it', async () => {
    const { client, server } = connected();
    let sawCancelledAtEntry: boolean | undefined;
    server.onRequest('blocking', async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return null;
    });
    server.onRequest('second', (_params, token: CancellationToken) => {
      sawCancelledAtEntry = token.isCancellationRequested;
      // A late subscriber still hears the event once.
      let late = false;
      token.onCancellationRequested(() => {
        late = true;
      });
      return { entry: token.isCancellationRequested, late };
    });
    server.listen();
    const first = client.request('blocking');
    const second = client.request('second');
    await settle();
    client.cancel(2);
    await Promise.all([first, second]);
    expect(sawCancelledAtEntry).toBe(true);
    expect((await second).result).toEqual({ entry: true, late: true });
  });

  it('ignores a cancellation for an id it has never seen', async () => {
    const { client, server } = connected();
    server.onRequest('ping', () => 'pong');
    server.listen();
    client.notify('$/cancelRequest', {});
    client.cancel(999);
    expect(await client.call('ping')).toBe('pong');
  });
});

describe('outgoing requests', () => {
  it('resolves when the client answers', async () => {
    const { client, server } = connected();
    server.listen();
    const answer = server.sendRequest('workspace/configuration', { items: [] });
    await settle();
    const outgoing = client.received.find((message) => 'method' in message);
    expect(outgoing).toMatchObject({ method: 'workspace/configuration', id: 1 });
    client.writeRaw(encode({ jsonrpc: '2.0', id: 1, result: [{ enable: true }] }));
    expect(await answer).toEqual([{ enable: true }]);
  });

  it('does not deadlock when a handler awaits a request of its own', async () => {
    // Rule 3. If responses queued behind handlers, this would hang forever: the
    // handler holds the queue that the response has to pass through.
    const { client, server } = connected();
    server.onRequest('needsConfig', async () => {
      const config = (await server.sendRequest('workspace/configuration')) as { level: number };
      return config.level * 2;
    });
    server.listen();
    const pending = client.request('needsConfig');
    await settle();
    const outgoing = client.received.find(
      (message) => 'method' in message && message.method === 'workspace/configuration',
    );
    expect(outgoing).toBeDefined();
    client.writeRaw(encode({ jsonrpc: '2.0', id: 1, result: { level: 3 } }));
    expect((await pending).result).toBe(6);
  });

  it('rejects an outgoing request when the client answers with an error', async () => {
    const { client, server } = connected();
    server.listen();
    const answer = server.sendRequest('window/showMessageRequest');
    await settle();
    client.writeRaw(
      encode({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'not supported' } }),
    );
    await expect(answer).rejects.toThrow('not supported');
  });

  it('rejects everything in flight when the connection goes away', async () => {
    const { client, server } = connected();
    server.listen();
    const answer = server.sendRequest('workspace/configuration');
    await settle();
    client.transport.dispose();
    await expect(answer).rejects.toThrow('The connection closed');
  });

  it('refuses to send on a closed connection', async () => {
    const { server } = connected();
    server.listen();
    server.dispose();
    await expect(server.sendRequest('anything')).rejects.toThrow('The connection is closed');
  });
});

describe('the request guard', () => {
  it('refuses a method that has no handler, which is the whole point of it', async () => {
    // A per-handler check cannot answer for a method nobody registered, and
    // `MethodNotFound` would send the client looking for a bug in its own
    // capability negotiation instead of in its lifecycle.
    const { client, server } = connected();
    server.setRequestGuard(() => ({ code: ErrorCodes.serverNotInitialized, message: 'not yet' }));
    server.listen();
    const response = await client.request('textDocument/documentSymbol');
    expect(response.error).toEqual({ code: ErrorCodes.serverNotInitialized, message: 'not yet' });
  });

  it('runs before the handler, which never sees the request', async () => {
    const { client, server } = connected();
    let ran = 0;
    server.onRequest('ping', () => {
      ran += 1;
      return 'pong';
    });
    server.setRequestGuard(() => ({ code: ErrorCodes.invalidRequest, message: 'no' }));
    server.listen();
    await client.request('ping');
    expect(ran).toBe(0);
  });

  it('lets a request through when it returns nothing, and can be lifted', async () => {
    const { client, server } = connected();
    let open = false;
    server.onRequest('ping', () => 'pong');
    server.setRequestGuard(() =>
      open ? undefined : { code: ErrorCodes.serverNotInitialized, message: 'not yet' },
    );
    server.listen();
    expect((await client.request('ping')).error?.code).toBe(ErrorCodes.serverNotInitialized);
    open = true;
    expect(await client.call('ping')).toBe('pong');
    server.setRequestGuard(undefined);
    expect(await client.call('ping')).toBe('pong');
  });

  it('does not sit in front of notifications, which have nowhere to answer', async () => {
    const { client, server } = connected();
    const seen: string[] = [];
    server.onNotification('note', () => seen.push('note'));
    server.setRequestGuard(() => ({ code: ErrorCodes.invalidRequest, message: 'no' }));
    server.listen();
    client.notify('note');
    await settle();
    expect(seen).toEqual(['note']);
  });
});

describe('malformed input', () => {
  it('answers a parse error with a null id and stays open', async () => {
    const { client, server } = connected();
    server.onRequest('ping', () => 'pong');
    server.listen();
    client.writeRaw('Content-Length: 5\r\n\r\n{oops');
    await settle();
    const error = client.received.find((message) => 'error' in message);
    expect(error).toMatchObject({ id: null });
    // The frame was intact, so the stream is still in sync.
    expect(await client.call('ping')).toBe('pong');
  });

  it('closes the connection when the stream itself is unreadable', async () => {
    const logged: string[] = [];
    const { client, server } = duplex();
    const connection = new MessageConnection(server, { error: (message) => logged.push(message) });
    let closed = false;
    connection.onClose(() => {
      closed = true;
    });
    connection.listen();
    client.writeRaw('Content-Type: text/plain\r\n\r\n{}');
    await settle();
    expect(closed).toBe(true);
    expect(logged[0]).toContain('Closing the connection');
  });

  it('reports a response to a request it never sent', async () => {
    const logged: string[] = [];
    const { client, server } = duplex();
    new MessageConnection(server, { error: (message) => logged.push(message) }).listen();
    client.writeRaw(encode({ jsonrpc: '2.0', id: 77, result: null }));
    await settle();
    expect(logged).toEqual(['A response arrived for unknown request 77']);
  });
});

describe('lifetime', () => {
  it('fires onClose once when the far end disappears', async () => {
    const { client, server } = connected();
    let closes = 0;
    server.onClose(() => {
      closes += 1;
    });
    server.listen();
    client.transport.dispose();
    await settle();
    expect(closes).toBe(1);
  });

  it('is idempotent under dispose', () => {
    const { server } = connected();
    server.listen();
    server.dispose();
    expect(() => server.dispose()).not.toThrow();
  });

  it('stops routing to a disposed handler', async () => {
    const { client, server } = connected();
    const registration = server.onRequest('temp', () => 'here');
    server.listen();
    expect(await client.call('temp')).toBe('here');
    registration.dispose();
    expect((await client.request('temp')).error?.code).toBe(ErrorCodes.methodNotFound);
  });
});

/** Frame a message the way a client would, for the raw-write cases above. */
function encode(message: Record<string, unknown>): Uint8Array {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const header = new TextEncoder().encode(`Content-Length: ${body.length}\r\n\r\n`);
  const frame = new Uint8Array(header.length + body.length);
  frame.set(header, 0);
  frame.set(body, header.length);
  return frame;
}

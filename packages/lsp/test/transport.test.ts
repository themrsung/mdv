/**
 * The two transports SPEC 29.4 names: stdio in a desktop host, a port in a
 * worker. Both are plumbing, and plumbing is only ever tested one way — put
 * something in one end and look at the other end.
 *
 * So the assertions here are about bytes and objects rather than about MDV. The
 * two that matter most are the awkward ones: a client that writes before the
 * server listens (an editor always does), and a port that carries objects while
 * everything under it counts bytes.
 */

import { describe, expect, it } from 'vitest';
import { MessageBuffer, encodeMessage } from '../src/protocol/jsonrpc.js';
import type { Message } from '../src/protocol/jsonrpc.js';
import { createServer } from '../src/server.js';
import { portTransport } from '../src/transport/port.js';
import type { MessagePortLike } from '../src/transport/port.js';
import { streamTransport } from '../src/transport/stream.js';
import type { ByteSink, ByteSource } from '../src/transport/stream.js';
import { INITIALIZE_PARAMS, settle } from './harness.js';

const encoder = new TextEncoder();

/** A Node-shaped readable, driven by hand. */
class FakeSource implements ByteSource {
  readonly #listeners = new Map<string, ((argument: never) => void)[]>();

  on(event: string, listener: (argument: never) => void): unknown {
    const existing = this.#listeners.get(event) ?? [];
    existing.push(listener);
    this.#listeners.set(event, existing);
    return this;
  }

  emit(event: 'data' | 'end' | 'close' | 'error', argument?: unknown): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      (listener as (value: unknown) => void)(argument);
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

/** A worker port, driven by hand. `start` is present so its call can be seen. */
class FakePort implements MessagePortLike {
  readonly posted: unknown[] = [];
  started = 0;
  #listener: ((event: { readonly data: unknown }) => void) | undefined;

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  addEventListener(_type: 'message', listener: (event: { readonly data: unknown }) => void): void {
    this.#listener = listener;
  }

  start(): void {
    this.started += 1;
  }

  deliver(data: unknown): void {
    this.#listener?.({ data });
  }
}

const HELLO: Message = { jsonrpc: '2.0', id: 1, method: 'initialize' };

describe('streamTransport', () => {
  it('hands over what the stream gives it', () => {
    const input = new FakeSource();
    const transport = streamTransport(input, new FakeSink());
    const seen: string[] = [];
    transport.onData((chunk) => seen.push(new TextDecoder().decode(chunk)));

    input.emit('data', encoder.encode('one'));
    input.emit('data', encoder.encode('two'));

    expect(seen).toEqual(['one', 'two']);
  });

  it('keeps the bytes that arrived before anyone was listening', () => {
    // An editor spawns the process and writes `initialize` at once; the server
    // is still installing features. Losing this is a handshake that never ends.
    const input = new FakeSource();
    const transport = streamTransport(input, new FakeSink());
    input.emit('data', encodeMessage(HELLO));

    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    const buffer = new MessageBuffer();
    for (const chunk of seen) buffer.append(chunk);
    expect(buffer.take()).toEqual({ kind: 'message', message: HELLO });
  });

  it('re-encodes a stream that was given an encoding', () => {
    const input = new FakeSource();
    const transport = streamTransport(input, new FakeSink());
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    input.emit('data', '가');

    // Three bytes, not one character: `Content-Length` counts the former.
    expect(Array.from(seen[0] ?? [])).toEqual([0xea, 0xb0, 0x80]);
  });

  it('writes where the client reads', () => {
    const output = new FakeSink();
    const transport = streamTransport(new FakeSource(), output);
    transport.write(encodeMessage(HELLO));
    expect(output.messages()).toEqual([HELLO]);
  });

  it('closes once, however the far end goes', () => {
    // Node emits `end` then `close` for a stream that finished, and `error`
    // alone for a pipe that broke. All three mean the same thing here.
    const input = new FakeSource();
    const transport = streamTransport(input, new FakeSink());
    let closes = 0;
    transport.onClose(() => {
      closes += 1;
    });

    input.emit('end');
    input.emit('close');
    input.emit('error', new Error('EPIPE'));

    expect(closes).toBe(1);
  });

  it('tells a listener that registers after the close', () => {
    const input = new FakeSource();
    const transport = streamTransport(input, new FakeSink());
    input.emit('end');

    let closed = false;
    transport.onClose(() => {
      closed = true;
    });

    expect(closed).toBe(true);
  });

  it('stops writing once the far end has gone', () => {
    const output = new FakeSink();
    const input = new FakeSource();
    const transport = streamTransport(input, output);
    input.emit('end');

    transport.write(encodeMessage(HELLO));

    expect(output.chunks).toEqual([]);
  });

  it('goes quiet when disposed, without reporting a close', () => {
    // Disposing is this end finishing, not the client vanishing: a connection
    // told the second thing fails every request in flight.
    const input = new FakeSource();
    const output = new FakeSink();
    const transport = streamTransport(input, output);
    let closed = false;
    transport.onClose(() => {
      closed = true;
    });
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    transport.dispose();
    input.emit('data', encoder.encode('late'));
    transport.write(encodeMessage(HELLO));

    expect(closed).toBe(false);
    expect(seen).toEqual([]);
    expect(output.chunks).toEqual([]);
  });

  it('carries a handshake between a real server and a hand-fed stream', async () => {
    const input = new FakeSource();
    const output = new FakeSink();
    const server = createServer(streamTransport(input, output), { version: '0.0.0' });
    server.listen();

    // Split across a chunk boundary in the middle of the header, which is what
    // a pipe does when it feels like it.
    const frame = encodeMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: INITIALIZE_PARAMS,
    });
    input.emit('data', frame.subarray(0, 5));
    input.emit('data', frame.subarray(5));
    await settle();

    const [response] = output.messages();
    expect(response).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'mdv-language-server', version: '0.0.0' } },
    });
  });
});

describe('portTransport', () => {
  it('starts a port that needs starting', () => {
    const port = new FakePort();
    portTransport(port);
    expect(port.started).toBe(1);
  });

  it('posts the message, not the frame', () => {
    // A browser LSP client reads `event.data` as the message itself. Posting
    // bytes at it would be a channel talking to nobody.
    const port = new FakePort();
    const transport = portTransport(port);

    transport.write(encodeMessage(HELLO));

    expect(port.posted).toEqual([HELLO]);
  });

  it('posts nothing until a split frame is whole, then all of what arrived', () => {
    const port = new FakePort();
    const transport = portTransport(port);
    const second: Message = { jsonrpc: '2.0', method: 'initialized' };
    const frame = encodeMessage(HELLO);

    transport.write(frame.subarray(0, 12));
    expect(port.posted).toEqual([]);

    const rest = new Uint8Array(frame.length - 12 + encodeMessage(second).length);
    rest.set(frame.subarray(12), 0);
    rest.set(encodeMessage(second), frame.length - 12);
    transport.write(rest);

    expect(port.posted).toEqual([HELLO, second]);
  });

  it('frames an object that arrives, so the connection can read it', () => {
    const port = new FakePort();
    const transport = portTransport(port);
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    port.deliver(HELLO);

    const buffer = new MessageBuffer();
    for (const chunk of seen) buffer.append(chunk);
    expect(buffer.take()).toEqual({ kind: 'message', message: HELLO });
  });

  it('passes bytes through for a peer that framed them itself', () => {
    const port = new FakePort();
    const transport = portTransport(port);
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    const frame = encodeMessage(HELLO);
    port.deliver(frame);
    const copy = new ArrayBuffer(frame.length);
    new Uint8Array(copy).set(frame);
    port.deliver(copy);

    expect(seen).toHaveLength(2);
    expect(Array.from(seen[1] ?? [])).toEqual(Array.from(frame));
  });

  it('keeps what arrived before anyone was listening', () => {
    const port = new FakePort();
    const transport = portTransport(port);
    port.deliver(HELLO);

    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    expect(seen).toHaveLength(1);
  });

  it('drops a value it cannot serialise and keeps reading', () => {
    // Structured clone carries cycles across a port; `JSON.stringify` refuses
    // them. One broken peer message is not a broken connection.
    const port = new FakePort();
    const transport = portTransport(port);
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    port.deliver(cyclic);
    port.deliver('not a message');
    port.deliver(HELLO);

    expect(seen).toHaveLength(1);
  });

  it('goes quiet in both directions when disposed', () => {
    const port = new FakePort();
    const transport = portTransport(port);
    const seen: Uint8Array[] = [];
    transport.onData((chunk) => seen.push(chunk));

    transport.dispose();
    port.deliver(HELLO);
    transport.write(encodeMessage(HELLO));

    expect(seen).toEqual([]);
    expect(port.posted).toEqual([]);
  });

  it('carries a handshake between a real server and a hand-driven port', async () => {
    const port = new FakePort();
    const server = createServer(portTransport(port), { version: '0.0.0' });
    server.listen();

    port.deliver({ jsonrpc: '2.0', id: 1, method: 'initialize', params: INITIALIZE_PARAMS });
    await settle();

    expect(port.posted).toHaveLength(1);
    expect(port.posted[0]).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: { serverInfo: { name: 'mdv-language-server', version: '0.0.0' } },
    });
  });
});

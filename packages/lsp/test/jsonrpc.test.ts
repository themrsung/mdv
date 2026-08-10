/**
 * Framing: the layer where a bug is silent and permanent.
 *
 * `Content-Length` counts bytes, chunks arrive at arbitrary boundaries, and a
 * single byte misread desynchronises every message that follows. These tests
 * exist to make that class of bug loud.
 */

import { describe, expect, it } from 'vitest';

import {
  ErrorCodes,
  JSONRPC_VERSION,
  MessageBuffer,
  ResponseErrorException,
  encodeMessage,
  isNotificationMessage,
  isRequestMessage,
  isResponseMessage,
} from '../src/protocol/jsonrpc.js';
import type { Message } from '../src/protocol/jsonrpc.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function frame(body: string): Uint8Array {
  const bytes = encoder.encode(body);
  return encoder.encode(`Content-Length: ${bytes.length}\r\n\r\n${body}`);
}

function drain(buffer: MessageBuffer): Message[] {
  const messages: Message[] = [];
  for (;;) {
    const result = buffer.take();
    if (result === undefined) return messages;
    if (result.kind !== 'message') throw new Error(result.reason);
    messages.push(result.message);
  }
}

describe('encodeMessage', () => {
  it('writes an ASCII header, a blank line, then the JSON body', () => {
    const bytes = encodeMessage({ jsonrpc: JSONRPC_VERSION, method: 'initialized' });
    const text = decoder.decode(bytes);
    expect(text).toBe(`Content-Length: 40\r\n\r\n{"jsonrpc":"2.0","method":"initialized"}`);
    expect(text.slice(0, text.indexOf('\r\n\r\n'))).toMatch(/^Content-Length: \d+$/u);
  });

  it('counts UTF-8 bytes, not characters', () => {
    // The em dash is three bytes and one JavaScript character. A server that
    // measured `.length` would under-declare by two and truncate the body.
    const message: Message = { jsonrpc: JSONRPC_VERSION, method: 'x', params: { text: '—' } };
    const bytes = encodeMessage(message);
    const text = decoder.decode(bytes);
    const declared = Number(/Content-Length: (\d+)/u.exec(text)?.[1]);
    const body = JSON.stringify(message);
    expect(declared).toBe(encoder.encode(body).length);
    expect(declared).toBeGreaterThan(body.length);
  });

  it('round-trips through the buffer with multi-byte content intact', () => {
    const buffer = new MessageBuffer();
    const sent: Message = {
      jsonrpc: JSONRPC_VERSION,
      id: 1,
      method: 'textDocument/didOpen',
      params: { text: 'ラベル — 🎯 café' },
    };
    buffer.append(encodeMessage(sent));
    expect(drain(buffer)).toEqual([sent]);
    expect(buffer.pending).toBe(0);
  });
});

describe('MessageBuffer', () => {
  it('yields nothing until a whole frame has arrived', () => {
    const buffer = new MessageBuffer();
    const bytes = frame('{"jsonrpc":"2.0","method":"a"}');
    for (const byte of bytes.slice(0, bytes.length - 1)) {
      buffer.append(new Uint8Array([byte]));
      expect(buffer.take()).toBeUndefined();
    }
    buffer.append(bytes.subarray(bytes.length - 1));
    expect(drain(buffer)).toEqual([{ jsonrpc: '2.0', method: 'a' }]);
  });

  it('splits several messages delivered in one chunk', () => {
    const buffer = new MessageBuffer();
    const a = frame('{"jsonrpc":"2.0","method":"a"}');
    const b = frame('{"jsonrpc":"2.0","method":"b"}');
    const c = frame('{"jsonrpc":"2.0","id":3,"result":null}');
    const joined = new Uint8Array(a.length + b.length + c.length);
    joined.set(a, 0);
    joined.set(b, a.length);
    joined.set(c, a.length + b.length);
    buffer.append(joined);
    expect(
      drain(buffer).map((message) => ('method' in message ? message.method : message.id)),
    ).toEqual(['a', 'b', 3]);
  });

  it('survives a chunk boundary inside the header', () => {
    const buffer = new MessageBuffer();
    const bytes = frame('{"jsonrpc":"2.0","method":"split"}');
    buffer.append(bytes.subarray(0, 9));
    expect(buffer.take()).toBeUndefined();
    buffer.append(bytes.subarray(9));
    expect(drain(buffer)).toEqual([{ jsonrpc: '2.0', method: 'split' }]);
  });

  it('reads the header name case-insensitively and ignores Content-Type', () => {
    const buffer = new MessageBuffer();
    const body = '{"jsonrpc":"2.0","method":"case"}';
    buffer.append(
      encoder.encode(
        `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n` +
          `content-length: ${encoder.encode(body).length}\r\n\r\n${body}`,
      ),
    );
    expect(drain(buffer)).toEqual([{ jsonrpc: '2.0', method: 'case' }]);
  });

  it('reports a body that is not JSON as invalid, and stays in sync', () => {
    const buffer = new MessageBuffer();
    buffer.append(frame('{oops'));
    buffer.append(frame('{"jsonrpc":"2.0","method":"after"}'));
    const first = buffer.take();
    expect(first?.kind).toBe('invalid');
    // The point of `invalid` rather than `corrupt`: the next frame still reads.
    expect(drain(buffer)).toEqual([{ jsonrpc: '2.0', method: 'after' }]);
  });

  it('rejects a JSON-RPC batch, which is legal JSON-RPC but not legal LSP', () => {
    const buffer = new MessageBuffer();
    buffer.append(frame('[{"jsonrpc":"2.0","method":"a"}]'));
    expect(buffer.take()).toEqual({
      kind: 'invalid',
      reason: 'A message body was not a JSON-RPC object',
    });
  });

  it('reports a header without a Content-Length as corrupt', () => {
    const buffer = new MessageBuffer();
    buffer.append(encoder.encode('Content-Type: text/plain\r\n\r\n{}'));
    const result = buffer.take();
    expect(result?.kind).toBe('corrupt');
    // There is no offset to resume from, so nothing is kept.
    expect(buffer.pending).toBe(0);
  });

  it('reports a non-numeric Content-Length as corrupt rather than guessing', () => {
    const buffer = new MessageBuffer();
    buffer.append(encoder.encode('Content-Length: eleven\r\n\r\n{}'));
    expect(buffer.take()?.kind).toBe('corrupt');
  });

  it('accepts an empty body as an invalid message, not a hang', () => {
    const buffer = new MessageBuffer();
    buffer.append(encoder.encode('Content-Length: 0\r\n\r\n'));
    expect(buffer.take()?.kind).toBe('invalid');
  });
});

describe('message classification', () => {
  const request: Message = { jsonrpc: JSONRPC_VERSION, id: 1, method: 'a' };
  const notification: Message = { jsonrpc: JSONRPC_VERSION, method: 'a' };
  const response: Message = { jsonrpc: JSONRPC_VERSION, id: 1, result: null };

  it('tells the three kinds apart', () => {
    expect([request, notification, response].map(isRequestMessage)).toEqual([true, false, false]);
    expect([request, notification, response].map(isNotificationMessage)).toEqual([
      false,
      true,
      false,
    ]);
    expect([request, notification, response].map(isResponseMessage)).toEqual([false, false, true]);
  });

  it('treats a null id with a method as a notification, not a request', () => {
    // A client that sends `id: null` on a request has broken it; answering an
    // id of `null` would be indistinguishable from a parse-error response.
    const odd = { jsonrpc: JSONRPC_VERSION, id: null, method: 'a' } as unknown as Message;
    expect(isRequestMessage(odd)).toBe(false);
  });
});

describe('ResponseErrorException', () => {
  it('carries its code into the response', () => {
    const error = new ResponseErrorException(ErrorCodes.invalidParams, 'No `uri`');
    expect(error.toResponseError()).toEqual({
      code: ErrorCodes.invalidParams,
      message: 'No `uri`',
    });
  });

  it('omits `data` entirely when there is none', () => {
    const error = new ResponseErrorException(ErrorCodes.internalError, 'boom');
    expect('data' in error.toResponseError()).toBe(false);
    expect(new ResponseErrorException(1, 'x', { detail: true }).toResponseError().data).toEqual({
      detail: true,
    });
  });

  it('is an Error, so an accidental throw still has a stack', () => {
    expect(new ResponseErrorException(1, 'x')).toBeInstanceOf(Error);
  });
});

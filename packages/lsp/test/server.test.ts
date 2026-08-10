/**
 * The lifecycle and document sync, driven the way a real client drives them.
 *
 * The handshake is the part of LSP that a client will not forgive: advertise a
 * capability with nothing behind it and the editor calls it; get the state
 * machine wrong and the editor hangs at startup with no error anywhere.
 */

import { describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { TextDocumentSyncKind } from '../src/protocol/types.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { MdvServer } from '../src/server.js';
import type { InitializeResult } from '../src/protocol/types.js';
import type { TestClient } from './harness.js';

interface Started {
  client: TestClient;
  server: MdvServer;
  exits: number[];
  logged: string[];
}

function start(): Started {
  const { client, server: transport } = duplex();
  const exits: number[] = [];
  const logged: string[] = [];
  const server = createServer(transport, {
    version: '0.0.0',
    onExit: (code) => exits.push(code),
    logger: { info: (message) => logged.push(message), error: (message) => logged.push(message) },
  });
  server.listen();
  return { client, server, exits, logged };
}

async function started(): Promise<Started> {
  const context = start();
  await context.client.call('initialize', INITIALIZE_PARAMS);
  context.client.notify('initialized', {});
  await settle();
  return context;
}

describe('initialize', () => {
  it('reports its name and version', async () => {
    const { client } = start();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.serverInfo).toEqual({ name: 'mdv-language-server', version: '0.0.0' });
  });

  it('advertises incremental sync with open/close and save', async () => {
    const { client } = start();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.textDocumentSync).toEqual({
      openClose: true,
      change: TextDocumentSyncKind.incremental,
      save: { includeText: false },
    });
  });

  it('answers `utf-16`, the encoding its offsets are computed in', async () => {
    const { client } = start();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.positionEncoding).toBe('utf-16');
  });

  it('advertises nothing it cannot serve', async () => {
    // Stage 1 has no language features, so the handshake must not promise any:
    // a client will call whatever appears here.
    const { client } = start();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(Object.keys(result.capabilities).sort()).toEqual([
      'positionEncoding',
      'textDocumentSync',
    ]);
  });

  it('refuses a second initialize', async () => {
    const { client } = await started();
    const response = await client.request('initialize', INITIALIZE_PARAMS);
    expect(response.error?.code).toBe(ErrorCodes.invalidRequest);
    expect(response.error?.message).toBe('The server is already initialized');
  });

  it('accepts an initialize with no capabilities at all', async () => {
    const { client } = start();
    const response = await client.request('initialize', { processId: null, rootUri: null });
    expect(response.error).toBeUndefined();
  });
});

describe('the pre-initialize guard', () => {
  it('answers ServerNotInitialized, not a wrong answer', async () => {
    const { client } = start();
    const response = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: 'file:///a.mdv' },
    });
    // −32002. The server does not yet know what the client can render.
    expect(response.error?.code).toBe(ErrorCodes.serverNotInitialized);
  });

  it('drops a document notification that arrives too early', async () => {
    const { client, server } = start();
    client.notify('textDocument/didOpen', openParams('file:///early.mdv', 'x'));
    await settle();
    expect(server.documents.all()).toHaveLength(0);
  });
});

describe('shutdown and exit', () => {
  it('answers shutdown with null and stays up', async () => {
    const { client, server, exits } = await started();
    expect((await client.request('shutdown')).result).toBeNull();
    expect(server.state()).toBe('shuttingDown');
    expect(exits).toEqual([]);
  });

  it('clears the diagnostics it published before going away', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', 'x'));
    await settle();
    await client.call('shutdown');
    expect(client.notificationsOf('textDocument/publishDiagnostics')).toEqual([
      {
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///a.mdv', diagnostics: [] },
      },
    ]);
  });

  it('refuses a request that arrives after shutdown', async () => {
    const { client } = await started();
    await client.call('shutdown');
    const response = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: 'file:///a.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidRequest);
    expect(response.error?.message).toContain('after `shutdown`');
  });

  it('exits 0 after a shutdown', async () => {
    const { client, server, exits } = await started();
    await client.call('shutdown');
    client.notify('exit');
    await settle();
    expect(exits).toEqual([0]);
    expect(server.state()).toBe('exited');
  });

  it('exits 1 when `exit` arrives without one, so a supervisor can tell', async () => {
    const { client, exits } = await started();
    client.notify('exit');
    await settle();
    expect(exits).toEqual([1]);
  });

  it('exits 1 when the client vanishes without saying anything', async () => {
    const { client, exits } = await started();
    client.transport.dispose();
    await settle();
    expect(exits).toEqual([1]);
  });

  it('does not exit twice when the transport closes after `exit`', async () => {
    const { client, exits } = await started();
    await client.call('shutdown');
    client.notify('exit');
    await settle();
    client.transport.dispose();
    await settle();
    expect(exits).toEqual([0]);
  });
});

describe('document synchronisation', () => {
  it('mirrors an opened document', async () => {
    const { client, server } = await started();
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', '# Title\n'));
    await settle();
    const document = server.documents.get('file:///a.mdv');
    expect(document?.text).toBe('# Title\n');
    expect(document?.languageId).toBe('mdv');
    expect(document?.version).toBe(1);
  });

  it('applies an incremental change to the mirror', async () => {
    const { client, server } = await started();
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', 'one\ntwo\n'));
    client.notify('textDocument/didChange', {
      textDocument: { uri: 'file:///a.mdv', version: 2 },
      contentChanges: [
        {
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 } },
          text: 'TWO',
        },
      ],
    });
    await settle();
    const document = server.documents.get('file:///a.mdv');
    expect(document?.text).toBe('one\nTWO\n');
    expect(document?.version).toBe(2);
  });

  it('keeps two documents apart', async () => {
    const { client, server } = await started();
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', 'A'));
    client.notify('textDocument/didOpen', openParams('file:///b.mdv', 'B'));
    await settle();
    expect(
      server.documents
        .all()
        .map((document) => document.text)
        .sort(),
    ).toEqual(['A', 'B']);
  });

  it('forgets a closed document', async () => {
    const { client, server } = await started();
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', 'A'));
    client.notify('textDocument/didClose', { textDocument: { uri: 'file:///a.mdv' } });
    await settle();
    expect(server.documents.all()).toHaveLength(0);
  });

  it('logs a change for a document it never saw, and does not invent one', async () => {
    const { client, server, logged } = await started();
    client.notify('textDocument/didChange', {
      textDocument: { uri: 'file:///ghost.mdv', version: 2 },
      contentChanges: [{ text: 'invented' }],
    });
    await settle();
    expect(server.documents.all()).toHaveLength(0);
    expect(logged.some((line) => line.includes('never opened'))).toBe(true);
  });

  it('announces a save without needing the text', async () => {
    const { client, server } = await started();
    const seen: string[] = [];
    server.documents.onDidChangeContent((event) => seen.push(event.reason));
    client.notify('textDocument/didOpen', openParams('file:///a.mdv', 'A'));
    client.notify('textDocument/didSave', { textDocument: { uri: 'file:///a.mdv' } });
    await settle();
    expect(seen).toEqual(['open', 'save']);
    expect(server.documents.get('file:///a.mdv')?.text).toBe('A');
  });
});

describe('features', () => {
  it('advertises only what an installed feature claims', async () => {
    const { client, server: transport } = duplex();
    const server = createServer(transport, {
      features: [
        (context) => {
          context.onRequest('textDocument/hover', () => ({
            contents: { kind: 'markdown', value: 'hi' },
          }));
          return { hoverProvider: true };
        },
      ],
    });
    server.listen();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.hoverProvider).toBe(true);
    expect(await client.call('textDocument/hover', {})).toEqual({
      contents: { kind: 'markdown', value: 'hi' },
    });
  });

  it('hands a feature the client capabilities it was initialized with', async () => {
    const { client, server: transport } = duplex();
    let seen: unknown;
    const server = createServer(transport, {
      features: [
        (context) => {
          context.onRequest('probe', () => {
            seen = context.client();
            return null;
          });
          return {};
        },
      ],
    });
    server.listen();
    await client.call('initialize', INITIALIZE_PARAMS);
    await client.call('probe');
    expect(seen).toEqual(INITIALIZE_PARAMS.capabilities);
  });

  it('guards a feature request with the same lifecycle rules', async () => {
    const { client, server: transport } = duplex();
    createServer(transport, {
      features: [
        (context) => {
          context.onRequest('probe', () => 'served');
          return {};
        },
      ],
    }).listen();
    expect((await client.request('probe')).error?.code).toBe(ErrorCodes.serverNotInitialized);
    await client.call('initialize', INITIALIZE_PARAMS);
    expect(await client.call('probe')).toBe('served');
  });
});

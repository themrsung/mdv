/**
 * Naming the server bundles (SPEC 29.4).
 *
 * String arithmetic, and the reason it is worth a test file: every mistake it
 * can make is invisible until an extension host fails to start a server, which
 * is the one place in this project with no debugger attached. The payload
 * surviving the trip matters just as much — a worker URL that silently dropped
 * `?settings=` would start a server on defaults and validate everyone's
 * documents at the wrong level.
 */

import { describe, expect, it } from 'vitest';

import {
  NODE_SERVER_FILE,
  WORKER_SERVER_FILE,
  nodeServer,
  workerServer,
} from '../src/lsp/locate.js';
import {
  DEFAULT_SERVER_SETTINGS,
  SETTINGS_FLAG,
  settingsFromArgv,
  settingsFromQuery,
  type ServerSettings,
} from '../src/lsp/settings.js';

const STRICT: ServerSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  level: 3,
  strict: true,
  allowExternal: true,
  allowedOrigins: ['https://data.example'],
};

describe('nodeServer', () => {
  it('names the file `build:server` writes', () => {
    expect(nodeServer('/ext', DEFAULT_SERVER_SETTINGS).module).toBe(`/ext/${NODE_SERVER_FILE}`);
  });

  it('does not double the separator on a base that ends in one', () => {
    expect(nodeServer('/ext/', DEFAULT_SERVER_SETTINGS).module).toBe(`/ext/${NODE_SERVER_FILE}`);
  });

  it('joins a Windows path without inventing a mixed-up one', () => {
    // Node resolves `C:\ext/dist/server.cjs`; `C:\ext\\dist/...` it would not.
    expect(nodeServer('C:\\ext\\', DEFAULT_SERVER_SETTINGS).module).toBe(
      `C:\\ext/${NODE_SERVER_FILE}`,
    );
  });

  it('passes the payload as the flag the server reads', () => {
    const { args } = nodeServer('/ext', STRICT);
    expect(args[0]).toBe(SETTINGS_FLAG);
    expect(settingsFromArgv(args)).toEqual(STRICT);
  });
});

describe('workerServer', () => {
  it('names the file `build:web-server` writes, under the extension root', () => {
    const url = workerServer('https://host.example/ext', DEFAULT_SERVER_SETTINGS);
    expect(url.startsWith(`https://host.example/ext/${WORKER_SERVER_FILE}?`)).toBe(true);
  });

  it('round-trips the payload through the query string', () => {
    const url = workerServer('https://host.example/ext', STRICT);
    expect(settingsFromQuery(url.slice(url.indexOf('?')))).toEqual(STRICT);
  });

  it('survives a scheme `URL` would not treat as special', () => {
    // `vscode-file://` is what a desktop web host hands out, and it is exactly
    // the kind of scheme a naive `new URL(...)` round trip mangles.
    const url = workerServer('vscode-file://vscode-app/ext/', STRICT);
    expect(url.startsWith(`vscode-file://vscode-app/ext/${WORKER_SERVER_FILE}?`)).toBe(true);
    expect(settingsFromQuery(url.slice(url.indexOf('?')))).toEqual(STRICT);
  });
});

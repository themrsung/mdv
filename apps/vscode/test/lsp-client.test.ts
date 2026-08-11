/**
 * The client half of SPEC 29.4.
 *
 * `LanguageServerDiagnosticService` is pure lifecycle — it does not convert a
 * diagnostic, own a collection, or know what a document is. So this file
 * specifies the only things it can get wrong, and they are all about *when*:
 *
 *  - a settings change that moves the payload must reach the server, and the
 *    only way it can is a restart, because `@mdv/lsp` bakes its configuration in
 *    at construction;
 *  - a settings change that does not move the payload must **not** restart —
 *    a colour theme flip is one keystroke away from another, and tearing a
 *    process down for it would make the squiggles blink;
 *  - two changes a millisecond apart must not leave two servers running;
 *  - a server that refuses to start must not take the extension host with it.
 *
 * The client is a fake rather than a real `vscode-languageclient`: this
 * environment has no extension host, and the seam exists precisely so the half
 * that has the bugs can be run without one.
 */

import { describe, expect, it } from 'vitest';

import {
  CLIENT_ID,
  DIAGNOSTIC_COLLECTION,
  DID_CHANGE_CONFIGURATION,
  LanguageServerDiagnosticService,
  MDV_DOCUMENT_SELECTOR,
  clientOptions,
  samePayload,
  type LanguageClientLike,
  type MdvClientOptions,
} from '../src/lsp/client.js';
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from '../src/lsp/settings.js';
import type { MdvSettings } from '../src/settings.js';
import { DEFAULT_SETTINGS } from './fixtures.js';

/** One fake client, recording the calls the service makes on it. */
interface FakeClient extends LanguageClientLike {
  readonly payload: ServerSettings;
  readonly options: MdvClientOptions;
  readonly events: string[];
  readonly notifications: { method: string; params: unknown }[];
  running: boolean;
}

/** A factory plus the log of every client it has been asked to build. */
function fakeClients(options: { readonly failStart?: boolean } = {}): {
  readonly clients: FakeClient[];
  create: (payload: ServerSettings, opts: MdvClientOptions) => LanguageClientLike;
} {
  const clients: FakeClient[] = [];
  return {
    clients,
    create(payload, opts) {
      const client: FakeClient = {
        payload,
        options: opts,
        events: [],
        notifications: [],
        running: false,
        async start(): Promise<void> {
          client.events.push('start');
          if (options.failStart === true) throw new Error('no server on this host');
          client.running = true;
        },
        async stop(): Promise<void> {
          client.events.push('stop');
          client.running = false;
        },
        async sendNotification(method: string, params?: unknown): Promise<void> {
          client.notifications.push({ method, params });
        },
      };
      clients.push(client);
      return client;
    },
  };
}

/** A settings box the test can move under the service, like a real store. */
function settingsBox(initial: MdvSettings = DEFAULT_SETTINGS): {
  read: () => MdvSettings;
  set: (next: MdvSettings) => void;
} {
  let current = initial;
  return {
    read: () => current,
    set: (next) => {
      current = next;
    },
  };
}

const STRICTER: MdvSettings = {
  ...DEFAULT_SETTINGS,
  validate: { enable: true, level: 3, strict: true },
};

describe('clientOptions', () => {
  it('names the collection and the trace section the manifest contributes', () => {
    // SPEC 29.6 spells the setting `mdv.trace.server`; `vscode-languageclient`
    // reads `${id}.trace.server`. If the id drifts, the setting stops working
    // and nothing else breaks — which is why it is asserted here.
    expect(CLIENT_ID).toBe('mdv');
    expect(clientOptions(DEFAULT_SERVER_SETTINGS).diagnosticCollectionName).toBe(
      DIAGNOSTIC_COLLECTION,
    );
  });

  it('covers both language ids the extension activates on', () => {
    expect(MDV_DOCUMENT_SELECTOR.map((filter) => filter.language)).toEqual(['mdv', 'markdown']);
  });

  it('carries the payload into the initialize params', () => {
    expect(clientOptions(DEFAULT_SERVER_SETTINGS).initializationOptions).toEqual(
      DEFAULT_SERVER_SETTINGS,
    );
  });
});

describe('samePayload', () => {
  it('is true for a payload rebuilt from the same settings', () => {
    expect(samePayload(DEFAULT_SERVER_SETTINGS, { ...DEFAULT_SERVER_SETTINGS })).toBe(true);
  });

  it('sees a change in any of the five fields', () => {
    const moved: ServerSettings[] = [
      { ...DEFAULT_SERVER_SETTINGS, level: 3 },
      { ...DEFAULT_SERVER_SETTINGS, strict: true },
      { ...DEFAULT_SERVER_SETTINGS, allowExternal: true },
      { ...DEFAULT_SERVER_SETTINGS, attributeOrder: 'preserve' },
      { ...DEFAULT_SERVER_SETTINGS, allowedOrigins: ['https://a.example'] },
    ];
    for (const payload of moved) expect(samePayload(DEFAULT_SERVER_SETTINGS, payload)).toBe(false);
  });

  it('compares origins element-wise, not by length', () => {
    const a: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, allowedOrigins: ['https://a.example'] };
    const b: ServerSettings = { ...DEFAULT_SERVER_SETTINGS, allowedOrigins: ['https://b.example'] };
    expect(samePayload(a, b)).toBe(false);
  });
});

describe('LanguageServerDiagnosticService', () => {
  it('reports the engine the seam names', () => {
    const { create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox().read, create);
    expect(service.kind).toBe('language-server');
    service.dispose();
  });

  it('does not start a server inside the constructor', () => {
    const { clients, create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox().read, create);
    // SPEC 29.8's activation budget: the constructor queues, it does not spawn.
    expect(clients).toHaveLength(0);
    service.dispose();
  });

  it('starts one client, with the settings the store held', async () => {
    const { clients, create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox(STRICTER).read, create);
    await service.whenIdle();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.events).toEqual(['start']);
    expect(clients[0]?.payload).toEqual({ ...DEFAULT_SERVER_SETTINGS, level: 3, strict: true });
    service.dispose();
  });

  it('nudges the running server when the payload has not moved', async () => {
    const { clients, create } = fakeClients();
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, create);
    await service.whenIdle();

    // A colour theme change: the diagnostics need re-running, the settings the
    // server was built from are untouched.
    service.revalidateAll();
    await service.whenIdle();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.events).toEqual(['start']);
    expect(clients[0]?.notifications).toEqual([
      { method: DID_CHANGE_CONFIGURATION, params: { settings: DEFAULT_SERVER_SETTINGS } },
    ]);
    service.dispose();
  });

  it('restarts when the payload moves, old one first', async () => {
    const { clients, create } = fakeClients();
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, create);
    await service.whenIdle();

    box.set(STRICTER);
    service.revalidateAll();
    await service.whenIdle();

    expect(clients).toHaveLength(2);
    expect(clients[0]?.events).toEqual(['start', 'stop']);
    expect(clients[1]?.events).toEqual(['start']);
    expect(clients[1]?.payload.level).toBe(3);
    // A restart carries the settings; it does not also notify.
    expect(clients[1]?.notifications).toEqual([]);
    service.dispose();
  });

  it('leaves exactly one server running when two changes arrive together', async () => {
    const { clients, create } = fakeClients();
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, create);

    box.set(STRICTER);
    service.revalidateAll();
    box.set({
      ...DEFAULT_SETTINGS,
      security: { allowExternal: true, allowedOrigins: [], trusted: true },
    });
    service.revalidateAll();
    await service.whenIdle();

    expect(clients).toHaveLength(3);
    expect(clients.filter((client) => client.running)).toHaveLength(1);
    expect(clients[2]?.payload.allowExternal).toBe(true);
    service.dispose();
    await service.whenIdle();
    expect(clients.filter((client) => client.running)).toHaveLength(0);
  });

  it('routes a single-document revalidate through the same notification', async () => {
    const { clients, create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox().read, create);
    await service.whenIdle();

    // The seam takes a `vscode.TextDocument`; this class never reads it, and
    // this environment has no `vscode` to build one from.
    service.revalidate(undefined as never);
    await service.whenIdle();

    expect(clients[0]?.notifications.map((entry) => entry.method)).toEqual([
      DID_CHANGE_CONFIGURATION,
    ]);
    service.dispose();
  });

  it('survives a server that will not start, and tries again on the next change', async () => {
    const failing = fakeClients({ failStart: true });
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, failing.create);
    await service.whenIdle();

    expect(failing.clients).toHaveLength(1);
    expect(failing.clients[0]?.running).toBe(false);

    box.set(STRICTER);
    service.revalidateAll();
    await service.whenIdle();

    // A second client was built — and no `stop` was called on the first, which
    // never started.
    expect(failing.clients).toHaveLength(2);
    expect(failing.clients[0]?.events).toEqual(['start']);
    service.dispose();
  });

  it('stops the client, once, however many times it is disposed', async () => {
    const { clients, create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox().read, create);
    await service.whenIdle();

    service.dispose();
    service.dispose();
    await service.whenIdle();

    expect(clients[0]?.events).toEqual(['start', 'stop']);
  });

  it('ignores work queued after disposal', async () => {
    const { clients, create } = fakeClients();
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, create);
    await service.whenIdle();

    service.dispose();
    box.set(STRICTER);
    service.revalidateAll();
    await service.whenIdle();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.events).toEqual(['start', 'stop']);
  });

  it('abandons a queued restart that disposal overtook', async () => {
    const { clients, create } = fakeClients();
    const box = settingsBox();
    const service = new LanguageServerDiagnosticService(box.read, create);
    await service.whenIdle();

    box.set(STRICTER);
    service.revalidateAll();
    service.dispose();
    await service.whenIdle();

    // Starting a server in order to stop it would be the worst of both.
    expect(clients).toHaveLength(1);
    expect(clients[0]?.events).toEqual(['start', 'stop']);
  });

  it('never spawns a server when disposal beats activation', async () => {
    const { clients, create } = fakeClients();
    const service = new LanguageServerDiagnosticService(settingsBox().read, create);

    // A window closing during `activate` is ordinary, and the queued start has
    // not run yet.
    service.dispose();
    await service.whenIdle();

    expect(clients).toHaveLength(0);
  });
});

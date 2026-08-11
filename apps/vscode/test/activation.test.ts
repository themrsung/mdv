/**
 * Activation, in both hosts (SPEC 29; the exit criterion for M8).
 *
 * `extension-node.ts` and `extension-web.ts` are two entry points over one
 * `activateWith`, and the only thing that can go wrong between them is
 * disagreement: a command the web build forgets to register, a context key that
 * claims Node is available where it is not, a client configured differently on
 * one side so the two hosts report different diagnostics for the same file.
 * These tests activate the real entry points against the `vscode` double and
 * check what each one actually registered.
 *
 * What they deliberately do *not* re-check: the behaviour of the pieces.
 * `lsp-client.test.ts` owns the restart lifecycle, `markdownit.test.ts` the
 * fence renderer, `manifest.test.ts` the `package.json` side of the command
 * list. Activation owns the wiring.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';

import { DATA_SCHEME } from '../src/commands/authoring.js';
import { COMMANDS } from '../src/commands/ids.js';
import { deactivate, type MdvExtensionApi } from '../src/extension.js';
import { activate as activateNode } from '../src/extension-node.js';
import { activate as activateWeb } from '../src/extension-web.js';
import { CONTEXT_NODE_HOST } from '../src/host.js';
import { CLIENT_ID, CLIENT_NAME, DIAGNOSTIC_COLLECTION } from '../src/lsp/client.js';
import { NODE_SERVER_FILE, WORKER_SERVER_FILE } from '../src/lsp/locate.js';
import { settingsFromArgv, settingsFromQuery } from '../src/lsp/settings.js';
import type { MarkdownItLike } from '../src/markdownit.js';
import { PREVIEW_VIEW_TYPE } from '../src/preview/panel.js';
import { READER_VIEW_TYPE } from '../src/reader.js';
import { disposeAll, fakeExtensionContext } from './double/context.js';
import { TransportKind, builtClients, resetClients } from './double/languageclient.js';
import {
  UIKind,
  configurationChange,
  fire,
  host,
  recording,
  reset,
  setUserSetting,
} from './double/vscode.js';
import { installWorker, recordOf, uninstallWorker, workers } from './double/worker.js';

/** The commands `package.json` promises, in the order the id table lists them. */
const ALL_COMMANDS = Object.values(COMMANDS);

/**
 * Let the queued work run.
 *
 * `activate` has a 50 ms budget (SPEC 29.8), so it starts nothing it can defer:
 * the host context key goes out in a microtask and the language client starts
 * off the diagnostic service's promise queue. Both settle immediately here —
 * nothing does real I/O under the doubles — but they settle *after* `activate`
 * returns, which is the whole point of the arrangement.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

/** The node client's `ServerOptions`, as `nodeClientFactory` writes it. */
interface RecordedServerOptions {
  readonly run: {
    readonly module: string;
    readonly args: readonly string[];
    readonly transport: TransportKind;
  };
  readonly debug: {
    readonly module: string;
    readonly args: readonly string[];
    readonly options: { readonly execArgv: readonly string[] };
  };
}

let context: vscode.ExtensionContext | undefined;

/** Activate an entry point and arrange for it to be torn down again. */
function start(activate: (context: vscode.ExtensionContext) => MdvExtensionApi): {
  readonly context: vscode.ExtensionContext;
  readonly api: MdvExtensionApi;
} {
  const created = fakeExtensionContext();
  context = created;
  return { context: created, api: activate(created) };
}

beforeEach(() => {
  reset();
  resetClients();
});

afterEach(() => {
  if (context !== undefined) disposeAll(context);
  context = undefined;
  // The log channel is a module-level singleton, so a test that left it behind
  // would make the next one see no channel at all.
  deactivate();
  uninstallWorker();
});

describe('the desktop host', () => {
  beforeEach(() => {
    host.uiKind = UIKind.Desktop;
  });

  it('registers every command, and each of them once', () => {
    // A second registration of the same id throws in the double, exactly as it
    // does in the real host, so "once" is enforced by getting this far.
    start(activateNode);

    expect([...recording.commands.keys()].sort()).toEqual([...ALL_COMMANDS].sort());
  });

  it('opens exactly one output channel', () => {
    start(activateNode);

    expect(recording.outputChannels.map((channel) => channel.name)).toEqual(['MDV']);
  });

  it('registers the preview serializer, the reader and the data scheme', () => {
    start(activateNode);

    expect(recording.webviewSerializers.map((entry) => entry.viewType)).toEqual([
      PREVIEW_VIEW_TYPE,
    ]);
    expect(recording.customEditors.map((entry) => entry.viewType)).toEqual([READER_VIEW_TYPE]);
    expect(recording.contentProviders.map((entry) => entry.scheme)).toEqual([DATA_SCHEME]);
  });

  it('publishes the node capability so the manifest can gate on it', async () => {
    start(activateNode);
    expect(recording.contextKeys.has(CONTEXT_NODE_HOST)).toBe(false);

    await settle();

    expect(recording.contextKeys.get(CONTEXT_NODE_HOST)).toBe(true);
  });

  it('hands VS Code a markdown-it contribution straight away', () => {
    // VS Code asks for this the moment the extension resolves, before any
    // deferred work has run, so it cannot depend on the client being up.
    const { api } = start(activateNode);
    const md = fakeMarkdownIt();

    expect(api.extendMarkdownIt(md)).toBe(md);
    expect(typeof md.renderer.rules['fence']).toBe('function');
  });

  it('runs diagnostics over the language server, and only there', async () => {
    start(activateNode);
    await settle();

    // The in-process engine registers the formatter, the lenses, completion and
    // its own collection. With a server running, all four would be duplicates:
    // VS Code merges providers instead of choosing between them.
    expect(recording.formatters).toHaveLength(0);
    expect(recording.codeLensProviders).toHaveLength(0);
    expect(recording.completionProviders).toHaveLength(0);
    expect(recording.diagnosticCollections).toHaveLength(0);

    expect(builtClients).toHaveLength(1);
    expect(builtClients[0]?.host).toBe('node');
    expect(builtClients[0]?.starts).toBe(1);
  });

  it('forks the bundled CommonJS server over stdio', async () => {
    const { context: activated } = start(activateNode);
    await settle();

    const options = builtClients[0]?.serverOptions as RecordedServerOptions | undefined;
    expect(options?.run.module).toBe(`${activated.extensionPath}/${NODE_SERVER_FILE}`);
    expect(options?.run.transport).toBe(TransportKind.stdio);
    // The debug variant is the same server plus an inspector; a `run` that
    // quietly carried `--inspect` would make every normal install open a port.
    expect(options?.debug.module).toBe(options?.run.module);
    expect(options?.run).not.toHaveProperty('options');
    expect(options?.debug.options.execArgv).toContain('--nolazy');
  });

  it('tells the server the settings it read', async () => {
    setUserSetting('mdv.validate.level', 3);
    setUserSetting('mdv.validate.strict', true);
    start(activateNode);
    await settle();

    const options = builtClients[0]?.serverOptions as RecordedServerOptions | undefined;
    const payload = settingsFromArgv(options?.run.args ?? []);
    expect(payload.level).toBe(3);
    expect(payload.strict).toBe(true);
  });

  it('restarts the server when a setting the server cares about changes', async () => {
    start(activateNode);
    await settle();

    setUserSetting('mdv.validate.level', 1);
    fire.didChangeConfiguration.fire(configurationChange('mdv'));
    await settle();

    expect(builtClients).toHaveLength(2);
    expect(builtClients[0]?.stops).toBe(1);
    const restarted = builtClients[1]?.serverOptions as RecordedServerOptions | undefined;
    expect(settingsFromArgv(restarted?.run.args ?? []).level).toBe(1);
  });

  it('leaves nothing behind when the host unloads it', () => {
    const { context: activated } = start(activateNode);
    const listeners = [
      fire.didChangeConfiguration,
      fire.didGrantWorkspaceTrust,
      fire.didChangeActiveColorTheme,
      fire.didOpenTextDocument,
    ];
    expect(listeners.some((emitter) => emitter.listenerCount > 0)).toBe(true);

    disposeAll(activated);
    deactivate();
    context = undefined;

    expect([...recording.commands.keys()]).toEqual([]);
    expect(recording.watchers.every((watcher) => watcher.disposed)).toBe(true);
    for (const emitter of listeners) expect(emitter.listenerCount).toBe(0);
  });
});

describe('the web host', () => {
  beforeEach(() => {
    host.uiKind = UIKind.Web;
    installWorker();
  });

  it('registers the same commands as the desktop host', () => {
    start(activateWeb);

    expect([...recording.commands.keys()].sort()).toEqual([...ALL_COMMANDS].sort());
  });

  it('says Node is unavailable, whatever the process it happens to run in', async () => {
    // vitest runs this in Node, so `typeof process` lies. `uiKind` is the part
    // of the answer that is actually about the host, and the extension has to
    // let it win — the commands gated on `mdv.hostHasNode` are the ones that
    // would throw on a `require('node:fs')` here.
    start(activateWeb);
    await settle();

    expect(recording.contextKeys.get(CONTEXT_NODE_HOST)).toBe(false);
  });

  it('starts the server in a worker, with the payload in the script URL', async () => {
    setUserSetting('mdv.security.allowExternal', true);
    setUserSetting('mdv.security.allowedOrigins', ['https://example.test']);
    const { context: activated } = start(activateWeb);
    await settle();

    expect(builtClients).toHaveLength(1);
    expect(builtClients[0]?.host).toBe('browser');
    expect(workers).toHaveLength(1);
    expect(recordOf(builtClients[0]?.worker)).toBe(workers[0]);

    const url = new URL(workers[0]?.url ?? '');
    expect(url.pathname).toBe(`${activated.extensionUri.path}/${WORKER_SERVER_FILE}`);
    // A worker has no argv. If the query were dropped the server would start on
    // defaults, which say `allowExternal: false` - the failure would look like
    // a security rule working, not like a bug.
    const payload = settingsFromQuery(url.search);
    expect(payload.allowExternal).toBe(true);
    expect(payload.allowedOrigins).toEqual(['https://example.test']);
  });

  it('never registers the in-process providers either', async () => {
    start(activateWeb);
    await settle();

    expect(recording.formatters).toHaveLength(0);
    expect(recording.codeLensProviders).toHaveLength(0);
    expect(recording.completionProviders).toHaveLength(0);
    expect(recording.diagnosticCollections).toHaveLength(0);
  });
});

describe('both hosts', () => {
  it('configure the client identically', async () => {
    // The two hosts must disagree about transport and nothing else. Anything
    // else that differs here is a file that behaves differently in
    // `vscode.dev` than it does on a desktop, for no reason a user could see.
    host.uiKind = UIKind.Desktop;
    const desktop = start(activateNode);
    await settle();
    const desktopOptions = builtClients[0]?.clientOptions;
    disposeAll(desktop.context);
    context = undefined;
    deactivate();

    reset();
    resetClients();
    host.uiKind = UIKind.Web;
    installWorker();
    start(activateWeb);
    await settle();
    const webOptions = builtClients[0]?.clientOptions;

    expect(desktopOptions).toBeDefined();
    expect(webOptions).toEqual(desktopOptions);
  });

  it('name the same client and the same diagnostic collection', async () => {
    host.uiKind = UIKind.Desktop;
    start(activateNode);
    await settle();

    expect(builtClients[0]?.id).toBe(CLIENT_ID);
    expect(builtClients[0]?.name).toBe(CLIENT_NAME);
    expect(builtClients[0]?.clientOptions).toMatchObject({
      diagnosticCollectionName: DIAGNOSTIC_COLLECTION,
      outputChannelName: CLIENT_NAME,
    });
  });
});

/** The smallest thing `extendMarkdownIt` will accept. */
function fakeMarkdownIt(): MarkdownItLike {
  return {
    core: { ruler: { push: () => {} } },
    renderer: { rules: {} },
  };
}

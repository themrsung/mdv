/**
 * The browser half of the client (SPEC 29.4).
 *
 * `vscode-languageclient/browser` speaks LSP over `postMessage` to a `Worker`
 * the caller constructs. It never terminates that worker — not on `stop()`, not
 * on `dispose()` — so this file owns the worker's life and hands back a
 * {@link LanguageClientLike} whose `stop` really stops. A settings change is a
 * restart (see `client.ts`), so a leaked worker per restart would be a leak per
 * keystroke in the settings editor.
 *
 * The payload rides in the script URL's query string because a worker has no
 * argv; `locate.ts` builds the URL and `server-worker.ts` reads it back.
 */

import {
  LanguageClient,
  RevealOutputChannelOn,
  type LanguageClientOptions,
} from 'vscode-languageclient/browser';

import {
  CLIENT_ID,
  CLIENT_NAME,
  type LanguageClientFactory,
  type LanguageClientLike,
  type MdvClientOptions,
} from './client.js';
import { workerServer } from './locate.js';

/**
 * Build clients that spawn the web worker server bundle.
 *
 * @param extensionBase `ExtensionContext.extensionUri.toString(true)` — not
 *   encoded, because the payload appended after it is, and a doubly-encoded
 *   query is a payload the server would read back mangled.
 */
export function workerClientFactory(extensionBase: string): LanguageClientFactory {
  return (payload, options) => {
    const worker = new Worker(workerServer(extensionBase, payload), { name: CLIENT_NAME });
    const client = new LanguageClient(CLIENT_ID, CLIENT_NAME, webOptions(options), worker);
    return terminatingClient(client, worker);
  };
}

/**
 * Wrap the library's client so the worker dies with it.
 *
 * `terminate()` runs in a `finally`: a client that fails to shut down cleanly is
 * exactly the case where the worker is still running and must be killed, and
 * the caller's own error handling is watching the rejected promise.
 */
function terminatingClient(client: LanguageClientLike, worker: Worker): LanguageClientLike {
  return {
    start: () => client.start(),
    stop: async () => {
      try {
        await client.stop();
      } finally {
        worker.terminate();
      }
    },
    sendNotification: (method, params) => client.sendNotification(method, params),
  };
}

/** The twin of `nodeOptions` in `client-node.ts`; see the note there. */
function webOptions(options: MdvClientOptions): LanguageClientOptions {
  return {
    documentSelector: options.documentSelector.map((filter) => ({ language: filter.language })),
    diagnosticCollectionName: options.diagnosticCollectionName,
    outputChannelName: options.outputChannelName,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions: options.initializationOptions,
  };
}

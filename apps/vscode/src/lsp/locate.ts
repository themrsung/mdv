/**
 * Where the two server bundles live, and what to hand them (SPEC 29.4).
 *
 * `build:server` writes `dist/server.cjs` and `build:web-server` writes
 * `dist/web/server.js`. The extension has to name those files at runtime, from
 * the extension's own install location, and pass the settings payload in the
 * one channel each host offers: argv for a process, a query string for a worker.
 *
 * That is all this file does, and it does it with strings. It imports no
 * `vscode` and no `vscode-languageclient`, so both host adapters can use it and
 * so the arithmetic that is easy to get wrong — a doubled slash, a payload that
 * never made it into the URL — is testable in a plain Node process.
 */

import { serverArgv, serverQuery, type ServerSettings } from './settings.js';

/** `build:server`'s output, relative to the extension root. */
export const NODE_SERVER_FILE = 'dist/server.cjs';

/** `build:web-server`'s output, relative to the extension root. */
export const WORKER_SERVER_FILE = 'dist/web/server.js';

/** A node server, as `vscode-languageclient`'s `NodeModule` needs it named. */
export interface NodeServerLocation {
  /** Absolute path to the CommonJS bundle the client will fork. */
  readonly module: string;
  /** The payload, as argv — `server-node.ts` reads it with `settingsFromArgv`. */
  readonly args: readonly string[];
}

/**
 * The desktop server's module path and arguments.
 *
 * `extensionPath` is `vscode.ExtensionContext.extensionPath`: an absolute path
 * in the host's own notation. The join uses `/` even when that path came from
 * Windows with `\` separators, because node's resolver accepts either and
 * mixing them is only ugly, never wrong.
 */
export function nodeServer(extensionPath: string, payload: ServerSettings): NodeServerLocation {
  return { module: join(extensionPath, NODE_SERVER_FILE), args: serverArgv(payload) };
}

/**
 * The worker server's script URL, payload included.
 *
 * `extensionBase` is `vscode.ExtensionContext.extensionUri.toString()` — in
 * `vscode.dev` an `https://` URL, in a desktop web host a `vscode-file://` one.
 * The query is appended as text rather than by rebuilding a `URL`, because
 * `serverQuery` has already percent-encoded the payload and a round trip
 * through `URL` on a non-special scheme is a good way to lose it.
 *
 * A base that already carries a query is a bug rather than a case to merge: the
 * extension root is a directory.
 */
export function workerServer(extensionBase: string, payload: ServerSettings): string {
  return `${join(extensionBase, WORKER_SERVER_FILE)}?${serverQuery(payload)}`;
}

/** Join with exactly one separator, whatever the base ended with. */
function join(base: string, relative: string): string {
  return `${base.replace(/[\\/]+$/, '')}/${relative}`;
}

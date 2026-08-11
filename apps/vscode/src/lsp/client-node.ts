/**
 * The desktop half of the client (SPEC 29.4).
 *
 * `vscode-languageclient/node` forks `dist/server.cjs` and speaks LSP over the
 * child's stdio — which is why `server-node.ts` keeps `console.log` out of that
 * process and logs to `stderr` instead. The fork happens lazily: constructing
 * the client spawns nothing, `start()` does, and that is what lets
 * {@link LanguageServerDiagnosticService} build a client it may never start.
 *
 * This file and `client-web.ts` are the only two modules in the extension that
 * import `vscode-languageclient`, and they are never in the same bundle:
 * `build:extension` reaches this one, `build:web` reaches the other. Everything
 * they disagree about is here; everything they must agree about is in
 * `client.ts`.
 */

import {
  LanguageClient,
  RevealOutputChannelOn,
  TransportKind,
  type LanguageClientOptions,
  type ServerOptions,
} from 'vscode-languageclient/node';

import {
  CLIENT_ID,
  CLIENT_NAME,
  type LanguageClientFactory,
  type MdvClientOptions,
} from './client.js';
import { nodeServer } from './locate.js';

/**
 * The debug server's extra node flags.
 *
 * `--nolazy` makes breakpoints in the bundle bind before the code runs;
 * `--inspect` picks the port `.vscode/launch.json` attaches to. The `run`
 * variant carries neither, so a normal install never opens a port.
 */
const DEBUG_EXEC_ARGV: readonly string[] = Object.freeze(['--nolazy', '--inspect=6009']);

/**
 * Build clients that fork the CommonJS server bundle.
 *
 * @param extensionPath `ExtensionContext.extensionPath` — the absolute
 *   directory the extension was installed into, in the host's own notation.
 */
export function nodeClientFactory(extensionPath: string): LanguageClientFactory {
  return (payload, options) => {
    const located = nodeServer(extensionPath, payload);
    const run = {
      module: located.module,
      args: [...located.args],
      transport: TransportKind.stdio,
    };
    const serverOptions: ServerOptions = {
      run,
      debug: { ...run, options: { execArgv: [...DEBUG_EXEC_ARGV] } },
    };
    return new LanguageClient(CLIENT_ID, CLIENT_NAME, serverOptions, nodeOptions(options));
  };
}

/**
 * The shared options, widened into the library's own shape.
 *
 * `client-web.ts` has the twin of this function rather than sharing it: the
 * only line that differs is `RevealOutputChannelOn`, an enum whose value would
 * have to come from one of the two host entries, and importing `/node` from the
 * web bundle to reach a number is exactly the mistake this split exists to
 * prevent.
 */
function nodeOptions(options: MdvClientOptions): LanguageClientOptions {
  return {
    documentSelector: options.documentSelector.map((filter) => ({ language: filter.language })),
    diagnosticCollectionName: options.diagnosticCollectionName,
    outputChannelName: options.outputChannelName,
    // The extension's own channel is where a user looks for MDV; a server that
    // stole focus on every parse error would make the editor unusable.
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    initializationOptions: options.initializationOptions,
  };
}

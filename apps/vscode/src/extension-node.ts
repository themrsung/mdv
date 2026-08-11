/**
 * The desktop extension entry point (SPEC 29.4).
 *
 * `build:extension` bundles this file into `dist/extension.js`, which
 * `package.json`'s `main` names. It exists only to choose a client: everything
 * else is in `extension.ts`, which is host-agnostic and imports neither half of
 * `vscode-languageclient`.
 *
 * Two entries rather than one branch inside a shared entry, because the branch
 * would not survive bundling — esbuild follows every import it can see, so a
 * single entry that could reach `client-node.ts` would put `node:child_process`
 * in the web bundle no matter which way the branch fell at runtime.
 */

import type * as vscode from 'vscode';

import { activateWith, type MdvExtensionApi } from './extension.js';
import { nodeClientFactory } from './lsp/client-node.js';

/** Called by VS Code on `onLanguage:mdv` or `onLanguage:markdown`. */
export function activate(context: vscode.ExtensionContext): MdvExtensionApi {
  // `extensionPath`, not `extensionUri`: the client forks a file by path.
  return activateWith(context, nodeClientFactory(context.extensionPath));
}

export { deactivate } from './extension.js';

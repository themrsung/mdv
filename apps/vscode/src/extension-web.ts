/**
 * The browser extension entry point (SPEC 29.4).
 *
 * `build:web` bundles this file into `dist/web/extension.js`, which
 * `package.json`'s `browser` names. The twin of `extension-node.ts`; see the
 * note there for why the choice is made by the entry and not by a branch.
 */

import type * as vscode from 'vscode';

import { activateWith, type MdvExtensionApi } from './extension.js';
import { workerClientFactory } from './lsp/client-web.js';

/** Called by VS Code on `onLanguage:mdv` or `onLanguage:markdown`. */
export function activate(context: vscode.ExtensionContext): MdvExtensionApi {
  // `toString(true)` skips encoding: the worker URL appends an already-encoded
  // query, and encoding the base again would encode that query's `%` signs too.
  return activateWith(context, workerClientFactory(context.extensionUri.toString(true)));
}

export { deactivate } from './extension.js';

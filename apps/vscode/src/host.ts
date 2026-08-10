/**
 * Host capability gating (SPEC 29.1, 29.8).
 *
 * The extension runs in two places: the desktop host, where Node is available,
 * and `vscode.dev`, where it is not. SPEC 29.8 requires the Node-only features
 * (PDF export, writing beside the source file) to be **hidden** by a `when`
 * clause rather than to fail when invoked, so the same context keys that gate
 * the commands in `package.json` are set here, once, at activation.
 */

import * as vscode from 'vscode';

/** What this host can actually do. */
export interface HostCapabilities {
  /** `false` in a browser host: no `fs`, no `pdf-lib`, no child processes. */
  readonly node: boolean;
  /** Whether the workspace is trusted; gates `mdv.security.*` (SPEC 29.6). */
  readonly trusted: boolean;
}

/**
 * `vscode.env.uiKind === UIKind.Desktop` is necessary but not sufficient: a
 * desktop *UI* can still be driving a web extension host. Probing for `process`
 * is the check that actually answers "can I require `node:fs`".
 */
export function detectHost(): HostCapabilities {
  const desktop = vscode.env.uiKind === vscode.UIKind.Desktop;
  const hasProcess =
    typeof process !== 'undefined' &&
    typeof process.versions === 'object' &&
    typeof process.versions.node === 'string';
  return { node: desktop && hasProcess, trusted: vscode.workspace.isTrusted };
}

/** Context keys read by the `when` clauses in `package.json`. */
export const CONTEXT_NODE_HOST = 'mdv.hostHasNode';

/** Publish the capability context keys. Cheap; safe to call again on change. */
export async function publishHostContext(host: HostCapabilities): Promise<void> {
  await vscode.commands.executeCommand('setContext', CONTEXT_NODE_HOST, host.node);
}

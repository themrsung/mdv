/**
 * The one place the logger touches VS Code.
 *
 * `log.ts` is deliberately host-free so the pipeline and the markdown-it
 * integration can be tested in a plain Node process; this file supplies the
 * {@link LogSink} that makes those log lines actually appear in the **MDV**
 * output channel, and turns a failed command into a notification with a
 * "Show Log" button.
 */

import * as vscode from 'vscode';

import { setLogSink } from './log.js';

/** Created once in `activate`, disposed with the extension. */
let channel: vscode.OutputChannel | undefined;

/** Idempotent: `activate` calls it, everything else just uses `log`. */
export function createLogChannel(): vscode.OutputChannel {
  if (channel !== undefined) return channel;
  const created = vscode.window.createOutputChannel('MDV');
  channel = created;
  setLogSink({
    append(line: string): void {
      created.appendLine(line);
    },
    report(context: string, detail: string): void {
      void vscode.window.showErrorMessage(`MDV: ${context} failed — ${detail}`, 'Show Log').then(
        (choice) => {
          if (choice === 'Show Log') created.show(true);
        },
        () => {
          /* the notification itself failing is not worth another notification */
        },
      );
    },
  });
  return created;
}

/** Release the channel. Called from `deactivate` and by the disposable. */
export function disposeLogChannel(): void {
  setLogSink(undefined);
  channel?.dispose();
  channel = undefined;
}

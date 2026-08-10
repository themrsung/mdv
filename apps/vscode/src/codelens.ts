/**
 * Code lenses above each visual block (SPEC 29.4: "`Preview` · `Export PNG` ·
 * `Export SVG` · `Show data`").
 *
 * SPEC 29.4 assigns these to the language server. The server is not implemented
 * in this tree, so they are computed in-process from the same pipeline the
 * preview uses — which means they are exact rather than regex-guessed, and they
 * cost nothing extra because the pipeline's parse is already memoised for this
 * document.
 *
 * `mdv.codeLens.enable` is honoured by registering or disposing the provider,
 * not by returning an empty array: a provider that is registered and always
 * silent still makes VS Code ask on every scroll.
 *
 * `Export PNG` is deliberately absent from the lens row: PNG export is not
 * implemented in this build (see `commands/exports.ts`), and offering a lens
 * that only ever explains itself is worse than not offering it.
 */

import * as vscode from 'vscode';
import { logError } from './log.js';
import type { SettingsStore } from './settings.js';
import type { PipelineStore } from './documents.js';
import { isPreviewable, MDV_LANGUAGE } from './documents.js';
import { inputsFor } from './commands/blocks.js';
import { COMMANDS } from './commands/index.js';

class MdvCodeLensProvider implements vscode.CodeLensProvider {
  readonly #settings: SettingsStore;
  readonly #pipelines: PipelineStore;
  readonly #emitter = new vscode.EventEmitter<void>();

  readonly onDidChangeCodeLenses = this.#emitter.event;

  constructor(settings: SettingsStore, pipelines: PipelineStore) {
    this.#settings = settings;
    this.#pipelines = pipelines;
  }

  async provideCodeLenses(
    document: vscode.TextDocument,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeLens[]> {
    if (!this.#settings.current.codeLens.enable) return [];
    if (!isPreviewable(document)) return [];
    try {
      const result = await this.#pipelines
        .get(document.uri)
        .run(inputsFor(document, this.#settings));
      if (token.isCancellationRequested) return [];

      const lenses: vscode.CodeLens[] = [];
      for (const block of result.blocks) {
        const line = Math.min(block.startLine, Math.max(0, document.lineCount - 1));
        const range = new vscode.Range(line, 0, line, 0);
        lenses.push(
          new vscode.CodeLens(range, {
            title: 'Preview',
            command: COMMANDS.showPreviewToSide,
            tooltip: `Preview ${block.blockType}`,
          }),
          new vscode.CodeLens(range, {
            title: 'Export SVG',
            command: COMMANDS.exportBlock,
            tooltip: 'Write this block to an .svg file',
          }),
          new vscode.CodeLens(range, {
            title: 'Show data',
            command: COMMANDS.showData,
            tooltip: 'Open the resolved table for this block',
          }),
        );
      }
      return lenses;
    } catch (error) {
      logError(`code lenses for ${document.uri.toString()}`, error);
      return [];
    }
  }

  refresh(): void {
    this.#emitter.fire();
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}

/** Register the provider, following `mdv.codeLens.enable`. */
export function registerCodeLens(
  settings: SettingsStore,
  pipelines: PipelineStore,
): vscode.Disposable {
  const provider = new MdvCodeLensProvider(settings, pipelines);
  let registration: vscode.Disposable | undefined;

  const sync = (): void => {
    if (settings.current.codeLens.enable && registration === undefined) {
      registration = vscode.languages.registerCodeLensProvider(
        [{ language: MDV_LANGUAGE }],
        provider,
      );
    } else if (!settings.current.codeLens.enable && registration !== undefined) {
      registration.dispose();
      registration = undefined;
    }
    provider.refresh();
  };
  sync();

  const listener = settings.onDidChange(sync);
  return new vscode.Disposable(() => {
    listener.dispose();
    registration?.dispose();
    provider.dispose();
  });
}

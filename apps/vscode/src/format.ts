/**
 * Document formatting (SPEC 29.4's "Formatting" row, SPEC 27).
 *
 * `@mdv/parser`'s `toMarkdown` is the canonical formatter, and it is
 * round-trip-tested in that package — so this file is nothing but the VS Code
 * adapter for it. Two settings are honoured:
 *
 * - `mdv.format.enable` decides whether the provider is registered at all, so
 *   turning it off actually removes MDV from the "Format Document" menu rather
 *   than making it a no-op.
 * - `mdv.format.attributeOrder` maps onto `FormatOptions.canonicalAttrOrder`:
 *   `canonical` → `true`, `preserve` → `false`. `alphabetical` has no
 *   `FormatOptions` counterpart in this tree; it degrades to `canonical` (whose
 *   order *is* "a fixed order, then alphabetical") and says so once in the log,
 *   rather than silently doing something else.
 *
 * Formatting is a whole-document replace. `toMarkdown` is idempotent and MUST
 * NOT change the resolved AST (SPEC 27), so a no-op format returns no edits —
 * checked here, because an editor that reports a dirty buffer after formatting
 * an already-formatted file is a bug the user will feel.
 */

import * as vscode from 'vscode';
import type { FormatOptions } from '@mdv/parser';
import { parse, toMarkdown } from '@mdv/parser';
import { log, logError } from './log.js';
import type { SettingsStore } from './settings.js';
import { isPreviewable, MDV_LANGUAGE } from './documents.js';

let warnedAboutAlphabetical = false;

function formatOptions(order: 'canonical' | 'alphabetical' | 'preserve'): FormatOptions {
  if (order === 'alphabetical' && !warnedAboutAlphabetical) {
    warnedAboutAlphabetical = true;
    log(
      'mdv.format.attributeOrder="alphabetical" is not distinct from "canonical" in this build; ' +
        'the canonical order is a fixed prefix followed by alphabetical.',
    );
  }
  return { canonicalAttrOrder: order !== 'preserve' };
}

class MdvFormatter implements vscode.DocumentFormattingEditProvider {
  readonly #settings: SettingsStore;

  constructor(settings: SettingsStore) {
    this.#settings = settings;
  }

  provideDocumentFormattingEdits(
    document: vscode.TextDocument,
    _options: vscode.FormattingOptions,
    token: vscode.CancellationToken,
  ): vscode.TextEdit[] {
    if (!this.#settings.current.format.enable) return [];
    if (!isPreviewable(document)) return [];
    const source = document.getText();
    try {
      const formatted = toMarkdown(
        parse(source),
        formatOptions(this.#settings.current.format.attributeOrder),
      );
      if (token.isCancellationRequested) return [];
      if (formatted === source) return [];
      const whole = new vscode.Range(
        document.positionAt(0),
        document.positionAt(source.length),
      );
      return [vscode.TextEdit.replace(whole, formatted)];
    } catch (error) {
      // A formatter that mangles a file is far worse than one that declines.
      logError(`format ${document.uri.toString()}`, error);
      return [];
    }
  }
}

/**
 * Register the formatter, and re-register it when `mdv.format.enable` flips.
 *
 * The provider is genuinely added and removed rather than left registered and
 * inert, so `editor.formatOnSave` does not silently pick MDV as the formatter
 * for a document the user asked it not to touch.
 */
export function registerFormatter(settings: SettingsStore): vscode.Disposable {
  let registration: vscode.Disposable | undefined;

  const sync = (): void => {
    const wanted = settings.current.format.enable;
    if (wanted && registration === undefined) {
      registration = vscode.languages.registerDocumentFormattingEditProvider(
        [{ language: MDV_LANGUAGE }],
        new MdvFormatter(settings),
      );
    } else if (!wanted && registration !== undefined) {
      registration.dispose();
      registration = undefined;
    }
  };
  sync();

  const listener = settings.onDidChange(sync);
  return new vscode.Disposable(() => {
    listener.dispose();
    registration?.dispose();
    registration = undefined;
  });
}

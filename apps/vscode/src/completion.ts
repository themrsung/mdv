/**
 * Completion inside a visual block (part of SPEC 29.4's "Completion" row).
 *
 * The full row is the language server's: block types, attribute keys valid for
 * the current type, enum values, column names, `@dataset` ids, theme tokens and
 * format presets. The server is not implemented here, so this provider covers
 * the three that need no schema plumbing and are the most useful while typing:
 *
 * 1. **Block types** right after ``` ```mdv ```, from the live chart registry —
 *    so a type a plugin registered would appear automatically.
 * 2. **Channel names** at the start of a header line, from the chart type's own
 *    `channels` declaration, with its one-line `doc` as the detail.
 * 3. **Column names** after a channel key, read from the block's own data
 *    section or its referenced dataset — this is the interesting one, and it is
 *    what `mdv.completion.columnNames` turns off.
 *
 * Everything else in that row (attribute keys from the JSON Schema, enum values,
 * hover, signature help) is honestly absent rather than approximated: guessing
 * at a schema the LSP would read exactly would produce completions that are
 * subtly wrong, which is worse than none.
 */

import * as vscode from 'vscode';
import { logError } from './log.js';
import type { SettingsStore } from './settings.js';
import type { PipelineStore } from './documents.js';
import { isPreviewable, MDV_LANGUAGE } from './documents.js';
import { chartRegistry, registeredTypes } from './pipeline/index.js';
import { inputsFor, blockAtLine } from './commands/blocks.js';

/** The info string of the fence that opens the block containing `line`. */
function fenceInfoAbove(
  document: vscode.TextDocument,
  line: number,
): { line: number; info: string } | undefined {
  for (let n = line; n >= 0; n -= 1) {
    const text = document.lineAt(n).text;
    const match = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*(.*)$/.exec(text);
    if (match === null) continue;
    const info = (match[1] ?? '').trim();
    if (info.length === 0) return undefined; // a closing fence: we are outside a block
    if (/^mdv\b/.test(info)) return { line: n, info };
    return undefined;
  }
  return undefined;
}

/** `true` when `line` is in the header section (before the `---` separator). */
function inHeader(document: vscode.TextDocument, fenceLine: number, line: number): boolean {
  for (let n = fenceLine + 1; n < line; n += 1) {
    if (document.lineAt(n).text.trimEnd() === '---') return false;
  }
  return true;
}

class MdvCompletionProvider implements vscode.CompletionItemProvider {
  readonly #settings: SettingsStore;
  readonly #pipelines: PipelineStore;

  constructor(settings: SettingsStore, pipelines: PipelineStore) {
    this.#settings = settings;
    this.#pipelines = pipelines;
  }

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.CompletionItem[]> {
    if (!isPreviewable(document)) return [];
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);

    // ── 1. Block types on the fence line itself ─────────────────────────────
    const fenceHere = /^[ \t]{0,3}(?:`{3,}|~{3,})[ \t]*mdv[ \t]+([A-Za-z0-9-]*)$/.exec(linePrefix);
    if (fenceHere !== null) {
      return registeredTypes().map((type) => {
        const item = new vscode.CompletionItem(type.name, vscode.CompletionItemKind.Class);
        item.detail = `level ${String(type.level)} · ${type.family}`;
        item.documentation = new vscode.MarkdownString(
          type.channels.map((channel) => `- \`${channel.name}\` — ${channel.doc}`).join('\n'),
        );
        return item;
      });
    }

    const fence = fenceInfoAbove(document, position.line - 1);
    if (fence === undefined) return [];
    if (!inHeader(document, fence.line, position.line)) return [];

    const blockType = (
      /^mdv[ \t]+([A-Za-z][A-Za-z0-9-]*)/.exec(fence.info)?.[1] ?? ''
    ).toLowerCase();
    const chartType = blockType.length > 0 ? chartRegistry().get(blockType) : undefined;

    // ── 2. Channel keys at the start of a header line ───────────────────────
    if (/^[ \t]*[A-Za-z-]*$/.test(linePrefix)) {
      if (chartType === undefined) return [];
      return chartType.channels.map((channel) => {
        const item = new vscode.CompletionItem(channel.name, vscode.CompletionItemKind.Property);
        item.detail = channel.required ? 'required' : 'optional';
        item.documentation = new vscode.MarkdownString(channel.doc);
        item.insertText = new vscode.SnippetString(`${channel.name}: $0`);
        return item;
      });
    }

    // ── 3. Column names after a channel key ─────────────────────────────────
    if (!this.#settings.current.completion.columnNames) return [];
    const afterKey =
      /^[ \t]*([A-Za-z][A-Za-z0-9_-]*)[ \t]*:[ \t]*(?:\[[^\]]*)?[A-Za-z0-9_-]*$/.exec(linePrefix);
    if (afterKey === null) return [];
    const key = afterKey[1];
    if (key === undefined) return [];
    if (chartType !== undefined && !chartType.channels.some((c) => c.name === key)) return [];

    try {
      const pipeline = this.#pipelines.get(document.uri);
      const result = await pipeline.run(inputsFor(document, this.#settings));
      if (token.isCancellationRequested) return [];
      const block = blockAtLine(result.blocks, fence.line);
      if (block === undefined) return [];
      const data = pipeline.tables.find((entry) => entry.index === block.index);
      if (data === undefined) return [];

      return data.table.fields.map((field) => {
        const item = new vscode.CompletionItem(field.name, vscode.CompletionItemKind.Field);
        item.detail = field.type;
        item.documentation = new vscode.MarkdownString(
          `Column \`${field.name}\` — inferred type \`${field.type}\`, ` +
            `${String(data.table.rows.length)} row(s)`,
        );
        return item;
      });
    } catch (error) {
      logError(`completion for ${document.uri.toString()}`, error);
      return [];
    }
  }
}

export function registerCompletion(
  settings: SettingsStore,
  pipelines: PipelineStore,
): vscode.Disposable {
  return vscode.languages.registerCompletionItemProvider(
    [{ language: MDV_LANGUAGE }],
    new MdvCompletionProvider(settings, pipelines),
    // Trigger on the two characters that begin a value and a key respectively.
    ':',
    ' ',
  );
}

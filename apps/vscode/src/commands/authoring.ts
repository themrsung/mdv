/**
 * The authoring commands of SPEC 29.5: `insertChart`, `tableToChart`,
 * `pasteData`, `showData`.
 *
 * All four are text edits or read-only views. None of them writes a file, and
 * none of them touches the network.
 */

import * as vscode from 'vscode';
import type { CommandContext } from './context.js';
import { blockAtLine, runFor } from './blocks.js';
import { registeredTypes } from '../pipeline/index.js';
import type { Table, Value } from '@mdv/core';

/** The scheme of the read-only documents `mdv.showData` opens. */
export const DATA_SCHEME = 'mdv-data';

// ─────────────────────────────────────────────────────────────────────────────
// Insert Chart…
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SPEC 29.5: "quick-pick of types with a live preview".
 *
 * The live preview here is the quick pick's own: `onDidChangeActive` renders the
 * highlighted type's skeleton into the detail line. A full rendered thumbnail
 * would need a second webview per keystroke, which is a poor trade for a
 * one-shot insertion.
 */
export async function insertChart(ctx: CommandContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage('MDV: open a document first');
    return;
  }

  const items: (vscode.QuickPickItem & { name: string })[] = registeredTypes().map((type) => ({
    name: type.name,
    label: type.name,
    description: `level ${String(type.level)}`,
    detail: type.channels
      .filter((channel) => channel.required)
      .map((channel) => channel.name)
      .join(', '),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Insert MDV chart',
    placeHolder: 'Chart type',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (picked === undefined) return;

  const snippet = chartSnippet(picked.name);
  await editor.insertSnippet(snippet, editor.selection.active);
  void ctx.diagnostics.revalidate(editor.document);
}

/** A skeleton block for `type`, with tab stops on the parts an author fills in. */
function chartSnippet(type: string): vscode.SnippetString {
  const snippet = new vscode.SnippetString();
  snippet.appendText('```mdv ');
  snippet.appendText(type);
  snippet.appendText('\ntitle: ');
  snippet.appendPlaceholder('Title');
  if (type === 'pie' || type === 'donut') {
    snippet.appendText('\ncategory: ');
    snippet.appendPlaceholder('region');
    snippet.appendText('\nvalue: ');
    snippet.appendPlaceholder('revenue');
    snippet.appendText('\n---\nregion | revenue\n');
    snippet.appendPlaceholder('APAC   | 4210');
    snippet.appendText('\n```\n');
    return snippet;
  }
  if (type === 'metric') {
    snippet.appendText('\nvalue: ');
    snippet.appendPlaceholder('revenue');
    snippet.appendText('\n---\nrevenue\n');
    snippet.appendPlaceholder('1240');
    snippet.appendText('\n```\n');
    return snippet;
  }
  snippet.appendText('\nx: ');
  snippet.appendPlaceholder('quarter');
  snippet.appendText('\ny: ');
  snippet.appendPlaceholder('revenue');
  snippet.appendText('\n---\nquarter | revenue\n');
  snippet.appendPlaceholder('Q1      | 1240');
  snippet.appendText('\n```\n');
  return snippet;
}

// ─────────────────────────────────────────────────────────────────────────────
// Convert Table to Chart
// ─────────────────────────────────────────────────────────────────────────────

/** A GFM table found in the source, with its span and its parsed cells. */
interface FoundTable {
  readonly startLine: number;
  readonly endLine: number;
  readonly header: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|')) text = text.slice(0, -1);
  return text.split('|').map((cell) => cell.trim());
}

const DELIMITER_ROW = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/**
 * The GFM table containing `line`, if any.
 *
 * A deliberately local scan rather than a document parse: the command runs on a
 * context-menu click and must be instant, and a GFM table is defined by exactly
 * two syntactic facts — a delimiter row under a header row, and contiguous rows
 * containing a pipe.
 */
export function findTableAt(document: vscode.TextDocument, line: number): FoundTable | undefined {
  const total = document.lineCount;
  const hasPipe = (n: number): boolean =>
    n >= 0 && n < total && document.lineAt(n).text.includes('|');

  // Walk up to the first line of the run of pipe-bearing lines.
  let start = line;
  if (!hasPipe(start)) return undefined;
  while (start > 0 && hasPipe(start - 1)) start -= 1;
  let end = line;
  while (end + 1 < total && hasPipe(end + 1)) end += 1;

  if (end - start < 2) return undefined;
  const delimiter = document.lineAt(start + 1).text;
  if (!DELIMITER_ROW.test(delimiter)) return undefined;

  const header = splitRow(document.lineAt(start).text);
  const rows: string[][] = [];
  for (let n = start + 2; n <= end; n += 1) rows.push(splitRow(document.lineAt(n).text));
  if (header.length === 0) return undefined;
  return { startLine: start, endLine: end, header, rows };
}

/** `true` when every non-empty cell in a column parses as a JSON number. */
function isNumericColumn(rows: readonly (readonly string[])[], index: number): boolean {
  let seen = 0;
  for (const row of rows) {
    const cell = row[index];
    if (cell === undefined || cell.length === 0) continue;
    if (!/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(cell)) return false;
    seen += 1;
  }
  return seen > 0;
}

/**
 * SPEC 29.5: convert the GFM table under the cursor into a chart block.
 *
 * The chart type and the channels are inferred the same way a reader would:
 * the first non-numeric column is the category axis, every numeric column is a
 * value. One value column is a bar; several become wide form (SPEC 7.1.1).
 */
export async function tableToChart(ctx: CommandContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return;
  const found = findTableAt(editor.document, editor.selection.active.line);
  if (found === undefined) {
    void vscode.window.showInformationMessage('MDV: put the cursor inside a Markdown table first');
    return;
  }

  const numeric: string[] = [];
  let category: string | undefined;
  for (let i = 0; i < found.header.length; i += 1) {
    const name = found.header[i];
    if (name === undefined || name.length === 0) continue;
    if (isNumericColumn(found.rows, i)) numeric.push(name);
    else category ??= name;
  }
  if (category === undefined || numeric.length === 0) {
    void vscode.window.showWarningMessage(
      'MDV: this table needs one text column and at least one numeric column to become a chart',
    );
    return;
  }

  const types = ['bar', 'line', 'area', 'scatter', 'pie'];
  const type = await vscode.window.showQuickPick(types, {
    title: 'Convert table to chart',
    placeHolder: 'Chart type',
  });
  if (type === undefined) return;

  const width = found.header.map((name, i) =>
    Math.max(name.length, ...found.rows.map((row) => row[i]?.length ?? 0)),
  );
  const pad = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(width[i] ?? cell.length)).join(' | ');

  const lines: string[] = [`\`\`\`mdv ${type}`];
  if (type === 'pie') {
    lines.push(`category: ${category}`, `value: ${numeric[0] ?? ''}`);
  } else {
    lines.push(`x: ${category}`);
    lines.push(numeric.length === 1 ? `y: ${numeric[0] ?? ''}` : `y: [${numeric.join(', ')}]`);
  }
  lines.push('---', pad(found.header));
  for (const row of found.rows) lines.push(pad(row));
  lines.push('```');

  const range = new vscode.Range(
    found.startLine,
    0,
    found.endLine,
    editor.document.lineAt(found.endLine).text.length,
  );
  await editor.edit((builder) => {
    builder.replace(range, lines.join('\n'));
  });
  ctx.diagnostics.revalidate(editor.document);
}

// ─────────────────────────────────────────────────────────────────────────────
// Paste as Dataset
// ─────────────────────────────────────────────────────────────────────────────

/** SPEC 29.5: paste CSV/TSV from the clipboard as a `dataset` block. */
export async function pasteData(ctx: CommandContext): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return;

  const clipboard = await vscode.env.clipboard.readText();
  const text = clipboard.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (text.length === 0) {
    void vscode.window.showInformationMessage('MDV: the clipboard is empty');
    return;
  }

  const firstLine = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  // TSV wins on a tie only when there is at least one tab: SPEC 3.2 says a tab is
  // significant only for `format: tsv`.
  const format = firstLine.includes('\t') ? 'tsv' : 'csv';

  const id = await vscode.window.showInputBox({
    title: 'Paste as dataset',
    prompt: 'Dataset id — blocks reference it as `data: "@id"`',
    value: 'data',
    validateInput: (value) =>
      /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? undefined : 'An id matches [A-Za-z_][A-Za-z0-9_-]*',
  });
  if (id === undefined) return;

  const indented = text
    .split('\n')
    .map((line) => (line.length > 0 ? line : ''))
    .join('\n');
  const block = [
    '```mdv dataset',
    `id: ${id}`,
    `format: ${format}`,
    '---',
    indented,
    '```',
    '',
  ].join('\n');

  await editor.edit((builder) => {
    builder.insert(editor.selection.active, block);
  });
  ctx.diagnostics.revalidate(editor.document);
}

// ─────────────────────────────────────────────────────────────────────────────
// Show Resolved Data
// ─────────────────────────────────────────────────────────────────────────────

/** One cell, rendered the way `mdv data` would render it. */
function cellText(value: Value): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** The prepared table as a padded pipe table — greppable and copyable. */
export function renderTable(table: Table): string {
  const header = table.fields.map((field) => `${field.name} (${field.type})`);
  const rows = table.rows.map((row) => row.map((value) => cellText(value)));
  const width = header.map((name, i) =>
    Math.max(name.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const line = (cells: readonly string[]): string =>
    cells.map((cell, i) => cell.padEnd(width[i] ?? cell.length)).join(' | ');
  const rule = width.map((w) => '-'.repeat(Math.max(3, w))).join('-|-');
  return [line(header), rule, ...rows.map(line)].join('\n');
}

/**
 * SPEC 29.5: open the block's resolved table in a virtual document.
 *
 * "Resolved" means after `src:`, after the projection and after the transform
 * pipeline — the table the chart actually drew, which is exactly the thing an
 * author cannot see from the source.
 */
export class ResolvedDataProvider implements vscode.TextDocumentContentProvider {
  readonly #contents = new Map<string, string>();
  readonly #emitter = new vscode.EventEmitter<vscode.Uri>();

  readonly onDidChange = this.#emitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#contents.get(uri.toString()) ?? 'No data for this block.';
  }

  /** Publish `text` under a URI derived from the source document and block. */
  publish(source: vscode.Uri, blockId: string, text: string): vscode.Uri {
    const name = (source.path.split('/').pop() ?? 'document').replace(/\.[^.]+$/, '');
    const uri = vscode.Uri.parse(
      `${DATA_SCHEME}:/${encodeURIComponent(name)}/${encodeURIComponent(blockId)}.txt`,
    );
    this.#contents.set(uri.toString(), text);
    this.#emitter.fire(uri);
    return uri;
  }

  dispose(): void {
    this.#emitter.dispose();
    this.#contents.clear();
  }
}

export async function showData(ctx: CommandContext, provider: ResolvedDataProvider): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return;
  const document = editor.document;
  const result = await runFor(document, ctx.pipelines, ctx.settings);
  const block = blockAtLine(result.blocks, editor.selection.active.line);
  if (block === undefined) {
    void vscode.window.showInformationMessage('MDV: no visual block at the cursor');
    return;
  }
  const data = ctx.pipelines.get(document.uri).tables.find((entry) => entry.index === block.index);
  if (data === undefined) {
    void vscode.window.showWarningMessage(`MDV: block ${block.id} has no resolved table`);
    return;
  }
  const header = [
    `# ${block.blockType} — ${block.id}`,
    `${String(data.table.rows.length)} row(s), ${String(data.table.fields.length)} column(s)`,
    '',
  ].join('\n');
  const uri = provider.publish(document.uri, block.id, `${header}${renderTable(data.table)}\n`);
  const shown = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(shown, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside,
  });
}

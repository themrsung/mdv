/**
 * Locating the visual block at (or nearest to) the cursor.
 *
 * Several commands need it — `Export Block as Image`, `Show Resolved Data`,
 * `Convert Table to Chart` — and all of them should agree about what "this
 * block" means, so the rule lives in one place: the block whose source span
 * contains the cursor line, else the last block that starts before it, else the
 * first block in the document.
 */

import type * as vscode from 'vscode';
import type { PipelineStore } from '../documents.js';
import type { PipelineInputs, PipelineResult, RenderedBlock } from '../pipeline/index.js';
import { themeNameFor } from '../pipeline/index.js';
import type { SettingsStore } from '../settings.js';
import { editorKind } from '../preview/panel.js';

/** Build the pipeline inputs a command should use for `document`. */
export function inputsFor(
  document: vscode.TextDocument,
  settings: SettingsStore,
  width = 720,
): PipelineInputs {
  const current = settings.current;
  return {
    source: document.getText(),
    uri: document.uri.toString(),
    width,
    theme: themeNameFor(current.preview.theme, editorKind()),
    level: current.validate.level,
    strict: current.validate.strict,
    allowExternal: current.security.allowExternal,
    allowedOrigins: current.security.allowedOrigins,
  };
}

/** Run the pipeline for a command, reusing the document's memoised stages. */
export async function runFor(
  document: vscode.TextDocument,
  pipelines: PipelineStore,
  settings: SettingsStore,
  width = 720,
): Promise<PipelineResult> {
  return pipelines.get(document.uri).run(inputsFor(document, settings, width));
}

/** The block at `line`, by the rule in this module's header. */
export function blockAtLine(
  blocks: readonly RenderedBlock[],
  line: number,
): RenderedBlock | undefined {
  let before: RenderedBlock | undefined;
  for (const block of blocks) {
    if (line >= block.startLine && line <= block.endLine) return block;
    if (block.startLine <= line) before = block;
  }
  return before ?? blocks[0];
}

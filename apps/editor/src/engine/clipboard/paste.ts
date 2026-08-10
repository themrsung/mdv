/**
 * Paste.
 *
 * Choosing the flavour is most of the job, and the order is not negotiable:
 *
 * 1. **`text/x-mdv`** — our own source. Exact, so nothing else is considered.
 * 2. **`text/html`** — everyone else's rich text, put through the normaliser.
 * 3. **`text/plain`** — literal text, *not* parsed as markdown unless asked.
 *
 * The last point is the one people get wrong. Pasting `a_b_c` from a terminal
 * should produce `a_b_c`, not `a<em>b</em>c`. Markdown parsing on paste is a
 * separate, explicit gesture — `parseMarkdown: true`, wired to "Paste as
 * Markdown" — and never the default.
 *
 * Where the caret is matters too. Pasting a table into a table pastes *cells*,
 * growing the target as needed, rather than nesting a table inside a cell.
 */

import type { Block } from '../model.js';
import type { IdFactory } from '../ids.js';
import type { Command } from '../state.js';
import { paragraph } from '../builders.js';
import { textRun } from '../inline.js';
import { read } from '../io/read.js';
import { insertFragment } from '../commands/insert.js';
import { pasteCells, tableFocus } from '../commands/tables.js';
import type { CellGrid } from '../table.js';
import { blocksFromHtml } from './from-html.js';
import type { ClipboardPayload } from './payload.js';

/** How to interpret a payload. */
export interface PasteOptions {
  /**
   * Parse `text/plain` as `.mdv` source instead of literal text.
   * Default false. This is the "Paste as Markdown" command, not normal paste.
   */
  readonly parseMarkdown?: boolean;
  /**
   * Prefer `text/plain` even when HTML is available — "Paste without
   * Formatting". Default false.
   */
  readonly plainOnly?: boolean;
  /**
   * Let a pasted table grow the table it lands in. Default true; false clips
   * the paste to the existing bounds.
   */
  readonly growTables?: boolean;
}

/**
 * Turn a payload into blocks.
 *
 * Returns an empty list when there is nothing usable, which callers should
 * treat as "not handled" rather than as an error.
 */
export function blocksFromPayload(
  payload: ClipboardPayload,
  ids: IdFactory,
  options: PasteOptions = {},
): readonly Block[] {
  if (!options.plainOnly && payload.mdv !== undefined && payload.mdv !== '') {
    return read(payload.mdv, { ids }).blocks;
  }
  if (!options.plainOnly && payload.html !== undefined && payload.html !== '') {
    const blocks = blocksFromHtml(payload.html, ids);
    if (blocks.length > 0) return blocks;
  }
  if (payload.text !== undefined && payload.text !== '') {
    return blocksFromText(payload.text, ids, options);
  }
  return [];
}

/**
 * Turn plain text into blocks.
 *
 * Each line becomes its own paragraph and blank lines are dropped. Joining
 * lines into one paragraph — which is what CommonMark's soft break would imply
 * — is wrong here: people paste addresses, log lines and lists far more often
 * than they paste hard-wrapped prose, and losing their line structure is much
 * more annoying than an extra paragraph break.
 *
 * Tab-separated text with a consistent shape is recognised as a grid by
 * {@link gridFromText} and handled separately by the paste command.
 */
export function blocksFromText(
  text: string,
  ids: IdFactory,
  options: PasteOptions = {},
): readonly Block[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\ufeff/, '');
  if (options.parseMarkdown) return read(normalized, { ids }).blocks;

  const out: Block[] = [];
  for (const line of normalized.split('\n')) {
    if (line.trim() === '') continue;
    out.push(paragraph(ids, [textRun(ids(), line)]));
  }
  return out;
}

/**
 * Read tab-separated text as a rectangular grid, or `undefined` when it is not.
 *
 * This is what a spreadsheet puts in `text/plain`. Requiring at least two
 * columns and a consistent column count keeps ordinary prose containing a stray
 * tab from being mistaken for a table.
 */
export function gridFromText(text: string, ids: IdFactory): CellGrid | undefined {
  const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n');
  if (lines.length === 0) return undefined;

  const rows = lines.map((line) => line.split('\t'));
  const width = rows[0]?.length ?? 0;
  if (width < 2) return undefined;
  if (!rows.every((row) => row.length === width)) return undefined;

  return rows.map((row) => row.map((cell) => (cell === '' ? [] : [textRun(ids(), cell)])));
}

/** Read a single table block back out as a grid, for cell-wise pasting. */
export function gridFromBlocks(blocks: readonly Block[]): CellGrid | undefined {
  if (blocks.length !== 1) return undefined;
  const only = blocks[0];
  if (only?.kind !== 'table') return undefined;
  return only.rows.map((row) => row.cells.map((cell) => cell.runs));
}

/**
 * The paste command.
 *
 * Delegates to {@link insertFragment} in the general case and to
 * {@link pasteCells} when both the source and the destination are tabular,
 * which is the behaviour anyone who has used a spreadsheet expects.
 */
export function paste(payload: ClipboardPayload, options: PasteOptions = {}): Command {
  return (state, ctx) => {
    const blocks = blocksFromPayload(payload, ctx.ids, options);
    if (blocks.length === 0) return null;

    const focus = tableFocus(state.doc, state.selection);
    if (focus) {
      const grid =
        gridFromBlocks(blocks) ??
        (payload.text === undefined ? undefined : gridFromText(payload.text, ctx.ids));
      if (grid && grid.length > 0) {
        const grow = options.growTables ?? true;
        return pasteCells(grid, { grow })(state, ctx);
      }
    }

    return insertFragment(blocks)(state, ctx);
  };
}

/** Paste, forcing the plain-text flavour. Wire this to Shift+Ctrl+V. */
export function pasteWithoutFormatting(payload: ClipboardPayload): Command {
  return paste(payload, { plainOnly: true });
}

/** Paste, parsing the text as `.mdv` source. */
export function pasteAsMarkdown(payload: ClipboardPayload): Command {
  return paste(payload, { plainOnly: true, parseMarkdown: true });
}

/**
 * `table` — the GFM-style pipe table (SPEC 6.2.1), and `matrix` (SPEC 6.2.5).
 *
 * `table` is the canonical MDV format and is Level 1. Its rules:
 *
 * - the first non-blank line is the header row;
 * - a delimiter row (`---|---`) immediately after the header is OPTIONAL, is
 *   consumed when present, and its alignment markers set column alignment;
 * - leading and trailing `|` are optional and MUST be stripped;
 * - cell content is trimmed, `\|` is a literal pipe, an empty cell is null;
 * - blank lines are skipped.
 *
 * Ragged rows are padded/truncated by `buildTable`, which owns `MDV2120` and
 * `MDV2121` for every format.
 */

import type { DiagCollector } from './diag.js';
import type { ParsedData, RawCell } from './raw.js';
import { isBlank, splitLines, stripBom } from './raw.js';

export type Alignment = 'left' | 'center' | 'right';

/**
 * Split one pipe-table row into trimmed cells.
 *
 * `\|` is a literal pipe and `\\` is a literal backslash; every other backslash
 * is kept verbatim, because data is not a string literal.
 */
export function splitPipeRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;
    if (ch === '\\') {
      const next = line[i + 1];
      if (next === '|') {
        cell += '|';
        i += 1;
        continue;
      }
      if (next === '\\') {
        cell += '\\';
        i += 1;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
      continue;
    }
    cell += ch;
  }
  cells.push(cell.trim());

  // Leading and trailing `|` are optional; strip the empty edges they create.
  if (cells.length > 1 && cells[0] === '' && line.trimStart().startsWith('|')) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === '' && line.trimEnd().endsWith('|')) {
    cells.pop();
  }
  return cells;
}

/** `true` when every cell of the row is an alignment marker (`:---`, `---:`, `:-:`). */
export function isDelimiterRow(cells: readonly string[]): boolean {
  if (cells.length === 0) return false;
  for (const cell of cells) {
    if (!isAlignmentMarker(cell)) return false;
  }
  return true;
}

function isAlignmentMarker(cell: string): boolean {
  let i = 0;
  if (cell[i] === ':') i += 1;
  let dashes = 0;
  while (cell[i] === '-') {
    dashes += 1;
    i += 1;
  }
  if (cell[i] === ':') i += 1;
  return dashes > 0 && i === cell.length;
}

function alignmentOf(cell: string): Alignment | undefined {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return undefined;
}

/** Parse a `table` data section. */
export function parseTableFormat(input: string, _diag: DiagCollector): ParsedData {
  const lines = splitLines(stripBom(input)).filter((l) => !isBlank(l));
  if (lines.length === 0) return { fields: [], rows: [] };

  const fields = splitPipeRow(lines[0] as string);
  let start = 1;
  let align: (Alignment | undefined)[] | undefined;

  if (lines.length > 1) {
    const second = splitPipeRow(lines[1] as string);
    if (isDelimiterRow(second)) {
      align = second.map(alignmentOf);
      start = 2;
    }
  }

  const rows: RawCell[][] = [];
  for (let i = start; i < lines.length; i += 1) {
    rows.push(splitPipeRow(lines[i] as string));
  }

  return align === undefined ? { fields, rows } : { fields, rows, align };
}

/**
 * Parse a `matrix` data section (SPEC 6.2.5).
 *
 * The first row is the column key, the first column of each row is the row key,
 * and the result is the three-field long table (`row`, `column`, `value`) the
 * encoder actually receives.
 */
export function parseMatrix(input: string, diag: DiagCollector): ParsedData {
  const grid = parseTableFormat(input, diag);
  if (grid.fields.length === 0) return { fields: ['row', 'column', 'value'], rows: [] };

  const columnKeys = grid.fields.slice(1);
  const rows: RawCell[][] = [];
  for (const line of grid.rows) {
    const rowKey = line[0] ?? null;
    for (let c = 0; c < columnKeys.length; c += 1) {
      rows.push([rowKey, columnKeys[c] as string, line[c + 1] ?? null]);
    }
  }
  return { fields: ['row', 'column', 'value'], rows };
}

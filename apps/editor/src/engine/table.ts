/**
 * The table model and its rectangular algebra.
 *
 * Tables are the one structure in this engine with a shape invariant, and the
 * invariant is enforced here rather than at the edges: **every row has exactly
 * `align.length` cells, and row 0 is the header**. Every function in this file
 * takes a rectangular table and returns a rectangular table. Nothing else in
 * the engine is allowed to build a `TableBlock` by hand — use {@link makeRectangular}
 * on anything that came from outside (a reader, a paste, a UI drag).
 *
 * GFM has no notion of a merged cell and neither does this model. A "cell
 * selection" is therefore always a plain rectangle, which is what makes copy,
 * paste, clear and fill one code path instead of four.
 */

import { tableCell, tableRow } from './builders.js';
import { EngineError, expect } from './errors.js';
import type { IdFactory, NodeId } from './ids.js';
import { normalizeRuns } from './inline.js';
import type { ColumnAlign, Run, TableBlock, TableCell, TableRow } from './model.js';
import type { CellRect, CellRef } from './selection.js';

/* -------------------------------------------------------------------------- */
/* Shape                                                                       */
/* -------------------------------------------------------------------------- */

/** Number of columns, which is authoritative in `align`, not in any row. */
export function columnCount(table: TableBlock): number {
  return table.align.length;
}

/** Number of rows *including* the header row. */
export function rowCount(table: TableBlock): number {
  return table.rows.length;
}

/** Number of body rows, i.e. every row after the header. */
export function bodyRowCount(table: TableBlock): number {
  return Math.max(0, table.rows.length - 1);
}

/** True when every row has exactly {@link columnCount} cells and a header exists. */
export function isRectangular(table: TableBlock): boolean {
  if (table.align.length === 0 || table.rows.length === 0) return false;
  return table.rows.every((row) => row.cells.length === table.align.length);
}

/**
 * Coerce a possibly ragged table into a rectangular one.
 *
 * The width is the widest row, so no authored content is ever truncated: a
 * reader that met `| a | b | c |` under a two-column delimiter row keeps all
 * three columns and pads the alignment list. A table with no rows at all gains
 * a single empty header row, because a zero-row table cannot be serialised as
 * GFM.
 */
export function makeRectangular(table: TableBlock, ids: IdFactory): TableBlock {
  const width = Math.max(
    1,
    table.align.length,
    ...table.rows.map((row) => row.cells.length),
  );
  const align: ColumnAlign[] = [];
  for (let index = 0; index < width; index += 1) align.push(table.align[index] ?? 'none');

  const source = table.rows.length > 0 ? table.rows : [tableRow(ids, [])];
  const rows = source.map((row) => {
    if (row.cells.length === width) return row;
    const cells: TableCell[] = [];
    for (let index = 0; index < width; index += 1) {
      cells.push(row.cells[index] ?? tableCell(ids));
    }
    return { ...row, cells };
  });

  if (align.length === table.align.length && rows.every((row, i) => row === table.rows[i])) {
    return table;
  }
  return { ...table, align, rows };
}

/** Raise `EDIT_INVARIANT` unless `table` is rectangular. */
export function assertRectangular(table: TableBlock): TableBlock {
  if (!isRectangular(table)) {
    throw new EngineError('EDIT_INVARIANT', 'table is not rectangular', {
      id: table.id,
      align: table.align.length,
      rows: table.rows.map((row) => row.cells.length),
    });
  }
  return table;
}

/* -------------------------------------------------------------------------- */
/* Addressing                                                                  */
/* -------------------------------------------------------------------------- */

/** The cell at `(row, col)`, or `undefined` when out of range. */
export function cellAt(table: TableBlock, row: number, col: number): TableCell | undefined {
  return table.rows[row]?.cells[col];
}

/** Clamp a reference into the table's current extent. */
export function clampRef(table: TableBlock, ref: CellRef): CellRef {
  const rows = Math.max(1, table.rows.length);
  const cols = Math.max(1, columnCount(table));
  return {
    row: Math.max(0, Math.min(Math.trunc(ref.row), rows - 1)),
    col: Math.max(0, Math.min(Math.trunc(ref.col), cols - 1)),
  };
}

/** Clamp a rectangle into the table's current extent. */
export function clampRect(table: TableBlock, rect: CellRect): CellRect {
  const topLeft = clampRef(table, { row: rect.top, col: rect.left });
  const bottomRight = clampRef(table, { row: rect.bottom, col: rect.right });
  return {
    top: Math.min(topLeft.row, bottomRight.row),
    left: Math.min(topLeft.col, bottomRight.col),
    bottom: Math.max(topLeft.row, bottomRight.row),
    right: Math.max(topLeft.col, bottomRight.col),
  };
}

/** A rectangle covering the whole table, header included. */
export function wholeTableRect(table: TableBlock): CellRect {
  return { top: 0, left: 0, bottom: table.rows.length - 1, right: columnCount(table) - 1 };
}

/** Every reference inside `rect`, in row-major order. */
export function refsInRect(rect: CellRect): readonly CellRef[] {
  const out: CellRef[] = [];
  for (let row = rect.top; row <= rect.bottom; row += 1) {
    for (let col = rect.left; col <= rect.right; col += 1) out.push({ row, col });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                  */
/* -------------------------------------------------------------------------- */

/** Directions {@link moveCell} understands. */
export type CellDirection = 'up' | 'down' | 'left' | 'right' | 'next' | 'previous';

/**
 * Move a cell reference.
 *
 * `next` and `previous` are the Tab and Shift-Tab motions: they wrap at the row
 * ends and stop at the two corners of the table, returning `undefined` so the
 * caller can decide whether Tab at the last cell should append a row (it
 * usually should) rather than having that policy baked in here.
 */
export function moveCell(
  table: TableBlock,
  from: CellRef,
  direction: CellDirection,
): CellRef | undefined {
  const cols = columnCount(table);
  const rows = table.rows.length;
  const ref = clampRef(table, from);
  switch (direction) {
    case 'up':
      return ref.row > 0 ? { row: ref.row - 1, col: ref.col } : undefined;
    case 'down':
      return ref.row + 1 < rows ? { row: ref.row + 1, col: ref.col } : undefined;
    case 'left':
      return ref.col > 0 ? { row: ref.row, col: ref.col - 1 } : undefined;
    case 'right':
      return ref.col + 1 < cols ? { row: ref.row, col: ref.col + 1 } : undefined;
    case 'next':
      if (ref.col + 1 < cols) return { row: ref.row, col: ref.col + 1 };
      return ref.row + 1 < rows ? { row: ref.row + 1, col: 0 } : undefined;
    case 'previous':
      if (ref.col > 0) return { row: ref.row, col: ref.col - 1 };
      return ref.row > 0 ? { row: ref.row - 1, col: cols - 1 } : undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

function emptyRow(table: TableBlock, ids: IdFactory): TableRow {
  return tableRow(
    ids,
    Array.from({ length: columnCount(table) }, () => tableCell(ids)),
  );
}

/**
 * Insert `count` empty rows so that the first new row sits at index `at`.
 *
 * `at` is clamped to `[1, rowCount]`: a GFM table's first row is its header, so
 * nothing can be inserted above it. Use {@link insertColumn} for the other axis.
 */
export function insertRow(
  table: TableBlock,
  ids: IdFactory,
  at: number,
  count = 1,
): TableBlock {
  const total = Math.max(1, Math.trunc(count));
  const index = Math.max(1, Math.min(Math.trunc(at), table.rows.length));
  const added = Array.from({ length: total }, () => emptyRow(table, ids));
  return {
    ...table,
    rows: [...table.rows.slice(0, index), ...added, ...table.rows.slice(index)],
  };
}

/**
 * Delete the row at `at`.
 *
 * Deleting the header promotes the first body row into the header, because a
 * GFM table without a header cannot be written; deleting the only row is a
 * no-op for the same reason. Both cases return the table unchanged when there
 * is nothing legal to do, so a UI can bind the action unconditionally.
 */
export function deleteRow(table: TableBlock, at: number): TableBlock {
  const index = Math.trunc(at);
  if (index < 0 || index >= table.rows.length) return table;
  if (table.rows.length <= 1) return table;
  return { ...table, rows: [...table.rows.slice(0, index), ...table.rows.slice(index + 1)] };
}

/**
 * Move the row at `from` so it lands at index `to`.
 *
 * The header never moves and nothing moves above it; both indices are clamped
 * into the body.
 */
export function moveRow(table: TableBlock, from: number, to: number): TableBlock {
  const last = table.rows.length - 1;
  if (last < 1) return table;
  const source = Math.max(1, Math.min(Math.trunc(from), last));
  const target = Math.max(1, Math.min(Math.trunc(to), last));
  if (source === target) return table;
  const rows = [...table.rows];
  const [moved] = rows.splice(source, 1);
  if (!moved) return table;
  rows.splice(target, 0, moved);
  return { ...table, rows };
}

/** Append an empty row at the bottom. */
export function appendRow(table: TableBlock, ids: IdFactory): TableBlock {
  return insertRow(table, ids, table.rows.length, 1);
}

/* -------------------------------------------------------------------------- */
/* Columns                                                                     */
/* -------------------------------------------------------------------------- */

/** Insert an empty column at `at`, clamped to `[0, columnCount]`. */
export function insertColumn(
  table: TableBlock,
  ids: IdFactory,
  at: number,
  align: ColumnAlign = 'none',
  count = 1,
): TableBlock {
  const total = Math.max(1, Math.trunc(count));
  const index = Math.max(0, Math.min(Math.trunc(at), columnCount(table)));
  const alignment = [
    ...table.align.slice(0, index),
    ...Array.from({ length: total }, () => align),
    ...table.align.slice(index),
  ];
  const rows = table.rows.map((row) => ({
    ...row,
    cells: [
      ...row.cells.slice(0, index),
      ...Array.from({ length: total }, () => tableCell(ids)),
      ...row.cells.slice(index),
    ],
  }));
  return { ...table, align: alignment, rows };
}

/** Delete the column at `at`. Deleting the last column is a no-op. */
export function deleteColumn(table: TableBlock, at: number): TableBlock {
  const index = Math.trunc(at);
  if (index < 0 || index >= columnCount(table)) return table;
  if (columnCount(table) <= 1) return table;
  return {
    ...table,
    align: [...table.align.slice(0, index), ...table.align.slice(index + 1)],
    rows: table.rows.map((row) => ({
      ...row,
      cells: [...row.cells.slice(0, index), ...row.cells.slice(index + 1)],
    })),
  };
}

/** Move the column at `from` to index `to`, carrying its alignment with it. */
export function moveColumn(table: TableBlock, from: number, to: number): TableBlock {
  const last = columnCount(table) - 1;
  if (last < 1) return table;
  const source = Math.max(0, Math.min(Math.trunc(from), last));
  const target = Math.max(0, Math.min(Math.trunc(to), last));
  if (source === target) return table;

  const align = [...table.align];
  const [movedAlign] = align.splice(source, 1);
  align.splice(target, 0, movedAlign ?? 'none');

  const rows = table.rows.map((row) => {
    const cells = [...row.cells];
    const [moved] = cells.splice(source, 1);
    cells.splice(target, 0, moved ?? tableCellPlaceholder(row, source));
    return { ...row, cells };
  });
  return { ...table, align, rows };
}

/** Only reachable if a row was ragged, which {@link assertRectangular} forbids. */
function tableCellPlaceholder(row: TableRow, index: number): TableCell {
  throw new EngineError('EDIT_INVARIANT', 'ragged row encountered during column move', {
    row: row.id,
    index,
  });
}

/** Set one column's alignment. */
export function setColumnAlign(
  table: TableBlock,
  col: number,
  align: ColumnAlign,
): TableBlock {
  const index = Math.trunc(col);
  if (index < 0 || index >= columnCount(table)) return table;
  if (table.align[index] === align) return table;
  const next = [...table.align];
  next[index] = align;
  return { ...table, align: next };
}

/* -------------------------------------------------------------------------- */
/* Cell content                                                                */
/* -------------------------------------------------------------------------- */

/** Replace the runs of one cell. Out-of-range references are ignored. */
export function setCellRuns(
  table: TableBlock,
  ref: CellRef,
  runs: readonly Run[],
): TableBlock {
  if (!cellAt(table, ref.row, ref.col)) return table;
  const rows = table.rows.map((row, r) => {
    if (r !== ref.row) return row;
    return {
      ...row,
      cells: row.cells.map((cell, c) => (c === ref.col ? { ...cell, runs: normalizeRuns(runs) } : cell)),
    };
  });
  return { ...table, rows };
}

/** Empty every cell in `rect`, keeping the cells (and their ids) in place. */
export function clearCells(table: TableBlock, rect: CellRect): TableBlock {
  const area = clampRect(table, rect);
  const rows = table.rows.map((row, r) => {
    if (r < area.top || r > area.bottom) return row;
    return {
      ...row,
      cells: row.cells.map((cell, c) =>
        c >= area.left && c <= area.right && cell.runs.length > 0 ? { ...cell, runs: [] } : cell,
      ),
    };
  });
  return { ...table, rows };
}

/** A rectangular block of run lists, row-major. The clipboard's cell payload. */
export type CellGrid = readonly (readonly (readonly Run[])[])[];

/** Copy `rect` out of the table as a plain grid of run lists. */
export function extractRect(table: TableBlock, rect: CellRect): CellGrid {
  const area = clampRect(table, rect);
  const out: (readonly Run[])[][] = [];
  for (let row = area.top; row <= area.bottom; row += 1) {
    const line: (readonly Run[])[] = [];
    for (let col = area.left; col <= area.right; col += 1) {
      line.push(cellAt(table, row, col)?.runs ?? []);
    }
    out.push(line);
  }
  return out;
}

/** Options for {@link pasteRect}. */
export interface PasteRectOptions {
  /**
   * Grow the table when the grid overflows its right or bottom edge. Default
   * `true`: pasting a 3×3 block into the last cell should not silently lose six
   * cells. Set `false` to clip instead (what a spreadsheet does when a range is
   * pre-selected).
   */
  readonly grow?: boolean;
}

/**
 * Write `grid` into the table with its top-left corner at `at`.
 *
 * The result is always rectangular: short grid rows leave the cells they do not
 * cover untouched, and growing adds fully-formed empty rows and columns first,
 * so the table is never transiently ragged.
 */
export function pasteRect(
  table: TableBlock,
  ids: IdFactory,
  at: CellRef,
  grid: CellGrid,
  options: PasteRectOptions = {},
): TableBlock {
  if (grid.length === 0) return table;
  const grow = options.grow ?? true;
  const origin = clampRef(table, at);
  const width = Math.max(...grid.map((row) => row.length));
  let next = table;

  if (grow) {
    const neededRows = origin.row + grid.length - next.rows.length;
    if (neededRows > 0) next = insertRow(next, ids, next.rows.length, neededRows);
    const neededCols = origin.col + width - columnCount(next);
    if (neededCols > 0) next = insertColumn(next, ids, columnCount(next), 'none', neededCols);
  }

  const rows = next.rows.map((row, r) => {
    const line = grid[r - origin.row];
    if (!line) return row;
    let changed = false;
    const cells = row.cells.map((cell, c) => {
      const runs = line[c - origin.col];
      if (runs === undefined) return cell;
      changed = true;
      return { ...cell, runs: normalizeRuns(runs) };
    });
    return changed ? { ...row, cells } : row;
  });
  return { ...next, rows };
}

/* -------------------------------------------------------------------------- */
/* Construction from foreign data                                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a rectangular table from a grid of run lists, treating the first row as
 * the header. Used by the clipboard when an HTML `<table>` arrives.
 */
export function tableFromGrid(
  ids: IdFactory,
  grid: CellGrid,
  align: readonly ColumnAlign[] = [],
): TableBlock {
  const width = Math.max(1, align.length, ...grid.map((row) => row.length));
  const rows: TableRow[] = (grid.length > 0 ? grid : [[]]).map((line) =>
    tableRow(
      ids,
      Array.from({ length: width }, (_unused, index) => tableCell(ids, line[index] ?? [])),
    ),
  );
  const alignment = Array.from({ length: width }, (_unused, index): ColumnAlign => align[index] ?? 'none');
  const id = ids();
  return assertRectangular({ kind: 'table', id, align: alignment, rows });
}

/** The header cell ids, in column order. Handy for a UI that labels columns. */
export function headerCellIds(table: TableBlock): readonly NodeId[] {
  const header = expect(table.rows[0], 'table has no header row');
  return header.cells.map((cell) => cell.id);
}

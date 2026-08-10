/**
 * Table commands.
 *
 * Thin wrappers over `table.ts`: the algebra lives there and is pure, these
 * bind it to a selection and produce transactions. Every one of them keeps the
 * selection inside the table it started in, because losing the caret is the
 * fastest way to make a table editor feel broken.
 */

import type { NodeId } from '../ids.js';
import { MappingBuilder } from '../mapping.js';
import type { ColumnAlign, MdvDocument, TableBlock } from '../model.js';
import type { Command } from '../state.js';
import type { CellRect, CellRef, Selection } from '../selection.js';
import { caret, cellRect, containerPath } from '../selection.js';
import { findBlock, replaceBlockWith } from '../tree.js';
import {
  appendRow,
  clampRef,
  columnCount,
  deleteColumn as deleteColumnAt,
  deleteRow as deleteRowAt,
  extractRect,
  insertColumn as insertColumnAt,
  insertRow as insertRowAt,
  moveCell,
  moveColumn as moveColumnTo,
  moveRow as moveRowTo,
  pasteRect,
  setColumnAlign as setAlign,
  wholeTableRect,
} from '../table.js';
import type { CellDirection, CellGrid } from '../table.js';

/** The table and cell the selection is in, if it is in one. */
export interface TableFocus {
  readonly table: TableBlock;
  readonly cell: CellRef;
  readonly rect: CellRect;
}

/** Resolve the selection to a table focus, or `undefined` when outside a table. */
export function tableFocus(doc: MdvDocument, selection: Selection): TableFocus | undefined {
  if (selection.kind === 'cells') {
    const block = findBlock(doc, selection.tableId)?.block;
    if (block?.kind !== 'table') return undefined;
    const rect = cellRect(selection);
    return { table: block, cell: { row: rect.top, col: rect.left }, rect };
  }
  if (selection.kind !== 'text') return undefined;
  const path = containerPath(selection.anchor);
  if (path.length !== 2) return undefined;
  const block = findBlock(doc, selection.anchor.blockId)?.block;
  if (block?.kind !== 'table') return undefined;
  const cell = clampRef(block, { row: path[0] ?? 0, col: path[1] ?? 0 });
  return { table: block, cell, rect: { top: cell.row, left: cell.col, bottom: cell.row, right: cell.col } };
}

/** Put the caret at the start of a cell. */
export function caretInCell(tableId: NodeId, ref: CellRef): Selection {
  return caret({ blockId: tableId, path: [ref.row, ref.col, 0], offset: 0 });
}

function commit(
  doc: MdvDocument,
  table: TableBlock,
  next: TableBlock,
  selection: Selection,
): { readonly doc: MdvDocument; readonly selection: Selection } | null {
  if (next === table) return null;
  return { doc: replaceBlockWith(doc, table.id, [next]), selection };
}

/** Insert an empty row above the focused one. The header cannot be pushed down. */
export function insertRowAbove(): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const at = Math.max(1, focus.rect.top);
    const next = insertRowAt(focus.table, ctx.ids, at);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: at, col: focus.cell.col }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Insert an empty row below the focused one. */
export function insertRowBelow(): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const at = focus.rect.bottom + 1;
    const next = insertRowAt(focus.table, ctx.ids, at);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: Math.max(1, at), col: focus.cell.col }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Delete every row the selection touches. The last surviving row stays. */
export function deleteRows(): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    let next = focus.table;
    for (let row = focus.rect.bottom; row >= focus.rect.top; row -= 1) {
      next = deleteRowAt(next, row);
    }
    const target = clampRef(next, { row: focus.rect.top, col: focus.cell.col });
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, target));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Insert an empty column to the left of the focused one. */
export function insertColumnLeft(): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const at = focus.rect.left;
    const next = insertColumnAt(focus.table, ctx.ids, at);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: focus.cell.row, col: at }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Insert an empty column to the right of the focused one. */
export function insertColumnRight(): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const at = focus.rect.right + 1;
    const next = insertColumnAt(focus.table, ctx.ids, at);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: focus.cell.row, col: at }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Delete every column the selection touches. The last surviving column stays. */
export function deleteColumns(): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    let next = focus.table;
    for (let col = focus.rect.right; col >= focus.rect.left; col -= 1) {
      next = deleteColumnAt(next, col);
    }
    const target = clampRef(next, { row: focus.cell.row, col: focus.rect.left });
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, target));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Move the focused row one place up or down, never past the header. */
export function moveRow(delta: number): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const from = focus.cell.row;
    const to = from + Math.trunc(delta);
    if (from < 1 || to < 1 || to >= focus.table.rows.length) return null;
    const next = moveRowTo(focus.table, from, to);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: to, col: focus.cell.col }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Move the focused column one place left or right. */
export function moveColumn(delta: number): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const from = focus.cell.col;
    const to = from + Math.trunc(delta);
    if (to < 0 || to >= columnCount(focus.table)) return null;
    const next = moveColumnTo(focus.table, from, to);
    const result = commit(state.doc, focus.table, next, caretInCell(focus.table.id, { row: focus.cell.row, col: to }));
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/** Set the alignment of every column the selection touches. */
export function setColumnAlignment(align: ColumnAlign): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    let next = focus.table;
    for (let col = focus.rect.left; col <= focus.rect.right; col += 1) {
      next = setAlign(next, col, align);
    }
    const result = commit(state.doc, focus.table, next, state.selection);
    return result === null ? null : { state: { ...result, pendingMarks: null }, label: 'table edit' };
  };
}

/**
 * Move the caret between cells.
 *
 * `next` past the last cell appends a row, which is how a table gets filled in
 * from the keyboard; every other overrun is a no-op so the caret cannot escape
 * the table by accident.
 */
export function navigateCell(direction: CellDirection): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const target = moveCell(focus.table, focus.cell, direction);
    if (!target) {
      if (direction !== 'next') return null;
      const grown = appendRow(focus.table, ctx.ids);
      return {
        state: {
          doc: replaceBlockWith(state.doc, focus.table.id, [grown]),
          selection: caretInCell(focus.table.id, { row: grown.rows.length - 1, col: 0 }),
          pendingMarks: null,
        },
        label: 'table edit',
      };
    }
    return {
      state: { doc: state.doc, selection: caretInCell(focus.table.id, target), pendingMarks: null },
      label: 'table edit',
    };
  };
}

/** Select a rectangular range of cells. */
export function selectCells(tableId: NodeId, anchor: CellRef, focus: CellRef): Command {
  return (state) => {
    const block = findBlock(state.doc, tableId)?.block;
    if (block?.kind !== 'table') return null;
    return {
      state: {
        doc: state.doc,
        selection: {
          kind: 'cells',
          tableId,
          anchor: clampRef(block, anchor),
          focus: clampRef(block, focus),
        },
        pendingMarks: null,
      },
      label: 'table edit',
    };
  };
}

/** Select every cell of the focused table. */
export function selectWholeTable(): Command {
  return (state) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus) return null;
    const rect = wholeTableRect(focus.table);
    return {
      state: {
        doc: state.doc,
        selection: {
          kind: 'cells',
          tableId: focus.table.id,
          anchor: { row: rect.top, col: rect.left },
          focus: { row: rect.bottom, col: rect.right },
        },
        pendingMarks: null,
      },
      label: 'table edit',
    };
  };
}

/**
 * Paste a rectangular block of cells with its top-left corner at the focus.
 *
 * Grows the table when the grid overflows, so nothing is silently dropped.
 */
export function pasteCells(grid: CellGrid, options: { readonly grow?: boolean } = {}): Command {
  return (state, ctx) => {
    const focus = tableFocus(state.doc, state.selection);
    if (!focus || grid.length === 0) return null;
    const next = pasteRect(focus.table, ctx.ids, focus.cell, grid, options);
    const height = grid.length;
    const width = Math.max(...grid.map((row) => row.length));
    const result = commit(state.doc, focus.table, next, {
      kind: 'cells',
      tableId: focus.table.id,
      anchor: focus.cell,
      focus: clampRef(next, { row: focus.cell.row + height - 1, col: focus.cell.col + width - 1 }),
    });
    return result === null
      ? null
      : {
          state: { ...result, pendingMarks: null },
          label: 'paste',
          mapPoint: new MappingBuilder(state.doc).build(result.doc),
        };
  };
}

/** Copy the selected rectangle out of the focused table. */
export function copyCells(doc: MdvDocument, selection: Selection): CellGrid | undefined {
  const focus = tableFocus(doc, selection);
  if (!focus) return undefined;
  return extractRect(focus.table, focus.rect);
}

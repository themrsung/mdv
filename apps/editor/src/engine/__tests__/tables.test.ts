/**
 * Tables.
 *
 * One invariant dominates: **the grid is always rectangular**, and row 0 is
 * always the header. Every operation below is checked against it, because a
 * single ragged row makes every column operation ill-defined and there is no
 * good place to discover that later.
 *
 * The second theme is that the caret must survive. A table editor where
 * inserting a row loses your place is unusable, so each command asserts where
 * the selection ended up as well as what the grid contains.
 */

import { describe, expect, it } from 'vitest';

import {
  deleteColumns,
  deleteRows,
  insertColumnLeft,
  insertColumnRight,
  insertRowAbove,
  insertRowBelow,
  insertText,
  moveColumn,
  moveRow,
  navigateCell,
  pasteCells,
  selectCells,
  setColumnAlignment,
} from '../commands/index.js';
import { columnCount, isRectangular, makeRectangular, tableFromGrid } from '../table.js';
import { createIdFactory } from '../ids.js';
import { textRun } from '../inline.js';
import type { TableBlock } from '../model.js';
import { blockAt, caretAt, editorFor, inCell, tableText } from './helpers.js';
import { caret } from '../selection.js';

const GRID = '| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n';

function tableOf(editor: ReturnType<typeof editorFor>): TableBlock {
  const block = blockAt(editor.getDocument(), 0);
  if (block.kind !== 'table') throw new Error(`expected a table, got ${block.kind}`);
  return block;
}

/** Put the caret in one cell, `offset` characters in. */
function focus(editor: ReturnType<typeof editorFor>, row: number, col: number, offset = 0): void {
  editor.select(caret(inCell(editor.getDocument(), tableOf(editor).id, row, col, offset)));
}

function expectRectangular(table: TableBlock): void {
  expect(isRectangular(table)).toBe(true);
  const width = columnCount(table);
  for (const row of table.rows) expect(row.cells).toHaveLength(width);
  expect(table.align).toHaveLength(width);
}

describe('reading a table', () => {
  it('produces a rectangular grid with the header first', () => {
    const editor = editorFor(GRID);
    const table = tableOf(editor);
    expectRectangular(table);
    expect(tableText(table)).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
      ['4', '5', '6'],
    ]);
  });

  it('pads a ragged source row rather than accepting it', () => {
    const editor = editorFor('| a | b | c |\n| --- | --- | --- |\n| 1 |\n');
    expectRectangular(tableOf(editor));
    expect(tableText(tableOf(editor))[1]).toEqual(['1', '', '']);
  });
});

describe('rows', () => {
  it('inserts above without displacing the header', () => {
    const editor = editorFor(GRID);
    focus(editor, 0, 1);
    editor.dispatch(insertRowAbove());

    const table = tableOf(editor);
    expectRectangular(table);
    expect(tableText(table)[0]).toEqual(['a', 'b', 'c']);
    expect(tableText(table)[1]).toEqual(['', '', '']);
  });

  it('inserts below the focused row', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 0);
    editor.dispatch(insertRowBelow());

    const table = tableOf(editor);
    expectRectangular(table);
    expect(table.rows).toHaveLength(4);
    expect(tableText(table)[2]).toEqual(['', '', '']);
  });

  it('deletes a row and undoes exactly', () => {
    const editor = editorFor(GRID);
    const before = editor.toText();
    focus(editor, 1, 0);
    editor.dispatch(deleteRows());

    expect(tableOf(editor).rows).toHaveLength(2);
    expectRectangular(tableOf(editor));
    editor.undo();
    expect(editor.toText()).toBe(before);
  });

  it('refuses to delete the last remaining row', () => {
    const editor = editorFor('| a |\n| --- |\n');
    focus(editor, 0, 0);
    editor.dispatch(deleteRows());
    expect(tableOf(editor).rows).toHaveLength(1);
  });

  it('promotes the next row when the header is deleted', () => {
    const editor = editorFor(GRID);
    focus(editor, 0, 0);
    editor.dispatch(deleteRows());
    expect(tableText(tableOf(editor))[0]).toEqual(['1', '2', '3']);
    expectRectangular(tableOf(editor));
  });

  it('moves a body row without moving the header', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 0);
    editor.dispatch(moveRow(1));

    expect(tableText(tableOf(editor))).toEqual([
      ['a', 'b', 'c'],
      ['4', '5', '6'],
      ['1', '2', '3'],
    ]);
  });

  it('will not move the header', () => {
    const editor = editorFor(GRID);
    focus(editor, 0, 0);
    expect(editor.dispatch(moveRow(1))).toBeNull();
  });
});

describe('columns', () => {
  it('inserts to the left, widening every row and the alignment list', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 1);
    editor.dispatch(insertColumnLeft());

    const table = tableOf(editor);
    expectRectangular(table);
    expect(columnCount(table)).toBe(4);
    expect(tableText(table)[0]).toEqual(['a', '', 'b', 'c']);
  });

  it('inserts to the right', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 1);
    editor.dispatch(insertColumnRight());
    expect(tableText(tableOf(editor))[0]).toEqual(['a', 'b', '', 'c']);
    expectRectangular(tableOf(editor));
  });

  it('deletes a column and undoes exactly', () => {
    const editor = editorFor(GRID);
    const before = editor.toText();
    focus(editor, 0, 1);
    editor.dispatch(deleteColumns());

    expect(columnCount(tableOf(editor))).toBe(2);
    expect(tableText(tableOf(editor))[0]).toEqual(['a', 'c']);
    expectRectangular(tableOf(editor));

    editor.undo();
    expect(editor.toText()).toBe(before);
  });

  it('refuses to delete the last remaining column', () => {
    const editor = editorFor('| a |\n| --- |\n| 1 |\n');
    focus(editor, 0, 0);
    editor.dispatch(deleteColumns());
    expect(columnCount(tableOf(editor))).toBe(1);
  });

  it('moves a column with its alignment', () => {
    const editor = editorFor('| a | b |\n| :-- | --: |\n| 1 | 2 |\n');
    focus(editor, 0, 0);
    editor.dispatch(moveColumn(1));

    const table = tableOf(editor);
    expect(tableText(table)[0]).toEqual(['b', 'a']);
    expect(table.align).toEqual(['right', 'left']);
    expectRectangular(table);
  });

  it('sets alignment across a cell selection', () => {
    const editor = editorFor(GRID);
    const id = tableOf(editor).id;
    editor.dispatch(selectCells(id, { row: 0, col: 0 }, { row: 0, col: 1 }));
    editor.dispatch(setColumnAlignment('center'));

    expect(tableOf(editor).align).toEqual(['center', 'center', 'none']);
    expect(editor.toText()).toContain('| :-: | :-: | --- |');
  });
});

describe('navigation', () => {
  it('moves right and wraps to the next row', () => {
    const editor = editorFor(GRID);
    focus(editor, 0, 2);
    editor.dispatch(navigateCell('next'));

    const selection = editor.getSelection();
    if (selection.kind !== 'text') throw new Error('expected a text selection');
    expect(selection.anchor.path.slice(0, 2)).toEqual([1, 0]);
  });

  it('appends a row when tabbing past the last cell', () => {
    const editor = editorFor(GRID);
    focus(editor, 2, 2);
    editor.dispatch(navigateCell('next'));

    const table = tableOf(editor);
    expect(table.rows).toHaveLength(4);
    expectRectangular(table);
    const selection = editor.getSelection();
    if (selection.kind !== 'text') throw new Error('expected a text selection');
    expect(selection.anchor.path.slice(0, 2)).toEqual([3, 0]);
  });

  it('does not escape the table upwards from the header', () => {
    const editor = editorFor(GRID);
    focus(editor, 0, 0);
    expect(editor.dispatch(navigateCell('up'))).toBeNull();
  });
});

describe('cell editing', () => {
  it('types into the focused cell only', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 1, 1);
    editor.dispatch(insertText('!'));

    expect(tableText(tableOf(editor))[1]).toEqual(['1', '2!', '3']);
    expect(tableText(tableOf(editor))[0]).toEqual(['a', 'b', 'c']);
    expectRectangular(tableOf(editor));
  });

  it('clears a cell range without changing the shape', () => {
    const editor = editorFor(GRID);
    const id = tableOf(editor).id;
    editor.dispatch(selectCells(id, { row: 1, col: 0 }, { row: 2, col: 1 }));
    editor.dispatch(insertText(''));

    const table = tableOf(editor);
    expectRectangular(table);
    expect(table.rows).toHaveLength(3);
  });
});

describe('pasting a rectangle', () => {
  it('grows the table to fit an oversized paste', () => {
    const editor = editorFor('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    focus(editor, 1, 0);

    const ids = createIdFactory('p');
    const grid = [
      [[textRun(ids(), 'x')], [textRun(ids(), 'y')], [textRun(ids(), 'z')]],
      [[textRun(ids(), 'q')], [textRun(ids(), 'r')], [textRun(ids(), 's')]],
    ];
    editor.dispatch(pasteCells(grid));

    const table = tableOf(editor);
    expectRectangular(table);
    expect(columnCount(table)).toBe(3);
    expect(table.rows).toHaveLength(3);
    expect(tableText(table)[1]).toEqual(['x', 'y', 'z']);
    expect(tableText(table)[2]).toEqual(['q', 'r', 's']);
  });

  it('clips instead of growing when asked', () => {
    const editor = editorFor('| a | b |\n| --- | --- |\n| 1 | 2 |\n');
    focus(editor, 1, 1);

    const ids = createIdFactory('p');
    const grid = [[[textRun(ids(), 'x')], [textRun(ids(), 'y')]]];
    editor.dispatch(pasteCells(grid, { grow: false }));

    const table = tableOf(editor);
    expect(columnCount(table)).toBe(2);
    expect(tableText(table)[1]).toEqual(['1', 'x']);
    expectRectangular(table);
  });
});

describe('the algebra directly', () => {
  it('makeRectangular is idempotent', () => {
    const ids = createIdFactory('m');
    const table = tableFromGrid(ids, [
      [[textRun(ids(), 'a')], [textRun(ids(), 'b')]],
      [[textRun(ids(), '1')]],
    ]);
    const once = makeRectangular(table, ids);
    expectRectangular(once);
    expect(makeRectangular(once, ids)).toBe(once);
  });

  it('tableFromGrid produces the alignment list the grid implies', () => {
    const ids = createIdFactory('m');
    const table = tableFromGrid(ids, [
      [[textRun(ids(), 'a')], [textRun(ids(), 'b')], [textRun(ids(), 'c')]],
    ]);
    expect(table.align).toEqual(['none', 'none', 'none']);
    expectRectangular(table);
  });
});

describe('every table command leaves a writable document', () => {
  it('survives a barrage of operations', () => {
    const editor = editorFor(GRID);
    focus(editor, 1, 1);

    editor.dispatch(insertColumnRight());
    editor.dispatch(insertRowBelow());
    editor.dispatch(moveColumn(-1));
    editor.dispatch(setColumnAlignment('right'));
    editor.dispatch(deleteRows());
    editor.dispatch(insertText('done'));

    expectRectangular(tableOf(editor));
    const text = editor.toText();
    expect(editorFor(text).toText()).toBe(text);
  });

  it('unwinds all of it', () => {
    const editor = editorFor(GRID);
    const before = editor.toText();
    focus(editor, 1, 1);

    editor.dispatch(insertColumnRight());
    editor.dispatch(insertRowBelow());
    editor.dispatch(deleteColumns());

    while (editor.canUndo()) editor.undo();
    expect(editor.toText()).toBe(before);
  });
});

describe('a table next to other blocks', () => {
  it('is untouched by editing its neighbour', () => {
    const editor = editorFor(`intro\n\n${GRID}`);
    const intro = blockAt(editor.getDocument(), 0);
    editor.select(caretAt(editor.getDocument(), intro.id, 5));
    editor.dispatch(insertText('!'));

    const table = blockAt(editor.getDocument(), 1);
    if (table.kind !== 'table') throw new Error('expected a table');
    expectRectangular(table);
    expect(tableText(table)[0]).toEqual(['a', 'b', 'c']);
    expect(editor.toText().startsWith('intro!\n')).toBe(true);
  });
});

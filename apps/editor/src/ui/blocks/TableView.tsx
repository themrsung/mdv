/**
 * Tables.
 *
 * A GFM table is a rectangle of inline containers, so every cell is its own
 * editing host and everything the rest of the editor knows about text applies
 * unchanged inside one. What is table-specific lives here:
 *
 * - **Handles.** A strip above the columns and beside the rows. Clicking one
 *   selects that line; its menu inserts, deletes and moves. Column handles also
 *   carry the alignment control, because alignment is a property of the column
 *   and nothing else.
 * - **Rectangular selection.** Press in one cell, drag to another, and the
 *   engine holds a `cells` selection covering the rectangle. Formatting,
 *   deletion and copying all understand it.
 * - **Keyboard navigation.** Tab and the arrows are resolved by the surface,
 *   which owns the keymap; the only thing that happens here is that a cell
 *   knows its own coordinates.
 *
 * The header row is row 0 and cannot be deleted or displaced: a GFM table
 * without a header is not a table. The engine enforces that; the UI simply does
 * not offer the operations that would break it.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { CellRect, ColumnAlign, TableBlock } from '../../engine/index.js';
import { columnCount, commands } from '../../engine/index.js';
import { useEditorApi } from '../state/store.js';
import { useSurface } from '../surface/surface-context.js';
import { Editable } from './Editable.js';

const ALIGNMENTS: readonly { readonly value: ColumnAlign; readonly label: string }[] = [
  { value: 'none', label: 'Default' },
  { value: 'left', label: 'Left' },
  { value: 'center', label: 'Center' },
  { value: 'right', label: 'Right' },
];

function inRect(rect: CellRect | null, row: number, col: number): boolean {
  if (rect === null) return false;
  return row >= rect.top && row <= rect.bottom && col >= rect.left && col <= rect.right;
}

/* -------------------------------------------------------------------------- */
/* Handle menu                                                                 */
/* -------------------------------------------------------------------------- */

interface HandleMenuProps {
  readonly axis: 'row' | 'column';
  readonly index: number;
  readonly table: TableBlock;
  readonly onClose: () => void;
}

function HandleMenu({ axis, index, table, onClose }: HandleMenuProps): ReactElement {
  const { run, select } = useEditorApi();
  const reference = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const first = reference.current?.querySelector('button');
    if (first instanceof HTMLElement) first.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent): void => {
      if (reference.current !== null && !reference.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const act = useCallback(
    (perform: () => void) => () => {
      // Every entry acts on the engine's current selection, so put it on the
      // line whose handle was clicked before doing anything.
      const ref = axis === 'row' ? { row: index, col: 0 } : { row: 0, col: index };
      select({ kind: 'cells', tableId: table.id, anchor: ref, focus: ref });
      perform();
      onClose();
    },
    [axis, index, onClose, select, table.id],
  );

  const isRow = axis === 'row';
  const isHeader = isRow && index === 0;
  const lastColumn = columnCount(table) <= 1;
  const lastBodyRow = table.rows.length <= 2;

  return (
    <div className="mdv-menu mdv-menu--handle" role="menu" ref={reference}>
      <div className="mdv-menu__label">{isRow ? `Row ${String(index)}` : `Column ${String(index + 1)}`}</div>

      {isRow ? (
        <>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.insertRowAbove()))} disabled={isHeader}>
            Insert row above
          </button>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.insertRowBelow()))}>
            Insert row below
          </button>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.moveRow(-1)))} disabled={isHeader || index <= 1}>
            Move up
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.moveRow(1)))}
            disabled={isHeader || index >= table.rows.length - 1}
          >
            Move down
          </button>
          <button
            type="button"
            role="menuitem"
            className="mdv-menu__danger"
            onClick={act(() => void run(commands.deleteRows()))}
            disabled={isHeader || lastBodyRow}
          >
            Delete row
          </button>
          {isHeader ? <p className="mdv-menu__note">A table keeps its header row.</p> : null}
        </>
      ) : (
        <>
          <div className="mdv-menu__group" role="group" aria-label="Column alignment">
            {ALIGNMENTS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={(table.align[index] ?? 'none') === option.value}
                className={
                  (table.align[index] ?? 'none') === option.value ? 'is-active' : undefined
                }
                onClick={act(() => void run(commands.setColumnAlignment(option.value)))}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.insertColumnLeft()))}>
            Insert column left
          </button>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.insertColumnRight()))}>
            Insert column right
          </button>
          <button type="button" role="menuitem" onClick={act(() => void run(commands.moveColumn(-1)))} disabled={index === 0}>
            Move left
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.moveColumn(1)))}
            disabled={index >= columnCount(table) - 1}
          >
            Move right
          </button>
          <button
            type="button"
            role="menuitem"
            className="mdv-menu__danger"
            onClick={act(() => void run(commands.deleteColumns()))}
            disabled={lastColumn}
          >
            Delete column
          </button>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Table                                                                       */
/* -------------------------------------------------------------------------- */

interface OpenMenu {
  readonly axis: 'row' | 'column';
  readonly index: number;
}

function TableViewImpl({ block }: { readonly block: TableBlock }): ReactElement {
  const { select, doc } = useEditorApi();
  const surface = useSurface();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const dragAnchor = useRef<{ row: number; col: number } | null>(null);

  const columns = columnCount(block);
  const rect = surface.cellSelection?.tableId === block.id ? surface.cellSelection.rect : null;
  const active = surface.activeBlockId === block.id;
  const closeMenu = useCallback(() => {
    setMenu(null);
  }, []);

  /*
   * Rectangular selection is driven from `pointerdown` + `pointerover` rather
   * than from the native selection, because the native one cannot leave a cell:
   * each cell is its own editing host. Dragging is only escalated to a cell
   * selection once a *second* cell is entered, so an ordinary click-and-drag
   * inside one cell still selects text the way it should.
   */
  const onCellPointerDown = useCallback(
    (row: number, col: number) => (event: React.PointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      dragAnchor.current = { row, col };
    },
    [],
  );

  const onCellPointerEnter = useCallback(
    (row: number, col: number) => (event: React.PointerEvent<HTMLElement>) => {
      const anchor = dragAnchor.current;
      if (anchor === null) return;
      // `buttons` is the authoritative "is a button still held" bit; a pointerup
      // outside the window never reaches us, and this notices on the next move.
      if (event.buttons === 0) {
        dragAnchor.current = null;
        return;
      }
      if (anchor.row === row && anchor.col === col) return;
      select({ kind: 'cells', tableId: block.id, anchor, focus: { row, col } });
    },
    [block.id, select],
  );

  useEffect(() => {
    const stop = (): void => {
      dragAnchor.current = null;
    };
    document.addEventListener('pointerup', stop);
    document.addEventListener('pointercancel', stop);
    return () => {
      document.removeEventListener('pointerup', stop);
      document.removeEventListener('pointercancel', stop);
    };
  }, []);

  const selectColumn = useCallback(
    (index: number) => () => {
      select({
        kind: 'cells',
        tableId: block.id,
        anchor: { row: 0, col: index },
        focus: { row: Math.max(0, block.rows.length - 1), col: index },
      });
    },
    [block.id, block.rows.length, select],
  );

  const selectRow = useCallback(
    (index: number) => () => {
      select({
        kind: 'cells',
        tableId: block.id,
        anchor: { row: index, col: 0 },
        focus: { row: index, col: Math.max(0, columns - 1) },
      });
    },
    [block.id, columns, select],
  );

  void doc;

  return (
    <div className={`mdv-table-wrap${active || rect !== null ? ' is-active' : ''}`}>
      <div className="mdv-table-handles mdv-table-handles--columns" aria-hidden={false}>
        <span className="mdv-table-corner" />
        {Array.from({ length: columns }, (_, index) => (
          <span className="mdv-table-handle-cell" key={`col-${String(index)}`}>
            <button
              type="button"
              className={`mdv-handle${rect !== null && rect.left <= index && index <= rect.right ? ' is-active' : ''}`}
              aria-label={`Column ${String(index + 1)} options`}
              aria-haspopup="menu"
              aria-expanded={menu?.axis === 'column' && menu.index === index}
              onClick={(event) => {
                selectColumn(index)();
                event.stopPropagation();
                setMenu((current) =>
                  current?.axis === 'column' && current.index === index
                    ? null
                    : { axis: 'column', index },
                );
              }}
            >
              <span aria-hidden="true">⋯</span>
            </button>
            {menu?.axis === 'column' && menu.index === index ? (
              <HandleMenu axis="column" index={index} table={block} onClose={closeMenu} />
            ) : null}
          </span>
        ))}
      </div>

      <div className="mdv-table-body">
        <div className="mdv-table-handles mdv-table-handles--rows">
          {block.rows.map((row, rowIndex) => (
            <span className="mdv-table-handle-cell" key={row.id}>
              <button
                type="button"
                className={`mdv-handle${rect !== null && rect.top <= rowIndex && rowIndex <= rect.bottom ? ' is-active' : ''}`}
                aria-label={rowIndex === 0 ? 'Header row options' : `Row ${String(rowIndex)} options`}
                aria-haspopup="menu"
                aria-expanded={menu?.axis === 'row' && menu.index === rowIndex}
                onClick={(event) => {
                  selectRow(rowIndex)();
                  event.stopPropagation();
                  setMenu((current) =>
                    current?.axis === 'row' && current.index === rowIndex
                      ? null
                      : { axis: 'row', index: rowIndex },
                  );
                }}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              {menu?.axis === 'row' && menu.index === rowIndex ? (
                <HandleMenu axis="row" index={rowIndex} table={block} onClose={closeMenu} />
              ) : null}
            </span>
          ))}
        </div>

        <table className="mdv-table">
          <thead>
            <tr>
              {(block.rows[0]?.cells ?? []).map((cell, colIndex) => (
                <th
                  key={cell.id}
                  scope="col"
                  className={`mdv-cell${inRect(rect, 0, colIndex) ? ' is-selected' : ''}`}
                  style={alignStyle(block.align[colIndex])}
                  onPointerDown={onCellPointerDown(0, colIndex)}
                  onPointerEnter={onCellPointerEnter(0, colIndex)}
                >
                  <Editable
                    key={`${cell.id}:${String(surface.generations.get(block.id) ?? 0)}`}
                    tag="div"
                    blockId={block.id}
                    path={[0, colIndex]}
                    runs={cell.runs}
                    className="mdv-cell__text"
                  />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.slice(1).map((row, bodyIndex) => {
              const rowIndex = bodyIndex + 1;
              return (
                <tr key={row.id}>
                  {row.cells.map((cell, colIndex) => (
                    <td
                      key={cell.id}
                      className={`mdv-cell${inRect(rect, rowIndex, colIndex) ? ' is-selected' : ''}`}
                      style={alignStyle(block.align[colIndex])}
                      onPointerDown={onCellPointerDown(rowIndex, colIndex)}
                      onPointerEnter={onCellPointerEnter(rowIndex, colIndex)}
                    >
                      <Editable
                        key={`${cell.id}:${String(surface.generations.get(block.id) ?? 0)}`}
                        tag="div"
                        blockId={block.id}
                        path={[rowIndex, colIndex]}
                        runs={cell.runs}
                        className="mdv-cell__text"
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function alignStyle(align: ColumnAlign | undefined): { textAlign: 'left' | 'center' | 'right' } | undefined {
  switch (align) {
    case 'left':
      return { textAlign: 'left' };
    case 'center':
      return { textAlign: 'center' };
    case 'right':
      return { textAlign: 'right' };
    default:
      return undefined;
  }
}

export const TableView = memo(TableViewImpl);

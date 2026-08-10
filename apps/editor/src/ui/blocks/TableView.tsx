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

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
      if (reference.current !== null && !reference.current.contains(event.target as Node))
        onClose();
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
      <div className="mdv-menu__label">
        {isRow ? `Row ${String(index)}` : `Column ${String(index + 1)}`}
      </div>

      {isRow ? (
        <>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.insertRowAbove()))}
            disabled={isHeader}
          >
            Insert row above
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.insertRowBelow()))}
          >
            Insert row below
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.moveRow(-1)))}
            disabled={isHeader || index <= 1}
          >
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
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.insertColumnLeft()))}
          >
            Insert column left
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.insertColumnRight()))}
          >
            Insert column right
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={act(() => void run(commands.moveColumn(-1)))}
            disabled={index === 0}
          >
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

/**
 * Handle registration.
 *
 * The strips are siblings of the `<table>`, not part of it, so CSS has nothing
 * to say about how tall a row is or how wide a column is: those are decided by
 * the table layout algorithm from content the strips never see. Measuring is
 * the only honest answer. A handle that is merely *near* its row is worse than
 * no handle at all, because clicking it selects a line the user did not point
 * at.
 *
 * `corner` is how far the column strip must be indented for its first cell to
 * start where column 0 starts, and `lead` is the matching indent down the row
 * strip. Both are measured against the first *cell* rather than the table box,
 * which absorbs the half-pixel that `border-collapse` puts outside the rows
 * without hard-coding a border width the theme is free to change.
 */
interface HandleMetrics {
  readonly rows: readonly number[];
  readonly cols: readonly number[];
  readonly corner: number;
  readonly lead: number;
}

const NO_METRICS: HandleMetrics = { rows: [], cols: [], corner: 0, lead: 0 };

/**
 * A measured size, pinned along one axis.
 *
 * The `min-*` twin is not redundant: the stylesheet gives every handle cell a
 * 12px floor so that an unmeasured strip is still clickable, and that floor
 * would silently win over a genuinely smaller measurement and push everything
 * below it out of registration. When we have measured, the measurement is the
 * whole truth. Before the first layout effect there is nothing to say, and the
 * stylesheet keeps the strip usable.
 */
function sizeOf(
  value: number | undefined,
  axis: 'width' | 'height',
): React.CSSProperties | undefined {
  if (value === undefined) return undefined;
  return axis === 'width' ? { width: value, minWidth: value } : { height: value, minHeight: value };
}

function sameLine(a: readonly number[], b: readonly number[]): boolean {
  // Sub-pixel churn is not worth a re-render; a quarter pixel is invisible.
  return (
    a.length === b.length && a.every((value, index) => Math.abs(value - (b[index] ?? 0)) < 0.25)
  );
}

function sameMetrics(a: HandleMetrics, b: HandleMetrics): boolean {
  return (
    Math.abs(a.corner - b.corner) < 0.25 &&
    Math.abs(a.lead - b.lead) < 0.25 &&
    sameLine(a.rows, b.rows) &&
    sameLine(a.cols, b.cols)
  );
}

/**
 * Keeps the handle strips in registration with the table.
 *
 * Re-runs whenever the shape changes, so newly inserted rows and columns get
 * observed too. Writing the measurements back cannot change the table's own
 * geometry — the strips live outside it and are sized, never sizing — so the
 * observer cannot drive itself in a loop; `sameMetrics` stops the state churn
 * regardless.
 */
function useHandleMetrics(
  tableRef: React.RefObject<HTMLTableElement | null>,
  rowStripRef: React.RefObject<HTMLDivElement | null>,
  rowCount: number,
  columns: number,
): HandleMetrics {
  const [metrics, setMetrics] = useState<HandleMetrics>(NO_METRICS);

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (table === null) return;

    const measure = (): void => {
      const rows = Array.from(table.rows, (row) => row.getBoundingClientRect().height);
      const header = table.rows.item(0);
      const cols =
        header === null
          ? []
          : Array.from(header.cells, (cell) => cell.getBoundingClientRect().width);
      const strip = rowStripRef.current;
      const origin =
        header?.cells.item(0)?.getBoundingClientRect() ?? table.getBoundingClientRect();
      const corner = strip === null ? 0 : origin.left - strip.getBoundingClientRect().left;
      const lead = origin.top - table.getBoundingClientRect().top;
      const next: HandleMetrics = { rows, cols, corner, lead };
      setMetrics((current) => (sameMetrics(current, next) ? current : next));
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(table);
    // A row can change height, or a column its share of the width, without the
    // table's own box moving at all. Watch the parts, not just the whole.
    for (const row of Array.from(table.rows)) observer.observe(row);
    const header = table.rows.item(0);
    if (header !== null) for (const cell of Array.from(header.cells)) observer.observe(cell);

    return () => {
      observer.disconnect();
    };
  }, [tableRef, rowStripRef, rowCount, columns]);

  return metrics;
}

function TableViewImpl({ block }: { readonly block: TableBlock }): ReactElement {
  const { select, doc } = useEditorApi();
  const surface = useSurface();
  const [menu, setMenu] = useState<OpenMenu | null>(null);
  const dragAnchor = useRef<{ row: number; col: number } | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const rowStripRef = useRef<HTMLDivElement | null>(null);

  const columns = columnCount(block);
  const metrics = useHandleMetrics(tableRef, rowStripRef, block.rows.length, columns);
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
        <span
          className="mdv-table-corner"
          style={
            metrics.corner > 0 ? { width: metrics.corner, minWidth: metrics.corner } : undefined
          }
        />
        {Array.from({ length: columns }, (_, index) => (
          <span
            className="mdv-table-handle-cell"
            key={`col-${String(index)}`}
            style={sizeOf(metrics.cols[index], 'width')}
          >
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
        <div
          className="mdv-table-handles mdv-table-handles--rows"
          ref={rowStripRef}
          style={metrics.lead > 0 ? { paddingTop: metrics.lead } : undefined}
        >
          {block.rows.map((row, rowIndex) => (
            <span
              className="mdv-table-handle-cell"
              key={row.id}
              style={sizeOf(metrics.rows[rowIndex], 'height')}
            >
              <button
                type="button"
                className={`mdv-handle${rect !== null && rect.top <= rowIndex && rowIndex <= rect.bottom ? ' is-active' : ''}`}
                aria-label={
                  rowIndex === 0 ? 'Header row options' : `Row ${String(rowIndex)} options`
                }
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

        <table className="mdv-table" ref={tableRef}>
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

function alignStyle(
  align: ColumnAlign | undefined,
): { textAlign: 'left' | 'center' | 'right' } | undefined {
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

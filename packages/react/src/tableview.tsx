/**
 * The table view (SPEC 12.3).
 *
 * > **Every visual block MUST make its underlying data reachable as a table.**
 * > Default `table: details` renders a collapsed `<details>` element after the
 * > chart containing an accessible `<table>` with a `<caption>`, proper header
 * > scopes, and formatted values.
 *
 * This is a real alternative rendering, not a visually-hidden dump: it is a
 * `<table>` a sighted keyboard user can open, read, select and copy out of. That
 * is the point — the table view is the reason tooltips may never gate a value
 * (SPEC 7.5) and the reason PDF export is lossless.
 *
 * **Cells are not formatted here.** `A11yTable.rows` is already formatted
 * strings, produced once in layout so the screen, the PDF and the CLI cannot
 * disagree. Re-formatting them in the DOM renderer would reintroduce exactly the
 * divergence the scene graph exists to prevent.
 */

import { useCallback, useId, type ReactElement, type SyntheticEvent } from 'react';
import type { A11yColumn, A11yTable } from '@mdv/core';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/** Props for {@link MdvTableView}. */
export interface MdvTableViewProps {
  table: A11yTable;
  /** Open state for the `details` presentation. Controlled, so <kbd>T</kbd> can toggle it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Element id for the `<details>`, so the chart can point at it. */
  id?: string;
  /** Ref for the `<summary>`, so <kbd>T</kbd> can move focus into the table. */
  summaryRef?: React.RefObject<HTMLElement | null>;
}

/** Alignment class for a column (SPEC 12.3: quantities right-align). */
function alignClass(column: A11yColumn): string {
  switch (column.align) {
    case 'right':
      return CLS.alignRight;
    case 'center':
      return CLS.alignCenter;
    default:
      return CLS.alignLeft;
  }
}

/**
 * Whether the first column is a row header.
 *
 * A category column identifies its row, so it is a `<th scope="row">`; a table
 * whose first column is a quantity has no row header and every cell is a `<td>`.
 * Marking a number as a row header would have a screen reader announce "1,240"
 * before every value in the row.
 */
function hasRowHeader(columns: readonly A11yColumn[]): boolean {
  const first = columns[0];
  if (first === undefined || columns.length < 2) return false;
  return first.type !== 'number' && first.type !== 'integer';
}

/** The `<table>` itself, without any wrapper. */
function DataTable({ table }: { table: A11yTable }): ReactElement {
  const rowHeader = hasRowHeader(table.columns);
  return (
    <table className={CLS.dataTable}>
      <caption>{table.caption}</caption>
      <thead>
        <tr>
          {table.columns.map((column, index) => (
            <th key={`${String(index)}-${column.name}`} scope="col" className={alignClass(column)}>
              {column.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {table.columns.map((column, columnIndex) => {
              // Cells are already formatted strings; a short row is a hole in
              // the data, shown as an empty cell rather than as `undefined`.
              const cell = row[columnIndex] ?? '';
              const className = alignClass(column);
              return columnIndex === 0 && rowHeader ? (
                <th key={columnIndex} scope="row" className={className}>
                  {cell}
                </th>
              ) : (
                <td key={columnIndex} className={className}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Render a block's data as a table, in whichever presentation SPEC 12.3 asked
 * for.
 *
 * - `details` — collapsed `<details>` after the chart. The default.
 * - `visible` — always shown.
 * - `hidden` — in the accessibility tree, out of the visual flow.
 * - `none` — nothing. Layout has already emitted `MDV3090` (info) for this, and
 *   it is permitted only when the same data is visible elsewhere.
 */
export function MdvTableView(props: MdvTableViewProps): ReactElement | null {
  const { table } = props;
  const generatedId = useId();
  const id = props.id ?? generatedId;

  const onToggle = useCallback(
    (event: SyntheticEvent<HTMLDetailsElement>) => {
      props.onOpenChange?.(event.currentTarget.open);
    },
    [props],
  );

  if (table.presentation === 'none') return null;

  if (table.presentation === 'visible') {
    return (
      <div className={CLS.tableView} id={id}>
        <DataTable table={table} />
      </div>
    );
  }

  if (table.presentation === 'hidden') {
    return (
      <div className={`${CLS.tableView} ${CLS.visuallyHidden}`} id={id}>
        <DataTable table={table} />
      </div>
    );
  }

  return (
    <details className={CLS.tableView} id={id} open={props.open ?? false} onToggle={onToggle}>
      {/*
        The summary is the second tab stop of the block, after the chart itself
        (SPEC 12.4). Its label names the table rather than saying "details", so
        it is meaningful out of context in a list of links and landmarks.
      */}
      <summary className={CLS.tableSummary} ref={props.summaryRef as React.Ref<HTMLElement>}>
        {table.caption}
      </summary>
      <DataTable table={table} />
    </details>
  );
}

/**
 * Faceting — small multiples (SPEC 7.6).
 *
 * `row:` and `column:` split one block into panels over a field's values. The
 * panels sit on a **uniform grid**, and by default they **share their scales**:
 * that shared scale is the entire reason small multiples work, because it is
 * what makes two panels comparable at a glance. `shareY: false` is legal and
 * emits `MDV3030` (info), because unshared scales invite exactly the false
 * comparison the form exists to enable.
 *
 * Panel *identity* follows the same first-appearance rule as series identity
 * (SPEC 11.2 rule 1): the order panels appear in is the order their values first
 * appear in the data, so adding a filter does not reshuffle the grid.
 *
 * Axes are drawn on the outer panels only — the left column carries the value
 * axis, the bottom row of each column carries the category axis. Repeating an
 * identical ladder in every cell is ink that is not data (SPEC 11.4).
 */

import type { BlockAttrs } from '../types/attrs.js';
import { facetWrapOf } from '../types/attrs.js';
import type { Table, Value } from '../types/data.js';
import type { Rect } from '../types/layout.js';
import { columnIndex, identityKey } from '../encode/table-access.js';

/** Gap between panels, in px. */
export const FACET_GAP = 12;
/** Height reserved for a panel's title. */
export const FACET_TITLE_HEIGHT = 18;

/** One panel of the grid. */
export interface FacetPanel {
  /** Row-major index. */
  index: number;
  row: number;
  column: number;
  /** The `row:` field's value for this panel, when faceting by row. */
  rowValue: string | undefined;
  /** The `column:` field's value for this panel, when faceting by column. */
  columnValue: string | undefined;
  /** Panel heading. */
  title: string;
  /** Indices into the prepared table, ascending. */
  rowIndices: number[];
  /** The panel's rectangle, including its title band. */
  rect: Rect;
  /** The plot area of the panel, below the title. */
  body: Rect;
  /** Draw the value axis here (leftmost column). */
  showValueAxis: boolean;
  /** Draw the category axis here (bottom row). */
  showCategoryAxis: boolean;
}

/** The whole plan. */
export interface FacetPlan {
  panels: FacetPanel[];
  rows: number;
  columns: number;
  shareX: boolean;
  shareY: boolean;
  /** The field driving rows, when there is one. */
  rowField: string | undefined;
  /** The field driving columns, when there is one. */
  columnField: string | undefined;
}

/** Options for {@link planFacets}. */
export interface FacetPlanOptions {
  attrs: BlockAttrs;
  table: Table;
  /** The area the whole grid must fit into. */
  area: Rect;
  /** Cap on panels, so a 5 000-value field cannot allocate 5 000 panels. */
  maxPanels?: number;
}

/** Default cap on panel count. Beyond this, faceting is not the right form. */
export const MAX_FACET_PANELS = 100;

/**
 * Plan the facet grid.
 *
 * @returns `undefined` when the block is not faceted, which is the common case
 * and costs one property read.
 */
export function planFacets(options: FacetPlanOptions): FacetPlan | undefined {
  const rowField = nonEmpty(options.attrs.row);
  const columnField = nonEmpty(options.attrs.column);
  if (rowField === undefined && columnField === undefined) return undefined;

  const rowValues = rowField === undefined ? [undefined] : distinct(options.table, rowField);
  const columnValues =
    columnField === undefined ? [undefined] : distinct(options.table, columnField);

  if (rowValues.length === 0 || columnValues.length === 0) return undefined;

  // `columns:` wraps a single-axis facet into a grid; a two-axis facet already
  // has its grid and ignores it. A `table` block's `columns:` map shares the
  // name and means something else entirely (SPEC 10.1), so go through the
  // discriminator rather than reading the attribute — a facet-on-a-table would
  // otherwise wrap by whatever `Math.floor` made of an object.
  const wrap = facetWrapOf(options.attrs);
  const oneDimensional = rowField === undefined || columnField === undefined;
  const cells: { rowValue: string | undefined; columnValue: string | undefined }[] = [];
  for (const rowValue of rowValues) {
    for (const columnValue of columnValues) cells.push({ rowValue, columnValue });
  }
  const capped = cells.slice(0, Math.max(1, options.maxPanels ?? MAX_FACET_PANELS));

  let columns: number;
  let rows: number;
  if (oneDimensional && wrap !== undefined) {
    // `facetWrapOf` has already floored it and rejected anything below 1.
    columns = Math.min(wrap, capped.length);
    rows = Math.ceil(capped.length / columns);
  } else if (oneDimensional) {
    columns = rowField === undefined ? capped.length : 1;
    rows = Math.ceil(capped.length / Math.max(1, columns));
  } else {
    columns = columnValues.length;
    rows = rowValues.length;
  }
  columns = Math.max(1, columns);
  rows = Math.max(1, rows);

  const rowIndexField = rowField === undefined ? -1 : columnIndex(options.table, rowField);
  const columnIndexField = columnField === undefined ? -1 : columnIndex(options.table, columnField);

  const cellWidth = (options.area.width - FACET_GAP * (columns - 1)) / columns;
  const cellHeight = (options.area.height - FACET_GAP * (rows - 1)) / rows;

  const panels: FacetPanel[] = capped.map((cell, index) => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const rect: Rect = {
      x: options.area.x + column * (cellWidth + FACET_GAP),
      y: options.area.y + row * (cellHeight + FACET_GAP),
      width: Math.max(0, cellWidth),
      height: Math.max(0, cellHeight),
    };
    const body: Rect = {
      x: rect.x,
      y: rect.y + FACET_TITLE_HEIGHT,
      width: rect.width,
      height: Math.max(0, rect.height - FACET_TITLE_HEIGHT),
    };
    const rowIndices = selectRows(
      options.table,
      rowIndexField,
      cell.rowValue,
      columnIndexField,
      cell.columnValue,
    );
    return {
      index,
      row,
      column,
      rowValue: cell.rowValue,
      columnValue: cell.columnValue,
      title: panelTitle(cell.rowValue, cell.columnValue),
      rowIndices,
      rect,
      body,
      showValueAxis: column === 0,
      showCategoryAxis: row === rows - 1 || index + columns >= capped.length,
    };
  });

  return {
    panels,
    rows,
    columns,
    shareX: options.attrs.shareX !== false,
    shareY: options.attrs.shareY !== false,
    rowField,
    columnField,
  };
}

/** Distinct values of a field, in first-appearance order. */
function distinct(table: Table, field: string): string[] {
  const index = columnIndex(table, field);
  if (index === -1) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of table.rows) {
    const key = identityKey((row[index] ?? null) as Value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Row indices matching a cell's row and column values. */
function selectRows(
  table: Table,
  rowIndexField: number,
  rowValue: string | undefined,
  columnIndexField: number,
  columnValue: string | undefined,
): number[] {
  const out: number[] = [];
  for (let r = 0; r < table.rows.length; ++r) {
    const row = table.rows[r];
    if (row === undefined) continue;
    if (rowValue !== undefined && rowIndexField >= 0) {
      if (identityKey((row[rowIndexField] ?? null) as Value) !== rowValue) continue;
    }
    if (columnValue !== undefined && columnIndexField >= 0) {
      if (identityKey((row[columnIndexField] ?? null) as Value) !== columnValue) continue;
    }
    out.push(r);
  }
  return out;
}

/** `EMEA`, `Q1`, or `EMEA · Q1`. */
function panelTitle(rowValue: string | undefined, columnValue: string | undefined): string {
  if (rowValue !== undefined && columnValue !== undefined) return `${rowValue} · ${columnValue}`;
  return rowValue ?? columnValue ?? '';
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * A view of `table` containing only the given rows.
 *
 * Row *arrays* are shared, not copied: a prepared table is immutable by contract
 * ("Never mutate it — it is memoised and shared with other blocks"), so sharing
 * is safe and keeps a 20-panel facet from copying the data twenty times.
 */
export function facetSubtable(table: Table, rowIndices: readonly number[]): Table {
  const rows: Value[][] = [];
  for (const index of rowIndices) {
    const row = table.rows[index];
    if (row !== undefined) rows.push(row);
  }
  return { fields: table.fields, rows };
}

/**
 * `true` when the author turned off a shared scale, which is `MDV3030` (info).
 *
 * Not an error: there are legitimate reasons — panels measuring different
 * quantities — but every one of them is worth stating in the caption, and a lint
 * run should surface the choice.
 */
export function unsharedScaleRequested(plan: FacetPlan): boolean {
  return !plan.shareY || !plan.shareX;
}

/**
 * The table view (SPEC 12.3).
 *
 * > **Every visual block MUST make its underlying data reachable as a table.**
 *
 * This is the requirement that makes two other rules affordable: tooltips may
 * never gate a value (SPEC 7.5), and PDF export is lossless (SPEC 28). Both hold
 * because whatever the chart draws, the numbers are also *here*.
 *
 * Cells are formatted **once**, in layout, and stored as strings. A DOM renderer
 * and the PDF exporter must not re-format them or the two would disagree — and
 * the whole point of a lossless export is that they cannot.
 */

import type { Column, Table } from '../types/data.js';
import type { A11yColumn, A11yTable } from '../types/scene.js';
import { formatValue } from '../scale/format.js';
import { columnTitle, isQuantitativeType } from '../encode/table-access.js';

/** How the table is presented (SPEC 12.3). `none` emits `MDV3090`. */
export type TablePresentation = A11yTable['presentation'];

/** Options for {@link buildA11yTable}. */
export interface A11yTableOptions {
  table: Table;
  /**
   * Columns to project, in channel order. Defaults to every field — a chart that
   * binds three of twelve columns should pass the three, because a table view
   * with nine irrelevant columns is not reachable data, it is noise.
   */
  columns?: readonly Column[];
  caption: string;
  presentation: TablePresentation;
  locale: string;
  timezone: string;
  /** Hard cap on emitted rows, to bound the DOM of a 100 000-row dataset. */
  maxRows?: number;
}

/** Default row cap. Beyond this the caption says how many were omitted. */
export const DEFAULT_TABLE_ROW_CAP = 1000;

/** Alignment for a field type: quantities right, everything else left. */
export function alignmentFor(type: string): A11yColumn['align'] {
  return isQuantitativeType(type) ? 'right' : 'left';
}

/**
 * Project a prepared table into the accessible table view.
 *
 * Never throws and never returns `undefined`: a block with no data still gets a
 * table, with its columns and no rows, because the error card renders the table
 * too (SPEC 14.1 principle 2).
 */
export function buildA11yTable(options: A11yTableOptions): A11yTable {
  const source = options.table;
  const chosen =
    options.columns !== undefined && options.columns.length > 0 ? options.columns : source.fields;

  // Resolve each projected column to its index once; a per-cell name lookup over
  // a 10 000-row table is the difference between 2 ms and 200 ms.
  const indices: number[] = [];
  const columns: A11yColumn[] = [];
  for (const wanted of chosen) {
    const index = source.fields.findIndex((field) => field.name === wanted.name);
    if (index === -1) continue;
    indices.push(index);
    columns.push({
      name: columnTitle(wanted, wanted.name),
      type: wanted.type,
      align: alignmentFor(wanted.type),
    });
  }

  const cap = options.maxRows ?? DEFAULT_TABLE_ROW_CAP;
  const limit = Math.min(source.rows.length, Math.max(0, cap));
  const ctx = { locale: options.locale, timezone: options.timezone };

  const rows: string[][] = [];
  for (let r = 0; r < limit; ++r) {
    const sourceRow = source.rows[r];
    if (sourceRow === undefined) continue;
    const row: string[] = [];
    for (let c = 0; c < indices.length; ++c) {
      const index = indices[c] as number;
      const field = source.fields[index];
      row.push(formatValue(sourceRow[index] ?? null, field?.format, ctx));
    }
    rows.push(row);
  }

  const omitted = source.rows.length - limit;
  const caption =
    omitted > 0
      ? `${options.caption} (first ${limit} of ${source.rows.length} rows)`
      : options.caption;

  return { caption, columns, rows, presentation: options.presentation };
}

/**
 * The caption for a generated table view.
 *
 * The block's title when it has one — the table is the same data under a
 * different presentation and deserves the same heading.
 */
export function defaultTableCaption(title: string | undefined, blockType: string): string {
  if (title !== undefined && title !== '') return title;
  return `${blockType.charAt(0).toUpperCase()}${blockType.slice(1)} chart data`;
}

/**
 * The table view (SPEC 12.3) and generated descriptions (SPEC 12.2).
 *
 * > **Every visual block MUST make its underlying data reachable as a table.**
 *
 * Cells are **already formatted strings**: the DOM renderer and the PDF exporter
 * must not re-format, or screen and print would disagree and the export would
 * stop being lossless (SPEC 12.3).
 *
 * Descriptions are contributed through {@link ChartType.describe} — the registry
 * contract's own path — so core marks them `descGenerated: true` and authoring
 * tools can prompt for a better one. No chart type writes an `A11yTree`.
 */

import type { A11yColumn, A11yTable, BlockAttrs, Column, DataType, Table, TableViewAttr } from '@mdv/core';
import { channelFormat, cell, humaniseColumn, isQuantitative } from './table.js';
import { formatValue } from './format.js';
import { compareNumbers } from './num.js';

/** Right-align quantities, left-align everything else (SPEC 12.3). */
export function alignFor(type: DataType | undefined): A11yColumn['align'] {
  return isQuantitative(type) ? 'right' : 'left';
}

/** How the table view is presented, from the `table` attribute (SPEC 8.1). */
export function presentationOf(attrs: BlockAttrs): TableViewAttr {
  return attrs.table ?? 'details';
}

/** One column of the table view, with its formatting. */
export interface TableViewColumn {
  column: Column;
  index: number;
  format?: string | undefined;
  /** Overrides the humanised header. */
  label?: string | undefined;
}

/**
 * Project the prepared table onto the bound columns.
 *
 * Only the columns a chart actually reads appear: dumping every column of a
 * hundred-column dataset under a two-column chart is not "reachable data", it is
 * noise that hides the values the chart is about.
 */
export function buildA11yTable(
  table: Table,
  columns: readonly TableViewColumn[],
  caption: string,
  presentation: TableViewAttr,
): A11yTable {
  const used = columns.filter((entry) => entry.index >= 0);
  const view: A11yTable = {
    caption,
    columns: used.map((entry) => ({
      name: entry.label ?? humaniseColumn(entry.column),
      type: entry.column.type,
      align: alignFor(entry.column.type),
    })),
    rows: [],
    presentation,
  };
  for (let row = 0; row < table.rows.length; row += 1) {
    view.rows.push(
      used.map((entry) => formatValue(cell(table, row, entry.index), entry.format ?? entry.column.format)),
    );
  }
  return view;
}

/** Build a {@link TableViewColumn} from a bound channel. */
export function viewColumn(
  bound: { column: Column; index: number; channel?: { format?: string } } | undefined,
): TableViewColumn | undefined {
  if (bound === undefined) return undefined;
  const format = channelFormat(bound.channel, bound.column);
  return { column: bound.column, index: bound.index, ...(format === undefined ? {} : { format }) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Generated descriptions (SPEC 12.2)
// ─────────────────────────────────────────────────────────────────────────────

/** The pieces a generated description is assembled from. */
export interface DescriptionParts {
  /** "Bar chart", "Line chart", … — a full sentence opener. */
  chartKind: string;
  /** "Revenue by quarter" — what the chart is of. */
  subject?: string;
  /** "4 categories", "3 series over 12 dates". */
  scope?: string;
  /** The extent sentence, already formatted. */
  range?: string;
  /** "Highest: Q4." */
  extreme?: string;
}

/**
 * Assemble a description in the shape SPEC 12.2 specifies:
 *
 * > "Bar chart. Revenue by quarter, 4 categories. Values range from 1,240 in Q1
 * > to 1,893 in Q4. Highest: Q4."
 */
export function composeDescription(parts: DescriptionParts): string {
  const sentences: string[] = [`${parts.chartKind}.`];
  const subject = [parts.subject, parts.scope].filter((s): s is string => s !== undefined && s !== '').join(', ');
  if (subject !== '') sentences.push(`${subject}.`);
  if (parts.range !== undefined && parts.range !== '') sentences.push(`${parts.range}.`);
  if (parts.extreme !== undefined && parts.extreme !== '') sentences.push(`${parts.extreme}.`);
  return sentences.join(' ');
}

/** "Revenue by quarter" from the measure and category titles. */
export function subjectPhrase(measure: string | undefined, by: string | undefined): string | undefined {
  if (measure === undefined || measure === '') return undefined;
  if (by === undefined || by === '') return measure;
  return `${measure} by ${by.toLowerCase()}`;
}

/** A count phrase that gets its plural right: "1 category", "4 categories". */
export function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** The lowest and highest labelled observation, for the extent sentence. */
export interface LabelledExtreme {
  label: string;
  value: number;
  formatted: string;
}

/** Find the min and max of labelled values; `undefined` when there are none. */
export function extremesOf(
  entries: readonly { label: string; value: number }[],
  format: (value: number) => string,
): { low: LabelledExtreme; high: LabelledExtreme } | undefined {
  let low: { label: string; value: number } | undefined;
  let high: { label: string; value: number } | undefined;
  for (const entry of entries) {
    if (!Number.isFinite(entry.value)) continue;
    if (low === undefined || compareNumbers(entry.value, low.value) < 0) low = entry;
    if (high === undefined || compareNumbers(entry.value, high.value) > 0) high = entry;
  }
  if (low === undefined || high === undefined) return undefined;
  return {
    low: { ...low, formatted: format(low.value) },
    high: { ...high, formatted: format(high.value) },
  };
}

/**
 * Serialising a resolved table (SPEC 6.1) for `mdv data` and `mdv export --to csv`.
 *
 * Values are written **faithfully**, not through the 3-decimal display formatter
 * of SPEC 24.3 rule 4: that rule governs the scene graph, where a number is a
 * coordinate. Rounding a data export would silently change the data. What the two
 * do share is that nothing here reads a locale or a timezone — a `Date` is an ISO
 * 8601 instant in UTC and a number is JavaScript's shortest round-trip form.
 */

import type { Table, Value } from '@mdv/core';

/** One cell as text, deterministically. */
export function cellText(value: Value): string {
  if (value === null) return '';
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  if (typeof value === 'number') {
    // `-0` prints as `0`: the sign is invisible in every other representation
    // and would make two identical exports differ (SPEC 24.3 rule 4).
    if (Object.is(value, -0)) return '0';
    return Number.isFinite(value) ? String(value) : '';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

/** RFC 4180 quoting. */
function csvCell(text: string): string {
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A table as RFC 4180 CSV with a header row and CRLF-free LF line endings. */
export function tableToCsv(table: Table): string {
  const lines: string[] = [table.fields.map((field) => csvCell(field.name)).join(',')];
  for (const row of table.rows) {
    const cells: string[] = [];
    for (let i = 0; i < table.fields.length; ++i) {
      cells.push(csvCell(cellText(row[i] ?? null)));
    }
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** A table as an array of row objects, plus its inferred field types. */
export function tableToJson(table: Table): string {
  const rows = table.rows.map((row) => {
    const object: Record<string, string | number | boolean | null> = {};
    for (let i = 0; i < table.fields.length; ++i) {
      const field = table.fields[i];
      if (field === undefined) continue;
      const value = row[i] ?? null;
      object[field.name] =
        value instanceof Date
          ? cellText(value)
          : typeof value === 'number' && !Number.isFinite(value)
            ? null
            : value;
    }
    return object;
  });
  const payload = {
    fields: table.fields.map((field) => ({
      name: field.name,
      type: field.type,
      ...(field.inferred === true ? { inferred: true } : {}),
    })),
    rows,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Longest display width in a column, counting codepoints rather than UTF-16 units. */
function widthOf(text: string): number {
  return [...text].length;
}

function pad(text: string, width: number, right: boolean): string {
  const gap = ' '.repeat(Math.max(0, width - widthOf(text)));
  return right ? `${gap}${text}` : `${text}${gap}`;
}

/**
 * A table as aligned monospace text, for the terminal.
 *
 * Numeric columns are right-aligned so magnitudes line up, which is the whole
 * reason to print a table in a terminal at all.
 */
export function tableToText(table: Table, maxRows = 20): string {
  if (table.fields.length === 0) return '(no columns)\n';

  const numeric = table.fields.map((field) => field.type === 'number');
  const shown = table.rows.slice(0, maxRows);
  const cells = shown.map((row) => table.fields.map((_, index) => cellText(row[index] ?? null)));

  const widths = table.fields.map((field, index) => {
    let width = widthOf(field.name);
    for (const row of cells) width = Math.max(width, widthOf(row[index] ?? ''));
    return width;
  });

  const lines: string[] = [];
  lines.push(
    table.fields
      .map((field, index) => pad(field.name, widths[index] ?? 0, numeric[index] === true))
      .join('  '),
  );
  lines.push(widths.map((width) => '─'.repeat(width)).join('  '));
  for (const row of cells) {
    lines.push(
      row.map((text, index) => pad(text, widths[index] ?? 0, numeric[index] === true)).join('  '),
    );
  }
  if (table.rows.length > shown.length) {
    lines.push(
      `… ${table.rows.length - shown.length} more row${table.rows.length - shown.length === 1 ? '' : 's'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

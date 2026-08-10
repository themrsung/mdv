/**
 * From {@link ParsedData} to a {@link Table} (SPEC 6.1): field naming, null
 * normalisation, inference, coercion, and the SPEC 13.6 shape limits.
 *
 * Diagnostics are emitted **per column or per table**, never per row: a 100 000
 * row CSV with a bad numeric column must produce one `MDV2151` naming the column
 * and the count, not 100 000 identical diagnostics that bury everything else.
 */

import type { Column, DataType, FieldDecl, Table, Value } from '../types/data.js';
import type { DiagCollector } from './diag.js';
import { coerceCell, inferColumnType } from './infer.js';
import type { EffectiveLimits } from './limits.js';
import { createNullMatcher } from './nulls.js';
import type { ParsedData, RawCell } from './raw.js';
import type { TimeZoneSpec } from './temporal.js';

/** Options for {@link buildTable}. */
export interface BuildOptions {
  /** `fields:` declarations, keyed by the field's name as written. */
  fields?: Readonly<Record<string, FieldDecl>> | undefined;
  /** `nullValues:` — replaces the SPEC 6.5 default list when present. */
  nullValues?: readonly string[] | undefined;
  /** Document timezone for zone-less temporal values (SPEC 6.6). */
  timezone: TimeZoneSpec;
  limits: EffectiveLimits;
}

/** A `FieldDecl` plus the `unit:` of SPEC 6.6, which the shared type omits. */
interface FieldDeclExt extends FieldDecl {
  /** `{type: datetime, unit: ms}` — `s | ms | us | ns`. */
  unit?: string;
}

/**
 * Normalise field names (SPEC 6.1.2): trim, keep case, replace an empty name
 * with a positional one, and disambiguate duplicates by suffixing `_2`, `_3`.
 */
export function normaliseFieldNames(
  raw: readonly string[],
  diag: DiagCollector,
): { names: string[]; originals: string[] } {
  const names: string[] = [];
  const originals: string[] = [];
  const used = new Map<string, number>();
  const duplicated: string[] = [];

  for (let i = 0; i < raw.length; i += 1) {
    const trimmed = (raw[i] ?? '').trim();
    const base = trimmed === '' ? `column_${i + 1}` : trimmed;
    originals.push(base);
    const seen = used.get(base);
    if (seen === undefined) {
      used.set(base, 1);
      names.push(base);
      continue;
    }
    let next = seen + 1;
    let candidate = `${base}_${next}`;
    while (used.has(candidate)) {
      next += 1;
      candidate = `${base}_${next}`;
    }
    used.set(base, next);
    used.set(candidate, 1);
    names.push(candidate);
    if (!duplicated.includes(base)) duplicated.push(base);
  }

  if (duplicated.length > 0) {
    diag.emit('MDV2110', {
      message: `Duplicate field name${duplicated.length > 1 ? 's' : ''} ${duplicated
        .map((d) => `\`${d}\``)
        .join(', ')} — suffixed`,
      detail: 'Field names are compared case-sensitively after trimming (SPEC 6.1.2).',
    });
  }
  return { names, originals };
}

/** Build the prepared {@link Table}. Never throws. */
export function buildTable(parsed: ParsedData, options: BuildOptions, diag: DiagCollector): Table {
  const limits = options.limits;

  let rawNames = parsed.fields;
  if (rawNames.length > limits.maxFieldsPerTable) {
    diag.emit('MDV4031', {
      message: `Table has ${rawNames.length} fields; the limit is ${limits.maxFieldsPerTable}`,
      detail: 'Extra fields were dropped (SPEC 13.6).',
    });
    rawNames = rawNames.slice(0, limits.maxFieldsPerTable);
  }

  const { names, originals } = normaliseFieldNames(rawNames, diag);
  const width = names.length;

  // ── Row shape ────────────────────────────────────────────────────────────
  let sourceRows = parsed.rows;
  if (sourceRows.length > limits.maxRowsPerBlock) {
    diag.emit('MDV4031', {
      message: `Data has ${sourceRows.length} rows; the limit is ${limits.maxRowsPerBlock}`,
      detail: 'The table was truncated (SPEC 13.6).',
    });
    sourceRows = sourceRows.slice(0, limits.maxRowsPerBlock);
  }
  if (width > 0 && sourceRows.length * width > limits.maxCellsPerTable) {
    const allowed = Math.max(0, Math.floor(limits.maxCellsPerTable / width));
    diag.emit('MDV4031', {
      message: `Data has ${sourceRows.length * width} cells; the limit is ${limits.maxCellsPerTable}`,
      detail: `The table was truncated to ${allowed} rows (SPEC 13.6).`,
    });
    sourceRows = sourceRows.slice(0, allowed);
  }

  const isNull = createNullMatcher(options.nullValues);
  const columns: RawCell[][] = [];
  for (let c = 0; c < width; c += 1) columns.push([]);

  let padded = 0;
  let truncated = 0;
  for (const row of sourceRows) {
    if (row.length < width) padded += 1;
    else if (row.length > width) truncated += 1;
    for (let c = 0; c < width; c += 1) {
      const cell = row[c];
      (columns[c] as RawCell[]).push(cell === undefined || isNull(cell) ? null : cell);
    }
  }

  if (padded > 0) {
    diag.emit('MDV2120', {
      message: `${padded} row${padded > 1 ? 's have' : ' has'} fewer cells than the header — padded with nulls`,
    });
  }
  if (truncated > 0) {
    diag.emit('MDV2121', {
      message: `${truncated} row${truncated > 1 ? 's have' : ' has'} more cells than the header — truncated`,
    });
  }

  // ── Types ────────────────────────────────────────────────────────────────
  const rowCount = sourceRows.length;
  const fields: Column[] = [];
  const coerced: Value[][] = [];

  for (let c = 0; c < width; c += 1) {
    const name = names[c] as string;
    const original = originals[c] as string;
    const decl = (options.fields?.[name] ?? options.fields?.[original]) as FieldDeclExt | undefined;
    const cells = columns[c] as RawCell[];

    const inferred = decl?.type === undefined;
    const type: DataType = decl?.type ?? inferColumnType(cells, rowCount, options.timezone);

    const values: Value[] = [];
    let failures = 0;
    let firstBad: string | undefined;
    for (const cell of cells) {
      const value = coerceCell(cell, {
        type,
        parse: decl?.parse,
        unit: decl?.unit,
        inferred,
        zone: options.timezone,
      });
      if (value === undefined) {
        failures += 1;
        if (firstBad === undefined) firstBad = String(cell);
        values.push(null);
      } else {
        values.push(value);
      }
    }

    if (failures > 0) {
      diag.emit('MDV2151', {
        message: `${failures} value${failures > 1 ? 's' : ''} in \`${name}\` did not parse as \`${type}\` — treated as null`,
        detail:
          firstBad === undefined
            ? undefined
            : `First offending value: \`${clip(firstBad)}\`.${
                decl?.parse === undefined
                  ? ' Add a `parse:` format if the layout is not ISO 8601.'
                  : ''
              }`,
      });
    }

    const column: Column = { name, type };
    if (decl?.format !== undefined) column.format = decl.format;
    if (decl?.parse !== undefined) column.parse = decl.parse;
    if (decl?.title !== undefined) column.title = decl.title;
    if (inferred) column.inferred = true;
    fields.push(column);
    coerced.push(values);
  }

  const rows: Value[][] = [];
  for (let r = 0; r < rowCount; r += 1) {
    const row: Value[] = [];
    for (let c = 0; c < width; c += 1) row.push((coerced[c] as Value[])[r] ?? null);
    rows.push(row);
  }

  return { fields, rows };
}

/** An empty table — what every failure path returns, so consumers have one shape. */
export function emptyTable(): Table {
  return { fields: [], rows: [] };
}

function clip(text: string): string {
  return text.length <= 40 ? text : `${text.slice(0, 37)}…`;
}

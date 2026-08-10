/**
 * Type inference (SPEC 6.1.1) and coercion.
 *
 * > If `fields:` does not declare a type, the reader infers per column by
 * > examining **all** rows (not a sample — sampling makes rendering
 * > data-dependent and therefore non-deterministic across implementations):
 * >
 * > 1. All values null/empty → `unknown`.
 * > 2. All non-null values match the boolean spellings `true`/`false` → `boolean`.
 * > 3. All non-null values parse as JSON numbers → `integer` if every value is an
 * >    integer, else `number`. Values with grouping separators or a trailing
 * >    `%`/currency symbol are **not** numbers under inference.
 * > 4. All non-null values parse as ISO 8601 → `date`, `datetime`, or `time`.
 * > 5. Distinct-value count ≤ 100 **and** ≤ 50 % of row count → `category`.
 * > 6. Otherwise → `string`.
 *
 * Inference is column-wide and never row-by-row: one bad cell in a numeric
 * column makes the whole column a string, which is visible, rather than a column
 * of mixed types, which is not.
 */

import type { DataType, Value } from '../types/data.js';
import type { RawCell } from './raw.js';
import { parseJsonNumber, parseLooseNumber } from './scalar.js';
import { parseWithPattern } from './strftime.js';
import { UNIT_MS, parseIso8601, parseIsoDuration, type TimeZoneSpec } from './temporal.js';

/** SPEC 6.1.1 step 5: at most this many distinct values to be a category. */
export const CATEGORY_MAX_DISTINCT = 100;
/** SPEC 6.1.1 step 5: and at most this share of the row count. */
export const CATEGORY_MAX_RATIO = 0.5;

/**
 * Infer the type of one column from **all** of its cells.
 *
 * @param cells - the column's values, nulls already normalised
 * @param rowCount - total rows in the table, which step 5 compares against
 * @param zone - the document timezone, for zone-less ISO values
 */
export function inferColumnType(
  cells: readonly RawCell[],
  rowCount: number,
  zone: TimeZoneSpec = 'UTC',
): DataType {
  let nonNull = 0;
  let booleans = 0;
  let numbers = 0;
  let integers = 0;
  let dates = 0;
  let datetimes = 0;
  let times = 0;
  const distinct = new Set<string>();
  let distinctOverflow = false;

  for (const cell of cells) {
    if (cell === null) continue;
    nonNull += 1;

    if (typeof cell === 'boolean') {
      booleans += 1;
    } else if (typeof cell === 'number') {
      numbers += 1;
      if (Number.isInteger(cell)) integers += 1;
    } else {
      const text = cell.trim();
      if (text === 'true' || text === 'false') booleans += 1;
      const num = parseJsonNumber(text);
      if (num !== undefined) {
        numbers += 1;
        if (Number.isInteger(num)) integers += 1;
      } else {
        const iso = parseIso8601(text, zone);
        if (iso !== undefined) {
          if (iso.kind === 'date') dates += 1;
          else if (iso.kind === 'datetime') datetimes += 1;
          else times += 1;
        }
      }
    }

    if (!distinctOverflow) {
      distinct.add(keyOf(cell));
      if (distinct.size > CATEGORY_MAX_DISTINCT) distinctOverflow = true;
    }
  }

  if (nonNull === 0) return 'unknown';
  if (booleans === nonNull) return 'boolean';
  if (numbers === nonNull) return integers === nonNull ? 'integer' : 'number';

  const temporal = dates + datetimes + times;
  if (temporal === nonNull) {
    if (datetimes > 0) return 'datetime';
    if (dates > 0) return 'date';
    return 'time';
  }

  if (
    !distinctOverflow &&
    distinct.size <= CATEGORY_MAX_DISTINCT &&
    distinct.size <= rowCount * CATEGORY_MAX_RATIO
  ) {
    return 'category';
  }
  return 'string';
}

function keyOf(cell: Exclude<RawCell, null>): string {
  return typeof cell === 'string' ? cell : `\u0000${String(cell)}`;
}

/** What a column declaration can say about coercion (SPEC 6.1.1, 6.6). */
export interface CoerceOptions {
  type: DataType;
  /** A strftime pattern from `parse:`. */
  parse?: string | undefined;
  /** Epoch unit for `{type: datetime, unit: ms}` (SPEC 6.6). */
  unit?: string | undefined;
  /** `true` when {@link type} came from inference, which forbids loose numbers. */
  inferred: boolean;
  zone: TimeZoneSpec;
}

/**
 * Coerce one cell to its column type.
 *
 * @returns the value, or `undefined` when the cell does not parse — the caller
 * turns that into `null` plus one `MDV2151` for the column. A value is never
 * silently reinterpreted as something else.
 */
export function coerceCell(cell: RawCell, options: CoerceOptions): Value | undefined {
  if (cell === null) return null;

  switch (options.type) {
    case 'boolean': {
      if (typeof cell === 'boolean') return cell;
      const text = String(cell).trim();
      if (text === 'true') return true;
      if (text === 'false') return false;
      return undefined;
    }

    case 'integer':
    case 'number': {
      const value = numberOf(cell, options.inferred);
      if (value === undefined) return undefined;
      if (options.type === 'integer' && !Number.isInteger(value)) return value;
      return value;
    }

    case 'date':
    case 'datetime':
    case 'time': {
      if (typeof cell === 'number') {
        const unit = options.unit;
        if (unit === undefined) return undefined; // SPEC 6.6: epoch numbers require an explicit unit
        const ms = UNIT_MS[unit];
        if (ms === undefined) return undefined;
        return new Date(cell * ms);
      }
      const text = String(cell).trim();
      if (options.parse !== undefined && options.parse !== '') {
        return parseWithPattern(text, options.parse, options.zone);
      }
      return parseIso8601(text, options.zone)?.date;
    }

    case 'duration': {
      if (typeof cell === 'number') {
        const ms = options.unit === undefined ? 1 : (UNIT_MS[options.unit] ?? 1);
        return cell * ms;
      }
      const text = String(cell).trim();
      const iso = parseIsoDuration(text);
      if (iso !== undefined) return iso;
      const num = parseLooseNumber(text);
      if (num === undefined) return undefined;
      const ms = options.unit === undefined ? 1 : (UNIT_MS[options.unit] ?? 1);
      return num * ms;
    }

    case 'category':
    case 'string': {
      if (typeof cell === 'string') return cell;
      return String(cell);
    }

    case 'unknown':
    default:
      return typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean'
        ? cell
        : null;
  }
}

function numberOf(cell: Exclude<RawCell, null>, inferred: boolean): number | undefined {
  if (typeof cell === 'number') return Number.isFinite(cell) ? cell : undefined;
  if (typeof cell === 'boolean') return undefined;
  const text = cell.trim();
  const strict = parseJsonNumber(text);
  if (strict !== undefined) return strict;
  // An inferred numeric column only exists when every cell was a JSON number, so
  // the loose reader is reachable only for a *declared* type — which is exactly
  // the escape hatch SPEC 6.1.1 step 3 points at.
  return inferred ? undefined : parseLooseNumber(text);
}

/** `true` for the types a scale treats as quantitative. */
export function isQuantitative(type: DataType): boolean {
  return type === 'number' || type === 'integer' || type === 'duration';
}

/** `true` for the types a scale treats as temporal. */
export function isTemporal(type: DataType): boolean {
  return type === 'date' || type === 'datetime' || type === 'time';
}

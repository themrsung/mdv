/**
 * Small, shared accessors over a prepared {@link Table}.
 *
 * Column lookup is by **case-sensitive** name (SPEC 6.1.2) and is memo-free: a
 * table is a plain structure that any stage may hold, and a cache keyed on it
 * would be the sort of hidden state SPEC 17.3 invariant 4 rules out.
 */

import type { Column, Table, Value } from '../types/data.js';
import type { ScaleInput } from '../types/encode.js';

/** Index of a field, or `-1`. */
export function columnIndex(table: Table, name: string): number {
  for (let i = 0; i < table.fields.length; ++i) {
    if ((table.fields[i] as Column).name === name) return i;
  }
  return -1;
}

/** A field by name, or `undefined`. */
export function column(table: Table, name: string): Column | undefined {
  const index = columnIndex(table, name);
  return index === -1 ? undefined : table.fields[index];
}

/** Every cell of a field, in row order. An unknown field yields an empty array. */
export function columnValues(table: Table, name: string): Value[] {
  const index = columnIndex(table, name);
  if (index === -1) return [];
  const out: Value[] = new Array<Value>(table.rows.length);
  for (let r = 0; r < table.rows.length; ++r) out[r] = (table.rows[r] as Value[])[index] ?? null;
  return out;
}

/** One cell, or `null` for an out-of-range access. */
export function cell(table: Table, row: number, name: string): Value {
  const index = columnIndex(table, name);
  if (index === -1) return null;
  return (table.rows[row]?.[index] ?? null) as Value;
}

/**
 * A cell as a scale input.
 *
 * Booleans become the strings `'true'`/`'false'` so they can key a band; every
 * other type passes through, because a scale must see a `Date` as a `Date`.
 */
export function asScaleInput(value: Value): ScaleInput | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

/** A cell as a stable identity key. Dates key by ISO instant, never by locale. */
export function identityKey(value: Value): string {
  if (value === null) return '';
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? value.toISOString() : '';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/** A cell as a finite number, or `undefined`. Dates count as their epoch ms. */
export function asNumber(value: Value): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

/**
 * Humanise a field name for a title (SPEC 7.3, "field name, humanised").
 *
 * `unit_price` → `Unit price`, `unitPrice` → `Unit price`, `GDP` → `GDP`.
 * Deliberately ASCII-mechanical: no locale casing, because `toLocaleUpperCase`
 * turns a Turkish `i` into `İ` and makes a title host-dependent (SPEC 24.3).
 */
export function humanise(name: string): string {
  if (name === '') return '';
  const spaced = name
    .replace(/[_\-.]+/g, ' ')
    // Split camelCase into sentence case — `unitPrice` is "Unit price", not
    // "Unit Price" — but leave a run of capitals alone, because `revenueUSD`
    // ends in an acronym and "Revenue Usd" is worse than either.
    .replace(
      /([a-z0-9])([A-Z])([a-z]?)/g,
      (_match, before: string, capital: string, after: string) =>
        after === '' ? `${before} ${capital}` : `${before} ${capital.toLowerCase()}${after}`,
    )
    .replace(/\s+/g, ' ')
    .trim();
  if (spaced === '') return name;
  // An all-caps token is an acronym; leave it alone.
  if (spaced === spaced.toUpperCase() && /[A-Z]/.test(spaced)) return spaced;
  const first = spaced[0] as string;
  return first.toUpperCase() + spaced.slice(1);
}

/** The display title of a column: declared title, else the humanised name. */
export function columnTitle(field: Column | undefined, name: string): string {
  if (field?.title !== undefined && field.title !== '') return field.title;
  return humanise(field?.name ?? name);
}

/** `true` for the field types that need a discrete scale. */
export function isDiscreteType(type: string | undefined): boolean {
  return type === 'string' || type === 'category' || type === 'boolean';
}

/** `true` for the field types that need a temporal scale. */
export function isTemporalType(type: string | undefined): boolean {
  return type === 'date' || type === 'datetime' || type === 'time';
}

/** `true` for the field types a quantitative channel accepts. */
export function isQuantitativeType(type: string | undefined): boolean {
  return type === 'number' || type === 'integer' || type === 'duration';
}

/**
 * Null and missing values (SPEC 6.5).
 *
 * > By default, a value is null if it is an empty cell, `null`, `NULL`, `NaN`, or
 * > `-` alone. `nullValues: ["", "N/A", "—"]` replaces that list.
 *
 * `nullValues` **replaces** the default list rather than extending it, so an
 * author who writes `nullValues: ["N/A"]` gets a literal `-` in the data.
 *
 * Nulls are never silently coerced to zero: a chart whose data has gaps MUST
 * look like it has gaps. `nullPolicy` is honoured at encode time, not here.
 */

import type { RawCell } from './raw.js';

/** The default null spellings (SPEC 6.5). */
export const DEFAULT_NULL_VALUES: readonly string[] = Object.freeze([
  '',
  'null',
  'NULL',
  'NaN',
  '-',
]);

/** How continuous marks handle nulls (SPEC 6.5). */
export type NullPolicy = 'gap' | 'skip' | 'zero' | 'drop';

/** A compiled null matcher. Case-sensitive, matched against the trimmed cell. */
export interface NullMatcher {
  (cell: RawCell): boolean;
}

/**
 * Compile a null matcher.
 *
 * @param spellings - `nullValues:` from the block or dataset; omit for the
 * SPEC 6.5 defaults.
 */
export function createNullMatcher(spellings?: readonly string[]): NullMatcher {
  const list = spellings ?? DEFAULT_NULL_VALUES;
  const set = new Set(list);
  const matchesEmpty = set.has('');
  return (cell: RawCell): boolean => {
    if (cell === null) return true;
    if (typeof cell === 'number') return !Number.isFinite(cell);
    if (typeof cell === 'boolean') return false;
    const trimmed = cell.trim();
    if (trimmed === '') return matchesEmpty;
    return set.has(trimmed) || set.has(cell);
  };
}

/** Apply a matcher, returning `null` for a missing cell and the cell otherwise. */
export function normaliseNull(cell: RawCell, isNull: NullMatcher): RawCell {
  return isNull(cell) ? null : cell;
}

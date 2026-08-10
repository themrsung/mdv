/**
 * Total, deterministic value ordering — the backbone of `sort`, `pivot` field
 * naming, and grouping.
 *
 * Two rules from SPEC 6.7 and SPEC 24.3:
 *
 * - **Nulls sort last**, in both directions: a missing value is not "small", it
 *   is absent, and burying it at the end keeps the interesting rows on screen.
 * - **No locale.** `localeCompare` depends on the host ICU version, so two
 *   machines would order the same table differently and produce different PDFs.
 *   Strings compare by code unit.
 */

import type { Value } from '../types/data.js';

/** Type rank, so a mixed column still has one total order. */
function rank(value: Value): number {
  if (value === null) return 5;
  if (typeof value === 'number') return 0;
  if (value instanceof Date) return 1;
  if (typeof value === 'boolean') return 2;
  return 3;
}

/**
 * Compare two cells. Nulls always sort last, whatever `descending` says, which
 * is why the caller passes the direction in rather than negating the result.
 */
export function compareValues(a: Value, b: Value, descending = false): number {
  const aNull = a === null;
  const bNull = b === null;
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    return aNull ? 1 : -1;
  }

  const rankA = rank(a);
  const rankB = rank(b);
  let order: number;
  if (rankA !== rankB) {
    order = rankA < rankB ? -1 : 1;
  } else if (typeof a === 'string' && typeof b === 'string') {
    order = a < b ? -1 : a > b ? 1 : 0;
  } else {
    const x = numeric(a);
    const y = numeric(b);
    order = x < y ? -1 : x > y ? 1 : 0;
  }
  return descending ? -order : order;
}

function numeric(value: Value): number {
  if (typeof value === 'number') return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'boolean') return value ? 1 : 0;
  /* c8 ignore next -- strings take the branch above; null is handled earlier. */
  return 0;
}

/**
 * A stable grouping key for a cell.
 *
 * Two values share a key only when they are the same value of the same kind:
 * the string `"1"` and the number `1` are different groups, because silently
 * merging them would make a chart depend on how a CSV happened to quote a cell.
 */
export function groupKey(value: Value): string {
  if (value === null) return '\u0000null';
  if (value instanceof Date) return `\u0000d${value.getTime()}`;
  if (typeof value === 'number') return `\u0000n${value}`;
  if (typeof value === 'boolean') return `\u0000b${value ? 1 : 0}`;
  return `s${value}`;
}

/** A key for a tuple of cells, unambiguous because each part is length-prefixed. */
export function tupleKey(values: readonly Value[]): string {
  let out = '';
  for (const value of values) {
    const part = groupKey(value);
    out += `${part.length}:${part}`;
  }
  return out;
}

/**
 * A **stable** sort by a comparator (SPEC 6.7: "Sort is stable").
 *
 * `Array.prototype.sort` is required to be stable since ES2019, but a decorated
 * sort on the index makes the guarantee explicit and independent of the engine.
 */
export function stableSort<T>(items: readonly T[], compare: (a: T, b: T) => number): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const order = compare(a.item, b.item);
      return order !== 0 ? order : a.index - b.index;
    })
    .map((entry) => entry.item);
}

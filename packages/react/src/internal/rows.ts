/**
 * `MdvBlock`'s inline `data` prop: rows of objects → a prepared `Table`.
 *
 * > Field order comes from the first row's key order, which is why insertion
 * > order matters (SPEC 24.3 rule 5).
 *
 * The rows go through core's own `buildTable`, not through a bespoke converter,
 * so a `<MdvBlock data={rows}/>` and the same numbers written as a CSV data
 * section infer the same field types, honour the same `fields:` declarations and
 * report the same diagnostics. A second implementation of type inference is a
 * second set of answers.
 */

import type { BlockAttrs, Diagnostic, MdvConfig, Table, Value } from '@mdv/core';
import type { MdvBlock, Range } from '@mdv/parser';
import { buildTable } from '@mdv/core/data/build.js';
import type { RawCell } from '@mdv/core/data/raw.js';
import { createCollector } from '@mdv/core/data/diag.js';
import { dataOptionsFrom } from '@mdv/core/resolve.js';

/** One input row. Insertion order of the first row fixes the field order. */
export type Row = Readonly<Record<string, Value>>;

/** The prepared table plus anything the preparation had to say. */
export interface RowsResult {
  table: Table;
  diagnostics: readonly Diagnostic[];
}

/**
 * A cell as `buildTable` wants it.
 *
 * `Date` has no `RawCell` spelling, so it goes in as an ISO 8601 instant, which
 * is the one temporal form SPEC 6.6 requires every reader to parse. `undefined`
 * and a missing key are both the empty cell.
 */
function toRawCell(value: Value | undefined): RawCell {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return value;
}

/**
 * Field names in first-appearance order.
 *
 * Later rows may introduce a key the first row lacked; dropping it would lose
 * data silently, so it is appended. Ragged input is the caller's, and
 * `buildTable` fills short rows with nulls.
 */
function fieldNames(rows: readonly Row[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

/** Prepare rows of objects into a table (SPEC 6.1). */
export function tableFromRows(
  rows: readonly Row[],
  attrs: BlockAttrs,
  config: MdvConfig | undefined,
): RowsResult {
  const options = dataOptionsFrom(config);
  const collector = createCollector('data');
  const fields = fieldNames(rows);

  const table = buildTable(
    {
      fields,
      rows: rows.map((row) => fields.map((name) => toRawCell(row[name]))),
    },
    {
      fields: attrs.fields,
      timezone: options.timezone,
      limits: options.limits,
    },
    collector,
  );

  return { table, diagnostics: collector.diagnostics };
}

/** A zero-width range at the document start, for a block that has no source. */
const SYNTHETIC_RANGE: Range = Object.freeze({
  start: Object.freeze({ offset: 0, line: 1, column: 1 }),
  end: Object.freeze({ offset: 0, line: 1, column: 1 }),
});

/**
 * A synthetic AST node for a `<MdvBlock>` that was never written down.
 *
 * `layoutBlock` reads `node.raw` when it has to draw an error card, and every
 * consumer of `ResolvedBlock` expects a node. Fabricating one that says what the
 * component was asked to draw is more useful than an empty string, and it keeps
 * `ResolvedBlock` honest rather than partial.
 */
export function syntheticNode(type: string, header: string, level: 1 | 2 | 3): MdvBlock {
  return {
    type: 'mdvBlock',
    blockType: type,
    attrs: {},
    attrsPosition: {},
    raw: { header, data: '', fence: '```' },
    level,
    position: {
      start: { line: 1, column: 1, offset: 0 },
      end: { line: 1, column: 1, offset: 0 },
    },
  };
}

export { SYNTHETIC_RANGE };

/**
 * Shared plumbing for the transform pipeline (SPEC 6.7).
 *
 * Every step is a pure function `(Table, params, TransformContext) → Table`.
 * The context carries what a step may read besides its input: diagnostics, the
 * document timezone and build time, the resource limits, and the one impure
 * thing a step can ask for — another dataset, for `join` — which arrives as an
 * injected lookup rather than a registry import, so this module stays free of
 * the dataset graph.
 */

import type { DiagCollector } from '../data/diag.js';
import type { FormatContext } from '../data/format.js';
import type { EffectiveLimits } from '../data/limits.js';
import type { TimeZoneSpec } from '../data/temporal.js';
import type { Column, DataType, Table, Value } from '../types/data.js';
import type { ExprValue } from '../expr/index.js';

export interface TransformContext {
  diag: DiagCollector;
  /** Document timezone (SPEC 6.6) — never the host zone. */
  zone: TimeZoneSpec;
  /** `now()` (SPEC 6.8.2). */
  buildTime: Date;
  format: FormatContext;
  limits: EffectiveLimits;
  /**
   * Resolve `join.with` (`"@other"`).
   *
   * @returns `undefined` for an unresolved or not-yet-ready dataset; the step
   * emits `MDV2142` and returns its input unchanged.
   */
  lookup?: (reference: string) => Table | undefined;
}

/** A table with no rows and no fields — the identity a failed step falls back to. */
export function cloneTable(table: Table): Table {
  return {
    fields: table.fields.map((field) => ({ ...field })),
    rows: table.rows.map((row) => [...row]),
  };
}

/** Index of every field name, first occurrence winning (SPEC 6.1.2 de-duplicates). */
export function fieldIndex(fields: readonly Column[]): Map<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field !== undefined && !index.has(field.name)) index.set(field.name, i);
  }
  return index;
}

/**
 * Look up a field, emitting `MDV2111` when it is absent.
 *
 * @returns `undefined` when the step should give up rather than invent a column.
 */
export function requireField(
  table: Table,
  name: string,
  step: string,
  diag: DiagCollector,
): number | undefined {
  const at = fieldIndex(table.fields).get(name);
  if (at === undefined) {
    diag.emit('MDV2111', {
      message: `\`${step}\` references unknown field \`${name}\``,
      detail: `The table has ${describeFields(table.fields)}. Names are case-sensitive (SPEC 6.1.2).`,
    });
    return undefined;
  }
  return at;
}

/** A short, deterministic rendering of a field list, for diagnostic details. */
export function describeFields(fields: readonly Column[]): string {
  if (fields.length === 0) return 'no fields';
  return fields.map((field) => `\`${field.name}\``).join(', ');
}

/**
 * Narrow an expression result to a cell.
 *
 * A list has no cell representation — the data model is scalar (SPEC 6.1) — so
 * it becomes null and is reported through the expression's own type-error
 * channel, one diagnostic for the whole expression.
 */
export function toCell(value: ExprValue, fail: (message: string) => void): Value {
  if (Array.isArray(value)) {
    fail('An expression produced a list, but a cell holds a single value');
    return null;
  }
  return value as Value;
}

/**
 * Infer the type of a derived column from its values (SPEC 6.1.1 in miniature).
 *
 * Column-wide and never row-by-row: one mixed value makes the whole column a
 * string, exactly as inference over raw cells does.
 */
export function typeOfValues(values: readonly Value[]): DataType {
  let sawNumber = false;
  let sawInteger = true;
  let sawBoolean = false;
  let sawDate = false;
  let sawString = false;
  let sawAny = false;

  for (const value of values) {
    if (value === null) continue;
    sawAny = true;
    if (typeof value === 'number') {
      sawNumber = true;
      if (!Number.isInteger(value)) sawInteger = false;
    } else if (typeof value === 'boolean') {
      sawBoolean = true;
    } else if (value instanceof Date) {
      sawDate = true;
    } else {
      sawString = true;
    }
  }

  if (!sawAny) return 'unknown';
  const kinds = Number(sawNumber) + Number(sawBoolean) + Number(sawDate) + Number(sawString);
  if (kinds > 1) return 'string';
  if (sawNumber) return sawInteger ? 'integer' : 'number';
  if (sawBoolean) return 'boolean';
  if (sawDate) return 'datetime';
  return 'string';
}

/**
 * Guard a produced table against the SPEC 13.6 shape limits.
 *
 * A transform can multiply rows (`join`) or fields (`pivot`), so the ceiling is
 * re-checked after every step rather than only at parse time.
 */
export function enforceLimits(table: Table, step: string, ctx: TransformContext): Table {
  const { limits, diag } = ctx;
  let out = table;

  if (out.fields.length > limits.maxFieldsPerTable) {
    diag.emit('MDV4031', {
      message: `\`${step}\` produced ${out.fields.length} fields; the limit is ${limits.maxFieldsPerTable}`,
      detail: 'Extra fields were dropped (SPEC 13.6).',
    });
    const fields = out.fields.slice(0, limits.maxFieldsPerTable);
    out = { fields, rows: out.rows.map((row) => row.slice(0, limits.maxFieldsPerTable)) };
  }

  if (out.rows.length > limits.maxRowsPerBlock) {
    diag.emit('MDV4031', {
      message: `\`${step}\` produced ${out.rows.length} rows; the limit is ${limits.maxRowsPerBlock}`,
      detail: 'The table was truncated (SPEC 13.6).',
    });
    out = { fields: out.fields, rows: out.rows.slice(0, limits.maxRowsPerBlock) };
  }

  const cells = out.rows.length * out.fields.length;
  if (cells > limits.maxCellsPerTable && out.fields.length > 0) {
    const allowed = Math.max(0, Math.floor(limits.maxCellsPerTable / out.fields.length));
    diag.emit('MDV4031', {
      message: `\`${step}\` produced ${cells} cells; the limit is ${limits.maxCellsPerTable}`,
      detail: `The table was truncated to ${allowed} rows (SPEC 13.6).`,
    });
    out = { fields: out.fields, rows: out.rows.slice(0, allowed) };
  }

  return out;
}

/**
 * Append a field, disambiguating a clash the way SPEC 6.1.2 does for headers:
 * `revenue`, `revenue_2`, `revenue_3`.
 */
export function uniqueName(taken: ReadonlySet<string>, name: string): string {
  if (!taken.has(name)) return name;
  let next = 2;
  while (taken.has(`${name}_${next}`)) next += 1;
  return `${name}_${next}`;
}

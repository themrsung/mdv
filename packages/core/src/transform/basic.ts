/**
 * The row-shaping steps of SPEC 6.7: `filter`, `derive`, `sort`, `limit`,
 * `select` and `rename`.
 *
 * Every step here returns a new table and never mutates its input — a dataset
 * feeds many blocks, and one block's pipeline must not be visible to another.
 */

import type { Column, Table, Value } from '../types/data.js';
import {
  compileExpression,
  createFieldIndex,
  createTypeErrorReporter,
  rowScope,
  truthy,
  type EvalContext,
} from '../expr/index.js';
import { compareValues, stableSort } from './order.js';
import { fieldIndex, toCell, typeOfValues, uniqueName, type TransformContext } from './context.js';

/** Build the evaluation context a compiled expression needs from a transform context. */
function evalContext(ctx: TransformContext, fail: (message: string) => void): EvalContext {
  return {
    zone: ctx.zone,
    buildTime: ctx.buildTime,
    format: ctx.format,
    aggregate: false,
    fail,
  };
}

/**
 * `filter` — keep rows where the expression is truthy. Null is false
 * (SPEC 6.7), so a missing value drops the row rather than passing it through.
 */
export function applyFilter(table: Table, source: string, ctx: TransformContext): Table {
  const compiled = compileExpression(source, ctx.diag);
  if (compiled === undefined) return table; // The diagnostic is already emitted.

  const index = createFieldIndex(table.fields);
  const missing = compiled.fields.filter((name) => !index.has(name));
  if (missing.length > 0) {
    ctx.diag.emit('MDV2111', {
      message: `\`filter\` references unknown field${missing.length > 1 ? 's' : ''} ${missing
        .map((name) => `\`${name}\``)
        .join(', ')}`,
      detail: `In \`${source}\`.`,
    });
    return table;
  }

  const reporter = createTypeErrorReporter();
  const evaluation = evalContext(ctx, reporter.fail);
  const rows = table.rows.filter((row) =>
    truthy(compiled.evaluate(rowScope(index, row), evaluation)),
  );
  reporter.finish(compiled, ctx.diag);

  return { fields: table.fields.map((field) => ({ ...field })), rows: rows.map((row) => [...row]) };
}

/**
 * `derive` — add or replace fields, "evaluated left to right; later entries see
 * earlier ones" (SPEC 6.7).
 *
 * That ordering is why this runs one expression at a time over a growing table
 * rather than compiling them all against the input: `{a: "x*2", b: "a+1"}` must
 * see the new `a`.
 */
export function applyDerive(
  table: Table,
  spec: Readonly<Record<string, string>>,
  ctx: TransformContext,
): Table {
  let fields: Column[] = table.fields.map((field) => ({ ...field }));
  let rows: Value[][] = table.rows.map((row) => [...row]);

  for (const [name, source] of Object.entries(spec)) {
    const compiled = compileExpression(source, ctx.diag);
    if (compiled === undefined) continue;

    const index = createFieldIndex(fields);
    const unknown = compiled.fields.filter((field) => !index.has(field));
    if (unknown.length > 0) {
      ctx.diag.emit('MDV2111', {
        message: `\`derive\` for \`${name}\` references unknown field${
          unknown.length > 1 ? 's' : ''
        } ${unknown.map((field) => `\`${field}\``).join(', ')}`,
        detail: `In \`${source}\`. A derived field is visible only to later entries (SPEC 6.7).`,
      });
      continue;
    }

    const reporter = createTypeErrorReporter();
    const evaluation = evalContext(ctx, reporter.fail);
    const values = rows.map((row) =>
      toCell(compiled.evaluate(rowScope(index, row), evaluation), reporter.fail),
    );
    reporter.finish(compiled, ctx.diag);

    const at = index.get(name);
    const column: Column = { name, type: typeOfValues(values), inferred: true };
    if (at === undefined) {
      fields = [...fields, column];
      rows = rows.map((row, i) => [...row, values[i] ?? null]);
    } else {
      const existing = fields[at] as Column;
      // Replacing a column keeps the author's title and format, which describe
      // the field's meaning rather than the expression that filled it.
      fields = fields.map((field, i) =>
        i === at
          ? {
              ...column,
              ...(existing.title !== undefined ? { title: existing.title } : {}),
              ...(existing.format !== undefined ? { format: existing.format } : {}),
            }
          : field,
      );
      rows = rows.map((row, i) => row.map((cell, j) => (j === at ? (values[i] ?? null) : cell)));
    }
  }

  return { fields, rows };
}

/** One `sort` key: a field name and a direction. `-revenue` is descending. */
interface SortKey {
  name: string;
  descending: boolean;
}

function parseSortKey(raw: string): SortKey {
  if (raw.startsWith('-')) return { name: raw.slice(1).trim(), descending: true };
  if (raw.startsWith('+')) return { name: raw.slice(1).trim(), descending: false };
  return { name: raw.trim(), descending: false };
}

/** `sort` — stable, multi-key, nulls last (SPEC 6.7). */
export function applySort(
  table: Table,
  spec: string | readonly string[],
  ctx: TransformContext,
): Table {
  const raw = typeof spec === 'string' ? [spec] : spec;
  const index = fieldIndex(table.fields);
  const keys: (SortKey & { at: number })[] = [];

  for (const entry of raw) {
    const key = parseSortKey(entry);
    const at = index.get(key.name);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`sort\` references unknown field \`${key.name}\``,
        detail: 'The rows were left in their original order.',
      });
      continue;
    }
    keys.push({ ...key, at });
  }
  if (keys.length === 0) return table;

  const rows = stableSort(table.rows, (a, b) => {
    for (const key of keys) {
      const order = compareValues(a[key.at] ?? null, b[key.at] ?? null, key.descending);
      if (order !== 0) return order;
    }
    return 0;
  });

  return { fields: table.fields.map((field) => ({ ...field })), rows: rows.map((row) => [...row]) };
}

/** `limit` — a row slice applied after sorting (SPEC 6.7). */
export function applyLimit(
  table: Table,
  spec: number | { n: number; offset?: number },
  ctx: TransformContext,
): Table {
  const n = typeof spec === 'number' ? spec : spec.n;
  const offset = typeof spec === 'number' ? 0 : (spec.offset ?? 0);

  if (!Number.isFinite(n) || n < 0 || !Number.isFinite(offset) || offset < 0) {
    ctx.diag.emit('MDV2501', {
      message: '`limit` needs a non-negative row count',
      detail: `Got ${JSON.stringify(spec)}.`,
    });
    return table;
  }

  const start = Math.trunc(offset);
  const rows = table.rows.slice(start, start + Math.trunc(n));
  return { fields: table.fields.map((field) => ({ ...field })), rows: rows.map((row) => [...row]) };
}

/** `select` — projection "preserving the listed order" (SPEC 6.7). */
export function applySelect(table: Table, names: readonly string[], ctx: TransformContext): Table {
  const index = fieldIndex(table.fields);
  const picked: number[] = [];
  const fields: Column[] = [];

  for (const name of names) {
    const at = index.get(name);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`select\` references unknown field \`${name}\``,
        detail: 'The field was skipped.',
      });
      continue;
    }
    picked.push(at);
    fields.push({ ...(table.fields[at] as Column) });
  }

  if (fields.length === 0) {
    ctx.diag.emit('MDV2501', {
      message: '`select` matched no fields',
      detail: 'The table was left unchanged rather than emptied.',
    });
    return table;
  }

  return { fields, rows: table.rows.map((row) => picked.map((at) => row[at] ?? null)) };
}

/** `rename` — old → new, leaving order and values untouched (SPEC 6.7). */
export function applyRename(
  table: Table,
  spec: Readonly<Record<string, string>>,
  ctx: TransformContext,
): Table {
  const index = fieldIndex(table.fields);
  const fields = table.fields.map((field) => ({ ...field }));
  const taken = new Set(fields.map((field) => field.name));

  for (const [from, to] of Object.entries(spec)) {
    const at = index.get(from);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`rename\` references unknown field \`${from}\``,
      });
      continue;
    }
    const target = fields[at] as Column;
    taken.delete(target.name);
    const name = uniqueName(taken, to);
    if (name !== to) {
      ctx.diag.emit('MDV2110', {
        message: `\`rename\` would have produced two fields named \`${to}\``,
        detail: `The second was named \`${name}\` (SPEC 6.1.2).`,
      });
    }
    target.name = name;
    taken.add(name);
  }

  return { fields, rows: table.rows.map((row) => [...row]) };
}

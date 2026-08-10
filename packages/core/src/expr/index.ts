/**
 * MDVX — the expression language (SPEC 6.8).
 *
 * The public shape is deliberately small: compile once, evaluate per row, and
 * report at most one type-error diagnostic per expression. {@link runExpression}
 * packages that discipline so no call site has to remember it.
 */

import type { DiagCollector } from '../data/diag.js';
import type { Column, Table, Value } from '../types/data.js';
import type { CompiledExpression, EvalContext, Scope } from './compile.js';
import type { ExprValue } from './values.js';

export type { BinaryOp, ExprNode, UnaryOp } from './ast.js';
export { callsIn, depthOf, fieldsIn } from './ast.js';
export type { CompiledExpression, CompileOptions, EvalContext, Scope } from './compile.js';
export { compileExpression } from './compile.js';
export type { FunctionContext, FunctionDef } from './functions.js';
export { FUNCTIONS, isWhitelisted, isoWeek, lookupFunction, percentile } from './functions.js';
export { parseExpression } from './parse.js';
export type { ParseError, ParseResult } from './parse.js';
export type { ExprValue, TypeErrorSink } from './values.js';
export { asNumber, compare, equals, isList, truthy, typeName } from './values.js';

/** Everything {@link runExpression} needs that is not the expression itself. */
export interface RunContext extends Omit<EvalContext, 'fail'> {
  diag: DiagCollector;
}

/**
 * A row scope over one table row.
 *
 * The index is built once per table, not once per row, because a wide table
 * evaluated per row would otherwise be quadratic.
 */
export function createFieldIndex(fields: readonly Column[]): ReadonlyMap<string, number> {
  const index = new Map<string, number>();
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i];
    if (field !== undefined && !index.has(field.name)) index.set(field.name, i);
  }
  return index;
}

/** A {@link Scope} over one row, backed by a shared field index. */
export function rowScope(index: ReadonlyMap<string, number>, row: readonly Value[]): Scope {
  return {
    read(name) {
      const at = index.get(name);
      if (at === undefined) return undefined;
      return row[at] ?? null;
    },
  };
}

/** A {@link Scope} over a group of rows: a field reads as the whole column. */
export function groupScope(
  index: ReadonlyMap<string, number>,
  rows: readonly (readonly Value[])[],
): Scope {
  return {
    read(name) {
      const at = index.get(name);
      if (at === undefined) return undefined;
      return rows.map((row) => row[at] ?? null);
    },
  };
}

/**
 * Evaluate one compiled expression over every row of a table.
 *
 * The type-error discipline of SPEC 6.8.3 lives here: the first failure is kept,
 * the rest are counted, and exactly one `MDV2210` is emitted at the end —
 * "one diagnostic is emitted per expression (not per row)".
 *
 * @returns one value per row, in row order.
 */
export function runExpression(
  compiled: CompiledExpression,
  table: Table,
  ctx: RunContext,
): ExprValue[] {
  const index = createFieldIndex(table.fields);
  reportMissingFields(compiled, index, ctx.diag);

  let firstError: string | undefined;
  let errorCount = 0;
  const evalCtx: EvalContext = {
    zone: ctx.zone,
    buildTime: ctx.buildTime,
    format: ctx.format,
    aggregate: ctx.aggregate,
    fail(message) {
      errorCount += 1;
      firstError ??= message;
    },
  };

  const out: ExprValue[] = [];
  for (const row of table.rows) {
    out.push(compiled.evaluate(rowScope(index, row), evalCtx));
  }

  reportTypeErrors(compiled, firstError, errorCount, ctx.diag);
  return out;
}

/**
 * Evaluate once against a prepared scope, with the same one-diagnostic rule.
 * Used by `aggregate`, where the scope is a group rather than a row.
 */
export function runExpressionOnce(
  compiled: CompiledExpression,
  scope: Scope,
  ctx: RunContext,
): ExprValue {
  let firstError: string | undefined;
  let errorCount = 0;
  const value = compiled.evaluate(scope, {
    zone: ctx.zone,
    buildTime: ctx.buildTime,
    format: ctx.format,
    aggregate: ctx.aggregate,
    fail(message) {
      errorCount += 1;
      firstError ??= message;
    },
  });
  reportTypeErrors(compiled, firstError, errorCount, ctx.diag);
  return value;
}

/**
 * A collector of type errors across many evaluations of one expression, for
 * callers that drive the loop themselves (`aggregate` over many groups).
 */
export interface TypeErrorReporter {
  /** Pass this as the `fail` of an {@link EvalContext}. */
  fail(message: string): void;
  /** Emit the single `MDV2210`, if anything failed. Call once, at the end. */
  finish(compiled: CompiledExpression, diag: DiagCollector): void;
}

/** Create a reporter that folds every failure of one expression into one code. */
export function createTypeErrorReporter(): TypeErrorReporter {
  let firstError: string | undefined;
  let errorCount = 0;
  return {
    fail(message) {
      errorCount += 1;
      firstError ??= message;
    },
    finish(compiled, diag) {
      reportTypeErrors(compiled, firstError, errorCount, diag);
    },
  };
}

/**
 * `MDV2111` for every field an expression reads that the table does not have.
 *
 * Reported once per expression, before evaluation, because a name that is simply
 * mistyped should say so rather than yielding a column of nulls in silence.
 */
function reportMissingFields(
  compiled: CompiledExpression,
  index: ReadonlyMap<string, number>,
  diag: DiagCollector,
): void {
  const missing = compiled.fields.filter((name) => !index.has(name));
  if (missing.length === 0) return;
  diag.emit('MDV2111', {
    message: `Expression references unknown field${missing.length > 1 ? 's' : ''} ${missing
      .map((name) => `\`${name}\``)
      .join(', ')}`,
    detail: `In \`${compiled.source}\`. Field names are case-sensitive (SPEC 6.1.2).`,
  });
}

function reportTypeErrors(
  compiled: CompiledExpression,
  firstError: string | undefined,
  count: number,
  diag: DiagCollector,
): void {
  if (firstError === undefined) return;
  diag.emit('MDV2210', {
    message: firstError,
    detail:
      count === 1
        ? `In \`${compiled.source}\`; the result is null.`
        : `In \`${compiled.source}\`; ${count} values became null.`,
  });
}

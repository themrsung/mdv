/**
 * MDVX runtime values and the semantics of SPEC 6.8.3.
 *
 * Three rules drive everything in this file:
 *
 * 1. **Null propagates.** Any arithmetic or comparison with null yields null.
 * 2. **No implicit coercion** between string and number: `'1' + 1` is a type
 *    error (`MDV2210`), while `+` on two strings concatenates.
 * 3. **Type errors are diagnostics, not exceptions.** The offending value
 *    becomes null and evaluation continues, so one bad row never blanks a chart.
 */

import type { Value } from '../types/data.js';

/** A value inside an expression: a cell, or a list (from `[a, b]` or a group). */
export type ExprValue = Value | readonly ExprValue[];

/** The runtime sink for SPEC 6.8.3 type errors. One report per expression. */
export interface TypeErrorSink {
  /** Records a type error. Callers still return null for the sub-expression. */
  fail(message: string): void;
}

/** `true` for a list value. Lists are the only non-cell runtime shape. */
export function isList(value: ExprValue): value is readonly ExprValue[] {
  return Array.isArray(value);
}

/**
 * Truthiness (SPEC 6.8.3). Null is falsy; so are `0`, `''`, `false`, `NaN` and
 * the empty list. Every other value — including a `Date` — is truthy.
 */
export function truthy(value: ExprValue): boolean {
  if (value === null || value === false) return false;
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value);
  if (typeof value === 'string') return value.length > 0;
  if (isList(value)) return value.length > 0;
  return true;
}

/** Numeric view of a value, or `undefined` when it is not a number. */
export function asNumber(value: ExprValue): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (value instanceof Date) return value.getTime();
  return undefined;
}

/**
 * Comparable key for `==`, `<` and friends.
 *
 * Dates compare as instants, so a `date` column sorts and filters against
 * another date without the document having to say so.
 */
function comparable(value: ExprValue): number | string | boolean | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  return undefined;
}

/** Deep equality for `==`. Lists compare element-wise; Dates compare as instants. */
export function equals(left: ExprValue, right: ExprValue): boolean {
  if (isList(left) || isList(right)) {
    if (!isList(left) || !isList(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, i) => equals(item, right[i] as ExprValue));
  }
  const a = comparable(left);
  const b = comparable(right);
  if (a === undefined || b === undefined) return left === right;
  return a === b;
}

/**
 * Ordering for `<`, `<=`, `>`, `>=`.
 *
 * @returns `undefined` when the operands are not mutually ordered — mixing a
 * string with a number is a type error, not a silent coercion (SPEC 6.8.3).
 */
export function compare(left: ExprValue, right: ExprValue): number | undefined {
  const a = comparable(left);
  const b = comparable(right);
  if (a === undefined || b === undefined) return undefined;
  if (typeof a === 'string' || typeof b === 'string') {
    if (typeof a !== 'string' || typeof b !== 'string') return undefined;
    // Code-unit order: `localeCompare` is ICU-dependent and would break
    // determinism across machines (SPEC 24.3).
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const x = typeof a === 'boolean' ? (a ? 1 : 0) : a;
  const y = typeof b === 'boolean' ? (b ? 1 : 0) : b;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** The `+` operator: numeric addition, or string concatenation, never a mix. */
export function add(left: ExprValue, right: ExprValue, sink: TypeErrorSink): ExprValue {
  if (typeof left === 'string' && typeof right === 'string') return left + right;
  if (typeof left === 'number' && typeof right === 'number') return left + right;
  if (left instanceof Date && typeof right === 'number') return new Date(left.getTime() + right);
  sink.fail(`Cannot add ${typeName(left)} and ${typeName(right)}`);
  return null;
}

/** Arithmetic other than `+`. Division and modulo by zero yield null, not `Infinity`. */
export function arithmetic(
  op: '-' | '*' | '/' | '%' | '**',
  left: ExprValue,
  right: ExprValue,
  sink: TypeErrorSink,
): ExprValue {
  if (op === '-' && left instanceof Date && right instanceof Date) {
    return left.getTime() - right.getTime();
  }
  if (op === '-' && left instanceof Date && typeof right === 'number') {
    return new Date(left.getTime() - right);
  }
  if (typeof left !== 'number' || typeof right !== 'number') {
    sink.fail(`Cannot apply ${JSON.stringify(op)} to ${typeName(left)} and ${typeName(right)}`);
    return null;
  }
  switch (op) {
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? null : finite(left / right);
    case '%':
      return right === 0 ? null : finite(left % right);
    case '**':
      return finite(left ** right);
  }
}

/** `in`: membership in a list, or a substring of a string. */
export function inOperator(left: ExprValue, right: ExprValue, sink: TypeErrorSink): ExprValue {
  if (isList(right)) return right.some((item) => equals(item, left));
  if (typeof right === 'string') {
    if (typeof left !== 'string') {
      sink.fail(`Cannot test ${typeName(left)} against a string with \`in\``);
      return null;
    }
    return right.includes(left);
  }
  sink.fail(`\`in\` needs a list or a string on the right, not ${typeName(right)}`);
  return null;
}

/** `contains`: the mirror of `in`. */
export function containsOperator(
  left: ExprValue,
  right: ExprValue,
  sink: TypeErrorSink,
): ExprValue {
  return inOperator(right, left, sink);
}

/** A human name for a runtime value, used in type-error details. */
export function typeName(value: ExprValue): string {
  if (value === null) return 'null';
  if (isList(value)) return 'a list';
  if (value instanceof Date) return 'a date';
  switch (typeof value) {
    case 'number':
      return 'a number';
    case 'string':
      return 'a string';
    default:
      return 'a boolean';
  }
}

/** A non-finite arithmetic result is missing data, not `Infinity` on an axis. */
function finite(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

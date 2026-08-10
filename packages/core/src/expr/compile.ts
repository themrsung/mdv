/**
 * Compile an MDVX expression to a closure tree (SPEC 6.8.3).
 *
 * > Evaluation MUST NOT use `eval`, `new Function`, or any dynamic code
 * > construction. Reference implementations compile to a closure tree over a
 * > fixed operator set.
 *
 * That is exactly what happens here: every AST node becomes a small arrow
 * function over `(scope, ctx)`. The only things a compiled expression can reach
 * are the scope it is handed and the whitelisted functions — there is no path to
 * a host object, because no host object is ever in scope.
 *
 * Diagnostics split by phase:
 * - syntax and unknown functions are compile-time (`MDV2200`, `MDV2220`);
 * - the SPEC 13.6 limits are compile-time (`MDV4030`);
 * - type errors are runtime, reported **once per expression** and never per row
 *   (`MDV2210`), which is what keeps a wrong column from producing 100 000
 *   identical diagnostics.
 */

import type { DiagCollector } from '../data/diag.js';
import { LIMITS } from '../data/limits.js';
import type { BinaryOp, ExprNode } from './ast.js';
import { callsIn, depthOf, fieldsIn } from './ast.js';
import { lookupFunction, type FunctionContext } from './functions.js';
import { parseExpression } from './parse.js';
import {
  add,
  arithmetic,
  compare,
  containsOperator,
  equals,
  inOperator,
  truthy,
  type ExprValue,
} from './values.js';

/** What a compiled expression reads a field from: one row, or one group. */
export interface Scope {
  /** `undefined` when the field does not exist — the caller emits `MDV2111`. */
  read(name: string): ExprValue | undefined;
}

/** Everything evaluation needs beyond the scope. */
export interface EvalContext extends Omit<FunctionContext, 'fail'> {
  /** Runtime type errors land here; the compiler reports only the first. */
  fail(message: string): void;
}

/** A compiled expression. Pure, total, and safe to call once per row. */
export interface CompiledExpression {
  /** The source, verbatim, for diagnostics and memo keys. */
  source: string;
  /** Field names the expression reads, in first-appearance order. */
  fields: readonly string[];
  /** Evaluate against one scope. Never throws. */
  evaluate(scope: Scope, ctx: EvalContext): ExprValue;
}

/** Options for {@link compileExpression}. */
export interface CompileOptions {
  /** `true` inside `aggregate`, which unlocks the stats group (SPEC 6.8.2). */
  aggregate?: boolean;
  /** Limits, so an embedder's lowered ceiling applies here too (SPEC 13.6). */
  limits?: {
    maxExpressionChars: number;
    maxExpressionDepth: number;
    maxExpressionCalls: number;
  };
}

const DEFAULT_LIMITS = {
  maxExpressionChars: LIMITS.maxExpressionChars,
  maxExpressionDepth: LIMITS.maxExpressionDepth,
  maxExpressionCalls: LIMITS.maxExpressionCalls,
};

/**
 * Compile `source`, emitting compile-time diagnostics into `diag`.
 *
 * @returns `undefined` when the expression cannot be compiled. The caller drops
 * the step or the derived field rather than rendering something invented.
 */
export function compileExpression(
  source: string,
  diag: DiagCollector,
  options: CompileOptions = {},
): CompiledExpression | undefined {
  const limits = options.limits ?? DEFAULT_LIMITS;

  if (source.length > limits.maxExpressionChars) {
    diag.emit('MDV4030', {
      message: `Expression is ${source.length} characters; the limit is ${limits.maxExpressionChars}`,
      detail: 'Split the expression across `derive` steps (SPEC 13.6).',
    });
    return undefined;
  }

  const parsed = parseExpression(source);
  if (parsed.node === undefined) {
    const error = parsed.error;
    diag.emit('MDV2200', {
      message: error === undefined ? 'Malformed expression' : error.message,
      detail: error === undefined ? undefined : `At offset ${error.offset} of \`${source}\`.`,
    });
    return undefined;
  }
  const node = parsed.node;

  const depth = depthOf(node);
  if (depth > limits.maxExpressionDepth) {
    diag.emit('MDV4030', {
      message: `Expression nests ${depth} levels deep; the limit is ${limits.maxExpressionDepth}`,
    });
    return undefined;
  }
  const calls = callsIn(node);
  if (calls > limits.maxExpressionCalls) {
    diag.emit('MDV4030', {
      message: `Expression makes ${calls} function calls; the limit is ${limits.maxExpressionCalls}`,
    });
    return undefined;
  }

  if (!checkCalls(node, diag, options.aggregate === true, source)) return undefined;

  const compiled = build(node);
  return {
    source,
    fields: fieldsIn(node),
    evaluate: (scope, ctx) => compiled(scope, ctx),
  };
}

/** A node compiled to a closure. The whole tree is built from these. */
type Thunk = (scope: Scope, ctx: EvalContext) => ExprValue;

function build(node: ExprNode): Thunk {
  switch (node.kind) {
    case 'literal': {
      const value = node.value;
      return () => value;
    }

    case 'field': {
      const name = node.name;
      return (scope) => {
        const value = scope.read(name);
        // A missing field is null here; the *reference* is reported once, by the
        // caller, which knows the table's fields (`MDV2111`).
        return value === undefined ? null : value;
      };
    }

    case 'list': {
      const items = node.items.map(build);
      return (scope, ctx) => items.map((item) => item(scope, ctx));
    }

    case 'unary': {
      const operand = build(node.operand);
      if (node.op === '!') {
        return (scope, ctx) => {
          const value = operand(scope, ctx);
          return value === null ? null : !truthy(value);
        };
      }
      return (scope, ctx) => {
        const value = operand(scope, ctx);
        if (value === null) return null;
        if (typeof value !== 'number') {
          ctx.fail('Unary `-` needs a number');
          return null;
        }
        return -value;
      };
    }

    case 'conditional': {
      const test = build(node.test);
      const consequent = build(node.consequent);
      const alternate = build(node.alternate);
      return (scope, ctx) =>
        truthy(test(scope, ctx)) ? consequent(scope, ctx) : alternate(scope, ctx);
    }

    case 'call': {
      const args = node.args.map(build);
      const name = node.name;
      // Resolved at compile time: the name can never be re-bound at runtime.
      const fn = lookupFunction(name);
      /* c8 ignore next -- `checkCalls` rejects unknown names before this point. */
      if (fn === undefined) return () => null;
      return (scope, ctx) =>
        fn.call(
          args.map((arg) => arg(scope, ctx)),
          ctx,
        );
    }

    case 'binary':
      return binary(node.op, build(node.left), build(node.right));
  }
}

function binary(op: BinaryOp, left: Thunk, right: Thunk): Thunk {
  switch (op) {
    // ── Short-circuiting logic ───────────────────────────────────────────────
    case '&&':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        if (!truthy(a)) return a === null ? null : false;
        const b = right(scope, ctx);
        return b === null ? null : truthy(b);
      };
    case '||':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        if (truthy(a)) return true;
        const b = right(scope, ctx);
        if (truthy(b)) return true;
        return a === null || b === null ? null : false;
      };

    // ── Equality: null == null is true, so a filter can test for missing data ─
    case '==':
      return (scope, ctx) => equals(left(scope, ctx), right(scope, ctx));
    case '!=':
      return (scope, ctx) => !equals(left(scope, ctx), right(scope, ctx));

    // ── Ordering ─────────────────────────────────────────────────────────────
    case '<':
    case '<=':
    case '>':
    case '>=':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        const b = right(scope, ctx);
        if (a === null || b === null) return null;
        const order = compare(a, b);
        if (order === undefined) {
          ctx.fail(`Cannot compare with ${JSON.stringify(op)} across different types`);
          return null;
        }
        switch (op) {
          case '<':
            return order < 0;
          case '<=':
            return order <= 0;
          case '>':
            return order > 0;
          default:
            return order >= 0;
        }
      };

    case 'in':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        const b = right(scope, ctx);
        if (a === null || b === null) return null;
        return inOperator(a, b, ctx);
      };
    case 'contains':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        const b = right(scope, ctx);
        if (a === null || b === null) return null;
        return containsOperator(a, b, ctx);
      };

    // ── Arithmetic ───────────────────────────────────────────────────────────
    case '+':
      return (scope, ctx) => {
        const a = left(scope, ctx);
        const b = right(scope, ctx);
        if (a === null || b === null) return null;
        return add(a, b, ctx);
      };
    default:
      return (scope, ctx) => {
        const a = left(scope, ctx);
        const b = right(scope, ctx);
        if (a === null || b === null) return null;
        return arithmetic(op as '-' | '*' | '/' | '%' | '**', a, b, ctx);
      };
  }
}

/**
 * Walk the tree and reject calls the whitelist does not allow: an unknown name
 * (`MDV2220`), a wrong arity, or a stats function outside an aggregate context
 * (both `MDV2200`, because the expression is not well-formed for its position).
 */
function checkCalls(
  node: ExprNode,
  diag: DiagCollector,
  aggregate: boolean,
  source: string,
): boolean {
  switch (node.kind) {
    case 'literal':
    case 'field':
      return true;
    case 'unary':
      return checkCalls(node.operand, diag, aggregate, source);
    case 'binary':
      return (
        checkCalls(node.left, diag, aggregate, source) &&
        checkCalls(node.right, diag, aggregate, source)
      );
    case 'conditional':
      return (
        checkCalls(node.test, diag, aggregate, source) &&
        checkCalls(node.consequent, diag, aggregate, source) &&
        checkCalls(node.alternate, diag, aggregate, source)
      );
    case 'list':
      return node.items.every((item) => checkCalls(item, diag, aggregate, source));
    case 'call': {
      const fn = lookupFunction(node.name);
      if (fn === undefined) {
        diag.emit('MDV2220', {
          message: `\`${node.name}()\` is not an MDVX function`,
          detail: `In \`${source}\`. Only the SPEC 6.8.2 whitelist may be called.`,
        });
        return false;
      }
      if (node.args.length < fn.min || node.args.length > fn.max) {
        diag.emit('MDV2200', {
          message: `\`${node.name}()\` takes ${arity(fn.min, fn.max)}, but got ${node.args.length}`,
          detail: `In \`${source}\`.`,
        });
        return false;
      }
      if (fn.aggregateOnly === true && !aggregate) {
        diag.emit('MDV2200', {
          message: `\`${node.name}()\` is only available inside \`aggregate\``,
          detail: `In \`${source}\`. Aggregate first, then derive from the result (SPEC 6.8.2).`,
        });
        return false;
      }
      return node.args.every((arg) => checkCalls(arg, diag, aggregate, source));
    }
  }
}

function arity(min: number, max: number): string {
  if (max === Infinity) return `at least ${min} argument${min === 1 ? '' : 's'}`;
  if (min === max) return `${min} argument${min === 1 ? '' : 's'}`;
  return `${min}–${max} arguments`;
}

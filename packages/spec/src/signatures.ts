import rawSignatureTable from '../signatures.json';
import type { Arity, FunctionSignature, SignatureTable, StepSignature } from './types.js';

/**
 * The SPEC 6.8.2 function whitelist and the SPEC 6.7 step shapes, loaded from
 * `packages/spec/signatures.json`.
 *
 * The evaluator in `@mdv/core` owns the *implementations*; this table owns the
 * *names*. Both are generated from the same two spec sections, and
 * `packages/core/test/signatures.test.ts` fails the build if they drift, so a
 * tool that wants to describe a call — an LSP, a CLI `--explain`, the web
 * app's editor — reads it here instead of duplicating the list.
 */
export const SIGNATURE_TABLE: SignatureTable = rawSignatureTable as unknown as SignatureTable;

/** Every whitelisted function, in SPEC 6.8.2 table order. */
export const FUNCTION_SIGNATURES: readonly FunctionSignature[] = SIGNATURE_TABLE.functions;

/** Every transform step, in SPEC 6.7 table order. */
export const STEP_SIGNATURES: readonly StepSignature[] = SIGNATURE_TABLE.steps;

const FUNCTION_INDEX: ReadonlyMap<string, FunctionSignature> = new Map(
  FUNCTION_SIGNATURES.map((entry) => [entry.name, entry] as const),
);

const STEP_INDEX: ReadonlyMap<string, StepSignature> = new Map(
  STEP_SIGNATURES.map((entry) => [entry.name, entry] as const),
);

/**
 * Look up a whitelisted function by name.
 *
 * @returns the signature, or `undefined` for a name that is not on the SPEC
 * 6.8.2 whitelist — which, at evaluation time, is `MDV2220`.
 */
export function lookupSignature(name: string): FunctionSignature | undefined {
  return FUNCTION_INDEX.get(name);
}

/**
 * Look up a transform step by name.
 *
 * @returns the signature, or `undefined` for a step SPEC 6.7 does not define —
 * which, in a pipeline, is `MDV2500`.
 */
export function lookupStepSignature(name: string): StepSignature | undefined {
  return STEP_INDEX.get(name);
}

/**
 * How many arguments `name` accepts, counted from its parameter list.
 *
 * A `rest` parameter takes one or more arguments, or a single list, so it
 * contributes a minimum of one and no maximum. Too few arguments is `MDV2200`
 * and too many is `MDV2201`.
 *
 * @returns `undefined` for a name that is not whitelisted.
 */
export function arityOf(name: string): Arity | undefined {
  const signature = FUNCTION_INDEX.get(name);
  if (signature === undefined) return undefined;
  let min = 0;
  let variadic = false;
  for (const param of signature.params) {
    if (param.rest === true) {
      min += 1;
      variadic = true;
    } else if (param.optional !== true) {
      min += 1;
    }
  }
  return { min, max: variadic ? Infinity : signature.params.length };
}

/**
 * The parameter as it is printed inside a signature label: `exponent`,
 * `length?` for an optional one, `value…` for a variadic tail.
 */
function renderParam(param: { name: string; optional?: boolean; rest?: boolean }): string {
  if (param.rest === true) return `${param.name}…`;
  return param.optional === true ? `${param.name}?` : param.name;
}

/**
 * A call signature as a tool shows it, e.g. `substr(text, start, length?)`.
 *
 * The label is the whole of what a signature-help client renders, and the
 * parameter spans it highlights are found by searching it, so the parameter
 * names must appear in it verbatim and exactly once each — which they do,
 * because SPEC 6.8.2 gives every parameter of a function a distinct name.
 */
export function renderSignature(signature: FunctionSignature): string {
  return `${signature.name}(${signature.params.map(renderParam).join(', ')})`;
}

/**
 * A step signature as a tool shows it, e.g.
 * `window: {op, field, size, output, partition?}`.
 *
 * Steps whose parameter is not a mapping have no keys, and fall back to the
 * prose shape from SPEC 6.7: `sort: a field name or a list of them`.
 */
export function renderStepSignature(signature: StepSignature): string {
  if (signature.keys.length === 0) {
    return `${signature.name}: ${signature.shape.replaceAll('`', '')}`;
  }
  return `${signature.name}: {${signature.keys.map(renderParam).join(', ')}}`;
}

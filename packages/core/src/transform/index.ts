/**
 * The transform pipeline (SPEC 6.7).
 *
 * > `transform:` is an ordered pipeline applied after parsing and before
 * > encoding. Each step takes a table and returns a table. Transforms are pure,
 * > total, and deliberately non-Turing-complete: no loops, no recursion, no user
 * > functions.
 *
 * Totality is the property this module enforces: a malformed step emits a
 * diagnostic and returns its input, so a pipeline always produces a table and a
 * bad step degrades the chart instead of deleting it.
 */

import { STEP_SIGNATURES } from '@mdv/spec';
import type {
  AggregateStep,
  BinStep,
  DeriveStep,
  FilterStep,
  JoinStep,
  LimitStep,
  PivotStep,
  RenameStep,
  SelectStep,
  SortStep,
  Table,
  TransformPipeline,
  TransformStep,
  UnpivotStep,
  WindowStep,
} from '../types/data.js';
import { applyAggregate } from './aggregate.js';
import {
  applyDerive,
  applyFilter,
  applyLimit,
  applyRename,
  applySelect,
  applySort,
} from './basic.js';
import { enforceLimits, type TransformContext } from './context.js';
import { applyJoin } from './join.js';
import { applyBin, applyPivot, applyUnpivot } from './reshape.js';
import { applyWindow } from './window.js';

export type { TransformContext } from './context.js';
export { cloneTable, typeOfValues } from './context.js';
export { compareValues, groupKey, stableSort, tupleKey } from './order.js';

/**
 * The step names SPEC 6.7 defines, in table order. Anything else is `MDV2500`.
 *
 * Read from `@mdv/spec` rather than spelled again here: the same list has to be
 * known by anything that describes a pipeline without running one — the LSP's
 * completion and signature help, a CLI that explains a step — and a second copy
 * is a copy that goes stale. `dispatch` below still switches on the names
 * literally; `test/signatures.test.ts` is what holds the two together, by
 * running every named step and refusing the `MDV2500` a missing case would give.
 */
const STEP_NAMES: readonly string[] = STEP_SIGNATURES.map((step) => step.name);

/**
 * Apply one pipeline to one table.
 *
 * The step budget (`maxTransformSteps`, SPEC 13.6) is checked here rather than
 * inside the steps: a pipeline is a document-authored loop bound, and this is
 * the only place that knows how long it is.
 */
export function applyPipeline(
  table: Table,
  pipeline: TransformPipeline | undefined,
  ctx: TransformContext,
): Table {
  if (pipeline === undefined || pipeline.length === 0) return table;

  let steps = pipeline;
  if (steps.length > ctx.limits.maxTransformSteps) {
    ctx.diag.emit('MDV4031', {
      message: `The pipeline has ${steps.length} steps; the limit is ${ctx.limits.maxTransformSteps}`,
      detail: 'The remaining steps were skipped (SPEC 13.6).',
    });
    steps = steps.slice(0, ctx.limits.maxTransformSteps);
  }

  let current = table;
  for (const step of steps) {
    current = applyStep(current, step, ctx);
  }
  return current;
}

/** Apply one step. Never throws; a bad step returns its input unchanged. */
export function applyStep(table: Table, step: TransformStep, ctx: TransformContext): Table {
  const entries = asRecord(step);
  const names = Object.keys(entries).filter((name) => entries[name] !== undefined);
  const known = names.filter((name) => STEP_NAMES.includes(name));

  if (known.length === 0) {
    ctx.diag.emit('MDV2500', {
      message: `\`${names[0] ?? '(empty)'}\` is not a transform step`,
      detail: `Known steps are ${STEP_NAMES.map((name) => `\`${name}\``).join(', ')} (SPEC 6.7).`,
    });
    return table;
  }
  if (known.length > 1) {
    ctx.diag.emit('MDV2501', {
      message: `A transform step declares ${known.map((name) => `\`${name}\``).join(' and ')}`,
      detail: 'Each list entry is exactly one step; only the first was applied.',
    });
  }

  const name = known[0] as string;
  const params = entries[name];
  const out = dispatch(table, name, params, ctx);
  return enforceLimits(out, name, ctx);
}

function dispatch(table: Table, name: string, params: unknown, ctx: TransformContext): Table {
  switch (name) {
    case 'filter':
      return typeof params === 'string'
        ? applyFilter(table, params, ctx)
        : malformed(table, 'filter', 'an expression string', params, ctx);

    case 'derive':
      return isStringMap(params)
        ? applyDerive(table, params, ctx)
        : malformed(table, 'derive', 'a map of field name to expression', params, ctx);

    case 'aggregate':
      return isRecord(params)
        ? applyAggregate(table, params as AggregateStep['aggregate'], ctx)
        : malformed(table, 'aggregate', 'a mapping', params, ctx);

    case 'sort':
      return typeof params === 'string' || isStringArray(params)
        ? applySort(table, params as SortStep['sort'], ctx)
        : malformed(table, 'sort', 'a field name or a list of them', params, ctx);

    case 'limit':
      return typeof params === 'number' || (isRecord(params) && typeof params['n'] === 'number')
        ? applyLimit(table, params as LimitStep['limit'], ctx)
        : malformed(table, 'limit', 'a number or `{n, offset}`', params, ctx);

    case 'pivot':
      return isRecord(params) &&
        typeof params['key'] === 'string' &&
        typeof params['value'] === 'string'
        ? applyPivot(table, params as unknown as PivotStep['pivot'], ctx)
        : malformed(table, 'pivot', '`{key, value, group?}`', params, ctx);

    case 'unpivot':
      return isRecord(params) && isStringArray(params['fields'])
        ? applyUnpivot(table, params as unknown as UnpivotStep['unpivot'], ctx)
        : malformed(table, 'unpivot', '`{fields, key?, value?}`', params, ctx);

    case 'bin':
      return isRecord(params) && typeof params['field'] === 'string'
        ? applyBin(table, params as unknown as BinStep['bin'], ctx)
        : malformed(table, 'bin', '`{field, step? | count?, output?}`', params, ctx);

    case 'window':
      return isRecord(params) &&
        typeof params['op'] === 'string' &&
        typeof params['field'] === 'string' &&
        typeof params['output'] === 'string' &&
        isWindowOp(params['op'])
        ? applyWindow(table, params as unknown as WindowStep['window'], ctx)
        : malformed(table, 'window', '`{op, field, size, output, partition?}`', params, ctx);

    case 'join':
      return isRecord(params) &&
        typeof params['with'] === 'string' &&
        (typeof params['on'] === 'string' ||
          (isRecord(params['on']) &&
            typeof params['on']['left'] === 'string' &&
            typeof params['on']['right'] === 'string'))
        ? applyJoin(table, params as unknown as JoinStep['join'], ctx)
        : malformed(table, 'join', '`{with, on, how?}`', params, ctx);

    case 'rename':
      return isStringMap(params)
        ? applyRename(table, params, ctx)
        : malformed(table, 'rename', 'a map of old name to new name', params, ctx);

    case 'select':
      return isStringArray(params)
        ? applySelect(table, params, ctx)
        : malformed(table, 'select', 'a list of field names', params, ctx);

    /* c8 ignore next 2 -- `applyStep` only dispatches names from `STEP_NAMES`. */
    default:
      return table;
  }
}

function malformed(
  table: Table,
  step: string,
  expected: string,
  got: unknown,
  ctx: TransformContext,
): Table {
  ctx.diag.emit('MDV2501', {
    message: `\`${step}\` needs ${expected}`,
    detail: `Got ${describe(got)}. The step was skipped (SPEC 6.7).`,
  });
  return table;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  return JSON.stringify(value);
}

const WINDOW_OPS: readonly string[] = [
  'sum',
  'mean',
  'min',
  'max',
  'count',
  'cumsum',
  'delta',
  'pct_change',
  'rank',
  'lag',
  'lead',
];

function isWindowOp(value: unknown): boolean {
  return typeof value === 'string' && WINDOW_OPS.includes(value);
}

/**
 * A step as a mapping, so its single key can be read.
 *
 * `TransformStep` is a union of one-key interfaces, none of which has an index
 * signature; the double assertion is the only way to ask "which key is set?"
 * without enumerating the union twice.
 */
function asRecord(step: TransformStep): Record<string, unknown> {
  return step as unknown as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isStringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === 'string');
}

/**
 * A memoisation key over a pipeline (SPEC 6.7).
 *
 * > Transforms are evaluated once per resolved dataset and memoised by
 * > (dataset identity, transform pipeline) so N charts over one dataset cost one
 * > evaluation.
 *
 * The key is canonical JSON with **sorted object keys**, so two pipelines that
 * differ only in mapping order share one evaluation — which is safe precisely
 * because no step's meaning depends on that order.
 */
export function pipelineKey(pipeline: TransformPipeline | undefined): string {
  if (pipeline === undefined || pipeline.length === 0) return '';
  return canonical(pipeline);
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The step names a pipeline uses, for diagnostics and tooling. */
export function stepNamesOf(pipeline: TransformPipeline): string[] {
  return pipeline.map((step) => {
    const names = Object.keys(asRecord(step)).filter((name) => STEP_NAMES.includes(name));
    return names[0] ?? 'unknown';
  });
}

export type {
  AggregateStep,
  BinStep,
  DeriveStep,
  FilterStep,
  JoinStep,
  LimitStep,
  PivotStep,
  RenameStep,
  SelectStep,
  SortStep,
  UnpivotStep,
  WindowStep,
};

/**
 * `aggregate` — group-and-reduce (SPEC 6.7).
 *
 * ```yaml
 * aggregate:
 *   group: [region, month]
 *   sum: [revenue, units]
 *   mean: {avgPrice: price}
 * ```
 *
 * Two determinism decisions worth stating:
 *
 * 1. **Groups keep first-appearance order.** Sorting them would silently reorder
 *    a chart the author already ordered; `sort` is the step for that.
 * 2. **Output fields follow a canonical aggregator order** — the SPEC 6.7 table
 *    order, then percentiles ascending — rather than the key order of the YAML
 *    mapping, so two parsers that disagree about mapping order still produce
 *    byte-identical output (SPEC 24.3).
 */

import type { AggregateArg, AggregateStep, Column, DataType, Table, Value } from '../types/data.js';
import { percentile } from '../expr/index.js';
import { compareValues, tupleKey } from './order.js';
import { fieldIndex, uniqueName, type TransformContext } from './context.js';

/** The SPEC 6.7 aggregator names in table order; percentiles are handled apart. */
const CANONICAL_OPS = ['sum', 'mean', 'median', 'min', 'max', 'first', 'last', 'stddev'] as const;

type CanonicalOp = (typeof CANONICAL_OPS)[number];

/** One resolved output column of the aggregate. */
interface Aggregation {
  /** Output field name. */
  name: string;
  /** Input field index, or `undefined` for `count`, which needs no input. */
  at: number | undefined;
  op: CanonicalOp | 'count' | 'percentile';
  /** The percentile, when `op` is `percentile`. */
  p?: number;
  /** Input field name, for diagnostics. */
  input?: string;
}

const PERCENTILE_KEY = /^p(\d+(?:\.\d+)?)$/u;

/** Normalise `[a, b]` or `{out: in}` into output→input pairs, in a stable order. */
function pairsOf(arg: AggregateArg): { out: string; in: string }[] {
  if (Array.isArray(arg)) {
    return (arg as readonly string[]).map((name) => ({ out: name, in: name }));
  }
  return Object.entries(arg as Readonly<Record<string, string>>).map(([out, input]) => ({
    out,
    in: input,
  }));
}

export function applyAggregate(
  table: Table,
  spec: AggregateStep['aggregate'],
  ctx: TransformContext,
): Table {
  const index = fieldIndex(table.fields);

  // ── Group columns ──────────────────────────────────────────────────────────
  const groupNames = spec.group ?? [];
  const groupAt: number[] = [];
  for (const name of groupNames) {
    const at = index.get(name);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`aggregate.group\` references unknown field \`${name}\``,
        detail: 'The field was dropped from the grouping.',
      });
      continue;
    }
    groupAt.push(at);
  }

  // ── Aggregations, in canonical order ───────────────────────────────────────
  const taken = new Set<string>(groupAt.map((at) => (table.fields[at] as Column).name));
  const aggregations: Aggregation[] = [];

  const addPairs = (op: CanonicalOp | 'percentile', arg: AggregateArg, p?: number): void => {
    for (const pair of pairsOf(arg)) {
      const at = index.get(pair.in);
      if (at === undefined) {
        ctx.diag.emit('MDV2111', {
          message: `\`aggregate\` references unknown field \`${pair.in}\``,
          detail: `The aggregator \`${op === 'percentile' ? `p${p ?? 0}` : op}\` was skipped.`,
        });
        continue;
      }
      const name = uniqueName(taken, pair.out);
      taken.add(name);
      aggregations.push({
        name,
        at,
        op,
        input: pair.in,
        ...(p !== undefined ? { p } : {}),
      });
    }
  };

  for (const op of CANONICAL_OPS) {
    const arg = spec[op];
    if (arg === undefined) continue;
    addPairs(op, arg);
  }

  if (spec.count !== undefined) {
    const name = uniqueName(taken, spec.count === true ? 'count' : spec.count);
    taken.add(name);
    aggregations.push({ name, at: undefined, op: 'count' });
  }

  // Percentiles last, ascending, so `p95` always follows `p50`.
  const percentiles: { p: number; arg: AggregateArg }[] = [];
  for (const [key, arg] of Object.entries(spec)) {
    const match = PERCENTILE_KEY.exec(key);
    if (match === null || arg === undefined) continue;
    percentiles.push({ p: Number(match[1]), arg: arg as AggregateArg });
  }
  percentiles.sort((a, b) => a.p - b.p);
  for (const entry of percentiles) addPairs('percentile', entry.arg, entry.p);

  if (aggregations.length === 0 && groupAt.length === 0) {
    ctx.diag.emit('MDV2501', {
      message: '`aggregate` has neither a group nor an aggregator',
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  // ── Grouping, in first-appearance order ────────────────────────────────────
  const order: string[] = [];
  const groups = new Map<string, { key: Value[]; rows: Value[][] }>();
  for (const row of table.rows) {
    const key = groupAt.map((at) => row[at] ?? null);
    const id = tupleKey(key);
    let group = groups.get(id);
    if (group === undefined) {
      group = { key, rows: [] };
      groups.set(id, group);
      order.push(id);
    }
    group.rows.push(row);
  }
  // An empty table with a grouping produces no rows; with no grouping it still
  // produces the one all-rows summary, which is what `count` over nothing means.
  if (table.rows.length === 0 && groupAt.length === 0) {
    order.push('');
    groups.set('', { key: [], rows: [] });
  }

  // ── Reduce ─────────────────────────────────────────────────────────────────
  const nonNumeric = new Set<string>();
  const fields: Column[] = [
    ...groupAt.map((at) => ({ ...(table.fields[at] as Column) })),
    ...aggregations.map((aggregation) => ({
      name: aggregation.name,
      type: outputType(aggregation, table),
      inferred: true,
    })),
  ];

  const rows: Value[][] = [];
  for (const id of order) {
    const group = groups.get(id) as { key: Value[]; rows: Value[][] };
    const out: Value[] = [...group.key];
    for (const aggregation of aggregations) {
      out.push(reduce(aggregation, group.rows, nonNumeric));
    }
    rows.push(out);
  }

  for (const name of nonNumeric) {
    ctx.diag.emit('MDV2502', {
      message: `\`aggregate\` computed a numeric summary of the non-numeric field \`${name}\``,
      detail: 'Non-numeric cells were ignored (SPEC 6.7).',
    });
  }

  return { fields, rows };
}

/**
 * One number out of one column — the arithmetic behind `:mdv-value[]` (SPEC 9.2).
 *
 * `:mdv-value[@sales.revenue.sum]` asks for a single cell of an aggregate that
 * has no grouping, no output column and no place to put a diagnostic: it is read
 * during a Markdown walk, not a pipeline run. Rather than let the React and PDF
 * renderers each write their own `sum`, this exposes the reducer the pipeline
 * already uses, so the sentence and the chart beside it cannot disagree.
 *
 * `undefined` — not `null` — for an unknown field or an unspelled operator, so
 * the caller can tell "the author asked for something that is not there" (render
 * the source text, SPEC 15.2) from "the column aggregated to nothing" (`null`,
 * an empty column, which prints as an em dash like any other missing value).
 *
 * Non-numeric cells under a numeric operator are ignored exactly as they are in
 * the pipeline, but silently: the walk has no diagnostic sink, and `MDV2502` is
 * already emitted by whichever `aggregate` step the author wrote deliberately.
 *
 * @param table - the resolved table, already through its pipeline
 * @param field - the column name, as spelled in the reference
 * @param op - `sum`, `mean`, `median`, `min`, `max`, `first`, `last`, `stddev`,
 *   `count`, or a percentile spelled `p50`, `p95`, `p99.9`
 */
export function aggregateColumn(table: Table, field: string, op: string): Value | undefined {
  const at = fieldIndex(table.fields).get(field);
  if (at === undefined) return undefined;

  const aggregation = aggregationFor(at, field, op);
  if (aggregation === undefined) return undefined;

  // The set is a sink for `MDV2502`, which has nowhere to go from here.
  return reduce(aggregation, table.rows, new Set<string>());
}

/** Resolve an operator name to the aggregation {@link reduce} expects. */
function aggregationFor(at: number, field: string, op: string): Aggregation | undefined {
  if (op === 'count') return { name: op, at: undefined, op: 'count' };

  const canonical = CANONICAL_OPS.find((name) => name === op);
  if (canonical !== undefined) return { name: op, at, op: canonical, input: field };

  const match = PERCENTILE_KEY.exec(op);
  if (match === null) return undefined;
  const p = Number(match[1]);
  if (!Number.isFinite(p) || p < 0 || p > 100) return undefined;
  return { name: op, at, op: 'percentile', p, input: field };
}

/** The declared output type of one aggregation. */
function outputType(aggregation: Aggregation, table: Table): DataType {
  switch (aggregation.op) {
    case 'count':
      return 'integer';
    case 'first':
    case 'last':
    case 'min':
    case 'max': {
      // These return a member of the input column, so the type carries over.
      const source = aggregation.at === undefined ? undefined : table.fields[aggregation.at];
      return source?.type ?? 'unknown';
    }
    default:
      return 'number';
  }
}

function reduce(
  aggregation: Aggregation,
  rows: readonly Value[][],
  nonNumeric: Set<string>,
): Value {
  if (aggregation.op === 'count') {
    return rows.length;
  }

  const at = aggregation.at as number;
  const values: Value[] = rows.map((row) => row[at] ?? null);

  switch (aggregation.op) {
    case 'first':
      return firstNonNull(values);
    case 'last':
      return firstNonNull([...values].reverse());
    case 'min':
    case 'max': {
      const present = values.filter((value) => value !== null);
      if (present.length === 0) return null;
      let best = present[0] as Value;
      for (const value of present.slice(1)) {
        const order = compareValues(value, best);
        if (aggregation.op === 'min' ? order < 0 : order > 0) best = value;
      }
      return best;
    }
    default:
      break;
  }

  // The remaining aggregators are numeric.
  const numbers = numericOnly(values, aggregation, nonNumeric);
  switch (aggregation.op) {
    case 'sum': {
      if (numbers.length === 0) return null;
      let total = 0;
      for (const value of numbers) total += value;
      return total;
    }
    case 'mean':
      return numbers.length === 0 ? null : mean(numbers);
    case 'median':
      return percentile(numbers, 50);
    case 'stddev': {
      if (numbers.length < 2) return null;
      const average = mean(numbers);
      let sum = 0;
      for (const value of numbers) sum += (value - average) ** 2;
      return Math.sqrt(sum / (numbers.length - 1));
    }
    /* c8 ignore next 2 -- every op is covered above. */
    case 'percentile':
      return percentile(numbers, aggregation.p ?? 50);
    default:
      return null;
  }
}

function numericOnly(
  values: readonly Value[],
  aggregation: Aggregation,
  nonNumeric: Set<string>,
): number[] {
  const out: number[] = [];
  for (const value of values) {
    if (value === null) continue;
    if (typeof value === 'number') {
      out.push(value);
      continue;
    }
    if (value instanceof Date) {
      out.push(value.getTime());
      continue;
    }
    // A string or boolean under `sum` is the author's mistake, not the data's:
    // report it once per field rather than once per row (`MDV2502`).
    if (aggregation.input !== undefined) nonNumeric.add(aggregation.input);
  }
  return out;
}

function mean(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

function firstNonNull(values: readonly Value[]): Value {
  for (const value of values) {
    if (value !== null) return value;
  }
  return null;
}

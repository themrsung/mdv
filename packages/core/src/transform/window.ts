/**
 * `window` — a windowed aggregate over the current row order (SPEC 6.7).
 *
 * > `op` ∈ `sum, mean, min, max, count, cumsum, delta, pct_change, rank, lag,
 * > lead`. `size` in rows; `partition` groups. Order is the current row order.
 *
 * "Order is the current row order" is load-bearing: this step never sorts. If a
 * running total should follow time, the pipeline sorts by time first — which
 * keeps the result reproducible instead of depending on a hidden ordering rule.
 */

import type { Column, Table, Value, WindowStep } from '../types/data.js';
import { compareValues, tupleKey } from './order.js';
import { fieldIndex, typeOfValues, uniqueName, type TransformContext } from './context.js';

export function applyWindow(
  table: Table,
  spec: WindowStep['window'],
  ctx: TransformContext,
): Table {
  const index = fieldIndex(table.fields);
  const at = index.get(spec.field);
  if (at === undefined) {
    ctx.diag.emit('MDV2111', {
      message: `\`window\` references unknown field \`${spec.field}\``,
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  const size = Number.isFinite(spec.size) ? Math.max(1, Math.trunc(spec.size)) : 1;
  if (!Number.isFinite(spec.size) || spec.size < 1) {
    ctx.diag.emit('MDV2501', {
      message: '`window.size` must be at least 1 row',
      detail: `Got ${JSON.stringify(spec.size)}; 1 was used.`,
    });
  }

  const partitionNames =
    spec.partition === undefined
      ? []
      : typeof spec.partition === 'string'
        ? [spec.partition]
        : [...spec.partition];
  const partitionAt: number[] = [];
  for (const name of partitionNames) {
    const partition = index.get(name);
    if (partition === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`window.partition\` references unknown field \`${name}\``,
        detail: 'The field was dropped from the partitioning.',
      });
      continue;
    }
    partitionAt.push(partition);
  }

  // Row positions per partition, in row order — the whole step is one pass plus
  // one pass per partition, so a 100 000-row table stays linear.
  const partitions = new Map<string, number[]>();
  for (let i = 0; i < table.rows.length; i += 1) {
    const row = table.rows[i] as Value[];
    const id = tupleKey(partitionAt.map((position) => row[position] ?? null));
    const bucket = partitions.get(id);
    if (bucket === undefined) partitions.set(id, [i]);
    else bucket.push(i);
  }

  const output: Value[] = new Array<Value>(table.rows.length).fill(null);
  for (const positions of partitions.values()) {
    const values = positions.map((position) => (table.rows[position] as Value[])[at] ?? null);
    const computed = compute(spec.op, values, size);
    for (let i = 0; i < positions.length; i += 1) {
      output[positions[i] as number] = computed[i] ?? null;
    }
  }

  const taken = new Set(table.fields.map((field) => field.name));
  const existing = index.get(spec.output);
  const column: Column = { name: spec.output, type: typeOfValues(output), inferred: true };

  if (existing !== undefined) {
    return {
      fields: table.fields.map((field, i) => (i === existing ? column : { ...field })),
      rows: table.rows.map((row, i) =>
        row.map((cell, j) => (j === existing ? (output[i] ?? null) : cell)),
      ),
    };
  }

  column.name = uniqueName(taken, spec.output);
  return {
    fields: [...table.fields.map((field) => ({ ...field })), column],
    rows: table.rows.map((row, i) => [...row, output[i] ?? null]),
  };
}

/** Every window op, over one partition's values in row order. */
function compute(op: WindowStep['window']['op'], values: readonly Value[], size: number): Value[] {
  switch (op) {
    case 'sum':
    case 'mean':
    case 'count':
      return trailing(values, size, op);
    case 'min':
    case 'max':
      return trailingExtremum(values, size, op);
    case 'cumsum': {
      // Cumulative over the whole partition: `size` does not apply, because a
      // running total that forgets is a moving sum, which is `sum`.
      let total = 0;
      let seen = false;
      return values.map((value) => {
        const numeric = asNumber(value);
        if (numeric !== undefined) {
          total += numeric;
          seen = true;
        }
        return seen ? total : null;
      });
    }
    case 'delta':
      return values.map((value, i) => {
        const current = asNumber(value);
        const previous = asNumber(values[i - size] ?? null);
        if (current === undefined || previous === undefined) return null;
        return current - previous;
      });
    case 'pct_change':
      return values.map((value, i) => {
        const current = asNumber(value);
        const previous = asNumber(values[i - size] ?? null);
        if (current === undefined || previous === undefined || previous === 0) return null;
        return (current - previous) / previous;
      });
    case 'rank':
      return rank(values);
    case 'lag':
      return values.map((_value, i) => values[i - size] ?? null);
    case 'lead':
      return values.map((_value, i) => values[i + size] ?? null);
  }
}

/** Trailing window of `size` rows, ending at and including the current row. */
function trailing(values: readonly Value[], size: number, op: 'sum' | 'mean' | 'count'): Value[] {
  return values.map((_value, i) => {
    const from = Math.max(0, i - size + 1);
    let total = 0;
    let seen = 0;
    for (let j = from; j <= i; j += 1) {
      const numeric = asNumber(values[j] ?? null);
      if (numeric === undefined) continue;
      total += numeric;
      seen += 1;
    }
    if (op === 'count') return seen;
    if (seen === 0) return null;
    return op === 'sum' ? total : total / seen;
  });
}

function trailingExtremum(values: readonly Value[], size: number, op: 'min' | 'max'): Value[] {
  return values.map((_value, i) => {
    const from = Math.max(0, i - size + 1);
    let best: Value = null;
    for (let j = from; j <= i; j += 1) {
      const candidate = values[j] ?? null;
      if (candidate === null) continue;
      if (best === null) {
        best = candidate;
        continue;
      }
      const order = compareValues(candidate, best);
      if (op === 'min' ? order < 0 : order > 0) best = candidate;
    }
    return best;
  });
}

/**
 * Competition ranking (1, 2, 2, 4) ascending, nulls unranked.
 *
 * Ties share a rank because a chart that labelled two equal values "2nd" and
 * "3rd" would be asserting an order the data does not have.
 */
function rank(values: readonly Value[]): Value[] {
  const present = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value !== null)
    .sort((a, b) => {
      const order = compareValues(a.value, b.value);
      return order !== 0 ? order : a.index - b.index;
    });

  const out: Value[] = values.map(() => null);
  let position = 0;
  while (position < present.length) {
    const current = present[position] as { value: Value; index: number };
    let last = position;
    while (
      last + 1 < present.length &&
      compareValues((present[last + 1] as { value: Value }).value, current.value) === 0
    ) {
      last += 1;
    }
    for (let i = position; i <= last; i += 1) {
      out[(present[i] as { index: number }).index] = position + 1;
    }
    position = last + 1;
  }
  return out;
}

function asNumber(value: Value): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  return undefined;
}

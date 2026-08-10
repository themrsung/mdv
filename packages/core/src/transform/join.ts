/**
 * `join` — combine with another dataset (SPEC 6.7).
 *
 * ```yaml
 * - join: {with: "@targets", on: region, how: left}
 * ```
 *
 * `how` defaults to `left`, which is the safe default for a chart: an unmatched
 * row keeps its own values with nulls beside them, rather than vanishing and
 * quietly shrinking the picture.
 */

import type { Column, JoinStep, Table, Value } from '../types/data.js';
import { tupleKey } from './order.js';
import { fieldIndex, uniqueName, type TransformContext } from './context.js';

export function applyJoin(table: Table, spec: JoinStep['join'], ctx: TransformContext): Table {
  const lookup = ctx.lookup;
  if (lookup === undefined) {
    ctx.diag.emit('MDV2142', {
      message: `\`join\` cannot resolve \`${spec.with}\` here`,
      detail: 'This pipeline was evaluated without a dataset registry.',
    });
    return table;
  }

  const right = lookup(spec.with);
  if (right === undefined) {
    ctx.diag.emit('MDV2142', {
      message: `\`join\` references the unresolved dataset \`${spec.with}\``,
      detail: 'The left table was left unchanged (SPEC 6.3).',
    });
    return table;
  }

  const leftName = typeof spec.on === 'string' ? spec.on : spec.on.left;
  const rightName = typeof spec.on === 'string' ? spec.on : spec.on.right;

  const leftAt = fieldIndex(table.fields).get(leftName);
  const rightAt = fieldIndex(right.fields).get(rightName);
  if (leftAt === undefined || rightAt === undefined) {
    ctx.diag.emit('MDV2111', {
      message: `\`join\` references unknown field \`${leftAt === undefined ? leftName : rightName}\``,
      detail: `The join key must exist on both sides; the left table was left unchanged.`,
    });
    return table;
  }

  const how = spec.how ?? 'left';

  // Right-hand rows indexed by key. Built once, so the join is linear in the
  // two inputs rather than quadratic.
  const buckets = new Map<string, Value[][]>();
  for (const row of right.rows) {
    const key = tupleKey([row[rightAt] ?? null]);
    const bucket = buckets.get(key);
    if (bucket === undefined) buckets.set(key, [row]);
    else bucket.push(row);
  }

  // The right key column is dropped: it repeats the left key by construction.
  const carried: number[] = [];
  for (let i = 0; i < right.fields.length; i += 1) {
    if (i !== rightAt) carried.push(i);
  }

  const taken = new Set(table.fields.map((field) => field.name));
  const appended: Column[] = carried.map((at) => {
    const source = right.fields[at] as Column;
    const name = uniqueName(taken, source.name);
    taken.add(name);
    return { ...source, name };
  });

  const rows: Value[][] = [];
  for (const row of table.rows) {
    const matches = buckets.get(tupleKey([row[leftAt] ?? null]));
    if (matches === undefined) {
      // An inner join drops the row; a left join keeps it with null padding.
      if (how === 'inner') continue;
      rows.push([...row, ...carried.map(() => null)]);
      continue;
    }
    for (const match of matches) {
      rows.push([...row, ...carried.map((at) => match[at] ?? null)]);
    }
  }

  return { fields: [...table.fields.map((field) => ({ ...field })), ...appended], rows };
}

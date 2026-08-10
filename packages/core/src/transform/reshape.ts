/**
 * The reshaping steps of SPEC 6.7: `pivot`, `unpivot` and `bin`.
 */

import type { BinStep, Column, PivotStep, Table, UnpivotStep, Value } from '../types/data.js';
import { formatValue } from '../data/format.js';
import { compareValues, tupleKey } from './order.js';
import { fieldIndex, typeOfValues, uniqueName, type TransformContext } from './context.js';

/**
 * `pivot` — long → wide.
 *
 * > New field names come from the `key` column's values, sorted for
 * > determinism. (SPEC 6.7)
 *
 * Sorting is on the *value*, not on its rendering, so `2` lands before `10`;
 * the rendering only supplies the field name.
 */
export function applyPivot(table: Table, spec: PivotStep['pivot'], ctx: TransformContext): Table {
  const index = fieldIndex(table.fields);
  const keyAt = index.get(spec.key);
  const valueAt = index.get(spec.value);

  if (keyAt === undefined || valueAt === undefined) {
    ctx.diag.emit('MDV2111', {
      message: `\`pivot\` references unknown field \`${keyAt === undefined ? spec.key : spec.value}\``,
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  const groupNames =
    spec.group === undefined ? [] : typeof spec.group === 'string' ? [spec.group] : [...spec.group];
  const groupAt: number[] = [];
  for (const name of groupNames) {
    const at = index.get(name);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`pivot.group\` references unknown field \`${name}\``,
        detail: 'The field was dropped from the grouping.',
      });
      continue;
    }
    groupAt.push(at);
  }

  // ── Distinct key values, sorted ────────────────────────────────────────────
  const distinct: Value[] = [];
  for (const row of table.rows) {
    const key = row[keyAt] ?? null;
    if (!distinct.some((other) => compareValues(other, key) === 0)) distinct.push(key);
  }
  distinct.sort((a, b) => compareValues(a, b));

  // ── Groups, in first-appearance order ──────────────────────────────────────
  const order: string[] = [];
  const groups = new Map<string, { key: Value[]; cells: Map<number, Value> }>();
  for (const row of table.rows) {
    const key = groupAt.map((at) => row[at] ?? null);
    const id = tupleKey(key);
    let group = groups.get(id);
    if (group === undefined) {
      group = { key, cells: new Map() };
      groups.set(id, group);
      order.push(id);
    }
    const column = distinct.findIndex((value) => compareValues(value, row[keyAt] ?? null) === 0);
    // Two rows in one group sharing a key: the later wins, matching the "last
    // definition wins" rule the rest of the format uses for collisions.
    group.cells.set(column, row[valueAt] ?? null);
  }

  const taken = new Set(groupAt.map((at) => (table.fields[at] as Column).name));
  const names = distinct.map((value) => {
    const rendered = nameOf(value, ctx);
    const name = uniqueName(taken, rendered);
    taken.add(name);
    return name;
  });

  const rows: Value[][] = order.map((id) => {
    const group = groups.get(id) as { key: Value[]; cells: Map<number, Value> };
    return [...group.key, ...distinct.map((_value, column) => group.cells.get(column) ?? null)];
  });

  const fields: Column[] = [
    ...groupAt.map((at) => ({ ...(table.fields[at] as Column) })),
    ...names.map((name, column) => ({
      name,
      type: typeOfValues(rows.map((row) => row[groupAt.length + column] ?? null)),
      inferred: true,
    })),
  ];

  return { fields, rows };
}

/** A pivoted column's name: the key value as text, never empty. */
function nameOf(value: Value, ctx: TransformContext): string {
  if (value === null) return 'null';
  const rendered = formatValue(value, undefined, ctx.format);
  return rendered === '' ? 'null' : rendered;
}

/**
 * `unpivot` — wide → long. Defaults `key: "key"`, `value: "value"` (SPEC 6.7).
 *
 * The fields that are *not* unpivoted stay, in their original order, so an id
 * column keeps identifying its rows.
 */
export function applyUnpivot(
  table: Table,
  spec: UnpivotStep['unpivot'],
  ctx: TransformContext,
): Table {
  const index = fieldIndex(table.fields);
  const melted: number[] = [];
  for (const name of spec.fields) {
    const at = index.get(name);
    if (at === undefined) {
      ctx.diag.emit('MDV2111', {
        message: `\`unpivot\` references unknown field \`${name}\``,
        detail: 'The field was skipped.',
      });
      continue;
    }
    melted.push(at);
  }

  if (melted.length === 0) {
    ctx.diag.emit('MDV2501', {
      message: '`unpivot` matched no fields',
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  const kept: number[] = [];
  for (let i = 0; i < table.fields.length; i += 1) {
    if (!melted.includes(i)) kept.push(i);
  }

  const taken = new Set(kept.map((at) => (table.fields[at] as Column).name));
  const keyName = uniqueName(taken, spec.key ?? 'key');
  taken.add(keyName);
  const valueName = uniqueName(taken, spec.value ?? 'value');

  const rows: Value[][] = [];
  for (const row of table.rows) {
    for (const at of melted) {
      rows.push([
        ...kept.map((keep) => row[keep] ?? null),
        (table.fields[at] as Column).name,
        row[at] ?? null,
      ]);
    }
  }

  const fields: Column[] = [
    ...kept.map((at) => ({ ...(table.fields[at] as Column) })),
    { name: keyName, type: 'category' as const, inferred: true },
    {
      name: valueName,
      type: typeOfValues(rows.map((row) => row[kept.length + 1] ?? null)),
      inferred: true,
    },
  ];

  return { fields, rows };
}

/**
 * `bin` — numeric or temporal binning; "`step` wins over `count`" (SPEC 6.7).
 *
 * The bin's **lower edge** is the value written out, because that is what an
 * axis can place: a histogram bar starts at its edge, not at a label.
 */
export function applyBin(table: Table, spec: BinStep['bin'], ctx: TransformContext): Table {
  const index = fieldIndex(table.fields);
  const at = index.get(spec.field);
  if (at === undefined) {
    ctx.diag.emit('MDV2111', {
      message: `\`bin\` references unknown field \`${spec.field}\``,
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  const source = table.fields[at] as Column;
  const temporal = source.type === 'date' || source.type === 'datetime' || source.type === 'time';

  const numbers: number[] = [];
  for (const row of table.rows) {
    const cell = row[at] ?? null;
    if (cell === null) continue;
    if (typeof cell === 'number') numbers.push(cell);
    else if (cell instanceof Date) numbers.push(cell.getTime());
  }

  if (numbers.length === 0) {
    ctx.diag.emit('MDV2502', {
      message: `\`bin\` needs numeric or temporal values, but \`${spec.field}\` has none`,
      detail: 'The table was left unchanged.',
    });
    return table;
  }

  let min = numbers[0] as number;
  let max = min;
  for (const value of numbers) {
    if (value < min) min = value;
    if (value > max) max = value;
  }

  let step: number;
  if (spec.step !== undefined && Number.isFinite(spec.step) && spec.step > 0) {
    step = spec.step;
  } else if (spec.count !== undefined && Number.isFinite(spec.count) && spec.count > 0) {
    const span = max - min;
    step = span === 0 ? 1 : span / Math.trunc(spec.count);
  } else {
    ctx.diag.emit('MDV2501', {
      message: '`bin` needs a positive `step` or `count`',
      detail: `Got ${JSON.stringify({ step: spec.step, count: spec.count })}.`,
    });
    return table;
  }

  // Bins are anchored at the minimum rather than at zero, so a range like
  // 1000–1100 does not collapse into one bin whose edge is 0.
  const anchor = min;
  const values: Value[] = table.rows.map((row) => {
    const cell = row[at] ?? null;
    if (cell === null) return null;
    const numeric = typeof cell === 'number' ? cell : cell instanceof Date ? cell.getTime() : null;
    if (numeric === null) return null;
    const edge = anchor + binIndex(numeric - anchor, step) * step;
    return temporal ? new Date(edge) : round(edge, step);
  });

  const outputName = spec.output ?? `${spec.field}_bin`;
  const existing = index.get(outputName);
  if (existing !== undefined) {
    const fields = table.fields.map((field, i) =>
      i === existing
        ? { name: outputName, type: typeOfValues(values), inferred: true }
        : { ...field },
    );
    return {
      fields,
      rows: table.rows.map((row, i) =>
        row.map((cell, j) => (j === existing ? (values[i] ?? null) : cell)),
      ),
    };
  }

  return {
    fields: [
      ...table.fields.map((field) => ({ ...field })),
      { name: outputName, type: typeOfValues(values), inferred: true },
    ],
    rows: table.rows.map((row, i) => [...row, values[i] ?? null]),
  };
}

/**
 * Which bin an offset falls in.
 *
 * A plain `Math.floor(offset / step)` puts `0.7` in the `0.6` bin when the step
 * is `0.1`, because `(0.7 - 0.1) / 0.1` is `5.999999999999999` in binary
 * floating point. A value that sits within float dust of an edge belongs *on*
 * that edge, so the quotient is snapped to a whole number first; a value that is
 * genuinely interior (a quotient of `2.4999999999999996`) is untouched.
 */
function binIndex(offset: number, step: number): number {
  const quotient = offset / step;
  const nearest = Math.round(quotient);
  const tolerance = 1e-9 * Math.max(1, Math.abs(quotient));
  return Math.abs(quotient - nearest) < tolerance ? nearest : Math.floor(quotient);
}

/**
 * Trim the floating-point dust an edge accumulates: with `step: 0.1`, an edge of
 * `0.30000000000000004` would print as its own bin label.
 */
function round(edge: number, step: number): number {
  const decimals = decimalsOf(step);
  if (decimals === 0) return edge;
  const scale = 10 ** decimals;
  return Math.round(edge * scale) / scale;
}

function decimalsOf(step: number): number {
  if (Number.isInteger(step)) return 0;
  const text = String(step);
  const dot = text.indexOf('.');
  if (dot === -1) return 0;
  const exponent = text.indexOf('e');
  if (exponent !== -1) return Math.min(12, Math.max(0, exponent - dot - 1));
  return Math.min(12, text.length - dot - 1);
}

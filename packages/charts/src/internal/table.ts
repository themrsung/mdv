/**
 * Reading the prepared table (SPEC 6) and resolving channel bindings (SPEC 7.1).
 *
 * The prepared table is **memoised and shared with other blocks** — every
 * accessor here is read-only, and none of them copies a row unless it must.
 */

import type { Channel, ChannelName, Column, DataType, Encoding, ScaleInput, Table, Value } from '@mdv/core';
import { humanise } from './format.js';
import { isFiniteNumber } from './num.js';

/** A resolved binding: the channel, its column, and the column's position. */
export interface BoundField {
  channel: Channel;
  column: Column;
  index: number;
}

/** Normalise a channel binding to a list; `y: [a, b]` is wide form (SPEC 7.1.1). */
export function channelList(encoding: Encoding, name: ChannelName): readonly Channel[] {
  const value = encoding[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value.filter((c): c is Channel => c !== undefined && c !== null) : [value];
}

/**
 * Whether a channel was written as a JSON array, regardless of its length.
 *
 * `channelList` deliberately flattens `y: [a]` and `y: a` to the same thing,
 * because for encoding purposes they are the same thing. Validation is the one
 * place that must tell them apart: SPEC 7.1 makes `series` mutually exclusive
 * with a *list-valued* `y`, and the schema in Appendix D spells that as
 * `{ "y": { "type": "array" } }` — a one-element list is still an array, so
 * `y: [revenue]` with `series` is `MDV3010` just as `y: [a, b]` is.
 */
export function isChannelList(encoding: Encoding, name: ChannelName): boolean {
  return Array.isArray(encoding[name]);
}

/** The first binding for a channel, or `undefined`. */
export function firstChannel(encoding: Encoding, name: ChannelName): Channel | undefined {
  return channelList(encoding, name)[0];
}

/**
 * The first binding among several channel names.
 *
 * Pie accepts its identity as `category`, `x` or `label` (SPEC 8.5); this is how
 * those aliases resolve without duplicating the lookup at each call site.
 */
export function firstChannelOf(encoding: Encoding, names: readonly ChannelName[]): Channel | undefined {
  for (const name of names) {
    const channel = firstChannel(encoding, name);
    if (channel !== undefined) return channel;
  }
  return undefined;
}

/** Locate a column by exact, case-sensitive name (SPEC 6.1.2). */
export function findColumn(table: Table, field: string | undefined): { column: Column; index: number } | undefined {
  if (field === undefined) return undefined;
  for (let i = 0; i < table.fields.length; i += 1) {
    const column = table.fields[i];
    if (column !== undefined && column.name === field) return { column, index: i };
  }
  return undefined;
}

/** Resolve a channel to its column, or `undefined` when unbound or missing. */
export function bindField(table: Table, channel: Channel | undefined): BoundField | undefined {
  if (channel === undefined) return undefined;
  const found = findColumn(table, channel.field);
  if (found === undefined) return undefined;
  return { channel, column: found.column, index: found.index };
}

/** Read one cell. Out-of-range indices yield `null`, never a throw. */
export function cell(table: Table, row: number, column: number): Value {
  const values = table.rows[row];
  if (values === undefined) return null;
  const value = values[column];
  return value === undefined ? null : value;
}

/**
 * Coerce a cell to a number.
 *
 * Booleans do **not** coerce: `true` is not 1 in a measure, and silently making
 * it so would misstate a magnitude. Numeric strings do, because a CSV column
 * that failed inference should still plot.
 */
export function cellNumber(value: Value): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed.replace(/,/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Coerce a cell to a positional scale input, preserving dates as dates. */
export function cellScaleInput(value: Value): ScaleInput | null {
  if (value === null) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return String(value);
  return value;
}

/** `true` for the temporal types of SPEC 6.1. */
export function isTemporal(type: DataType | undefined): boolean {
  return type === 'date' || type === 'datetime' || type === 'time';
}

/** `true` for the types a continuous scale accepts. */
export function isQuantitative(type: DataType | undefined): boolean {
  return type === 'number' || type === 'integer' || type === 'duration';
}

/** `true` for the discrete types. */
export function isDiscrete(type: DataType | undefined): boolean {
  return type === 'string' || type === 'category' || type === 'boolean';
}

/** The title a channel should carry: explicit, else the humanised field name. */
export function channelTitle(channel: Channel | undefined, column: Column | undefined): string | false {
  if (channel?.title === false) return false;
  if (typeof channel?.title === 'string') return channel.title;
  if (column?.title !== undefined) return column.title;
  return column?.name ?? '';
}

/** A column's display name: its declared title, else the humanised field name. */
export function humaniseColumn(column: Column): string {
  return column.title ?? humanise(column.name);
}

/** The format spec in force for a channel: channel override, else the column's. */
export function channelFormat(channel: Channel | undefined, column: Column | undefined): string | undefined {
  return channel?.format ?? column?.format;
}

/**
 * Distinct values of a column in **first-appearance order** (SPEC 11.2 rule 1).
 *
 * First-appearance order over the unfiltered table is what makes a series keep
 * its palette slot when a filter removes another series — never sort this.
 */
export function distinctValues(table: Table, columnIndex: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let row = 0; row < table.rows.length; row += 1) {
    const value = cell(table, row, columnIndex);
    if (value === null) continue;
    const key = value instanceof Date ? value.toISOString() : String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** `true` when every cell of a column is null — an all-null column (SPEC 6.5). */
export function isColumnAllNull(table: Table, columnIndex: number): boolean {
  for (let row = 0; row < table.rows.length; row += 1) {
    if (cell(table, row, columnIndex) !== null) return false;
  }
  return true;
}

/** Every finite numeric value of a column, for extent computation. */
export function numericColumn(table: Table, columnIndex: number): number[] {
  const out: number[] = [];
  for (let row = 0; row < table.rows.length; row += 1) {
    const numeric = cellNumber(cell(table, row, columnIndex));
    if (isFiniteNumber(numeric)) out.push(numeric);
  }
  return out;
}

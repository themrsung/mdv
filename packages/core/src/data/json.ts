/**
 * `json` and `ndjson` (SPEC 6.2.3).
 *
 * > Field order is the key order of the **first** object; keys appearing only in
 * > later objects are appended in first-seen order. Nested objects and arrays
 * > are flattened with `.` and `[n]` path segments up to `maxFlattenDepth`
 * > (default 4). Values that remain non-scalar after flattening become their
 * > JSON text.
 *
 * `JSON.parse` is the parser: it is a total function on strings, it cannot
 * execute anything (SPEC 13.1), and its key order is specified by ECMAScript,
 * so two conforming engines agree (SPEC 24.3).
 */

import type { DiagCollector } from './diag.js';
import { LIMITS } from './limits.js';
import type { ParsedData, RawCell } from './raw.js';
import { isBlank, splitLines, stripBom } from './raw.js';

/** Options shared by the two JSON readers. */
export interface JsonOptions {
  /** Field names for an array-of-arrays payload (SPEC 6.2.3). */
  columns?: readonly string[] | undefined;
  /** @defaultValue 4 */
  maxFlattenDepth?: number | undefined;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function isRecord(v: Json): v is { [k: string]: Json } {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Flatten one record into `path → scalar`, in first-seen path order.
 *
 * Beyond `maxDepth` a container becomes its JSON text rather than more fields —
 * a bounded, honest degradation instead of an unbounded field explosion.
 */
export function flattenRecord(
  value: Json,
  maxDepth: number,
  into: Map<string, RawCell> = new Map(),
  prefix = '',
  depth = 0,
): Map<string, RawCell> {
  if (Array.isArray(value)) {
    if (depth >= maxDepth) {
      into.set(prefix, JSON.stringify(value));
      return into;
    }
    for (let i = 0; i < value.length; i += 1) {
      flattenRecord(value[i] as Json, maxDepth, into, `${prefix}[${i}]`, depth + 1);
    }
    return into;
  }
  if (isRecord(value)) {
    if (depth >= maxDepth) {
      into.set(prefix, JSON.stringify(value));
      return into;
    }
    for (const key of Object.keys(value)) {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      flattenRecord(value[key] as Json, maxDepth, into, path, depth + 1);
    }
    return into;
  }
  into.set(prefix, value);
  return into;
}

function assemble(records: readonly Json[], options: JsonOptions, diag: DiagCollector): ParsedData {
  const maxDepth = options.maxFlattenDepth ?? LIMITS.maxFlattenDepth;
  const order: string[] = [];
  const seen = new Set<string>();
  const flat: Map<string, RawCell>[] = [];

  let arrayRows: RawCell[][] | undefined;

  for (const record of records) {
    if (Array.isArray(record)) {
      // An array of arrays: field names must come from `columns:`.
      arrayRows ??= [];
      const row: RawCell[] = [];
      for (const cell of record) {
        row.push(
          typeof cell === 'object' && cell !== null ? JSON.stringify(cell) : (cell as RawCell),
        );
      }
      arrayRows.push(row);
      continue;
    }
    const m = flattenRecord(record, maxDepth);
    flat.push(m);
    for (const key of m.keys()) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }

  if (arrayRows !== undefined) {
    if (flat.length > 0) {
      diag.emit('MDV2102', {
        message: 'JSON data mixes objects and arrays',
        detail: 'Use either an array of objects, or an array of arrays with `columns:` declared.',
      });
    }
    let width = 0;
    for (const r of arrayRows) width = Math.max(width, r.length);
    let fields: string[];
    if (options.columns !== undefined && options.columns.length > 0) {
      fields = [...options.columns];
    } else {
      diag.emit('MDV2102', {
        message: 'JSON array-of-arrays has no `columns:` declaration',
        detail: 'Declare `columns: [a, b, …]`; positional names were used instead.',
      });
      fields = [];
      for (let c = 0; c < width; c += 1) fields.push(`column_${c + 1}`);
    }
    return { fields, rows: arrayRows };
  }

  const rows: RawCell[][] = flat.map((m) => order.map((k) => m.get(k) ?? null));
  return { fields: order, rows };
}

/** Parse a `json` data section: an array of objects, or an array of arrays. */
export function parseJson(input: string, options: JsonOptions, diag: DiagCollector): ParsedData {
  const text = stripBom(input).trim();
  if (text === '') return { fields: [], rows: [] };

  let value: Json;
  try {
    value = JSON.parse(text) as Json;
  } catch (error) {
    diag.emit('MDV2102', {
      message: 'Data section is not valid JSON',
      detail: error instanceof Error ? error.message : undefined,
    });
    return { fields: [], rows: [] };
  }

  if (Array.isArray(value)) return assemble(value, options, diag);
  if (isRecord(value)) return assemble([value], options, diag);

  diag.emit('MDV2102', {
    message: 'JSON data must be an array of objects or an object',
    detail: `Found a bare ${typeof value === 'object' ? 'null' : typeof value}.`,
  });
  return { fields: [], rows: [] };
}

/** Parse an `ndjson` data section: one JSON object per line. */
export function parseNdjson(input: string, options: JsonOptions, diag: DiagCollector): ParsedData {
  const lines = splitLines(stripBom(input));
  const records: Json[] = [];
  let reported = false;

  for (const line of lines) {
    if (isBlank(line)) continue;
    try {
      records.push(JSON.parse(line) as Json);
    } catch {
      if (!reported) {
        reported = true;
        diag.emit('MDV2102', {
          message: 'Line is not valid JSON in an `ndjson` data section',
          detail: 'Every non-blank line must be one complete JSON value.',
        });
      }
    }
  }
  return assemble(records, options, diag);
}

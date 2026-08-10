/**
 * `columns` (SPEC 6.2.4) — a mapping of field name → sequence of values.
 *
 * ```yaml
 * month:   [Jan, Feb, Mar, Apr]
 * actual:  [120, 145, 132, 168]
 * ```
 *
 * Flow sequences (including ones that span lines) and block sequences are both
 * accepted. All sequences MUST have equal length (`MDV2130`).
 *
 * Hand-written rather than delegated to a YAML library: `@mdv/core` reads this
 * on the hot path for untrusted input, and the accepted grammar here is exactly
 * MDV attribute notation (SPEC 5.3.1) — in particular only `true`/`false` are
 * booleans, so `no` stays the string "no" (the Norway problem).
 */

import type { DiagCollector } from './diag.js';
import type { ParsedData, RawCell } from './raw.js';
import { isBlank, splitLines, stripBom } from './raw.js';
import { parseScalarToken } from './scalar.js';

interface Sequence {
  name: string;
  values: RawCell[];
}

/** Split a flow-sequence body on commas that are not inside quotes or brackets. */
function splitFlowItems(body: string): string[] {
  const items: string[] = [];
  let item = '';
  let depth = 0;
  let quote: string | undefined;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (quote !== undefined) {
      item += ch;
      if (ch === '\\' && i + 1 < body.length) {
        item += body[i + 1] as string;
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      item += ch;
      continue;
    }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    if (ch === ',' && depth === 0) {
      items.push(item);
      item = '';
      continue;
    }
    item += ch;
  }
  if (item.trim() !== '' || items.length > 0) items.push(item);
  return items;
}

/** Index of the `:` separating a key from its value, ignoring quoted keys. */
function keySeparator(line: string): number {
  let quote: string | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote !== undefined) {
      if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ':') return i;
  }
  return -1;
}

/** Parse a `columns` data section. */
export function parseColumns(input: string, diag: DiagCollector): ParsedData {
  const lines = splitLines(stripBom(input));
  const sequences: Sequence[] = [];
  let current: Sequence | undefined;
  let pendingFlow: string | undefined;
  let malformed = false;

  const finishFlow = (): void => {
    if (pendingFlow === undefined || current === undefined) return;
    const open = pendingFlow.indexOf('[');
    const close = pendingFlow.lastIndexOf(']');
    const body = close > open ? pendingFlow.slice(open + 1, close) : pendingFlow.slice(open + 1);
    for (const item of splitFlowItems(body)) {
      const text = item.trim();
      if (text === '' && splitFlowItems(body).length === 1) continue;
      current.values.push(parseScalarToken(text));
    }
    pendingFlow = undefined;
  };

  for (const raw of lines) {
    if (pendingFlow !== undefined) {
      pendingFlow += `\n${raw}`;
      if (raw.includes(']')) finishFlow();
      continue;
    }
    if (isBlank(raw)) continue;

    const trimmed = raw.trim();
    if (trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') || trimmed === '-') {
      if (current === undefined) {
        malformed = true;
        continue;
      }
      current.values.push(parseScalarToken(trimmed.slice(1).trim()));
      continue;
    }

    const sep = keySeparator(trimmed);
    if (sep < 0) {
      malformed = true;
      continue;
    }
    const name = unquote(trimmed.slice(0, sep).trim());
    const rest = trimmed.slice(sep + 1).trim();
    current = { name, values: [] };
    sequences.push(current);

    if (rest.startsWith('[')) {
      pendingFlow = rest;
      if (rest.includes(']')) finishFlow();
      continue;
    }
    if (rest !== '') {
      // A scalar where a sequence was expected: treat it as a one-value column.
      current.values.push(parseScalarToken(rest));
    }
  }
  finishFlow();

  if (malformed) {
    diag.emit('MDV2102', {
      message: 'Data section does not parse as `columns`',
      detail: 'Every entry must be `name: [v1, v2, …]` or a block sequence under `name:`.',
    });
  }
  if (sequences.length === 0) return { fields: [], rows: [] };

  const length = sequences[0]?.values.length ?? 0;
  let ragged = false;
  for (const seq of sequences) {
    if (seq.values.length !== length) ragged = true;
  }
  if (ragged) {
    const shape = sequences.map((s) => `${s.name}=${s.values.length}`).join(', ');
    diag.emit('MDV2130', { message: `\`columns\` sequences have unequal length (${shape})` });
  }

  let height = 0;
  for (const seq of sequences) height = Math.max(height, seq.values.length);

  const rows: RawCell[][] = [];
  for (let r = 0; r < height; r += 1) {
    rows.push(sequences.map((s) => s.values[r] ?? null));
  }
  return { fields: sequences.map((s) => s.name), rows };
}

function unquote(text: string): string {
  if (text.length >= 2) {
    const first = text[0];
    if ((first === '"' || first === "'") && text[text.length - 1] === first) {
      return text.slice(1, -1);
    }
  }
  return text;
}

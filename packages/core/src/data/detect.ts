/**
 * Auto-detection (SPEC 6.2.6).
 *
 * > Applied to the first non-blank line of the data section, in order. The rules
 * > are exhaustive and MUST be applied exactly:
 * >
 * > 1. Begins with `[` or `{` → `json`.
 * > 2. Every non-blank line begins with `{` → `ndjson`.
 * > 3. Contains an unescaped `|` → `table`.
 * > 4. Contains a TAB → `tsv`.
 * > 5. Matches `^\s*[A-Za-z_][\w.-]*\s*:\s*\[` → `columns`.
 * > 6. Otherwise → `csv`.
 *
 * One clarification is unavoidable: taken in the literal order, rule 2 is
 * unreachable, because any section whose first line begins with `{` has already
 * matched rule 1. This implementation therefore tests `[` under rule 1, then
 * rule 2, then `{` under rule 1 — the only reading in which every rule can
 * fire. Where the two readings differ (a `{`-initial section), they agree on the
 * resulting table: a single JSON object and a one-line NDJSON stream are the
 * same one-row table.
 */

import type { DataFormat } from '../types/data.js';
import { isBlank, splitLines, stripBom } from './raw.js';

/** A concrete format: {@link DataFormat} minus `auto`. */
export type ConcreteFormat = Exclude<DataFormat, 'auto'>;

/** `true` when the line contains a `|` that is not preceded by a backslash. */
export function hasUnescapedPipe(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\') {
      i += 1;
      continue;
    }
    if (line[i] === '|') return true;
  }
  return false;
}

/** Rule 5: `^\s*[A-Za-z_][\w.-]*\s*:\s*\[`, as a hand-written scan. */
export function looksLikeColumns(line: string): boolean {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i += 1;
  const start = i;
  if (i >= line.length || !isIdentStart(line.charCodeAt(i))) return false;
  i += 1;
  while (i < line.length && isIdentRest(line.charCodeAt(i))) i += 1;
  if (i === start) return false;
  while (i < line.length && isSpace(line.charCodeAt(i))) i += 1;
  if (line[i] !== ':') return false;
  i += 1;
  while (i < line.length && isSpace(line.charCodeAt(i))) i += 1;
  return line[i] === '[';
}

function isSpace(c: number): boolean {
  return c === 0x20 || c === 0x09;
}
function isIdentStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}
function isIdentRest(c: number): boolean {
  return (
    isIdentStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2e || c === 0x2d // `\w` plus `.` and `-`
  );
}

/**
 * Detect the syntax of a data section.
 *
 * Ambiguity resolves in favour of `table`, since it is the canonical format.
 */
export function detectFormat(raw: string): ConcreteFormat {
  const lines = splitLines(stripBom(raw));
  const nonBlank = lines.filter((l) => !isBlank(l));
  const first = nonBlank[0];
  if (first === undefined) return 'csv';

  const head = first.trimStart();
  if (head.startsWith('[')) return 'json';

  if (nonBlank.every((l) => l.trimStart().startsWith('{'))) return 'ndjson';
  if (head.startsWith('{')) return 'json';

  if (hasUnescapedPipe(first)) return 'table';
  if (first.includes('\t')) return 'tsv';
  if (looksLikeColumns(first)) return 'columns';
  return 'csv';
}

/** Map a response media type to a format (SPEC 6.4). `undefined` ⇒ auto-detect. */
export function formatFromMediaType(contentType: string | undefined): ConcreteFormat | undefined {
  if (contentType === undefined) return undefined;
  const mime = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  switch (mime) {
    case 'text/csv':
    case 'application/csv':
      return 'csv';
    case 'text/tab-separated-values':
      return 'tsv';
    case 'application/json':
    case 'text/json':
      return 'json';
    case 'application/x-ndjson':
    case 'application/ndjson':
    case 'application/jsonl':
      return 'ndjson';
    case 'text/markdown':
      return 'table';
    default:
      return undefined;
  }
}

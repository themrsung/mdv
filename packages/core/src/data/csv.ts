/**
 * `csv` and `tsv` (SPEC 6.2.2) — Level 1, and therefore mandatory.
 *
 * RFC 4180 with the spec's clarifications:
 *
 * - the first record is the header unless `header: false`;
 * - `\r\n` and `\n` both terminate a record (a lone `\r` does too — a Classic
 *   Mac file is not worth an error card);
 * - a quoted field may span lines;
 * - a UTF-8 BOM inside the data section is stripped;
 * - `delimiter:` overrides the separator for `csv`;
 * - `tsv` is tab-separated with **no quoting** and no embedded tabs.
 *
 * A line containing no characters at all is skipped; a line containing `""` is
 * a one-field record, because the author wrote something.
 *
 * Hand-written, single pass, no regular expressions: SPEC 13.6 requires parsing
 * to be linear in input size and free of catastrophic backtracking.
 */

import type { DiagCollector } from './diag.js';
import type { ParsedData, RawCell } from './raw.js';
import { stripBom } from './raw.js';

/** Options for {@link parseDelimited}. */
export interface DelimitedOptions {
  /** One character. Defaults to `,` for csv and `\t` for tsv. */
  delimiter: string;
  /** `false` when the first record is data and names are positional. */
  header: boolean;
  /** RFC 4180 double-quote handling. `false` for `tsv`. */
  quoting: boolean;
}

const QUOTE = 0x22;
const CR = 0x0d;
const LF = 0x0a;

/**
 * Scan delimited text into records. Never throws; an unterminated quote run is
 * reported as `MDV2102` and the partial record is kept.
 */
export function scanDelimited(
  input: string,
  delimiter: string,
  quoting: boolean,
  diag?: DiagCollector,
): string[][] {
  const text = stripBom(input);
  const delim = delimiter.charCodeAt(0);
  const records: string[][] = [];
  let record: string[] = [];
  let field = '';
  let touched = false; // any character consumed in the current record
  let i = 0;

  const endRecord = (): void => {
    if (touched || record.length > 0) {
      record.push(field);
      records.push(record);
      record = [];
    }
    field = '';
    touched = false;
  };

  while (i < text.length) {
    const c = text.charCodeAt(i);

    if (quoting && c === QUOTE && field.length === 0) {
      // A quoted field: everything up to the closing quote is literal, a
      // doubled quote is one quote, and newlines inside are data.
      i += 1;
      touched = true;
      let closed = false;
      while (i < text.length) {
        const q = text.charCodeAt(i);
        if (q === QUOTE) {
          if (text.charCodeAt(i + 1) === QUOTE) {
            field += '"';
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        field += text[i] as string;
        i += 1;
      }
      if (!closed) {
        diag?.emit('MDV2102', {
          message: 'Unterminated quoted field in the data section',
          detail: 'A `"` opened a field that is never closed. Double an embedded quote as `""`.',
        });
        endRecord();
        return records;
      }
      continue;
    }

    if (c === delim) {
      record.push(field);
      field = '';
      touched = true;
      i += 1;
      continue;
    }
    if (c === LF) {
      endRecord();
      i += 1;
      continue;
    }
    if (c === CR) {
      endRecord();
      i += text.charCodeAt(i + 1) === LF ? 2 : 1;
      continue;
    }
    field += text[i] as string;
    touched = true;
    i += 1;
  }

  endRecord();
  return records;
}

/**
 * Parse a `csv` or `tsv` data section into {@link ParsedData}.
 *
 * Ragged records are **not** padded here — `buildTable` owns `MDV2120`/`MDV2121`
 * so every format reports raggedness identically.
 */
export function parseDelimited(
  input: string,
  options: DelimitedOptions,
  diag: DiagCollector,
): ParsedData {
  const records = scanDelimited(input, options.delimiter, options.quoting, diag);
  if (records.length === 0) return { fields: [], rows: [] };

  if (options.header) {
    const head = records[0] as string[];
    const rows: RawCell[][] = [];
    for (let r = 1; r < records.length; r += 1) rows.push(records[r] as RawCell[]);
    return { fields: [...head], rows };
  }

  let width = 0;
  for (const r of records) width = Math.max(width, r.length);
  const fields: string[] = [];
  for (let c = 0; c < width; c += 1) fields.push(`column_${c + 1}`);
  return { fields, rows: records.map((r) => r as RawCell[]) };
}

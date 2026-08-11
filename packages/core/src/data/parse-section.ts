/**
 * The data-section dispatcher (SPEC 6.2): pick a reader, run it, and report what
 * was picked.
 *
 * `table`, `csv` and `tsv` are Level 1 and always available; `json`, `ndjson`,
 * `columns` and `matrix` are Level 2. Auto-detection emits `MDV2101` (info) so
 * an author can pin the format when the guess is wrong.
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { DataFormat, Table } from '../types/data.js';
import { buildTable, emptyTable, type BuildOptions } from './build.js';
import { parseColumns } from './columns.js';
import { parseDelimited } from './csv.js';
import { detectFormat, type ConcreteFormat } from './detect.js';
import type { DiagCollector } from './diag.js';
import { parseJson, parseNdjson } from './json.js';
import { isBlank, splitLines } from './raw.js';
import type { ParsedData } from './raw.js';
import { parseMatrix, parseTableFormat } from './table-format.js';

/** Formats available at each conformance level (SPEC 6.2, SPEC 16.1). */
export const LEVEL_1_FORMATS: readonly ConcreteFormat[] = Object.freeze(['table', 'csv', 'tsv']);

/** Reader options taken from the block or dataset header. */
export interface SectionOptions {
  /** @defaultValue 'auto' */
  format?: DataFormat | undefined;
  /** `delimiter:` overrides the separator for `csv`. */
  delimiter?: string | undefined;
  /** `header: false` makes the first record data (SPEC 6.2.2). */
  header?: boolean | undefined;
  /** `columns:` for a JSON array of arrays (SPEC 6.2.3). */
  columns?: readonly string[] | undefined;
  maxFlattenDepth?: number | undefined;
  /** The level in force; a Level 2 format below it is still read, with a note. */
  level?: ConformanceLevel | undefined;
}

/** What {@link parseDataSection} produced. */
export interface SectionResult {
  data: ParsedData;
  /** The format actually used. */
  format: ConcreteFormat;
  /** `true` when {@link format} came from auto-detection. */
  detected: boolean;
}

/** Read a data section into rows of raw cells. */
export function parseDataSection(
  raw: string,
  options: SectionOptions,
  diag: DiagCollector,
): SectionResult {
  const requested = options.format ?? 'auto';
  const empty = splitLines(raw).every(isBlank);

  if (empty) {
    if (raw.length === 0 || raw.trim() === '') {
      diag.emit('MDV2100');
    }
    return {
      data: { fields: [], rows: [] },
      format: requested === 'auto' ? 'csv' : requested,
      detected: false,
    };
  }

  const detected = requested === 'auto';
  const format: ConcreteFormat = detected ? detectFormat(raw) : requested;

  if (detected) {
    diag.emit('MDV2101', {
      message: `Data format auto-detected as \`${format}\``,
      detail: 'Declare `format:` to pin it if this is not what you meant.',
      severity: 'info',
    });
  }

  const data = read(raw, format, options, diag);
  return { data, format, detected };
}

function read(
  raw: string,
  format: ConcreteFormat,
  options: SectionOptions,
  diag: DiagCollector,
): ParsedData {
  const header = options.header ?? true;
  switch (format) {
    case 'table':
      return parseTableFormat(raw, diag);
    case 'csv':
      return parseDelimited(
        raw,
        { delimiter: firstChar(options.delimiter, ','), header, quoting: true },
        diag,
      );
    case 'tsv':
      return parseDelimited(raw, { delimiter: '\t', header, quoting: false }, diag);
    case 'json':
      return parseJson(
        raw,
        { columns: options.columns, maxFlattenDepth: options.maxFlattenDepth },
        diag,
      );
    case 'ndjson':
      return parseNdjson(
        raw,
        { columns: options.columns, maxFlattenDepth: options.maxFlattenDepth },
        diag,
      );
    case 'columns':
      return parseColumns(raw, diag);
    case 'matrix':
      return parseMatrix(raw, diag);
    default:
      return { fields: [], rows: [] };
  }
}

/**
 * The one character a `delimiter:` attribute means (SPEC 6.2.2).
 *
 * Exported because `locate.ts` has to split a header row the same way the
 * reader will, and a locator that disagreed with the reader about where a cell
 * starts would hand out ranges that edit the wrong characters.
 */
export function firstChar(value: string | undefined, fallback: string): string {
  if (value === undefined || value.length === 0) return fallback;
  if (value === '\\t') return '\t';
  return value[0] as string;
}

/** Read a data section straight through to a prepared {@link Table}. */
export function readTable(
  raw: string,
  section: SectionOptions,
  build: BuildOptions,
  diag: DiagCollector,
): { table: Table; format: ConcreteFormat } {
  const result = parseDataSection(raw, section, diag);
  if (result.data.fields.length === 0 && result.data.rows.length === 0) {
    return { table: emptyTable(), format: result.format };
  }
  return { table: buildTable(result.data, build, diag), format: result.format };
}

/**
 * The intermediate shape every data-format reader produces (SPEC 6.2), before
 * inference and coercion turn it into a {@link import('../types/data.js').Table}.
 *
 * Text formats (`table`, `csv`, `tsv`, `matrix`) yield strings; the JSON family
 * yields JSON scalars, which inference treats identically — SPEC 6.1.1 step 3
 * says "parse as JSON numbers", and a JSON number already has.
 */

/** A cell as it came out of a format reader, before null and type handling. */
export type RawCell = string | number | boolean | null;

/** A parsed data section. */
export interface ParsedData {
  /** Field names in source order, before trimming and de-duplication. */
  fields: string[];
  /** Row-major cells. Ragged rows are the reader's problem, not the caller's. */
  rows: RawCell[][];
  /**
   * Column alignment from a `table` delimiter row (SPEC 6.2.1), when present.
   * `undefined` entries mean "not specified".
   */
  align?: (('left' | 'center' | 'right') | undefined)[];
}

/** Strip a leading UTF-8 BOM (SPEC 6.2.2). */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Split into lines on `\n`, `\r\n` and a lone `\r`, dropping one trailing empty
 * line so a file that ends with a newline does not gain a blank record.
 */
export function splitLines(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c === 0x0a) {
      out.push(text.slice(start, i));
      start = i + 1;
    } else if (c === 0x0d) {
      out.push(text.slice(start, i));
      if (text.charCodeAt(i + 1) === 0x0a) i += 1;
      start = i + 1;
    }
  }
  if (start < text.length) out.push(text.slice(start));
  return out;
}

/** `true` when a line contains nothing but spaces and tabs. */
export function isBlank(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const c = line.charCodeAt(i);
    if (c !== 0x20 && c !== 0x09) return false;
  }
  return true;
}

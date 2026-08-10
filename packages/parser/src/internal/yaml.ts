/**
 * The YAML half of the parser, on its own so there is exactly one of it.
 *
 * Front matter (SPEC 3.4) and a block header (SPEC 5.1) are YAML, and so is a
 * theme file (SPEC 11.6). They are read by the same code and therefore mean the
 * same thing: in all three `#rrggbb` is a string, `on` and `yes` are *strings*
 * and only `true`/`false` are booleans (YAML 1.2's core schema, not 1.1's), and
 * a duplicate key loses to the last one. A second YAML reader elsewhere in the
 * workspace would be a second dialect, and the drift would show up as a theme
 * that resolves in the CLI and not in the editor.
 *
 * YAML 1.2 is a superset of JSON, so {@link parseYamlValue} reads a `.json`
 * file too — see the caveat there, which is not the one you would guess.
 *
 * `toAttrValue` is the boundary between `yaml`'s object model and MDV's
 * {@link AttrValue}: no `Date`, no `bigint`, no `NaN`, nothing that survives a
 * `JSON.parse(JSON.stringify(…))` differently than it went in — because the
 * canonical AST (SPEC 24.3) is JSON and must not depend on YAML's richer scalar
 * set.
 */

import { parseDocument } from 'yaml';
import type { AttrMap, AttrValue } from '../types.js';

/** A YAML syntax error, located in the text that was parsed. */
export interface YamlSyntaxError {
  /** One line, already trimmed of `yaml`'s multi-line source excerpt. */
  readonly message: string;
  /** UTF-16 offsets into the parsed text; `end` may equal `start`. */
  readonly start: number;
  readonly end: number;
}

/** What {@link parseYamlValue} produced. */
export interface YamlValueResult {
  /**
   * The document's value, or `null` for an empty or comment-only text — and
   * also for a text so broken that nothing survived, which is why `errors`
   * exists rather than a `null` check.
   */
  readonly value: AttrValue;
  readonly errors: readonly YamlSyntaxError[];
}

/**
 * Parse a standalone YAML (or JSON) text into an {@link AttrValue}.
 *
 * Never throws (SPEC 21): a syntax error is a `errors` entry, and the value is
 * whatever the parser could still recover — `yaml` is error-tolerant, so a file
 * with one bad line usually still yields the rest.
 *
 * Reading JSON with this is deliberate: YAML 1.2 is a superset, and every
 * *valid* JSON document means exactly the same thing to both readers. Invalid
 * JSON is where they part, and not always loudly — this reader accepts the
 * trailing comma in `{"a": 1,}`, and it does not know `//`, so
 *
 * ```json
 * { // a note
 *   "a": 1 }
 * ```
 *
 * parses without complaint into the single key `// a note "a"`. A caller that
 * lets an author point at a `.json` file must therefore not lean on `errors` to
 * catch it: `themeFromText` in `@mdv/themes` sends a `.json` file to
 * `JSON.parse` and only a `.yaml` file here, for exactly this reason.
 *
 * @param text - the whole file, already decoded to UTF-16 (SPEC 3.2)
 */
export function parseYamlValue(text: string): YamlValueResult {
  const errors: YamlSyntaxError[] = [];
  try {
    const document = parseDocument(text, { prettyErrors: false });
    for (const error of document.errors) {
      const start = error.pos[0] ?? 0;
      errors.push({ message: firstLine(error.message), start, end: error.pos[1] ?? start });
    }
    // `maxAliasCount` caps alias expansion: an anchor that references itself a
    // few times is the billion-laughs attack, and this file may be untrusted
    // workspace content (SPEC 25.2).
    return { value: toAttrValue(document.toJS({ maxAliasCount: 100 })), errors };
  } catch (error) {
    // `yaml` throws only for failures it does not model as a document error.
    errors.push({ message: describeYamlError(error), start: 0, end: 0 });
    return { value: null, errors };
  }
}

/** `yaml`'s object model → MDV's {@link AttrValue}. */
export function toAttrValue(value: unknown): AttrValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => toAttrValue(entry));
  if (value instanceof Map) {
    const out: AttrMap = {};
    for (const [key, entry] of value.entries()) out[String(key)] = toAttrValue(entry);
    return out;
  }
  if (typeof value === 'object') {
    const out: AttrMap = {};
    for (const [key, entry] of Object.entries(value)) out[key] = toAttrValue(entry);
    return out;
  }
  return String(value);
}

/** True for a mapping — the shape front matter and a theme file must both be. */
export function isAttrMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `yaml` appends a source excerpt to its messages; a diagnostic wants one line. */
export function firstLine(message: string): string {
  const index = message.indexOf('\n');
  return index === -1 ? message : message.slice(0, index);
}

export function describeYamlError(error: unknown): string {
  if (error instanceof Error) return firstLine(error.message);
  return 'The text could not be parsed as YAML.';
}

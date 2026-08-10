/**
 * Scalars and flow collections in MDV attribute notation (SPEC 5.3.1,
 * Appendix A).
 *
 * Two rules do the heavy lifting here and both are deliberate departures from
 * "just use a YAML parser":
 *
 * - **Only `true` and `false` are booleans.** `yes`, `no`, `on`, `off` are
 *   strings. This is the Norway problem, and MDV does not have it.
 * - **Numbers follow the JSON number grammar**, so no octal, no sexagesimal, no
 *   leading `+`, no bare `.5`.
 *
 * Everything else that looks scalar is a string. SPEC 5.3.3 then lets the
 * *schema* override the spelling — `title: 2026` is the string `"2026"` when
 * `title` is declared `string` — but that retyping happens in `@mdv/core`, which
 * is the layer that knows the schemas. The parser records the spelling.
 */

import type { AttrScalar, AttrValue } from '../types.js';

/** JSON number grammar (RFC 8259 §6), anchored. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** SPEC 5.3.1: `[A-Za-z_][A-Za-z0-9_-]*`, case-sensitive. */
export const ATTR_KEY = /^[A-Za-z_][A-Za-z0-9_-]*/;

/**
 * Type a *plain* (unquoted) scalar by its spelling, per SPEC 5.3.1.
 *
 * The empty string, `null` and `~` are null; `true`/`false` are booleans; a JSON
 * number is a number; everything else is a string.
 */
export function typePlainScalar(text: string): AttrScalar {
  if (text.length === 0 || text === 'null' || text === '~') return null;
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (JSON_NUMBER.test(text)) return Number(text);
  return text;
}

/**
 * Strip a trailing comment from a plain scalar (SPEC 5.3.1: a `#` beginning a
 * line, or preceded by whitespace, outside quotes) and trim the result.
 *
 * @returns the scalar text and the index just past its last character, so the
 * caller can record a range that excludes the comment.
 */
export function stripPlainComment(text: string, from: number): { text: string; end: number } {
  let end = text.length;
  for (let i = from; i < text.length; i += 1) {
    if (text.charCodeAt(i) !== 35 /* # */) continue;
    if (i === from) {
      end = i;
      break;
    }
    const previous = text.charCodeAt(i - 1);
    if (previous === 32 || previous === 9) {
      end = i;
      break;
    }
  }
  let start = from;
  while (start < end && isSpace(text.charCodeAt(start))) start += 1;
  while (end > start && isSpace(text.charCodeAt(end - 1))) end -= 1;
  return { text: text.slice(start, end), end };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

/** Result of reading a quoted scalar. */
export interface QuotedRead {
  value: string;
  /** Index just past the closing quote, or past the end when unterminated. */
  end: number;
  /** `false` when the closing quote is missing. */
  terminated: boolean;
}

/**
 * Read a quoted scalar starting at `start` (which must be `"` or `'`).
 *
 * Double quotes honour the JSON escape set plus `\uXXXX`; single quotes use the
 * YAML doubling convention (`''` is one apostrophe) and have no other escapes.
 */
export function readQuoted(text: string, start: number): QuotedRead {
  const quote = text.charCodeAt(start);
  const double = quote === 34;
  let i = start + 1;
  let out = '';
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code === quote) {
      if (!double && text.charCodeAt(i + 1) === quote) {
        out += "'";
        i += 2;
        continue;
      }
      return { value: out, end: i + 1, terminated: true };
    }
    if (double && code === 92 /* \ */ && i + 1 < text.length) {
      const next = text[i + 1] as string;
      switch (next) {
        case 'n':
          out += '\n';
          i += 2;
          continue;
        case 't':
          out += '\t';
          i += 2;
          continue;
        case 'r':
          out += '\r';
          i += 2;
          continue;
        case 'b':
          out += '\b';
          i += 2;
          continue;
        case 'f':
          out += '\f';
          i += 2;
          continue;
        case 'u': {
          const hex = text.slice(i + 2, i + 6);
          if (/^[0-9a-fA-F]{4}$/.test(hex)) {
            out += String.fromCharCode(Number.parseInt(hex, 16));
            i += 6;
            continue;
          }
          out += next;
          i += 2;
          continue;
        }
        default:
          out += next;
          i += 2;
          continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return { value: out, end: text.length, terminated: false };
}

/**
 * Serialise a string as a quoted scalar. Used by the formatter and by info-string
 * emission; always produces something {@link readQuoted} reads back identically.
 */
export function quoteScalar(value: string, quote: '"' | "'" = '"'): string {
  if (quote === "'") return `'${value.replaceAll("'", "''")}'`;
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case '"':
        out += '\\"';
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\t':
        out += '\\t';
        break;
      case '\r':
        out += '\\r';
        break;
      default:
        out += ch;
    }
  }
  return `${out}"`;
}

/**
 * SPEC 5.3.1: quoting is required when a plain scalar would be ambiguous — it
 * begins with `[ { " ' #`, contains `: `, or ends with `#`.
 */
export function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;
  if (value !== value.trim()) return true;
  if ('[{"\'#-'.includes(value[0] as string)) return true;
  if (value.includes(': ')) return true;
  if (value.endsWith('#')) return true;
  if (value.includes('\n')) return true;
  // A plain scalar that would retype on re-read has to be quoted to stay a string.
  return value === 'true' || value === 'false' || value === 'null' || value === '~';
}

// ─────────────────────────────────────────────────────────────────────────────
// Flow collections
// ─────────────────────────────────────────────────────────────────────────────

/** Receives a range for every path discovered while parsing a value. */
export type RangeSink = (path: string, start: number, end: number) => void;

/** Outcome of {@link readFlow}. */
export interface FlowRead {
  value: AttrValue;
  /** Index just past the value. */
  end: number;
  /** `false` when a bracket or brace is unbalanced. */
  ok: boolean;
}

/**
 * Read a flow sequence, flow mapping, quoted scalar or bare token starting at
 * `start`.
 *
 * `sink` is called with a dotted path for every node, so the caller can build
 * `attrsPosition` with exact per-key ranges. Offsets handed to `sink` are indices
 * into `text`; the caller adds its own base offset.
 */
export function readFlow(text: string, start: number, path: string, sink: RangeSink): FlowRead {
  const i = skipSpace(text, start);
  if (i >= text.length) {
    sink(path, start, start);
    return { value: null, end: i, ok: true };
  }
  const ch = text[i] as string;

  if (ch === '[') return readFlowSequence(text, i, path, sink);
  if (ch === '{') return readFlowMapping(text, i, path, sink);
  if (ch === '"' || ch === "'") {
    const quoted = readQuoted(text, i);
    sink(path, i, quoted.end);
    return { value: quoted.value, end: quoted.end, ok: quoted.terminated };
  }

  // Bare token: runs to the next structural character at this nesting level.
  let end = i;
  while (end < text.length && !',]}'.includes(text[end] as string)) end += 1;
  let trimmed = end;
  while (trimmed > i && isSpace(text.charCodeAt(trimmed - 1))) trimmed -= 1;
  sink(path, i, trimmed);
  return { value: typePlainScalar(text.slice(i, trimmed)), end, ok: true };
}

function readFlowSequence(text: string, start: number, path: string, sink: RangeSink): FlowRead {
  const items: AttrValue[] = [];
  let i = start + 1;
  let ok = true;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) {
      ok = false;
      break;
    }
    if (text[i] === ']') {
      i += 1;
      break;
    }
    const item = readFlow(text, i, `${path}[${items.length}]`, sink);
    items.push(item.value);
    ok = ok && item.ok;
    i = skipSpace(text, item.end);
    if (i < text.length && text[i] === ',') {
      i += 1;
      continue;
    }
    if (i < text.length && text[i] === ']') {
      i += 1;
      break;
    }
    if (i >= text.length) {
      ok = false;
      break;
    }
    // Junk between items: skip a character so we always make progress.
    ok = false;
    i += 1;
  }
  sink(path, start, i);
  return { value: items, end: i, ok };
}

function readFlowMapping(text: string, start: number, path: string, sink: RangeSink): FlowRead {
  const map: Record<string, AttrValue> = {};
  let i = start + 1;
  let ok = true;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) {
      ok = false;
      break;
    }
    if (text[i] === '}') {
      i += 1;
      break;
    }
    const keyMatch = ATTR_KEY.exec(text.slice(i));
    if (keyMatch === null) {
      ok = false;
      // Skip to the next separator so the rest of the mapping still parses.
      while (i < text.length && !',}'.includes(text[i] as string)) i += 1;
      if (i < text.length && text[i] === ',') {
        i += 1;
        continue;
      }
      continue;
    }
    const key = keyMatch[0];
    i += key.length;
    i = skipSpace(text, i);
    if (text[i] !== ':') {
      ok = false;
      map[key] = null;
      while (i < text.length && !',}'.includes(text[i] as string)) i += 1;
      if (i < text.length && text[i] === ',') i += 1;
      continue;
    }
    i += 1;
    const child = readFlow(text, i, path === '' ? key : `${path}.${key}`, sink);
    map[key] = child.value;
    ok = ok && child.ok;
    i = skipSpace(text, child.end);
    if (i < text.length && text[i] === ',') {
      i += 1;
      continue;
    }
    if (i < text.length && text[i] === '}') {
      i += 1;
      break;
    }
    if (i >= text.length) {
      ok = false;
      break;
    }
    ok = false;
    i += 1;
  }
  sink(path, start, i);
  return { value: map, end: i, ok };
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
  return i;
}

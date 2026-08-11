/**
 * The two one-line attribute grammars: the visual-block info string (SPEC 5.2)
 * and the directive attribute block (Appendix A `attr-block`).
 *
 * Both are parsed straight out of the raw source rather than out of anything
 * micromark hands back. micromark resolves character references and backslash
 * escapes in info strings, which would shift every offset in `attrsPosition` by
 * an unpredictable amount; the raw text is also what `toMarkdown` re-emits, so
 * parsing it keeps the round trip exact.
 */

import type { AttrMap, AttrRanges, Range } from '../types.js';
import type { DiagnosticBag } from './diagnostics.js';
import type { SourceIndex } from './source.js';
import { readQuoted, typePlainScalar } from './scalar.js';

/** SPEC 5.2: `block-type = ALPHA *( ALPHA / DIGIT / "-" )`. */
const BLOCK_TYPE = /^[A-Za-z][A-Za-z0-9-]*$/;

/** SPEC 5.2: `attr-key = ALPHA *( ALPHA / DIGIT / "-" / "_" )`. */
const INLINE_KEY = /^[A-Za-z][A-Za-z0-9_-]*/;

/** Appendix A: `ident` for `#id` and `.class`. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_-]*/;

/** What {@link parseInfoString} recovers from a fence's info string. */
export interface InfoString {
  /** Lowercased block type, or `null` when the info string omits it. */
  readonly type: string | null;
  /** Source range of the type token, when present. */
  readonly typeRange: Range | null;
  readonly attrs: AttrMap;
  readonly positions: AttrRanges;
  /**
   * `true` when any part of the line was rejected: a token that is neither a
   * type nor `key=value` is dropped, and a value with no text or an unclosed
   * quote is recovered as a guess. Either way the attributes no longer describe
   * the whole line, so the caller keeps the source verbatim (SPEC 19).
   */
  readonly malformed: boolean;
}

/**
 * Parse an info string (SPEC 5.2). `text` is the whole first line of the block
 * and `start` is the offset *within that line* of the character after the fence
 * run; `base` is the absolute offset of `text[0]`.
 *
 * The leading `mdv` token is consumed unconditionally: the caller has already
 * established that this is an MDV block.
 */
export function parseInfoString(
  text: string,
  start: number,
  base: number,
  root: SourceIndex,
  bag: DiagnosticBag,
): InfoString {
  const attrs: AttrMap = {};
  const positions: Record<string, Range> = {};
  let type: string | null = null;
  let typeRange: Range | null = null;
  let malformed = false;

  let i = skipSpace(text, start);
  // The `mdv` token itself.
  while (i < text.length && !isSpace(text.charCodeAt(i))) i += 1;

  let seenAttr = false;
  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length) break;
    const tokenStart = i;

    const keyMatch = INLINE_KEY.exec(text.slice(i));
    if (keyMatch === null) {
      const end = tokenEnd(text, i);
      bag.add('MDV1200', root.range(base + i, base + end), {
        detail: `\`${text.slice(i, end)}\` is neither a block type nor a \`key=value\` attribute.`,
      });
      malformed = true;
      i = end;
      continue;
    }

    const key = keyMatch[0];
    let cursor = i + key.length;

    if (text.charCodeAt(cursor) !== 61 /* = */) {
      const end = tokenEnd(text, i);
      const token = text.slice(i, end);
      if (seenAttr || type !== null || !BLOCK_TYPE.test(token)) {
        bag.add('MDV1200', root.range(base + i, base + end), {
          detail:
            type === null && !BLOCK_TYPE.test(token)
              ? `\`${token}\` is not a valid block type; types are letters, digits and hyphens.`
              : `\`${token}\` is not a \`key=value\` attribute.`,
        });
        malformed = true;
        i = end;
        continue;
      }
      type = token.toLowerCase();
      typeRange = root.range(base + i, base + end);
      i = end;
      continue;
    }

    seenAttr = true;
    cursor += 1;
    const quoted = text.charCodeAt(cursor) === 34 || text.charCodeAt(cursor) === 39;
    const value = readInlineValue(text, cursor);
    if (!value.ok) {
      bag.add('MDV1200', root.range(base + tokenStart, base + value.end), {
        detail: quoted
          ? `The value of \`${key}\` opens a quote that is never closed.`
          : `\`${key}=\` has no value; write \`${key}=""\` for an empty string.`,
      });
      malformed = true;
    }
    attrs[key] = value.value;
    positions[key] = root.range(base + cursor, base + value.end);
    i = value.end;
  }

  return { type, typeRange, attrs, positions, malformed };
}

/** What {@link parseAttrBlock} recovers from `{...}`. */
export interface AttrBlock {
  readonly attrs: AttrMap;
  readonly positions: AttrRanges;
  /** Offset just past the closing brace, or past the end when unterminated. */
  readonly end: number;
  /** `false` when the block is not closed. */
  readonly ok: boolean;
}

/**
 * Parse a directive attribute block (Appendix A).
 *
 * ```abnf
 * attr-block = "{" *WSP *( d-attr *( 1*WSP d-attr ) ) "}"
 * d-attr     = ( "#" ident ) / ( "." ident ) / ( attr-key "=" value )
 * ```
 *
 * `start` indexes the `{` in `text`; `base` is the absolute offset of `text[0]`.
 * Shorthands fold into ordinary attributes: `#x` sets `id`, and `.a .b` sets
 * `class` to `"a b"` (Appendix B types `class` as a string).
 */
export function parseAttrBlock(
  text: string,
  start: number,
  base: number,
  root: SourceIndex,
): AttrBlock {
  const attrs: AttrMap = {};
  const positions: Record<string, Range> = {};
  const classes: string[] = [];
  let classStart = -1;
  let classEnd = -1;
  let ok = true;
  let i = start + 1;

  for (;;) {
    i = skipSpace(text, i);
    if (i >= text.length || text.charCodeAt(i) === 10) {
      ok = false;
      break;
    }
    if (text.charCodeAt(i) === 125 /* } */) {
      i += 1;
      break;
    }

    const code = text.charCodeAt(i);
    if (code === 35 /* # */ || code === 46 /* . */) {
      const identMatch = IDENT.exec(text.slice(i + 1));
      if (identMatch === null) {
        ok = false;
        i = attrTokenEnd(text, i);
        continue;
      }
      const ident = identMatch[0];
      const from = i + 1;
      const to = from + ident.length;
      if (code === 35) {
        attrs['id'] = ident;
        positions['id'] = root.range(base + from, base + to);
      } else {
        classes.push(ident);
        if (classStart === -1) classStart = from;
        classEnd = to;
      }
      i = to;
      continue;
    }

    const keyMatch = INLINE_KEY.exec(text.slice(i));
    if (keyMatch === null) {
      ok = false;
      const end = attrTokenEnd(text, i);
      if (end === i) break;
      i = end;
      continue;
    }
    const key = keyMatch[0];
    let cursor = i + key.length;
    if (text.charCodeAt(cursor) !== 61 /* = */) {
      // A bare word is not in the grammar; treat it as a valueless flag so the
      // author's intent survives, and let the block still close cleanly.
      ok = false;
      attrs[key] = true;
      positions[key] = root.range(base + i, base + cursor);
      i = cursor;
      continue;
    }
    cursor += 1;
    const value = readInlineValue(text, cursor, true);
    if (!value.ok) ok = false;
    attrs[key] = value.value;
    positions[key] = root.range(base + cursor, base + value.end);
    i = value.end;
  }

  if (classes.length > 0) {
    attrs['class'] = classes.join(' ');
    positions['class'] = root.range(base + classStart, base + classEnd);
  }

  return { attrs, positions, end: i, ok };
}

interface ValueRead {
  readonly value: string | number | boolean | null;
  readonly end: number;
  readonly ok: boolean;
}

/** `bare-value / quoted-value`, per SPEC 5.2 and Appendix A. */
function readInlineValue(text: string, start: number, inBraces = false): ValueRead {
  const code = text.charCodeAt(start);
  if (code === 34 || code === 39) {
    const quoted = readQuoted(text, start);
    return { value: quoted.value, end: quoted.end, ok: quoted.terminated };
  }
  let end = start;
  while (end < text.length) {
    const ch = text.charCodeAt(end);
    if (isSpace(ch) || ch === 10) break;
    if (inBraces && ch === 125 /* } */) break;
    end += 1;
  }
  return { value: typePlainScalar(text.slice(start, end)), end, ok: end > start };
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9;
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charCodeAt(i))) i += 1;
  return i;
}

/** End of a whitespace-delimited token. */
function tokenEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length && !isSpace(text.charCodeAt(i))) i += 1;
  return i;
}

/** End of a token inside `{...}`: whitespace or the closing brace. */
function attrTokenEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text.charCodeAt(i);
    if (isSpace(ch) || ch === 125 || ch === 10) break;
    i += 1;
  }
  return i === from ? from + 1 : i;
}

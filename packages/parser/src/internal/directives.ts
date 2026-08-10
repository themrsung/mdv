/**
 * Directive recognition (SPEC 9, Appendix A).
 *
 * ```abnf
 * directive-block  = ":::" name [ attr-block ] LF *block ":::" LF
 * directive-leaf   = "::" name [ "[" label "]" ] [ attr-block ] LF
 * directive-inline = ":" name [ "[" label "]" ] [ attr-block ]
 * name             = "mdv-" ALPHA *( ALPHA / DIGIT / "-" )
 * ```
 *
 * This module only *recognises* directives in a line of text; splicing them into
 * the tree is `transform.ts`. There is no micromark extension involved, so the
 * matcher works on raw source and reports raw offsets — which is what
 * `attrsPosition` needs anyway.
 *
 * The `mdv-` prefix is mandatory (SPEC 9): `:::note` belongs to some other
 * directive vocabulary and MDV leaves it alone as ordinary text, exactly as a
 * non-MDV renderer would.
 */

import type { AttrMap, AttrRanges } from '../types.js';
import type { SourceIndex } from './source.js';
import { parseAttrBlock } from './inline-attrs.js';

/** Appendix A: `name = "mdv-" ALPHA *( ALPHA / DIGIT / "-" )`. */
const NAME = /^mdv-[A-Za-z][A-Za-z0-9-]*/;

/** Block directives of SPEC 9.1. */
export const BLOCK_DIRECTIVES: ReadonlySet<string> = new Set([
  'mdv-grid',
  'mdv-figure',
  'mdv-callout',
  'mdv-tabs',
  'mdv-tab',
  'mdv-columns',
  'mdv-page',
  'mdv-details',
]);

/** Inline directives of SPEC 9.2. */
export const INLINE_DIRECTIVES: ReadonlySet<string> = new Set([
  'mdv-spark',
  'mdv-metric',
  'mdv-delta',
  'mdv-badge',
  'mdv-ref',
  'mdv-value',
]);

/** A directive recognised in a run of text. */
export interface DirectiveMatch {
  readonly kind: 'inline' | 'leaf' | 'container';
  readonly name: string;
  /** Raw bracketed content, or `null` when there is no `[...]`. */
  readonly label: string | null;
  readonly attrs: AttrMap;
  readonly positions: AttrRanges;
  /** Index in `text` of the leading colon. */
  readonly start: number;
  /** Index in `text` just past the directive. */
  readonly end: number;
  /** `false` when a `[` or `{` is opened and never closed. */
  readonly ok: boolean;
}

/**
 * Try to read a directive whose leading colon is at `start` in `text`.
 *
 * @param base - absolute offset of `text[0]`, for attribute ranges.
 * @returns `null` when `start` does not begin an MDV directive.
 */
export function readDirective(
  text: string,
  start: number,
  base: number,
  root: SourceIndex,
): DirectiveMatch | null {
  if (text.charCodeAt(start) !== 58 /* : */) return null;
  // A backslash escape means the author wanted a literal colon.
  if (start > 0 && text.charCodeAt(start - 1) === 92 /* \ */) return null;

  let colons = 0;
  while (text.charCodeAt(start + colons) === 58) colons += 1;
  if (colons > 3) return null;
  const kind: DirectiveMatch['kind'] =
    colons === 3 ? 'container' : colons === 2 ? 'leaf' : 'inline';

  const nameMatch = NAME.exec(text.slice(start + colons));
  if (nameMatch === null) return null;
  const name = nameMatch[0];
  let i = start + colons + name.length;
  let ok = true;

  let label: string | null = null;
  if (text.charCodeAt(i) === 91 /* [ */) {
    const close = findLabelEnd(text, i);
    if (close === -1) {
      // An unclosed label is not a directive; leaving it as text is what a
      // non-MDV renderer does and avoids swallowing the rest of the line.
      return null;
    }
    label = text.slice(i + 1, close);
    i = close + 1;
  }

  let attrs: AttrMap = {};
  let positions: AttrRanges = {};
  if (text.charCodeAt(i) === 123 /* { */) {
    const block = parseAttrBlock(text, i, base, root);
    attrs = block.attrs;
    positions = block.positions;
    ok = block.ok;
    i = block.end;
  }

  return { kind, name, label, attrs, positions, start, end: i, ok };
}

/**
 * Read a directive that must occupy a whole line, ignoring trailing whitespace.
 * Used for the leaf and container-opener forms, which are block constructs.
 */
export function readLineDirective(
  text: string,
  base: number,
  root: SourceIndex,
): DirectiveMatch | null {
  const match = readDirective(text, 0, base, root);
  if (match === null) return null;
  for (let i = match.end; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9) return null;
  }
  return match;
}

/** `true` when a line closes a container directive: `:::` and nothing else. */
export function isContainerCloser(text: string): boolean {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) === 58) i += 1;
  if (i !== 3) return false;
  for (let j = i; j < text.length; j += 1) {
    const code = text.charCodeAt(j);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/** `true` when the directive name is one SPEC 9 defines. */
export function isKnownDirective(name: string, kind: DirectiveMatch['kind']): boolean {
  return kind === 'inline' ? INLINE_DIRECTIVES.has(name) : BLOCK_DIRECTIVES.has(name);
}

/** Index of the `]` closing the label opened at `open`, or `-1`. */
function findLabelEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 92 /* \ */) {
      i += 1;
      continue;
    }
    if (code === 10) return -1;
    if (code === 91 /* [ */) depth += 1;
    else if (code === 93 /* ] */) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

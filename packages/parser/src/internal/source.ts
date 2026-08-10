/**
 * Source text handling: SPEC 3.2 normalisation, a line index, and the
 * sub-source machinery that keeps every position absolute (SPEC 14.4).
 *
 * The parser re-parses regions of the document in several places — the document
 * body after front matter, the content of a container directive, the tail of a
 * paragraph that a directive closer cut in half, the label of an inline
 * directive. Each of those hands micromark a *different string* than the one the
 * caller passed to {@link parse}, so every position micromark produces has to be
 * mapped back. {@link SubSource} is that mapping, and it is exact: it is built
 * from whole physical lines plus a per-line count of stripped prefix characters,
 * so an offset in the sub-text always corresponds to exactly one offset in the
 * root text.
 */

import type { Position, Range } from '../types.js';

const NUL = String.fromCharCode(0);
const REPLACEMENT = String.fromCharCode(0xfffd);

/**
 * SPEC 3.2. Strips a leading BOM, normalises CRLF and lone CR to LF, and
 * replaces U+0000 with U+FFFD.
 *
 * Offsets reported by the parser index into the *normalised* string, which is
 * what SPEC 3.2 means by "before parsing".
 */
export function normaliseSource(input: string): string {
  let text = input;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (text.indexOf('\r') !== -1) text = text.replace(/\r\n?/g, '\n');
  if (text.indexOf(NUL) !== -1) text = text.replaceAll(NUL, REPLACEMENT);
  return text;
}

/** A line-start index over a string, with binary-search offset → line lookup. */
export class SourceIndex {
  readonly text: string;
  /** Offset of the first character of each line. Always starts with `0`. */
  readonly lineStarts: readonly number[];

  constructor(text: string) {
    this.text = text;
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    this.lineStarts = starts;
  }

  /** Number of lines. A text ending in LF has a final empty line. */
  get lineCount(): number {
    return this.lineStarts.length;
  }

  /** 0-based index of the line containing `offset`. */
  lineIndexAt(offset: number): number {
    const clamped = offset < 0 ? 0 : offset > this.text.length ? this.text.length : offset;
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const start = this.lineStarts[mid];
      if (start !== undefined && start <= clamped) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Offset of the first character of line `i` (0-based). */
  lineStart(i: number): number {
    if (i <= 0) return 0;
    if (i >= this.lineStarts.length) return this.text.length;
    return this.lineStarts[i] ?? this.text.length;
  }

  /** Offset just past the last character of line `i`, excluding the LF. */
  lineEnd(i: number): number {
    const next = i + 1 < this.lineStarts.length ? this.lineStarts[i + 1] : undefined;
    if (next === undefined) return this.text.length;
    // `next` points past the LF; step back over it.
    return next - 1;
  }

  /** Text of line `i` without its line terminator. */
  lineText(i: number): string {
    return this.text.slice(this.lineStart(i), this.lineEnd(i));
  }

  /** Whether line `i` is terminated by an LF in the source. */
  lineHasTerminator(i: number): boolean {
    return i + 1 < this.lineStarts.length;
  }

  /** A 1-based {@link Position} for an absolute offset. */
  positionAt(offset: number): Position {
    const clamped = offset < 0 ? 0 : offset > this.text.length ? this.text.length : offset;
    const line = this.lineIndexAt(clamped);
    return { offset: clamped, line: line + 1, column: clamped - this.lineStart(line) + 1 };
  }

  /** A half-open {@link Range} between two absolute offsets. */
  range(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) };
  }
}

/** One physical root line contributed to a sub-source, minus a stripped prefix. */
export interface SubLine {
  /** 0-based index of the line in the root source. */
  readonly line: number;
  /** Number of leading characters of that line that the sub-text omits. */
  readonly strip: number;
}

/**
 * A string handed to a sub-parser together with the mapping back to the root
 * source. Built only from whole lines, which is what makes the mapping total.
 */
export interface SubSource {
  /** The text a sub-parser sees. */
  readonly text: string;
  /** Line index over {@link text}. */
  readonly index: SourceIndex;
  /** The root document. */
  readonly root: SourceIndex;
  /**
   * Absolute root offset of the first character of each sub-line, plus one
   * trailing sentinel for the position just past the end of the sub-text.
   */
  readonly absStart: readonly number[];
  /** `true` when the sub-source covers the root text exactly (no mapping needed). */
  readonly identity: boolean;
}

/** Build a {@link SubSource} out of a selection of root lines. */
export function makeSubSource(root: SourceIndex, lines: readonly SubLine[]): SubSource {
  if (lines.length === 0) {
    return {
      text: '',
      index: new SourceIndex(''),
      root,
      absStart: [0, 0],
      identity: false,
    };
  }
  const pieces: string[] = [];
  const absStart: number[] = [];
  for (const line of lines) {
    const start = root.lineStart(line.line);
    const end = root.lineEnd(line.line);
    const strip = line.strip < 0 ? 0 : line.strip > end - start ? end - start : line.strip;
    absStart.push(start + strip);
    pieces.push(root.text.slice(start + strip, end));
  }
  const last = lines[lines.length - 1] as SubLine;
  const trailing = root.lineHasTerminator(last.line);
  const text = pieces.join('\n') + (trailing ? '\n' : '');
  // Sentinel for the phantom final line created by the trailing LF, and for any
  // offset that lands exactly at the end of the sub-text.
  absStart.push(root.lineEnd(last.line) + (trailing ? 1 : 0));

  const first = lines[0] as SubLine;
  const identity =
    first.line === 0 &&
    first.strip === 0 &&
    lines.length === root.lineCount &&
    text.length === root.text.length;

  return { text, index: new SourceIndex(text), root, absStart, identity };
}

/** A sub-source covering the whole of `root` from `startLine` onwards. */
export function subSourceFromLine(root: SourceIndex, startLine: number): SubSource {
  const lines: SubLine[] = [];
  for (let i = startLine; i < root.lineCount; i += 1) lines.push({ line: i, strip: 0 });
  return makeSubSource(root, lines);
}

/** Translate an offset in {@link SubSource.text} to an absolute root offset. */
export function mapOffset(sub: SubSource, subOffset: number): number {
  if (sub.identity) return subOffset;
  const clamped =
    subOffset < 0 ? 0 : subOffset > sub.text.length ? sub.text.length : subOffset;
  const line = sub.index.lineIndexAt(clamped);
  const column = clamped - sub.index.lineStart(line);
  const base = sub.absStart[line];
  if (base === undefined) {
    const tail = sub.absStart[sub.absStart.length - 1];
    return tail ?? 0;
  }
  return base + column;
}

/** Translate an offset in a sub-source to an absolute root {@link Position}. */
export function mapPosition(sub: SubSource, subOffset: number): Position {
  return sub.root.positionAt(mapOffset(sub, subOffset));
}

interface PositionedLike {
  position?: { start: { offset?: number | undefined }; end: { offset?: number | undefined } };
  children?: unknown;
}

/**
 * Rewrite every `position` in a tree produced from `sub` so that it refers to
 * the root document (SPEC 14.4). Uses offsets rather than line/column because
 * micromark expands tabs when computing columns and we do not.
 */
export function remapTree(node: unknown, sub: SubSource): void {
  if (sub.identity) return;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === null || typeof current !== 'object') continue;
    const positioned = current as PositionedLike;
    const position = positioned.position;
    if (position !== undefined) {
      const startOffset = position.start.offset;
      const endOffset = position.end.offset;
      if (typeof startOffset === 'number' && typeof endOffset === 'number') {
        positioned.position = {
          start: mapPosition(sub, startOffset),
          end: mapPosition(sub, endOffset),
        };
      }
    }
    const children = positioned.children;
    if (Array.isArray(children)) {
      for (const child of children) stack.push(child);
    }
  }
}

/**
 * How many characters of a line to strip so that a sub-parse starting at
 * `column` (1-based) sees the line's content and not its container prefix.
 *
 * Only whitespace and block-quote markers are ever stripped, which covers the
 * container prefixes CommonMark can put in front of a directive: list-item
 * indentation and `>`.
 */
export function containerStrip(root: SourceIndex, line: number, column: number): number {
  const want = column - 1;
  if (want <= 0) return 0;
  const text = root.lineText(line);
  let i = 0;
  while (i < want && i < text.length) {
    const ch = text.charCodeAt(i);
    // space, tab, '>'
    if (ch === 32 || ch === 9 || ch === 62) i += 1;
    else break;
  }
  return i;
}

/** Codepoint-order string comparison. `localeCompare` is banned (CONTRACTS 1.4). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

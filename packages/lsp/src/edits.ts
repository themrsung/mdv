/**
 * Whole text in, minimal edits out.
 *
 * A formatter produces a new document; a client wants a list of `TextEdit`s. The
 * lazy translation — one edit replacing the entire file — is correct and awful:
 * it moves the cursor, collapses folded regions, discards the selection, and
 * turns every reformat into a single unreviewable line in the undo stack. Worse,
 * it makes `textDocument/rangeFormatting` impossible to honour, because the one
 * edit is never inside the range the client asked about.
 *
 * So the two texts are diffed by line and the differences come back as separate
 * edits. Lines, not characters: canonical formatting is a line-oriented
 * operation (SPEC 5.3.1 indentation, table alignment, attribute order within a
 * directive that occupies its own line), and a character diff would spend its
 * time producing surgical intra-line edits that no human reviewing an undo step
 * would recognise. A changed line is the unit an author thinks in.
 *
 * ## Coordinates
 *
 * Every hunk boundary is computed as an **offset** into the original text and
 * converted with {@link TextDocument.positionAt}. Deriving `{ line, character }`
 * arithmetically is where this kind of code goes wrong: a document whose last
 * line has no terminator has one fewer position than lines, and `\r\n` makes the
 * end of a line two units from its start. The offset is unambiguous; let the
 * mirror do the conversion it already does for diagnostics.
 */

import type { TextDocument } from './documents.js';
import type { Range, TextEdit } from './protocol/types.js';

/**
 * The largest line count the quadratic diff is allowed to see.
 *
 * The LCS table below is O(n·m) in time and memory. At the limit that is 4M
 * cells — tens of milliseconds and a few megabytes, on a document nobody hand
 * edits. Past it, a single whole-document edit is the honest answer: slow and
 * precise is worse than fast and blunt when the client is waiting on a
 * synchronous formatting request.
 */
export const MAX_DIFF_LINES = 2000;

/**
 * Split into lines, each keeping its terminator.
 *
 * Keeping `\n` attached means a hunk's text is exactly the substring it
 * replaces, so no edit has to reason about whether it owns the newline at its
 * edge — the classic off-by-one in this kind of diff. Empty text is zero lines,
 * not one empty line: an empty document contains nothing, and pretending
 * otherwise makes the diff of `'' → 'x\n'` a replacement rather than an
 * insertion.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** A run of lines in the original replaced by a run of lines in the result. */
interface Hunk {
  /** First line of the original this hunk covers. */
  readonly start: number;
  /** One past the last line of the original this hunk covers. */
  readonly end: number;
  /** What those lines become. May be empty, for a deletion. */
  readonly text: string;
}

/**
 * The hunks that turn `before` into `after`.
 *
 * A longest-common-subsequence walk, after trimming the identical head and tail
 * — which is nearly all of a formatting pass, and is what keeps the quadratic
 * middle small in practice.
 */
function diffLines(before: readonly string[], after: readonly string[]): Hunk[] {
  // Identical prefix.
  let head = 0;
  const shortest = Math.min(before.length, after.length);
  while (head < shortest && before[head] === after[head]) head += 1;

  // Identical suffix, never overlapping the prefix.
  let tail = 0;
  while (
    tail < shortest - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  if (a.length === 0 && b.length === 0) return [];
  if (a.length === 0) return [{ start: head, end: head, text: b.join('') }];
  if (b.length === 0) return [{ start: head, end: head + a.length, text: '' }];

  // Too big to be careful about. One hunk covering the whole changed middle is
  // still better than one covering the whole document.
  if (a.length * b.length > MAX_DIFF_LINES * MAX_DIFF_LINES) {
    return [{ start: head, end: head + a.length, text: b.join('') }];
  }

  // dp[i][j] — the length of the longest common subsequence of a[i..] and b[j..].
  const width = b.length + 1;
  const dp = new Int32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * width + j] =
        a[i] === b[j]
          ? (dp[(i + 1) * width + j + 1] as number) + 1
          : Math.max(dp[(i + 1) * width + j] as number, dp[i * width + j + 1] as number);
    }
  }

  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  // An open hunk, accumulating consecutive non-matching lines. Deletions and
  // insertions that touch are one edit, not two: `- old` `+ new` is a
  // replacement to everyone who reads it.
  let start = -1;
  let replaced = '';
  const close = (): void => {
    if (start < 0) return;
    hunks.push({ start: head + start, end: head + i, text: replaced });
    start = -1;
    replaced = '';
  };

  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      close();
      i += 1;
      j += 1;
      continue;
    }
    if (start < 0) start = i;
    // Prefer the move the table says loses nothing. When both are equal, delete
    // first: it keeps a rewritten line's edit anchored on the line it replaces.
    if (j >= b.length) {
      i += 1;
    } else if (i >= a.length) {
      replaced += b[j] as string;
      j += 1;
    } else if ((dp[(i + 1) * width + j] as number) >= (dp[i * width + j + 1] as number)) {
      i += 1;
    } else {
      replaced += b[j] as string;
      j += 1;
    }
  }
  close();
  return hunks;
}

/** The offset each line starts at, plus the end of the text. */
function lineOffsets(lines: readonly string[]): number[] {
  const offsets: number[] = [0];
  let offset = 0;
  for (const line of lines) {
    offset += line.length;
    offsets.push(offset);
  }
  return offsets;
}

/** An edit and the original lines it covers, so a range filter can ask. */
export interface LineEdit extends TextEdit {
  /** First line of the original document this edit covers. */
  readonly startLine: number;
  /** One past the last line covered. Equal to `startLine` for an insertion. */
  readonly endLine: number;
}

/**
 * The minimal edits turning `document`'s text into `formatted`.
 *
 * The result is ordered, and no two edits overlap or touch — LSP requires both,
 * and clients that apply edits in reverse rely on it.
 */
export function textEdits(document: TextDocument, formatted: string): LineEdit[] {
  const source = document.text;
  if (formatted === source) return [];

  const before = splitLines(source);
  const offsets = lineOffsets(before);
  return diffLines(before, splitLines(formatted)).map((hunk) => ({
    range: {
      start: document.positionAt(offsets[hunk.start] as number),
      end: document.positionAt(offsets[hunk.end] as number),
    },
    newText: hunk.text,
    startLine: hunk.start,
    endLine: hunk.end,
  }));
}

/**
 * Keep the edits that fall inside `range`, expanded to whole lines.
 *
 * `textDocument/rangeFormatting` asks the server to format a selection, and a
 * client is entitled to assume nothing outside it moves. Since the formatter
 * only knows how to format a whole document — a Markdown document is not
 * separable, a table's alignment depends on rows the selection may not contain —
 * the whole thing is formatted and the edits outside the selection are dropped.
 * The author gets exactly what they asked for, and the next full format will
 * offer the rest.
 *
 * The selection is expanded to whole lines because a partial line cannot
 * meaningfully contain a line-oriented edit, and clients routinely send a range
 * that stops mid-word.
 *
 * An edit that only inserts (`startLine === endLine`) counts as inside when its
 * line is within the selection, including the line just past its end — that is
 * where a missing trailing newline gets added.
 */
export function editsWithin(edits: readonly LineEdit[], range: Range): LineEdit[] {
  const first = range.start.line;
  // A selection ending at character 0 does not include that line: an editor
  // reports a three-line selection as ending at the start of the fourth.
  const last = range.end.character === 0 ? range.end.line : range.end.line + 1;
  return edits.filter((edit) =>
    edit.startLine === edit.endLine
      ? edit.startLine >= first && edit.startLine <= last
      : edit.startLine >= first && edit.endLine <= last,
  );
}

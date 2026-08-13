/**
 * Run-list algebra.
 *
 * A block's inline content is a flat, ordered list of {@link Run}s. Every
 * operation here is pure and returns a **canonical** list:
 *
 * - marks are sorted into a fixed order, so two runs with the same formatting
 *   compare equal structurally;
 * - adjacent text runs with equal marks are merged;
 * - empty text runs are dropped, except that an otherwise empty list collapses
 *   to `[]` rather than to a list of empties.
 *
 * Canonicalisation is what makes `read(write(doc))` reproduce `doc` exactly and
 * what keeps undo diffs small.
 */

import type { IdFactory, NodeId } from './ids.js';
import type { Mark, MarkType, RawRun, Run, TextRun } from './model.js';

/** Fixed mark order. Nesting order in the written source follows this too. */
const MARK_ORDER: readonly MarkType[] = ['link', 'strong', 'emphasis', 'strikethrough', 'code'];

function markRank(type: MarkType): number {
  const index = MARK_ORDER.indexOf(type);
  return index < 0 ? MARK_ORDER.length : index;
}

/** Sort marks into the canonical order. Stable, allocation-free when already sorted. */
export function sortMarks(marks: readonly Mark[]): readonly Mark[] {
  let sorted = true;
  for (let i = 1; i < marks.length; i += 1) {
    const previous = marks[i - 1];
    const current = marks[i];
    if (previous && current && markRank(previous.type) > markRank(current.type)) {
      sorted = false;
      break;
    }
  }
  if (sorted) return marks;
  return [...marks].sort((a, b) => markRank(a.type) - markRank(b.type));
}

/** Structural equality for a single mark. */
export function markEquals(a: Mark, b: Mark): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'link' && b.type === 'link') return a.href === b.href && a.title === b.title;
  return true;
}

/** Structural equality for a mark set, order-insensitive. */
export function marksEqual(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  const left = sortMarks(a);
  const right = sortMarks(b);
  for (let i = 0; i < left.length; i += 1) {
    const l = left[i];
    const r = right[i];
    if (!l || !r || !markEquals(l, r)) return false;
  }
  return true;
}

/** True when `marks` contains a mark of this type (link href is ignored). */
export function hasMarkType(marks: readonly Mark[], type: MarkType): boolean {
  return marks.some((mark) => mark.type === type);
}

/** Find the mark of `type` in `marks`, if any. */
export function findMark(marks: readonly Mark[], type: MarkType): Mark | undefined {
  return marks.find((mark) => mark.type === type);
}

/**
 * Add `mark` to a mark set, replacing any existing mark of the same type.
 *
 * Marks compose freely: the canonical order puts `code` innermost, so
 * `**`x`**` (strong containing code) is representable while the impossible
 * inverse is not.
 */
export function withMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  const rest = marks.filter((existing) => existing.type !== mark.type);
  return sortMarks([...rest, mark]);
}

/** Remove every mark of `type`. */
export function withoutMark(marks: readonly Mark[], type: MarkType): readonly Mark[] {
  return marks.filter((mark) => mark.type !== type);
}

/** Create a text run. */
export function textRun(id: NodeId, text: string, marks: readonly Mark[] = []): TextRun {
  return { kind: 'text', id, text, marks: sortMarks(marks) };
}

/** Create a verbatim run. */
export function rawRun(id: NodeId, source: string, text: string): RawRun {
  return { kind: 'raw', id, source, text };
}

/** The plain-text projection of a run. */
export function runText(run: Run): string {
  return run.text;
}

/** Character length of a run in UTF-16 code units — the unit {@link Point.offset} uses. */
export function runLength(run: Run): number {
  return run.text.length;
}

/** Marks carried by a run; raw runs carry none. */
export function runMarks(run: Run): readonly Mark[] {
  return run.kind === 'text' ? run.marks : [];
}

/** Concatenated plain text of a run list. */
export function runsText(runs: readonly Run[]): string {
  let out = '';
  for (const run of runs) out += run.text;
  return out;
}

/** Total length of a run list in UTF-16 code units. */
export function runsLength(runs: readonly Run[]): number {
  let total = 0;
  for (const run of runs) total += run.text.length;
  return total;
}

/**
 * Merge adjacent compatible runs and drop empties.
 *
 * Raw runs are never merged: each is atomic. The first surviving run keeps its
 * id so that a caret anchored to it stays anchored.
 */
export function normalizeRuns(runs: readonly Run[]): readonly Run[] {
  const out: Run[] = [];
  for (const run of runs) {
    if (run.kind === 'text' && run.text.length === 0) continue;
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      previous.kind === 'text' &&
      run.kind === 'text' &&
      marksEqual(previous.marks, run.marks)
    ) {
      out[out.length - 1] = { ...previous, text: previous.text + run.text };
      continue;
    }
    out.push(run.kind === 'text' ? { ...run, marks: sortMarks(run.marks) } : run);
  }
  return out;
}

/** A location inside a run list: which run, and how far into it. */
export interface RunOffset {
  readonly run: number;
  readonly offset: number;
}

/**
 * Convert an absolute character offset into a `(run, offset)` pair.
 *
 * Boundaries bind to the **end of the earlier run** so that typing at a
 * boundary inherits the formatting of the text to the left, which is what every
 * word processor does.
 */
export function locate(runs: readonly Run[], absolute: number): RunOffset {
  if (runs.length === 0) return { run: 0, offset: 0 };
  let remaining = Math.max(0, absolute);
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    if (!run) break;
    if (remaining <= run.text.length) return { run: index, offset: remaining };
    remaining -= run.text.length;
  }
  const last = runs.length - 1;
  const lastRun = runs[last];
  return { run: last, offset: lastRun ? lastRun.text.length : 0 };
}

/** Convert a `(run, offset)` pair into an absolute character offset. */
export function absolute(runs: readonly Run[], at: RunOffset): number {
  let total = 0;
  for (let index = 0; index < at.run && index < runs.length; index += 1) {
    total += runs[index]?.text.length ?? 0;
  }
  const run = runs[at.run];
  const max = run ? run.text.length : 0;
  return total + Math.min(Math.max(0, at.offset), max);
}

/**
 * Extract the runs covering `[start, end)` in absolute offsets.
 *
 * A raw run is included only when it is fully covered: half-selecting an atomic
 * span would produce text that cannot be written back.
 */
export function sliceRuns(runs: readonly Run[], start: number, end: number): readonly Run[] {
  const from = Math.max(0, Math.min(start, end));
  const to = Math.max(start, end);
  const out: Run[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (runEnd <= from || runStart >= to) continue;
    if (run.kind === 'raw') {
      if (runStart >= from && runEnd <= to) out.push(run);
      continue;
    }
    const localStart = Math.max(0, from - runStart);
    const localEnd = Math.min(run.text.length, to - runStart);
    out.push({ ...run, text: run.text.slice(localStart, localEnd) });
  }
  return normalizeRuns(out);
}

/** Replace `[start, end)` with `replacement`, returning a canonical run list. */
export function spliceRuns(
  runs: readonly Run[],
  start: number,
  end: number,
  replacement: readonly Run[],
): readonly Run[] {
  const total = runsLength(runs);
  const from = Math.max(0, Math.min(start, total));
  const to = Math.max(from, Math.min(end, total));
  return normalizeRuns([
    ...sliceRuns(runs, 0, from),
    ...replacement,
    ...sliceRuns(runs, to, total),
  ]);
}

/**
 * Apply `update` to the marks of every text run overlapping `[start, end)`.
 * Raw runs are left alone — they carry their own formatting in their source.
 */
export function mapMarks(
  runs: readonly Run[],
  start: number,
  end: number,
  update: (marks: readonly Mark[]) => readonly Mark[],
  ids: IdFactory,
): readonly Run[] {
  if (start >= end) return runs;
  const out: Run[] = [];
  let cursor = 0;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (run.kind === 'raw' || runEnd <= start || runStart >= end) {
      out.push(run);
      continue;
    }
    const localStart = Math.max(0, start - runStart);
    const localEnd = Math.min(run.text.length, end - runStart);
    if (localStart > 0) out.push({ ...run, text: run.text.slice(0, localStart) });
    out.push(
      textRun(
        localStart > 0 ? ids() : run.id,
        run.text.slice(localStart, localEnd),
        update(run.marks),
      ),
    );
    if (localEnd < run.text.length) out.push(textRun(ids(), run.text.slice(localEnd), run.marks));
  }
  return normalizeRuns(out);
}

/**
 * Marks that apply to the whole of `[start, end)`.
 *
 * Used to decide whether {@link toggleMark} should add or remove: a toggle
 * removes only when every covered character already carries the mark.
 */
export function commonMarks(runs: readonly Run[], start: number, end: number): readonly Mark[] {
  let result: readonly Mark[] | null = null;
  let cursor = 0;
  let sawText = false;
  for (const run of runs) {
    const runStart = cursor;
    const runEnd = cursor + run.text.length;
    cursor = runEnd;
    if (run.kind !== 'text' || runEnd <= start || runStart >= end) continue;
    if (run.text.length === 0) continue;
    sawText = true;
    result =
      result === null
        ? run.marks
        : result.filter((mark) => run.marks.some((other) => markEquals(mark, other)));
  }
  if (!sawText || result === null) return [];
  return sortMarks(result);
}

/**
 * Marks the character *ending* at `offset` carries — the caret's left side.
 *
 * At the start of a block there is no such character, so the one to the right
 * stands in: typing into an empty paragraph that begins with bold text should
 * be bold.
 */
function leftMarks(runs: readonly Run[], offset: number): readonly Mark[] {
  if (offset <= 0) {
    const first = runs[0];
    return first ? runMarks(first) : [];
  }
  const at = locate(runs, offset);
  const run = runs[at.run];
  if (!run) return [];
  if (at.offset === 0 && at.run > 0) {
    const previous = runs[at.run - 1];
    return previous ? runMarks(previous) : runMarks(run);
  }
  return runMarks(run);
}

/** Marks the character *starting* at `offset` carries — the caret's right side. */
function rightMarks(runs: readonly Run[], offset: number): readonly Mark[] {
  let cursor = 0;
  for (const run of runs) {
    const end = cursor + run.text.length;
    // A zero-length run holds no character, so it is neither side of a caret.
    if (run.text.length > 0 && offset < end) return runMarks(run);
    cursor = end;
  }
  return [];
}

/**
 * Marks a collapsed caret at `offset` would inherit.
 *
 * Emphasis is *inclusive*: typing at the end of bold text continues it, which
 * is how a writer adds a word to something they just emboldened. A link is
 * **not**, and that asymmetry is deliberate. The character after a link is
 * nearly always punctuation — `[docs](…).` — and absorbing it into the anchor
 * silently changes both the link text and what the reader clicks. So a link is
 * inherited only when the caret has the same link on both sides, i.e. when the
 * caret is genuinely *inside* the anchor rather than resting against its edge.
 * The rest of the mark set is unaffected: typing after bold-and-linked text
 * stays bold and stops being a link.
 *
 * Deliberate marks still win — `state.pendingMarks`, set by the link command
 * or by a toggle, is consulted before this function ever runs — so a writer who
 * asks for a link and then types gets one.
 */
export function marksAt(runs: readonly Run[], offset: number): readonly Mark[] {
  if (runs.length === 0) return [];
  const inherited = leftMarks(runs, offset);
  if (!hasMarkType(inherited, 'link')) return inherited;
  // Both sides, not just the one `leftMarks` reports: at the start of a block
  // it stands in the right-hand character for the left, which would put the
  // caret "inside" a leading link when it is in fact in front of it.
  const before = offset <= 0 ? [] : inherited;
  const after = rightMarks(runs, offset);
  const carries = (mark: Mark, side: readonly Mark[]): boolean =>
    side.some((other) => markEquals(mark, other));
  return inherited.filter(
    (mark) => mark.type !== 'link' || (carries(mark, before) && carries(mark, after)),
  );
}

/** Deep structural equality for two run lists. */
export function runsEqual(a: readonly Run[], b: readonly Run[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const left = a[i];
    const right = b[i];
    if (!left || !right || left.kind !== right.kind) return false;
    if (left.kind === 'text' && right.kind === 'text') {
      if (left.text !== right.text || !marksEqual(left.marks, right.marks)) return false;
    } else if (left.kind === 'raw' && right.kind === 'raw') {
      if (left.source !== right.source || left.text !== right.text) return false;
    }
  }
  return true;
}

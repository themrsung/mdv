/**
 * Selection model and normalisation.
 *
 * A {@link Point} is `(blockId, path, offset)` where `path` addresses a run
 * inside the block and `offset` is a UTF-16 code-unit index into that run:
 *
 * | block kind          | `path`                        | `offset` indexes    |
 * | ------------------- | ----------------------------- | ------------------- |
 * | paragraph, heading  | `[runIndex]`                  | the run's text      |
 * | table               | `[rowIndex, colIndex, runIdx]`| the run's text      |
 * | code                | `[0]`                         | the block's text    |
 * | atomic (image, …)   | — not addressable —           | use a node selection|
 *
 * Three selection shapes exist. A **text** selection is an anchor/focus pair
 * (collapsed when they are equal); a **cells** selection is a rectangular range
 * inside one table; a **node** selection covers one atomic block.
 *
 * {@link normalizeSelection} is total: given *any* selection and *any*
 * document it returns a selection that is valid for that document. Commands
 * normalise their input and their output, so an invalid selection can never be
 * committed.
 */

import { EngineError } from './errors.js';
import type { NodeId } from './ids.js';
import { absolute as runsAbsolute, locate } from './inline.js';
import type { Block, MdvDocument, Run } from './model.js';
import { isAtomicBlock, isRunBlock, isTextBlock } from './model.js';
import { allBlocks, findBlock, leafBlocks, updateBlock } from './tree.js';

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** A caret position. */
export interface Point {
  readonly blockId: NodeId;
  /** Address of a run within the block; see the table in the module docs. */
  readonly path: readonly number[];
  /** UTF-16 code-unit offset inside the addressed run. */
  readonly offset: number;
}

/** A caret or a range of inline content, possibly spanning blocks. */
export interface TextSelection {
  readonly kind: 'text';
  readonly anchor: Point;
  readonly focus: Point;
}

/** A rectangular block of table cells. Inclusive on both corners. */
export interface CellSelection {
  readonly kind: 'cells';
  readonly tableId: NodeId;
  readonly anchor: CellRef;
  readonly focus: CellRef;
}

/** A single atomic block selected as a unit. */
export interface NodeSelection {
  readonly kind: 'node';
  readonly blockId: NodeId;
}

/** Any selection the engine can hold. */
export type Selection = TextSelection | CellSelection | NodeSelection;

/** Row/column coordinates inside a table. Row 0 is the header. */
export interface CellRef {
  readonly row: number;
  readonly col: number;
}

/** An inclusive rectangle of cells, corners sorted. */
export interface CellRect {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/* -------------------------------------------------------------------------- */
/* Construction                                                                */
/* -------------------------------------------------------------------------- */

/** Build a point. */
export function point(blockId: NodeId, path: readonly number[], offset: number): Point {
  return { blockId, path, offset };
}

/** A collapsed text selection at `at`. */
export function caret(at: Point): TextSelection {
  return { kind: 'text', anchor: at, focus: at };
}

/** A text selection from `anchor` to `focus`. */
export function range(anchor: Point, focus: Point): TextSelection {
  return { kind: 'text', anchor, focus };
}

/**
 * The selection Ctrl/Cmd+A means: everything the caret can reach.
 *
 * It runs from the start of the first addressable *leaf* to the end of the
 * last, which is rarely the first and last block. Lists and quotes keep their
 * text in leaves, so a document that opens with a list has no addressable
 * position in its first block at all; a table's last position is its last
 * cell, not its first. Getting this wrong does not misbehave loudly — it
 * silently selects a prefix, and the delete that follows leaves debris.
 *
 * Atomic blocks (images, visual blocks, thematic breaks, raw passthroughs)
 * hold no caret position. One leading or trailing atomic block therefore sits
 * outside the range: `Point` cannot address it, and inventing a document-level
 * position to cover the case would complicate every command that reads one.
 * Deletion closes that gap at the other end — `deleteSelection` recognises a
 * range that covers this much and blanks the page, atomic edges included, so
 * Ctrl+A Backspace never strands a chart in an otherwise empty document. A
 * document that is *only* atomic blocks selects its first one as a node, so
 * Ctrl+A is never a no-op.
 */
export function wholeDocument(doc: MdvDocument): Selection | undefined {
  const blocks = leafBlocks(doc).map((location) => location.block);
  const first = blocks.find((block) => startOfBlock(block) !== undefined);
  const last = [...blocks].reverse().find((block) => endOfBlock(block) !== undefined);
  const anchor = first ? startOfBlock(first) : undefined;
  const focus = last ? endOfBlock(last) : undefined;
  if (anchor && focus) return { kind: 'text', anchor, focus };
  const only = blocks[0];
  return only ? { kind: 'node', blockId: only.id } : undefined;
}

/** True when the selection is a zero-width caret. */
export function isCollapsed(selection: Selection): boolean {
  return selection.kind === 'text' && pointsEqual(selection.anchor, selection.focus);
}

/** Structural equality for points. */
export function pointsEqual(a: Point, b: Point): boolean {
  return (
    a.blockId === b.blockId &&
    a.offset === b.offset &&
    a.path.length === b.path.length &&
    a.path.every((value, index) => value === b.path[index])
  );
}

/** Structural equality for selections. */
export function selectionsEqual(a: Selection, b: Selection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'text' && b.kind === 'text') {
    return pointsEqual(a.anchor, b.anchor) && pointsEqual(a.focus, b.focus);
  }
  if (a.kind === 'cells' && b.kind === 'cells') {
    return (
      a.tableId === b.tableId &&
      a.anchor.row === b.anchor.row &&
      a.anchor.col === b.anchor.col &&
      a.focus.row === b.focus.row &&
      a.focus.col === b.focus.col
    );
  }
  if (a.kind === 'node' && b.kind === 'node') return a.blockId === b.blockId;
  return false;
}

/** Sorted, inclusive rectangle covered by a cell selection. */
export function cellRect(selection: CellSelection): CellRect {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.col, selection.focus.col),
    right: Math.max(selection.anchor.col, selection.focus.col),
  };
}

/* -------------------------------------------------------------------------- */
/* Inline containers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The run list a point addresses, plus enough context to write it back.
 *
 * Code blocks are exposed as a one-run container so that the text commands do
 * not need a second code path; {@link writeContainer} folds the runs back into
 * a plain string on the way out.
 */
export interface InlineContainer {
  readonly blockId: NodeId;
  /** Path *without* the trailing run index. */
  readonly path: readonly number[];
  readonly runs: readonly Run[];
  /** `text` containers discard marks when written back. */
  readonly storage: 'runs' | 'text';
}

/** Path of the container that holds the run addressed by `p`. */
export function containerPath(p: Point): readonly number[] {
  return p.path.slice(0, -1);
}

/** Index of the run addressed by `p` within its container. */
export function runIndex(p: Point): number {
  return p.path.length === 0 ? 0 : (p.path[p.path.length - 1] ?? 0);
}

/** Resolve the container at `path` inside `block`, or `undefined` if invalid. */
export function containerOf(block: Block, path: readonly number[]): InlineContainer | undefined {
  if (isRunBlock(block)) {
    if (path.length !== 0) return undefined;
    return { blockId: block.id, path: [], runs: block.runs, storage: 'runs' };
  }
  if (isTextBlock(block)) {
    if (path.length !== 0) return undefined;
    return {
      blockId: block.id,
      path: [],
      runs: [{ kind: 'text', id: `${block.id}:text`, text: block.text, marks: [] }],
      storage: 'text',
    };
  }
  if (block.kind === 'table') {
    if (path.length !== 2) return undefined;
    const row = block.rows[path[0] ?? -1];
    const cell = row?.cells[path[1] ?? -1];
    if (!row || !cell) return undefined;
    return {
      blockId: block.id,
      path: [path[0] ?? 0, path[1] ?? 0],
      runs: cell.runs,
      storage: 'runs',
    };
  }
  return undefined;
}

/** Resolve the container a point addresses. */
export function resolveContainer(doc: MdvDocument, p: Point): InlineContainer | undefined {
  const location = findBlock(doc, p.blockId);
  if (!location) return undefined;
  return containerOf(location.block, containerPath(p));
}

/** Resolve the container a point addresses, or raise `EDIT_INVALID_SELECTION`. */
export function requireContainer(doc: MdvDocument, p: Point): InlineContainer {
  const container = resolveContainer(doc, p);
  if (!container) {
    throw new EngineError('EDIT_INVALID_SELECTION', 'point does not address an inline container', {
      point: { blockId: p.blockId, path: [...p.path], offset: p.offset },
    });
  }
  return container;
}

/** Write a run list back into the container it came from. */
export function writeContainer(
  doc: MdvDocument,
  container: InlineContainer,
  runs: readonly Run[],
): MdvDocument {
  return updateBlock(doc, container.blockId, (block) => {
    if (container.storage === 'text') {
      if (block.kind !== 'code') return block;
      return { ...block, text: runs.map((run) => run.text).join('') };
    }
    if (isRunBlock(block)) return { ...block, runs };
    if (block.kind === 'table') {
      const rowIndex = container.path[0] ?? -1;
      const colIndex = container.path[1] ?? -1;
      const rows = block.rows.map((row, r) => {
        if (r !== rowIndex) return row;
        return {
          ...row,
          cells: row.cells.map((cell, c) => (c === colIndex ? { ...cell, runs } : cell)),
        };
      });
      return { ...block, rows };
    }
    return block;
  });
}

/* -------------------------------------------------------------------------- */
/* Absolute offsets                                                            */
/* -------------------------------------------------------------------------- */

/** Convert a point to an absolute offset within its container. */
export function toAbsolute(container: InlineContainer, p: Point): number {
  return runsAbsolute(container.runs, { run: runIndex(p), offset: p.offset });
}

/** Convert an absolute offset within `container` back to a point. */
export function fromAbsolute(container: InlineContainer, offset: number): Point {
  const at = locate(container.runs, offset);
  return { blockId: container.blockId, path: [...container.path, at.run], offset: at.offset };
}

/** Absolute offset of the end of a container. */
export function containerLength(container: InlineContainer): number {
  let total = 0;
  for (const run of container.runs) total += run.text.length;
  return total;
}

/** A point at the very start of `block`, or `undefined` if it is atomic. */
export function startOfBlock(block: Block): Point | undefined {
  const container = firstContainer(block);
  if (!container) return undefined;
  return { blockId: block.id, path: [...container.path, 0], offset: 0 };
}

/** A point at the very end of `block`, or `undefined` if it is atomic. */
export function endOfBlock(block: Block): Point | undefined {
  const container = lastContainer(block);
  if (!container) return undefined;
  const lastIndex = Math.max(0, container.runs.length - 1);
  const last = container.runs[lastIndex];
  return {
    blockId: block.id,
    path: [...container.path, lastIndex],
    offset: last ? last.text.length : 0,
  };
}

function firstContainer(block: Block): InlineContainer | undefined {
  if (block.kind === 'table') return containerOf(block, [0, 0]);
  return containerOf(block, []);
}

function lastContainer(block: Block): InlineContainer | undefined {
  if (block.kind === 'table') {
    const row = block.rows.length - 1;
    const col = (block.rows[row]?.cells.length ?? 1) - 1;
    return containerOf(block, [row, col]);
  }
  return containerOf(block, []);
}

/* -------------------------------------------------------------------------- */
/* Document order                                                              */
/* -------------------------------------------------------------------------- */

/** Map from block id to its index in a pre-order walk. */
export function blockOrderIndex(doc: MdvDocument): ReadonlyMap<NodeId, number> {
  const map = new Map<NodeId, number>();
  allBlocks(doc).forEach((location, index) => map.set(location.block.id, index));
  return map;
}

/**
 * Compare two points in document order.
 *
 * Returns a negative number when `a` precedes `b`, zero when they coincide.
 * Points in blocks that are not in the document sort last, deterministically by
 * block id, so a stale point never makes a sort unstable.
 */
export function comparePoints(doc: MdvDocument, a: Point, b: Point): number {
  const order = blockOrderIndex(doc);
  const ai = order.get(a.blockId);
  const bi = order.get(b.blockId);
  if (ai === undefined || bi === undefined) {
    if (ai === undefined && bi === undefined)
      return a.blockId < b.blockId ? -1 : a.blockId > b.blockId ? 1 : 0;
    return ai === undefined ? 1 : -1;
  }
  if (ai !== bi) return ai - bi;
  const length = Math.max(a.path.length, b.path.length);
  for (let index = 0; index < length; index += 1) {
    const av = a.path[index] ?? -1;
    const bv = b.path[index] ?? -1;
    if (av !== bv) return av - bv;
  }
  return a.offset - b.offset;
}

/** The selection's start and end points in document order. */
export function orderedPoints(doc: MdvDocument, selection: TextSelection): readonly [Point, Point] {
  return comparePoints(doc, selection.anchor, selection.focus) <= 0
    ? [selection.anchor, selection.focus]
    : [selection.focus, selection.anchor];
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Round `offset` down to the nearest code-point boundary within `text`. */
function snapToCodePoint(text: string, offset: number): number {
  const clamped = Math.max(0, Math.min(Math.trunc(offset), text.length));
  if (clamped === 0 || clamped === text.length) return clamped;
  const code = text.charCodeAt(clamped);
  // A low surrogate at `clamped` means we are inside a pair; step back one unit.
  if (code >= 0xdc00 && code <= 0xdfff) {
    const previous = text.charCodeAt(clamped - 1);
    if (previous >= 0xd800 && previous <= 0xdbff) return clamped - 1;
  }
  return clamped;
}

/**
 * The first caret-addressable block at or after `index` in a pre-order walk,
 * falling back to the last one before it.
 */
function nearestCaretBlock(doc: MdvDocument, index: number): Block | undefined {
  const candidates: { block: Block; order: number }[] = [];
  allBlocks(doc).forEach((location, order) => {
    if (isAtomicBlock(location.block)) return;
    if (startOfBlock(location.block) === undefined) return;
    candidates.push({ block: location.block, order });
  });
  if (candidates.length === 0) return undefined;
  for (const candidate of candidates) {
    if (candidate.order >= index) return candidate.block;
  }
  return candidates[candidates.length - 1]?.block;
}

/** Clamp a point so it addresses a real run at a real offset. */
export function normalizePoint(doc: MdvDocument, p: Point): Point | undefined {
  const location = findBlock(doc, p.blockId);
  if (!location) return undefined;
  const block = location.block;
  if (isAtomicBlock(block)) return undefined;

  let path = containerPath(p);
  if (block.kind === 'table') {
    const rowCount = block.rows.length;
    if (rowCount === 0) return undefined;
    const row = Math.max(0, Math.min(path[0] ?? 0, rowCount - 1));
    const colCount = block.rows[row]?.cells.length ?? 0;
    if (colCount === 0) return undefined;
    const col = Math.max(0, Math.min(path[1] ?? 0, colCount - 1));
    path = [row, col];
  } else {
    path = [];
  }

  const container = containerOf(block, path);
  if (!container) return undefined;
  if (container.runs.length === 0) {
    return { blockId: block.id, path: [...path, 0], offset: 0 };
  }
  const index = Math.max(0, Math.min(runIndex(p), container.runs.length - 1));
  const run = container.runs[index];
  if (!run) return { blockId: block.id, path: [...path, 0], offset: 0 };
  let offset = snapToCodePoint(run.text, p.offset);
  // Raw runs are atomic: the caret sits before or after them, never inside.
  if (run.kind === 'raw' && offset !== 0 && offset !== run.text.length) {
    offset = offset * 2 >= run.text.length ? run.text.length : 0;
  }
  return { blockId: block.id, path: [...path, index], offset };
}

/**
 * Return a selection that is valid for `doc`.
 *
 * The rules, in order:
 * 1. A cell selection is clamped to the table's current extent; if the table is
 *    gone the selection collapses to the nearest caret position.
 * 2. A node selection survives only if the block still exists and is atomic.
 * 3. A text selection has both endpoints clamped. An endpoint in a vanished or
 *    atomic block snaps to the nearest caret-addressable block.
 * 4. A text selection whose endpoints land in two different cells of the *same*
 *    table becomes a cell selection — dragging across cells is a rectangular
 *    selection, not a linear one.
 */
export function normalizeSelection(doc: MdvDocument, selection: Selection): Selection {
  const fallback = (): Selection => {
    const block = nearestCaretBlock(doc, 0);
    if (!block) {
      // No caret-addressable block: select the first block as a node, else a
      // degenerate caret on the document itself, which commands reject.
      const first = doc.blocks[0];
      if (first) return { kind: 'node', blockId: first.id };
      return { kind: 'text', anchor: point(doc.id, [0], 0), focus: point(doc.id, [0], 0) };
    }
    const at = startOfBlock(block);
    return at ? caret(at) : { kind: 'node', blockId: block.id };
  };

  if (selection.kind === 'node') {
    const location = findBlock(doc, selection.blockId);
    if (location && isAtomicBlock(location.block)) return selection;
    if (location) {
      const at = startOfBlock(location.block);
      if (at) return caret(at);
    }
    return fallback();
  }

  if (selection.kind === 'cells') {
    const location = findBlock(doc, selection.tableId);
    if (!location || location.block.kind !== 'table') return fallback();
    const t = location.block;
    const clamp = (ref: CellRef): CellRef => {
      const row = Math.max(0, Math.min(Math.trunc(ref.row), t.rows.length - 1));
      const cols = t.rows[row]?.cells.length ?? 1;
      return { row, col: Math.max(0, Math.min(Math.trunc(ref.col), cols - 1)) };
    };
    return {
      kind: 'cells',
      tableId: t.id,
      anchor: clamp(selection.anchor),
      focus: clamp(selection.focus),
    };
  }

  const anchor = normalizePoint(doc, selection.anchor);
  const focus = normalizePoint(doc, selection.focus);
  if (!anchor && !focus) {
    const anchorBlock = findBlock(doc, selection.anchor.blockId);
    if (anchorBlock && isAtomicBlock(anchorBlock.block)) {
      return { kind: 'node', blockId: anchorBlock.block.id };
    }
    return fallback();
  }
  if (!anchor || !focus) {
    const survivor = anchor ?? focus;
    if (!survivor) return fallback();
    return caret(survivor);
  }

  if (
    anchor.blockId === focus.blockId &&
    anchor.path.length === 3 &&
    focus.path.length === 3 &&
    (anchor.path[0] !== focus.path[0] || anchor.path[1] !== focus.path[1])
  ) {
    return {
      kind: 'cells',
      tableId: anchor.blockId,
      anchor: { row: anchor.path[0] ?? 0, col: anchor.path[1] ?? 0 },
      focus: { row: focus.path[0] ?? 0, col: focus.path[1] ?? 0 },
    };
  }

  return { kind: 'text', anchor, focus };
}

/** True when `selection` is already exactly what {@link normalizeSelection} returns. */
export function isNormalized(doc: MdvDocument, selection: Selection): boolean {
  return selectionsEqual(selection, normalizeSelection(doc, selection));
}

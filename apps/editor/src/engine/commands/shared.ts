/**
 * Machinery shared by the commands: range deletion, block removal, pruning.
 *
 * Deleting a selection is the single hardest operation in a block editor,
 * because it is the only one that has to reason about every combination of
 * block kinds at once. It lives here, once, and every command that needs it
 * (typing over a selection, Backspace, paste, drag-move) calls the same
 * function rather than reimplementing three quarters of it.
 */

import { EngineError } from '../errors.js';
import type { NodeId } from '../ids.js';
import type { MappingBuilder } from '../mapping.js';
import { addressOf } from '../mapping.js';
import { normalizeRuns, runsLength, sliceRuns, spliceRuns } from '../inline.js';
import type { Block, ListBlock, MdvDocument, Run } from '../model.js';
import { isAtomicBlock } from '../model.js';
import type { CellRect, Point, Selection, TextSelection } from '../selection.js';
import {
  blockOrderIndex,
  cellRect,
  comparePoints,
  containerOf,
  containerPath,
  endOfBlock,
  fromAbsolute,
  orderedPoints,
  requireContainer,
  resolveContainer,
  startOfBlock,
  toAbsolute,
  wholeDocument,
  writeContainer,
} from '../selection.js';
import { allBlocks, findBlock, replaceBlockWith } from '../tree.js';
import { clampRect, clearCells, refsInRect, setCellRuns } from '../table.js';

/* -------------------------------------------------------------------------- */
/* Block removal                                                               */
/* -------------------------------------------------------------------------- */

/** Ids of every container enclosing `blockId`, innermost first. */
export function ancestorIds(doc: MdvDocument, blockId: NodeId): readonly NodeId[] {
  const out: NodeId[] = [];
  let location = findBlock(doc, blockId);
  while (location) {
    const parent = location.parent;
    if (parent.kind === 'document') break;
    const parentId = parent.kind === 'blockquote' ? parent.id : parent.listId;
    out.push(parentId);
    location = findBlock(doc, parentId);
  }
  return out;
}

/**
 * The outermost blocks lying strictly between two blocks in document order.
 *
 * "Outermost" matters: when a whole nested list sits between the endpoints we
 * want to remove the list, not each of its paragraphs and then an empty husk.
 * Containers that *enclose* the end block are never returned — removing them
 * would take the end block with them.
 */
export function blocksBetween(
  doc: MdvDocument,
  startBlockId: NodeId,
  endBlockId: NodeId,
): readonly NodeId[] {
  const order = blockOrderIndex(doc);
  const startOrder = order.get(startBlockId);
  const endOrder = order.get(endBlockId);
  if (startOrder === undefined || endOrder === undefined) return [];

  const endAncestors = new Set(ancestorIds(doc, endBlockId));
  const marked = new Set<NodeId>();
  const out: NodeId[] = [];

  allBlocks(doc).forEach((location, index) => {
    if (index <= startOrder || index >= endOrder) return;
    const id = location.block.id;
    if (endAncestors.has(id)) return;
    if (ancestorIds(doc, id).some((ancestor) => marked.has(ancestor))) return;
    marked.add(id);
    out.push(id);
  });
  return out;
}

/** Remove several blocks by id, ignoring ids that are already gone. */
export function removeBlocks(doc: MdvDocument, ids: readonly NodeId[]): MdvDocument {
  let next = doc;
  for (const id of ids) {
    if (!findBlock(next, id)) continue;
    next = replaceBlockWith(next, id, []);
  }
  return next;
}

/**
 * Drop list items that hold no blocks, and lists and quotes left with no
 * children. Deleting across structure leaves these husks behind; leaving them
 * in the model would serialise as stray `-` bullets and `>` markers.
 */
export function pruneEmptyContainers(doc: MdvDocument): MdvDocument {
  const prune = (blocks: readonly Block[]): readonly Block[] => {
    const out: Block[] = [];
    for (const block of blocks) {
      if (block.kind === 'blockquote') {
        const children = prune(block.children);
        if (children.length === 0) continue;
        out.push(children === block.children ? block : { ...block, children });
        continue;
      }
      if (block.kind === 'list') {
        const items = block.items
          .map((item) => {
            const inner = prune(item.blocks);
            return inner === item.blocks ? item : { ...item, blocks: inner };
          })
          .filter((item) => item.blocks.length > 0);
        if (items.length === 0) continue;
        out.push({ ...block, items } as ListBlock);
        continue;
      }
      out.push(block);
    }
    if (out.length === blocks.length && out.every((block, index) => block === blocks[index])) {
      return blocks;
    }
    return out;
  };
  const blocks = prune(doc.blocks);
  return blocks === doc.blocks ? doc : { ...doc, blocks };
}

/* -------------------------------------------------------------------------- */
/* Container editing                                                           */
/* -------------------------------------------------------------------------- */

/** The result of an edit that also knows where the caret ended up. */
export interface EditOutcome {
  readonly doc: MdvDocument;
  readonly selection: Selection;
}

/** Replace `[from, to)` in the container holding `at` with `replacement`. */
export function spliceAt(
  doc: MdvDocument,
  at: Point,
  from: number,
  to: number,
  replacement: readonly Run[],
  builder: MappingBuilder,
): { readonly doc: MdvDocument; readonly caret: Point } {
  const container = requireContainer(doc, at);
  const runs = spliceRuns(container.runs, from, to, replacement);
  const inserted = runsLength(replacement);
  builder.splice(addressOf(at), from, to, inserted);
  const next = writeContainer(doc, container, runs);
  const after = resolveContainer(next, at);
  if (!after) {
    throw new EngineError('EDIT_INVARIANT', 'container vanished during splice', {
      blockId: at.blockId,
    });
  }
  return { doc: next, caret: fromAbsolute(after, from + inserted) };
}

/** True when a block's inline content can absorb another block's tail. */
export function isMergeable(block: Block): boolean {
  return block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'code';
}

/* -------------------------------------------------------------------------- */
/* Range deletion                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Delete a text range, merging the endpoint blocks when both can hold inline
 * content.
 *
 * The rules, and why:
 *
 * - Within one container it is a plain splice.
 * - Across blocks the tail of the end block is appended to the head of the
 *   start block, everything between is removed, and the end block goes away —
 *   the behaviour every editor has, and the reason `mapPoint` needs `move`.
 * - When either endpoint is a table the two are **not** merged: cell text never
 *   escapes into a paragraph and a paragraph never lands inside a cell. The
 *   covered cells are cleared instead, which is what a spreadsheet does and
 *   what keeps the table rectangular.
 * - An atomic block (image, visual block, thematic break, raw passthrough)
 *   fully inside the range is removed; one that merely touches the range is
 *   left alone, since half an image is not a thing.
 */
export function deleteTextRange(
  doc: MdvDocument,
  selection: TextSelection,
  builder: MappingBuilder,
): EditOutcome {
  const [start, end] = orderedPoints(doc, selection);
  if (comparePoints(doc, start, end) === 0) {
    return { doc, selection: { kind: 'text', anchor: start, focus: start } };
  }

  const startContainer = requireContainer(doc, start);
  const endContainer = requireContainer(doc, end);
  const startAbs = toAbsolute(startContainer, start);
  const endAbs = toAbsolute(endContainer, end);

  if (start.blockId === end.blockId) {
    const samePath =
      containerPath(start).length === containerPath(end).length &&
      containerPath(start).every((value, index) => value === containerPath(end)[index]);
    if (samePath) {
      const result = spliceAt(doc, start, startAbs, endAbs, [], builder);
      return {
        doc: result.doc,
        selection: { kind: 'text', anchor: result.caret, focus: result.caret },
      };
    }
    // Two containers inside one block can only be two cells of one table.
    return deleteWithinTable(doc, start, end, startAbs, endAbs, builder);
  }

  const startBlock = findBlock(doc, start.blockId)?.block;
  const endBlock = findBlock(doc, end.blockId)?.block;
  if (!startBlock || !endBlock) {
    throw new EngineError('EDIT_INVALID_SELECTION', 'selection endpoint is not in the document');
  }

  const between = blocksBetween(doc, start.blockId, end.blockId);
  const merge = isMergeable(startBlock) && isMergeable(endBlock);

  let next = doc;

  if (merge) {
    const head = sliceRuns(startContainer.runs, 0, startAbs);
    const tail = sliceRuns(endContainer.runs, endAbs, runsLength(endContainer.runs));
    builder.splice(addressOf(start), startAbs, runsLength(startContainer.runs), 0);
    builder.move(addressOf(end), endAbs, addressOf(start), startAbs);
    for (const id of between) builder.drop(id);
    builder.drop(end.blockId);

    next = writeContainer(next, startContainer, normalizeRuns([...head, ...tail]));
    next = removeBlocks(next, [...between, end.blockId]);
  } else {
    // No merge: each endpoint keeps its own block and only loses its own text —
    // *unless* the range swallows the block whole. A table selected from its
    // first cell to its last is deleted; leaving an empty grid behind is what
    // makes Ctrl+A, Backspace feel broken. Only a block that cannot merge is
    // treated this way: an emptied paragraph or heading is a real place to put
    // the caret and keeps the block type the user was working in.
    const dropStart = !isMergeable(startBlock) && atBlockStart(doc, startBlock, start);
    const dropEnd = !isMergeable(endBlock) && atBlockEnd(doc, endBlock, end);

    builder.splice(addressOf(start), startAbs, runsLength(startContainer.runs), 0);
    builder.splice(addressOf(end), 0, endAbs, 0);
    for (const id of between) builder.drop(id);

    if (dropStart) {
      builder.drop(start.blockId);
      // Both endpoints gone would leave nothing to type into, so the first one
      // becomes the empty paragraph the deletion has to land in. Reusing its id
      // keeps ids unique — the block it names no longer exists.
      next = replaceBlockWith(
        next,
        start.blockId,
        dropEnd ? [{ kind: 'paragraph', id: start.blockId, runs: [] }] : [],
      );
    } else {
      next = writeContainer(next, startContainer, sliceRuns(startContainer.runs, 0, startAbs));
      if (startBlock.kind === 'table') {
        next = clearTableTail(next, start);
      }
    }

    if (dropEnd) {
      builder.drop(end.blockId);
      next = removeBlocks(next, [end.blockId]);
    } else {
      const endContainerAfter = resolveContainer(next, end);
      if (endContainerAfter) {
        next = writeContainer(
          next,
          endContainerAfter,
          sliceRuns(endContainerAfter.runs, endAbs, runsLength(endContainerAfter.runs)),
        );
      }
      if (endBlock.kind === 'table') {
        next = clearTableHead(next, end);
      }
    }
    next = removeBlocks(next, between);
  }

  next = pruneEmptyContainers(next);
  // Prefer the position the deletion collapsed to, then the surviving end of
  // the range, then anywhere at all. `caretNear` closes the last gap: when
  // nothing left in the document can hold a caret — a lone image or chart — it
  // selects that block instead, so the next keystroke still has a target.
  const caret = caretIn(next, start, startAbs) ?? caretAtStartOf(next, end.blockId);
  return {
    doc: next,
    selection: caret ? { kind: 'text', anchor: caret, focus: caret } : caretNear(next, end.blockId),
  };
}

/** The caret `abs` characters into the container `at` addresses, if it survived. */
function caretIn(doc: MdvDocument, at: Point, abs: number): Point | undefined {
  const container = resolveContainer(doc, at);
  return container ? fromAbsolute(container, Math.min(abs, runsLength(container.runs))) : undefined;
}

/** The first position inside `blockId`, if the block is still in the document. */
function caretAtStartOf(doc: MdvDocument, blockId: NodeId): Point | undefined {
  const block = findBlock(doc, blockId)?.block;
  return block ? startOfBlock(block) : undefined;
}

/** True when `a` and `b` address the same position, however each is spelled. */
function samePosition(doc: MdvDocument, a: Point, b: Point): boolean {
  if (a.blockId !== b.blockId) return false;
  const pathA = containerPath(a);
  const pathB = containerPath(b);
  if (pathA.length !== pathB.length) return false;
  if (!pathA.every((value, index) => value === pathB[index])) return false;
  const containerA = resolveContainer(doc, a);
  const containerB = resolveContainer(doc, b);
  if (!containerA || !containerB) return false;
  return toAbsolute(containerA, a) === toAbsolute(containerB, b);
}

/** True when `at` is the first position a caret can hold inside `block`. */
function atBlockStart(doc: MdvDocument, block: Block, at: Point): boolean {
  const from = startOfBlock(block);
  return from !== undefined && samePosition(doc, from, at);
}

/** True when `at` is the last position a caret can hold inside `block`. */
function atBlockEnd(doc: MdvDocument, block: Block, at: Point): boolean {
  const to = endOfBlock(block);
  return to !== undefined && samePosition(doc, to, at);
}

/** Clear every cell after the one holding `at`, in row-major order. */
function clearTableTail(doc: MdvDocument, at: Point): MdvDocument {
  const location = findBlock(doc, at.blockId);
  if (location?.block.kind !== 'table') return doc;
  const table = location.block;
  const path = containerPath(at);
  const row = path[0] ?? 0;
  const col = path[1] ?? 0;
  let next = table;
  for (const ref of refsInRect({
    top: row,
    left: 0,
    bottom: table.rows.length - 1,
    right: table.align.length - 1,
  })) {
    if (ref.row === row && ref.col <= col) continue;
    next = setCellRuns(next, ref, []);
  }
  return next === table ? doc : replaceBlockWith(doc, table.id, [next]);
}

/** Clear every cell before the one holding `at`, in row-major order. */
function clearTableHead(doc: MdvDocument, at: Point): MdvDocument {
  const location = findBlock(doc, at.blockId);
  if (location?.block.kind !== 'table') return doc;
  const table = location.block;
  const path = containerPath(at);
  const row = path[0] ?? 0;
  const col = path[1] ?? 0;
  let next = table;
  for (const ref of refsInRect({ top: 0, left: 0, bottom: row, right: table.align.length - 1 })) {
    if (ref.row === row && ref.col >= col) continue;
    next = setCellRuns(next, ref, []);
  }
  return next === table ? doc : replaceBlockWith(doc, table.id, [next]);
}

/** Delete between two cells of one table: partial ends, cleared middle. */
function deleteWithinTable(
  doc: MdvDocument,
  start: Point,
  end: Point,
  startAbs: number,
  endAbs: number,
  builder: MappingBuilder,
): EditOutcome {
  const startContainer = requireContainer(doc, start);
  requireContainer(doc, end); // validates the address; the runs are not needed
  builder.splice(addressOf(start), startAbs, runsLength(startContainer.runs), 0);
  builder.splice(addressOf(end), 0, endAbs, 0);

  let next = writeContainer(doc, startContainer, sliceRuns(startContainer.runs, 0, startAbs));
  next = clearTableTail(next, start);
  next = clearTableHead(next, end);
  const endAfter = resolveContainer(next, end);
  if (endAfter) {
    next = writeContainer(
      next,
      endAfter,
      sliceRuns(endAfter.runs, endAbs, runsLength(endAfter.runs)),
    );
  }
  const caretContainer = resolveContainer(next, start);
  const caret = caretContainer ? fromAbsolute(caretContainer, startAbs) : start;
  return { doc: next, selection: { kind: 'text', anchor: caret, focus: caret } };
}

/** Clear the cells of a rectangular selection. */
export function deleteCellRange(
  doc: MdvDocument,
  tableId: NodeId,
  rect: CellRect,
  builder: MappingBuilder,
): EditOutcome {
  const location = findBlock(doc, tableId);
  if (location?.block.kind !== 'table') {
    throw new EngineError('EDIT_NODE_NOT_FOUND', 'cell selection has no table', { tableId });
  }
  const table = location.block;
  const area = clampRect(table, rect);
  for (const ref of refsInRect(area)) {
    const cell = table.rows[ref.row]?.cells[ref.col];
    if (!cell || cell.runs.length === 0) continue;
    builder.splice({ blockId: tableId, path: [ref.row, ref.col] }, 0, runsLength(cell.runs), 0);
  }
  const next = replaceBlockWith(doc, tableId, [clearCells(table, area)]);
  return {
    doc: next,
    selection: {
      kind: 'cells',
      tableId,
      anchor: { row: area.top, col: area.left },
      focus: { row: area.bottom, col: area.right },
    },
  };
}

/**
 * Delete whatever the selection covers.
 *
 * Returns `null` when the selection is a collapsed caret and there is
 * consequently nothing to delete — the caller decides whether that means
 * "do nothing" or "delete one grapheme".
 */
export function deleteSelection(
  doc: MdvDocument,
  selection: Selection,
  builder: MappingBuilder,
): EditOutcome | null {
  if (selection.kind === 'text') {
    if (comparePoints(doc, selection.anchor, selection.focus) === 0) return null;
    return clearWholeDocument(doc, selection, builder) ?? deleteTextRange(doc, selection, builder);
  }
  if (selection.kind === 'cells') {
    return deleteCellRange(doc, selection.tableId, cellRect(selection), builder);
  }
  const location = findBlock(doc, selection.blockId);
  if (!location) return null;
  builder.drop(selection.blockId);
  const next = pruneEmptyContainers(replaceBlockWith(doc, selection.blockId, []));
  if (next.blocks.length === 0) return blankPage(next, selection.blockId);
  return { doc: next, selection: caretNear(next, selection.blockId) };
}

/**
 * Select-all then Backspace — or typing over that selection — means "blank
 * page", and a blank page keeps nothing: not the heading level of the first
 * block, and not the images and charts that {@link wholeDocument} cannot
 * address with a `Point` and would otherwise strand in a document the writer
 * just emptied. Any narrower range goes through {@link deleteTextRange}, which
 * does preserve the block the selection started in.
 */
function clearWholeDocument(
  doc: MdvDocument,
  selection: TextSelection,
  builder: MappingBuilder,
): EditOutcome | null {
  const everything = wholeDocument(doc);
  if (everything?.kind !== 'text') return null;
  const [start, end] = orderedPoints(doc, selection);
  if (!samePosition(doc, start, everything.anchor)) return null;
  if (!samePosition(doc, end, everything.focus)) return null;
  const first = doc.blocks[0];
  if (!first) return null;
  for (const location of allBlocks(doc)) builder.drop(location.block.id);
  return blankPage(doc, first.id);
}

/** An empty paragraph, reusing `id` from a block that is on its way out. */
function blankPage(doc: MdvDocument, id: NodeId): EditOutcome {
  const paragraph: Block = { kind: 'paragraph', id, runs: [] };
  const at: Point = { blockId: id, path: [0], offset: 0 };
  return {
    doc: { ...doc, blocks: [paragraph] },
    selection: { kind: 'text', anchor: at, focus: at },
  };
}

/**
 * A caret somewhere sensible after `blockId` was removed: the start of the
 * first block that can hold one, preferring blocks that were after it.
 */
export function caretNear(doc: MdvDocument, _removedId: NodeId): Selection {
  for (const location of allBlocks(doc)) {
    if (isAtomicBlock(location.block)) continue;
    const at = startOfBlock(location.block);
    if (at) return { kind: 'text', anchor: at, focus: at };
  }
  const first = doc.blocks[0];
  if (first) return { kind: 'node', blockId: first.id };
  const degenerate: Point = { blockId: doc.id, path: [0], offset: 0 };
  return { kind: 'text', anchor: degenerate, focus: degenerate };
}

/** Resolve a point's container, or raise a diagnostic naming the point. */
export function containerAt(doc: MdvDocument, at: Point): ReturnType<typeof requireContainer> {
  return requireContainer(doc, at);
}

/** The container of a block's `[row, col]` cell, when the block is a table. */
export function cellContainer(
  block: Block,
  row: number,
  col: number,
): ReturnType<typeof containerOf> {
  return containerOf(block, [row, col]);
}

/**
 * Test helpers.
 *
 * Deliberately thin: the point of these tests is to pin down the engine's real
 * API, so anything that hides it would defeat the exercise. What is here is
 * only the addressing arithmetic — "put the caret ten characters into the
 * second block" — that would otherwise be repeated in every assertion.
 */

import { createEditor } from '../editor.js';
import type { Editor } from '../editor.js';
import { createIdFactory } from '../ids.js';
import type { NodeId } from '../ids.js';
import type { Block, MdvDocument } from '../model.js';
import type { Point, Selection } from '../selection.js';
import { caret, fromAbsolute, range, requireContainer, toAbsolute } from '../selection.js';
import { allBlocks } from '../tree.js';
import { write } from '../io/write.js';

/** An editor over `text`, with deterministic ids so assertions can name them. */
export function editorFor(text: string): Editor {
  return createEditor({ text, context: { ids: createIdFactory('t') } });
}

/** The `n`th top-level block. */
export function blockAt(doc: MdvDocument, index: number): Block {
  const block = doc.blocks[index];
  if (!block) throw new Error(`no block at index ${index}; document has ${doc.blocks.length}`);
  return block;
}

/** Every block in document order, containers included. */
export function flatBlocks(doc: MdvDocument): readonly Block[] {
  return [...allBlocks(doc)].map((location) => location.block);
}

/** The first block whose kind matches. */
export function firstOfKind(doc: MdvDocument, kind: Block['kind']): Block {
  const found = flatBlocks(doc).find((block) => block.kind === kind);
  if (!found) throw new Error(`no ${kind} block in document`);
  return found;
}

/**
 * The absolute offset of a point within its container.
 *
 * `Point.offset` is relative to the run named by the last path segment, so two
 * points that look different can address the same character. Assertions should
 * compare this instead.
 */
export function absoluteOf(doc: MdvDocument, p: Point): number {
  return toAbsolute(requireContainer(doc, p), p);
}

/** A point `offset` characters into a run block, counting across runs. */
export function at(doc: MdvDocument, blockId: NodeId, offset: number): Point {
  // A point's path ends with a *run* index, which `containerPath` strips, so
  // the container of a run block is addressed by a one-element path.
  const container = requireContainer(doc, { blockId, path: [0], offset: 0 });
  return fromAbsolute(container, offset);
}

/** A point `offset` characters into a table cell. */
export function inCell(doc: MdvDocument, tableId: NodeId, row: number, col: number, offset = 0): Point {
  const container = requireContainer(doc, { blockId: tableId, path: [row, col, 0], offset: 0 });
  return fromAbsolute(container, offset);
}

/** A collapsed selection `offset` characters into a block. */
export function caretAt(doc: MdvDocument, blockId: NodeId, offset: number): Selection {
  return caret(at(doc, blockId, offset));
}

/** A selection spanning `[from, to)` inside one block. */
export function rangeIn(doc: MdvDocument, blockId: NodeId, from: number, to: number): Selection {
  return range(at(doc, blockId, from), at(doc, blockId, to));
}

/** A selection from one block's offset to another's. */
export function rangeAcross(
  doc: MdvDocument,
  startId: NodeId,
  startOffset: number,
  endId: NodeId,
  endOffset: number,
): Selection {
  return range(at(doc, startId, startOffset), at(doc, endId, endOffset));
}

/** The document as `.mdv` source, for readable assertions. */
export function source(doc: MdvDocument): string {
  return write(doc);
}

/** The plain text of a run block, for readable assertions. */
export function textOf(block: Block): string {
  if (block.kind === 'paragraph' || block.kind === 'heading') {
    return block.runs.map((run) => run.text).join('');
  }
  if (block.kind === 'code' || block.kind === 'raw') return block.text;
  throw new Error(`${block.kind} has no inline text`);
}

/** The plain text of every cell, row-major, for table assertions. */
export function tableText(block: Block): readonly (readonly string[])[] {
  if (block.kind !== 'table') throw new Error(`expected a table, got ${block.kind}`);
  return block.rows.map((row) => row.cells.map((cell) => cell.runs.map((run) => run.text).join('')));
}

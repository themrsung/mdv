/**
 * Insertion commands: blocks, fragments, images, tables and visual blocks.
 *
 * Every insertion answers the same three questions — is the caret's block empty
 * (replace it), is the caret at an edge (insert beside it), or is it in the
 * middle (split, then insert between) — so they all funnel through
 * {@link insertBlocks} rather than each inventing its own placement rule.
 */

import { emptyTable, image as makeImage, paragraph as makeParagraph, visualBlock } from '../builders.js';
import type { IdFactory, NodeId } from '../ids.js';
import { normalizeRuns, runsLength, runsText, sliceRuns, spliceRuns } from '../inline.js';
import { MappingBuilder, addressOf } from '../mapping.js';
import type { Block, ColumnAlign, InfoAttribute, MdvDocument, Run } from '../model.js';
import { isAtomicBlock, isRunBlock } from '../model.js';
import type { Command, EditContext, EditorState } from '../state.js';
import type { Point, Selection } from '../selection.js';
import {
  caret,
  cellRect,
  containerPath,
  endOfBlock,
  fromAbsolute,
  requireContainer,
  resolveContainer,
  startOfBlock,
  toAbsolute,
  writeContainer,
} from '../selection.js';
import { findBlock, insertBlocks as insertIntoParent, replaceBlockWith } from '../tree.js';
import { deleteSelection } from './shared.js';

/** Where an insertion put the caret afterwards. */
function afterBlock(block: Block): Selection {
  if (isAtomicBlock(block)) return { kind: 'node', blockId: block.id };
  const at = endOfBlock(block);
  return at ? caret(at) : { kind: 'node', blockId: block.id };
}

/** True when a block holds no content at all — the "empty paragraph" test. */
export function isEmptyBlock(block: Block): boolean {
  if (isRunBlock(block)) return runsLength(block.runs) === 0;
  if (block.kind === 'code') return block.text === '';
  return false;
}

/**
 * Insert blocks at the selection.
 *
 * Splits the caret's block when the caret is inside it, so an image dropped
 * mid-sentence lands between the two halves rather than swallowing one.
 */
export function insertBlocksAtSelection(blocks: readonly Block[]): Command {
  return (state, ctx) => {
    if (blocks.length === 0) return null;
    const builder = new MappingBuilder(state.doc);
    let doc = state.doc;
    let selection = state.selection;

    const cleared = deleteSelection(doc, selection, builder);
    if (cleared) {
      doc = cleared.doc;
      selection = cleared.selection;
    }

    const last = blocks[blocks.length - 1];
    if (!last) return null;

    if (selection.kind === 'node') {
      builder.drop(selection.blockId);
      const next = replaceBlockWith(doc, selection.blockId, blocks);
      return {
        state: { doc: next, selection: afterBlock(last), pendingMarks: null },
        label: 'insert',
        mapPoint: builder.build(next),
      };
    }

    const at =
      selection.kind === 'cells'
        ? ({ blockId: selection.tableId, path: [cellRect(selection).top, cellRect(selection).left, 0], offset: 0 } satisfies Point)
        : selection.anchor;

    const location = findBlock(doc, at.blockId);
    if (!location) return null;

    // Inside a table, a block insertion goes *after* the table: a GFM cell
    // cannot contain a block.
    const host = containerPath(at).length > 0 ? location : location;
    const anchorBlock = host.block;

    if (anchorBlock.kind === 'table') {
      const next = insertIntoParent(doc, host.parent, host.index + 1, blocks);
      return {
        state: { doc: next, selection: afterBlock(last), pendingMarks: null },
        label: 'insert',
        mapPoint: builder.build(next),
      };
    }

    if (isEmptyBlock(anchorBlock)) {
      builder.drop(anchorBlock.id);
      const next = replaceBlockWith(doc, anchorBlock.id, blocks);
      return {
        state: { doc: next, selection: afterBlock(last), pendingMarks: null },
        label: 'insert',
        mapPoint: builder.build(next),
      };
    }

    const container = requireContainer(doc, at);
    const abs = toAbsolute(container, at);
    const total = runsLength(container.runs);

    if (abs <= 0) {
      const next = insertIntoParent(doc, host.parent, host.index, blocks);
      return {
        state: { doc: next, selection: afterBlock(last), pendingMarks: null },
        label: 'insert',
        mapPoint: builder.build(next),
      };
    }
    if (abs >= total) {
      const next = insertIntoParent(doc, host.parent, host.index + 1, blocks);
      return {
        state: { doc: next, selection: afterBlock(last), pendingMarks: null },
        label: 'insert',
        mapPoint: builder.build(next),
      };
    }

    // Mid-block: split, then insert between the halves.
    const tail = makeParagraph(ctx.ids, sliceRuns(container.runs, abs, total));
    builder.splice(addressOf(at), abs, total, 0);
    builder.move(addressOf(at), abs, { blockId: tail.id, path: [] }, 0);
    let next = writeContainer(doc, container, sliceRuns(container.runs, 0, abs));
    next = insertIntoParent(next, host.parent, host.index + 1, [...blocks, tail]);
    return {
      state: { doc: next, selection: afterBlock(last), pendingMarks: null },
      label: 'insert',
      mapPoint: builder.build(next),
    };
  };
}

/**
 * Insert a *fragment* — the paste path.
 *
 * A fragment differs from a block list in that its first and last blocks are
 * expected to fuse with the text around the caret: pasting "b" into "a|c"
 * yields one paragraph "abc", not three. Only paragraphs fuse; pasting a
 * heading into the middle of a sentence deliberately splits it.
 */
export function insertFragment(blocks: readonly Block[]): Command {
  return (state, ctx) => {
    if (blocks.length === 0) return null;
    const builder = new MappingBuilder(state.doc);
    let doc = state.doc;
    let selection = state.selection;

    const cleared = deleteSelection(doc, selection, builder);
    if (cleared) {
      doc = cleared.doc;
      selection = cleared.selection;
    }
    if (selection.kind !== 'text') {
      return insertBlocksAtSelection(blocks)({ ...state, doc, selection }, ctx);
    }

    const at = selection.anchor;
    const location = findBlock(doc, at.blockId);
    if (!location) return null;
    const block = location.block;
    const container = requireContainer(doc, at);
    const abs = toAbsolute(container, at);
    const total = runsLength(container.runs);

    const first = blocks[0];
    const lastBlock = blocks[blocks.length - 1];
    if (!first || !lastBlock) return null;

    // A code block or a table cell can only take plain text.
    if (container.storage === 'text' || containerPath(at).length > 0) {
      const text = blocks.map((entry) => blockPlainText(entry)).join('\n');
      const runs = spliceRuns(container.runs, abs, abs, [
        { kind: 'text', id: ctx.ids(), text, marks: [] },
      ]);
      builder.splice(addressOf(at), abs, abs, text.length);
      const next = writeContainer(doc, container, runs);
      const after = resolveContainer(next, at);
      return {
        state: {
          doc: next,
          selection: caret(after ? fromAbsolute(after, abs + text.length) : at),
          pendingMarks: null,
        },
        label: 'paste',
        mapPoint: builder.build(next),
      };
    }

    // Single paragraph: pure inline insertion.
    if (blocks.length === 1 && first.kind === 'paragraph' && isRunBlock(block)) {
      const inserted = runsLength(first.runs);
      const runs = spliceRuns(container.runs, abs, abs, first.runs);
      builder.splice(addressOf(at), abs, abs, inserted);
      const next = writeContainer(doc, container, runs);
      const after = resolveContainer(next, at);
      return {
        state: {
          doc: next,
          selection: caret(after ? fromAbsolute(after, abs + inserted) : at),
          pendingMarks: null,
        },
        label: 'paste',
        mapPoint: builder.build(next),
      };
    }

    if (isEmptyBlock(block)) {
      builder.drop(block.id);
      const next = replaceBlockWith(doc, block.id, blocks);
      return {
        state: { doc: next, selection: afterBlock(lastBlock), pendingMarks: null },
        label: 'paste',
        mapPoint: builder.build(next),
      };
    }

    const head = sliceRuns(container.runs, 0, abs);
    const tailRuns = sliceRuns(container.runs, abs, total);

    // Fuse the fragment's first paragraph onto the head of the caret's block.
    const middle: Block[] = [...blocks];
    const fused = first.kind === 'paragraph' && isRunBlock(block);
    let headRuns: readonly Run[] = head;
    if (fused && first.kind === 'paragraph') {
      headRuns = normalizeRuns([...head, ...first.runs]);
      middle.shift();
    }

    // Fuse the text after the caret onto the fragment's last paragraph, or,
    // when the fragment ends in something that cannot hold it, keep it as its
    // own paragraph after the fragment.
    const tailBlocks: Block[] = [];
    const lastMiddle = middle[middle.length - 1];
    let caretBlockId: NodeId;
    let caretOffset: number;

    if (runsLength(tailRuns) > 0) {
      if (lastMiddle?.kind === 'paragraph') {
        caretOffset = runsLength(lastMiddle.runs);
        middle[middle.length - 1] = {
          ...lastMiddle,
          runs: normalizeRuns([...lastMiddle.runs, ...tailRuns]),
        };
        caretBlockId = lastMiddle.id;
      } else {
        const tail = makeParagraph(ctx.ids, tailRuns);
        tailBlocks.push(tail);
        caretBlockId = tail.id;
        caretOffset = 0;
      }
      builder.move(addressOf(at), abs, { blockId: caretBlockId, path: [] }, caretOffset);
    } else if (lastMiddle) {
      caretBlockId = lastMiddle.id;
      caretOffset = isRunBlock(lastMiddle) ? runsLength(lastMiddle.runs) : 0;
    } else {
      caretBlockId = block.id;
      caretOffset = runsLength(headRuns);
    }

    builder.splice(addressOf(at), abs, total, fused && first.kind === 'paragraph' ? runsLength(first.runs) : 0);

    let next = writeContainer(doc, container, headRuns);
    if (middle.length > 0 || tailBlocks.length > 0) {
      next = insertIntoParent(next, location.parent, location.index + 1, [...middle, ...tailBlocks]);
    }

    return {
      state: {
        doc: next,
        selection: caretIn(next, caretBlockId, caretOffset) ?? selection,
        pendingMarks: null,
      },
      label: 'paste',
      mapPoint: builder.build(next),
    };
  };
}

/** A caret at `offset` inside `blockId`, or a node selection for atomic blocks. */
function caretIn(doc: MdvDocument, blockId: NodeId, offset: number): Selection | null {
  const block = findBlock(doc, blockId)?.block;
  if (!block) return null;
  if (isAtomicBlock(block)) return { kind: 'node', blockId };
  const probe: Point =
    block.kind === 'table'
      ? { blockId, path: [0, 0, 0], offset: 0 }
      : { blockId, path: [0], offset: 0 };
  const container = resolveContainer(doc, probe);
  if (!container) return { kind: 'node', blockId };
  return caret(fromAbsolute(container, Math.min(Math.max(0, offset), runsLength(container.runs))));
}

/** A block's content as plain text, for pasting into code or a table cell. */
export function blockPlainText(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return runsText(block.runs);
    case 'code':
      return block.text;
    case 'raw':
      return block.text;
    case 'image':
      return block.alt;
    case 'thematicBreak':
      return '';
    case 'visual':
      return block.data ?? '';
    case 'table':
      return block.rows
        .map((row) => row.cells.map((cell) => runsText(cell.runs)).join('\t'))
        .join('\n');
    case 'blockquote':
      return block.children.map(blockPlainText).join('\n');
    case 'list':
      return block.items.map((item) => item.blocks.map(blockPlainText).join('\n')).join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/* Concrete insertions                                                         */
/* -------------------------------------------------------------------------- */

/** Options accepted by {@link insertImage}. */
export interface InsertImageOptions {
  readonly alt?: string;
  readonly title?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

/**
 * Insert an image block.
 *
 * `src` is whatever the caller has — a URL or, in this editor, a `data:` URI
 * produced by the image pipeline. The engine does not fetch or validate it.
 */
export function insertImage(src: string, options: InsertImageOptions = {}): Command {
  return (state, ctx) => {
    const block = makeImage(ctx.ids, src, options);
    const result = insertBlocksAtSelection([block])(state, ctx);
    return result === null ? null : { ...result, label: 'insert image' };
  };
}

/** Insert an empty table with a header row and `bodyRows` body rows. */
export function insertTable(columns: number, bodyRows: number): Command {
  return (state, ctx) => {
    const block = emptyTable(ctx.ids, columns, bodyRows);
    const result = insertBlocksAtSelection([block])(state, ctx);
    if (result === null) return null;
    return {
      ...result,
      label: 'insert table',
      state: {
        ...result.state,
        selection: {
          kind: 'text',
          anchor: { blockId: block.id, path: [0, 0, 0], offset: 0 },
          focus: { blockId: block.id, path: [0, 0, 0], offset: 0 },
        },
      },
    };
  };
}

/** Options accepted by {@link insertVisualBlock}. */
export interface InsertVisualOptions {
  readonly header?: string;
  readonly data?: string | null;
  readonly infoAttributes?: readonly InfoAttribute[];
}

/**
 * Insert an MDV visual block.
 *
 * Note the SPEC 5.1 determinism rule the writer enforces: a block with `data`
 * gets a `---` separator, a block without one does not, and a block whose data
 * is the empty string still gets the separator. Pass `data: null` for "header
 * only".
 */
export function insertVisualBlock(type: string, options: InsertVisualOptions = {}): Command {
  return (state, ctx) => {
    const block = visualBlock(ctx.ids, type, options);
    const result = insertBlocksAtSelection([block])(state, ctx);
    return result === null ? null : { ...result, label: 'insert visual block' };
  };
}

/** Insert a thematic break. */
export function insertThematicBreak(): Command {
  return (state, ctx) => {
    const block: Block = { kind: 'thematicBreak', id: ctx.ids(), marker: '---' };
    const result = insertBlocksAtSelection([block])(state, ctx);
    return result === null ? null : { ...result, label: 'insert' };
  };
}

/** Replace an image's attributes in place — the image inspector's commit. */
export function updateImage(
  blockId: NodeId,
  patch: { readonly alt?: string; readonly title?: string | null; readonly src?: string; readonly width?: number | null; readonly height?: number | null },
): Command {
  return (state) => {
    const location = findBlock(state.doc, blockId);
    if (location?.block.kind !== 'image') return null;
    const block = location.block;
    const next = {
      ...block,
      ...(patch.src === undefined ? {} : { src: patch.src }),
      ...(patch.alt === undefined ? {} : { alt: patch.alt }),
      ...(patch.title === undefined ? {} : { title: patch.title }),
      ...(patch.width === undefined ? {} : { width: patch.width }),
      ...(patch.height === undefined ? {} : { height: patch.height }),
    };
    return {
      state: {
        doc: replaceBlockWith(state.doc, blockId, [next]),
        selection: state.selection,
        pendingMarks: null,
      },
      label: 'insert image',
    };
  };
}

/** Replace a visual block's header and/or data section. */
export function updateVisualBlock(
  blockId: NodeId,
  patch: { readonly blockType?: string; readonly header?: string; readonly data?: string | null },
): Command {
  return (state) => {
    const location = findBlock(state.doc, blockId);
    if (location?.block.kind !== 'visual') return null;
    const block = location.block;
    const next = {
      ...block,
      ...(patch.blockType === undefined ? {} : { blockType: patch.blockType }),
      ...(patch.header === undefined ? {} : { header: patch.header }),
      ...(patch.data === undefined ? {} : { data: patch.data }),
    };
    return {
      state: {
        doc: replaceBlockWith(state.doc, blockId, [next]),
        selection: state.selection,
        pendingMarks: null,
      },
      label: 'insert visual block',
    };
  };
}

/** Build an empty table without inserting it — used by the clipboard. */
export function buildTable(
  ids: IdFactory,
  columns: number,
  rows: number,
  _align: readonly ColumnAlign[] = [],
): Block {
  return emptyTable(ids, columns, rows);
}

/** Re-exported for the command index. */
export type { EditContext, EditorState, MdvDocument };

/**
 * Copy and cut.
 *
 * Three flavours go on the clipboard, and each has a job:
 *
 * - **`text/x-mdv`** is the document's own source, so a copy between two `.mdv`
 *   documents is exact — visual blocks, attribute quoting, raw blocks and all.
 * - **`text/plain`** is *also* the source. This is the established convention
 *   for markdown editors, and it is the useful one: pasting into a terminal, a
 *   commit message or a code review gives you markdown rather than a wall of
 *   unstructured prose.
 * - **`text/html`** is semantic HTML for everyone else, so pasting into Gmail
 *   or a document editor keeps the formatting.
 */

import type { Block, ListItem, Run, TableCell, TableRow } from '../model.js';
import type { IdFactory } from '../ids.js';
import { createIdFactory } from '../ids.js';
import type { Point, Selection } from '../selection.js';
import { cellRect, containerPath, orderedPoints, resolveContainer, toAbsolute } from '../selection.js';
import type { MdvDocument } from '../model.js';
import { findBlock } from '../tree.js';
import { sliceRuns, runsLength } from '../inline.js';
import { codeBlock, heading, paragraph, table as tableBlock, tableCell, tableRow } from '../builders.js';
import { blocksBetween } from '../commands/shared.js';
import { extractRect } from '../table.js';
import { write, writeBlocks } from '../io/write.js';
import { blocksToHtml } from './to-html.js';
import { HTML_CLIPBOARD_TYPE, MDV_CLIPBOARD_TYPE, TEXT_CLIPBOARD_TYPE } from './payload.js';

/** Everything a copy produced. */
export interface CopyResult {
  /** The extracted fragment, for callers that want the model rather than text. */
  readonly blocks: readonly Block[];
  /** `.mdv` source. */
  readonly mdv: string;
  /** `text/plain`, which is the same source. */
  readonly text: string;
  /** `text/html`. */
  readonly html: string;
}

/**
 * Extract and serialise the selection.
 *
 * Returns `null` for a collapsed caret: copying nothing should leave whatever
 * is already on the clipboard alone rather than replacing it with an empty
 * string.
 */
export function copySelection(doc: MdvDocument, selection: Selection): CopyResult | null {
  const blocks = fragmentOf(doc, selection);
  if (blocks.length === 0) return null;
  const mdv = writeBlocks(blocks);
  return { blocks, mdv, text: mdv, html: blocksToHtml(blocks) };
}

/** The whole document, serialised for the clipboard. */
export function copyDocument(doc: MdvDocument): CopyResult {
  return {
    blocks: doc.blocks,
    mdv: write(doc),
    text: write(doc),
    html: blocksToHtml(doc.blocks),
  };
}

/** A copy result as a MIME-keyed map, ready to hand to `setData`. */
export function clipboardEntries(result: CopyResult): Readonly<Record<string, string>> {
  return {
    [MDV_CLIPBOARD_TYPE]: result.mdv,
    [TEXT_CLIPBOARD_TYPE]: result.text,
    [HTML_CLIPBOARD_TYPE]: result.html,
  };
}

/**
 * Extract the selected content as a standalone block list.
 *
 * Partially covered blocks are trimmed to what the selection touches; fully
 * covered ones keep their kind, so copying a whole heading gives you a heading
 * and copying half of one gives you a paragraph. Ids are fresh, so the fragment
 * can be pasted back into the same document without colliding.
 */
export function fragmentOf(
  doc: MdvDocument,
  selection: Selection,
  ids: IdFactory = createIdFactory('c'),
): readonly Block[] {
  return selectedBlocks(doc, selection, ids).map((block) => withFreshIds(block, ids));
}

/**
 * The selected content, still sharing node identity with `doc`.
 *
 * Wholly covered blocks come back as the very objects that are in the document,
 * because trimming them would be a no-op; {@link fragmentOf} is what turns the
 * result into a standalone value.
 */
function selectedBlocks(
  doc: MdvDocument,
  selection: Selection,
  ids: IdFactory,
): readonly Block[] {
  if (selection.kind === 'node') {
    const block = findBlock(doc, selection.blockId)?.block;
    return block ? [block] : [];
  }

  if (selection.kind === 'cells') {
    const block = findBlock(doc, selection.tableId)?.block;
    if (block?.kind !== 'table') return [];
    const rect = cellRect(selection);
    const grid = extractRect(block, rect);
    if (grid.length === 0) return [];
    const align = block.align.slice(rect.left, rect.right + 1);
    const rows = grid.map((row) => tableRow(ids, row.map((runs) => tableCell(ids, runs))));
    return [tableBlock(ids, align, rows)];
  }

  const [start, end] = orderedPoints(doc, selection);
  if (start.blockId === end.blockId && containerPath(start).join() === containerPath(end).join()) {
    return sliceOne(doc, start, end, ids);
  }

  const head = tailOf(doc, start, ids);
  const middle = blocksBetween(doc, start.blockId, end.blockId)
    .map((id) => findBlock(doc, id)?.block)
    .filter((block): block is Block => block !== undefined);
  const tail = headOf(doc, end, ids);
  return [...head, ...middle, ...tail];
}

/** One container, sliced between two points in it. */
function sliceOne(doc: MdvDocument, start: Point, end: Point, ids: IdFactory): readonly Block[] {
  const container = resolveContainer(doc, start);
  const block = findBlock(doc, start.blockId)?.block;
  if (!container || !block) return [];

  const from = toAbsolute(container, start);
  const to = toAbsolute(container, end);
  if (from === to) return [];

  if (container.storage === 'text' && block.kind === 'code') {
    const text = block.text.slice(from, to);
    return from === 0 && to === block.text.length ? [block] : [codeBlock(ids, text, block.info, block.fence)];
  }

  const whole = from === 0 && to === runsLength(container.runs);
  if (whole && container.path.length === 0) return [block];

  const runs = sliceRuns(container.runs, from, to);
  if (whole && block.kind === 'heading') return [heading(ids, block.level, runs, block.style)];
  return [paragraph(ids, runs)];
}

/**
 * Everything from a point to the end of its block.
 *
 * A point inside a table takes the whole table: a partial table with an
 * arbitrary starting cell is not a shape the model can express, and cropping it
 * would be a bigger surprise than including one extra row.
 */
function tailOf(doc: MdvDocument, point: Point, ids: IdFactory): readonly Block[] {
  const block = findBlock(doc, point.blockId)?.block;
  if (!block) return [];
  if (block.kind === 'table') return [block];

  const container = resolveContainer(doc, point);
  if (!container) return [block];
  const from = toAbsolute(container, point);

  if (container.storage === 'text' && block.kind === 'code') {
    return from === 0 ? [block] : [codeBlock(ids, block.text.slice(from), block.info, block.fence)];
  }
  if (from === 0) return [block];
  const runs = sliceRuns(container.runs, from, runsLength(container.runs));
  return runs.length === 0 ? [] : [paragraph(ids, runs)];
}

/** Everything from the start of a block up to a point. */
function headOf(doc: MdvDocument, point: Point, ids: IdFactory): readonly Block[] {
  const block = findBlock(doc, point.blockId)?.block;
  if (!block) return [];
  if (block.kind === 'table') return [block];

  const container = resolveContainer(doc, point);
  if (!container) return [block];
  const to = toAbsolute(container, point);
  if (to === 0) return [];

  if (container.storage === 'text' && block.kind === 'code') {
    return to === block.text.length ? [block] : [codeBlock(ids, block.text.slice(0, to), block.info, block.fence)];
  }
  const length = runsLength(container.runs);
  if (to >= length) return [block];
  const runs: readonly Run[] = sliceRuns(container.runs, 0, to);
  return runs.length === 0 ? [] : [paragraph(ids, runs)];
}

/* -------------------------------------------------------------------------- */
/* Re-identification                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The same content under fresh ids, top to bottom.
 *
 * A fragment is a value, not a view: it can be pasted back into the document it
 * came from, and more than once. Ids *address* nodes here, so a fragment that
 * kept the originals would make `findBlock` ambiguous the moment it landed —
 * the caret would then resolve against whichever copy happened to come first.
 *
 * Every field other than the ids is carried across untouched, and the rebuild
 * is written out by hand rather than spread over `...block`, so that adding a
 * block kind to the model breaks this switch instead of silently leaking the
 * new kind's ids.
 */
function withFreshIds(block: Block, ids: IdFactory): Block {
  switch (block.kind) {
    case 'paragraph':
      return { kind: 'paragraph', id: ids(), runs: freshRuns(block.runs, ids) };
    case 'heading':
      return {
        kind: 'heading',
        id: ids(),
        level: block.level,
        style: block.style,
        runs: freshRuns(block.runs, ids),
      };
    case 'list': {
      const items = block.items.map((item) => freshItem(item, ids));
      return block.ordered
        ? {
            kind: 'list',
            id: ids(),
            ordered: true,
            start: block.start,
            delimiter: block.delimiter,
            tight: block.tight,
            items,
          }
        : {
            kind: 'list',
            id: ids(),
            ordered: false,
            bullet: block.bullet,
            tight: block.tight,
            items,
          };
    }
    case 'blockquote':
      return {
        kind: 'blockquote',
        id: ids(),
        children: block.children.map((child) => withFreshIds(child, ids)),
      };
    case 'code':
      return { kind: 'code', id: ids(), info: block.info, text: block.text, fence: block.fence };
    case 'thematicBreak':
      return { kind: 'thematicBreak', id: ids(), marker: block.marker };
    case 'image':
      return {
        kind: 'image',
        id: ids(),
        src: block.src,
        alt: block.alt,
        title: block.title,
        width: block.width,
        height: block.height,
      };
    case 'table':
      return {
        kind: 'table',
        id: ids(),
        align: block.align,
        rows: block.rows.map((row) => freshRow(row, ids)),
      };
    case 'visual':
      return {
        kind: 'visual',
        id: ids(),
        blockType: block.blockType,
        infoAttributes: block.infoAttributes,
        header: block.header,
        data: block.data,
        fence: block.fence,
      };
    case 'raw':
      return { kind: 'raw', id: ids(), text: block.text };
  }
}

/** Runs under fresh ids; marks are immutable value objects and are shared. */
function freshRuns(runs: readonly Run[], ids: IdFactory): readonly Run[] {
  return runs.map((run) =>
    run.kind === 'text'
      ? { kind: 'text', id: ids(), text: run.text, marks: run.marks }
      : { kind: 'raw', id: ids(), source: run.source, text: run.text },
  );
}

/** One list item, itself a block container, under fresh ids. */
function freshItem(item: ListItem, ids: IdFactory): ListItem {
  return {
    id: ids(),
    checked: item.checked,
    blocks: item.blocks.map((child) => withFreshIds(child, ids)),
  };
}

/** One table row under fresh ids. */
function freshRow(row: TableRow, ids: IdFactory): TableRow {
  return { id: ids(), cells: row.cells.map((cell) => freshCell(cell, ids)) };
}

/** One table cell under fresh ids. */
function freshCell(cell: TableCell, ids: IdFactory): TableCell {
  return { id: ids(), runs: freshRuns(cell.runs, ids) };
}

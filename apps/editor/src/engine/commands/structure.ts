/**
 * Structural commands: split, merge, block type, indent and outdent.
 *
 * These are the edits that change the *shape* of the document rather than its
 * characters, and they are the ones that must never coalesce in the undo stack:
 * pressing Enter and then typing should undo as two steps, not one.
 */

import {
  blockquote as makeQuote,
  bulletList,
  listItem as makeItem,
  orderedList,
  paragraph as makeParagraph,
} from '../builders.js';
import { EngineError } from '../errors.js';
import type { IdFactory, NodeId } from '../ids.js';
import { reassignIds } from '../ids.js';
import { normalizeRuns, runsLength, runsText, sliceRuns } from '../inline.js';
import { MappingBuilder, addressOf } from '../mapping.js';
import type { Block, HeadingLevel, ListBlock, ListItem, MdvDocument, Run } from '../model.js';
import { isAtomicBlock, isRunBlock } from '../model.js';
import type { Point, Selection } from '../selection.js';
import {
  blockOrderIndex,
  caret,
  comparePoints,
  containerPath,
  endOfBlock,
  fromAbsolute,
  orderedPoints,
  requireContainer,
  resolveContainer,
  startOfBlock,
  toAbsolute,
  writeContainer,
} from '../selection.js';
import {
  ROOT,
  allBlocks,
  enclosingListItem,
  findBlock,
  findListItem,
  insertBlocks,
  replaceBlockWith,
  siblingsOf,
  withSiblings,
} from '../tree.js';
import type { ParentRef } from '../tree.js';
import type { Command, CommandResult, EditContext, EditorState } from '../state.js';
import { deleteSelection, isMergeable, pruneEmptyContainers } from './shared.js';

/* -------------------------------------------------------------------------- */
/* Selection → blocks                                                          */
/* -------------------------------------------------------------------------- */

/** The leaf blocks the selection touches, in document order. */
export function touchedBlocks(doc: MdvDocument, selection: Selection): readonly Block[] {
  if (selection.kind === 'node') {
    const block = findBlock(doc, selection.blockId)?.block;
    return block ? [block] : [];
  }
  if (selection.kind === 'cells') {
    const block = findBlock(doc, selection.tableId)?.block;
    return block ? [block] : [];
  }
  const order = blockOrderIndex(doc);
  const [start, end] = orderedPoints(doc, selection);
  const from = order.get(start.blockId);
  const to = order.get(end.blockId);
  if (from === undefined || to === undefined) return [];
  const out: Block[] = [];
  allBlocks(doc).forEach((location, index) => {
    if (index < from || index > to) return;
    if (location.block.kind === 'list' || location.block.kind === 'blockquote') return;
    out.push(location.block);
  });
  return out;
}

/** The list items the selection touches, outermost-last, in document order. */
function touchedItems(doc: MdvDocument, selection: Selection): readonly NodeId[] {
  const seen = new Set<NodeId>();
  const out: NodeId[] = [];
  for (const block of touchedBlocks(doc, selection)) {
    const item = enclosingListItem(doc, block.id);
    if (!item || seen.has(item.itemId)) continue;
    seen.add(item.itemId);
    out.push(item.itemId);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Split                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Split the block at the caret — the Enter key.
 *
 * - In a paragraph or heading: two blocks, the tail carrying the text after the
 *   caret. A split heading yields a heading and a *paragraph*, because nobody
 *   means to create a second heading by pressing Enter at its end.
 * - In a code block: a newline, because a code block's content is one string.
 * - At the end of an empty list item: outdent instead, which is how every
 *   editor lets you leave a list.
 * - In a table cell: nothing. Enter has no meaning there; bind it to
 *   {@link insertRowBelow} or cell navigation in the UI.
 */
export function splitBlock(): Command {
  return (state, ctx) => {
    const builder = new MappingBuilder(state.doc);
    let doc = state.doc;
    let selection = state.selection;

    const cleared = deleteSelection(doc, selection, builder);
    if (cleared) {
      doc = cleared.doc;
      selection = cleared.selection;
    }
    if (selection.kind !== 'text') return null;

    const at = selection.anchor;
    const location = findBlock(doc, at.blockId);
    if (!location) return null;
    const block = location.block;

    if (block.kind === 'table') return null;

    if (block.kind === 'code') {
      const container = requireContainer(doc, at);
      const abs = toAbsolute(container, at);
      const text = runsText(container.runs);
      const next = `${text.slice(0, abs)}\n${text.slice(abs)}`;
      builder.splice(addressOf(at), abs, abs, 1);
      const written = writeContainer(doc, container, [
        { kind: 'text', id: `${block.id}:text`, text: next, marks: [] },
      ]);
      const after = resolveContainer(written, at);
      const caretPoint = after ? fromAbsolute(after, abs + 1) : at;
      return {
        state: { doc: written, selection: caret(caretPoint), pendingMarks: null },
        label: 'split',
        mapPoint: builder.build(written),
      };
    }

    if (!isRunBlock(block)) return null;

    const container = requireContainer(doc, at);
    const abs = toAbsolute(container, at);
    const total = runsLength(container.runs);
    const head = sliceRuns(container.runs, 0, abs);
    // Fresh ids for the tail: `sliceRuns` keeps the ids it was given, and the
    // head keeps them too, so without this a split would leave two runs sharing
    // an id — which breaks every id-keyed lookup and every UI list key.
    const tail = reassignIds(sliceRuns(container.runs, abs, total), ctx.ids);

    const item = enclosingListItem(doc, block.id);
    if (item) {
      const found = findListItem(doc, item.itemId);
      const isLastBlock = found
        ? found.item.blocks[found.item.blocks.length - 1]?.id === block.id
        : false;
      const itemIsEmpty =
        found?.item.blocks.length === 1 && isRunBlock(block) && runsLength(block.runs) === 0;
      if (itemIsEmpty && isLastBlock) {
        const lifted = outdentItem(doc, ctx, item.itemId);
        if (lifted) {
          const target = findBlock(lifted, block.id)?.block;
          const point = target ? startOfBlock(target) : undefined;
          return {
            state: {
              doc: lifted,
              selection: point ? caret(point) : selection,
              pendingMarks: null,
            },
            label: 'outdent',
            mapPoint: builder.build(lifted),
          };
        }
      }
      if (isLastBlock && found) {
        const tailBlock = makeParagraph(ctx.ids, tail);
        // Order matters: the move must be recorded first, so a point inside
        // the tail is re-targeted before the splice that truncates the source
        // would have collapsed it onto the split boundary.
        builder.move(addressOf(at), abs, { blockId: tailBlock.id, path: [] }, 0);
        builder.splice(addressOf(at), abs, total, 0);
        let next = writeContainer(doc, container, head);
        const newItem = makeItem(ctx.ids, [tailBlock], found.item.checked === null ? null : false);
        next = insertListItemAfter(next, found.list.id, item.itemId, newItem);
        const point = startOfBlock(tailBlock);
        return {
          state: { doc: next, selection: point ? caret(point) : selection, pendingMarks: null },
          label: 'split',
          mapPoint: builder.build(next),
        };
      }
    }

    const tailBlock =
      block.kind === 'heading' && abs >= total
        ? makeParagraph(ctx.ids, tail)
        : block.kind === 'heading'
          ? { ...block, id: ctx.ids(), runs: normalizeRuns(tail) }
          : makeParagraph(ctx.ids, tail);

    builder.move(addressOf(at), abs, { blockId: tailBlock.id, path: [] }, 0);
    builder.splice(addressOf(at), abs, total, 0);

    let next = writeContainer(doc, container, head);
    next = insertBlocks(next, location.parent, location.index + 1, [tailBlock]);
    const point = startOfBlock(tailBlock);
    return {
      state: { doc: next, selection: point ? caret(point) : selection, pendingMarks: null },
      label: 'split',
      mapPoint: builder.build(next),
    };
  };
}

function insertListItemAfter(
  doc: MdvDocument,
  listId: NodeId,
  afterItemId: NodeId,
  item: ListItem,
): MdvDocument {
  const location = findBlock(doc, listId);
  if (location?.block.kind !== 'list') {
    throw new EngineError('EDIT_NODE_NOT_FOUND', 'list not found', { listId });
  }
  const list = location.block;
  const index = list.items.findIndex((candidate) => candidate.id === afterItemId);
  const at = index < 0 ? list.items.length : index + 1;
  const items = [...list.items.slice(0, at), item, ...list.items.slice(at)];
  return replaceBlockWith(doc, listId, [{ ...list, items } as ListBlock]);
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                       */
/* -------------------------------------------------------------------------- */

/** The leaf block before `blockId` in document order, if any. */
export function previousLeaf(doc: MdvDocument, blockId: NodeId): Block | undefined {
  const list = allBlocks(doc).filter(
    (location) => location.block.kind !== 'list' && location.block.kind !== 'blockquote',
  );
  const index = list.findIndex((location) => location.block.id === blockId);
  return index > 0 ? list[index - 1]?.block : undefined;
}

/** The leaf block after `blockId` in document order, if any. */
export function nextLeaf(doc: MdvDocument, blockId: NodeId): Block | undefined {
  const list = allBlocks(doc).filter(
    (location) => location.block.kind !== 'list' && location.block.kind !== 'blockquote',
  );
  const index = list.findIndex((location) => location.block.id === blockId);
  return index >= 0 ? list[index + 1]?.block : undefined;
}

/**
 * Append `source`'s inline content to `target` and delete `source`.
 *
 * Returns `undefined` when the two cannot be merged (either is a table, an
 * image, a visual block or a raw passthrough).
 */
export function mergeBlocks(
  doc: MdvDocument,
  targetId: NodeId,
  sourceId: NodeId,
  builder: MappingBuilder,
): { readonly doc: MdvDocument; readonly caret: Point } | undefined {
  const target = findBlock(doc, targetId)?.block;
  const source = findBlock(doc, sourceId)?.block;
  if (!target || !source) return undefined;
  if (!isMergeable(target) || !isMergeable(source)) return undefined;

  const targetContainer = resolveContainer(doc, { blockId: targetId, path: [0], offset: 0 });
  const sourceContainer = resolveContainer(doc, { blockId: sourceId, path: [0], offset: 0 });
  if (!targetContainer || !sourceContainer) return undefined;

  const boundary = runsLength(targetContainer.runs);
  builder.move({ blockId: sourceId, path: [] }, 0, { blockId: targetId, path: [] }, boundary);
  builder.drop(sourceId);

  let next = writeContainer(doc, targetContainer, [
    ...targetContainer.runs,
    ...sourceContainer.runs,
  ]);
  next = replaceBlockWith(next, sourceId, []);
  next = pruneEmptyContainers(next);

  const after = resolveContainer(next, { blockId: targetId, path: [0], offset: 0 });
  return {
    doc: next,
    caret: after ? fromAbsolute(after, boundary) : { blockId: targetId, path: [0], offset: 0 },
  };
}

/**
 * Merge the caret's block into the one before it — Backspace at a block start.
 *
 * When the previous block is atomic the merge is refused and the block is
 * *selected* instead, so the next Backspace deletes it. Deleting an image
 * because the caret happened to be after it is the kind of surprise this
 * engine avoids.
 */
export function mergeBackward(): Command {
  return (state, ctx) => {
    if (state.selection.kind !== 'text') return null;
    const at = state.selection.anchor;
    const block = findBlock(state.doc, at.blockId)?.block;
    if (!block) return null;

    const item = enclosingListItem(state.doc, block.id);
    if (item) {
      const found = findListItem(state.doc, item.itemId);
      if (found && found.item.blocks[0]?.id === block.id) {
        const lifted = outdentItem(state.doc, ctx, item.itemId);
        if (lifted) {
          const target = findBlock(lifted, block.id)?.block;
          const point = target ? startOfBlock(target) : undefined;
          return {
            state: {
              doc: lifted,
              selection: point ? caret(point) : state.selection,
              pendingMarks: null,
            },
            label: 'outdent',
          };
        }
      }
    }

    const quote = quoteParentOf(state.doc, block.id);
    if (quote && siblingsOf(state.doc, { kind: 'blockquote', id: quote })[0]?.id === block.id) {
      const lifted = unwrapQuote(state.doc, quote);
      const target = findBlock(lifted, block.id)?.block;
      const point = target ? startOfBlock(target) : undefined;
      return {
        state: {
          doc: lifted,
          selection: point ? caret(point) : state.selection,
          pendingMarks: null,
        },
        label: 'block type',
      };
    }

    const previous = previousLeaf(state.doc, block.id);
    if (!previous) {
      if (block.kind === 'heading' || block.kind === 'code') {
        return setBlockType({ kind: 'paragraph' })(state, ctx);
      }
      return null;
    }
    if (isAtomicBlock(previous)) {
      return {
        state: {
          doc: state.doc,
          selection: { kind: 'node', blockId: previous.id },
          pendingMarks: null,
        },
        label: 'delete',
      };
    }

    const builder = new MappingBuilder(state.doc);
    const merged = mergeBlocks(state.doc, previous.id, block.id, builder);
    if (!merged) return null;
    return {
      state: { doc: merged.doc, selection: caret(merged.caret), pendingMarks: null },
      label: 'merge',
      mapPoint: builder.build(merged.doc),
    };
  };
}

/** Merge the block after the caret into the caret's block — Delete at a block end. */
export function mergeForward(): Command {
  return (state) => {
    if (state.selection.kind !== 'text') return null;
    const at = state.selection.anchor;
    const block = findBlock(state.doc, at.blockId)?.block;
    if (!block) return null;
    const next = nextLeaf(state.doc, block.id);
    if (!next) return null;
    if (isAtomicBlock(next)) {
      return {
        state: {
          doc: state.doc,
          selection: { kind: 'node', blockId: next.id },
          pendingMarks: null,
        },
        label: 'delete',
      };
    }
    const builder = new MappingBuilder(state.doc);
    const merged = mergeBlocks(state.doc, block.id, next.id, builder);
    if (!merged) return null;
    return {
      state: { doc: merged.doc, selection: caret(merged.caret), pendingMarks: null },
      label: 'merge',
      mapPoint: builder.build(merged.doc),
    };
  };
}

function quoteParentOf(doc: MdvDocument, blockId: NodeId): NodeId | undefined {
  const parent = findBlock(doc, blockId)?.parent;
  return parent?.kind === 'blockquote' ? parent.id : undefined;
}

function unwrapQuote(doc: MdvDocument, quoteId: NodeId): MdvDocument {
  const location = findBlock(doc, quoteId);
  if (location?.block.kind !== 'blockquote') return doc;
  return replaceBlockWith(doc, quoteId, location.block.children);
}

/* -------------------------------------------------------------------------- */
/* Block type                                                                  */
/* -------------------------------------------------------------------------- */

/** What {@link setBlockType} can turn a block into. */
export type BlockTypeSpec =
  | { readonly kind: 'paragraph' }
  | { readonly kind: 'heading'; readonly level: HeadingLevel }
  | { readonly kind: 'code'; readonly info?: string }
  | { readonly kind: 'quote' }
  | { readonly kind: 'bulletList'; readonly bullet?: '-' | '*' | '+' }
  | { readonly kind: 'orderedList'; readonly start?: number; readonly delimiter?: '.' | ')' };

/**
 * Retype every block the selection touches.
 *
 * `quote` and the two list kinds **toggle**: applying "bullet list" to a
 * paragraph wraps it, applying it again to the resulting item unwraps it, and
 * applying "ordered list" to a bullet item converts the list in place. This is
 * what a toolbar button means by "list".
 */
export function setBlockType(spec: BlockTypeSpec): Command {
  return (state, ctx) => {
    const targets = touchedBlocks(state.doc, state.selection);
    if (targets.length === 0) return null;

    if (spec.kind === 'quote') return toggleQuote(state, ctx, targets);
    if (spec.kind === 'bulletList' || spec.kind === 'orderedList') {
      return toggleList(state, ctx, targets, spec);
    }

    let doc = state.doc;
    let changed = false;
    for (const block of targets) {
      const replacement = retype(block, spec, ctx.ids);
      if (!replacement || (replacement.length === 1 && replacement[0] === block)) continue;
      doc = replaceBlockWith(doc, block.id, replacement);
      changed = true;
    }
    if (!changed) return null;
    return {
      state: { doc, selection: state.selection, pendingMarks: null },
      label: 'block type',
    };
  };
}

/** Convert one block. Returns `undefined` when the conversion is meaningless. */
function retype(block: Block, spec: BlockTypeSpec, ids: IdFactory): readonly Block[] | undefined {
  const runsOf = (): readonly Run[] => {
    if (isRunBlock(block)) return block.runs;
    if (block.kind === 'code')
      return block.text === '' ? [] : [{ kind: 'text', id: ids(), text: block.text, marks: [] }];
    return [];
  };

  if (spec.kind === 'paragraph') {
    if (block.kind === 'paragraph') return [block];
    if (block.kind === 'heading') return [{ kind: 'paragraph', id: block.id, runs: block.runs }];
    if (block.kind === 'code') {
      // One paragraph per line: a paragraph cannot hold a hard newline.
      const lines = block.text.split('\n');
      const kept = lines.length > 1 && lines[lines.length - 1] === '' ? lines.slice(0, -1) : lines;
      return kept.map((line, index) => ({
        kind: 'paragraph',
        id: index === 0 ? block.id : ids(),
        runs: line === '' ? [] : [{ kind: 'text', id: ids(), text: line, marks: [] } as const],
      }));
    }
    return undefined;
  }

  if (spec.kind === 'heading') {
    if (block.kind === 'heading' && block.level === spec.level) return [block];
    if (block.kind === 'paragraph' || block.kind === 'heading' || block.kind === 'code') {
      return [
        {
          kind: 'heading',
          id: block.id,
          level: spec.level,
          style: 'atx',
          runs: normalizeRuns(runsOf()),
        },
      ];
    }
    return undefined;
  }

  // `quote` and the list kinds are container conversions and never reach here;
  // `setBlockType` routes them to `toggleQuote` and `toggleList` instead.
  if (spec.kind !== 'code') return undefined;

  if (block.kind === 'code') {
    return spec.info === undefined || spec.info === block.info
      ? [block]
      : [{ ...block, info: spec.info }];
  }
  if (block.kind === 'paragraph' || block.kind === 'heading') {
    return [
      {
        kind: 'code',
        id: block.id,
        info: spec.info ?? '',
        text: runsText(block.runs),
        fence: { style: 'backtick', length: 3 },
      },
    ];
  }
  return undefined;
}

function toggleQuote(
  state: EditorState,
  ctx: EditContext,
  targets: readonly Block[],
): CommandResult | null {
  const doc = state.doc;
  const first = targets[0];
  if (!first) return null;
  const parents = targets.map((block) => findBlock(doc, block.id)?.parent);
  const quoteIds = new Set(
    parents.map((parent) => (parent?.kind === 'blockquote' ? parent.id : undefined)),
  );
  if (quoteIds.size === 1 && !quoteIds.has(undefined)) {
    const [quoteId] = [...quoteIds];
    if (quoteId !== undefined) {
      return {
        state: { doc: unwrapQuote(doc, quoteId), selection: state.selection, pendingMarks: null },
        label: 'block type',
      };
    }
  }
  const wrapped = wrapContiguous(doc, targets, (children, ids) => makeQuote(ids, children), ctx);
  if (!wrapped) return null;
  return {
    state: { doc: wrapped, selection: state.selection, pendingMarks: null },
    label: 'block type',
  };
}

function toggleList(
  state: EditorState,
  ctx: EditContext,
  targets: readonly Block[],
  spec: Extract<BlockTypeSpec, { kind: 'bulletList' | 'orderedList' }>,
): CommandResult | null {
  const doc = state.doc;
  const wantOrdered = spec.kind === 'orderedList';
  const items = targets.map((block) => enclosingListItem(doc, block.id));
  const listIds = new Set(items.map((item) => item?.listId));

  if (listIds.size === 1 && !listIds.has(undefined)) {
    const [listId] = [...listIds];
    const list = listId === undefined ? undefined : findBlock(doc, listId)?.block;
    if (list?.kind === 'list') {
      if (list.ordered === wantOrdered) {
        // Same kind: unwrap, flattening every item's blocks in order.
        const flattened = list.items.flatMap((item) => item.blocks);
        return {
          state: {
            doc: replaceBlockWith(doc, list.id, flattened),
            selection: state.selection,
            pendingMarks: null,
          },
          label: 'block type',
        };
      }
      const converted: ListBlock = wantOrdered
        ? {
            kind: 'list',
            id: list.id,
            ordered: true,
            start: spec.kind === 'orderedList' ? (spec.start ?? 1) : 1,
            delimiter: spec.kind === 'orderedList' ? (spec.delimiter ?? '.') : '.',
            tight: list.tight,
            items: list.items,
          }
        : {
            kind: 'list',
            id: list.id,
            ordered: false,
            bullet: spec.kind === 'bulletList' ? (spec.bullet ?? '-') : '-',
            tight: list.tight,
            items: list.items,
          };
      return {
        state: {
          doc: replaceBlockWith(doc, list.id, [converted]),
          selection: state.selection,
          pendingMarks: null,
        },
        label: 'block type',
      };
    }
  }

  const wrapped = wrapContiguous(
    doc,
    targets,
    (children, ids) => {
      const listItems = children.map((child) => makeItem(ids, [child]));
      return wantOrdered
        ? orderedList(ids, listItems, {
            start: spec.kind === 'orderedList' ? (spec.start ?? 1) : 1,
            delimiter: spec.kind === 'orderedList' ? (spec.delimiter ?? '.') : '.',
          })
        : bulletList(ids, listItems, {
            bullet: spec.kind === 'bulletList' ? (spec.bullet ?? '-') : '-',
          });
    },
    ctx,
  );
  if (!wrapped) return null;
  return {
    state: { doc: wrapped, selection: state.selection, pendingMarks: null },
    label: 'block type',
  };
}

/**
 * Wrap the contiguous run of `targets` that share a parent in a new container.
 * Blocks in other parents are wrapped separately, which is the only sane answer
 * for a selection that starts in a quote and ends outside it.
 */
function wrapContiguous(
  doc: MdvDocument,
  targets: readonly Block[],
  build: (children: readonly Block[], ids: IdFactory) => Block,
  ctx: EditContext,
): MdvDocument | null {
  const ids = ctx.ids;
  const groups = new Map<string, { parent: ParentRef; ids: NodeId[] }>();
  for (const block of targets) {
    const location = findBlock(doc, block.id);
    if (!location) continue;
    const key = parentKey(location.parent);
    const group = groups.get(key) ?? { parent: location.parent, ids: [] };
    group.ids.push(block.id);
    groups.set(key, group);
  }
  let next = doc;
  let changed = false;
  for (const group of groups.values()) {
    const siblings = siblingsOf(next, group.parent);
    const indices = group.ids
      .map((id) => siblings.findIndex((block) => block.id === id))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b);
    const first = indices[0];
    const last = indices[indices.length - 1];
    if (first === undefined || last === undefined) continue;
    const wrapped = build(siblings.slice(first, last + 1), ids);
    next = withSiblings(next, group.parent, [
      ...siblings.slice(0, first),
      wrapped,
      ...siblings.slice(last + 1),
    ]);
    changed = true;
  }
  return changed ? next : null;
}

function parentKey(parent: ParentRef): string {
  if (parent.kind === 'document') return 'document';
  if (parent.kind === 'blockquote') return `quote:${parent.id}`;
  return `item:${parent.listId}:${parent.itemId}`;
}

/* -------------------------------------------------------------------------- */
/* Indent and outdent                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Indent every touched list item by one level.
 *
 * An item becomes the last child of the item above it, reusing that item's
 * trailing sublist when it has one, so pressing Tab twice on two adjacent items
 * produces one sublist with two items rather than two sublists.
 */
export function indent(): Command {
  return (state, ctx) => {
    const items = touchedItems(state.doc, state.selection);
    if (items.length === 0) return null;
    let doc = state.doc;
    let changed = false;
    for (const itemId of items) {
      const next = indentItem(doc, ctx, itemId);
      if (next) {
        doc = next;
        changed = true;
      }
    }
    if (!changed) return null;
    return { state: { doc, selection: state.selection, pendingMarks: null }, label: 'indent' };
  };
}

/** Outdent every touched list item by one level, innermost first. */
export function outdent(): Command {
  return (state, ctx) => {
    const items = [...touchedItems(state.doc, state.selection)].reverse();
    if (items.length === 0) return null;
    let doc = state.doc;
    let changed = false;
    for (const itemId of items) {
      const next = outdentItem(doc, ctx, itemId);
      if (next) {
        doc = next;
        changed = true;
      }
    }
    if (!changed) return null;
    return { state: { doc, selection: state.selection, pendingMarks: null }, label: 'outdent' };
  };
}

/** Move one item under its previous sibling. Returns `undefined` if it is first. */
export function indentItem(
  doc: MdvDocument,
  ctx: EditContext,
  itemId: NodeId,
): MdvDocument | undefined {
  const found = findListItem(doc, itemId);
  if (!found || found.index === 0) return undefined;
  const previous = found.list.items[found.index - 1];
  if (!previous) return undefined;

  const last = previous.blocks[previous.blocks.length - 1];
  const sameKind =
    last?.kind === 'list' && last.ordered === found.list.ordered ? (last as ListBlock) : undefined;

  const nested: ListBlock = sameKind
    ? ({ ...sameKind, items: [...sameKind.items, found.item] } as ListBlock)
    : found.list.ordered
      ? orderedList(ctx.ids, [found.item], {
          start: 1,
          delimiter: found.list.delimiter,
          tight: found.list.tight,
        })
      : bulletList(ctx.ids, [found.item], { bullet: found.list.bullet, tight: found.list.tight });

  const blocks = sameKind
    ? [...previous.blocks.slice(0, -1), nested]
    : [...previous.blocks, nested];

  const items = found.list.items
    .map((item, index) => (index === found.index - 1 ? { ...item, blocks } : item))
    .filter((_item, index) => index !== found.index);

  return replaceBlockWith(doc, found.list.id, [{ ...found.list, items } as ListBlock]);
}

/**
 * Move one item out one level.
 *
 * A nested item becomes the next sibling of the item that contained it; a
 * top-level item loses its bullet, its blocks landing where the list was. Items
 * *after* the outdented one stay with it as a sublist, which is the standard
 * behaviour and the only one that preserves reading order.
 */
export function outdentItem(
  doc: MdvDocument,
  ctx: EditContext,
  itemId: NodeId,
): MdvDocument | undefined {
  const found = findListItem(doc, itemId);
  if (!found) return undefined;
  const listLocation = findBlock(doc, found.list.id);
  if (!listLocation) return undefined;

  const trailing = found.list.items.slice(found.index + 1);
  const remaining = found.list.items.slice(0, found.index);

  let carried = found.item.blocks;
  if (trailing.length > 0) {
    const sublist: ListBlock = found.list.ordered
      ? ({ ...found.list, id: ctx.ids(), items: trailing } as ListBlock)
      : ({ ...found.list, id: ctx.ids(), items: trailing } as ListBlock);
    carried = [...carried, sublist];
  }

  const parent = listLocation.parent;

  if (parent.kind === 'listItem') {
    const outerFound = findListItem(doc, parent.itemId);
    if (!outerFound) return undefined;
    // Replace the inner list inside the outer item with just the remaining items.
    const innerBlocks = outerFound.item.blocks
      .map((block) =>
        block.id === found.list.id
          ? remaining.length > 0
            ? ({ ...found.list, items: remaining } as ListBlock)
            : undefined
          : block,
      )
      .filter((block): block is Block => block !== undefined);
    const promoted = { ...found.item, blocks: carried };
    const outerItems = outerFound.list.items.flatMap((item) => {
      if (item.id !== parent.itemId) return [item];
      return [{ ...item, blocks: innerBlocks }, promoted];
    });
    return replaceBlockWith(doc, outerFound.list.id, [
      { ...outerFound.list, items: outerItems } as ListBlock,
    ]);
  }

  // Top level (or directly inside a quote): the item stops being a list item.
  const siblings = siblingsOf(doc, parent);
  const listIndex = siblings.findIndex((block) => block.id === found.list.id);
  if (listIndex < 0) return undefined;
  const before = remaining.length > 0 ? [{ ...found.list, items: remaining } as ListBlock] : [];
  const next = [
    ...siblings.slice(0, listIndex),
    ...before,
    ...carried,
    ...siblings.slice(listIndex + 1),
  ];
  return withSiblings(doc, parent, next);
}

/* -------------------------------------------------------------------------- */
/* Whole-block selection helpers                                               */
/* -------------------------------------------------------------------------- */

/** Select an atomic block as a node — what clicking an image should do. */
export function selectBlock(blockId: NodeId): Command {
  return (state) => {
    const location = findBlock(state.doc, blockId);
    if (!location) return null;
    const selection: Selection = isAtomicBlock(location.block)
      ? { kind: 'node', blockId }
      : (() => {
          const from = startOfBlock(location.block);
          const to = endOfBlock(location.block);
          return from && to
            ? { kind: 'text' as const, anchor: from, focus: to }
            : { kind: 'node' as const, blockId };
        })();
    return { state: { ...state, selection, pendingMarks: null }, label: 'replace' };
  };
}

/** Delete the blocks the selection touches outright, bullets and all. */
export function deleteBlocks(): Command {
  return (state, ctx) => {
    const targets = touchedBlocks(state.doc, state.selection);
    if (targets.length === 0) return null;
    const builder = new MappingBuilder(state.doc);
    let doc = state.doc;
    for (const block of targets) {
      if (!findBlock(doc, block.id)) continue;
      builder.drop(block.id);
      doc = replaceBlockWith(doc, block.id, []);
    }
    doc = pruneEmptyContainers(doc);
    if (doc.blocks.length === 0) doc = { ...doc, blocks: [makeParagraph(ctx.ids)] };
    const first = doc.blocks[0];
    const at = first ? startOfBlock(first) : undefined;
    return {
      state: {
        doc,
        selection: at ? caret(at) : state.selection,
        pendingMarks: null,
      },
      label: 'delete',
      mapPoint: builder.build(doc),
    };
  };
}

/** Exposed for tests: the container path of a point, as a comparable string. */
export function pathKey(at: Point): string {
  return containerPath(at).join('.');
}

/** Compare two points; re-exported so command modules need one import. */
export { comparePoints, ROOT };

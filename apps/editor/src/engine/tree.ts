/**
 * Tree navigation and structural sharing.
 *
 * Blocks are addressed by **id**, not by index path. Ids are stable across
 * edits, index paths are not, and an editor spends most of its time answering
 * "where is the block the caret is in, now that three edits have landed".
 * Lookups are linear in document size; documents are small and the constant is
 * a plain array walk, so this is not the bottleneck it looks like.
 *
 * Every mutator returns a new document that shares every untouched subtree.
 */

import { EngineError } from './errors.js';
import type { NodeId } from './ids.js';
import type { Block, ListBlock, ListItem, MdvDocument } from './model.js';
import { isContainerBlock } from './model.js';

/** Identifies the block list that owns a block. */
export type ParentRef =
  | { readonly kind: 'document' }
  | { readonly kind: 'blockquote'; readonly id: NodeId }
  | { readonly kind: 'listItem'; readonly listId: NodeId; readonly itemId: NodeId };

/** The document's top-level block list. */
export const ROOT: ParentRef = { kind: 'document' };

/** Where a block sits. */
export interface BlockLocation {
  readonly block: Block;
  readonly parent: ParentRef;
  /** Index within the owning block list. */
  readonly index: number;
}

/** True when two parent references denote the same block list. */
export function sameParent(a: ParentRef, b: ParentRef): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'document') return true;
  if (a.kind === 'blockquote' && b.kind === 'blockquote') return a.id === b.id;
  if (a.kind === 'listItem' && b.kind === 'listItem') {
    return a.listId === b.listId && a.itemId === b.itemId;
  }
  return false;
}

function childListsOf(block: Block): readonly { parent: ParentRef; blocks: readonly Block[] }[] {
  if (block.kind === 'blockquote') {
    return [{ parent: { kind: 'blockquote', id: block.id }, blocks: block.children }];
  }
  if (block.kind === 'list') {
    return block.items.map((item) => ({
      parent: { kind: 'listItem', listId: block.id, itemId: item.id } as const,
      blocks: item.blocks,
    }));
  }
  return [];
}

/**
 * Visit every block in document order (pre-order: a container is yielded before
 * its children). Return `false` from `visit` to stop the walk.
 */
export function walkBlocks(
  doc: MdvDocument,
  visit: (location: BlockLocation) => boolean | void,
): void {
  let stopped = false;
  const walk = (blocks: readonly Block[], parent: ParentRef): void => {
    for (let index = 0; index < blocks.length && !stopped; index += 1) {
      const block = blocks[index];
      if (!block) continue;
      if (visit({ block, parent, index }) === false) {
        stopped = true;
        return;
      }
      for (const child of childListsOf(block)) {
        if (stopped) return;
        walk(child.blocks, child.parent);
      }
    }
  };
  walk(doc.blocks, ROOT);
}

/** Locate a block by id. */
export function findBlock(doc: MdvDocument, id: NodeId): BlockLocation | undefined {
  let found: BlockLocation | undefined;
  walkBlocks(doc, (location) => {
    if (location.block.id === id) {
      found = location;
      return false;
    }
    return true;
  });
  return found;
}

/** Locate a block by id, or raise `EDIT_NODE_NOT_FOUND`. */
export function requireBlock(doc: MdvDocument, id: NodeId): BlockLocation {
  const location = findBlock(doc, id);
  if (!location) {
    throw new EngineError('EDIT_NODE_NOT_FOUND', `no block with id ${id}`, { id });
  }
  return location;
}

/** Every block in document order. */
export function allBlocks(doc: MdvDocument): readonly BlockLocation[] {
  const out: BlockLocation[] = [];
  walkBlocks(doc, (location) => {
    out.push(location);
  });
  return out;
}

/**
 * Caret-addressable blocks in document order.
 *
 * Containers (lists, block quotes) are skipped: the caret lives in their leaves.
 * This is the sequence arrow-key navigation and `deleteBackward` at a block
 * start walk.
 */
export function leafBlocks(doc: MdvDocument): readonly BlockLocation[] {
  return allBlocks(doc).filter((location) => !isContainerBlock(location.block));
}

/** Read the block list owned by `parent`. */
export function siblingsOf(doc: MdvDocument, parent: ParentRef): readonly Block[] {
  if (parent.kind === 'document') return doc.blocks;
  const location = findBlock(doc, parent.kind === 'blockquote' ? parent.id : parent.listId);
  if (!location) return [];
  const block = location.block;
  if (parent.kind === 'blockquote') {
    return block.kind === 'blockquote' ? block.children : [];
  }
  if (block.kind !== 'list') return [];
  return block.items.find((item) => item.id === parent.itemId)?.blocks ?? [];
}

function mapBlockChildren(
  block: Block,
  map: (blocks: readonly Block[]) => readonly Block[],
): Block {
  if (block.kind === 'blockquote') {
    const children = map(block.children);
    return children === block.children ? block : { ...block, children };
  }
  if (block.kind === 'list') {
    let changed = false;
    const items = block.items.map((item) => {
      const blocks = map(item.blocks);
      if (blocks === item.blocks) return item;
      changed = true;
      return { ...item, blocks };
    });
    return changed ? ({ ...block, items } as ListBlock) : block;
  }
  return block;
}

/**
 * Replace the block list owned by `parent`.
 *
 * Empty list items and empty block quotes are *not* pruned here; the command
 * layer decides when an empty container should disappear, because that is an
 * editing policy, not a structural rule.
 */
export function withSiblings(
  doc: MdvDocument,
  parent: ParentRef,
  blocks: readonly Block[],
): MdvDocument {
  if (parent.kind === 'document') {
    return blocks === doc.blocks ? doc : { ...doc, blocks };
  }
  const targetId = parent.kind === 'blockquote' ? parent.id : parent.listId;
  let applied = false;

  const rewrite = (list: readonly Block[]): readonly Block[] => {
    let changed = false;
    const out = list.map((block) => {
      if (block.id === targetId) {
        if (parent.kind === 'blockquote' && block.kind === 'blockquote') {
          applied = true;
          changed = true;
          return { ...block, children: blocks };
        }
        if (parent.kind === 'listItem' && block.kind === 'list') {
          let itemChanged = false;
          const items = block.items.map((item) => {
            if (item.id !== parent.itemId) return item;
            itemChanged = true;
            applied = true;
            return { ...item, blocks };
          });
          if (itemChanged) {
            changed = true;
            return { ...block, items } as ListBlock;
          }
          return block;
        }
      }
      const next = mapBlockChildren(block, rewrite);
      if (next !== block) changed = true;
      return next;
    });
    return changed ? out : list;
  };

  const next = rewrite(doc.blocks);
  if (!applied) {
    throw new EngineError('EDIT_NODE_NOT_FOUND', `no container for parent ${targetId}`, {
      parent,
    });
  }
  return next === doc.blocks ? doc : { ...doc, blocks: next };
}

/** Replace one block, in place, by id. */
export function replaceBlock(doc: MdvDocument, id: NodeId, block: Block): MdvDocument {
  return replaceBlockWith(doc, id, [block]);
}

/**
 * Replace one block with zero or more blocks. Removing a block is
 * `replaceBlockWith(doc, id, [])`.
 */
export function replaceBlockWith(
  doc: MdvDocument,
  id: NodeId,
  blocks: readonly Block[],
): MdvDocument {
  const location = requireBlock(doc, id);
  const siblings = siblingsOf(doc, location.parent);
  const next = [
    ...siblings.slice(0, location.index),
    ...blocks,
    ...siblings.slice(location.index + 1),
  ];
  return withSiblings(doc, location.parent, next);
}

/** Insert `blocks` into `parent` at `index`. */
export function insertBlocks(
  doc: MdvDocument,
  parent: ParentRef,
  index: number,
  blocks: readonly Block[],
): MdvDocument {
  const siblings = siblingsOf(doc, parent);
  const at = Math.max(0, Math.min(index, siblings.length));
  return withSiblings(doc, parent, [...siblings.slice(0, at), ...blocks, ...siblings.slice(at)]);
}

/** Apply `update` to a single block, by id. */
export function updateBlock(
  doc: MdvDocument,
  id: NodeId,
  update: (block: Block) => Block,
): MdvDocument {
  const location = requireBlock(doc, id);
  const next = update(location.block);
  return next === location.block ? doc : replaceBlock(doc, id, next);
}

/** Locate a list item by id, together with its owning list. */
export function findListItem(
  doc: MdvDocument,
  itemId: NodeId,
): { readonly list: ListBlock; readonly item: ListItem; readonly index: number } | undefined {
  let found: { list: ListBlock; item: ListItem; index: number } | undefined;
  walkBlocks(doc, (location) => {
    if (location.block.kind !== 'list') return true;
    const list = location.block;
    const index = list.items.findIndex((item) => item.id === itemId);
    if (index < 0) return true;
    const item = list.items[index];
    if (!item) return true;
    found = { list, item, index };
    return false;
  });
  return found;
}

/** The list item that (transitively) contains `blockId`, if any. */
export function enclosingListItem(
  doc: MdvDocument,
  blockId: NodeId,
): { readonly listId: NodeId; readonly itemId: NodeId } | undefined {
  let location = findBlock(doc, blockId);
  while (location) {
    const parent = location.parent;
    if (parent.kind === 'listItem') return { listId: parent.listId, itemId: parent.itemId };
    if (parent.kind === 'blockquote') {
      location = findBlock(doc, parent.id);
      continue;
    }
    return undefined;
  }
  return undefined;
}

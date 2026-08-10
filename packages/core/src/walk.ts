/**
 * Finding the blocks in a parsed document (SPEC 19).
 *
 * A `mdvBlock` can sit anywhere a leaf node can — inside a blockquote, a list
 * item, a footnote — so "every block in this document" is a tree walk, not a
 * filter over `doc.children`. It lives in its own module because both the data
 * resolver and the locators need it, and because a host that walks the tree
 * itself will eventually miss the nested case: this is the one walk.
 */

import type { MdvBlock, MdvDocument } from '@mdv/parser';

/** Every `mdvBlock` in the tree, in document order. */
export function visualBlocks(doc: MdvDocument): MdvBlock[] {
  const out: MdvBlock[] = [];
  const walk = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) continue;
      const typed = node as { type?: string; children?: readonly unknown[] };
      if (typed.type === 'mdvBlock') out.push(node as MdvBlock);
      if (Array.isArray(typed.children)) walk(typed.children);
    }
  };
  walk(doc.children);
  return out;
}

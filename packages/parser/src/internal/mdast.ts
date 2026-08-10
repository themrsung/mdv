/**
 * The CommonMark + GFM front end.
 *
 * Isolated in one module so that the rest of the parser never touches micromark
 * directly and every sub-parse goes through the same configuration — a sub-parse
 * that used different extensions than the main parse would produce positions and
 * node shapes that silently disagree with the rest of the tree.
 */

import type { Root } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { gfm } from 'micromark-extension-gfm';

const EXTENSIONS = [gfm()];
const MDAST_EXTENSIONS = [gfmFromMarkdown()];

/**
 * CommonMark 0.31.2 plus GFM tables, strikethrough, task lists, autolinks and
 * footnotes (SPEC 4).
 *
 * Front matter is *not* handled here: SPEC 3.4 allows `...` as a terminator,
 * which `micromark-extension-frontmatter` does not, so the parser strips front
 * matter itself and hands the remaining body over with a position mapping.
 */
export function runFromMarkdown(text: string): Root {
  return fromMarkdown(text, { extensions: EXTENSIONS, mdastExtensions: MDAST_EXTENSIONS });
}

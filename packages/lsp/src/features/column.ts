/**
 * Column names as a cursor sees them (SPEC 6.2, 6.7).
 *
 * The column half of what `dataset.ts` does for ids, and it exists for the same
 * reason: *which name is the cursor standing in*, and *which characters of the
 * document spell it*, have to be answered once and imported, because a feature
 * that hit-tested one way and edited another would offer an edit somewhere the
 * author never pointed.
 *
 * Nothing here decides where a column name may be written, or whether the block
 * owns the header at all: `locateColumns` publishes both, out of the module that
 * owns SPEC 6.7's lineage rules (SPEC 29.4).
 *
 * The difference from ids is the shape of a site's range. An id's range is the
 * value that carries it, and a cursor inside that value is a cursor on the id.
 * A header cell's range is the *whole data section*, so containment would put
 * every row of the table on the first column. The name's own span is resolved
 * first and the hit-test runs against that.
 */

import { locateColumns, visualBlocks } from '@mdv/core';
import type { ColumnLocation, ColumnMap, ColumnSite } from '@mdv/core';
import { parse } from '@mdv/parser';
import type { MdvBlock, MdvDocument } from '@mdv/parser';

import { toLspRange } from '../convert.js';
import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import type { Position, Range } from '../protocol/types.js';

/** The columns of the block a cursor is in, and the one it is standing on. */
export interface ColumnCursor {
  /**
   * `undefined` outside a block, and inside one whose columns this document
   * cannot move — rows read from elsewhere, or published under an `id:` for the
   * rest of the document to read.
   */
  readonly map: ColumnMap | undefined;
  /** `undefined` where the cursor is on text that names no column. */
  readonly column: ColumnLocation | undefined;
  /** The one use of {@link column} the cursor is in, of the many it has. */
  readonly site: ColumnSite | undefined;
}

const NOTHING: ColumnCursor = { map: undefined, column: undefined, site: undefined };

/**
 * Parse `document` and hit-test `position` against every column name the block
 * around it writes.
 *
 * A site whose name cannot be cut out of the text as written is skipped rather
 * than matched loosely, so a site this returns always has a span — which is
 * also why the block's own columns are searched and no neighbour's are: column
 * names are block-scoped (SPEC 29.4), and two blocks may spell one name for two
 * different things.
 */
export function columnsAt(
  document: TextDocument,
  position: Position,
  token: CancellationToken,
): ColumnCursor {
  throwIfCancelled(token);
  const offset = document.offsetAt(position);
  const block = blockAt(parse(document.text), offset);
  if (block === undefined) return NOTHING;

  const map = locateColumns(block);
  if (map === undefined) return NOTHING;

  for (const column of map.columns) {
    for (const site of column.sites) {
      const span = spanOf(document, site);
      if (span === undefined) continue;
      if (span.from <= offset && offset <= span.to) return { map, column, site };
    }
  }
  return { map, column: undefined, site: undefined };
}

/**
 * The name alone, rather than the attribute or the table row that carries it.
 *
 * `undefined` when the name cannot be found in the text as written, which for a
 * column means one of two things: a `rename:` step whose *key* is this name,
 * where the parser records a range for the value beside it and none for the key,
 * or a name a step produces that the document never spells (`bin`'s default
 * output). Both are places an edit would have to be invented, and inventing one
 * is how a rename half-applies.
 */
export function exactColumnRange(document: TextDocument, site: ColumnSite): Range | undefined {
  const span = spanOf(document, site);
  if (span === undefined) return undefined;
  return toLspRange(document, {
    start: { ...site.range.start, offset: span.from },
    end: { ...site.range.end, offset: span.to },
  });
}

/**
 * Where the name itself is written.
 *
 * The arithmetic `ColumnSite` documents: find `text` inside the source the range
 * spans, then count `offset` characters into it. The result is checked against
 * the name because this is the span a rename overwrites — an offset that landed
 * beside the name would still produce a plausible-looking edit, and the author
 * would find out by reading the diff.
 */
function spanOf(
  document: TextDocument,
  site: ColumnSite,
): { from: number; to: number } | undefined {
  const { start, end } = site.range;
  const written = document.text.slice(start.offset, end.offset);
  const shift = site.offset < 0 ? -1 : written.indexOf(site.text);
  if (shift === -1) return undefined;

  const from = start.offset + shift + site.offset;
  const to = from + site.name.length;
  if (document.text.slice(from, to) !== site.name) return undefined;
  return { from, to };
}

/**
 * The block the cursor is in.
 *
 * `visualBlocks` walks the whole tree, so a block nested in a list item or a
 * blockquote is found too, and blocks do not contain one another — the first
 * match is the only one.
 */
function blockAt(doc: MdvDocument, offset: number): MdvBlock | undefined {
  for (const block of visualBlocks(doc)) {
    const start = block.position?.start.offset;
    const end = block.position?.end.offset;
    if (start === undefined || end === undefined) continue;
    if (start <= offset && offset <= end) return block;
  }
  return undefined;
}

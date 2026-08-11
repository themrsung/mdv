/**
 * Dataset ids as a cursor sees them (SPEC 6.3).
 *
 * Go to definition, find references and rename all open with the same two
 * questions — *which id is the cursor standing in*, and *which characters of the
 * document spell it* — and they have to answer them identically. A rename that
 * hit-tested one way and edited another would offer to rename a position it then
 * changed somewhere else, so the arithmetic is written once here and imported,
 * never re-derived beside it.
 *
 * Nothing here decides where an id may be written: `locateDatasets` publishes
 * that, out of the same file the resolver routes with (SPEC 29.4).
 */

import { locateDatasets } from '@mdv/core';
import type { DatasetSite } from '@mdv/core';
import { parse } from '@mdv/parser';

import { toLspRange } from '../convert.js';
import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import type { Position, Range } from '../protocol/types.js';

/** Every dataset id a document writes, and the one a cursor is standing in. */
export interface DatasetCursor {
  /** In source order, which is the order a client renders a list of them in. */
  readonly sites: readonly DatasetSite[];
  /** `undefined` where the cursor is in prose, or on a key that holds no id. */
  readonly site: DatasetSite | undefined;
}

/** Parse `document` and hit-test `position` against every id it writes. */
export function datasetsAt(
  document: TextDocument,
  position: Position,
  token: CancellationToken,
): DatasetCursor {
  throwIfCancelled(token);
  const sites = locateDatasets(parse(document.text));
  return { sites, site: siteAt(sites, document.offsetAt(position)) };
}

/**
 * The site the cursor is in.
 *
 * Sites normally cover disjoint text, but a document the locator could not range
 * a front-matter key on falls back to the value, and then a declaration contains
 * the references written under it. The locator lists the wider site first, so the
 * *last* one containing the cursor is the most specific thing it is standing on.
 */
function siteAt(sites: readonly DatasetSite[], offset: number): DatasetSite | undefined {
  return last(
    sites,
    (site) => site.range.start.offset <= offset && offset <= site.range.end.offset,
  );
}

/** `Array.prototype.findLast`, which is a lib newer than this package targets. */
export function last(
  sites: readonly DatasetSite[],
  match: (site: DatasetSite) => boolean,
): DatasetSite | undefined {
  for (let index = sites.length - 1; index >= 0; index -= 1) {
    const site = sites[index] as DatasetSite;
    if (match(site)) return site;
  }
  return undefined;
}

/**
 * The id alone, rather than the value that carries it.
 *
 * A site's range covers the text as written — quotes, `@`, and any projection —
 * and highlighting all of that for `@sales[date, revenue]` would tell an author
 * the name of their dataset is twenty characters long. `text` and `offset` say
 * where the bare id sits inside the parsed value, and the value is the same
 * characters as the written one at a shift, which is found by looking for it.
 *
 * A value YAML rewrote rather than trimmed is not found and falls back to the
 * whole range: a range that is too wide is still a range that lands in the right
 * place, which is the point of the jump. Rename asks a stricter question and is
 * told about the same failure by {@link exactRange}.
 */
export function idRange(document: TextDocument, site: DatasetSite): Range {
  return exactRange(document, site) ?? toLspRange(document, site.range);
}

/**
 * {@link idRange}, but `undefined` rather than a fallback when the id could not
 * be found in the text as written.
 *
 * The fallback is right for a jump and wrong for an edit: replacing the whole of
 * `"@sales[date, revenue]"` with a bare new id would silently drop the quotes and
 * the projection. A rename that cannot see the id declines instead.
 */
export function exactRange(document: TextDocument, site: DatasetSite): Range | undefined {
  const { start, end } = site.range;
  const written = document.text.slice(start.offset, end.offset);
  const shift = site.offset < 0 ? -1 : written.indexOf(site.text);
  if (shift === -1) return undefined;

  const from = start.offset + shift + site.offset;
  return toLspRange(document, {
    start: { ...start, offset: from },
    end: { ...end, offset: from + site.id.length },
  });
}

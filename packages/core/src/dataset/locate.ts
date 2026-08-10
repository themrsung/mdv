/**
 * Where a document writes dataset ids (SPEC 6.3, 6.7).
 *
 * `expressionAt` in `../expr/locate.ts` answers the same question for
 * expressions; this is its counterpart for references. A tool that wants to
 * jump from `"@sales"` to the header that declared it needs two things no
 * editor can work out for itself: **which attribute keys carry a reference**,
 * and **where the id sits inside the value as it was written**. Both are this
 * package's business, because both are decided by `resolve.ts` — so both are
 * published here rather than re-derived by every host that asks.
 *
 * The keys are not guessable. `data:` is a reference on a visual block and raw
 * inline text in front matter; `from:` is dead on a block whose `data:` already
 * names a dataset; a `dataset` block declares through `id:` while front matter
 * declares through the key of the mapping. This module mirrors the routing in
 * `resolve.ts` exactly: if a site is listed here, the resolver reads it, and if
 * it is not, the resolver ignores it.
 */

import type { AttrMap, AttrRanges, AttrValue, MdvDocument, Range } from '@mdv/parser';
import { DATASET_BLOCK } from './declare.js';
import { isReference, parseReference } from './reference.js';
import { visualBlocks } from '../walk.js';

/** One place in a document where a dataset id is written. */
export interface DatasetSite {
  /** The id, without the `@` a reference wears. */
  readonly id: string;
  /**
   * Whether this site introduces the id or points at it. A front-matter alias
   * (`q1: "@sales"`) is one of each: the key declares `q1`, the value refers to
   * `sales`.
   */
  readonly kind: 'declaration' | 'reference';
  /**
   * The dotted attribute path this site was read from, as `attrsPosition` keys
   * it — `datasets.q1`, `datasets.q1.from`, `transform[0].join.with`, `data`,
   * `id`. Enough to say *why* a site is a site, in a diagnostic or a test.
   */
  readonly path: string;
  /**
   * The range of the text this site was read from, as written, quotes and all:
   * the value, or the key for a front-matter declaration, which is where that
   * id is actually spelled.
   */
  readonly range: Range;
  /** The text {@link range} covers, as parsed, which is what {@link offset} indexes into. */
  readonly text: string;
  /** Where the id starts inside {@link text}, or `-1` when it is not in it. */
  readonly offset: number;
}

/**
 * Every dataset id written in a document, in source order.
 *
 * Declarations come before the references written under them, and a block's
 * own reference comes before the ones in its pipeline. Sites normally cover
 * disjoint text — a front-matter declaration ranges the key, not the value
 * hanging off it — but a hand-built document carrying no key ranges falls back
 * to the value, and then a declaration does contain its references. A caller
 * hit-testing a cursor therefore wants the **last** containing site, which is
 * the narrowest under either shape.
 */
export function locateDatasets(doc: MdvDocument): readonly DatasetSite[] {
  const sites: DatasetSite[] = [];

  const front = doc.frontmatter;
  const declared = front?.datasets;
  if (front !== undefined && declared !== undefined) {
    for (const [id, value] of Object.entries(declared)) {
      const path = `datasets.${id}`;
      const range = front.attrsPosition[path];
      if (range === undefined) continue;

      // The key is the declaration wherever it appears; the value is a
      // reference only in the shorthand `q1: "@sales"` (SPEC 6.3). A key that
      // the parser could not range on its own — one written as a flow
      // collection, say — falls back to the value, so that the id is still
      // found even though nothing can point at where it is written.
      const keyRange = front.attrsKeyPosition[path];
      sites.push(
        keyRange === undefined
          ? { id, kind: 'declaration', path, range, text: '', offset: -1 }
          : { id, kind: 'declaration', path, range: keyRange, text: id, offset: 0 },
      );
      if (typeof value === 'string') pushReference(sites, value, range, path);
      else if (isMap(value)) pushPipeline(sites, value, front.attrsPosition, `${path}.`);
    }
  }

  for (const block of visualBlocks(doc)) {
    const attrs = block.attrs;
    const ranges = block.attrsPosition;

    if (block.blockType === DATASET_BLOCK) {
      const id = attrs['id'];
      const range = ranges['id'];
      // `id: costs` names the dataset outright: no `@`, no projection.
      if (typeof id === 'string' && range !== undefined) {
        sites.push({ id, kind: 'declaration', path: 'id', range, text: id, offset: 0 });
      }
      pushPipeline(sites, attrs, ranges, '');
      continue;
    }

    // A visual block reads `data:` first and stops there when it is a
    // reference, which leaves any `from:` beside it inert — so does this.
    const data = attrs['data'];
    if (typeof data === 'string' && isReference(data)) {
      pushReference(sites, data, ranges['data'], 'data');
    } else {
      pushPipeline(sites, attrs, ranges, '');
    }
  }

  return sites;
}

/** The reference-bearing keys of one header: `from:`, and every `join.with:`. */
function pushPipeline(
  sites: DatasetSite[],
  attrs: AttrMap,
  ranges: AttrRanges,
  prefix: string,
): void {
  pushReference(sites, attrs['from'], ranges[`${prefix}from`], `${prefix}from`);

  const pipeline = attrs['transform'];
  if (pipeline === undefined) return;
  // A lone step may be written unwrapped, and is pathed unwrapped too — the
  // pipeline reader is this tolerant, so the locator has to be (SPEC 14.1).
  const steps: readonly (readonly [string, AttrValue])[] = Array.isArray(pipeline)
    ? pipeline.map((step, index) => [`${prefix}transform[${index}]`, step] as const)
    : [[`${prefix}transform`, pipeline] as const];

  for (const [stepPath, step] of steps) {
    if (!isMap(step)) continue;
    const join = step['join'];
    if (!isMap(join)) continue;
    const path = `${stepPath}.join.with`;
    pushReference(sites, join['with'], ranges[path], path);
  }
}

/** Record a value that is written as a reference, and only if it is one. */
function pushReference(
  sites: DatasetSite[],
  value: AttrValue | undefined,
  range: Range | undefined,
  path: string,
): void {
  if (typeof value !== 'string' || range === undefined) return;
  const parsed = parseReference(value);
  if (parsed === undefined) return;
  sites.push({
    id: parsed.id,
    kind: 'reference',
    path,
    range,
    text: value,
    offset: value.indexOf('@') + 1,
  });
}

function isMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

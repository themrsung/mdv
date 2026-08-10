/**
 * The accessible tree (SPEC 12.1, 12.2, 12.3, 12.4).
 *
 * The tree is **part of the scene**, not a DOM afterthought, so the PDF exporter
 * emits the same descriptions as tagged content and a Canvas chart is never a
 * black box to a screen reader (SPEC 23.2).
 *
 * Name resolution is fixed by SPEC 12.1: `title` if present, else `desc`, else a
 * generated summary. The role is `figure` when the block has a caption and `img`
 * otherwise, which is the distinction a caption actually makes — a figure is a
 * captioned thing.
 */

import type { A11yTable, A11yTree, HitRegion } from '../types/scene.js';
import { focusOrderOf } from '../layout/hit.js';

/** Options for {@link buildA11yTree}. */
export interface A11yTreeOptions {
  /** `title:` from the block. */
  title?: string | undefined;
  /** `desc:` from the block, when the author wrote one. */
  desc?: string | undefined;
  /** A generated description, used when `desc` is absent (SPEC 12.2). */
  generated?: string | undefined;
  /** A caption makes the role `figure` (SPEC 12.1). */
  caption?: string | undefined;
  table: A11yTable;
  hits: readonly HitRegion[];
  /** BCP 47 tag, when the document's `lang` differs from the host. */
  lang?: string | undefined;
  /** Fallback name when there is no title, desc or generated summary. */
  fallbackName: string;
}

/**
 * Assemble the tree.
 *
 * The name is never empty: an unnamed `role="img"` is announced as "image",
 * which tells the reader nothing. When nothing better exists the caller's
 * `fallbackName` — typically "Bar chart" — is used, and the absence of a real
 * description is reported separately as `MDV3091`.
 */
export function buildA11yTree(options: A11yTreeOptions): A11yTree {
  const desc = pick(options.desc);
  const generated = pick(options.generated);
  const effectiveDesc = desc ?? generated;

  const name = pick(options.title) ?? effectiveDesc ?? options.fallbackName;

  const tree: A11yTree = {
    role: pick(options.caption) === undefined ? 'img' : 'figure',
    name,
    descGenerated: desc === undefined && generated !== undefined,
    table: options.table,
    focusOrder: focusOrderOf(options.hits),
  };
  // Set unconditionally when one exists, even where it also became the name: the
  // PDF `/Alt` text and `aria-describedby` both read this field, and an exporter
  // should not have to reconstruct it from the name.
  if (effectiveDesc !== undefined) tree.desc = effectiveDesc;
  if (options.lang !== undefined && options.lang !== '') tree.lang = options.lang;
  return tree;
}

/** `undefined` for absent-or-empty, so `''` never becomes an accessible name. */
function pick(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * `true` when the block has neither an authored nor a generated description.
 *
 * The caller emits `MDV3091` — a chart with no description is not merely
 * imperfect, it is unusable without sight (SPEC 12, "Normative").
 */
export function needsDescriptionDiagnostic(tree: A11yTree): boolean {
  return tree.desc === undefined || tree.desc.trim() === '';
}

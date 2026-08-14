/**
 * The numbering pre-pass — figure counters and anchors for the React walk
 * (SPEC 9.1, 9.2, 28.7).
 *
 * `:mdv-ref[fig-revenue]` prints "Figure 3", and it may point *forward*: the
 * reference is often in the sentence that introduces the figure. React renders
 * in document order and has nowhere to patch a node once it is returned, so the
 * counting happens here, once per document, before the first element is made.
 * The result is three lookup tables keyed by node identity, which is what makes
 * the walk itself stay a pure function of one node at a time.
 *
 * The rules — the slug, the disambiguation suffix, the label and which heading
 * restarts the counters — are `@mdv/core`'s, not this file's, precisely because
 * `render-pdf`'s flow builder uses the same four functions. What is duplicated
 * between the two is the *traversal*, which cannot be shared: one emits flow
 * items, the other React elements. So this file is written to mirror
 * `flow.ts` step for step, and `test/directives.test.tsx` asserts the two agree
 * on a document that exercises every counter:
 *
 * | construct              | counted here | counted in `flow.ts` |
 * | ---------------------- | ------------ | -------------------- |
 * | heading                | anchor + section restart | same       |
 * | `:::mdv-figure`        | always       | always               |
 * | block with a `caption` | always       | always               |
 * | GFM table              | never        | its own counter      |
 *
 * A GFM table is the one deliberate difference. The PDF prints "Table 4." above
 * each one because a paginated table needs a name a reader can say out loud; on
 * screen the table is right there in the flow and MDV puts no caption above it.
 * Keeping tables on a *separate* counter in the PDF is what makes that safe —
 * were they to share the figure counter, a document with tables would number its
 * figures differently in the two renderers.
 */

import { counterLabel, restartLevel, slugify, uniqueSlug } from '@mdv/core';
import { attr, kids, str, type MdastNode } from './mdast.js';

/**
 * What the pre-pass needs to know about a resolved block, which the AST alone
 * cannot say: `caption` may arrive from the front matter cascade rather than
 * the fence, and the anchor is the deterministic `mdv-{index}` when the author
 * wrote no `id` (SPEC 24.3 rule 7).
 */
export interface BlockFacts {
  /** The anchor: the author's `id`, or the deterministic `mdv-{index}`. */
  id: string;
  /** The resolved `caption`. A captioned block is a numbered figure. */
  caption?: string | undefined;
  /** The resolved `title`, which a reference falls back to. */
  title?: string | undefined;
}

export interface NumberingOptions {
  /** `numbering.restartAt` — `'h1'`…`'h6'`, or absent for one flat sequence. */
  restartAt?: string | undefined;
  /** The word a figure counter prints. Defaults to `'Figure'`. */
  figureWord?: string | undefined;
  /**
   * Resolved facts for an `mdvBlock` node, by identity.
   *
   * Absent for a block this document did not resolve — a `dataset` block draws
   * nothing (SPEC 6.3) and must not consume a figure number. Absent *entirely*
   * (no resolver at all) is the standalone-`renderMarkdown` case, where the
   * authored attributes are all there is and are used instead.
   */
  blocks?: ((node: MdastNode) => BlockFacts | undefined) | undefined;
}

/** The three tables the walk reads. Keyed by node identity, never by index. */
export interface DocumentNumbering {
  /** The element `id` a heading or a figure carries. */
  anchors: ReadonlyMap<MdastNode, string>;
  /** The counter a numbered node prints above or below itself: `Figure 3.1`. */
  labels: ReadonlyMap<MdastNode, string>;
  /** What `:mdv-ref[name]` prints, by anchor name. */
  targets: ReadonlyMap<string, string>;
}

/** A document with nothing numbered, for callers that skipped the pre-pass. */
export const EMPTY_NUMBERING: DocumentNumbering = {
  anchors: new Map<MdastNode, string>(),
  labels: new Map<MdastNode, string>(),
  targets: new Map<string, string>(),
};

interface Counters {
  slugs: Map<string, number>;
  anchors: Map<MdastNode, string>;
  labels: Map<MdastNode, string>;
  targets: Map<string, string>;
  restartAt: number;
  section: number;
  figure: number;
  word: string;
  blocks: ((node: MdastNode) => BlockFacts | undefined) | undefined;
}

/**
 * Number one document.
 *
 * @param nodes - the root's children, in document order
 * @param options - numbering settings, from the front matter
 */
export function numberDocument(
  nodes: readonly MdastNode[],
  options: NumberingOptions = {},
): DocumentNumbering {
  const ctx: Counters = {
    slugs: new Map<string, number>(),
    anchors: new Map<MdastNode, string>(),
    labels: new Map<MdastNode, string>(),
    targets: new Map<string, string>(),
    restartAt: restartLevel(options.restartAt),
    section: 0,
    figure: 0,
    word: options.figureWord ?? 'Figure',
    blocks: options.blocks,
  };
  walk(nodes, ctx);
  return { anchors: ctx.anchors, labels: ctx.labels, targets: ctx.targets };
}

/**
 * What `:mdv-ref[name]` prints, or `undefined` when nothing declares `name`.
 *
 * The two answers are different renders and not just different strings — a
 * resolved reference is a link and an unresolved one must not be — which is why
 * the not-found *form* is {@link missingRefLabel} rather than a fallback here.
 */
export function refLabel(numbering: DocumentNumbering, name: string): string | undefined {
  return numbering.targets.get(name);
}

/**
 * What a reference to nothing prints: `[fig-revenue?]` (SPEC 28.7).
 *
 * Spelled the same way `render-pdf/src/flow.ts` spells it in `resolveRefs`. A
 * broken cross-reference is a proofreading task, and the author is going to find
 * it by searching the rendered output for the shape they saw on screen; two
 * shapes for one fault would send them looking twice.
 */
export function missingRefLabel(name: string): string {
  return `[${name}?]`;
}

function walk(nodes: readonly MdastNode[], ctx: Counters): void {
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        visitHeading(node, ctx);
        continue;
      case 'mdvBlock':
        visitBlock(node, ctx);
        continue;
      case 'mdvDirective':
        visitDirective(node, ctx);
        continue;
      default:
        walk(kids(node), ctx);
        continue;
    }
  }
}

function visitHeading(node: MdastNode, ctx: Counters): void {
  const text = nodeText(node);
  const level = clampLevel(node['depth']);
  const id = uniqueSlug(slugify(text), ctx.slugs);
  // The restart happens *before* the heading's own figures are counted, so the
  // first figure under `## Results` is 2.1 and not 1.4 (`flow.ts:emitHeading`).
  if (ctx.restartAt > 0 && level <= ctx.restartAt) {
    ctx.section += 1;
    ctx.figure = 0;
  }
  ctx.anchors.set(node, id);
  ctx.targets.set(id, `§${text}`);
}

function visitBlock(node: MdastNode, ctx: Counters): void {
  const facts = blockFacts(node, ctx);
  if (facts === undefined) return;
  const caption = facts.caption;
  const labelled = caption !== undefined && caption !== '';
  if (labelled) ctx.figure += 1;
  const label = labelled ? counterLabel(ctx.word, ctx.figure, sectionPrefix(ctx)) : undefined;
  ctx.anchors.set(node, facts.id);
  if (label !== undefined) ctx.labels.set(node, label);
  // The reference has to print *something*, and a block with no caption still
  // has a name worth saying: its title, or failing that its own anchor.
  ctx.targets.set(facts.id, label ?? blank(facts.title) ?? facts.id);
}

/**
 * The resolved facts, or the authored ones when nothing resolved this document.
 *
 * `undefined` means "not a visual block": no anchor, and — this is the part
 * that matters — no figure number consumed, so a `dataset` block in the middle
 * of a document does not shift every figure after it by one.
 */
function blockFacts(node: MdastNode, ctx: Counters): BlockFacts | undefined {
  if (ctx.blocks !== undefined) return ctx.blocks(node);
  const id = attr(node, 'id');
  if (id === undefined) return undefined;
  return { id, caption: attr(node, 'caption'), title: attr(node, 'title') };
}

function visitDirective(node: MdastNode, ctx: Counters): void {
  if (str(node, 'name') !== 'mdv-figure') {
    walk(kids(node), ctx);
    return;
  }
  // `flow.ts` numbers the figure before walking into it, so a figure nested in
  // another figure gets the *later* number, as reading order says it should.
  ctx.figure += 1;
  const word = attr(node, 'label') ?? ctx.word;
  const label = counterLabel(word, ctx.figure, sectionPrefix(ctx));
  const anchor = attr(node, 'id') ?? uniqueSlug(slugify(label), ctx.slugs);
  ctx.anchors.set(node, anchor);
  ctx.labels.set(node, label);
  ctx.targets.set(anchor, label);
  walk(kids(node), ctx);
}

/** The section number to prefix a counter with, or `0` when there is none. */
function sectionPrefix(ctx: Counters): number {
  return ctx.restartAt > 0 ? ctx.section : 0;
}

function clampLevel(depth: unknown): number {
  if (typeof depth !== 'number' || !Number.isFinite(depth)) return 1;
  return Math.min(Math.max(Math.trunc(depth), 1), 6);
}

function blank(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * The plain text of an inline subtree, for a heading's slug.
 *
 * Takes `value` wherever it finds one and a directive's label otherwise, which
 * is what `runsText(inlineRuns(…))` amounts to for the inline constructs a
 * heading can contain. A heading is short and this runs once per heading, so
 * the recursion is not worth optimising.
 */
function nodeText(node: MdastNode): string {
  const parts: string[] = [];
  collectText(kids(node), parts);
  return parts.join('');
}

function collectText(nodes: readonly MdastNode[], out: string[]): void {
  for (const node of nodes) {
    const value = str(node, 'value');
    if (value !== undefined && node.type !== 'html') {
      out.push(value);
      continue;
    }
    if (node.type === 'mdvDirective') {
      const label = str(node, 'label');
      if (label !== undefined) out.push(label);
      continue;
    }
    collectText(kids(node), out);
  }
}

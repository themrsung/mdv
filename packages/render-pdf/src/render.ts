/**
 * Paginated pages → content-stream operators, link annotations and a structure
 * tree (SPEC 28.7, 28.8).
 *
 * This module is the last place that knows about points and page geometry and
 * the first that knows about PDF operators. It produces no bytes: everything it
 * returns is inspectable data, which is what makes the operator-trace fixtures
 * of SPEC 28.10 possible and what lets a test assert on a `/Link` rectangle
 * without parsing a PDF.
 *
 * Two invariants are worth stating because everything else follows from them:
 *
 * 1. **Charts are drawn by {@link drawScene}, from the very `Scene` the screen
 *    uses.** There is no second layout path, so a label that fits on screen fits
 *    on paper and pagination can never disagree with the viewport (SPEC 28.5).
 * 2. **The structure tree is rebuilt from `PageElement.path`.** Anything the
 *    paginator marked as an artifact (empty path) is wrapped in `/Artifact` and
 *    is invisible to assistive technology; everything else is marked content
 *    with an MCID that a structure element points back at.
 */

import type { Diagnostic } from '@mdv/parser';
import type { TextMetrics } from '@mdv/core';

import * as O from './ops.js';
import { PRINT_POLICY, drawScene } from './paint.js';
import type { PrintPolicy } from './paint.js';
import { ResourcePool } from './resources.js';
import { fontKeyOf, needsShaping, standardFace } from './fonts.js';
import { parseColorOr, toGray } from './color.js';
import type { Rgba } from './color.js';
import { ellipsize, fontFor } from './text.js';
import type { LineBox, PlacedRun, TextRun, TextStyle } from './text.js';
import type { Destination, Drawable, PageElement, PdfPage } from './paginate.js';
import type { DocStyle } from './style.js';
import type { ResolvedPdfOptions, RunningSlots } from './options.js';
import { formatPageNumber } from './options.js';
import { PdfProfileError, renderDiagnostic } from './diagnostics.js';
import { PT_PER_PX } from './units.js';

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/** A marked-content reference: "the ink with this MCID, on this page". */
export interface StructRef {
  kind: 'mcid';
  mcid: number;
  pageIndex: number;
}

/** One node of the logical structure tree (SPEC 28.8). */
export interface StructElement {
  kind: 'element';
  /** A standard structure type: `Document`, `H1`, `P`, `TD`, `Figure`, … */
  type: string;
  /** `/Alt` — the accessible description, verbatim from the scene's a11y tree. */
  alt: string | undefined;
  /** `/ActualText` — when the glyphs are not the text, e.g. a list marker. */
  actualText: string | undefined;
  /**
   * `/ID` — a name for this element, unique in the document.
   *
   * Only a `Note` needs one, and it needs one absolutely: ISO 14289-1 7.9
   * requires it, because a note is the one element a reader is expected to
   * arrive at from somewhere else.
   */
  id: string | undefined;
  /**
   * `/Scope` on a table header cell (ISO 14289-1 7.5).
   *
   * A `TH` that does not say which cells it heads leaves the reader to guess
   * from geometry, which is exactly what the tag exists to avoid.
   */
  scope: 'Row' | 'Column' | undefined;
  kids: StructKid[];
}

export type StructKid = StructElement | StructRef;

/** A `/Link` annotation, in PDF user space (origin bottom-left). */
export interface LinkAnnotation {
  rect: readonly [number, number, number, number];
  /** External target. Exactly one of {@link url} and {@link dest} is set. */
  url: string | undefined;
  /** Internal target: a page and a distance from the *bottom* of that page. */
  dest: { pageIndex: number; yPt: number } | undefined;
  /**
   * `/Contents` — what the link says, for a reader that cannot see where it
   * sits in the text (ISO 14289-1 7.18.1, 7.18.5).
   */
  text: string;
  /**
   * The `Link` structure element this annotation belongs to. The writer ties
   * the two together with an `/OBJR` kid and a `/StructParent` key; an
   * untagged link is a link a screen reader announces as nothing at all.
   */
  struct: StructElement;
}

/**
 * A link part-way through being drawn: open at the first run that carries the
 * target, closed by the run that does not (or by the end of the line).
 */
interface OpenLink {
  /** Target identity, so two adjacent links to *different* places stay apart. */
  target: string;
  struct: StructElement;
  rect: readonly [number, number, number, number];
  /** False until the first run has contributed ink, so `rect` means something. */
  started: boolean;
  text: string;
  url: string | undefined;
  dest: string | undefined;
}

/** How far apart two runs may sit and still be one link, in points. */
const JOIN_TOLERANCE_PT = 0.25;

/** What a run points at, or `undefined` when it is not a link. */
function linkTarget(run: TextRun): string | undefined {
  if (run.href !== undefined) return `url:${run.href}`;
  if (run.dest !== undefined) return `dest:${run.dest}`;
  return undefined;
}

/** One page, ready to be written. */
export interface RenderedPage {
  index: number;
  widthPt: number;
  heightPt: number;
  /** The printed page number, for the writer's own use. */
  pageNumber: number;
  ops: readonly O.PdfOp[];
  /** Resources this page's stream refers to, in first-use order. */
  pool: ResourcePool;
  links: readonly LinkAnnotation[];
  /**
   * The structure element that owns each MCID on this page, indexed by MCID.
   * This is the page's number tree entry for `/StructParents`.
   */
  mcidOwners: readonly StructElement[];
}

/** Everything the writer needs, and nothing that needs a `PDFDocument`. */
export interface RenderResult {
  pages: readonly RenderedPage[];
  /** The root `/Document` element. */
  structure: StructElement;
  diagnostics: readonly Diagnostic[];
}

/** Values for the `{…}` slots in a running header or footer (SPEC 28.2). */
export interface RunningContext {
  title: string;
  subtitle: string;
  author: string;
  /** Already formatted by the caller: this module never reads a clock. */
  date: string;
}

/** Input to {@link render}. */
export interface RenderInput {
  pages: readonly PdfPage[];
  style: DocStyle;
  metrics: TextMetrics;
  options: ResolvedPdfOptions;
  /** Named destinations discovered during pagination. */
  destinations: ReadonlyMap<string, Destination>;
  running: RunningContext;
  /** BCP-47 tag for `/Lang`, from the resolved config. */
  lang?: string | undefined;
  /** Resolve an `image` href to bytes; backends never fetch (SPEC 20). */
  resolveImage?:
    ((href: string) => { format: 'png' | 'jpg'; bytes: Uint8Array } | undefined) | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure paths
// ─────────────────────────────────────────────────────────────────────────────

/** The structure type of a path segment: `TD@7c1` → `TD`. */
function segmentTag(segment: string): string {
  const at = segment.indexOf('@');
  return at === -1 ? segment : segment.slice(0, at);
}

/** `true` when a segment may be shared with the adjacent element. */
function segmentMerges(segment: string): boolean {
  return segment.includes('@');
}

/** `H3` → `3`; anything else → `undefined`. */
function headingLevel(tag: string): number | undefined {
  if (tag.length !== 2 || tag[0] !== 'H') return undefined;
  const level = Number(tag[1]);
  return Number.isInteger(level) && level >= 1 && level <= 6 ? level : undefined;
}

/**
 * Rebuilds the structure tree from the flat element stream.
 *
 * The stream is already in reading order — the paginator emitted it in the order
 * it placed ink — so the tree is built with one stack and no lookahead. An
 * element joins the node its predecessor opened only where they agree on a
 * segment *and its identity*, which is what keeps two consecutive paragraphs
 * apart while keeping the four line-atoms of one paragraph together.
 */
class StructBuilder {
  readonly root: StructElement = {
    kind: 'element',
    type: 'Document',
    alt: undefined,
    actualText: undefined,
    id: undefined,
    scope: undefined,
    kids: [],
  };
  /** Open nodes, deepest last, paired with the path segment that opened them. */
  readonly #stack: { segment: string; node: StructElement }[] = [];
  /** Authored heading levels currently open, strictly increasing. */
  readonly #headings: number[] = [];
  #notes = 0;

  /**
   * The tag a heading gets, which is not always the one the author typed.
   *
   * ISO 14289-1 7.4.2 wants the heading sequence to start at `H1` and to
   * descend one level at a time. A document whose top heading is `##` — or one
   * that jumps `#` to `###` — reads correctly to a human and fails the
   * standard, so the authored levels are compacted onto the sequence the
   * standard asks for. The hierarchy is preserved exactly: a heading is one
   * level deeper than the last heading it sits under, and no deeper.
   */
  #headingTag(level: number): string {
    while (
      this.#headings.length > 0 &&
      (this.#headings[this.#headings.length - 1] as number) >= level
    ) {
      this.#headings.pop();
    }
    this.#headings.push(level);
    return `H${String(Math.min(6, this.#headings.length))}`;
  }

  /** Open (or reuse) the chain for `path` and return the leaf. */
  open(path: readonly string[]): StructElement {
    let shared = 0;
    while (shared < path.length && shared < this.#stack.length) {
      const segment = path[shared] as string;
      const entry = this.#stack[shared] as { segment: string; node: StructElement };
      if (entry.segment !== segment || !segmentMerges(segment)) break;
      shared += 1;
    }
    this.#stack.length = shared;
    for (let i = shared; i < path.length; i += 1) {
      const segment = path[i] as string;
      const parent = this.#stack[i - 1]?.node ?? this.root;
      const tag = segmentTag(segment);
      const level = headingLevel(tag);
      if (tag === 'Note') this.#notes += 1;
      const node: StructElement = {
        kind: 'element',
        type: level === undefined ? tag : this.#headingTag(level),
        alt: undefined,
        actualText: undefined,
        // A serial, not the note's own id: a note referenced twice is two
        // elements, and two elements may not share an `/ID`.
        id: tag === 'Note' ? `note${String(this.#notes)}` : undefined,
        // Every header cell this exporter emits heads a column: the paginator
        // only ever marks a whole row as the header (SPEC 12.2).
        scope: tag === 'TH' ? 'Column' : undefined,
        kids: [],
      };
      parent.kids.push(node);
      this.#stack.push({ segment, node });
    }
    const leaf = this.#stack[this.#stack.length - 1]?.node;
    return leaf ?? this.root;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Running heads
// ─────────────────────────────────────────────────────────────────────────────

const RUNNING_TOKEN = /\{(title|subtitle|author|date|page|pages|section|chapter)\}/g;

/**
 * Substitute the `{…}` slots of a header or footer template.
 *
 * An unknown token is left alone rather than blanked: a literal `{foo}` in a
 * header is far easier to diagnose than a silent gap.
 */
export function interpolateRunning(
  template: string,
  values: Readonly<Record<string, string>>,
): string {
  return template.replace(RUNNING_TOKEN, (whole, key: string) => values[key] ?? whole);
}

// ─────────────────────────────────────────────────────────────────────────────
// The renderer
// ─────────────────────────────────────────────────────────────────────────────

interface PageBuild {
  page: PdfPage;
  pool: ResourcePool;
  ops: O.PdfOp[];
  links: LinkAnnotation[];
  mcidOwners: StructElement[];
  /** Pending internal links, resolved once every destination has a page. */
  pending: {
    rect: readonly [number, number, number, number];
    name: string;
    text: string;
    struct: StructElement;
  }[];
}

class Renderer {
  readonly #input: RenderInput;
  readonly #style: DocStyle;
  readonly #options: ResolvedPdfOptions;
  readonly #policy: PrintPolicy;
  readonly #struct = new StructBuilder();
  readonly #diagnostics: Diagnostic[] = [];
  readonly #missing = new Set<number>();
  readonly #builds: PageBuild[] = [];
  /** Where each footnote body landed, so its reference can link to it. */
  readonly #noteDests = new Map<string, { pageIndex: number; yPt: number }>();
  /** The element currently being drawn, so a link can nest inside it. */
  #leaf: StructElement | undefined;
  #shaping = false;

  constructor(input: RenderInput) {
    this.#input = input;
    this.#style = input.style;
    this.#options = input.options;
    this.#policy = { ...PRINT_POLICY, grayscale: input.options.grayscale };
  }

  // ── colour ─────────────────────────────────────────────────────────────────

  #rgb(value: string): Rgba {
    const parsed = parseColorOr(value);
    return this.#policy.grayscale ? toGray(parsed) : parsed;
  }

  // ── text ───────────────────────────────────────────────────────────────────

  /**
   * A superscript run is raised by 1/3 em of the *body* size. `fontFor` already
   * shrank it to 0.7 em, so the raise is 0.333/0.7 of the shrunken size.
   */
  #riseOf(run: PlacedRun): number {
    return run.run.superscript === true ? run.font.size * (1 / 3 / 0.7) : 0;
  }

  /** Draw one laid-out line at a top-down origin. */
  #drawLine(build: PageBuild, xPt: number, topDownY: number, line: LineBox): void {
    const height = build.page.heightPt;
    const baseline = height - (topDownY + line.baselinePt);
    const body: O.PdfOp[] = [];
    const decorations: O.PdfOp[] = [];

    // A line is one text object (`BT … ET` below), so the font and the fill
    // colour persist from one run to the next. A line of prose is a dozen runs
    // that all share both, and re-selecting them per word is a `Tf` and an `rg`
    // per word in every content stream and every operator trace (SPEC 28.10).
    // Both trackers start empty on each line because what precedes the line is
    // not ours to assume: a rule or a cell background sets `rg` between lines.
    let font: string | undefined;
    let fill: string | undefined;
    /** The link being drawn, if the run before this one was inside one. */
    let open: OpenLink | undefined;

    for (const placed of line.runs) {
      if (placed.run.text === '') continue;
      const key = fontKeyOf(placed.font);
      const resource = build.pool.font(key);
      const face = standardFace(key);
      for (const cp of face.missingCodePoints(placed.run.text)) this.#missing.add(cp);
      if (!this.#shaping && needsShaping(placed.run.text)) this.#shaping = true;

      const color = this.#rgb(placed.color);
      const x = xPt + placed.xPt;
      const y = baseline + this.#riseOf(placed);

      const wantFont = `${resource} ${String(placed.font.size)}`;
      if (wantFont !== font) {
        body.push(O.setFont(resource, placed.font.size));
        font = wantFont;
      }
      const wantFill = `${String(color.r)} ${String(color.g)} ${String(color.b)}`;
      if (wantFill !== fill) {
        body.push(O.fillColor(color.r, color.g, color.b));
        fill = wantFill;
      }
      // A link is one target, not one run. `[the site](u)` is two runs by the
      // time the line breaker has had it, and emitting an annotation per run
      // gives a screen reader two links that each say half a label. So a run
      // that carries on the open link — same target, starting where the last
      // one stopped — extends it instead of starting another.
      const target = linkTarget(placed.run);
      if (open !== undefined && (target !== open.target || x > open.rect[2] + JOIN_TOLERANCE_PT)) {
        this.#closeLink(build, open);
        open = undefined;
      }
      const linked = target !== undefined;
      // A tagged link is a `Link` element of its own, nested inside whatever
      // the run sits in, holding the run's ink and — once the writer has an
      // object number for it — the annotation itself (ISO 14289-1 7.18.5).
      if (target !== undefined) open ??= this.#openLink(placed.run, target);
      const link = open;
      if (link !== undefined) this.#markLink(build, body, link.struct);
      body.push(O.textMatrix([1, 0, 0, 1, x, y]), O.showText(placed.run.text, resource));
      if (link !== undefined) body.push(O.endMarkedContent());

      const rule = (offset: number): void => {
        const w = Math.max(this.#policy.minStrokePt, placed.font.size * 0.055);
        decorations.push(
          O.strokeColor(color.r, color.g, color.b),
          O.lineWidth(w),
          O.moveTo(x, y + offset),
          O.lineTo(x + placed.widthPt, y + offset),
          O.strokePath(),
        );
      };
      // Links are underlined, not coloured: colour alone is never the only
      // signal (SPEC 16.2), and a printed page has no hover state.
      if (linked) rule(-placed.font.size * 0.11);
      if (placed.run.strike === true) rule(placed.font.size * 0.26);

      if (link !== undefined) this.#extendLink(link, placed, x, y);
    }
    // The line ends the link whatever it was doing: a link that wraps gets one
    // annotation per line, because a `/Rect` is a single rectangle.
    if (open !== undefined) this.#closeLink(build, open);

    if (body.length > 0) build.ops.push(O.beginText(), ...body, O.endText());
    build.ops.push(...decorations);
  }

  /**
   * Open a `Link` element for the run about to be drawn.
   *
   * It nests inside the element the run belongs to — a link in a paragraph is
   * part of that paragraph, not a sibling of it — which is why the ink goes in
   * a nested `BDC`: the reader walks into the link and back out again in the
   * middle of the sentence, exactly as it reads.
   */
  #openLink(run: TextRun, target: string): OpenLink {
    const node: StructElement = {
      kind: 'element',
      type: 'Link',
      alt: undefined,
      actualText: undefined,
      id: undefined,
      scope: undefined,
      kids: [],
    };
    (this.#leaf ?? this.#struct.root).kids.push(node);
    return {
      target,
      struct: node,
      rect: [0, 0, 0, 0],
      started: false,
      text: '',
      url: run.href,
      dest: run.dest,
    };
  }

  /** Mark one run's ink as belonging to an open link. */
  #markLink(build: PageBuild, ops: O.PdfOp[], struct: StructElement): void {
    const mcid = build.mcidOwners.length;
    build.mcidOwners.push(struct);
    struct.kids.push({ kind: 'mcid', mcid, pageIndex: build.page.index });
    ops.push(O.beginMarkedContent('Link', mcid));
  }

  /** Grow the annotation rectangle and the announced text over one more run. */
  #extendLink(open: OpenLink, placed: PlacedRun, x: number, baseline: number): void {
    const size = placed.font.size;
    const top = baseline + size * 0.85;
    const bottom = baseline - size * 0.25;
    const right = x + placed.widthPt;
    open.rect = open.started
      ? [
          Math.min(open.rect[0], x),
          Math.min(open.rect[1], bottom),
          Math.max(open.rect[2], right),
          Math.max(open.rect[3], top),
        ]
      : [x, bottom, right, top];
    open.started = true;
    open.text += placed.run.text;
  }

  /** File the finished link as an annotation for the writer to place. */
  #closeLink(build: PageBuild, open: OpenLink): void {
    if (!open.started) return;
    const rect = open.rect;
    // What the link *says*, not what it points at: `/Contents` is read aloud.
    const text = open.text.trim();
    if (open.url !== undefined) {
      build.links.push({ rect, url: open.url, dest: undefined, text, struct: open.struct });
      return;
    }
    if (open.dest !== undefined) {
      build.pending.push({ rect, name: open.dest, text, struct: open.struct });
    }
  }

  // ── primitives ─────────────────────────────────────────────────────────────

  #drawRect(build: PageBuild, d: Extract<Drawable, { kind: 'rect' }>): void {
    if (d.widthPt <= 0 || d.heightPt <= 0) return;
    const height = build.page.heightPt;
    const y = height - (d.yPt + d.heightPt);
    if (d.fill !== undefined) {
      const c = this.#rgb(d.fill);
      build.ops.push(O.fillColor(c.r, c.g, c.b));
    }
    if (d.stroke !== undefined) {
      const c = this.#rgb(d.stroke);
      build.ops.push(
        O.strokeColor(c.r, c.g, c.b),
        O.lineWidth(Math.max(this.#policy.minStrokePt, d.strokeWidthPt)),
      );
    }
    build.ops.push(O.rectangle(d.xPt, y, d.widthPt, d.heightPt));
    if (d.fill !== undefined && d.stroke !== undefined) build.ops.push(O.fillAndStroke());
    else if (d.fill !== undefined) build.ops.push(O.fillNonZero());
    else if (d.stroke !== undefined) build.ops.push(O.strokePath());
    else build.ops.push(O.endPath());
  }

  #drawRule(build: PageBuild, d: Extract<Drawable, { kind: 'rule' }>): void {
    const height = build.page.heightPt;
    const c = this.#rgb(d.color);
    build.ops.push(
      O.strokeColor(c.r, c.g, c.b),
      // Hairlines below half a point disappear on a laser printer (SPEC 28.5).
      O.lineWidth(Math.max(this.#policy.minStrokePt, d.widthPt)),
      O.moveTo(d.x1Pt, height - d.y1Pt),
      O.lineTo(d.x2Pt, height - d.y2Pt),
      O.strokePath(),
    );
  }

  #drawSceneDrawable(build: PageBuild, d: Extract<Drawable, { kind: 'scene' }>): void {
    const result = drawScene(d.scene, {
      pool: build.pool,
      placement: {
        xPt: d.xPt,
        // The scene is in CSS pixels; `scale` is the author's `pdf.scale` times
        // whatever the paginator had to give up to make it fit.
        yPt: d.yPt,
        scale: d.scale * PT_PER_PX,
        pageHeightPt: build.page.heightPt,
      },
      policy: this.#policy,
      ...(this.#input.resolveImage === undefined ? {} : { resolveImage: this.#input.resolveImage }),
    });
    build.ops.push(...result.ops);
    for (const cp of result.missingCodePoints) this.#missing.add(cp);
    if (result.shapingRequired) this.#shaping = true;
  }

  #drawAll(build: PageBuild, drawables: readonly Drawable[]): void {
    for (const d of drawables) {
      switch (d.kind) {
        case 'text':
          this.#drawLine(build, d.xPt, d.yPt, d.line);
          break;
        case 'rect':
          this.#drawRect(build, d);
          break;
        case 'rule':
          this.#drawRule(build, d);
          break;
        case 'scene':
          this.#drawSceneDrawable(build, d);
          break;
      }
    }
  }

  // ── elements ───────────────────────────────────────────────────────────────

  #drawElement(build: PageBuild, el: PageElement): void {
    if (el.path.length === 0) {
      // Decoration: a screen reader must not read a zebra stripe.
      build.ops.push(O.saveState(), O.beginArtifact());
      this.#drawAll(build, el.drawables);
      build.ops.push(O.endMarkedContent(), O.restoreState());
      return;
    }
    const leaf = this.#struct.open(el.path);
    if (el.alt !== undefined) leaf.alt = el.alt;
    if (el.actual !== undefined) leaf.actualText = el.actual;

    const mcid = build.mcidOwners.length;
    build.mcidOwners.push(leaf);
    leaf.kids.push({ kind: 'mcid', mcid, pageIndex: build.page.index });

    build.ops.push(O.saveState(), O.beginMarkedContent(leaf.type, mcid));
    this.#leaf = leaf;
    this.#drawAll(build, el.drawables);
    this.#leaf = undefined;
    build.ops.push(O.endMarkedContent(), O.restoreState());
  }

  // ── running heads (SPEC 28.2) ──────────────────────────────────────────────

  #runningValues(page: PdfPage, lastNumber: number): Record<string, string> {
    const style = this.#options.numbering.style;
    return {
      title: this.#input.running.title,
      subtitle: this.#input.running.subtitle,
      author: this.#input.running.author,
      date: this.#input.running.date,
      page: formatPageNumber(page.pageNumber, style),
      pages: formatPageNumber(lastNumber, style),
      section: page.section,
      chapter: page.chapter,
    };
  }

  #drawRunning(
    build: PageBuild,
    slots: RunningSlots,
    topDownY: number,
    values: Readonly<Record<string, string>>,
  ): void {
    const page = build.page;
    const style = this.#style.running;
    const left = page.margins.leftPt;
    const width = page.widthPt - page.margins.leftPt - page.margins.rightPt;
    if (width <= 0) return;

    build.ops.push(O.saveState(), O.beginArtifact());
    const parts: [string, 'left' | 'center' | 'right'][] = [
      [slots.left, 'left'],
      [slots.center, 'center'],
      [slots.right, 'right'],
    ];
    // Each slot gets a third of the measure. A header that ran into its
    // neighbour would be worse than one that says it was truncated.
    const slotWidth = width / 3;
    for (const [template, align] of parts) {
      const raw = interpolateRunning(template, values).trim();
      if (raw === '') continue;
      const value = ellipsize(raw, slotWidth, style, this.#input.metrics);
      const line = this.#singleLine(value, style);
      const x =
        align === 'left'
          ? left
          : align === 'center'
            ? left + (width - line.widthPt) / 2
            : left + width - line.widthPt;
      this.#drawLine(build, x, topDownY, line);
    }
    build.ops.push(O.endMarkedContent(), O.restoreState());
  }

  /** One unwrapped line — running heads never wrap. */
  #singleLine(value: string, style: TextStyle): LineBox {
    const font = fontFor(style, { text: value });
    const width = this.#input.metrics.measure(value, font).width;
    const heightPt = style.sizePt * style.lineHeight;
    const run: PlacedRun = {
      run: { text: value },
      xPt: 0,
      widthPt: width,
      font,
      color: style.color,
    };
    return { runs: [run], widthPt: width, heightPt, baselinePt: heightPt * 0.78 };
  }

  // ── driver ─────────────────────────────────────────────────────────────────

  run(): RenderResult {
    const { pages, options } = this.#input;
    let lastNumber = 0;
    for (const page of pages) if (page.pageNumber > lastNumber) lastNumber = page.pageNumber;

    for (const page of pages) {
      const build: PageBuild = {
        page,
        pool: new ResourcePool(),
        ops: [],
        links: [],
        mcidOwners: [],
        pending: [],
      };
      this.#builds.push(build);

      for (const el of page.elements) {
        this.#recordNoteDestination(page, el);
        this.#drawElement(build, el);
      }

      const values = this.#runningValues(page, lastNumber);
      const header = options.header;
      if (header !== undefined && (options.headerOnFirstPage || page.index > 0)) {
        this.#drawRunning(
          build,
          header,
          Math.max(0, page.margins.topPt - this.#style.runningGapPt),
          values,
        );
      }
      const footer = options.footer;
      if (footer !== undefined) {
        this.#drawRunning(
          build,
          footer,
          Math.min(page.heightPt, page.heightPt - page.margins.bottomPt + this.#style.runningGapPt),
          values,
        );
      }
    }

    this.#resolveLinks();
    this.#checkProfile();
    this.#reportFonts();

    return {
      pages: this.#builds.map((build) => ({
        index: build.page.index,
        widthPt: build.page.widthPt,
        heightPt: build.page.heightPt,
        pageNumber: build.page.pageNumber,
        ops: build.ops,
        pool: build.pool,
        links: build.links,
        mcidOwners: build.mcidOwners,
      })),
      structure: this.#struct.root,
      diagnostics: this.#diagnostics,
    };
  }

  /**
   * Remember where a footnote body was printed.
   *
   * Notes are placed at the foot of the page by the paginator without an anchor,
   * because their position is only known once the page is full. Recovering it
   * from the element path is what lets the reference superscript be a live link.
   */
  #recordNoteDestination(page: PdfPage, el: PageElement): void {
    const leaf = el.path[el.path.length - 1];
    if (leaf === undefined || !leaf.startsWith('Note@n')) return;
    const id = leaf.slice('Note@n'.length);
    if (this.#noteDests.has(id)) return;
    const first = el.drawables[0];
    const yPt = first === undefined || first.kind !== 'text' ? 0 : first.yPt;
    this.#noteDests.set(id, { pageIndex: page.index, yPt: page.heightPt - yPt });
  }

  /**
   * Turn named targets into page positions.
   *
   * A reference whose target does not exist produces no annotation — the text
   * already printed `[name]` at flow time, which tells the author what broke far
   * better than a dead rectangle would.
   */
  #resolveLinks(): void {
    if (!this.#options.links) return;
    for (const build of this.#builds) {
      for (const { rect, name, text, struct } of build.pending) {
        const target = name.startsWith('note-')
          ? this.#noteDests.get(name.slice('note-'.length))
          : this.#lookupDestination(name);
        if (target === undefined) continue;
        build.links.push({ rect, url: undefined, dest: target, text, struct });
      }
    }
  }

  #lookupDestination(name: string): { pageIndex: number; yPt: number } | undefined {
    const found: Destination | undefined = this.#input.destinations.get(name);
    if (found === undefined) return undefined;
    const page = this.#input.pages[found.pageIndex];
    if (page === undefined) return undefined;
    return { pageIndex: found.pageIndex, yPt: page.heightPt - found.yPt };
  }

  /**
   * PDF/UA has one hard requirement this exporter can actually check: every
   * `/Figure` carries an `/Alt` (SPEC 28.8). A missing one is `MDV5110` and
   * stops the export, because an untagged chart in a document that claims
   * PDF/UA conformance is a silent accessibility failure.
   */
  #checkProfile(): void {
    if (this.#options.profile !== 'pdf-ua-1') return;
    const offenders: string[] = [];
    const walk = (node: StructElement): void => {
      if (node.type === 'Figure' && (node.alt === undefined || node.alt === '')) {
        offenders.push(node.type);
      }
      for (const kid of node.kids) if (kid.kind === 'element') walk(kid);
    };
    walk(this.#struct.root);
    if (offenders.length === 0) return;
    const diagnostic = renderDiagnostic('MDV5110', {
      detail:
        `${String(offenders.length)} figure(s) have no accessible description. ` +
        'Give the block a `desc:` (or a `title:`), or export without `profile: pdf-ua-1`.',
    });
    this.#diagnostics.push(diagnostic);
    throw new PdfProfileError(diagnostic.message, 'MDV5110', [diagnostic]);
  }

  /** One diagnostic per problem, not one per glyph (SPEC 28.6). */
  #reportFonts(): void {
    if (this.#missing.size > 0) {
      const codes = [...this.#missing].sort((a, b) => a - b);
      const shown = codes
        .slice(0, 16)
        .map((c) => `U+${c.toString(16).toUpperCase().padStart(4, '0')}`);
      this.#diagnostics.push(
        renderDiagnostic('MDV5100', {
          detail:
            `The standard PDF fonts cannot encode ${String(codes.length)} codepoint(s): ` +
            `${shown.join(', ')}${codes.length > shown.length ? ', …' : ''}. ` +
            'Embedding a font that covers them is not implemented in this build.',
        }),
      );
    }
    if (this.#shaping) {
      this.#diagnostics.push(
        renderDiagnostic('MDV5101', {
          detail:
            'Text in a script that needs contextual shaping or bidirectional reordering was ' +
            'drawn in logical order with unshaped glyphs.',
        }),
      );
    }
  }
}

/**
 * Render paginated pages to operators, annotations and a structure tree.
 *
 * @throws PdfProfileError when `profile: 'pdf-ua-1'` and a figure has no `/Alt`.
 */
export function render(input: RenderInput): RenderResult {
  return new Renderer(input).run();
}

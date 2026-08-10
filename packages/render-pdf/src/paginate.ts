/**
 * Pagination (SPEC 28.3, 28.4).
 *
 * ## The model
 *
 * Flow items are turned into **atoms** — the smallest thing that may not be
 * split — and atoms are packed into pages by a greedy walker. Everything SPEC
 * 28.3 asks for is expressed as one of two properties of an atom:
 *
 * - `keepWithNext`, which chains an atom to its successor. A heading sets it
 *   (rule 3); the first `orphans` lines of a paragraph and the last `widows`
 *   lines set it (rule 1); a table's header row sets it, and the first and
 *   second-to-last body rows set it so no row is ever stranded (rule 4).
 * - `refit`/`rotate`, which only visual blocks have: an atom too tall for the
 *   space is scaled to fit down to 60 %, and below that is rotated onto a
 *   landscape page of its own with `MDV5120` (rule 2).
 *
 * A chain taller than an empty page is placed and allowed to break; the
 * alternative is an infinite loop, and a keep hint is a hint.
 *
 * ## Coordinates
 *
 * Everything here is in points, measured **from the top of the page downward**,
 * which is how a paginator naturally thinks. `render.ts` performs the single
 * flip into PDF user space. Scenes keep their own CSS-pixel space; the `scale`
 * on a scene drawable carries the conversion.
 *
 * ## Why layout happens here
 *
 * `layoutBlock` runs at the print column width (SPEC 28.5) from inside the
 * paginator, because the paginator is the only thing that knows the column
 * width — and because running it anywhere else would make it possible for a
 * page to be measured from one scene and drawn from another.
 */

import type { Diagnostic, ResolvedBlock, Scene, TextMetrics } from '@mdv/core';
import type {
  CodeItem,
  FlowCell,
  FlowDocument,
  FlowItem,
  FlowNote,
  HeadingItem,
  PageControlItem,
  ParagraphItem,
  TableItem,
  VisualItem,
} from './flow.js';
import { runsText } from './flow.js';
import type { DocStyle } from './style.js';
import type { LineBox, TextRun, TextStyle } from './text.js';
import { ellipsize, layoutRuns, measureText } from './text.js';
import type { Margins, PageBox } from './units.js';
import { orient, ptToPx, pxToPt, resolvePageSize } from './units.js';
import type { NumberingStyle, ResolvedPdfOptions } from './options.js';
import { formatPageNumber } from './options.js';
import { renderDiagnostic } from './diagnostics.js';
import { roundTo } from './number.js';

// ─────────────────────────────────────────────────────────────────────────────
// Output
// ─────────────────────────────────────────────────────────────────────────────

/** One drawing primitive, in page points with `y` measured from the top. */
export type Drawable =
  | { kind: 'text'; xPt: number; yPt: number; line: LineBox }
  | {
      kind: 'rect';
      xPt: number;
      yPt: number;
      widthPt: number;
      heightPt: number;
      fill: string | undefined;
      stroke: string | undefined;
      strokeWidthPt: number;
    }
  | {
      kind: 'rule';
      x1Pt: number;
      y1Pt: number;
      x2Pt: number;
      y2Pt: number;
      color: string;
      widthPt: number;
    }
  | { kind: 'scene'; xPt: number; yPt: number; scene: Scene; scale: number };

/**
 * One tagged element (SPEC 28.8).
 *
 * `path` is the chain of standard structure types from the document root down
 * to this leaf, e.g. `['Table@7', 'TR@8', 'TD@8c0']`. An empty path is an
 * **artifact**: running heads, rules, cell borders — decoration a screen reader
 * must not read.
 *
 * Each segment is `Tag` or `Tag@identity`. The writer rebuilds the tree by
 * merging adjacent elements that share a segment *including its identity*, so a
 * paragraph broken into four line-atoms is one `/P` with four marked-content
 * references while two consecutive paragraphs stay two. A segment with no
 * identity never merges with its neighbour. Threading identities through the
 * paths, rather than a live tree, is what lets the paginator stay a pure
 * producer of independent atoms.
 */
export interface PageElement {
  path: readonly string[];
  /** `/Alt`; required for `Figure` under PDF/UA. */
  alt: string | undefined;
  /** `/ActualText`, when the glyphs are not the text (list markers). */
  actual: string | undefined;
  drawables: readonly Drawable[];
}

/** A destination: a heading anchor, a figure id, a footnote. */
export interface Destination {
  name: string;
  pageIndex: number;
  /** Distance from the top of the page, in points. */
  yPt: number;
  /** What `:mdv-ref[]` prints for it. */
  label: string;
}

/** An outline (bookmark) entry (SPEC 28.7). */
export interface OutlineEntry {
  title: string;
  level: number;
  pageIndex: number;
  yPt: number;
  /** The heading's destination name, so the contents can link to it. */
  anchor: string;
}

/** One paginated page. */
export interface PdfPage {
  index: number;
  widthPt: number;
  heightPt: number;
  margins: Margins;
  elements: readonly PageElement[];
  /** The printed page number, after `numbering.start`/`restartAt`. */
  pageNumber: number;
  /** `{section}` — the innermost heading in force. */
  section: string;
  /** `{chapter}` — the `h1` in force. */
  chapter: string;
  /** `true` for the pages the table of contents occupies. */
  isFrontMatter: boolean;
}

/** The paginated document. */
export interface PaginateResult {
  pages: readonly PdfPage[];
  outline: readonly OutlineEntry[];
  destinations: ReadonlyMap<string, Destination>;
  diagnostics: readonly Diagnostic[];
  /** How many leading pages the table of contents took. */
  tocPageCount: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input
// ─────────────────────────────────────────────────────────────────────────────

/** Lays a block out at a size in CSS pixels — the screen's own entry point. */
export type BlockLayout = (block: ResolvedBlock, widthPx: number, heightPx: number) => Scene;

/** Natural size of a block in CSS pixels, given the column width. */
export type BlockSize = (
  block: ResolvedBlock,
  columnPx: number,
) => { width: number; height: number };

/** One line of the table of contents. */
export interface TocEntry {
  level: number;
  title: string;
  /** The printed page number, already formatted. */
  page: string;
  /** Destination name to link to. */
  dest: string;
}

/** Everything the paginator needs. */
export interface PaginateInput {
  flow: FlowDocument;
  style: DocStyle;
  metrics: TextMetrics;
  options: ResolvedPdfOptions;
  layout: BlockLayout;
  size: BlockSize;
  /** Rendered ahead of the body when `pdf.toc` is configured. */
  toc?:
    | {
        title: string;
        entries: readonly TocEntry[];
        pageBreakAfter: boolean;
      }
    | undefined;
}

/** The floor below which a chart is rotated rather than shrunk (SPEC 28.3). */
export const MIN_BLOCK_SCALE = 0.6;

/** Guard against a pathological keep-chain eating the whole document. */
const MAX_CHAIN = 512;

// ─────────────────────────────────────────────────────────────────────────────
// Atoms
// ─────────────────────────────────────────────────────────────────────────────

type DrawFn = (xPt: number, yPt: number, widthPt: number) => PageElement[];

interface Atom {
  heightPt: number;
  /** Leading space, dropped when the atom lands first on a page. */
  spaceBeforePt: number;
  keepWithNext: boolean;
  breakBefore: boolean;
  breakAfter: boolean;
  /** A `:::mdv-page` geometry change, applied to the page this atom opens. */
  geometry: { orientation?: 'portrait' | 'landscape'; size?: string } | undefined;
  /** Footnote identifiers referenced by this atom. */
  noteIds: readonly string[];
  /** Named destination anchored at this atom's top edge. */
  anchor: string | undefined;
  /** Label reported for that destination. */
  anchorLabel: string | undefined;
  outline: { title: string; level: number } | undefined;
  /** Repeated at the top of a continuation page (table headers). */
  repeat: Atom | undefined;
  /** Ends the run that `repeat` belongs to. */
  endsRepeat: boolean;
  /** Visual blocks only: a version that fits `heightAvailPt`, or `undefined`. */
  refit: ((heightAvailPt: number, columnWidthPt: number) => Atom | undefined) | undefined;
  /** Visual blocks only: a version for a landscape page of its own. */
  rotate: ((columnWidthPt: number, heightAvailPt: number) => Atom) | undefined;
  draw: DrawFn;
}

function atom(partial: Partial<Atom> & { heightPt: number; draw: DrawFn }): Atom {
  return {
    spaceBeforePt: 0,
    keepWithNext: false,
    breakBefore: false,
    breakAfter: false,
    geometry: undefined,
    noteIds: [],
    anchor: undefined,
    anchorLabel: undefined,
    outline: undefined,
    repeat: undefined,
    endsRepeat: false,
    refit: undefined,
    rotate: undefined,
    ...partial,
  };
}

function element(
  path: readonly string[],
  drawables: readonly Drawable[],
  extra: { alt?: string; actual?: string } = {},
): PageElement {
  return { path, alt: extra.alt, actual: extra.actual, drawables };
}

/** Footnote references carried by a line, in the order they appear. */
function notesOf(line: LineBox): string[] {
  const ids: string[] = [];
  for (const placed of line.runs) {
    const dest = placed.run.dest;
    if (dest !== undefined && dest.startsWith('note-')) ids.push(dest.slice(5));
  }
  return ids;
}

/** Horizontal offset for an aligned line. */
function alignOffset(line: LineBox, widthPt: number, align: TextStyle['align']): number {
  if (align === 'center') return Math.max(0, (widthPt - line.widthPt) / 2);
  if (align === 'right') return Math.max(0, widthPt - line.widthPt);
  return 0;
}

/**
 * The description the screen reader gets, reused verbatim as `/Alt` (SPEC 28.8).
 *
 * The PDF says exactly what the accessible tree says — a second, PDF-only
 * description would be a second thing to keep true.
 */
export function sceneAlt(scene: Scene, block: ResolvedBlock): string | undefined {
  const parts: string[] = [];
  const name = scene.a11y.name;
  if (name !== '') parts.push(name);
  const desc = scene.a11y.desc;
  if (desc !== undefined && desc !== '' && desc !== name) parts.push(desc);
  if (parts.length === 0) {
    const title = block.attrs.title;
    if (typeof title === 'string' && title !== '') parts.push(title);
  }
  return parts.length === 0 ? undefined : parts.join('. ');
}

// ─────────────────────────────────────────────────────────────────────────────
// The paginator
// ─────────────────────────────────────────────────────────────────────────────

interface PageState {
  box: PageBox;
  margins: Margins;
  elements: PageElement[];
  /** Cursor, from the page top. */
  y: number;
  /** Notes assigned to this page, in reference order. */
  notes: string[];
  notesHeight: number;
  section: string;
  chapter: string;
  frontMatter: boolean;
}

class Paginator {
  readonly #input: PaginateInput;
  readonly #style: DocStyle;
  readonly #metrics: TextMetrics;
  readonly #options: ResolvedPdfOptions;

  readonly #pages: PdfPage[] = [];
  readonly #outline: OutlineEntry[] = [];
  readonly #destinations = new Map<string, Destination>();
  readonly #diagnostics: Diagnostic[] = [];
  readonly #noteCache = new Map<string, { atoms: Atom[]; heightPt: number }>();
  readonly #notesById = new Map<string, FlowNote>();

  #box: PageBox;
  #margins: Margins;
  #page: PageState;
  #section = '';
  #chapter = '';
  #frontMatter = false;
  #tocPageCount = 0;
  /** Header to repeat at the top of a continuation page. */
  #repeat: Atom | undefined;

  /** Monotonic identity for structure elements — see {@link PageElement}. */
  #key = 0;
  /** Which run of consecutive blockquoted items we are in. */
  #quoteRun = 0;
  #prevQuoteDepth = 0;
  /** Which run of consecutive list items we are in. */
  #listRun = 0;
  #prevList = false;

  constructor(input: PaginateInput) {
    this.#input = input;
    this.#style = input.style;
    this.#metrics = input.metrics;
    this.#options = input.options;
    this.#box = input.options.page;
    this.#margins = input.options.margins;
    for (const note of input.flow.notes) this.#notesById.set(note.id, note);
    this.#page = this.#newPage();
  }

  get columnWidth(): number {
    return this.#box.widthPt - this.#margins.leftPt - this.#margins.rightPt;
  }

  /** A fresh structure-element identity. Allocation order is traversal order. */
  #nextKey(): string {
    this.#key += 1;
    return String(this.#key);
  }

  get contentTop(): number {
    return this.#margins.topPt;
  }

  get contentBottom(): number {
    return this.#box.heightPt - this.#margins.bottomPt;
  }

  get pageHeight(): number {
    return this.contentBottom - this.contentTop;
  }

  #newPage(): PageState {
    return {
      box: this.#box,
      margins: this.#margins,
      elements: [],
      y: this.#margins.topPt,
      notes: [],
      notesHeight: 0,
      section: this.#section,
      chapter: this.#chapter,
      frontMatter: this.#frontMatter,
    };
  }

  /** Space left for content, after the footnotes reserved on this page. */
  #available(): number {
    return this.contentBottom - this.#page.notesHeight - this.#page.y;
  }

  #isEmpty(): boolean {
    return this.#page.elements.length === 0;
  }

  #flush(): void {
    this.#emitNotes();
    const state = this.#page;
    this.#pages.push({
      index: this.#pages.length,
      widthPt: state.box.widthPt,
      heightPt: state.box.heightPt,
      margins: state.margins,
      elements: state.elements,
      pageNumber: 0,
      section: state.section,
      chapter: state.chapter,
      isFrontMatter: state.frontMatter,
    });
    this.#page = this.#newPage();
  }

  // ── footnotes (SPEC 28.3 rule 5) ───────────────────────────────────────────

  #emitNotes(): void {
    if (this.#page.notes.length === 0) return;
    const style = this.#style;
    const x = this.#page.margins.leftPt;
    const width = this.#page.box.widthPt - this.#page.margins.leftPt - this.#page.margins.rightPt;
    const top = this.#page.box.heightPt - this.#page.margins.bottomPt - this.#page.notesHeight;
    this.#page.elements.push(
      element([], [
        {
          kind: 'rule',
          x1Pt: x,
          y1Pt: top + style.footnoteGapPt / 2,
          x2Pt: x + Math.min(width, 144),
          y2Pt: top + style.footnoteGapPt / 2,
          color: style.colors.border,
          widthPt: 0.5,
        },
      ]),
    );
    let y = top + style.footnoteGapPt;
    for (const id of this.#page.notes) {
      for (const noteAtom of this.#noteAtoms(id).atoms) {
        for (const el of noteAtom.draw(x, y, width)) this.#page.elements.push(el);
        y += noteAtom.heightPt;
      }
    }
  }

  /** Measure a note body once; the result is reused wherever it is referenced. */
  #noteAtoms(id: string): { atoms: Atom[]; heightPt: number } {
    const cached = this.#noteCache.get(id);
    if (cached !== undefined) return cached;
    const note = this.#notesById.get(id);
    const style = this.#style;
    const indent = style.indentStepPt;
    const tag = `Note@n${id}`;
    const atoms: Atom[] = [];
    if (note !== undefined) {
      let firstParagraph = true;
      for (const item of note.body) {
        if (item.kind !== 'paragraph') continue;
        const runs: TextRun[] = firstParagraph
          ? [{ text: `${note.marker} `, superscript: true }, ...item.runs]
          : [...item.runs];
        firstParagraph = false;
        const lines = layoutRuns(runs, this.columnWidth - indent, style.footnote, this.#metrics);
        for (const line of lines) {
          atoms.push(
            atom({
              heightPt: line.heightPt,
              draw: (x, y) => [
                element([tag], [{ kind: 'text', xPt: x + indent, yPt: y, line }]),
              ],
            }),
          );
        }
      }
    }
    const heightPt = atoms.reduce((sum, a) => sum + a.heightPt, 0);
    const built = { atoms, heightPt };
    this.#noteCache.set(id, built);
    return built;
  }

  /**
   * Reserve room at the foot of the page for the notes an atom references.
   *
   * @returns `false` when the atom and its notes cannot share this page, in
   * which case the caller breaks and the reference travels with the note.
   */
  #reserveNotes(ids: readonly string[], atomHeight: number): boolean {
    if (ids.length === 0) return true;
    let extra = 0;
    const fresh: string[] = [];
    for (const id of ids) {
      if (this.#page.notes.includes(id)) continue;
      fresh.push(id);
      extra += this.#noteAtoms(id).heightPt;
    }
    if (fresh.length === 0) return true;
    if (this.#page.notes.length === 0) extra += this.#style.footnoteGapPt * 2;
    const room = this.contentBottom - this.#page.notesHeight - extra - this.#page.y;
    if (room < atomHeight && !this.#isEmpty()) return false;
    this.#page.notes.push(...fresh);
    this.#page.notesHeight += extra;
    return true;
  }

  // ── placement ──────────────────────────────────────────────────────────────

  #place(a: Atom, spaceBefore: number): void {
    const x = this.#margins.leftPt;
    const y = this.#page.y + spaceBefore;
    if (a.anchor !== undefined) {
      this.#destinations.set(a.anchor, {
        name: a.anchor,
        pageIndex: this.#pages.length,
        yPt: y,
        label: a.anchorLabel ?? a.anchor,
      });
    }
    if (a.outline !== undefined) {
      this.#outline.push({
        title: a.outline.title,
        level: a.outline.level,
        pageIndex: this.#pages.length,
        yPt: y,
        anchor: a.anchor ?? a.outline.title,
      });
      this.#section = a.outline.title;
      this.#page.section = a.outline.title;
      if (a.outline.level === 1) {
        this.#chapter = a.outline.title;
        this.#page.chapter = a.outline.title;
      }
    }
    for (const el of a.draw(x, y, this.columnWidth)) this.#page.elements.push(el);
    this.#page.y = y + a.heightPt;
  }

  /** Break the page and re-emit the table header, if one is in force. */
  #breakPage(): void {
    this.#flush();
    const repeat = this.#repeat;
    if (repeat !== undefined) this.#place(repeat, 0);
  }

  #placeAll(chain: readonly Atom[]): void {
    for (const a of chain) {
      if (a.repeat !== undefined) this.#repeat = a.repeat;
      let space = this.#isEmpty() ? 0 : a.spaceBeforePt;
      if (!this.#reserveNotes(a.noteIds, a.heightPt + space)) {
        this.#breakPage();
        space = this.#isEmpty() ? 0 : a.spaceBeforePt;
        this.#reserveNotes(a.noteIds, a.heightPt + space);
      }
      if (a.heightPt + space > this.#available() + 1e-6 && !this.#isEmpty()) {
        this.#breakPage();
        space = this.#isEmpty() ? 0 : a.spaceBeforePt;
      }
      this.#place(a, space);
      if (a.endsRepeat) this.#repeat = undefined;
      if (a.breakAfter) this.#flush();
    }
  }

  #chainHeight(chain: readonly Atom[]): number {
    let total = 0;
    for (let i = 0; i < chain.length; i += 1) {
      const a = chain[i] as Atom;
      total += a.heightPt + (i === 0 && this.#isEmpty() ? 0 : a.spaceBeforePt);
    }
    return total;
  }

  #placeChain(chain: readonly Atom[]): void {
    const total = this.#chainHeight(chain);
    if (total <= this.#available() + 1e-6) {
      this.#placeAll(chain);
      return;
    }

    if (total <= this.pageHeight + 1e-6) {
      // Shrinking a chart into what is left beats leaving a third of a page
      // blank, so long as it stays above the 60 % floor (SPEC 28.3 rule 2).
      const refitted = this.#tryRefit(chain, this.#available());
      if (refitted !== undefined) {
        this.#placeAll(refitted);
        return;
      }
      if (!this.#isEmpty()) this.#breakPage();
      this.#placeAll(chain);
      return;
    }

    const refitted = this.#tryRefit(chain, this.pageHeight);
    if (refitted !== undefined) {
      if (!this.#isEmpty()) this.#breakPage();
      this.#placeAll(refitted);
      return;
    }
    if (this.#rotateChain(chain)) return;
    // Nothing fits and nothing can shrink: place it and let it break.
    if (!this.#isEmpty()) this.#breakPage();
    this.#placeAll(chain);
  }

  /** Ask the visual atom in a chain to shrink into `heightAvail`. */
  #tryRefit(chain: readonly Atom[], heightAvail: number): Atom[] | undefined {
    const index = chain.findIndex((a) => a.refit !== undefined);
    if (index < 0) return undefined;
    const visual = chain[index] as Atom;
    const refit = visual.refit;
    if (refit === undefined) return undefined;
    let others = 0;
    for (let i = 0; i < chain.length; i += 1) {
      if (i === index) continue;
      const a = chain[i] as Atom;
      others += a.heightPt + a.spaceBeforePt;
    }
    const fitted = refit(heightAvail - others - visual.spaceBeforePt, this.columnWidth);
    if (fitted === undefined) return undefined;
    const out = [...chain];
    out[index] = fitted;
    return out;
  }

  /** Put a chart that cannot shrink on a landscape page of its own (rule 2). */
  #rotateChain(chain: readonly Atom[]): boolean {
    const index = chain.findIndex((a) => a.rotate !== undefined);
    if (index < 0) return false;
    const visual = chain[index] as Atom;
    const rotate = visual.rotate;
    if (rotate === undefined) return false;

    if (!this.#isEmpty()) this.#flush();
    const saved = this.#box;
    this.#applyGeometry({ orientation: 'landscape' });
    this.#page = this.#newPage();
    const out = [...chain];
    out[index] = rotate(this.columnWidth, this.pageHeight);
    this.#placeAll(out);
    this.#flush();
    this.#box = saved;
    this.#page = this.#newPage();
    return true;
  }

  /** Change the page box. Takes effect on the next page opened. */
  #applyGeometry(change: { orientation?: 'portrait' | 'landscape'; size?: string }): void {
    const orientation = change.orientation ?? this.#options.orientation;
    const configured = this.#options.page;
    const portrait: PageBox =
      change.size === undefined
        ? {
            widthPt: Math.min(configured.widthPt, configured.heightPt),
            heightPt: Math.max(configured.widthPt, configured.heightPt),
          }
        : resolvePageSize(change.size);
    this.#box = orient(portrait, orientation);
  }

  // ── the walk ───────────────────────────────────────────────────────────────

  run(): PaginateResult {
    this.#emitToc();

    const items = this.#input.flow.items;
    const queue: Atom[] = [];
    let cursor = 0;

    const fill = (): void => {
      while (queue.length === 0 && cursor < items.length) {
        const item = items[cursor];
        cursor += 1;
        if (item === undefined) continue;
        const produced = [...this.#atomsFor(item)];
        // SPEC 28.3 rule 2: a figure and its caption are one unit. The flow
        // stamps the members of an `mdv-figure` with a shared `group`; welding
        // the last atom of each member to whatever follows is what makes the
        // boundary between them unbreakable.
        const next = items[cursor];
        const last = produced[produced.length - 1];
        if (
          last !== undefined &&
          item.group !== undefined &&
          next !== undefined &&
          next.group === item.group
        ) {
          produced[produced.length - 1] = { ...last, keepWithNext: true };
        }
        for (const atomProduced of produced) queue.push(atomProduced);
      }
    };

    for (;;) {
      fill();
      const head = queue.shift();
      if (head === undefined) break;

      if (head.geometry !== undefined) {
        if (!this.#isEmpty()) this.#flush();
        this.#applyGeometry(head.geometry);
        this.#page = this.#newPage();
      }
      if (head.breakBefore && !this.#isEmpty()) this.#flush();

      // Gather the keep-chain this atom opens. Pulling stops at a forced break
      // or a geometry change, which is also where a chain cannot continue.
      const chain: Atom[] = [head];
      while ((chain[chain.length - 1] as Atom).keepWithNext && chain.length < MAX_CHAIN) {
        fill();
        const next = queue[0];
        if (next === undefined || next.breakBefore || next.geometry !== undefined) break;
        chain.push(next);
        queue.shift();
      }

      this.#placeChain(chain);
    }

    if (!this.#isEmpty()) this.#flush();
    if (this.#pages.length === 0) this.#flush();

    this.#numberPages();
    return {
      pages: this.#pages,
      outline: this.#outline,
      destinations: this.#destinations,
      diagnostics: this.#diagnostics,
      tocPageCount: this.#tocPageCount,
    };
  }

  /** Apply `numbering.start` and `restartAt` once every page exists. */
  #numberPages(): void {
    const { start, restartAt } = this.#options.numbering;
    const match = /^h([1-6])$/.exec(restartAt ?? '');
    const level = match === null ? 0 : Number.parseInt(match[1] ?? '1', 10);
    let n = start;
    let first = true;
    for (const page of this.#pages) {
      if (level > 0 && !first) {
        const opens = this.#outline.some(
          (entry) => entry.pageIndex === page.index && entry.level <= level,
        );
        if (opens) n = start;
      }
      page.pageNumber = n;
      n += 1;
      first = false;
    }
  }

  // ── table of contents (SPEC 28.2) ──────────────────────────────────────────

  #emitToc(): void {
    const toc = this.#input.toc;
    if (toc === undefined || toc.entries.length === 0) return;
    this.#frontMatter = true;
    this.#page.frontMatter = true;

    const style = this.#style;
    const titleLines = layoutRuns([{ text: toc.title }], this.columnWidth, style.tocTitle, this.#metrics);
    const titleTag = `H1@${this.#nextKey()}`;
    for (let i = 0; i < titleLines.length; i += 1) {
      const line = titleLines[i];
      if (line === undefined) continue;
      this.#placeChain([
        atom({
          heightPt: line.heightPt,
          keepWithNext: true,
          draw: (x, y) => [element([titleTag], [{ kind: 'text', xPt: x, yPt: y, line }])],
        }),
      ]);
    }
    this.#placeChain([atom({ heightPt: style.headingSpaceAfterPt, draw: () => [] })]);

    for (const entry of toc.entries) {
      this.#placeChain([this.#tocAtom(entry)]);
    }

    if (toc.pageBreakAfter && !this.#isEmpty()) this.#flush();
    this.#tocPageCount = this.#pages.length;
    this.#frontMatter = false;
    this.#page.frontMatter = false;
  }

  /**
   * One contents line: title on the left, page number hard against the right
   * margin, dot leaders between. The leader is built from whole dots so it lines
   * up between entries instead of ending at a random fraction of a dot.
   */
  #tocAtom(entry: TocEntry): Atom {
    const style = this.#style.tocEntry;
    const indent = (entry.level - 1) * this.#style.indentStepPt * 0.75;
    const width = this.columnWidth - indent;
    const pageWidth = measureText(entry.page, style, this.#metrics);
    const dotWidth = measureText(' .', style, this.#metrics);
    const titleRoom = width - pageWidth - dotWidth * 2;
    const title = ellipsize(entry.title, Math.max(dotWidth, titleRoom), style, this.#metrics);
    const titleWidth = measureText(title, style, this.#metrics);
    const leaderRoom = width - pageWidth - titleWidth - dotWidth;
    const dots = dotWidth <= 0 ? 0 : Math.max(0, Math.floor(leaderRoom / dotWidth));
    const runs: TextRun[] = [
      { text: title, dest: entry.dest, bold: entry.level === 1 },
      { text: ` ${' .'.repeat(dots)} `, color: this.#style.colors.muted },
      { text: entry.page, dest: entry.dest },
    ];
    const lines = layoutRuns(runs, Number.MAX_SAFE_INTEGER, style, this.#metrics);
    const line = lines[0] ?? {
      runs: [],
      widthPt: 0,
      heightPt: style.sizePt * style.lineHeight,
      baselinePt: style.sizePt * style.lineHeight * 0.78,
    };
    const tag = `TOCI@${this.#nextKey()}`;
    return atom({
      heightPt: line.heightPt,
      spaceBeforePt: entry.level === 1 ? this.#style.listGapPt : 0,
      draw: (x, y) => [element(['TOC@toc', tag], [{ kind: 'text', xPt: x + indent, yPt: y, line }])],
    });
  }

  // ── atom construction ──────────────────────────────────────────────────────

  *#atomsFor(item: FlowItem): Generator<Atom> {
    this.#trackRuns(item);
    switch (item.kind) {
      case 'heading':
        yield* this.#headingAtoms(item);
        return;
      case 'paragraph':
        yield* this.#paragraphAtoms(item);
        return;
      case 'code':
        yield* this.#codeAtoms(item);
        return;
      case 'rule':
        yield this.#ruleAtom();
        return;
      case 'table':
        yield* this.#tableAtoms(item);
        return;
      case 'visual':
        yield this.#visualAtom(item);
        return;
      case 'page':
        yield this.#pageAtom(item);
        return;
      default:
        return;
    }
  }

  /**
   * Open a new `/BlockQuote` or `/L` whenever a run of them starts.
   *
   * Nesting is flattened: an inner list is more indentation, not a second `/L`.
   * That is a known simplification of the structure tree, and it is preferable
   * to guessing at nesting the flow deliberately threw away (see
   * {@link FlowBase.indent}).
   */
  #trackRuns(item: FlowItem): void {
    if (item.quoteDepth > 0 && this.#prevQuoteDepth === 0) this.#quoteRun += 1;
    this.#prevQuoteDepth = item.quoteDepth;
    const isList =
      item.kind === 'paragraph' && (item.role === 'listItem' || item.indent > 0);
    if (isList && !this.#prevList) this.#listRun += 1;
    this.#prevList = isList;
  }

  #indentOf(item: { indent: number; quoteDepth: number }): number {
    return item.indent * this.#style.indentStepPt + item.quoteDepth * this.#style.quoteIndentPt;
  }

  /** The blockquote rules that apply to a line of a given height. */
  #quoteBars(quoteDepth: number, x: number, y: number, heightPt: number): Drawable[] {
    const out: Drawable[] = [];
    for (let d = 0; d < quoteDepth; d += 1) {
      out.push({
        kind: 'rect',
        xPt: x + d * this.#style.quoteIndentPt + this.#style.quoteIndentPt / 3,
        yPt: y,
        widthPt: this.#style.quoteBarPt,
        heightPt,
        fill: this.#style.colors.border,
        stroke: undefined,
        strokeWidthPt: 0,
      });
    }
    return out;
  }

  *#headingAtoms(item: HeadingItem): Generator<Atom> {
    const style = this.#style.heading(item.level);
    const indent = this.#indentOf(item);
    const lines = layoutRuns(item.runs, this.columnWidth - indent, style, this.#metrics);
    const tag = `H${item.level}@${this.#nextKey()}`;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      yield atom({
        heightPt: line.heightPt,
        spaceBeforePt: i === 0 ? this.#style.headingSpaceBefore(item.level) : 0,
        // Every line of the heading is chained, and the last one is chained to
        // whatever follows it: `break-after: avoid` (SPEC 28.3 rule 3).
        keepWithNext: true,
        noteIds: notesOf(line),
        anchor: i === 0 ? item.id : undefined,
        anchorLabel: i === 0 ? item.text : undefined,
        outline: i === 0 ? { title: item.text, level: item.level } : undefined,
        draw: (x, y) => [
          element(
            [tag],
            [
              ...this.#quoteBars(item.quoteDepth, x, y, line.heightPt),
              { kind: 'text', xPt: x + indent, yPt: y, line },
            ],
          ),
        ],
      });
    }
    // The gap under a heading is leading space on a zero-height atom, so it
    // vanishes when the heading turns out to be the last thing on a page.
    yield atom({
      heightPt: 0,
      spaceBeforePt: this.#style.headingSpaceAfterPt,
      keepWithNext: true,
      draw: () => [],
    });
  }

  *#paragraphAtoms(item: ParagraphItem): Generator<Atom> {
    const style = this.#styleFor(item);
    const indent = this.#indentOf(item);
    const width = Math.max(1, this.columnWidth - indent);
    const emptyLine: LineBox = {
      runs: [],
      widthPt: 0,
      heightPt: style.sizePt * style.lineHeight,
      baselinePt: style.sizePt * style.lineHeight * 0.78,
    };
    const lines =
      item.runs.length === 0
        ? [emptyLine]
        : layoutRuns(item.runs, width, style, this.#metrics);
    const markerWidth =
      item.marker === undefined
        ? 0
        : Math.max(
            this.#style.indentStepPt * 0.7,
            measureText(`${item.marker} `, style, this.#metrics),
          );
    const markerLine =
      item.marker === undefined
        ? undefined
        : layoutRuns([{ text: item.marker }], Number.MAX_SAFE_INTEGER, style, this.#metrics)[0];
    const path = this.#pathFor(item, this.#nextKey());
    const { widows, orphans } = this.#options;
    const n = lines.length;
    const accent = item.callout;

    for (let i = 0; i < n; i += 1) {
      const line = lines[i];
      if (line === undefined) continue;
      const first = i === 0;
      // rule 1: the first `orphans` lines and the last `widows` lines are each
      // welded together, so a break can never strand fewer than either.
      const keep = n <= widows + orphans ? i < n - 1 : i < orphans - 1 || i >= n - widows;
      yield atom({
        heightPt: line.heightPt,
        spaceBeforePt: first ? this.#spaceBefore(item) : 0,
        keepWithNext: keep || (first && item.keepWithNext),
        noteIds: notesOf(line),
        anchor: first ? item.anchor : undefined,
        draw: (x, y, w) => {
          const drawables: Drawable[] = [...this.#quoteBars(item.quoteDepth, x, y, line.heightPt)];
          if (accent !== undefined) {
            drawables.push({
              kind: 'rect',
              xPt: x + Math.max(0, indent - this.#style.quoteIndentPt / 2),
              yPt: y,
              widthPt: 2,
              heightPt: line.heightPt,
              fill: this.#style.colors.border,
              stroke: undefined,
              strokeWidthPt: 0,
            });
          }
          if (first && markerLine !== undefined) {
            drawables.push({
              kind: 'text',
              xPt: x + Math.max(0, indent - markerWidth),
              yPt: y,
              line: markerLine,
            });
          }
          drawables.push({
            kind: 'text',
            xPt: x + indent + alignOffset(line, w - indent, style.align),
            yPt: y,
            line,
          });
          return [
            element(
              path,
              drawables,
              first && item.marker !== undefined
                ? { actual: `${item.marker} ${runsText(item.runs)}` }
                : {},
            ),
          ];
        },
      });
    }
  }

  #styleFor(item: ParagraphItem): TextStyle {
    switch (item.role) {
      case 'caption':
        return this.#style.caption;
      case 'subheading':
        return this.#style.subheading;
      case 'footnote':
        return this.#style.footnote;
      default:
        return this.#style.body;
    }
  }

  #pathFor(item: ParagraphItem, key: string): readonly string[] {
    const quote = item.quoteDepth > 0 ? [`BlockQuote@q${String(this.#quoteRun)}`] : [];
    const list = (): readonly string[] => [
      ...quote,
      `L@l${String(this.#listRun)}`,
      `LI@${key}`,
      `LBody@${key}`,
      `P@${key}`,
    ];
    switch (item.role) {
      case 'caption':
        return [...quote, `Caption@${key}`];
      case 'subheading':
        return [...quote, `H6@${key}`];
      case 'footnote':
        return [...quote, `Note@${key}`];
      case 'listItem':
        return list();
      default:
        return item.indent > 0 ? list() : [...quote, `P@${key}`];
    }
  }

  #spaceBefore(item: ParagraphItem): number {
    if (item.role === 'listItem' || item.indent > 0 || item.role === 'caption') {
      return this.#style.listGapPt;
    }
    return this.#style.paragraphGapPt;
  }

  *#codeAtoms(item: CodeItem): Generator<Atom> {
    const style = this.#style.code;
    const indent = this.#indentOf(item);
    const pad = this.#style.codePaddingPt;
    const lineHeight = style.sizePt * style.lineHeight;
    const n = item.lines.length;
    const tag = `P@${this.#nextKey()}`;
    for (let i = 0; i < n; i += 1) {
      const source = item.lines[i] ?? '';
      // Code is never re-wrapped: a broken line is a different program. A long
      // line overflows the column, which at least stays readable and truthful.
      const line = layoutRuns(
        [{ text: source === '' ? ' ' : source, mono: true }],
        Number.MAX_SAFE_INTEGER,
        style,
        this.#metrics,
      )[0];
      if (line === undefined) continue;
      const first = i === 0;
      const last = i === n - 1;
      const height = lineHeight + (first ? pad : 0) + (last ? pad : 0);
      yield atom({
        heightPt: height,
        spaceBeforePt: first ? this.#style.paragraphGapPt : 0,
        // Two lines of code stranded at the foot of a page help nobody, so the
        // same widow/orphan reasoning applies as for prose.
        keepWithNext: n <= 4 ? !last : i < 1 || i >= n - 2,
        draw: (x, y, w) => [
          element(
            [tag],
            [
              ...this.#quoteBars(item.quoteDepth, x, y, height),
              {
                kind: 'rect',
                xPt: x + indent,
                yPt: y,
                widthPt: Math.max(0, w - indent),
                heightPt: height,
                fill: this.#style.colors.surface,
                stroke: undefined,
                strokeWidthPt: 0,
              },
              { kind: 'text', xPt: x + indent + pad, yPt: y + (first ? pad : 0), line },
            ],
          ),
        ],
      });
    }
  }

  #ruleAtom(): Atom {
    const gap = this.#style.ruleGapPt;
    return atom({
      heightPt: gap,
      spaceBeforePt: gap,
      draw: (x, y, w) => [
        element([], [
          {
            kind: 'rule',
            x1Pt: x,
            y1Pt: y + gap / 2,
            x2Pt: x + w,
            y2Pt: y + gap / 2,
            color: this.#style.colors.border,
            widthPt: 0.5,
          },
        ]),
      ],
    });
  }

  #pageAtom(item: PageControlItem): Atom {
    const geometry =
      item.orientation === undefined && item.size === undefined
        ? undefined
        : {
            ...(item.orientation === undefined ? {} : { orientation: item.orientation }),
            ...(item.size === undefined ? {} : { size: item.size }),
          };
    return atom({
      heightPt: 0,
      // `break=avoid` asks *not* to break here, which for a control that draws
      // nothing means: do nothing at all.
      breakBefore: item.breakKind === 'before' || (item.breakKind === undefined && geometry !== undefined),
      breakAfter: item.breakKind === 'after',
      geometry,
      draw: () => [],
    });
  }

  // ── tables (SPEC 28.3 rule 4) ──────────────────────────────────────────────

  *#tableAtoms(item: TableItem): Generator<Atom> {
    const widths = this.#columnWidths(item);
    const rows = item.rows;
    const tableKey = this.#nextKey();
    const headerAtom =
      item.head.length === 0
        ? undefined
        : this.#rowAtom(item, item.head, widths, true, false, tableKey, this.#nextKey());

    const captionKey = this.#nextKey();
    const captionText =
      item.caption === undefined
        ? item.label
        : `${item.label === undefined ? '' : `${item.label}. `}${item.caption}`;
    if (captionText !== undefined && captionText !== '') {
      const lines = layoutRuns(
        [{ text: captionText }],
        this.columnWidth,
        this.#style.caption,
        this.#metrics,
      );
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line === undefined) continue;
        yield atom({
          heightPt: line.heightPt,
          spaceBeforePt: i === 0 ? this.#style.blockGapPt : 0,
          keepWithNext: true,
          anchor: i === 0 ? item.anchor : undefined,
          anchorLabel: i === 0 ? item.label : undefined,
          draw: (x, y) => [
            element([`Caption@${captionKey}`], [{ kind: 'text', xPt: x, yPt: y, line }]),
          ],
        });
      }
    }

    if (headerAtom !== undefined) {
      // The header repeats at the top of every continuation page (SPEC 28.3
      // rule 4). The caption does not repeat: it carries the table's number and
      // its destination, and printing it twice would make `:mdv-ref[]` ambiguous
      // about which page it means.
      yield {
        ...headerAtom,
        keepWithNext: true,
        spaceBeforePt: captionText === undefined ? this.#style.blockGapPt : 0,
        repeat: headerAtom,
      };
    }
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row === undefined) continue;
      const last = i === rows.length - 1;
      yield {
        ...this.#rowAtom(item, row, widths, false, i % 2 === 1, tableKey, this.#nextKey()),
        keepWithNext: rows.length <= 2 ? !last : i === 0 || i === rows.length - 2,
        endsRepeat: last,
      };
    }
    if (rows.length === 0) {
      yield atom({ heightPt: 0, endsRepeat: true, draw: () => [] });
    }
  }

  /**
   * Auto table layout.
   *
   * Columns get their natural width when the table fits, and shrink toward the
   * widest single word when it does not. Distributing the deficit over the slack
   * (`natural − minimum`) rather than over the natural width is what stops a
   * column of dates being squeezed to nothing by a column of prose.
   */
  #columnWidths(item: TableItem): number[] {
    let columns = item.head.length;
    for (const row of item.rows) columns = Math.max(columns, row.length);
    columns = Math.max(columns, 1);
    const padding = this.#style.cellPadXPt * 2;
    const natural: number[] = new Array<number>(columns).fill(0);
    const minimum: number[] = new Array<number>(columns).fill(0);

    const consider = (cells: readonly FlowCell[], style: TextStyle): void => {
      for (let c = 0; c < cells.length; c += 1) {
        const cell = cells[c];
        if (cell === undefined) continue;
        const text = runsText(cell.runs);
        natural[c] = Math.max(natural[c] ?? 0, measureText(text, style, this.#metrics) + padding);
        let widest = 0;
        for (const word of text.split(' ')) {
          widest = Math.max(widest, measureText(word, style, this.#metrics));
        }
        minimum[c] = Math.max(minimum[c] ?? 0, widest + padding);
      }
    };

    consider(item.head, this.#style.tableHeader);
    for (const row of item.rows) consider(row, this.#style.tableCell);

    const available = this.columnWidth;
    const totalNatural = natural.reduce((a, b) => a + b, 0);
    if (totalNatural <= 0) return natural.map(() => roundTo(available / columns, 4));
    if (totalNatural <= available) {
      // Spread the slack evenly so the table spans the column: a table that
      // stops two thirds of the way across reads as a mistake.
      const slack = (available - totalNatural) / columns;
      return natural.map((w) => roundTo(w + slack, 4));
    }
    const totalMinimum = minimum.reduce((a, b) => a + b, 0);
    if (totalMinimum >= available) {
      const factor = available / totalMinimum;
      return minimum.map((w) => roundTo(w * factor, 4));
    }
    const slackTotal = totalNatural - totalMinimum;
    const deficit = totalNatural - available;
    return natural.map((w, i) => {
      const slack = w - (minimum[i] ?? 0);
      const share = slackTotal === 0 ? 0 : (slack / slackTotal) * deficit;
      return roundTo(w - share, 4);
    });
  }

  #rowAtom(
    item: TableItem,
    cells: readonly FlowCell[],
    widths: readonly number[],
    header: boolean,
    zebra: boolean,
    tableKey: string,
    rowKey: string,
  ): Atom {
    const style = header ? this.#style.tableHeader : this.#style.tableCell;
    const padX = this.#style.cellPadXPt;
    const padY = this.#style.cellPadYPt;
    const laid: LineBox[][] = [];
    let content = 0;
    for (let c = 0; c < widths.length; c += 1) {
      const cell = cells[c];
      const width = Math.max(1, (widths[c] ?? 0) - padX * 2);
      const lines = cell === undefined ? [] : layoutRuns(cell.runs, width, style, this.#metrics);
      laid.push(lines);
      content = Math.max(
        content,
        lines.reduce((sum, l) => sum + l.heightPt, 0),
      );
    }
    const height = content + padY * 2;
    const noteIds: string[] = [];
    for (const lines of laid) for (const line of lines) noteIds.push(...notesOf(line));
    const total = widths.reduce((a, b) => a + b, 0);

    return atom({
      heightPt: height,
      noteIds,
      draw: (x, y) => {
        const out: PageElement[] = [];
        const artifacts: Drawable[] = [];
        if (header || zebra) {
          artifacts.push({
            kind: 'rect',
            xPt: x,
            yPt: y,
            widthPt: total,
            heightPt: height,
            fill: this.#style.colors.surface,
            stroke: undefined,
            strokeWidthPt: 0,
          });
        }
        artifacts.push({
          kind: 'rule',
          x1Pt: x,
          y1Pt: y + height,
          x2Pt: x + total,
          y2Pt: y + height,
          color: header ? this.#style.colors.text : this.#style.colors.grid,
          widthPt: header ? 0.75 : 0.5,
        });
        out.push(element([], artifacts));

        let cx = x;
        for (let c = 0; c < widths.length; c += 1) {
          const width = widths[c] ?? 0;
          const lines = laid[c] ?? [];
          const align = item.align[c] ?? 'left';
          const inner = width - padX * 2;
          let cy = y + padY;
          const drawables: Drawable[] = [];
          for (const line of lines) {
            const offset =
              align === 'right'
                ? Math.max(0, inner - line.widthPt)
                : align === 'center'
                  ? Math.max(0, (inner - line.widthPt) / 2)
                  : 0;
            drawables.push({ kind: 'text', xPt: cx + padX + offset, yPt: cy, line });
            cy += line.heightPt;
          }
          out.push(
            element(
              [
                `Table@${tableKey}`,
                `TR@${rowKey}`,
                `${header ? 'TH' : 'TD'}@${rowKey}c${String(c)}`,
              ],
              drawables,
            ),
          );
          cx += width;
        }
        return out;
      },
    });
  }

  // ── visual blocks (SPEC 28.3 rule 2, SPEC 28.5) ────────────────────────────

  #visualAtom(item: VisualItem): Atom {
    return this.#sceneAtom(item, this.columnWidth, item.scale ?? 1, this.#nextKey());
  }

  /**
   * One atom per visual block.
   *
   * The scene comes from the caller's `layout`, which is `layoutBlock` — the
   * same function the screen calls, run at the print column width so labels are
   * re-fitted rather than scaled (SPEC 28.5). The exporter never re-implements
   * layout, so a page cannot disagree with the screen about whether a label fits.
   */
  #sceneAtom(item: VisualItem, columnWidthPt: number, scale: number, key: string): Atom {
    const columnPx = ptToPx(columnWidthPt);
    const natural = this.#input.size(item.block, columnPx);
    const scene = this.#input.layout(item.block, natural.width, natural.height);
    const widthPt = pxToPt(scene.width) * scale;
    const heightPt = pxToPt(scene.height) * scale;
    const alt = sceneAlt(scene, item.block);
    const authorScale = item.scale ?? 1;
    const self = this;

    return atom({
      heightPt,
      spaceBeforePt: this.#style.blockGapPt,
      breakBefore: item.breakBefore,
      breakAfter: item.breakAfter,
      // `pdf: {break: avoid}` (SPEC 28.4) is a request not to break *after* the
      // block, which for a single atom is exactly a keep-with-next.
      keepWithNext: item.breakAvoid || item.keepWithNext,
      anchor: item.anchor,
      anchorLabel: item.label,
      refit(heightAvailPt: number, availableWidthPt: number): Atom | undefined {
        if (heightAvailPt >= heightPt) return undefined;
        const unscaled = heightPt / scale;
        if (unscaled <= 0) return undefined;
        const target = Math.min(heightAvailPt / unscaled, authorScale);
        if (target < MIN_BLOCK_SCALE) return undefined;
        return self.#sceneAtom(item, availableWidthPt, target, key);
      },
      rotate(availableWidthPt: number, heightAvailPt: number): Atom {
        self.#diagnostics.push(
          renderDiagnostic('MDV5120', {
            blockId: item.block.id,
            range: item.block.range,
            detail:
              'The block does not fit the text column at 60 % or larger, so it is printed ' +
              'on a landscape page of its own.',
          }),
        );
        const landscape = self.#sceneAtom(item, availableWidthPt, authorScale, key);
        if (landscape.heightPt <= heightAvailPt) return landscape;
        const shrink = Math.max(
          MIN_BLOCK_SCALE,
          (heightAvailPt / landscape.heightPt) * authorScale,
        );
        return self.#sceneAtom(item, availableWidthPt, shrink, key);
      },
      draw: (x, y, w) => [
        element(
          [`Figure@${key}`],
          [
            {
              kind: 'scene',
              // Centre a block narrower than the column; a chart hugging the
              // left margin under full-width prose looks like a mistake.
              xPt: x + Math.max(0, (w - widthPt) / 2),
              yPt: y,
              scene,
              scale,
            },
          ],
          alt === undefined ? {} : { alt },
        ),
      ],
    });
  }
}

/** Paginate a flowed document. */
export function paginate(input: PaginateInput): PaginateResult {
  return new Paginator(input).run();
}

/**
 * Build contents entries from an outline and the pages it points at.
 *
 * `pageOffset` accounts for the contents pages themselves, which do not exist
 * yet the first time round; `document.ts` iterates until the count settles.
 */
export function tocEntries(
  outline: readonly OutlineEntry[],
  pages: readonly PdfPage[],
  depth: number,
  style: NumberingStyle,
  pageOffset: number,
): TocEntry[] {
  const out: TocEntry[] = [];
  for (const entry of outline) {
    if (entry.level > depth) continue;
    const page = pages[entry.pageIndex];
    out.push({
      level: entry.level,
      title: entry.title,
      page: page === undefined ? '' : formatPageNumber(page.pageNumber + pageOffset, style),
      dest: entry.anchor,
    });
  }
  return out;
}

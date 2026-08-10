/**
 * Document flow: MDV AST → a linear list of {@link FlowItem}s (SPEC 28.3).
 *
 * ## Why the list is flat
 *
 * A page break can land between any two lines, so a paginator that walks a tree
 * has to be able to split every container it meets. Flattening first — a nested
 * list becomes a run of paragraphs carrying an indent and a marker, a blockquote
 * becomes a run of items carrying a quote depth — means the paginator only ever
 * splits *one* thing, a sequence of lines, and the nesting survives as geometry
 * rather than as structure it would have to reconstruct. The tagged-PDF tree
 * (SPEC 28.8) is rebuilt from `indent`/`quoteDepth`/`listOrdinal` at write time,
 * so nothing is lost.
 *
 * ## What flowing does *not* do
 *
 * It does not measure. Nothing here needs a font, and nothing here is allowed to
 * look at the page size: the same {@link FlowItem}s must flow into A4 portrait
 * and A3 landscape. Measurement is `paginate.ts`.
 *
 * A visual block arrives as one atomic {@link VisualItem} holding the
 * `ResolvedBlock` itself, never a pre-rendered scene — the scene is produced by
 * the *same* `layoutBlock` the screen calls, at the print column width, in the
 * paginator (SPEC 28.5).
 */

import type {
  AttrMap,
  AttrValue,
  Blockquote,
  Code,
  FootnoteDefinition,
  Heading,
  List,
  ListItem,
  MdvBlock,
  MdvContent,
  MdvDirective,
  MdvError,
  Paragraph,
  PhrasingContent,
  RootContent,
  Table as MdTable,
} from '@mdv/parser';
import type { ResolvedBlock, ResolvedDocument } from '@mdv/core';
import type { TextRun } from './text.js';

// ─────────────────────────────────────────────────────────────────────────────
// Items
// ─────────────────────────────────────────────────────────────────────────────

/** Properties every flow item carries. */
export interface FlowBase {
  /** Left indent in *steps* (`DocStyle.indentStepPt` each). Lists nest with it. */
  indent: number;
  /** Enclosing `>` depth; the paginator draws one rule per level. */
  quoteDepth: number;
  /** Never leave this item as the last thing on a page (SPEC 28.3 rule 3). */
  keepWithNext: boolean;
  /**
   * Items sharing a group are atomic: they move to the next page together. Used
   * for a figure and its caption, and for a callout's title and body.
   */
  group: string | undefined;
  /** A named destination for `:mdv-ref[]` and the outline, if this item is one. */
  anchor: string | undefined;
}

/** A Markdown heading. Becomes an outline entry and a `/H1`–`/H6` tag. */
export interface HeadingItem extends FlowBase {
  kind: 'heading';
  level: 1 | 2 | 3 | 4 | 5 | 6;
  runs: readonly TextRun[];
  /** Plain text, for the bookmark label and the TOC. */
  text: string;
  /** Slug used as the link destination. */
  id: string;
}

/** The role a paragraph plays, which picks its {@link TextStyle}. */
export type ParagraphRole =
  | 'body'
  | 'caption'
  | 'subheading'
  | 'footnote'
  | 'callout'
  | 'listItem';

/** Any run of prose: body text, a list item, a caption, a footnote body. */
export interface ParagraphItem extends FlowBase {
  kind: 'paragraph';
  role: ParagraphRole;
  runs: readonly TextRun[];
  /** List marker (`•`, `3.`), drawn in the gutter to the left of the text. */
  marker: string | undefined;
  /** 1-based position in an ordered list, for the `/LI` tag; `undefined` if none. */
  listOrdinal: number | undefined;
  /** `'ordered' | 'bullet'` when this item opens a list item, else `undefined`. */
  listKind: 'ordered' | 'bullet' | undefined;
  /** Callout kind, for the accent rule. */
  callout: 'note' | 'tip' | 'warning' | 'danger' | undefined;
}

/** A fenced or indented code block. Never wrapped; long lines overflow. */
export interface CodeItem extends FlowBase {
  kind: 'code';
  lines: readonly string[];
  lang: string | undefined;
}

/** A thematic break. */
export interface RuleItem extends FlowBase {
  kind: 'rule';
}

/** One cell of a GFM table. */
export interface FlowCell {
  runs: readonly TextRun[];
}

/** A GFM table. Split at row boundaries by the paginator (SPEC 28.3 rule 4). */
export interface TableItem extends FlowBase {
  kind: 'table';
  head: readonly FlowCell[];
  rows: readonly (readonly FlowCell[])[];
  align: readonly ('left' | 'right' | 'center')[];
  /** "Table 3" plus any caption; `(continued)` is appended on later pages. */
  label: string | undefined;
  caption: string | undefined;
}

/**
 * A visual block. **Atomic** (SPEC 28.3 rule 2): the paginator lays it out with
 * `layoutBlock` at the column width and never splits the result.
 */
export interface VisualItem extends FlowBase {
  kind: 'visual';
  block: ResolvedBlock;
  /** "Figure 2", from the numbering pass; `undefined` for an unlabelled block. */
  label: string | undefined;
  /** `pdf: {break, scale}` on the block (SPEC 28.4). */
  breakBefore: boolean;
  breakAfter: boolean;
  breakAvoid: boolean;
  /** Author scale factor, 0 < scale ≤ 1; `undefined` means fit the column. */
  scale: number | undefined;
}

/** `:::mdv-page{break= orientation= size=}` (SPEC 28.4). Draws nothing. */
export interface PageControlItem extends FlowBase {
  kind: 'page';
  breakKind: 'before' | 'after' | 'avoid' | undefined;
  orientation: 'portrait' | 'landscape' | undefined;
  size: string | undefined;
}

/** Everything the paginator can place. */
export type FlowItem =
  | HeadingItem
  | ParagraphItem
  | CodeItem
  | RuleItem
  | TableItem
  | VisualItem
  | PageControlItem;

/** A footnote, keyed by its marker. */
export interface FlowNote {
  /** The printed marker, `1`, `2`, … in first-reference order. */
  marker: string;
  /** The definition identifier from the source. */
  id: string;
  /** The note body, already flattened. */
  body: readonly FlowItem[];
}

/** A named destination: heading anchors, figure ids, footnote definitions. */
export interface FlowTarget {
  /** Destination name, unique in the document. */
  name: string;
  /** The label `:mdv-ref[]` prints, e.g. `Figure 3` or `§2.1`. */
  label: string;
}

/** The whole document, flattened. */
export interface FlowDocument {
  items: readonly FlowItem[];
  /** Footnotes in first-reference order. */
  notes: readonly FlowNote[];
  /** Everything `:mdv-ref[]` can point at, by name. */
  targets: ReadonlyMap<string, FlowTarget>;
  /** Distinct external URLs in first-use order, for the link appendix (28.7). */
  externalLinks: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute helpers
// ─────────────────────────────────────────────────────────────────────────────

function attrString(attrs: AttrMap | undefined, key: string): string | undefined {
  const raw: AttrValue | undefined = attrs?.[key];
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number') return numberToString(raw);
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return undefined;
}

/** `String(n)` without the locale, and without `1e+21` for large integers. */
function numberToString(value: number): string {
  if (!Number.isFinite(value)) return '';
  return Number.isInteger(value) && Math.abs(value) < 1e21 ? value.toFixed(0) : String(value);
}

function attrNumber(attrs: AttrMap | undefined, key: string): number | undefined {
  const raw: AttrValue | undefined = attrs?.[key];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function attrMap(attrs: AttrMap | undefined, key: string): AttrMap | undefined {
  const raw: AttrValue | undefined = attrs?.[key];
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) return raw as AttrMap;
  return undefined;
}

/**
 * Read `pdf: {break, scale}` off a block (SPEC 28.4).
 *
 * `BlockAttrs` has no `pdf` field — the attribute is PDF-only and core's type
 * stops at the shared surface — so it arrives through the index signature and is
 * validated here rather than trusted.
 *
 * *CONTRACT: `packages/core/src/types/attrs.ts` `BlockAttrs` should gain
 * `pdf?: { break?: 'before' | 'after' | 'avoid'; scale?: number }`.*
 */
function blockPdfAttrs(block: ResolvedBlock): {
  breakKind: 'before' | 'after' | 'avoid' | undefined;
  scale: number | undefined;
} {
  const raw: unknown = (block.attrs as { pdf?: unknown }).pdf;
  if (raw === null || typeof raw !== 'object') return { breakKind: undefined, scale: undefined };
  const record = raw as Record<string, unknown>;
  const breakRaw = record['break'];
  const breakKind =
    breakRaw === 'before' || breakRaw === 'after' || breakRaw === 'avoid' ? breakRaw : undefined;
  const scaleRaw = record['scale'];
  const scaleNumber =
    typeof scaleRaw === 'number'
      ? scaleRaw
      : typeof scaleRaw === 'string'
        ? Number.parseFloat(scaleRaw)
        : Number.NaN;
  const scale =
    Number.isFinite(scaleNumber) && scaleNumber > 0 && scaleNumber <= 1 ? scaleNumber : undefined;
  return { breakKind, scale };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slugs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GitHub-style slug, minus the Unicode-aware lowercasing.
 *
 * `toLowerCase()` without an argument uses the *default* case mapping, not the
 * host locale, so it is deterministic (SPEC 24.3 rule 3); `toLocaleLowerCase`
 * would not be — in `tr`, `I` lowercases to `ı`.
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return base === '' ? 'section' : base;
}

/** Make `name` unique within `seen`, appending `-1`, `-2`, … as GitHub does. */
function unique(name: string, seen: Map<string, number>): string {
  const used = seen.get(name);
  if (used === undefined) {
    seen.set(name, 0);
    return name;
  }
  const next = used + 1;
  seen.set(name, next);
  return `${name}-${next}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline content
// ─────────────────────────────────────────────────────────────────────────────

interface InlineStyle {
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  strike?: boolean;
  href?: string;
  dest?: string;
}

/** Collector shared by the whole walk. */
interface Ctx {
  items: FlowItem[];
  /** Footnote definitions by identifier, filled on the first pass. */
  definitions: Map<string, FootnoteDefinition>;
  /** Footnote markers in first-reference order. */
  noteOrder: string[];
  targets: Map<string, FlowTarget>;
  slugs: Map<string, number>;
  externalLinks: string[];
  externalSeen: Set<string>;
  /** `:mdv-ref[name]` sites, patched once numbering is known. */
  pendingRefs: { run: { text: string }; name: string }[];
  /** Visual blocks by AST node, so a block keeps the resolve-stage identity. */
  blocks: Map<MdvBlock, ResolvedBlock>;
  /** Figure/table counters, and the section prefix from `numbering.restartAt`. */
  restartAt: number;
  sectionCounter: number;
  figureCounter: number;
  tableCounter: number;
  /** Level 1 by default; `undefined` when nothing restarts. */
  labels: { figure: string; table: string };
}

/** Convert phrasing content to runs. Unknown inline nodes contribute their text. */
function inlineRuns(nodes: readonly PhrasingContent[], ctx: Ctx, style: InlineStyle): TextRun[] {
  const out: TextRun[] = [];
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        push(out, node.value, style);
        break;
      case 'inlineCode':
        push(out, node.value, { ...style, mono: true });
        break;
      case 'strong':
        out.push(...inlineRuns(node.children, ctx, { ...style, bold: true }));
        break;
      case 'emphasis':
        out.push(...inlineRuns(node.children, ctx, { ...style, italic: true }));
        break;
      case 'delete':
        out.push(...inlineRuns(node.children, ctx, { ...style, strike: true }));
        break;
      case 'link': {
        const url = node.url;
        const next: InlineStyle = { ...style };
        if (url.startsWith('#')) next.dest = url.slice(1);
        else {
          next.href = url;
          if (!ctx.externalSeen.has(url)) {
            ctx.externalSeen.add(url);
            ctx.externalLinks.push(url);
          }
        }
        out.push(...inlineRuns(node.children, ctx, next));
        break;
      }
      case 'linkReference':
      case 'imageReference':
        // The definition is not resolved here; the visible text is what the
        // reader saw on screen, so it is what the page shows.
        out.push(...inlineRuns(node.type === 'linkReference' ? node.children : [], ctx, style));
        if (node.type === 'imageReference') push(out, node.alt ?? '', style);
        break;
      case 'image':
        // An inline raster in prose has no place in the text column; the alt
        // text carries the meaning, which is what a screen reader gets too.
        push(out, node.alt ?? '', { ...style, italic: true });
        break;
      case 'break':
        push(out, '\n', style);
        break;
      case 'footnoteReference': {
        const marker = noteMarker(ctx, node.identifier);
        out.push({ text: marker, superscript: true, dest: `note-${node.identifier}` });
        break;
      }
      case 'html':
        // HTML is not executed and not parsed (SPEC 25); it is shown verbatim so
        // the reader can see what the source said.
        push(out, node.value, { ...style, mono: true });
        break;
      case 'mdvDirective':
        out.push(...inlineDirective(node, ctx, style));
        break;
      default:
        break;
    }
  }
  return out;
}

function push(out: TextRun[], text: string, style: InlineStyle): void {
  if (text === '') return;
  const run: TextRun = { text };
  if (style.bold === true) run.bold = true;
  if (style.italic === true) run.italic = true;
  if (style.mono === true) run.mono = true;
  if (style.strike === true) run.strike = true;
  if (style.href !== undefined) run.href = style.href;
  if (style.dest !== undefined) run.dest = style.dest;
  out.push(run);
}

/**
 * Inline directives (SPEC 9.2).
 *
 * `mdv-ref` is resolved in a second pass, because a reference may point forward.
 * `mdv-spark` is the one construct with no print form: SPEC 15.2 says an
 * unsupported construct degrades to its source text rather than vanishing, and
 * that is what happens here, reported by the caller as `MDV1503`.
 */
function inlineDirective(node: MdvDirective, ctx: Ctx, style: InlineStyle): TextRun[] {
  const label = node.label ?? '';
  switch (node.name) {
    case 'mdv-ref': {
      // Placeholder text, rewritten by `resolveRefs` once every target is known.
      const run: TextRun = { text: label, dest: label };
      if (style.bold === true) run.bold = true;
      ctx.pendingRefs.push({ run, name: label });
      return [run];
    }
    case 'mdv-metric':
    case 'mdv-value':
    case 'mdv-delta': {
      // The screen renders these through the same formatter as the charts. That
      // formatter is stage 5 and is not reachable from here without re-running
      // encode, so the *authored* text is printed — never a blank.
      const out: TextRun[] = [];
      push(out, label, style);
      return out;
    }
    case 'mdv-badge': {
      const out: TextRun[] = [];
      push(out, `[${label}]`, { ...style, bold: true });
      return out;
    }
    default: {
      const out: TextRun[] = [];
      const attrs = renderAttrs(node.attrs);
      push(out, `:${node.name}[${label}]${attrs}`, { ...style, mono: true });
      return out;
    }
  }
}

/** Re-serialise an attribute map for a directive shown as literal source. */
function renderAttrs(attrs: AttrMap): string {
  const keys = Object.keys(attrs);
  if (keys.length === 0) return '';
  const parts: string[] = [];
  for (const key of keys) {
    const value = attrString(attrs, key);
    if (value === undefined) continue;
    parts.push(`${key}=${value}`);
  }
  return parts.length === 0 ? '' : `{${parts.join(' ')}}`;
}

/** Allocate (or recall) the printed marker for a footnote identifier. */
function noteMarker(ctx: Ctx, identifier: string): string {
  const existing = ctx.noteOrder.indexOf(identifier);
  if (existing >= 0) return String(existing + 1);
  ctx.noteOrder.push(identifier);
  return String(ctx.noteOrder.length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Block content
// ─────────────────────────────────────────────────────────────────────────────

interface Frame {
  indent: number;
  quoteDepth: number;
  group: string | undefined;
  callout: 'note' | 'tip' | 'warning' | 'danger' | undefined;
}

const ROOT_FRAME: Frame = { indent: 0, quoteDepth: 0, group: undefined, callout: undefined };

function base(frame: Frame, over: Partial<FlowBase> = {}): FlowBase {
  return {
    indent: frame.indent,
    quoteDepth: frame.quoteDepth,
    keepWithNext: false,
    group: frame.group,
    anchor: undefined,
    ...over,
  };
}

function walk(nodes: readonly MdvContent[], ctx: Ctx, frame: Frame): void {
  for (const node of nodes) walkOne(node, ctx, frame);
}

function walkOne(node: MdvContent | RootContent, ctx: Ctx, frame: Frame): void {
  switch (node.type) {
    case 'heading':
      emitHeading(node, ctx, frame);
      return;
    case 'paragraph':
      emitParagraph(node, ctx, frame);
      return;
    case 'thematicBreak':
      ctx.items.push({ ...base(frame), kind: 'rule' });
      return;
    case 'code':
      emitCode(node, ctx, frame);
      return;
    case 'blockquote':
      emitQuote(node, ctx, frame);
      return;
    case 'list':
      emitList(node, ctx, frame);
      return;
    case 'table':
      emitTable(node, ctx, frame);
      return;
    case 'html':
      emitCode(
        { type: 'code', value: node.value, lang: null, meta: null } as Code,
        ctx,
        frame,
      );
      return;
    case 'mdvBlock':
      emitVisual(node, ctx, frame);
      return;
    case 'mdvDirective':
      emitDirective(node, ctx, frame);
      return;
    case 'mdvError':
      emitError(node, ctx, frame);
      return;
    case 'footnoteDefinition':
      // Collected before the walk; the body is emitted at the foot of a page.
      return;
    case 'definition':
    case 'yaml':
      return;
    default:
      return;
  }
}

function emitHeading(node: Heading, ctx: Ctx, frame: Frame): void {
  const runs = inlineRuns(node.children, ctx, {});
  const text = runsText(runs);
  const level = clampLevel(node.depth);
  const id = unique(slugify(text), ctx.slugs);
  if (level <= ctx.restartAt) {
    ctx.sectionCounter += 1;
    ctx.figureCounter = 0;
    ctx.tableCounter = 0;
  }
  ctx.targets.set(id, { name: id, label: `§${text}` });
  ctx.items.push({
    ...base(frame, { keepWithNext: true, anchor: id }),
    kind: 'heading',
    level,
    runs,
    text,
    id,
  });
}

function clampLevel(depth: number): 1 | 2 | 3 | 4 | 5 | 6 {
  const n = Math.min(Math.max(Math.trunc(depth), 1), 6);
  return n as 1 | 2 | 3 | 4 | 5 | 6;
}

function emitParagraph(node: Paragraph, ctx: Ctx, frame: Frame): void {
  const runs = inlineRuns(node.children, ctx, {});
  if (runs.length === 0) return;
  ctx.items.push(paragraph(runs, ctx, frame, 'body'));
}

function paragraph(
  runs: readonly TextRun[],
  _ctx: Ctx,
  frame: Frame,
  role: ParagraphRole,
  over: Partial<ParagraphItem> = {},
): ParagraphItem {
  return {
    ...base(frame),
    kind: 'paragraph',
    role,
    runs,
    marker: undefined,
    listOrdinal: undefined,
    listKind: undefined,
    callout: frame.callout,
    ...over,
  };
}

function emitCode(node: Code, ctx: Ctx, frame: Frame): void {
  const lines = node.value.split('\n');
  const item: CodeItem = {
    ...base(frame),
    kind: 'code',
    lines,
    lang: node.lang ?? undefined,
  };
  ctx.items.push(item);
}

function emitQuote(node: Blockquote, ctx: Ctx, frame: Frame): void {
  walk(node.children as MdvContent[], ctx, { ...frame, quoteDepth: frame.quoteDepth + 1 });
}

/**
 * Flatten a list.
 *
 * The marker goes on the first *paragraph* of the item, and every later child
 * of the same item is indented to the same text edge — which is what makes a
 * paragraph continuation, a nested list or a code block inside a list item line
 * up under the text rather than under the bullet.
 */
function emitList(node: List, ctx: Ctx, frame: Frame): void {
  const ordered = node.ordered === true;
  let counter = typeof node.start === 'number' ? node.start : 1;
  for (const child of node.children) {
    emitListItem(child, ctx, frame, ordered, counter);
    counter += 1;
  }
}

/** Bullets by depth, cycling. Chosen from WinAnsi so the standard 14 cover them. */
const BULLETS = ['•', '◦', '▪'] as const;

function emitListItem(
  item: ListItem,
  ctx: Ctx,
  frame: Frame,
  ordered: boolean,
  ordinal: number,
): void {
  const inner: Frame = { ...frame, indent: frame.indent + 1 };
  const marker = ordered
    ? `${ordinal}.`
    : item.checked === true
      ? '☑'
      : item.checked === false
        ? '☐'
        : (BULLETS[frame.indent % BULLETS.length] ?? '•');
  const before = ctx.items.length;
  walk(item.children as MdvContent[], ctx, inner);
  const first = ctx.items[before];
  if (first === undefined) {
    // An empty list item still occupies a line, otherwise the numbering lies.
    ctx.items.push(
      paragraph([], ctx, inner, 'listItem', {
        marker,
        listOrdinal: ordered ? ordinal : undefined,
        listKind: ordered ? 'ordered' : 'bullet',
      }),
    );
    return;
  }
  if (first.kind === 'paragraph') {
    const replacement: ParagraphItem = {
      ...first,
      role: 'listItem',
      marker,
      listOrdinal: ordered ? ordinal : undefined,
      listKind: ordered ? 'ordered' : 'bullet',
    };
    ctx.items[before] = replacement;
    return;
  }
  // A list item that opens with a table, a chart or a code block: give the
  // marker its own line rather than hanging it off something unsplittable.
  ctx.items.splice(
    before,
    0,
    paragraph([], ctx, inner, 'listItem', {
      marker,
      listOrdinal: ordered ? ordinal : undefined,
      listKind: ordered ? 'ordered' : 'bullet',
      keepWithNext: true,
    }),
  );
}

function emitTable(node: MdTable, ctx: Ctx, frame: Frame): void {
  const align: ('left' | 'right' | 'center')[] = (node.align ?? []).map((a) =>
    a === 'right' ? 'right' : a === 'center' ? 'center' : 'left',
  );
  const rows = node.children;
  const headRow = rows[0];
  const head: FlowCell[] =
    headRow === undefined
      ? []
      : headRow.children.map((cell) => ({ runs: inlineRuns(cell.children, ctx, { bold: true }) }));
  const body: FlowCell[][] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    if (row === undefined) continue;
    body.push(row.children.map((cell) => ({ runs: inlineRuns(cell.children, ctx, {}) })));
  }
  while (align.length < head.length) align.push('left');
  ctx.tableCounter += 1;
  ctx.items.push({
    ...base(frame),
    kind: 'table',
    head,
    rows: body,
    align,
    label: counterLabel(ctx, 'table'),
    caption: undefined,
  });
}

function counterLabel(ctx: Ctx, kind: 'figure' | 'table'): string {
  const n = kind === 'figure' ? ctx.figureCounter : ctx.tableCounter;
  const word = kind === 'figure' ? ctx.labels.figure : ctx.labels.table;
  return ctx.restartAt > 0 && ctx.sectionCounter > 0
    ? `${word} ${ctx.sectionCounter}.${n}`
    : `${word} ${n}`;
}

function emitVisual(node: MdvBlock, ctx: Ctx, frame: Frame): void {
  const block = ctx.blocks.get(node);
  if (block === undefined) {
    // Resolve produces one ResolvedBlock per mdvBlock; a missing one means the
    // caller handed us a document whose AST and block list disagree. Show the
    // source rather than dropping the block silently (SPEC 14.1 principle 2).
    emitCode(
      { type: 'code', value: `${node.raw.header}\n---\n${node.raw.data}`, lang: null, meta: null } as Code,
      ctx,
      frame,
    );
    return;
  }
  const pdf = blockPdfAttrs(block);
  const caption = typeof block.attrs.caption === 'string' ? block.attrs.caption : undefined;
  const labelled = caption !== undefined && caption !== '';
  if (labelled) ctx.figureCounter += 1;
  const label = labelled ? counterLabel(ctx, 'figure') : undefined;
  const anchor = block.id;
  ctx.targets.set(anchor, { name: anchor, label: label ?? blockTitle(block) ?? anchor });
  ctx.items.push({
    ...base(frame, { anchor }),
    kind: 'visual',
    block,
    label,
    breakBefore: pdf.breakKind === 'before',
    breakAfter: pdf.breakKind === 'after',
    breakAvoid: pdf.breakKind === 'avoid',
    scale: pdf.scale,
  });
}

function blockTitle(block: ResolvedBlock): string | undefined {
  const title = block.attrs.title;
  return typeof title === 'string' && title !== '' ? title : undefined;
}

function emitError(node: MdvError, ctx: Ctx, frame: Frame): void {
  ctx.items.push(
    paragraph([{ text: node.diagnostic.message, bold: true }], ctx, frame, 'body'),
  );
  emitCode({ type: 'code', value: node.raw, lang: null, meta: null } as Code, ctx, frame);
}

/**
 * Container directives (SPEC 9.1) in print.
 *
 * SPEC 28.3 rule 6 is explicit about the two that behave differently on paper:
 * every `mdv-tab` renders in sequence with its title as a subheading, and
 * `mdv-details` renders expanded. Layout containers (`mdv-grid`,
 * `mdv-columns`) flatten to a single column, because a printed page has one
 * column of flow and a two-up grid that breaks across a page boundary is worse
 * than a stack. An unknown directive renders its children (`MDV1503`).
 */
function emitDirective(node: MdvDirective, ctx: Ctx, frame: Frame): void {
  const children = (node.children ?? []) as MdvContent[];
  switch (node.name) {
    case 'mdv-page': {
      const breakRaw = attrString(node.attrs, 'break');
      const orientationRaw = attrString(node.attrs, 'orientation');
      ctx.items.push({
        ...base(frame),
        kind: 'page',
        breakKind:
          breakRaw === 'before' || breakRaw === 'after' || breakRaw === 'avoid'
            ? breakRaw
            : undefined,
        orientation:
          orientationRaw === 'landscape' || orientationRaw === 'portrait'
            ? orientationRaw
            : undefined,
        size: attrString(node.attrs, 'size'),
      });
      walk(children, ctx, frame);
      return;
    }
    case 'mdv-figure': {
      const id = attrString(node.attrs, 'id');
      const caption = attrString(node.attrs, 'caption');
      const word = attrString(node.attrs, 'label') ?? ctx.labels.figure;
      ctx.figureCounter += 1;
      const n = ctx.figureCounter;
      const label =
        ctx.restartAt > 0 && ctx.sectionCounter > 0
          ? `${word} ${ctx.sectionCounter}.${n}`
          : `${word} ${n}`;
      const group = `fig-${n}`;
      const anchor = id ?? unique(slugify(label), ctx.slugs);
      ctx.targets.set(anchor, { name: anchor, label });
      const inner: Frame = { ...frame, group };
      const start = ctx.items.length;
      walk(children, ctx, inner);
      const first = ctx.items[start];
      if (first !== undefined) ctx.items[start] = { ...first, anchor } as FlowItem;
      if (caption !== undefined && caption !== '') {
        ctx.items.push(
          paragraph([{ text: `${label}. `, bold: true }, { text: caption }], ctx, inner, 'caption'),
        );
      }
      return;
    }
    case 'mdv-tabs': {
      for (const child of children) {
        if (child.type === 'mdvDirective' && child.name === 'mdv-tab') {
          const title = attrString(child.attrs, 'title') ?? child.label ?? '';
          if (title !== '') {
            ctx.items.push(
              paragraph([{ text: title }], ctx, frame, 'subheading', { keepWithNext: true }),
            );
          }
          walk((child.children ?? []) as MdvContent[], ctx, frame);
        } else {
          walkOne(child, ctx, frame);
        }
      }
      return;
    }
    case 'mdv-tab': {
      const title = attrString(node.attrs, 'title') ?? node.label ?? '';
      if (title !== '') {
        ctx.items.push(
          paragraph([{ text: title }], ctx, frame, 'subheading', { keepWithNext: true }),
        );
      }
      walk(children, ctx, frame);
      return;
    }
    case 'mdv-details': {
      const summary = attrString(node.attrs, 'summary') ?? node.label ?? '';
      if (summary !== '') {
        ctx.items.push(
          paragraph([{ text: summary }], ctx, frame, 'subheading', { keepWithNext: true }),
        );
      }
      walk(children, ctx, frame);
      return;
    }
    case 'mdv-callout': {
      const typeRaw = attrString(node.attrs, 'type');
      const kind =
        typeRaw === 'tip' || typeRaw === 'warning' || typeRaw === 'danger' ? typeRaw : 'note';
      const title = attrString(node.attrs, 'title');
      const group = `callout-${ctx.items.length}`;
      const inner: Frame = { ...frame, callout: kind, group };
      // Status is never colour alone (SPEC 16.2): the label is printed.
      const heading = title === undefined || title === '' ? CALLOUT_LABEL[kind] : title;
      ctx.items.push(
        paragraph([{ text: `${CALLOUT_ICON[kind]} ${heading}` }], ctx, inner, 'subheading', {
          keepWithNext: true,
        }),
      );
      walk(children, ctx, inner);
      return;
    }
    default:
      // `mdv-grid`, `mdv-columns` and anything unknown: children as content.
      walk(children, ctx, frame);
      return;
  }
}

const CALLOUT_LABEL: Readonly<Record<'note' | 'tip' | 'warning' | 'danger', string>> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
};

/** WinAnsi-safe marks; a glyph the standard 14 lack would be `MDV5100` noise. */
const CALLOUT_ICON: Readonly<Record<'note' | 'tip' | 'warning' | 'danger', string>> = {
  note: 'i',
  tip: '*',
  warning: '!',
  danger: '×',
};

/** Flatten runs to plain text, for bookmarks, the TOC and `/Alt`. */
export function runsText(runs: readonly TextRun[]): string {
  let out = '';
  for (const run of runs) out += run.text;
  return out.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

/** Options that change the flow itself, as opposed to how it is measured. */
export interface FlowOptions {
  /**
   * `numbering.restartAt` (SPEC 28.2): `'h1'`…`'h6'`. Figure and table counters
   * restart at that heading level and their labels gain the section number.
   */
  restartAt?: string | undefined;
  /** Word used for figures. Defaults to `Figure`; there is no localisation. */
  figureWord?: string;
  /** Word used for tables. Defaults to `Table`. */
  tableWord?: string;
}

/**
 * Flatten a resolved document into flow items.
 *
 * Pure and total: every AST node either becomes an item or is deliberately
 * dropped (front matter, link definitions), and nothing throws on content.
 */
export function buildFlow(doc: ResolvedDocument, options: FlowOptions = {}): FlowDocument {
  const restartMatch = /^h([1-6])$/.exec(options.restartAt ?? '');
  const blocks = new Map<MdvBlock, ResolvedBlock>();
  for (const block of doc.blocks) blocks.set(block.node, block);

  const ctx: Ctx = {
    items: [],
    definitions: new Map<string, FootnoteDefinition>(),
    noteOrder: [],
    targets: new Map<string, FlowTarget>(),
    slugs: new Map<string, number>(),
    externalLinks: [],
    externalSeen: new Set<string>(),
    pendingRefs: [],
    blocks,
    restartAt: restartMatch === null ? 0 : Number.parseInt(restartMatch[1] ?? '1', 10),
    sectionCounter: 0,
    figureCounter: 0,
    tableCounter: 0,
    labels: { figure: options.figureWord ?? 'Figure', table: options.tableWord ?? 'Table' },
  };

  collectDefinitions(doc.ast.children, ctx);
  walk(doc.ast.children, ctx, ROOT_FRAME);

  const notes = buildNotes(ctx);
  resolveRefs(ctx);

  return {
    items: ctx.items,
    notes,
    targets: ctx.targets,
    externalLinks: ctx.externalLinks,
  };
}

/** Footnote definitions may appear anywhere, including after their reference. */
function collectDefinitions(nodes: readonly MdvContent[], ctx: Ctx): void {
  for (const node of nodes) {
    if (node.type === 'footnoteDefinition') {
      ctx.definitions.set(node.identifier, node);
      continue;
    }
    const children = (node as { children?: unknown }).children;
    if (Array.isArray(children)) collectDefinitions(children as MdvContent[], ctx);
  }
}

/** Flatten each referenced note's body, in first-reference order. */
function buildNotes(ctx: Ctx): FlowNote[] {
  const notes: FlowNote[] = [];
  // Iterating `noteOrder` (an array built in reference order) rather than the
  // definition map keeps numbering independent of source order — SPEC 24.3
  // rule 5 wants iteration order to be data-derived, and the data here is the
  // order the reader meets the markers in.
  for (let i = 0; i < ctx.noteOrder.length; i += 1) {
    const id = ctx.noteOrder[i];
    if (id === undefined) continue;
    const marker = String(i + 1);
    const definition = ctx.definitions.get(id);
    const saved = ctx.items;
    ctx.items = [];
    if (definition !== undefined) {
      walk(definition.children as MdvContent[], ctx, {
        indent: 0,
        quoteDepth: 0,
        group: `note-${id}`,
        callout: undefined,
      });
    } else {
      ctx.items.push(
        paragraph([{ text: `Undefined note [^${id}]`, italic: true }], ctx, ROOT_FRAME, 'footnote'),
      );
    }
    const body = ctx.items.map((item) =>
      item.kind === 'paragraph' ? ({ ...item, role: 'footnote' } as FlowItem) : item,
    );
    ctx.items = saved;
    ctx.targets.set(`note-${id}`, { name: `note-${id}`, label: marker });
    notes.push({ marker, id, body });
  }
  return notes;
}

/**
 * Second pass for `:mdv-ref[]` (SPEC 28.7).
 *
 * A reference to a target that does not exist prints the name in brackets rather
 * than an empty gap — a silent hole is the one outcome SPEC 14.1 forbids.
 */
function resolveRefs(ctx: Ctx): void {
  for (const pending of ctx.pendingRefs) {
    const target = ctx.targets.get(pending.name);
    pending.run.text = target === undefined ? `[${pending.name}?]` : target.label;
  }
}

/**
 * The MDV editor document model.
 *
 * ## Design rules
 *
 * 1. **Plain data.** Every node is a plain object of strings, numbers, booleans,
 *    `null`, arrays and nested plain objects. No classes, no `Symbol`s, no
 *    functions, no `undefined` values. That makes the whole tree
 *    `structuredClone`-able, `JSON.stringify`-able and cheap to diff.
 * 2. **Immutable by default.** Everything is declared `readonly`. Commands
 *    never mutate; they build a new tree that shares untouched subtrees.
 * 3. **Optional means `null`, not missing.** `exactOptionalPropertyTypes` makes
 *    `{ title?: string }` genuinely awkward to construct; the model therefore
 *    uses explicit `| null` fields so a node literal always lists every key.
 * 4. **Source fidelity fields.** Nodes that could be written several ways carry
 *    the chosen spelling (`bullet`, `delimiter`, `marker`, `fence`, `style`) so
 *    `read` → `write` is stable rather than "normalising" the author's file out
 *    from under them.
 *
 * This model is intentionally *not* mdast and shares no code with the MDV
 * parser: an editor needs stable node identity, cheap structural sharing and a
 * lossless raw-block escape hatch, none of which a parse-only AST provides.
 */

import type { NodeId } from './ids.js';

/* -------------------------------------------------------------------------- */
/* Inline content                                                              */
/* -------------------------------------------------------------------------- */

/** Strong emphasis — written `**text**`. */
export interface StrongMark {
  readonly type: 'strong';
}
/** Emphasis — written `*text*`. */
export interface EmphasisMark {
  readonly type: 'emphasis';
}
/** Inline code — written with backtick fences. Excludes all other marks. */
export interface CodeMark {
  readonly type: 'code';
}
/** GFM strikethrough — written `~~text~~`. */
export interface StrikethroughMark {
  readonly type: 'strikethrough';
}
/** A hyperlink — written `[text](href "title")`. */
export interface LinkMark {
  readonly type: 'link';
  readonly href: string;
  /** `null` when the link has no title attribute. */
  readonly title: string | null;
}

/** A formatting attribute carried by a {@link TextRun}. */
export type Mark = StrongMark | EmphasisMark | CodeMark | StrikethroughMark | LinkMark;

/** Discriminator of {@link Mark}. */
export type MarkType = Mark['type'];

/**
 * A contiguous span of characters sharing one mark set.
 *
 * `text` is the *logical* text: offsets in a {@link Point} index into it with
 * UTF-16 code units, exactly like the DOM does, so mapping to and from a
 * contenteditable surface needs no translation table.
 */
export interface TextRun {
  readonly kind: 'text';
  readonly id: NodeId;
  readonly text: string;
  /** Canonically ordered — see `sortMarks` in `inline.ts`. */
  readonly marks: readonly Mark[];
}

/**
 * An atomic span whose source text the engine preserves verbatim.
 *
 * Produced by the reader for constructs it understands well enough to keep but
 * not well enough to edit: inline directives (`:mdv-value[…]{…}`), `$math$`,
 * inline images, autolinks, footnote references, hard line breaks. The writer
 * emits {@link source} unescaped; the editor treats the run as a single
 * indivisible character for caret movement and deletion.
 */
export interface RawRun {
  readonly kind: 'raw';
  readonly id: NodeId;
  /** Verbatim MDV source, emitted as-is. */
  readonly source: string;
  /** Plain-text projection used for copy, search and accessibility. */
  readonly text: string;
}

/** One element of a block's inline content. */
export type Run = TextRun | RawRun;

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

/** Heading levels permitted by CommonMark ATX and MDV. */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** How a fenced construct was spelled, so `write` can reproduce it. */
export interface FenceStyle {
  readonly style: 'backtick' | 'tilde';
  /** Number of fence characters; always ≥ 3. */
  readonly length: number;
}

/** A paragraph of inline content. */
export interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly id: NodeId;
  readonly runs: readonly Run[];
}

/** An ATX (`## x`) or setext (`x` / `---`) heading. */
export interface HeadingBlock {
  readonly kind: 'heading';
  readonly id: NodeId;
  readonly level: HeadingLevel;
  /** Setext is only representable for levels 1 and 2; `write` falls back to ATX. */
  readonly style: 'atx' | 'setext';
  readonly runs: readonly Run[];
}

/**
 * One item of a list.
 *
 * Items hold *blocks*, not runs: that is what makes multi-paragraph items and
 * nested lists fall out for free — a nested list is just a {@link ListBlock}
 * inside `blocks`.
 */
export interface ListItem {
  readonly id: NodeId;
  /** GFM task state; `null` when the item is not a task item. */
  readonly checked: boolean | null;
  readonly blocks: readonly Block[];
}

/** A bullet list. */
export interface BulletListBlock {
  readonly kind: 'list';
  readonly id: NodeId;
  readonly ordered: false;
  readonly bullet: '-' | '*' | '+';
  /** Tight lists render without inter-item blank lines. */
  readonly tight: boolean;
  readonly items: readonly ListItem[];
}

/** An ordered list. */
export interface OrderedListBlock {
  readonly kind: 'list';
  readonly id: NodeId;
  readonly ordered: true;
  /** Number of the first item. */
  readonly start: number;
  readonly delimiter: '.' | ')';
  readonly tight: boolean;
  readonly items: readonly ListItem[];
}

/** A bullet or ordered list. Discriminate on `ordered`. */
export type ListBlock = BulletListBlock | OrderedListBlock;

/** A block quote; children are ordinary blocks. */
export interface BlockquoteBlock {
  readonly kind: 'blockquote';
  readonly id: NodeId;
  readonly children: readonly Block[];
}

/** How a code block was delimited. */
export type CodeFence = FenceStyle | { readonly style: 'indented' };

/** A fenced or indented code block. Contents are opaque text, never inline-parsed. */
export interface CodeBlock {
  readonly kind: 'code';
  readonly id: NodeId;
  /** The full info string (`ts`, `js title=x`, …); empty when absent. */
  readonly info: string;
  /** Body without the trailing newline. */
  readonly text: string;
  readonly fence: CodeFence;
}

/** A thematic break. `marker` is the literal source (`---`, `***`, `___`, …). */
export interface ThematicBreakBlock {
  readonly kind: 'thematicBreak';
  readonly id: NodeId;
  readonly marker: string;
}

/**
 * A standalone image.
 *
 * By explicit product decision images are embedded as `data:` URIs rather than
 * referenced from disk, so a `.mdv` file is self-contained. `width`/`height`
 * are the intrinsic pixel dimensions recorded at ingestion; they are written
 * back as an MDV attribute suffix (`{width=800 height=600}`) so they survive a
 * round trip, and are `null` for images whose size is unknown.
 */
export interface ImageBlock {
  readonly kind: 'image';
  readonly id: NodeId;
  readonly src: string;
  readonly alt: string;
  readonly title: string | null;
  readonly width: number | null;
  readonly height: number | null;
}

/** Per-column alignment, from the GFM delimiter row. */
export type ColumnAlign = 'none' | 'left' | 'center' | 'right';

/** A single table cell. Cells carry inline content only. */
export interface TableCell {
  readonly id: NodeId;
  readonly runs: readonly Run[];
}

/** A table row. Always exactly `align.length` cells — see `table.ts`. */
export interface TableRow {
  readonly id: NodeId;
  readonly cells: readonly TableCell[];
}

/**
 * A GFM table.
 *
 * `rows[0]` is the header row; GFM has no headerless table, so the model does
 * not pretend otherwise. The rectangularity invariant (`every row has
 * align.length cells`) is enforced by every operation in `table.ts`.
 */
export interface TableBlock {
  readonly kind: 'table';
  readonly id: NodeId;
  readonly align: readonly ColumnAlign[];
  /** At least one row (the header). */
  readonly rows: readonly TableRow[];
}

/** An `key=value` pair from a visual block's info string (SPEC 5.2). */
export interface InfoAttribute {
  readonly key: string;
  readonly value: string;
  /** Quoting used in the source, preserved so `write` reproduces it. */
  readonly quote: 'none' | 'double' | 'single';
}

/**
 * An MDV visual block — ```` ```mdv <type> … ```` (SPEC 5).
 *
 * The header and data sections are kept as **verbatim text**, because they are
 * the only representation that is lossless: MDV attribute notation carries
 * comments, quoting styles and multiline scalars that no parsed map can
 * reproduce. `parseAttributes` in `io/attrs.ts` provides the structured view on
 * demand, and `setVisualAttribute` performs surgical edits that leave the rest
 * of the header untouched.
 *
 * `data === null` means **no separator line was present**, which per the SPEC
 * 5.1 determinism rule means the entire body is header. The writer honours that
 * exactly: it emits a `---` line if and only if `data !== null`.
 */
export interface VisualBlock {
  readonly kind: 'visual';
  readonly id: NodeId;
  /** Lowercased block type from the info string; empty when omitted. */
  readonly blockType: string;
  readonly infoAttributes: readonly InfoAttribute[];
  /** Header section, verbatim, without a trailing newline. May be empty. */
  readonly header: string;
  /** Data section, verbatim, without a trailing newline, or `null`. */
  readonly data: string | null;
  readonly fence: FenceStyle;
}

/**
 * Source text the reader chose not to interpret.
 *
 * Container directives (`:::mdv-grid{…}` … `:::`), HTML blocks, link reference
 * definitions and anything else outside the editor's structural vocabulary land
 * here. `text` is written back byte-for-byte, so an unrecognised construct is
 * never silently dropped or mangled — the single most important property of an
 * editor for a format that is still growing.
 */
export interface RawBlock {
  readonly kind: 'raw';
  readonly id: NodeId;
  /** Verbatim source, without a trailing newline. */
  readonly text: string;
}

/** Any block-level node. */
export type Block =
  | ParagraphBlock
  | HeadingBlock
  | ListBlock
  | BlockquoteBlock
  | CodeBlock
  | ThematicBreakBlock
  | ImageBlock
  | TableBlock
  | VisualBlock
  | RawBlock;

/** Discriminator of {@link Block}. */
export type BlockKind = Block['kind'];

/* -------------------------------------------------------------------------- */
/* Document                                                                    */
/* -------------------------------------------------------------------------- */

/** YAML front matter (SPEC 3.4), kept verbatim. */
export interface FrontMatter {
  /** Text between the delimiters, without the surrounding newlines. */
  readonly source: string;
  /** Closing delimiter as written: YAML permits `---` or `...`. */
  readonly terminator: '---' | '...';
}

/** A complete MDV document. */
export interface MdvDocument {
  readonly kind: 'document';
  readonly id: NodeId;
  readonly frontMatter: FrontMatter | null;
  readonly blocks: readonly Block[];
}

/* -------------------------------------------------------------------------- */
/* Narrowing helpers                                                           */
/* -------------------------------------------------------------------------- */

/** Blocks whose inline content is a single flat run list. */
export type RunBlock = ParagraphBlock | HeadingBlock;

/** True when `block` stores its inline content directly in `block.runs`. */
export function isRunBlock(block: Block): block is RunBlock {
  return block.kind === 'paragraph' || block.kind === 'heading';
}

/** Blocks that contain other blocks. */
export type ContainerBlock = ListBlock | BlockquoteBlock;

/** True when `block` nests other blocks. */
export function isContainerBlock(block: Block): block is ContainerBlock {
  return block.kind === 'list' || block.kind === 'blockquote';
}

/**
 * Blocks whose content is one opaque string the caret *can* enter, edited as
 * plain text rather than as marked-up runs.
 */
export type TextBlock = CodeBlock;

/** True when the caret addresses `block` by an offset into `block.text`. */
export function isTextBlock(block: Block): block is TextBlock {
  return block.kind === 'code';
}

/**
 * Blocks with no editable text: the caret can select them but not sit inside
 * them. Deleting into one removes it whole; they are edited through dedicated
 * UI (an image inspector, a chart form) rather than by typing.
 */
export type AtomicBlock = ThematicBreakBlock | ImageBlock | VisualBlock | RawBlock;

/** True when `block` has no position the caret can occupy. */
export function isAtomicBlock(block: Block): block is AtomicBlock {
  return (
    block.kind === 'thematicBreak' ||
    block.kind === 'image' ||
    block.kind === 'visual' ||
    block.kind === 'raw'
  );
}

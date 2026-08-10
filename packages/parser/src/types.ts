/**
 * The MDV AST (SPEC 19) and the diagnostic vocabulary (SPEC 14.2).
 *
 * MDV's AST is an extension of [mdast]. **Standard mdast node types are
 * unchanged** — they are re-exported from here so that no downstream package has
 * to depend on `@types/mdast` directly — and MDV adds exactly four node types:
 * {@link MdvBlock}, {@link MdvDirective}, {@link MdvError}, and the document root
 * {@link MdvDocument}.
 *
 * `Diagnostic` lives in `@mdv/parser` rather than in `@mdv/core` because the
 * parser is the first producer of diagnostics and core depends on the parser, not
 * the other way round.
 *
 * [mdast]: https://github.com/syntax-tree/mdast
 */

import type { Nodes as MdastNodes, PhrasingContent, Root, RootContent } from 'mdast';
import type { Data as UnistData, Node as UnistNode, Parent as UnistParent } from 'unist';

// ─────────────────────────────────────────────────────────────────────────────
// mdast re-exports — standard node types are unchanged (SPEC 19)
// ─────────────────────────────────────────────────────────────────────────────

export type {
  Blockquote,
  Break,
  Code,
  Definition,
  Delete,
  Emphasis,
  FootnoteDefinition,
  FootnoteReference,
  Heading,
  Html,
  Image,
  ImageReference,
  InlineCode,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  TableCell,
  TableRow,
  Text,
  ThematicBreak,
  Yaml,
} from 'mdast';

export type { Node as UnistNode, Parent as UnistParent, Point as UnistPoint } from 'unist';

/**
 * Every node that can appear in an MDV document: the standard mdast content
 * types plus MDV's four additions.
 */
export type MdvContent = RootContent | MdvBlock | MdvDirective | MdvError;

/** Any node in an MDV tree. */
export type MdvNode = MdastNodes | MdvDocument | MdvBlock | MdvDirective | MdvError;

// ─────────────────────────────────────────────────────────────────────────────
// Positions and ranges (SPEC 14.2, SPEC 14.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A point in the **original document** (SPEC 14.4) — never in a reconstructed
 * fragment. Equivalent to unist's `Point` with `offset` promoted to required.
 *
 * `line` and `column` are 1-based; `offset` is a 0-based UTF-16 code-unit index
 * into the source string.
 */
export interface Position {
  offset: number;
  line: number;
  column: number;
}

/** A half-open source span `[start, end)` in the original document. */
export interface Range {
  start: Position;
  end: Position;
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics (SPEC 14.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * SPEC 14.3.
 *
 * - `error`   — the block cannot render as specified; an error card is shown.
 * - `warning` — it renders, but the result probably misleads.
 * - `info`    — a better form exists; renders silently, visible in lint.
 *
 * `strict: true` promotes every `warning` to `error`.
 */
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

/** Which pipeline stage produced a diagnostic (SPEC 14.2). */
export type DiagnosticSource = 'parse' | 'data' | 'encode' | 'security' | 'render';

/** A single text replacement in the original document. */
export interface TextEdit {
  range: Range;
  /** Replacement text; the empty string deletes. */
  newText: string;
}

/**
 * A machine-applicable fix, surfaced by the LSP as a code action (SPEC 14.2).
 * Edits are non-overlapping and are applied to the original document as a batch.
 */
export interface CodeFix {
  /** Imperative, one line, e.g. `Add the --- separator`. */
  title: string;
  edits: TextEdit[];
  /** Marks the fix the editor should offer as the default. */
  preferred?: boolean;
}

/**
 * SPEC 14.2. Errors are **data, not exceptions**: the API returns diagnostics and
 * does not throw for document-level problems.
 */
export interface Diagnostic {
  /** An Appendix C code, e.g. `"MDV3010"`. */
  code: string;
  severity: DiagnosticSeverity;
  /** One sentence, no trailing period. */
  message: string;
  /** Explanation and fix. */
  detail?: string;
  /** A precise range in the original document (SPEC 14.4). */
  range: Range;
  /** The `id` of the block this belongs to, when there is one. */
  blockId?: string;
  source: DiagnosticSource;
  fixes?: CodeFix[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute notation (SPEC 5.3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A scalar in MDV attribute notation (SPEC 5.3.1).
 *
 * Note the deliberate omissions: only the spellings `true` and `false` are
 * booleans (`yes`/`no`/`on`/`off` are strings — the "Norway problem"), and
 * numbers follow the JSON number grammar.
 */
export type AttrScalar = string | number | boolean | null;

/** Any value expressible in MDV attribute notation. */
export type AttrValue = AttrScalar | readonly AttrValue[] | AttrMap;

/**
 * A parsed header or info-string attribute map.
 *
 * Iteration order is **source order** and is load-bearing (SPEC 24.3 rule 5).
 * Keys match `[A-Za-z_][A-Za-z0-9_-]*` and are compared case-sensitively.
 */
export interface AttrMap {
  [key: string]: AttrValue;
}

/**
 * Per-key source ranges for an {@link AttrMap}, keyed by a dotted path
 * (`"axis.y.title"`, `"y[1]"`). This is what lets an editor underline exactly the
 * offending attribute *value* rather than the whole block.
 */
export type AttrRanges = Record<string, Range>;

// ─────────────────────────────────────────────────────────────────────────────
// Front matter (SPEC 3.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed YAML front matter (SPEC 3.4).
 *
 * The reserved keys are typed; **unknown keys are preserved** in {@link extra}
 * and exposed to plugins. An unknown key MUST NOT produce an error — static site
 * generators routinely add their own.
 */
export interface FrontMatter {
  /** The spec version the document targets. Absent ⇒ `MDV1100` (info). */
  mdv?: string;
  title?: string;
  subtitle?: string;
  author?: string;
  /** As written; interpretation (and any `buildTime` pinning) happens in resolve. */
  date?: string;
  /** BCP 47 tag. Sets the document language for a11y and hyphenation. */
  lang?: string;
  /** A named built-in (`default`, `dark`, `print`, `high-contrast`), a path, or an inline theme. */
  theme?: string | AttrMap;
  /** Defaults to `lang`, then to `en-US`. */
  locale?: string;
  timezone?: string;
  /** Attribute defaults for every visual block — cascade level 3 (SPEC 5.5). */
  defaults?: AttrMap;
  /** Front-matter-declared datasets; shares one namespace with block datasets. */
  datasets?: AttrMap;
  /** PDF export settings (SPEC 28.2). */
  pdf?: AttrMap;
  /**
   * Declared *requirement*, never document-settable policy: `security` in front
   * matter is ignored by the reader (SPEC 25) and retained only for tooling.
   */
  security?: AttrMap;
  /**
   * A declaration of requirement, **not** an instruction to load (SPEC 26.3).
   * No code is ever fetched because a document asked for it.
   */
  plugins?: readonly string[];
  toc?: AttrMap | boolean;
  numbering?: AttrMap | boolean;
  /** Every non-reserved top-level key, preserved verbatim and in source order. */
  extra: AttrMap;
  /** Source range of the whole front-matter block, fences included. */
  range: Range;
  /** Per-key source ranges, for diagnostics and the LSP. */
  attrsPosition: AttrRanges;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four MDV node types (SPEC 19)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Opaque handle to a resolved table, attached to a block at resolve time
 * (SPEC 18 stage 2). Structurally mirrors `@mdv/core`'s `TableRef`; it is
 * declared here so the AST can be typed without the parser depending on core.
 */
export interface TableRef {
  /** Dataset id, or a synthetic id (`"#block-3"`) for an inline data section. */
  datasetId: string;
  /** Field projection from `@sales[date, revenue]`, in the listed order. */
  projection?: readonly string[];
  /** Memoisation key over (dataset identity, transform pipeline) — SPEC 6.7. */
  key: string;
}

/**
 * Placeholder for `@mdv/core`'s `DatasetNode`. The parser produces the empty map;
 * resolve (stage 2) populates it. Typed as `unknown` here rather than importing
 * from core, which would invert the dependency direction of SPEC 17.2.
 */
export type DatasetNodeLike = unknown;

/** The document root (SPEC 19). */
export interface MdvDocument extends UnistParent {
  type: 'root';
  frontmatter?: FrontMatter;
  children: MdvContent[];
  /** Every diagnostic produced so far, in document order. */
  diagnostics: Diagnostic[];
  /** Populated at resolve (SPEC 18 stage 2); `{}` straight out of `parse`. */
  datasets: Record<string, DatasetNodeLike>;
  data?: UnistData;
}

/**
 * A fenced visual block (SPEC 5, SPEC 19).
 *
 * A block always survives parsing: malformed content becomes diagnostics plus,
 * where the block cannot be recovered at all, an {@link MdvError} node — never a
 * thrown exception (SPEC 14.1).
 */
export interface MdvBlock extends UnistNode {
  type: 'mdvBlock';
  /** Lowercased type token, e.g. `'bar'`, `'ohlcv'`, `'dataset'`. */
  blockType: string;
  /** Header attributes ∪ info-string attributes, header winning (SPEC 5.5). */
  attrs: AttrMap;
  /** Per-key ranges, for diagnostics and the LSP. */
  attrsPosition: AttrRanges;
  /** Verbatim source, so the error card and `mdv fmt` can reproduce it. */
  raw: {
    /** The header section, before the `---` separator. */
    header: string;
    /** Everything after the separator, with block indentation removed. */
    data: string;
    /** The fence run that opened the block, e.g. '```' or '~~~~'. */
    fence: string;
  };
  /**
   * Where `raw.data` came from, present exactly when the block has a `---`
   * separator (SPEC 5.1).
   *
   * `raw.data` is text with the container indentation already stripped, so it
   * cannot be located in the source by searching for it, and a host must not go
   * looking for the separator itself — where a block's header stops and its data
   * starts is this package's decision, not a regular expression anyone may
   * re-derive. Recorded so the language server can fold a data section
   * independently of the block that holds it (SPEC 29.4) and so a reader that
   * rejects a row can point at the row.
   *
   * Empty and collapsed at the end of the separator line when the separator is
   * the last line of the block: a data section was declared and none was given.
   * Absent — not empty — when there is no separator at all, because then the
   * whole body is header and there is no data section to point at.
   */
  dataPosition?: Range;
  /** Set at resolve (SPEC 18 stage 2). */
  data?: TableRef;
  /** The conformance level this block requires (SPEC 16.1). */
  level: 1 | 2 | 3;
}

/**
 * A generic directive (SPEC 9): `:name`, `::name`, or `:::name`.
 *
 * An unknown directive is `MDV1503` (info) and its children render as ordinary
 * content — never an error (SPEC 15.2).
 */
export interface MdvDirective extends UnistNode {
  type: 'mdvDirective';
  kind: 'inline' | 'leaf' | 'container';
  /** e.g. `'mdv-grid'`. */
  name: string;
  attrs: AttrMap;
  attrsPosition: AttrRanges;
  /** The bracketed content, `:name[label]`. */
  label?: string;
  /** Present for `container` and, as phrasing content, for `inline`. */
  children?: (RootContent | PhrasingContent | MdvContent)[];
}

/**
 * A construct that could not be parsed at all. Carries the diagnostic and the
 * preserved source, which is what the error card shows (SPEC 14.1 principle 2:
 * failures are visible, never silent, and never an empty frame).
 */
export interface MdvError extends UnistNode {
  type: 'mdvError';
  diagnostic: Diagnostic;
  /** Preserved source, shown verbatim in the error card. */
  raw: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// mdast declaration merging — makes `unist-util-visit` and friends type-aware
// ─────────────────────────────────────────────────────────────────────────────

declare module 'mdast' {
  interface RootContentMap {
    mdvBlock: MdvBlock;
    mdvDirective: MdvDirective;
    mdvError: MdvError;
  }
  interface PhrasingContentMap {
    mdvDirective: MdvDirective;
  }
}

/** Narrowing guard for {@link MdvBlock}. */
export function isMdvBlock(node: UnistNode | Root | MdvContent): node is MdvBlock {
  return node.type === 'mdvBlock';
}

/** Narrowing guard for {@link MdvDirective}. */
export function isMdvDirective(node: UnistNode | Root | MdvContent): node is MdvDirective {
  return node.type === 'mdvDirective';
}

/** Narrowing guard for {@link MdvError}. */
export function isMdvError(node: UnistNode | Root | MdvContent): node is MdvError {
  return node.type === 'mdvError';
}

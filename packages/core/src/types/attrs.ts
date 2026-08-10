/**
 * Block attributes (SPEC 8.1) after the cascade has run.
 *
 * The cascade (SPEC 5.5), lowest precedence to highest:
 *
 * 1. built-in defaults for the block type
 * 2. the active theme
 * 3. the document's `defaults:` front matter
 * 4. reader/embedder configuration (`MdvConfig.defaults`)
 * 5. block info-string attributes
 * 6. block header attributes
 *
 * Reader configuration outranks the document's own `defaults` so an embedder can
 * enforce a house style; a block always outranks both so an author can override
 * locally. Merging is **deep for mappings, replacing for sequences and scalars**.
 */

import type { AttrValue } from '@mdv/parser';
import type { DataFormat, DataType, FieldDecl, FormatSpec, TransformPipeline } from './data.js';
import type { AxisSpec, LegendPosition } from './encode.js';

/**
 * A dimension (SPEC 5.3.3): a bare number is device pixels, a string carries a
 * CSS-like unit (`"320px"`, `"100%"`, `"16rem"`, `"8cm"`). A malformed value is
 * `MDV1221`.
 */
export type Dimension = number | string;

/** `padding:` accepts one dimension or a per-side box (SPEC 8.1). */
export type PaddingAttr =
  Dimension | { top?: Dimension; right?: Dimension; bottom?: Dimension; left?: Dimension };

/** How the data table is exposed (SPEC 12.3). `none` emits `MDV3090`. */
export type TableViewAttr = 'details' | 'visible' | 'hidden' | 'none';

/** `legend:` (SPEC 7.4). */
export type LegendAttr =
  | 'auto'
  | LegendPosition
  | false
  | {
      position?: 'auto' | LegendPosition;
      title?: string | false;
      orient?: 'horizontal' | 'vertical';
      columns?: number;
      /** Beyond this, series fold into "Other". @defaultValue 12 */
      maxItems?: number;
    };

/** `tooltip:` (SPEC 7.5). A field list adds fields to the readout. */
export type TooltipAttr = boolean | readonly string[];

// ─────────────────────────────────────────────────────────────────────────────
// `columns:` — one name, two attributes (SPEC 7.6 vs SPEC 10.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cell renderer for a table column (SPEC 10.1). The field types are the
 * ordinary ones; the extra four are renderers that keep the value legible and
 * add an encoding on top of it, never in place of it.
 */
export type TableCellType = DataType | 'sparkline' | 'bar' | 'link' | 'badge';

/** In-cell magnitude encoding for a table column (SPEC 10.1). */
export type TableCellHeat = 'none' | 'sequential' | 'diverging' | 'bar';

/**
 * One entry of the table block's `columns:` map (SPEC 10.1).
 *
 * The index signature carries renderer-specific keys — a `sparkline` column
 * takes `curve`, a `bar` column takes its own scale hints — for the same reason
 * {@link BlockAttrs} has one: core does not model them, the block type's JSON
 * Schema validates them.
 */
export interface TableColumnAttr {
  /** Header text; defaults to the humanised field name. */
  label?: string;
  type?: TableCellType;
  /** Output format for the cell value, d3-style or strftime-style (SPEC 6.9). */
  format?: FormatSpec;
  align?: 'left' | 'right' | 'center';
  /** @defaultValue 'none' */
  heat?: TableCellHeat;
  /** The zero point for `heat: diverging`. */
  midpoint?: number;
  width?: Dimension;
  /** @defaultValue true */
  wrap?: boolean;
  readonly [cellSpecific: string]: unknown;
}

/**
 * The table block's `columns:` (SPEC 10.1): field name → configuration,
 * **ordered as written**, which is why it is a map and not a list.
 */
export type TableColumnsAttr = Readonly<Record<string, TableColumnAttr>>;

/**
 * `columns:` (Appendix B: `o|n`, `table, facet`).
 *
 * Two unrelated attributes were given one name by SPEC:
 *
 * - on a faceted block it is the wrap count, `columns: 3` (SPEC 7.6);
 * - on a `table` block it is the per-column configuration map (SPEC 10.1).
 *
 * They are disjoint at runtime — a number is never a map — so this is an honest
 * union rather than the `number` it used to be declared as. That declaration was
 * simply wrong for every `mdv table` block in existence: the parser produces an
 * object there (see `packages/parser/test/parser.test.ts`), so every reader had
 * to launder the value through the `unknown` index signature to get at it, and
 * `@mdv/charts` still does. Read it through {@link columnsAttrOf}, which is
 * total and tags which of the two you got.
 */
export type ColumnsAttr = number | TableColumnsAttr;

/** What a block's `columns:` turned out to mean. See {@link columnsAttrOf}. */
export type ColumnsMeaning =
  | { readonly kind: 'absent' }
  /** SPEC 7.6: wrap a one-dimensional facet after this many panels. */
  | { readonly kind: 'facet-wrap'; readonly wrap: number }
  /** SPEC 10.1: per-column configuration for a table block. */
  | { readonly kind: 'table'; readonly columns: TableColumnsAttr };

const ABSENT = { kind: 'absent' } as const;

/**
 * Decide which `columns:` a block carries.
 *
 * Total by construction: a value that is neither a positive finite number nor a
 * plain object — `columns: true`, `columns: [a, b]`, `columns: -1` — is
 * `absent`, because a malformed attribute must never take out a block
 * (SPEC 14.1, SPEC 15.2).
 */
export function columnsAttrOf(attrs: BlockAttrs): ColumnsMeaning {
  const value: unknown = attrs.columns;
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 1
      ? { kind: 'facet-wrap', wrap: Math.floor(value) }
      : ABSENT;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ABSENT;
  const columns: Record<string, TableColumnAttr> = {};
  // Insertion order is the column order (SPEC 10.1) and is load-bearing for
  // determinism (SPEC 24.3 rule 5), so rebuild rather than reorder. Entries that
  // are not maps are dropped, not defaulted: a column with no configuration is
  // indistinguishable from `{}` and would silently gain a position.
  for (const [name, spec] of Object.entries(value as Record<string, unknown>)) {
    if (typeof spec === 'object' && spec !== null && !Array.isArray(spec)) {
      columns[name] = spec as TableColumnAttr;
    }
  }
  return { kind: 'table', columns };
}

/** The SPEC 7.6 facet wrap count, or `undefined` when `columns:` means the other thing. */
export function facetWrapOf(attrs: BlockAttrs): number | undefined {
  const meaning = columnsAttrOf(attrs);
  return meaning.kind === 'facet-wrap' ? meaning.wrap : undefined;
}

/** The SPEC 10.1 per-column map, or `undefined` when `columns:` means the other thing. */
export function tableColumnsOf(attrs: BlockAttrs): TableColumnsAttr | undefined {
  const meaning = columnsAttrOf(attrs);
  return meaning.kind === 'table' ? meaning.columns : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// `format:` — one name, two attributes (SPEC 6.2 vs SPEC 8.13)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of data-section syntaxes (SPEC 6.2), frozen and in SPEC order.
 *
 * This is the discriminant for {@link FormatAttr}; it must stay in step with
 * {@link DataFormat}. The `satisfies` clause makes a drift a compile error in
 * one direction, and {@link isDataFormat}'s return type does it in the other.
 */
export const DATA_FORMATS = Object.freeze([
  'auto',
  'table',
  'csv',
  'tsv',
  'json',
  'ndjson',
  'columns',
  'matrix',
] as const) satisfies readonly DataFormat[];

/** Whether a value is one of the eight SPEC 6.2 data-section syntaxes. */
export function isDataFormat(value: unknown): value is DataFormat {
  return typeof value === 'string' && (DATA_FORMATS as readonly string[]).includes(value);
}

/**
 * `format:` (Appendix B: `e`, all block types).
 *
 * Another name doing two jobs:
 *
 * - with a data section it names the syntax, `format: csv` (SPEC 6.2);
 * - on a `metric` it is the number format for the value, `format: "$~s"`
 *   (SPEC 8.13), the same d3/strftime {@link FormatSpec} a channel or a table
 *   column takes (SPEC 6.9).
 *
 * Both arms are strings, so the discriminant is **membership in the closed
 * eight-member {@link DATA_FORMATS} set**, and that discriminant is sound rather
 * than merely convenient: a d3 number pattern always contains a type character,
 * a width, a precision or a symbol (`"$~s"`, `"+.1%"`, `",.0f"`), and a strftime
 * pattern always contains `%`. None of the eight can be produced that way, and
 * none of the eight is a legal format specifier. Read it through
 * {@link formatAttrOf}.
 */
export type FormatAttr = DataFormat | FormatSpec;

/** What a block's `format:` turned out to mean. See {@link formatAttrOf}. */
export type FormatMeaning =
  | { readonly kind: 'absent' }
  /** SPEC 6.2: the syntax of the data section. */
  | { readonly kind: 'data'; readonly format: DataFormat }
  /** SPEC 6.9/8.13: how to render a number or a date. */
  | { readonly kind: 'number'; readonly spec: FormatSpec };

/**
 * Decide which `format:` a block carries.
 *
 * Total: a non-string (`format: 3`, `format: {}`) is `absent`, and an empty
 * string is `absent` too — it is not a syntax name and it formats nothing.
 */
export function formatAttrOf(attrs: BlockAttrs): FormatMeaning {
  const value: unknown = attrs.format;
  if (typeof value !== 'string' || value === '') return ABSENT;
  return isDataFormat(value) ? { kind: 'data', format: value } : { kind: 'number', spec: value };
}

/** The SPEC 6.2 data-section syntax, or `undefined` when `format:` means the other thing. */
export function dataFormatOf(attrs: BlockAttrs): DataFormat | undefined {
  const meaning = formatAttrOf(attrs);
  return meaning.kind === 'data' ? meaning.format : undefined;
}

/** The SPEC 6.9 number/date pattern, or `undefined` when `format:` means the other thing. */
export function numberFormatOf(attrs: BlockAttrs): FormatSpec | undefined {
  const meaning = formatAttrOf(attrs);
  return meaning.kind === 'number' ? meaning.spec : undefined;
}

/**
 * Attributes common to every visual block (SPEC 8.1), fully resolved.
 *
 * Extension attributes (`x-*`) are preserved verbatim under {@link extensions}
 * and are **never interpreted by core** (SPEC 15.1). Per-type attributes live on
 * the chart type's own attribute record, not here.
 */
export interface BlockAttrs {
  /** Present only when the info string omitted the type. */
  type?: string;
  /** Rendered above the plot; also the default accessible name (SPEC 12.1). */
  title?: string;
  subtitle?: string;
  /** Rendered below; the figure caption in PDF. A caption makes the role `figure`. */
  caption?: string;
  /** The accessible description (SPEC 12.2). Generated when absent. */
  desc?: string;
  /** Anchor and cross-reference target. */
  id?: string;
  /** `"@dataset"`; mutually exclusive with a data section and with `src`. */
  data?: string;
  /** External source (SPEC 6.4). Disabled by default. */
  src?: string;
  /** SRI hash; a mismatch is `MDV4021`. */
  integrity?: string;
  /**
   * The data-section syntax (SPEC 6.2, `@defaultValue 'auto'`) **or** a number
   * format (SPEC 8.13). Read it with {@link formatAttrOf}, never directly.
   */
  format?: FormatAttr;
  fields?: Readonly<Record<string, FieldDecl>>;
  transform?: TransformPipeline;
  /** @defaultValue '100%' */
  width?: Dimension;
  /** @defaultValue 300 */
  height?: Dimension;
  /** Width : height; overrides {@link height} when width is fluid. */
  aspect?: number;
  /** @defaultValue `{top: 8, right: 8, bottom: 8, left: 8}` */
  padding?: PaddingAttr;
  /** Per-block theme override. */
  theme?: string;
  /** A named palette or explicit colors. A custom palette MUST be validated (`MDV3080`). */
  palette?: string | readonly string[];
  /** @defaultValue 'auto' */
  legend?: LegendAttr;
  /** @defaultValue true */
  tooltip?: TooltipAttr;
  /** Forced off under `prefers-reduced-motion` and on static targets. @defaultValue true */
  animate?: boolean;
  /** Passed through to the container element for embedder styling. */
  class?: string;
  /** A pre-rendered image for non-MDV pipelines (SPEC 5.6). Readers ignore it. */
  fallback?: string;
  /** @defaultValue 'details' */
  table?: TableViewAttr;
  /** Faceting (SPEC 7.6). */
  row?: string;
  column?: string;
  /**
   * The facet wrap count (SPEC 7.6) **or** the table's per-column map
   * (SPEC 10.1). Read it with {@link columnsAttrOf}, never directly.
   */
  columns?: ColumnsAttr;
  /** A shared scale is what makes panels comparable. @defaultValue true */
  shareX?: boolean;
  /** `false` emits `MDV3030` (info): unshared scales invite false comparison. */
  shareY?: boolean;
  facetHeight?: Dimension;
  /** Axis configuration (SPEC 7.3). There is no second value axis (SPEC 7.3.1). */
  axis?: { x?: AxisSpec | false; y?: AxisSpec | false };
  /**
   * `x-*` attributes, preserved verbatim through parse, resolve and `toMarkdown`,
   * and exposed to plugins. Core never reads them (SPEC 15.1).
   */
  extensions?: Readonly<Record<string, AttrValue>>;
  /**
   * Per-type attributes that core does not model (`stack`, `barWidth`, `corner`,
   * `bins`, …). Validated against the block type's JSON Schema, not here.
   */
  readonly [typeSpecific: string]: unknown;
}

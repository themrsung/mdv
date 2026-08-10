/**
 * The MDV data model (SPEC 6).
 *
 * Every visual block resolves its input to a {@link Table}: an ordered list of
 * named fields and an ordered list of rows. **This is the only data structure in
 * MDV.** Hierarchical visuals (treemap, sankey, gantt) express hierarchy through
 * *fields* — a parent key, a source/target pair — never through nested data.
 */

import type { Range } from '@mdv/parser';

// ─────────────────────────────────────────────────────────────────────────────
// Values and types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single cell (SPEC 6.1).
 *
 * `null` is the one missing marker: the empty string, `NA`, `N/A`, `-` and the
 * JSON `null` all normalise to it during preparation (SPEC 6.5). `NaN` is never
 * a legal cell value — it becomes `null`.
 */
export type Value = number | string | boolean | Date | null;

/**
 * Field type (SPEC 6.1). Inferred over **all** rows when not declared — never
 * sampled, because sampling makes rendering data-dependent and therefore
 * non-deterministic across implementations (SPEC 6.1.1).
 */
export type DataType =
  | 'number'
  | 'integer'
  | 'string'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'time'
  | 'duration'
  | 'category'
  | 'unknown';

/** SPEC 6.1 spells this `FieldType`; the two names are interchangeable. */
export type FieldType = DataType;

/**
 * A number or date format specifier (SPEC 6.9): a d3-format-style number pattern
 * (`",.0f"`, `"$,.2f"`, `".1%"`) or a strftime-style date pattern (`"%b %Y"`).
 */
export type FormatSpec = string;

/**
 * A column of a {@link Table} (SPEC 6.1 calls this `Field`).
 *
 * Names come from the data's header row, are compared **case-sensitively**, and
 * are trimmed of surrounding whitespace (SPEC 6.1.2). Duplicates are `MDV2110`
 * and are disambiguated by suffixing `_2`, `_3`.
 */
export interface Column {
  name: string;
  /** Declared in `fields:` or inferred per SPEC 6.1.1. */
  type: DataType;
  /** Output format; the axis and the table view both honour it. */
  format?: FormatSpec;
  /** Input format for `parse:` (e.g. `"%d/%m/%Y"`). */
  parse?: string;
  /** Human title for axes and legends; defaults to the humanised name. */
  title?: string;
  /** `true` when {@link type} came from inference rather than a declaration. */
  inferred?: boolean;
}

/** SPEC 6.1 spells {@link Column} `Field`. */
export type Field = Column;

/**
 * The table (SPEC 6.1). Row-major: `rows[i][j]` belongs to `fields[j]`.
 *
 * Every row has exactly `fields.length` cells after preparation — short rows are
 * padded (`MDV2120`) and long rows truncated (`MDV2121`).
 */
export interface Table {
  fields: Column[];
  rows: Value[][];
}

/** Declared field metadata from a block's `fields:` attribute (SPEC 6.1.1). */
export interface FieldDecl {
  type?: DataType;
  format?: FormatSpec;
  parse?: string;
  title?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Data formats (SPEC 6.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Data-section syntax (SPEC 6.2). `table`, `csv` and `tsv` are Level 1;
 * `json`, `ndjson`, `columns` and `matrix` are Level 2.
 *
 * `auto` detects and emits `MDV2101` (info) so the author can pin it.
 */
export type DataFormat =
  'auto' | 'table' | 'csv' | 'tsv' | 'json' | 'ndjson' | 'columns' | 'matrix';

// ─────────────────────────────────────────────────────────────────────────────
// Transforms (SPEC 6.7)
// ─────────────────────────────────────────────────────────────────────────────

/** An MDVX expression source string (SPEC 6.8). Never `eval`'d (SPEC 13.1). */
export type Expression = string;

/** Aggregator names available to `aggregate` (SPEC 6.7). `p<n>` is a percentile. */
export type AggregateOp =
  | 'sum'
  | 'mean'
  | 'median'
  | 'min'
  | 'max'
  | 'count'
  | 'first'
  | 'last'
  | 'stddev'
  /** Percentile, e.g. `p95`. */
  | `p${number}`;

/** `window.op` (SPEC 6.7). */
export type WindowOp =
  | 'sum'
  | 'mean'
  | 'min'
  | 'max'
  | 'count'
  | 'cumsum'
  | 'delta'
  | 'pct_change'
  | 'rank'
  | 'lag'
  | 'lead';

/** Either a field list (output keeps the name) or output name → input field. */
export type AggregateArg = readonly string[] | Readonly<Record<string, string>>;

/** Keeps rows where the expression is truthy. Null is false. */
export interface FilterStep {
  filter: Expression;
}
/** Adds or replaces fields, evaluated left to right; later entries see earlier ones. */
export interface DeriveStep {
  derive: Readonly<Record<string, Expression>>;
}
/** Group-and-aggregate. Each aggregator is a field list or an output→input map. */
export interface AggregateStep {
  aggregate: {
    group?: readonly string[];
    sum?: AggregateArg;
    mean?: AggregateArg;
    median?: AggregateArg;
    min?: AggregateArg;
    max?: AggregateArg;
    /** `true`, or the output field name. */
    count?: true | string;
    first?: AggregateArg;
    last?: AggregateArg;
    stddev?: AggregateArg;
  } & { readonly [percentile: `p${number}`]: AggregateArg | undefined };
}
/** `-` prefix is descending. Sort is **stable**; nulls sort last. */
export interface SortStep {
  sort: string | readonly string[];
}
/** Row slice after sorting. */
export interface LimitStep {
  limit: number | { n: number; offset?: number };
}
/** Long → wide. New field names come from `key`'s values, sorted for determinism. */
export interface PivotStep {
  pivot: { key: string; value: string; group?: string | readonly string[] };
}
/** Wide → long. */
export interface UnpivotStep {
  unpivot: { fields: readonly string[]; key?: string; value?: string };
}
/** Numeric or temporal binning. `step` wins over `count`. */
export interface BinStep {
  bin: { field: string; step?: number; count?: number; output?: string };
}
/** Windowed aggregate. `size` is in rows; order is the current row order. */
export interface WindowStep {
  window: {
    op: WindowOp;
    field: string;
    size: number;
    output: string;
    partition?: string | readonly string[];
  };
}
/** Joins against another dataset. `how` defaults to `left`. */
export interface JoinStep {
  join: {
    with: string;
    on: string | { left: string; right: string };
    how?: 'inner' | 'left';
  };
}
/** Renames fields, old → new. */
export interface RenameStep {
  rename: Readonly<Record<string, string>>;
}
/** Projection, preserving the listed order. */
export interface SelectStep {
  select: readonly string[];
}

/**
 * One step of the `transform:` pipeline (SPEC 6.7).
 *
 * Transforms are pure, total, and deliberately non-Turing-complete: no loops, no
 * recursion, no user functions. An unrecognised step is `MDV2500`.
 */
export type TransformStep =
  | FilterStep
  | DeriveStep
  | AggregateStep
  | SortStep
  | LimitStep
  | PivotStep
  | UnpivotStep
  | BinStep
  | WindowStep
  | JoinStep
  | RenameStep
  | SelectStep;

/** An ordered transform pipeline. */
export type TransformPipeline = readonly TransformStep[];

// ─────────────────────────────────────────────────────────────────────────────
// Datasets and references (SPEC 6.3, 6.4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A handle to one prepared table, attached to a block at resolve time.
 *
 * Structurally identical to `@mdv/parser`'s `TableRef`, which is declared there
 * so the AST can be typed without inverting the dependency of SPEC 17.2.
 */
export interface TableRef {
  /** Dataset id, or a synthetic id (`"#block-3"`) for an inline data section. */
  datasetId: string;
  /** Field projection from `@sales[date, revenue]`, in the listed order. */
  projection?: readonly string[];
  /**
   * Memoisation key over (dataset identity, transform pipeline). Two blocks with
   * the same key share one prepared table — that is what makes N charts over one
   * dataset cost one evaluation (SPEC 6.7).
   */
  key: string;
}

/** Lifecycle of a dataset. A block MUST render a placeholder for every non-ready state (SPEC 6.4). */
export type DatasetState = 'declared' | 'loading' | 'ready' | 'blocked' | 'failed';

/** Where a dataset was declared. All origins share one namespace (SPEC 6.3). */
export type DatasetOrigin = 'front-matter' | 'block' | 'inline' | 'config';

/**
 * A node of the dataset DAG (SPEC 6.3).
 *
 * Resolution is two-pass: a dataset may be referenced before it is declared.
 * A dataset MAY derive from another via {@link from} plus {@link transform};
 * cycles are `MDV2141`.
 */
export interface DatasetNode {
  /** Matches `[A-Za-z_][A-Za-z0-9_-]*`; unique per document (`MDV2140`). */
  id: string;
  origin: DatasetOrigin;
  /** `from: "@sales"` — this dataset derives from another. */
  from?: string;
  /** External source (SPEC 6.4). Disabled by default; requires `Capabilities`. */
  src?: string;
  /** SRI hash; a mismatch is `MDV4021` and the data is discarded. */
  integrity?: string;
  format?: DataFormat;
  /** The verbatim data section, before format parsing. */
  raw?: string;
  /** Declared field types and formats. */
  fields?: Readonly<Record<string, FieldDecl>>;
  transform?: TransformPipeline;
  /** Present once stage 4 (Prepare) has run for this node. */
  table?: Table;
  state: DatasetState;
  /** Why the dataset is `blocked` or `failed`, as an Appendix C code. */
  stateReason?: string;
  /** Source range of the declaration, for diagnostics. */
  range?: Range;
  /** `show: table` renders the dataset as an enhanced table at its location. */
  show?: 'none' | 'table';
}

/**
 * The resolved dataset graph for one document (SPEC 18 stage 2).
 *
 * Read-only by design: a registry belongs to exactly one `ResolvedDocument`, and
 * two documents never share one (SPEC 17.3 invariant 4).
 */
export interface DataRegistry {
  /** `undefined` for an unresolved reference — the caller emits `MDV2142`. */
  get(id: string): DatasetNode | undefined;
  has(id: string): boolean;
  /** Every dataset, in **declaration order** (SPEC 24.3 rule 5). */
  list(): readonly DatasetNode[];
  /**
   * The prepared table behind a reference, with any projection applied.
   *
   * @returns `undefined` when the dataset is missing or not yet `ready`; the
   * caller renders the placeholder state rather than an empty chart (SPEC 6.4).
   */
  resolve(ref: TableRef): Table | undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers other packages need on the type level
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A field name as written in an attribute. Bare when it matches
 * `[A-Za-z_][A-Za-z0-9_]*`, otherwise bracketed: `"[Net revenue (USD)]"`
 * (SPEC 6.1.2).
 */
export type FieldRef = string;

/** An index into `Table.rows`. Carried by marks and hit regions for traceability. */
export type RowIndex = number;

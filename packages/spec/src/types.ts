/**
 * Types for the machine-readable spec artefacts shipped by `@mdv/spec`.
 *
 * `@mdv/spec` carries **no runtime logic** (SPEC 17.2) — only data (the error-code
 * table, the JSON Schemas, the conformance fixtures) and the thin, total accessors
 * needed to read that data with types attached.
 */

/**
 * Default severity of a diagnostic code, per SPEC Appendix C.
 *
 * This is the *default*: `MdvConfig.strict` promotes every `warning` to `error`
 * (SPEC 14.3), and that promotion happens in `@mdv/core`, never here.
 */
export type ErrorSeverity = 'error' | 'warning' | 'info';

/** One row of SPEC Appendix C. */
export interface ErrorCodeEntry {
  /** e.g. `"MDV3010"`. Matches `/^MDV[1-5]\d{3}$/`. */
  readonly code: string;
  /** The default severity from Appendix C. */
  readonly severity: ErrorSeverity;
  /**
   * The one-sentence meaning from Appendix C, with no trailing period, suitable
   * as a fallback `Diagnostic.message` when the producer has nothing more specific.
   */
  readonly summary: string;
}

/** The `MDV1`…`MDV5` families of Appendix C. */
export type ErrorGroupKey = 'MDV1' | 'MDV2' | 'MDV3' | 'MDV4' | 'MDV5';

/** Shape of `packages/spec/errors.json`. */
export interface ErrorTable {
  readonly specVersion: string;
  readonly groups: Readonly<Record<string, string>>;
  readonly codes: readonly ErrorCodeEntry[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Signatures (SPEC 6.7, 6.8.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The section of the SPEC 6.8.2 whitelist a function is listed under. Purely a
 * grouping for presentation: it carries no evaluation meaning.
 */
export type SignatureGroup = 'math' | 'stats' | 'string' | 'temporal' | 'logic' | 'format';

/**
 * One parameter of a whitelisted function.
 *
 * The names are normative — SPEC 6.8.2 says the parameter names are the ones a
 * tool shows the author — so a reader may print them without inventing any.
 */
export interface SignatureParam {
  /** As written in SPEC 6.8.2, e.g. `"exponent"`. */
  readonly name: string;
  /** The argument may be left out. Optional parameters come last. */
  readonly optional?: boolean;
  /**
   * A variadic tail: one or more arguments, or a single list (SPEC 6.8.2).
   * A `rest` parameter is last, and contributes a minimum arity of one.
   */
  readonly rest?: boolean;
  /** What this argument means, with no trailing period. */
  readonly summary?: string;
}

/** One row of the SPEC 6.8.2 function whitelist. */
export interface FunctionSignature {
  /** The callable identifier, e.g. `"dateDiff"`. */
  readonly name: string;
  readonly group: SignatureGroup;
  /** In call order. Arity is this list, counted — it is not stored separately. */
  readonly params: readonly SignatureParam[];
  /** The one-line meaning from SPEC 6.8.2, with no trailing period. */
  readonly summary: string;
  /** Legal only in an aggregate context (SPEC 6.8.2). */
  readonly aggregateOnly?: boolean;
}

/** One key of a transform step whose parameter is a mapping (SPEC 6.7). */
export interface StepKey {
  readonly name: string;
  /** The key may be left out; anything else missing is `MDV2501`. */
  readonly optional?: boolean;
  /** What this key means, with no trailing period. */
  readonly summary?: string;
}

/** One row of the SPEC 6.7 transform step table. */
export interface StepSignature {
  /** The step name, e.g. `"window"`. */
  readonly name: string;
  /** The Shape column of SPEC 6.7, e.g. `` "`{op, field, size, output, partition?}`" ``. */
  readonly shape: string;
  /** The Semantics column, condensed to one line with no trailing period. */
  readonly summary: string;
  /** Empty for the steps whose parameter is not a mapping. */
  readonly keys: readonly StepKey[];
}

/** Shape of `packages/spec/signatures.json`. */
export interface SignatureTable {
  readonly specVersion: string;
  /** In SPEC 6.8.2 table order. */
  readonly functions: readonly FunctionSignature[];
  /** In SPEC 6.7 table order. */
  readonly steps: readonly StepSignature[];
}

/** How many arguments a callable accepts. `max` is `Infinity` for a variadic. */
export interface Arity {
  readonly min: number;
  readonly max: number;
}

/**
 * Conformance level (SPEC 16.1). A reader MUST advertise its level and MUST
 * implement every feature of the levels below the one it claims.
 */
export type ConformanceLevel = 1 | 2 | 3;

/** Fixture categories of the normative test suite (SPEC 16.2). */
export type FixtureCategory =
  'syntax' | 'data' | 'encode' | 'render' | 'a11y' | 'security' | 'pdf' | 'perf';

/** `meta.json` in a fixture directory (SPEC 16.2). */
export interface FixtureMeta {
  /** The conformance level at which this case must pass. */
  readonly level: ConformanceLevel;
  /** Free-form tags used to select subsets, e.g. `["bar", "stack"]`. */
  readonly tags: readonly string[];
  /** Optional human note explaining what the case pins down. */
  readonly note?: string;
  /**
   * Requirement ids from {@link LevelRequirement} this case exercises, for the
   * ones a run cannot see for itself.
   *
   * A conformance run derives most coverage from the document — the block types
   * it contains, the data format each block resolved from, whether it faceted —
   * because derived evidence cannot drift from the case. Some requirements leave
   * no such trace (a keyboard contract, an accessible-name rule the SVG happens
   * to satisfy incidentally), and those are declared here. Every id MUST appear
   * in `levels.json`; an unknown one is a corpus error, not a silent no-op.
   */
  readonly covers?: readonly string[];
  /**
   * The outputs this case promises to pin, as {@link GoldenName}s.
   *
   * A case asserts on whichever `expected.*` files it ships, so a file is its
   * own declaration and needs no entry here. This field is for the other
   * direction: a name listed with no file beside it is a corpus error, which is
   * what stops a case from being *written* to pin an output and then quietly
   * shipping without it. `pnpm test:update` turns each promise into a file.
   */
  readonly pin?: readonly GoldenName[];
}

/**
 * A golden a case can pin, named after the file that holds it (SPEC 16.2):
 * `expected.ast.json`, `diagnostics.json`, `expected.svg`, `expected.dark.svg`,
 * `expected.pdf.json`.
 */
export type GoldenName = 'ast' | 'diagnostics' | 'svg' | 'dark' | 'pdf';

// ─────────────────────────────────────────────────────────────────────────────
// Conformance levels (SPEC 16.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One feature named by the SPEC 16.1 level table.
 *
 * That table is three rows of prose. This is the same content broken into
 * individually addressable requirements, so that "Level 2 is substantiated by
 * the suite" can be checked rather than asserted: a level is substantiated only
 * when every requirement at or below it is exercised by a passing case.
 */
export interface LevelRequirement {
  /** Stable dotted id, e.g. `"type.bar"`. Referenced by `FixtureMeta.covers`. */
  readonly id: string;
  /** The lowest level at which a reader must implement this. */
  readonly level: ConformanceLevel;
  /** Short human label, e.g. `` "`bar`" `` or `"The attribute cascade"`. */
  readonly label: string;
  /** The section that defines the feature, e.g. `"8.2"`. */
  readonly spec: string;
}

/** Shape of `packages/spec/levels.json`. */
export interface LevelTable {
  readonly specVersion: string;
  /** Level number (as a string key) → the name SPEC 16.1 gives it. */
  readonly levels: Readonly<Record<string, string>>;
  readonly requirements: readonly LevelRequirement[];
}

/**
 * One node of a JSON Schema 2020-12 document, as far as the MDV schemas use it.
 *
 * This is a *reading* type, not a validating one: it names the keywords that
 * appear in `schemas/`, so an accessor can walk a schema with types attached.
 * A validator takes the raw JSON and applies the whole vocabulary; nothing here
 * claims to be that. Keywords the MDV schemas never write are simply absent,
 * and an unknown keyword is not an error — it is a keyword this reading does
 * not look at.
 */
export interface SchemaNode {
  /** A reference to a sibling schema file, e.g. `"./dimension.json"`. */
  readonly $ref?: string;
  readonly $comment?: string;
  /**
   * `"string"`, `"object"`, … The array form is legal JSON Schema and is read
   * as a union, though the MDV schemas spell unions with `oneOf`.
   */
  readonly type?: string | readonly string[];
  readonly title?: string;
  /** The prose Appendix D prints for this node. */
  readonly description?: string;
  /** A closed set of literal values. */
  readonly enum?: readonly unknown[];
  /** A single literal value. */
  readonly const?: unknown;
  /** The value assumed when the attribute is absent. */
  readonly default?: unknown;
  /** Illustrative values; the MDV schemas carry exactly one per property. */
  readonly examples?: readonly unknown[];
  readonly oneOf?: readonly SchemaNode[];
  readonly anyOf?: readonly SchemaNode[];
  readonly allOf?: readonly SchemaNode[];
  readonly not?: SchemaNode;
  readonly items?: SchemaNode;
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly patternProperties?: Readonly<Record<string, SchemaNode | boolean>>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly unevaluatedProperties?: SchemaNode | boolean;
  readonly required?: readonly string[];
  readonly pattern?: string;
  readonly format?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
}

/** A schema document: a {@link SchemaNode} that names itself and its properties. */
export interface BlockSchema extends SchemaNode {
  readonly $id: string;
  readonly title: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, SchemaNode>>;
}

/**
 * What Appendix D says about one attribute, rendered for a human to read.
 *
 * Every field is text in MDV's own attribute syntax rather than in JSON Schema's
 * — `padding: {top: 16, bottom: 24}`, not `{"top":16,"bottom":24}` — because the
 * one reader of this is an author looking at the line they are writing.
 */
export interface AttrDoc {
  /** The attribute key, e.g. `"legend"`. */
  readonly name: string;
  /** The type as written, e.g. `"dimension"`, `"string[]"`, `"top | right"`. */
  readonly type: string;
  /** Every value allowed, when the set is closed. */
  readonly values?: readonly string[];
  /** The value assumed when the attribute is absent, as written. */
  readonly default?: string;
  /** The Appendix D prose. */
  readonly description?: string;
  /** One complete header line, e.g. `"legend: top"`. */
  readonly example?: string;
}

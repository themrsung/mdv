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

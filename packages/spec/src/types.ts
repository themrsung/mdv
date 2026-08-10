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

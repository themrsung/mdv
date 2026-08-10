/**
 * `@mdv/spec` — the normative artefacts of the MDV specification.
 *
 * Contains the error-code table (SPEC Appendix C), the JSON Schemas
 * (SPEC Appendix D, in `schemas/`), and the conformance fixture corpus
 * (SPEC 16.2, in `tests/`). No rendering logic ever lives here.
 */

export {
  ERROR_CODES,
  ERROR_TABLE,
  codesInGroup,
  groupName,
  groupOf,
  isKnownErrorCode,
  lookupErrorCode,
  severityOf,
  summaryOf,
} from './errors.js';
export type { ErrorCode } from './errors.js';

export type {
  ConformanceLevel,
  ErrorCodeEntry,
  ErrorGroupKey,
  ErrorSeverity,
  ErrorTable,
  FixtureCategory,
  FixtureMeta,
} from './types.js';

/** The spec revision these artefacts were generated from. */
export const SPEC_VERSION = '1.0-draft.1';

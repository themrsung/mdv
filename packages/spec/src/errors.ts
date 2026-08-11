import rawErrorTable from '../errors.json' with { type: 'json' };
import type { ErrorCodeEntry, ErrorGroupKey, ErrorSeverity, ErrorTable } from './types.js';

/**
 * The Appendix C error table, loaded from `packages/spec/errors.json`.
 *
 * Every producer of diagnostics (`@mdv/parser`, `@mdv/core`, the backends) looks
 * up default severity and fallback text here rather than hard-coding it, so a
 * change to Appendix C is a one-file change.
 */
export const ERROR_TABLE: ErrorTable = rawErrorTable as unknown as ErrorTable;

/** Every code in Appendix C, in Appendix C order. */
export const ERROR_CODES: readonly ErrorCodeEntry[] = ERROR_TABLE.codes;

/**
 * Union of the literal codes in Appendix C. Widened to `string` deliberately:
 * plugins (SPEC 26) and future spec revisions add codes, and a closed union
 * would make an unknown code a compile error rather than a runtime diagnostic.
 * Use {@link isKnownErrorCode} when you need the closed check.
 */
export type ErrorCode = string;

const INDEX: ReadonlyMap<string, ErrorCodeEntry> = new Map(
  ERROR_TABLE.codes.map((entry) => [entry.code, entry] as const),
);

/** `true` when `code` appears in Appendix C. */
export function isKnownErrorCode(code: string): boolean {
  return INDEX.has(code);
}

/**
 * Look up an Appendix C entry.
 *
 * @returns the entry, or `undefined` for a code this build of the spec does not
 * know (a plugin code, or a document produced by a newer reader).
 */
export function lookupErrorCode(code: string): ErrorCodeEntry | undefined {
  return INDEX.get(code);
}

/**
 * Default severity for `code`.
 *
 * Unknown codes default to `'error'`: a diagnostic nobody can classify must not
 * be silently downgraded to `info` and disappear from a `--max-severity` gate.
 */
export function severityOf(code: string): ErrorSeverity {
  return INDEX.get(code)?.severity ?? 'error';
}

/**
 * The Appendix C one-line meaning for `code`, suitable as a fallback
 * `Diagnostic.message` (SPEC 14.2: one sentence, no trailing period).
 */
export function summaryOf(code: string): string {
  return INDEX.get(code)?.summary ?? `Unknown diagnostic code ${code}`;
}

/** The `MDV1`…`MDV5` family a code belongs to, or `undefined` if malformed. */
export function groupOf(code: string): ErrorGroupKey | undefined {
  const prefix = code.slice(0, 4);
  switch (prefix) {
    case 'MDV1':
    case 'MDV2':
    case 'MDV3':
    case 'MDV4':
    case 'MDV5':
      return prefix;
    default:
      return undefined;
  }
}

/** Human name of a code family, e.g. `"encoding"` for `MDV3xxx`. */
export function groupName(code: string): string | undefined {
  const group = groupOf(code);
  return group === undefined ? undefined : ERROR_TABLE.groups[group];
}

/** Every code in one family, in Appendix C order. */
export function codesInGroup(group: ErrorGroupKey): readonly ErrorCodeEntry[] {
  return ERROR_TABLE.codes.filter((entry) => entry.code.startsWith(group));
}

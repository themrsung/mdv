/**
 * Diagnostics (SPEC 14).
 *
 * The `Diagnostic` type itself lives in `@mdv/parser` — the parser is the first
 * producer of diagnostics and core depends on the parser, not the reverse. This
 * module re-exports it so no consumer has to know that, and adds the
 * constructors every stage uses.
 *
 * Four principles bind everything here (SPEC 14.1):
 *
 * 1. A document always renders. No single bad block stops the rest.
 * 2. Failures are visible, not silent — an error card with the code, the message
 *    and the raw data, never an empty frame.
 * 3. Every diagnostic carries a precise range in the **original** document.
 * 4. Errors are data, not exceptions.
 */

import { severityOf, summaryOf } from '@mdv/spec';
import type {
  CodeFix,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  Position,
  Range,
} from '@mdv/parser';

export type {
  CodeFix,
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  Position,
  Range,
  TextEdit,
} from '@mdv/parser';

/** Options for {@link createDiagnostic}. */
export interface DiagnosticInit {
  /** Where in the original document. Required: SPEC 14.1 principle 3. */
  range: Range;
  /** Which pipeline stage produced it. */
  source: DiagnosticSource;
  /**
   * One sentence, no trailing period. Defaults to the Appendix C summary for the
   * code — always prefer a specific message that names the offending value.
   */
  message?: string;
  /** Explanation and fix, shown in the error card and on LSP hover. */
  detail?: string;
  /** Overrides the Appendix C default severity. Use sparingly. */
  severity?: DiagnosticSeverity;
  blockId?: string;
  fixes?: readonly CodeFix[];
}

/**
 * Build a {@link Diagnostic} from an Appendix C error code.
 *
 * Severity and the fallback message come from `@mdv/spec`'s error table, so a
 * change to Appendix C propagates everywhere without a code change. An unknown
 * code defaults to `error`: an unclassifiable problem must not silently become
 * `info` and slip past a `--max-severity` gate.
 *
 * @example
 * ```ts
 * ctx.diagnostic(createDiagnostic('MDV3021', {
 *   range: attrRange,
 *   source: 'encode',
 *   message: 'Bar axis does not include zero',
 *   detail: 'Remove `zero: false`, or switch to a line chart, which may be truncated.',
 * }));
 * ```
 */
export function createDiagnostic(code: string, init: DiagnosticInit): Diagnostic {
  const d: Diagnostic = {
    code,
    severity: init.severity ?? severityOf(code),
    message: init.message ?? summaryOf(code),
    range: init.range,
    source: init.source,
  };
  if (init.detail !== undefined) d.detail = init.detail;
  if (init.blockId !== undefined) d.blockId = init.blockId;
  if (init.fixes !== undefined && init.fixes.length > 0) d.fixes = [...init.fixes];
  return d;
}

/**
 * Apply `strict: true` (SPEC 14.3): every `warning` becomes an `error`.
 * `info` is untouched — a suggestion does not become a failure.
 *
 * @returns the same object when nothing changes, so callers can compare by
 * identity to detect promotion.
 */
export function applyStrict(d: Diagnostic, strict: boolean): Diagnostic {
  if (!strict || d.severity !== 'warning') return d;
  return { ...d, severity: 'error' };
}

/** `true` when the diagnostic prevents its block from rendering as specified. */
export function isBlocking(d: Diagnostic): boolean {
  return d.severity === 'error';
}

/** Severity ordering, most severe first. Used by `--max-severity` gates. */
const SEVERITY_RANK: Readonly<Record<DiagnosticSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

/** `true` when `d` is at least as severe as `threshold`. */
export function atLeast(d: Diagnostic, threshold: DiagnosticSeverity): boolean {
  return SEVERITY_RANK[d.severity] <= SEVERITY_RANK[threshold];
}

/**
 * Total order for diagnostics: document position, then code, then message.
 *
 * Diagnostic order is part of the fixture contract (`diagnostics.json`), so it
 * must not depend on the order stages happened to run in.
 */
export function compareDiagnostics(a: Diagnostic, b: Diagnostic): number {
  const byOffset = a.range.start.offset - b.range.start.offset;
  if (byOffset !== 0) return byOffset;
  const byEnd = a.range.end.offset - b.range.end.offset;
  if (byEnd !== 0) return byEnd;
  if (a.code !== b.code) return a.code < b.code ? -1 : 1;
  if (a.message !== b.message) return a.message < b.message ? -1 : 1;
  return 0;
}

/** A zero-width range at the start of the document, for whole-document diagnostics. */
export const DOCUMENT_START: Range = Object.freeze({
  start: Object.freeze({ offset: 0, line: 1, column: 1 }) as Position,
  end: Object.freeze({ offset: 0, line: 1, column: 1 }) as Position,
});

/**
 * Diagnostics raised by the exporter (SPEC 14.2, Appendix C).
 *
 * Severity and the one-line summary come from `@mdv/spec`'s error table rather
 * than from string literals here, so a change to Appendix C is a one-file change
 * and this package cannot drift from it.
 */

import { severityOf, summaryOf } from '@mdv/spec';
import type { Diagnostic, Range } from '@mdv/parser';

/** A zero-width range at the start of the document, for whole-file problems. */
export const NO_RANGE: Range = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 0, line: 1, column: 1 },
};

/** Build a render-stage diagnostic. */
export function renderDiagnostic(
  code: string,
  options: {
    message?: string;
    detail?: string;
    range?: Range;
    blockId?: string;
  } = {},
): Diagnostic {
  const diagnostic: Diagnostic = {
    code,
    severity: severityOf(code),
    message: options.message ?? summaryOf(code),
    range: options.range ?? NO_RANGE,
    source: 'render',
  };
  if (options.detail !== undefined) diagnostic.detail = options.detail;
  if (options.blockId !== undefined) diagnostic.blockId = options.blockId;
  return diagnostic;
}

/**
 * Thrown when the export cannot honour the profile it was asked for.
 *
 * SPEC 21 reserves exceptions for host programmer error; a PDF/UA export that
 * silently produced an untagged figure would be a broken promise, so `MDV5110`
 * is both a diagnostic and a thrown failure.
 */
export class PdfProfileError extends Error {
  override readonly name = 'PdfProfileError';
  readonly code: string;
  readonly diagnostics: readonly Diagnostic[];

  constructor(message: string, code: string, diagnostics: readonly Diagnostic[]) {
    super(message);
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

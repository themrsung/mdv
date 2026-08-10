/**
 * MDV {@link Diagnostic} → `vscode.Diagnostic` (SPEC 14.2, 14.4).
 *
 * SPEC 14.4 is the whole point of this file: "Every diagnostic's range refers to
 * the **original document**", so an editor can underline exactly the offending
 * attribute value. The parser tracks offsets through the header and data
 * sub-parses to make that true; here we only have to not throw the precision
 * away.
 *
 * Two representations must be reconciled. MDV positions are 1-based line and
 * column with an absolute `offset`; VS Code positions are 0-based line and
 * character. The **offset** is the reliable one — it is what the parser
 * computes directly — so ranges are converted through
 * `TextDocument.positionAt`, which also clamps a stale offset to the document
 * instead of producing a range VS Code will reject.
 */

import * as vscode from 'vscode';
import type { Diagnostic, Range } from '@mdv/parser';

/** VS Code's severity for an MDV severity (SPEC 14.3). */
function severityOf(severity: Diagnostic['severity']): vscode.DiagnosticSeverity {
  switch (severity) {
    case 'error':
      return vscode.DiagnosticSeverity.Error;
    case 'warning':
      return vscode.DiagnosticSeverity.Warning;
    case 'info':
      return vscode.DiagnosticSeverity.Information;
  }
}

/**
 * Convert an MDV range.
 *
 * A zero-width range at the end of a line renders as an invisible squiggle, so a
 * collapsed range is widened to the character it points at — the author needs to
 * see *something* under "missing separator".
 */
export function toVsRange(document: vscode.TextDocument, range: Range): vscode.Range {
  const startOffset = Math.max(0, range.start.offset);
  const endOffset = Math.max(startOffset, range.end.offset);
  const start = document.positionAt(startOffset);
  let end = document.positionAt(endOffset);
  if (start.isEqual(end)) {
    const lineEnd = document.lineAt(start.line).range.end;
    end = start.character < lineEnd.character ? start.translate(0, 1) : lineEnd;
    // A completely empty line still needs a range VS Code will draw.
    if (start.isEqual(end) && start.line + 1 < document.lineCount) {
      end = new vscode.Position(start.line + 1, 0);
    }
  }
  return new vscode.Range(start, end);
}

/** The Appendix C documentation URL for a code, shown in the Problems panel. */
function codeTarget(code: string): vscode.Uri | undefined {
  if (!/^MDV\d{4}$/.test(code)) return undefined;
  return vscode.Uri.parse(`https://mdv.dev/spec/errors#${code.toLowerCase()}`);
}

/** One MDV diagnostic as VS Code sees it. */
export function toVsDiagnostic(
  document: vscode.TextDocument,
  diagnostic: Diagnostic,
): vscode.Diagnostic {
  const converted = new vscode.Diagnostic(
    toVsRange(document, diagnostic.range),
    // `detail` is the explanation and the fix (SPEC 14.2); the Problems panel
    // shows one line, the hover shows the whole message, so both belong here.
    diagnostic.detail !== undefined && diagnostic.detail.length > 0
      ? `${diagnostic.message}\n\n${diagnostic.detail}`
      : diagnostic.message,
    severityOf(diagnostic.severity),
  );
  const target = codeTarget(diagnostic.code);
  converted.code = target === undefined ? diagnostic.code : { value: diagnostic.code, target };
  converted.source = `mdv (${diagnostic.source})`;
  return converted;
}

/** Convert a whole run, preserving document order. */
export function toVsDiagnostics(
  document: vscode.TextDocument,
  diagnostics: readonly Diagnostic[],
): vscode.Diagnostic[] {
  return diagnostics.map((diagnostic) => toVsDiagnostic(document, diagnostic));
}

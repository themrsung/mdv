/**
 * MDV diagnostics → LSP diagnostics (SPEC 14.2, 14.4).
 *
 * SPEC 14.4 is the reason this file is careful: "Every diagnostic's range refers
 * to the **original document**", so an editor can underline exactly the
 * offending attribute value. The parser tracks offsets through the header and
 * data sub-parses to make that true; the only job here is to not throw the
 * precision away.
 *
 * Two coordinate systems meet. MDV positions are 1-based line and column with an
 * absolute `offset`; LSP positions are 0-based line and UTF-16 character. The
 * **offset** is the reliable one — it is what the parser computes directly, and
 * the line/column pair is a convenience derived from it — so every range is
 * converted through {@link TextDocument.positionAt}, which also clamps an offset
 * from a stale run to the mirror instead of emitting a range the client will
 * reject.
 *
 * This is the same conversion the VS Code extension does against `vscode.
 * TextDocument`; the duplication is the price of `@mdv/lsp` owning no editor
 * API.
 */

import { DiagnosticSeverity } from './protocol/types.js';
import type { TextDocument } from './documents.js';
import type {
  Diagnostic as LspDiagnostic,
  DiagnosticSeverityValue,
  Range as LspRange,
  TextEdit as LspTextEdit,
} from './protocol/types.js';
import type {
  Diagnostic as MdvDiagnostic,
  Range as MdvRange,
  TextEdit as MdvTextEdit,
} from '@mdv/parser';

/** LSP's severity for an MDV severity (SPEC 14.3). */
function severityOf(severity: MdvDiagnostic['severity']): DiagnosticSeverityValue {
  switch (severity) {
    case 'error':
      return DiagnosticSeverity.error;
    case 'warning':
      return DiagnosticSeverity.warning;
    case 'info':
      return DiagnosticSeverity.information;
  }
}

/**
 * Convert an MDV range.
 *
 * A zero-width range draws as an invisible squiggle in most clients, so a
 * collapsed range is widened to the character it points at — the author needs to
 * see *something* under "missing separator". The widening steps over a whole
 * code point rather than one UTF-16 unit: a range that ends between the halves
 * of a surrogate pair is a range the client cannot slice.
 */
export function toLspRange(document: TextDocument, range: MdvRange): LspRange {
  const startOffset = Math.max(0, range.start.offset);
  const endOffset = Math.max(startOffset, range.end.offset);
  const start = document.positionAt(startOffset);
  const end = document.positionAt(endOffset);
  if (start.line !== end.line || start.character !== end.character) return { start, end };

  if (start.character < document.lineText(start.line).length) {
    const codePoint = document.text.codePointAt(startOffset);
    const step = codePoint !== undefined && codePoint > 0xffff ? 2 : 1;
    return { start, end: document.positionAt(startOffset + step) };
  }
  // At the end of a line there is nothing left to underline, so the squiggle
  // reaches to the start of the next one — which is where the newline the
  // diagnostic is usually complaining about lives.
  if (start.line + 1 < document.lineCount) {
    return { start, end: { line: start.line + 1, character: 0 } };
  }
  // The very end of the document: leave it collapsed rather than invent text.
  return { start, end };
}

/**
 * Convert a fix's replacement (SPEC 14.2).
 *
 * Deliberately not {@link toLspRange}: a collapsed range here is an *insertion*,
 * and widening it to the next character — right for a squiggle nobody could
 * otherwise see — would make the fix overwrite that character instead.
 */
export function toLspEdit(document: TextDocument, edit: MdvTextEdit): LspTextEdit {
  const startOffset = Math.max(0, edit.range.start.offset);
  const endOffset = Math.max(startOffset, edit.range.end.offset);
  return {
    range: { start: document.positionAt(startOffset), end: document.positionAt(endOffset) },
    newText: edit.newText,
  };
}

/** The Appendix C documentation URL for a code, when the code has one. */
function codeHref(code: string): string | undefined {
  if (!/^MDV\d{4}$/.test(code)) return undefined;
  return `https://mdv.dev/spec/errors#${code.toLowerCase()}`;
}

/**
 * The text an editor shows.
 *
 * `detail` is the explanation and the fix (SPEC 14.2). Clients render the whole
 * message in the hover and the first line in the problems list, so both parts
 * belong in one string, separated by a blank line.
 */
function messageOf(diagnostic: MdvDiagnostic): string {
  const { message, detail } = diagnostic;
  return detail !== undefined && detail.length > 0 ? `${message}\n\n${detail}` : message;
}

/** One MDV diagnostic as a client sees it. */
export function toLspDiagnostic(document: TextDocument, diagnostic: MdvDiagnostic): LspDiagnostic {
  const href = codeHref(diagnostic.code);
  return {
    range: toLspRange(document, diagnostic.range),
    severity: severityOf(diagnostic.severity),
    code: diagnostic.code,
    ...(href === undefined ? {} : { codeDescription: { href } }),
    // Which stage found it (SPEC 14.2) — the difference between a typo and a
    // blocked fetch matters to the reader of a problems panel.
    source: `mdv (${diagnostic.source})`,
    message: messageOf(diagnostic),
  };
}

/** Convert a whole run, preserving document order (SPEC 14.2). */
export function toLspDiagnostics(
  document: TextDocument,
  diagnostics: readonly MdvDiagnostic[],
): LspDiagnostic[] {
  return diagnostics.map((diagnostic) => toLspDiagnostic(document, diagnostic));
}

/**
 * Diagnostic construction and ordering (SPEC 14.2, 14.3).
 *
 * Default severities come from `@mdv/spec`'s Appendix C table rather than being
 * repeated here, so a change to Appendix C is a one-file change (CONTRACTS §3).
 */

import { severityOf, summaryOf } from '@mdv/spec';
import type { CodeFix, Diagnostic, DiagnosticSeverity, Range } from '../types.js';
import { compareStrings } from './source.js';

/** Everything a caller may override on top of the Appendix C defaults. */
export interface DiagnosticInit {
  /** Overrides the Appendix C summary. One sentence, no trailing period. */
  message?: string;
  detail?: string;
  blockId?: string;
  fixes?: CodeFix[];
  /** Overrides the Appendix C default severity. Used only where SPEC differs. */
  severity?: DiagnosticSeverity;
}

/**
 * Accumulates diagnostics during a parse and hands them back in document order.
 *
 * Deliberately append-only and comparator-sorted: SPEC 24.3 requires the same
 * source to produce byte-identical output, and diagnostic order is part of that.
 */
export class DiagnosticBag {
  private readonly items: Diagnostic[] = [];

  add(code: string, range: Range, init: DiagnosticInit = {}): Diagnostic {
    const diagnostic: Diagnostic = {
      code,
      severity: init.severity ?? severityOf(code),
      message: init.message ?? summaryOf(code),
      range,
      source: 'parse',
      ...(init.detail !== undefined ? { detail: init.detail } : {}),
      ...(init.blockId !== undefined ? { blockId: init.blockId } : {}),
      ...(init.fixes !== undefined && init.fixes.length > 0 ? { fixes: init.fixes } : {}),
    };
    this.items.push(diagnostic);
    return diagnostic;
  }

  /** `true` when a diagnostic with this code has already been recorded. */
  has(code: string): boolean {
    return this.items.some((item) => item.code === code);
  }

  /** A cursor into the bag, for use with {@link tagBlock}. */
  mark(): number {
    return this.items.length;
  }

  /**
   * Attach a block id to every diagnostic added since `mark`.
   *
   * A block's id lives in its own header, so it is only known once the header has
   * been parsed — by which time the header's diagnostics already exist. Tagging
   * afterwards keeps `Diagnostic.blockId` accurate without a two-pass parse.
   */
  tagBlock(mark: number, blockId: string): void {
    for (let i = mark; i < this.items.length; i += 1) {
      const item = this.items[i];
      if (item !== undefined && item.blockId === undefined) item.blockId = blockId;
    }
  }

  get length(): number {
    return this.items.length;
  }

  /** Every diagnostic, sorted by start offset, then end offset, then code. */
  drain(): Diagnostic[] {
    const sorted = this.items.slice();
    sorted.sort(compareDiagnosticOrder);
    return sorted;
  }
}

/** Total, locale-independent document order for diagnostics. */
export function compareDiagnosticOrder(a: Diagnostic, b: Diagnostic): number {
  if (a.range.start.offset !== b.range.start.offset) {
    return a.range.start.offset - b.range.start.offset;
  }
  if (a.range.end.offset !== b.range.end.offset) {
    return a.range.end.offset - b.range.end.offset;
  }
  const byCode = compareStrings(a.code, b.code);
  if (byCode !== 0) return byCode;
  return compareStrings(a.message, b.message);
}

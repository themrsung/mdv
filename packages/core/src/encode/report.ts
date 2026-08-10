/**
 * A tiny diagnostic sink shared by encode and layout.
 *
 * Every stage in this half of the pipeline reports the same way: a code from
 * Appendix C, a range in the *original* document, and a message that names the
 * offending value (SPEC 14.1 principle 3). Bundling the range and the block id
 * into one object keeps that discipline cheap enough that nobody is tempted to
 * skip it.
 */

import type { Diagnostic, DiagnosticSeverity, DiagnosticSource, Range } from '@mdv/parser';
import { createDiagnostic } from '../types/diagnostics.js';
import type { ResolvedBlock } from '../types/resolved.js';

/** What a reporter needs to turn a code into a located diagnostic. */
export interface Reporter {
  /** Default range: the block, or a specific attribute when one is known. */
  readonly range: Range;
  readonly blockId: string | undefined;
  readonly source: DiagnosticSource;
  /** Emit one diagnostic. */
  emit(code: string, options?: ReportOptions): void;
  /** A reporter for the same block pointing at a different attribute. */
  at(range: Range | undefined): Reporter;
}

/** Per-diagnostic overrides. */
export interface ReportOptions {
  message?: string;
  detail?: string;
  range?: Range;
  severity?: DiagnosticSeverity;
}

/** Build a reporter over an explicit range. */
export function createReporter(
  sink: (d: Diagnostic) => void,
  range: Range,
  source: DiagnosticSource,
  blockId?: string,
): Reporter {
  const reporter: Reporter = {
    range,
    blockId,
    source,
    emit(code: string, options: ReportOptions = {}): void {
      sink(
        createDiagnostic(code, {
          range: options.range ?? range,
          source,
          ...(options.message !== undefined ? { message: options.message } : {}),
          ...(options.detail !== undefined ? { detail: options.detail } : {}),
          ...(options.severity !== undefined ? { severity: options.severity } : {}),
          ...(blockId !== undefined ? { blockId } : {}),
        }),
      );
    },
    at(next: Range | undefined): Reporter {
      return next === undefined ? reporter : createReporter(sink, next, source, blockId);
    },
  };
  return reporter;
}

/**
 * Build a reporter for a block, defaulting to the block's own range.
 *
 * Prefer {@link attrRange} to narrow it: an editor should underline the offending
 * attribute value, not thirty lines of fence.
 */
export function blockReporter(
  block: ResolvedBlock,
  sink: (d: Diagnostic) => void,
  source: DiagnosticSource,
): Reporter {
  return createReporter(sink, block.range, source, block.id);
}

/**
 * The source range of one attribute, by its dotted path (`"axis.y.title"`,
 * `"y[1]"`), falling back to the whole block.
 */
export function attrRange(block: ResolvedBlock, path: string): Range {
  const positions = block.node.attrsPosition as Record<string, Range> | undefined;
  return positions?.[path] ?? block.range;
}

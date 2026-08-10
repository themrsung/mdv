/**
 * Diagnostic plumbing shared by the data, dataset, transform and expression
 * layers (SPEC 14.1 principle 4: errors are data, not exceptions).
 *
 * Every function in these layers takes a {@link DiagCollector} instead of
 * throwing. A collector fixes the source stage, the owning block and the
 * fallback range once, so call sites stay short and every diagnostic carries a
 * range in the **original** document (SPEC 14.1 principle 3).
 */

import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticSource,
  Range,
  UnistNode,
} from '@mdv/parser';
import { DOCUMENT_START, createDiagnostic } from '../types/diagnostics.js';

/** Per-call overrides for {@link DiagCollector.emit}. */
export interface DiagOptions {
  /** One sentence, no trailing period. Defaults to the Appendix C summary. */
  message?: string | undefined;
  detail?: string | undefined;
  /** Overrides the Appendix C default severity. Use sparingly. */
  severity?: DiagnosticSeverity | undefined;
  /** A tighter range than the collector's default. */
  range?: Range | undefined;
}

/** A sink that accumulates diagnostics for one stage. */
export interface DiagCollector {
  /** Diagnostics in emission order; the caller sorts before publishing. */
  readonly diagnostics: readonly Diagnostic[];
  emit(code: string, options?: DiagOptions): void;
  /** `true` once an `error`-severity diagnostic has been emitted. */
  readonly hasError: boolean;
  /** A collector writing into the same array with a different default range. */
  withRange(range: Range): DiagCollector;
  /** A collector writing into the same array under a different block id. */
  withBlock(blockId: string, range?: Range): DiagCollector;
}

interface CollectorState {
  readonly list: Diagnostic[];
  errors: number;
  readonly onEmit: ((d: Diagnostic) => void) | undefined;
}

function make(
  state: CollectorState,
  range: Range,
  source: DiagnosticSource,
  blockId: string | undefined,
): DiagCollector {
  const collector: DiagCollector = {
    get diagnostics(): readonly Diagnostic[] {
      return state.list;
    },
    get hasError(): boolean {
      return state.errors > 0;
    },
    emit(code: string, options?: DiagOptions): void {
      const d = createDiagnostic(code, {
        range: options?.range ?? range,
        source,
        ...(options?.message !== undefined ? { message: options.message } : {}),
        ...(options?.detail !== undefined ? { detail: options.detail } : {}),
        ...(options?.severity !== undefined ? { severity: options.severity } : {}),
        ...(blockId !== undefined ? { blockId } : {}),
      });
      if (d.severity === 'error') state.errors += 1;
      state.list.push(d);
      state.onEmit?.(d);
    },
    withRange(next: Range): DiagCollector {
      return make(state, next, source, blockId);
    },
    withBlock(id: string, next?: Range): DiagCollector {
      return make(state, next ?? range, source, id);
    },
  };
  return collector;
}

/** Create a root collector. `onEmit` mirrors to `MdvConfig.onDiagnostic`. */
export function createCollector(
  source: DiagnosticSource,
  range: Range = DOCUMENT_START,
  options?: { blockId?: string; onEmit?: (d: Diagnostic) => void },
): DiagCollector {
  const state: CollectorState = {
    list: [],
    errors: 0,
    onEmit: options?.onEmit,
  };
  return make(state, range, source, options?.blockId);
}

/**
 * The source range of a unist node, or {@link DOCUMENT_START} when the node was
 * synthesised without one. Never throws: a missing position must not cost a
 * diagnostic its home.
 */
export function rangeOfNode(node: UnistNode | { position?: unknown } | undefined): Range {
  const pos = (node as { position?: unknown } | undefined)?.position;
  if (pos === null || typeof pos !== 'object') return DOCUMENT_START;
  const p = pos as {
    start?: { offset?: number; line?: number; column?: number };
    end?: { offset?: number; line?: number; column?: number };
  };
  const s = p.start;
  const e = p.end;
  if (!s || !e) return DOCUMENT_START;
  return {
    start: { offset: s.offset ?? 0, line: s.line ?? 1, column: s.column ?? 1 },
    end: { offset: e.offset ?? s.offset ?? 0, line: e.line ?? s.line ?? 1, column: e.column ?? 1 },
  };
}

/** `true` when the diagnostic list contains an `error`. */
export function hasBlockingDiagnostic(diagnostics: readonly Diagnostic[]): boolean {
  for (const d of diagnostics) if (d.severity === 'error') return true;
  return false;
}

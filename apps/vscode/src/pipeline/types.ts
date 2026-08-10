/**
 * The pipeline's public shape — the only vocabulary the rest of the extension
 * uses to talk about "what is in this document".
 *
 * Nothing outside `pipeline/` imports `@mdv/core` internals. That is the seam
 * that makes the in-process implementation replaceable by an out-of-process
 * language server (SPEC 29.4) without touching the preview, the commands or the
 * diagnostics controller.
 */

import type { Diagnostic } from '@mdv/parser';
import type { Table } from '@mdv/core';
import type { BuiltinName } from './theme.js';

/** Everything the pipeline needs from the host, per run. */
export interface PipelineInputs {
  /** The document text, exactly as the editor has it. */
  readonly source: string;
  /** The document URI, used as the base for a relative `src:` and as a cache key. */
  readonly uri: string;
  /** Content width in CSS pixels. A block's own `width:` still wins. */
  readonly width: number;
  readonly theme: BuiltinName;
  /** SPEC 16.1 conformance level; `mdv.validate.level`. */
  readonly level: 1 | 2 | 3;
  /** SPEC 14.3: promotes warnings to errors. `mdv.validate.strict`. */
  readonly strict: boolean;
  /** `mdv.security.allowExternal`. */
  readonly allowExternal: boolean;
  /** `mdv.security.allowedOrigins`. */
  readonly allowedOrigins: readonly string[];
}

/** One visual block, rendered. */
export interface RenderedBlock {
  /** The author's `id:` or the deterministic `mdv-{index}` fallback. */
  readonly id: string;
  /** 0-based position among the document's visual blocks. */
  readonly index: number;
  readonly blockType: string;
  /** Title, for the outline and the quick pick. */
  readonly title: string | undefined;
  /** 0-based inclusive line of the opening fence, for scroll sync. */
  readonly startLine: number;
  /** 0-based inclusive line of the closing fence. */
  readonly endLine: number;
  /** Serialised SVG, ready to be inserted into the webview. Never a script. */
  readonly svg: string;
  /** `true` when the block rendered its error card instead of a chart. */
  readonly failed: boolean;
  /** The chart family, so the webview installs the right hover layer. */
  readonly family: string;
}

/** What one pipeline run produced. */
export interface PipelineResult {
  /** Every diagnostic from stages 1–6, in document order, `strict` applied. */
  readonly diagnostics: readonly Diagnostic[];
  readonly blocks: readonly RenderedBlock[];
  /**
   * Origins named by a `src:` the document could not load because
   * `mdv.security.allowExternal` is off. Drives the preview's consent banner
   * (SPEC 29.3) — naming them is not granting them.
   */
  readonly blockedOrigins: readonly string[];
  /** Which stages actually ran, for the trace log and for the tests. */
  readonly stats: PipelineStats;
}

/** Per-run stage accounting; the evidence that the pipeline is incremental. */
export interface PipelineStats {
  /** `false` when the parse from the previous run was reused. */
  readonly parsed: boolean;
  /** `false` when the data resolution from the previous run was reused. */
  readonly resolved: boolean;
  /** How many blocks were laid out and serialised afresh. */
  readonly laidOut: number;
  /** How many blocks reused the previous run's SVG. */
  readonly reused: number;
}

/** A block's prepared table, for `mdv.showData`. */
export interface BlockData {
  readonly id: string;
  readonly index: number;
  readonly blockType: string;
  readonly table: Table;
}

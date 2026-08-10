/**
 * Resource limits (SPEC 13.6).
 *
 * > Defaults, all configurable, all producing a diagnostic and a partial render
 * > rather than a hang.
 *
 * These are **mandatory**, not advisory: a document is untrusted input
 * (SPEC 13), and every one of these caps is the difference between a slow
 * document and an unresponsive host. Every enforcement point emits `MDV4031`
 * (or `MDV4000` / `MDV4030` where the spec names a more specific code) and
 * continues with truncated data.
 */

/** The SPEC 13.6 defaults. */
export const LIMITS = Object.freeze({
  /** Document size, in bytes. */
  maxDocumentBytes: 8 * 1024 * 1024,
  /** Visual blocks per document. */
  maxBlocksPerDocument: 500,
  /** Rows per block, **after** transforms. */
  maxRowsPerBlock: 100_000,
  /** Marks per block. Enforced by the encode stage; stated here for one table. */
  maxMarksPerBlock: 50_000,
  /** Fields per table. */
  maxFieldsPerTable: 512,
  /** Transform steps per block. */
  maxTransformSteps: 32,
  /** MDVX source length, in characters. */
  maxExpressionChars: 1024,
  /** MDVX AST depth. */
  maxExpressionDepth: 32,
  /** MDVX function calls per expression. */
  maxExpressionCalls: 64,
  /** Fetch timeout, in milliseconds (SPEC 13.2). */
  fetchTimeoutMs: 5000,
  /** Response size cap for one fetch, in bytes (SPEC 13.2). */
  maxFetchBytes: 8 * 1024 * 1024,
  /** Redirects a fetch capability may follow (SPEC 13.2). */
  maxRedirects: 2,
  /** Cached response lifetime, in seconds (SPEC 6.4). */
  cacheTtlSeconds: 300,
  /** JSON flattening depth (SPEC 6.2.3). */
  maxFlattenDepth: 4,
  /**
   * Cells produced by one preparation, counted as `rows × fields`. Not named
   * separately in SPEC 13.6, but a 512-field × 100 000-row table is 51 million
   * cells; the product is what actually bounds memory (SPEC 13.6, "Total memory
   * per document").
   */
  maxCellsPerTable: 4_000_000,
} as const);

/** The subset of {@link LIMITS} an embedder may lower through `MdvConfig`. */
export interface EffectiveLimits {
  maxDocumentBytes: number;
  maxRowsPerBlock: number;
  fetchTimeoutMs: number;
  maxFieldsPerTable: number;
  maxTransformSteps: number;
  maxCellsPerTable: number;
  maxFetchBytes: number;
  maxBlocksPerDocument: number;
  maxRedirects: number;
  cacheTtlSeconds: number;
  maxFlattenDepth: number;
  maxExpressionChars: number;
  maxExpressionDepth: number;
  maxExpressionCalls: number;
}

/** Fold configured overrides into the defaults. A non-finite override is ignored. */
export function effectiveLimits(overrides?: {
  maxDocumentBytes?: number | undefined;
  maxRowsPerBlock?: number | undefined;
  fetchTimeoutMs?: number | undefined;
}): EffectiveLimits {
  return {
    maxDocumentBytes: positive(overrides?.maxDocumentBytes, LIMITS.maxDocumentBytes),
    maxRowsPerBlock: positive(overrides?.maxRowsPerBlock, LIMITS.maxRowsPerBlock),
    fetchTimeoutMs: positive(overrides?.fetchTimeoutMs, LIMITS.fetchTimeoutMs),
    maxFieldsPerTable: LIMITS.maxFieldsPerTable,
    maxTransformSteps: LIMITS.maxTransformSteps,
    maxCellsPerTable: LIMITS.maxCellsPerTable,
    maxFetchBytes: LIMITS.maxFetchBytes,
    maxBlocksPerDocument: LIMITS.maxBlocksPerDocument,
    maxRedirects: LIMITS.maxRedirects,
    cacheTtlSeconds: LIMITS.cacheTtlSeconds,
    maxFlattenDepth: LIMITS.maxFlattenDepth,
    maxExpressionChars: LIMITS.maxExpressionChars,
    maxExpressionDepth: LIMITS.maxExpressionDepth,
    maxExpressionCalls: LIMITS.maxExpressionCalls,
  };
}

function positive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

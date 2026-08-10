/**
 * Engine error codes.
 *
 * The engine never throws bare `Error`s and never swallows a problem silently.
 * Anything that cannot be represented, resolved, or committed raises an
 * {@link EngineError} carrying one of these codes, so the UI layer can react
 * without string matching.
 *
 * These codes are **engine** codes and are deliberately disjoint from the
 * `MDVnnnn` diagnostic numbers of the specification: those describe documents,
 * these describe editing operations.
 */
export type EngineErrorCode =
  /** A selection referenced a block, cell, run, or offset that does not exist. */
  | 'EDIT_INVALID_SELECTION'
  /** A node id was not present in the document. */
  | 'EDIT_NODE_NOT_FOUND'
  /** A model invariant would be violated (e.g. a ragged table). */
  | 'EDIT_INVARIANT'
  /** The operation is meaningful but not applicable to the current selection. */
  | 'EDIT_NOT_APPLICABLE'
  /** A document could not be written because a node holds unrepresentable text. */
  | 'IO_UNREPRESENTABLE'
  /** An image blob could not be decoded by the injected codec. */
  | 'IMAGE_DECODE_FAILED'
  /** The engine was asked to use a browser facility that was not injected. */
  | 'ENV_UNAVAILABLE';

/** An error raised by the editing engine. */
export class EngineError extends Error {
  /** Machine-readable cause. */
  readonly code: EngineErrorCode;
  /** Structured context; always JSON-serialisable. */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: EngineErrorCode, message: string, detail: Record<string, unknown> = {}) {
    super(`${code}: ${message}`);
    this.name = 'EngineError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Narrow `value` to non-nullish or raise an invariant error.
 *
 * Exists because `noUncheckedIndexedAccess` makes every indexed read optional;
 * using this keeps the intent ("this index is known to exist") explicit rather
 * than papering over it with a non-null assertion.
 */
export function expect<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    throw new EngineError('EDIT_INVARIANT', message);
  }
  return value;
}

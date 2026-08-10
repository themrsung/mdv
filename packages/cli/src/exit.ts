/**
 * Process exit codes (SPEC 27) and the error type that carries one.
 *
 * These live apart from `index.ts` so every command module can import them
 * without importing the command dispatcher — the CLI is a tree, not a cycle.
 */

/**
 * Process exit codes (SPEC 27). These are part of the CLI's contract with CI:
 * changing one is a breaking change.
 */
export const EXIT_CODES = Object.freeze({
  /** Success. */
  ok: 0,
  /** Diagnostics at or above `--max-severity`. */
  diagnostics: 1,
  /** Usage error. */
  usage: 2,
  /** I/O error. */
  io: 3,
  /** Security refusal. */
  security: 4,
});

/** One of the four failure codes. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * An error the CLI knows how to print: a one-line message, an optional hint on
 * the following line, and the exit code it maps to.
 *
 * Anything else that escapes a command is a bug in this package and is reported
 * as such, with its stack, rather than being flattened into "something failed".
 */
export class CliError extends Error {
  override readonly name = 'CliError';
  readonly exitCode: ExitCode;
  /** A second line telling the user what to do instead. */
  readonly hint: string | undefined;

  constructor(message: string, exitCode: ExitCode, hint?: string) {
    super(message);
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

/** `2` — the invocation was wrong. */
export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_CODES.usage, hint);
}

/** `3` — a file could not be read or written. */
export function ioError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_CODES.io, hint);
}

/** `4` — the document asked for something the security policy refuses. */
export function securityError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT_CODES.security, hint);
}

/** A thrown value as one line, without assuming it is an `Error`. */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

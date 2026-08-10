/**
 * The extension's logging core, plus the two guards that keep a bug in MDV from
 * taking the extension host down with it.
 *
 * SPEC 29.8 sets a hard quality bar: activation must not block and the host must
 * survive whatever a document throws at it. VS Code treats an unhandled promise
 * rejection in an extension as a crash of that extension, so **every** async
 * entry point in this extension is wrapped in {@link safe} or {@link safeSync}
 * before it is handed to `vscode.commands.registerCommand`, an event listener or
 * a `setTimeout`. There is no other rule to remember.
 *
 * This module deliberately does **not** import `vscode`. The output channel and
 * the error notification live behind {@link LogSink}, installed once by
 * `channel.ts` during activation. Two reasons, in order of importance:
 *
 *  1. The pure half of the extension (the pipeline, the markdown-it integration)
 *     can then be unit-tested in a plain Node process, where `vscode` does not
 *     resolve at all.
 *  2. A log call that happens before activation, or after `deactivate` has torn
 *     the channel down, is a no-op instead of a throw from inside a `catch`.
 *
 * Telemetry: none (SPEC 29.8). Nothing here leaves the machine.
 */

/**
 * Where log lines and user-visible failures go.
 *
 * `report` is only called for failures the user directly caused (a command they
 * invoked, see {@link safeCommand}); background failures never interrupt.
 */
export interface LogSink {
  /** Append one already-formatted line to the log. Must not throw. */
  append(line: string): void;
  /** Surface a command failure to the user. Must not throw. */
  report(context: string, detail: string): void;
}

/** Installed by `channel.ts` in `activate`; absent in tests and after shutdown. */
let sink: LogSink | undefined;

/** Install (or, with `undefined`, remove) the sink. Idempotent. */
export function setLogSink(next: LogSink | undefined): void {
  sink = next;
}

function stamp(level: string, message: string): string {
  // A monotonically increasing marker, not a wall-clock date: the log is read in
  // order, and a timestamp would make two runs of the smoke script differ.
  return `[${level}] ${message}`;
}

/** Write to the sink, swallowing a sink that has itself gone wrong. */
function emit(line: string): void {
  if (sink === undefined) return;
  try {
    sink.append(line);
  } catch {
    /* a logger that throws must not become the failure being logged */
  }
}

export function log(message: string): void {
  emit(stamp('info', message));
}

export function warn(message: string): void {
  emit(stamp('warn', message));
}

/** Render an unknown thrown value without ever throwing itself. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.stack !== undefined && error.stack.length > 0
      ? error.stack
      : `${error.name}: ${error.message}`;
  }
  try {
    return String(error);
  } catch {
    return '<unprintable error>';
  }
}

export function logError(context: string, error: unknown): void {
  emit(stamp('error', `${context}: ${describeError(error)}`));
}

/**
 * Wrap an async handler so a rejection becomes a log line instead of an
 * unhandled rejection.
 *
 * The returned function is `void`-returning on purpose: VS Code's command and
 * event APIs accept a `Thenable`, but a `Thenable` we hand them is a `Thenable`
 * we no longer control. Swallowing the rejection *here*, where we still have the
 * context string, is what makes the log useful.
 */
export function safe<A extends unknown[]>(
  context: string,
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => void {
  return (...args: A): void => {
    let result: Promise<void> | void;
    try {
      result = fn(...args);
    } catch (error) {
      logError(context, error);
      return;
    }
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((error: unknown) => {
        logError(context, error);
      });
    }
  };
}

/**
 * Wrap a synchronous function that has a meaningful return value.
 *
 * On failure it logs and returns `fallback` — used for the stages that must
 * degrade rather than disappear (a preview that cannot render still shows its
 * shell; a document that cannot be validated keeps its previous squiggles).
 */
export function safeSync<T>(context: string, fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch (error) {
    logError(context, error);
    return fallback;
  }
}

/**
 * Report a failure the user asked for directly (a command they invoked).
 *
 * Background failures only reach the output channel; a command the user ran and
 * that then did nothing needs to say so.
 */
export function reportCommandFailure(context: string, error: unknown): void {
  logError(context, error);
  if (sink === undefined) return;
  const detail = error instanceof Error ? error.message : String(error);
  try {
    sink.report(context, detail);
  } catch {
    /* the notification itself failing is not worth another notification */
  }
}

/** `safe`, but a failure also surfaces to the user. For command handlers only. */
export function safeCommand<A extends unknown[]>(
  context: string,
  fn: (...args: A) => Promise<void> | void,
): (...args: A) => void {
  return (...args: A): void => {
    let result: Promise<void> | void;
    try {
      result = fn(...args);
    } catch (error) {
      reportCommandFailure(context, error);
      return;
    }
    if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((error: unknown) => {
        reportCommandFailure(context, error);
      });
    }
  };
}

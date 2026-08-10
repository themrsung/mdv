/**
 * `mdv watch` (SPEC 27) — rebuild on change.
 *
 * ```text
 * mdv watch report.mdv -o report.pdf
 * ```
 *
 * Runs the export once, then again on every change to the file, until the
 * process is interrupted. `--serve` is **not** implemented in this build and is
 * refused rather than ignored: a live preview server is an HTTP server plus a
 * websocket, and pretending it started while nothing listens is worse than
 * saying so.
 *
 * Rebuild failures do not end the watch — a half-saved file is the normal case
 * for a file watcher — but they are printed in full.
 */

import { watch } from 'node:fs';

import type { GlobalFlags } from '../args.js';
import { CliError, EXIT_CODES, errorText, usageError } from '../exit.js';
import { absolute, displayPath } from '../io.js';
import type { CliIo } from '../io.js';
import { exportCommand } from './export.js';
import type { ExportFlags } from './export.js';
import { createTerm } from '../term.js';

/** Flags `mdv watch` accepts on top of the global ones. */
export interface WatchFlags extends ExportFlags {
  serve?: boolean;
  port?: number;
}

/** Coalescing window for editor "save" storms, in milliseconds. */
const DEBOUNCE_MS = 40;

/** `mdv watch` — rebuild on change. */
export async function watchCommand(
  io: CliIo,
  files: readonly string[],
  flags: WatchFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  if (flags.serve === true) {
    throw usageError(
      '`mdv watch --serve` is not implemented in this build',
      'The live preview server (SPEC 27) is not built yet. `mdv watch` without --serve rebuilds on change.',
    );
  }

  const input = files[0];
  if (input === undefined) {
    throw usageError('watch: no input file', 'Usage: mdv watch <file.mdv> -o <out.pdf>');
  }
  const abs = absolute(io, input);

  const rebuild = async (): Promise<void> => {
    try {
      await exportCommand(io, [abs], flags);
    } catch (error) {
      if (error instanceof CliError) {
        term.problem(`${term.red('error')} ${error.message}`);
        if (error.hint !== undefined) term.problem(`        ${term.dim(error.hint)}`);
      } else {
        term.problem(`${term.red('error')} ${errorText(error)}`);
      }
    }
  };

  await rebuild();
  term.status(`Watching ${displayPath(io, abs)} — press Ctrl-C to stop`);

  await new Promise<void>((resolveWatch) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let pending = false;

    const drain = (): void => {
      if (running) {
        pending = true;
        return;
      }
      running = true;
      void rebuild().finally(() => {
        running = false;
        if (pending) {
          pending = false;
          drain();
        }
      });
    };

    let watcher: ReturnType<typeof watch>;
    try {
      watcher = watch(abs, () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(drain, DEBOUNCE_MS);
      });
    } catch (error) {
      term.problem(`${term.red('error')} cannot watch ${displayPath(io, abs)}: ${errorText(error)}`);
      resolveWatch();
      return;
    }

    const stop = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      watcher.close();
      resolveWatch();
    };

    watcher.on('error', (error: unknown) => {
      term.problem(`${term.red('error')} watch failed: ${errorText(error)}`);
      stop();
    });

    const signal = io.signal;
    if (signal !== undefined) {
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    }
  });

  return EXIT_CODES.ok;
}

/**
 * Terminal output: one place that decides whether colour is allowed and where a
 * line goes.
 *
 * Colour is on only for an interactive stdout with no `NO_COLOR` in the
 * environment and no `--no-color` on the command line. Redirected output is
 * therefore plain text, which is what makes `mdv lint > report.txt` readable and
 * `mdv data x.mdv > x.csv` correct.
 */

import type { GlobalFlags } from './args.js';
import type { CliIo } from './io.js';

const ESC = '[';

/** A styled-output helper bound to one invocation. */
export interface Term {
  /** `true` when ANSI escapes may be emitted. */
  readonly color: boolean;
  /** `true` when `--quiet` suppressed status lines. */
  readonly quiet: boolean;
  /** Content. Goes to stdout, exactly as given. */
  out(text: string): void;
  /** Content, with a trailing newline. */
  line(text?: string): void;
  /** Status. Goes to stderr and is suppressed by `--quiet`. */
  status(text: string): void;
  /** A problem. Goes to stderr and is never suppressed. */
  problem(text: string): void;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  green(text: string): string;
}

function wrap(code: string, reset: string, on: boolean): (text: string) => string {
  return on
    ? (text: string): string => `${ESC}${code}${text}${ESC}${reset}`
    : (text: string): string => text;
}

/** Decide colour and bind the streams. */
export function createTerm(io: CliIo, flags: GlobalFlags): Term {
  const noColorEnv = io.env['NO_COLOR'];
  const dumb = io.env['TERM'] === 'dumb';
  const color =
    io.isTty && flags.noColor !== true && !dumb && (noColorEnv === undefined || noColorEnv === '');
  const quiet = flags.quiet === true;

  return {
    color,
    quiet,
    out(text: string): void {
      io.stdout.write(text);
    },
    line(text = ''): void {
      io.stdout.write(`${text}\n`);
    },
    status(text: string): void {
      if (!quiet) io.stderr.write(`${text}\n`);
    },
    problem(text: string): void {
      io.stderr.write(`${text}\n`);
    },
    bold: wrap('1m', '22m', color),
    dim: wrap('2m', '22m', color),
    red: wrap('31m', '39m', color),
    yellow: wrap('33m', '39m', color),
    blue: wrap('34m', '39m', color),
    green: wrap('32m', '39m', color),
  };
}

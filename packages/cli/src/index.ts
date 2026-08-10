/**
 * `@mdv/cli` — `render`, `export`, `lint`, `fmt`, `watch`, `data`,
 * `validate-theme`, `init` (SPEC 27).
 *
 * ```text
 * mdv render <file>            Render to the terminal (text backend)
 * mdv export <file>            Export: --to pdf|html|svg|png|md|json
 * mdv lint <glob>              Diagnostics; --max-severity, --format json|pretty|sarif
 * mdv fmt <glob>               Canonical formatting; --check for CI
 * mdv watch <file>             Rebuild on change; --serve for a live preview server
 * mdv data <file>              Print a block's resolved table; --block <id> --to csv|json
 * mdv validate-theme <file>    Run the palette validator
 * mdv init                     Scaffold a document with front matter
 * ```
 *
 * Two things hold throughout:
 *
 * - **Nothing here calls `process.exit`.** `run` returns a code and `src/bin.ts`
 *   applies it, so the whole CLI is testable in-process with an injected
 *   {@link CliIo}.
 * - **Output is deterministic.** No clock (`--build-time`, defaulting to the
 *   epoch), no host locale or timezone, and glob results sorted by codepoint —
 *   so two runs of the same command produce the same bytes (SPEC 24.3).
 *
 * *CONTRACT: `CONTRACTS.md` §3 lists the per-command functions with the shape
 * `(files, flags)`. They take the injected `CliIo` first here, because a command
 * that cannot write anywhere cannot be a command; the names and the exit codes
 * are unchanged.*
 */

import { CORE_VERSION, MdvConfigError, SPEC_VERSION } from '@mdv/core';

import {
  booleanOption,
  globalFlags,
  intOption,
  isCommandName,
  numberOption,
  parseCommandArgs,
  stringOption,
  togglePair,
} from './args.js';
import type { CommandName, GlobalFlags, OptionValues } from './args.js';
import { COMMAND_NAMES } from './args.js';
import { CliError, EXIT_CODES, errorText, usageError } from './exit.js';
import type { CliIo } from './io.js';
import { commandHelp, globalHelp } from './help.js';
import { createTerm } from './term.js';
import { dataCommand } from './commands/data.js';
import { exportCommand } from './commands/export.js';
import { fmtCommand } from './commands/fmt.js';
import { initCommand } from './commands/init.js';
import { lintCommand } from './commands/lint.js';
import { renderCommand } from './commands/render.js';
import { validateThemeCommand } from './commands/theme.js';
import { watchCommand } from './commands/watch.js';

/** This build's version, reported by `mdv --version`. */
export const CLI_VERSION = '0.0.0';

/**
 * Exit code for a bug in this package: not one of SPEC 27's four, deliberately,
 * so a crash can never be mistaken for "lint found problems" in CI.
 * `EX_SOFTWARE` from `sysexits.h`.
 */
export const INTERNAL_ERROR = 70;

/** `mdv 0.0.0 (spec …, core …)`. */
export function versionLine(): string {
  return `mdv ${CLI_VERSION} (spec ${SPEC_VERSION}, core ${CORE_VERSION})`;
}

/** Suggest a command for a misspelling, by shared prefix then by edit distance. */
function suggest(word: string): string | undefined {
  const lower = word.toLowerCase();
  const prefix = COMMAND_NAMES.find((name) => name.startsWith(lower) || lower.startsWith(name));
  if (prefix !== undefined) return prefix;

  let best: CommandName | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const name of COMMAND_NAMES) {
    // Levenshtein, iterative, two rows.
    let previous = Array.from({ length: name.length + 1 }, (_, i) => i);
    for (let i = 1; i <= lower.length; ++i) {
      const current: number[] = [i];
      for (let j = 1; j <= name.length; ++j) {
        const cost = lower[i - 1] === name[j - 1] ? 0 : 1;
        current.push(
          Math.min(
            (current[j - 1] ?? 0) + 1,
            (previous[j] ?? 0) + 1,
            (previous[j - 1] ?? 0) + cost,
          ),
        );
      }
      previous = current;
    }
    const score = previous[name.length] ?? Number.POSITIVE_INFINITY;
    if (score < bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return bestScore <= 3 ? best : undefined;
}

/** Dispatch one parsed command. */
async function dispatch(
  io: CliIo,
  command: CommandName,
  positionals: readonly string[],
  values: OptionValues,
): Promise<number> {
  const flags: GlobalFlags = globalFlags(values);

  switch (command) {
    case 'render': {
      const out = stringOption(values, 'out');
      const width = intOption(values, 'width');
      const block = stringOption(values, 'block');
      const rows = intOption(values, 'rows');
      return renderCommand(io, positionals, {
        ...flags,
        ...(out === undefined ? {} : { out }),
        ...(width === undefined ? {} : { width }),
        ...(block === undefined ? {} : { block }),
        ...(rows === undefined ? {} : { rows }),
      });
    }
    case 'export':
    case 'watch': {
      const out = stringOption(values, 'out');
      const to = stringOption(values, 'to');
      const width = intOption(values, 'width');
      const block = stringOption(values, 'block');
      const scale = numberOption(values, 'scale');
      const compress = togglePair(values, 'compress');
      const embedSource = togglePair(values, 'embed-source');
      const profile = stringOption(values, 'profile');
      const pageSize = stringOption(values, 'page-size');
      const orientation = stringOption(values, 'orientation');
      const shared = {
        ...flags,
        ...(out === undefined ? {} : { out }),
        ...(to === undefined ? {} : { to }),
        ...(width === undefined ? {} : { width }),
        ...(block === undefined ? {} : { block }),
        ...(scale === undefined ? {} : { scale }),
        ...(compress === undefined ? {} : { compress }),
        ...(embedSource === undefined ? {} : { embedSource }),
        ...(profile === undefined ? {} : { profile }),
        ...(pageSize === undefined ? {} : { pageSize }),
        ...(orientation === undefined ? {} : { orientation }),
        ...(booleanOption(values, 'paginate') === true ? { paginate: true } : {}),
      };
      if (command === 'export') return exportCommand(io, positionals, shared);
      const port = intOption(values, 'port');
      return watchCommand(io, positionals, {
        ...shared,
        ...(booleanOption(values, 'serve') === true ? { serve: true } : {}),
        ...(port === undefined ? {} : { port }),
      });
    }
    case 'lint': {
      const maxSeverity = stringOption(values, 'max-severity');
      const format = stringOption(values, 'format');
      return lintCommand(io, positionals, {
        ...flags,
        ...(maxSeverity === undefined ? {} : { maxSeverity }),
        ...(format === undefined ? {} : { format }),
      });
    }
    case 'fmt':
      return fmtCommand(io, positionals, {
        ...flags,
        ...(booleanOption(values, 'check') === true ? { check: true } : {}),
      });
    case 'data': {
      const block = stringOption(values, 'block');
      const to = stringOption(values, 'to');
      return dataCommand(io, positionals, {
        ...flags,
        ...(block === undefined ? {} : { block }),
        ...(to === undefined ? {} : { to }),
      });
    }
    case 'validate-theme': {
      const scheme = stringOption(values, 'scheme');
      return validateThemeCommand(io, positionals, {
        ...flags,
        ...(scheme === undefined ? {} : { scheme }),
      });
    }
    case 'init':
      return initCommand(io, positionals, {
        ...flags,
        ...(booleanOption(values, 'force') === true ? { force: true } : {}),
      });
  }
}

/**
 * Run the CLI.
 *
 * @param argv - arguments **after** the node executable and the script path
 * @param io - injected streams and process access, so the CLI is testable
 * without spawning a process
 * @returns the process exit code; the binary calls `process.exit` with it. This
 * function never calls `process.exit` itself, and never throws: every failure
 * becomes a printed message and a code.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
  const first = argv[0];

  try {
    if (first === undefined) {
      io.stderr.write(globalHelp(CLI_VERSION));
      return EXIT_CODES.usage;
    }

    if (first === '--help' || first === '-h' || first === 'help') {
      const topic = argv[1];
      if (topic !== undefined && isCommandName(topic)) {
        io.stdout.write(commandHelp(topic));
        return EXIT_CODES.ok;
      }
      if (topic !== undefined) {
        throw usageError(`No help for \`${topic}\``, `Commands: ${COMMAND_NAMES.join(', ')}`);
      }
      io.stdout.write(globalHelp(CLI_VERSION));
      return EXIT_CODES.ok;
    }

    if (first === '--version' || first === '-v') {
      io.stdout.write(`${versionLine()}\n`);
      return EXIT_CODES.ok;
    }

    if (first.startsWith('-')) {
      throw usageError(
        `Expected a command, got the flag \`${first}\``,
        `Commands: ${COMMAND_NAMES.join(', ')}`,
      );
    }

    if (!isCommandName(first)) {
      const hint = suggest(first);
      throw usageError(
        `Unknown command \`${first}\``,
        hint === undefined
          ? `Commands: ${COMMAND_NAMES.join(', ')}`
          : `Did you mean \`mdv ${hint}\`?`,
      );
    }

    const parsed = parseCommandArgs(argv.slice(1), first);
    if (parsed.help) {
      io.stdout.write(commandHelp(first));
      return EXIT_CODES.ok;
    }
    return await dispatch(io, first, parsed.positionals, parsed.values);
  } catch (error) {
    return report(io, error);
  }
}

/** Print a failure the way the user should see it, and pick its exit code. */
function report(io: CliIo, error: unknown): number {
  // Colour decided without flags: the command line may not have parsed.
  const term = createTerm(io, {});

  if (error instanceof CliError) {
    io.stderr.write(`${term.red('error')} ${error.message}\n`);
    if (error.hint !== undefined) io.stderr.write(`      ${term.dim(error.hint)}\n`);
    return error.exitCode;
  }

  if (error instanceof MdvConfigError) {
    // Host programmer error, which from the CLI's side is the user's config.
    const at = error.path === undefined ? '' : ` (at \`${error.path}\`)`;
    io.stderr.write(`${term.red('error')} invalid configuration${at}: ${error.message}\n`);
    return EXIT_CODES.usage;
  }

  io.stderr.write(`${term.red('internal error')} ${errorText(error)}\n`);
  if (error instanceof Error && error.stack !== undefined) {
    io.stderr.write(`${term.dim(error.stack)}\n`);
  }
  io.stderr.write(
    term.dim('This is a bug in mdv. Please report it with the document that triggered it.\n'),
  );
  return INTERNAL_ERROR;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public surface
// ─────────────────────────────────────────────────────────────────────────────

export { EXIT_CODES, CliError } from './exit.js';
export type { ExitCode } from './exit.js';
export type { CliIo } from './io.js';
export type { GlobalFlags, CommandName } from './args.js';
export { COMMAND_NAMES, isCommandName } from './args.js';
export { globalHelp, commandHelp } from './help.js';

export { renderCommand } from './commands/render.js';
export type { RenderFlags } from './commands/render.js';
export { exportCommand, resolveTarget, EXPORT_TARGETS } from './commands/export.js';
export type { ExportFlags, ExportTarget } from './commands/export.js';
export { lintCommand } from './commands/lint.js';
export type { LintFlags, LintFormat } from './commands/lint.js';
export { fmtCommand } from './commands/fmt.js';
export type { FmtFlags } from './commands/fmt.js';
export { watchCommand } from './commands/watch.js';
export type { WatchFlags } from './commands/watch.js';
export { dataCommand } from './commands/data.js';
export type { DataFlags } from './commands/data.js';
export { validateThemeCommand } from './commands/theme.js';
export type { ValidateThemeFlags } from './commands/theme.js';
export { initCommand, SCAFFOLD } from './commands/init.js';
export type { InitFlags } from './commands/init.js';

export { expandInputs, DOCUMENT_EXTENSIONS } from './io.js';
export { loadDocument, buildConfig, builtinsPlugin, securityRefusals } from './pipeline.js';
export type { LoadedDocument } from './pipeline.js';
export { sceneFor, selectBlock, selectBlocks, DEFAULT_WIDTH } from './scene.js';
export { tableToCsv, tableToJson, tableToText, cellText } from './table.js';
export {
  atOrAbove,
  countDiagnostics,
  formatJson,
  formatPretty,
  formatSarif,
  parseSeverity,
  severityRank,
  summarise,
} from './report.js';
export type { DiagnosticCounts, FileDiagnostics } from './report.js';
export { createTerm } from './term.js';
export type { Term } from './term.js';

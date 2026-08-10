/**
 * Argument parsing, on `node:util`'s `parseArgs` and nothing else.
 *
 * `parseArgs` is strict here: an unknown flag is a usage error (exit 2) with the
 * list of flags the command does accept, because a silently ignored
 * `--max-severity` in a CI script is worse than a failed build.
 */

import { parseArgs } from 'node:util';
import type { ParseArgsConfig } from 'node:util';

import { usageError } from './exit.js';

/** The option table shape `parseArgs` accepts. */
export type OptionTable = NonNullable<ParseArgsConfig['options']>;

/** Values `parseArgs` hands back. */
export type OptionValues = Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;

/** Global flags, accepted by every subcommand (SPEC 27). */
export interface GlobalFlags {
  config?: string;
  theme?: string;
  level?: 1 | 2 | 3;
  strict?: boolean;
  locale?: string;
  timezone?: string;
  /** Pins `now()` (SPEC 24.3 rule 2). ISO 8601. */
  buildTime?: string;
  allowExternal?: boolean;
  allowFile?: boolean;
  quiet?: boolean;
  noColor?: boolean;
}

/** Flags every command accepts (SPEC 27). */
export const GLOBAL_OPTIONS = {
  config: { type: 'string' },
  theme: { type: 'string' },
  level: { type: 'string' },
  strict: { type: 'boolean' },
  locale: { type: 'string' },
  timezone: { type: 'string' },
  'build-time': { type: 'string' },
  'allow-external': { type: 'boolean' },
  'allow-file': { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  'no-color': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies OptionTable;

/** Per-command options, merged over {@link GLOBAL_OPTIONS}. */
export const COMMAND_OPTIONS = {
  render: {
    out: { type: 'string', short: 'o' },
    width: { type: 'string' },
    block: { type: 'string' },
    rows: { type: 'string' },
  },
  export: {
    to: { type: 'string' },
    out: { type: 'string', short: 'o' },
    width: { type: 'string' },
    block: { type: 'string' },
    scale: { type: 'string' },
    paginate: { type: 'boolean' },
    compress: { type: 'boolean' },
    'no-compress': { type: 'boolean' },
    'embed-source': { type: 'boolean' },
    'no-embed-source': { type: 'boolean' },
    profile: { type: 'string' },
    'page-size': { type: 'string' },
    orientation: { type: 'string' },
  },
  lint: {
    'max-severity': { type: 'string' },
    format: { type: 'string' },
  },
  fmt: {
    check: { type: 'boolean' },
  },
  watch: {
    out: { type: 'string', short: 'o' },
    to: { type: 'string' },
    serve: { type: 'boolean' },
    port: { type: 'string' },
  },
  data: {
    block: { type: 'string' },
    to: { type: 'string' },
  },
  'validate-theme': {
    scheme: { type: 'string' },
  },
  init: {
    force: { type: 'boolean', short: 'f' },
  },
} as const satisfies Record<string, OptionTable>;

/** Every subcommand name (SPEC 27). */
export const COMMAND_NAMES = Object.freeze([
  'render',
  'export',
  'lint',
  'fmt',
  'watch',
  'data',
  'validate-theme',
  'init',
] as const);

/** A subcommand name. */
export type CommandName = (typeof COMMAND_NAMES)[number];

/** `true` when `value` names a subcommand. */
export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

/** Parsed command line: the values, the positionals, and `--help`. */
export interface ParsedArgs {
  values: OptionValues;
  positionals: readonly string[];
  help: boolean;
}

/**
 * Parse one command's arguments.
 *
 * @throws CliError (exit 2) for an unknown or malformed flag, naming the flags
 * this command accepts.
 */
export function parseCommandArgs(
  argv: readonly string[],
  command: CommandName | undefined,
): ParsedArgs {
  const table: OptionTable = {
    ...GLOBAL_OPTIONS,
    ...(command === undefined ? {} : COMMAND_OPTIONS[command]),
  };
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: table,
      strict: true,
      allowPositionals: true,
    });
  } catch (error) {
    const known = Object.keys(table)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((name) => `--${name}`)
      .join(' ');
    const message = error instanceof Error ? error.message : String(error);
    throw usageError(
      command === undefined ? message : `${command}: ${message}`,
      `Accepted flags: ${known}`,
    );
  }
  return {
    values: parsed.values as OptionValues,
    positionals: parsed.positionals,
    help: parsed.values['help'] === true,
  };
}

/** A string-valued option, or `undefined`. Repeated options take the last. */
export function stringOption(values: OptionValues, name: string): string | undefined {
  const value = values[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; --i) {
      const item = value[i];
      if (typeof item === 'string') return item;
    }
  }
  return undefined;
}

/** A boolean option. Absent is `undefined`, not `false`, so it can be defaulted. */
export function booleanOption(values: OptionValues, name: string): boolean | undefined {
  const value = values[name];
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    for (let i = value.length - 1; i >= 0; --i) {
      const item = value[i];
      if (typeof item === 'boolean') return item;
    }
  }
  return undefined;
}

/** A positive integer option (`--width`, `--port`). */
export function intOption(values: OptionValues, name: string): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw usageError(`--${name} must be a whole number, got \`${raw}\``);
  }
  return Number.parseInt(raw.trim(), 10);
}

/** A finite number option (`--scale`). */
export function numberOption(values: OptionValues, name: string): number | undefined {
  const raw = stringOption(values, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed)) {
    throw usageError(`--${name} must be a number, got \`${raw}\``);
  }
  return parsed;
}

/**
 * Collect the global flags.
 *
 * @throws CliError (exit 2) for `--level 4` or an unparseable `--build-time` —
 * both are silent wrongness otherwise: level 4 would fall back to the default and
 * a bad build time would pin the export to `Invalid Date`.
 */
export function globalFlags(values: OptionValues): GlobalFlags {
  const flags: GlobalFlags = {};

  const config = stringOption(values, 'config');
  if (config !== undefined) flags.config = config;

  const theme = stringOption(values, 'theme');
  if (theme !== undefined) flags.theme = theme;

  const level = stringOption(values, 'level');
  if (level !== undefined) {
    if (level !== '1' && level !== '2' && level !== '3') {
      throw usageError(`--level must be 1, 2 or 3, got \`${level}\``);
    }
    flags.level = level === '1' ? 1 : level === '2' ? 2 : 3;
  }

  if (booleanOption(values, 'strict') === true) flags.strict = true;

  const locale = stringOption(values, 'locale');
  if (locale !== undefined) flags.locale = locale;

  const timezone = stringOption(values, 'timezone');
  if (timezone !== undefined) flags.timezone = timezone;

  const buildTime = stringOption(values, 'build-time');
  if (buildTime !== undefined) {
    if (Number.isNaN(Date.parse(buildTime))) {
      throw usageError(
        `--build-time is not a date: \`${buildTime}\``,
        'Use an ISO 8601 instant, e.g. --build-time 2026-01-31T00:00:00Z',
      );
    }
    flags.buildTime = buildTime;
  }

  if (booleanOption(values, 'allow-external') === true) flags.allowExternal = true;
  if (booleanOption(values, 'allow-file') === true) flags.allowFile = true;
  if (booleanOption(values, 'quiet') === true) flags.quiet = true;
  if (booleanOption(values, 'no-color') === true) flags.noColor = true;

  return flags;
}

/**
 * Resolve a tri-state pair of flags (`--compress` / `--no-compress`).
 *
 * @throws CliError (exit 2) when both are given — an ambiguous command line is a
 * mistake, and picking one silently hides it.
 */
export function togglePair(
  values: OptionValues,
  name: string,
): boolean | undefined {
  const on = booleanOption(values, name);
  const off = booleanOption(values, `no-${name}`);
  if (on === true && off === true) {
    throw usageError(`--${name} and --no-${name} cannot both be given`);
  }
  if (off === true) return false;
  if (on === true) return true;
  return undefined;
}

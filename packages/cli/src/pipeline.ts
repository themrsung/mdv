/**
 * From a path on disk to a `ResolvedDocument`.
 *
 * Everything impure the pipeline is allowed to do arrives here as an injected
 * capability (SPEC 25.2, invariant 1): the network only with `--allow-external`,
 * the filesystem only with `--allow-file`, and the clock never — `buildTime` is
 * `--build-time` or the epoch, so two runs of the same command produce the same
 * bytes (SPEC 24.3 rule 2).
 */

import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { readFile as readFileRaw } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { builtinChartTypes } from '@mdv/charts';
import { getBuiltinTheme, listBuiltinThemes, resolveTheme } from '@mdv/themes';
import { parse, resolve as resolveDocument } from '@mdv/core';
import type {
  Capabilities,
  ColorScheme,
  FetchInit,
  FetchResult,
  MdvConfig,
  MdvPlugin,
  ResolvedDocument,
  Theme,
  ThemeOverride,
} from '@mdv/core';
import type { Diagnostic, MdvDocument } from '@mdv/parser';

import type { GlobalFlags } from './args.js';
import { CliError, EXIT_CODES, errorText, ioError, usageError } from './exit.js';
import { absolute, displayPath, readTextFile } from './io.js';
import type { CliIo } from './io.js';
import type { Term } from './term.js';

/** Reported as the plugin that contributed the built-ins. */
export const CLI_VERSION = '0.0.0';

/** A document, read and resolved, with everything a command needs about it. */
export interface LoadedDocument {
  /** Absolute path. */
  path: string;
  /** How to name the file in a message. */
  display: string;
  /** The original text, byte-for-byte, for `embedSource` and for `fmt`. */
  source: string;
  doc: MdvDocument;
  resolved: ResolvedDocument;
}

// ─────────────────────────────────────────────────────────────────────────────
// Capabilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A filesystem capability rooted at the document's own directory.
 *
 * A `src:` may not escape that directory. A document is data, and data that can
 * read `../../.ssh/id_rsa` and plot it is an exfiltration primitive, not a
 * feature (SPEC 13).
 */
function fileCapability(root: string): (path: string) => Promise<Uint8Array> {
  return async (path: string): Promise<Uint8Array> => {
    const target = isAbsolute(path) ? path : resolvePath(root, path);
    const rel = relative(root, target);
    if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
      throw new Error(
        `refusing to read \`${path}\`: it is outside the document's directory (${root})`,
      );
    }
    return new Uint8Array(await readFileRaw(target));
  };
}

/** A network capability over the host `fetch`, honouring the configured timeout. */
function fetchCapability(): (url: string, init: FetchInit) => Promise<FetchResult> {
  return async (url: string, init: FetchInit): Promise<FetchResult> => {
    const host = (globalThis as { fetch?: typeof fetch }).fetch;
    if (host === undefined) {
      throw new Error('this Node build has no global fetch; upgrade to Node 20.11 or newer');
    }
    const controller = new AbortController();
    const timeout =
      init.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            controller.abort();
          }, init.timeoutMs);
    try {
      const response = await host(url, {
        method: 'GET',
        signal: controller.signal,
        redirect: 'follow',
        ...(init.headers === undefined ? {} : { headers: { ...init.headers } }),
      });
      const body = new Uint8Array(await response.arrayBuffer());
      const contentType = response.headers.get('content-type') ?? undefined;
      return {
        status: response.status,
        url: response.url === '' ? url : response.url,
        body,
        ...(contentType === undefined ? {} : { contentType }),
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

function capabilitiesFor(flags: GlobalFlags, documentDir: string, term: Term): Capabilities {
  const caps: Capabilities = {};
  if (flags.allowFile === true) caps.readFile = fileCapability(documentDir);
  if (flags.allowExternal === true) caps.fetch = fetchCapability();
  caps.logger = {
    debug(): void {
      // Debug logging is off unless someone asks for it; there is no --verbose yet.
    },
    info(message: string): void {
      term.status(message);
    },
    warn(message: string): void {
      term.problem(`${term.yellow('warning')} ${message}`);
    },
    error(message: string): void {
      term.problem(`${term.red('error')} ${message}`);
    },
  };
  return caps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

/** Keys a `--config` file may set. Anything else is reported and ignored. */
const CONFIG_KEYS: readonly string[] = [
  'level',
  'strict',
  'theme',
  'colorScheme',
  'locale',
  'timezone',
  'buildTime',
  'defaults',
  'security',
  'render',
  'a11y',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Load `--config`.
 *
 * `.json` is parsed; `.js`/`.mjs` is imported and its default export taken. There
 * is **no automatic discovery** of a config file: a build whose output depends on
 * a file nobody named is not reproducible, and reproducibility is the point
 * (SPEC 24.3).
 *
 * @throws CliError (exit 2) for a malformed file, (exit 3) when it cannot be read
 */
export async function loadConfigFile(io: CliIo, path: string, term: Term): Promise<MdvConfig> {
  const abs = absolute(io, path);
  const shown = displayPath(io, abs);
  let value: unknown;

  if (abs.endsWith('.js') || abs.endsWith('.mjs') || abs.endsWith('.cjs')) {
    try {
      const module: unknown = await import(pathToFileURL(abs).href);
      value = isRecord(module) ? (module['default'] ?? module) : module;
    } catch (error) {
      throw usageError(`Cannot load config ${shown}: ${errorText(error)}`);
    }
  } else {
    const text = await readTextFile(io, abs);
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw usageError(`Cannot parse config ${shown}: ${errorText(error)}`);
    }
  }

  if (!isRecord(value)) {
    throw usageError(
      `Config ${shown} must be an object, got ${value === null ? 'null' : typeof value}`,
    );
  }

  const out: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const key of Object.keys(value)) {
    if (CONFIG_KEYS.includes(key)) out[key] = value[key];
    else unknown.push(key);
  }
  if (unknown.length > 0) {
    term.problem(
      `${term.yellow('warning')} ${shown}: ignoring unsupported config key${unknown.length === 1 ? '' : 's'} ${unknown.join(', ')}`,
    );
  }
  // `buildTime` is a string in JSON and a Date in MdvConfig.
  const buildTime = out['buildTime'];
  if (typeof buildTime === 'string') {
    const parsed = new Date(buildTime);
    if (Number.isNaN(parsed.getTime())) {
      throw usageError(`Config ${shown}: \`buildTime\` is not a date: ${buildTime}`);
    }
    out['buildTime'] = parsed;
  }
  return out as MdvConfig;
}

/**
 * Resolve `--theme`: a built-in name, or a path to a theme override file
 * (SPEC 11.6).
 */
export async function loadThemeSetting(
  io: CliIo,
  setting: string,
  scheme: ColorScheme,
): Promise<string | Theme> {
  if (!/\.(json|jsonc)$/i.test(setting)) return setting;
  const override = await readThemeOverride(io, setting);
  return resolveTheme(override, scheme);
}

/** Read and shallow-check a theme override file. */
export async function readThemeOverride(io: CliIo, path: string): Promise<ThemeOverride> {
  const text = await readTextFile(io, path);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw usageError(`Cannot parse theme ${displayPath(io, path)}: ${errorText(error)}`);
  }
  if (!isRecord(value)) {
    throw usageError(`Theme ${displayPath(io, path)} must be an object`);
  }
  return value as ThemeOverride;
}

/** The plugin that carries the built-in chart types and themes into core. */
export function builtinsPlugin(): MdvPlugin {
  return {
    name: '@mdv/cli builtins',
    version: CLI_VERSION,
    chartTypes: builtinChartTypes,
    themes: listBuiltinThemes(),
  };
}

/**
 * Build the `MdvConfig` one command run uses.
 *
 * Precedence is SPEC 25's: built-in defaults ← `--config` file ← command-line
 * flags. Front matter is merged by `resolve` itself, and only for the keys a
 * document is permitted to set.
 */
export async function buildConfig(
  io: CliIo,
  flags: GlobalFlags,
  documentPath: string,
  term: Term,
): Promise<MdvConfig> {
  const base: MdvConfig =
    flags.config === undefined ? {} : await loadConfigFile(io, flags.config, term);

  const config: MdvConfig = { ...base };
  config.plugins = [...(base.plugins ?? []), builtinsPlugin()];
  config.capabilities = capabilitiesFor(flags, dirname(absolute(io, documentPath)), term);

  if (flags.level !== undefined) config.level = flags.level;
  if (flags.strict === true) config.strict = true;
  if (flags.locale !== undefined) config.locale = flags.locale;
  if (flags.timezone !== undefined) config.timezone = flags.timezone;
  if (flags.buildTime !== undefined) config.buildTime = new Date(flags.buildTime);
  if (flags.theme !== undefined) {
    const scheme: ColorScheme = base.colorScheme === 'dark' ? 'dark' : 'light';
    config.theme = await loadThemeSetting(io, flags.theme, scheme);
  }

  const security = { ...(base.security ?? {}) };
  if (flags.allowExternal === true) security.allowExternal = true;
  if (flags.allowFile === true) security.allowFileUrls = true;
  config.security = security;

  return config;
}

/** The `print` theme, which SPEC 28.5 applies to an export by default. */
export function printTheme(): Theme {
  return getBuiltinTheme('print');
}

// ─────────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read, parse and resolve one document.
 *
 * `resolve` never rejects for document content — a broken block becomes a
 * diagnostic and an error card — so anything thrown here is either a
 * configuration mistake (exit 2) or a filesystem failure (exit 3).
 */
export async function loadDocument(
  io: CliIo,
  flags: GlobalFlags,
  file: string,
  term: Term,
): Promise<LoadedDocument> {
  const abs = absolute(io, file);
  const source = await readTextFile(io, abs);
  const config = await buildConfig(io, flags, abs, term);
  const doc = parse(source);
  let resolved: ResolvedDocument;
  try {
    resolved = await resolveDocument(doc, config);
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw ioError(`Cannot resolve ${displayPath(io, abs)}: ${errorText(error)}`);
  }
  return { path: abs, display: displayPath(io, abs), source, doc, resolved };
}

/**
 * The security refusals in a resolved document (SPEC 13): external data with no
 * `--allow-external`, an off-allowlist origin, a `file:` URL that was declined.
 *
 * They are diagnostics, not exceptions — the document still renders, with error
 * cards — so the command decides the exit code rather than aborting.
 */
export function securityRefusals(loaded: LoadedDocument): readonly Diagnostic[] {
  return loaded.resolved.diagnostics.filter(
    (d) => d.source === 'security' && d.severity === 'error',
  );
}

/**
 * Exit code for a command that completed: `4` when the document asked for
 * something the security policy refused, otherwise `0` (SPEC 27).
 */
export function outcomeFor(loaded: LoadedDocument, term: Term): number {
  const refused = securityRefusals(loaded);
  if (refused.length === 0) return EXIT_CODES.ok;
  for (const d of refused) {
    term.problem(`${term.red('refused')} ${term.dim(d.code)} ${d.message}`);
  }
  return EXIT_CODES.security;
}

/** Require exactly one input file. */
export function singleInput(files: readonly string[], command: string): string {
  const first = files[0];
  if (first === undefined) {
    throw usageError(`${command}: no input file`, `Usage: mdv ${command} <file.mdv>`);
  }
  if (files.length > 1) {
    throw usageError(
      `${command}: expected one input file, got ${files.length}`,
      'Run the command once per file, or use a shell loop.',
    );
  }
  return first;
}

/**
 * The injected process surface, plus the filesystem helpers every command
 * shares.
 *
 * Two rules hold everywhere below:
 *
 * 1. **Every filesystem failure becomes a `CliError` with exit code 3 and a
 *    sentence a human can act on.** `ENOENT` is "no such file", not
 *    `Error: ENOENT: no such file or directory, open '…'`.
 * 2. **Status goes to stderr, content goes to stdout.** `mdv data x.mdv | …`
 *    must pipe the table and nothing else.
 */

import { constants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import { CliError, errorText, ioError } from './exit.js';

/** Injected process surface, so `run` is a pure-ish function under test. */
export interface CliIo {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  /** Working directory for relative paths and for the document root check. */
  cwd: string;
  /** Environment, read only for `NO_COLOR` and `TZ`. */
  env: Readonly<Record<string, string | undefined>>;
  /** `true` when stdout is a TTY, which selects the ANSI text backend. */
  isTty: boolean;
  /** Aborts `mdv watch`. Absent means "run until the process is killed". */
  signal?: AbortSignal;
}

/** Absolute path for a user-supplied one, resolved against `io.cwd`. */
export function absolute(io: CliIo, path: string): string {
  return isAbsolute(path) ? path : resolvePath(io.cwd, path);
}

/** The shortest way to name a path in a message: relative to the cwd, if inside it. */
export function displayPath(io: CliIo, path: string): string {
  const abs = absolute(io, path);
  const rel = relative(io.cwd, abs);
  if (rel === '') return '.';
  return rel.startsWith(`..${sep}`) || rel === '..' ? abs : rel;
}

/** Map a Node filesystem error onto a legible {@link CliError}. */
function fsError(action: string, path: string, error: unknown): CliError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return ioError(`Cannot ${action} ${path}: no such file or directory`);
    case 'EISDIR':
      return ioError(`Cannot ${action} ${path}: it is a directory, not a file`);
    case 'ENOTDIR':
      return ioError(`Cannot ${action} ${path}: a path segment is not a directory`);
    case 'EACCES':
    case 'EPERM':
      return ioError(`Cannot ${action} ${path}: permission denied`);
    default:
      return ioError(`Cannot ${action} ${path}: ${errorText(error)}`);
  }
}

/** Read a UTF-8 text file. */
export async function readTextFile(io: CliIo, path: string): Promise<string> {
  try {
    const bytes = await readFile(absolute(io, path));
    // A BOM is the parser's business (SPEC 3.2), so it is passed through intact.
    return new TextDecoder('utf-8').decode(bytes);
  } catch (error) {
    throw fsError('read', displayPath(io, path), error);
  }
}

/** Write bytes, creating the parent directory if it does not exist. */
export async function writeBinaryFile(io: CliIo, path: string, data: Uint8Array): Promise<void> {
  const abs = absolute(io, path);
  try {
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, data);
  } catch (error) {
    throw fsError('write', displayPath(io, path), error);
  }
}

/** Write UTF-8 text, creating the parent directory if it does not exist. */
export async function writeTextFile(io: CliIo, path: string, text: string): Promise<void> {
  await writeBinaryFile(io, path, new TextEncoder().encode(text));
}

/** `true` when the path exists at all. */
export async function exists(io: CliIo, path: string): Promise<boolean> {
  try {
    await access(absolute(io, path), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** `true` when the path exists and is a directory. */
export async function isDirectory(io: CliIo, path: string): Promise<boolean> {
  try {
    return (await stat(absolute(io, path))).isDirectory();
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Globs
// ─────────────────────────────────────────────────────────────────────────────

/** Document extensions a bare directory argument expands to. */
export const DOCUMENT_EXTENSIONS: readonly string[] = ['.mdv', '.md'];

const MAGIC = /[*?[]/;

/**
 * One glob segment as an anchored regular expression.
 *
 * `*` and `?` do not cross a separator (there is one segment here by
 * construction) and `[...]` is a literal character class. Everything else is
 * escaped, so a filename with a `.` or a `+` in it matches itself.
 */
function segmentPattern(segment: string): RegExp {
  let out = '';
  for (let i = 0; i < segment.length; ++i) {
    const ch = segment[i] as string;
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else if (ch === '[') {
      const close = segment.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
      } else {
        const body = segment.slice(i + 1, close);
        out += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        i = close;
      }
    } else out += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** Codepoint order — never `localeCompare` (SPEC 24.3, CONTRACTS §1.4). */
export function byCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

async function walk(dir: string, segments: readonly string[], out: string[]): Promise<void> {
  const head = segments[0];
  if (head === undefined) return;
  const rest = segments.slice(1);

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    // A directory that vanished or cannot be read matches nothing. Refusing the
    // whole invocation because one subtree is unreadable would be worse.
    return;
  }
  const names = entries.map((e) => e.name).sort(byCodepoint);
  const byName = new Map(entries.map((e) => [e.name, e]));

  if (head === '**') {
    // Zero directories consumed…
    if (rest.length > 0) await walk(dir, rest, out);
    // …or one, recursively.
    for (const name of names) {
      if (name.startsWith('.')) continue;
      if (byName.get(name)?.isDirectory() === true) {
        await walk(resolvePath(dir, name), segments, out);
      } else if (rest.length === 0) {
        out.push(resolvePath(dir, name));
      }
    }
    return;
  }

  const pattern = segmentPattern(head);
  for (const name of names) {
    if (!pattern.test(name)) continue;
    const entry = byName.get(name);
    const full = resolvePath(dir, name);
    if (rest.length === 0) {
      if (entry?.isDirectory() !== true) out.push(full);
    } else if (entry?.isDirectory() === true) {
      await walk(full, rest, out);
    }
  }
}

/**
 * Expand file arguments: literal paths pass through, a directory expands to the
 * documents beneath it, and a pattern containing `*`, `?` or `[` is matched
 * against the filesystem.
 *
 * Deliberately hand-rolled rather than pulled from npm: the CLI adds no
 * dependency, and the result is sorted by codepoint so a lint report over a glob
 * is byte-identical on every machine (SPEC 24.3).
 *
 * @throws CliError (exit 3) when a literal path does not exist — a typo in a
 * filename must not be reported as "0 files, all clean".
 */
export async function expandInputs(io: CliIo, patterns: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();

  for (const pattern of patterns) {
    if (!MAGIC.test(pattern)) {
      const abs = absolute(io, pattern);
      if (await isDirectory(io, abs)) {
        const inside: string[] = [];
        await walk(abs, ['**'], inside);
        for (const file of inside.sort(byCodepoint)) {
          if (DOCUMENT_EXTENSIONS.some((ext) => file.endsWith(ext)) && !seen.has(file)) {
            seen.add(file);
            found.push(file);
          }
        }
        continue;
      }
      if (!(await exists(io, abs))) {
        throw ioError(`Cannot read ${displayPath(io, pattern)}: no such file or directory`);
      }
      if (!seen.has(abs)) {
        seen.add(abs);
        found.push(abs);
      }
      continue;
    }

    const abs = absolute(io, pattern);
    const parts = abs.split(/[\\/]+/);
    // The static prefix is everything up to the first magic segment; walking
    // from there instead of from the root keeps a glob cheap.
    let split = parts.length;
    for (let i = 0; i < parts.length; ++i) {
      const part = parts[i] as string;
      if (part === '**' || MAGIC.test(part)) {
        split = i;
        break;
      }
    }
    const base = parts.slice(0, split).join(sep) || sep;
    const matches: string[] = [];
    await walk(base, parts.slice(split), matches);
    for (const file of matches.sort(byCodepoint)) {
      if (!seen.has(file)) {
        seen.add(file);
        found.push(file);
      }
    }
  }

  return found;
}

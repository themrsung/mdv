/**
 * Discovering and validating the fixture corpus (SPEC 16.2).
 *
 * A case is a directory holding `input.mdv`. Everything beside it is optional
 * and each optional file adds one check — a case that ships only an input still
 * asserts something real (that it parses, round-trips and resolves without an
 * unhandled exception), and a case that ships `expected.svg` additionally pins
 * the pixels.
 *
 * Loading is strict about the corpus and forgiving about the build: a malformed
 * `meta.json` or a `covers` id that `levels.json` does not define is a
 * {@link CorpusIssue}, never a thrown error, so one bad directory reports itself
 * instead of hiding the other four hundred.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isKnownRequirement } from '@mdv/spec';
import type { ConformanceLevel, FixtureCategory } from '@mdv/spec';
import type {
  CaseMeta,
  Corpus,
  CorpusIssue,
  DiagnosticFingerprint,
  FixtureCase,
  Goldens,
} from './types.js';

/** Where the normative corpus lives, relative to the repository root. */
export const DEFAULT_ROOT = 'packages/spec/tests';

/** The SPEC 16.2 directory skeleton. The first path segment must be one of these. */
export const FIXTURE_CATEGORIES: readonly FixtureCategory[] = [
  'syntax',
  'data',
  'encode',
  'render',
  'a11y',
  'security',
  'pdf',
  'perf',
];

/** The document under test. A directory holding this file is a case. */
export const INPUT_FILE = 'input.mdv';

/** Per-case metadata (SPEC 16.2). Optional; a case with none takes defaults. */
export const META_FILE = 'meta.json';

/** The ordered diagnostics a case pins, if it pins any. */
export const DIAGNOSTICS_FILE = 'diagnostics.json';

/** The golden artefacts a case may ship, by the check that compares each. */
export const GOLDEN_FILES = {
  ast: 'expected.ast.json',
  svg: 'expected.svg',
  dark: 'expected.dark.svg',
  pdf: 'expected.pdf.json',
} as const;

const EXPECTED_FILES: ReadonlySet<string> = new Set(Object.values(GOLDEN_FILES));

const META_KEYS: ReadonlySet<string> = new Set(['level', 'tags', 'note', 'covers']);

/** Directories that are never part of the corpus, whatever they contain. */
const IGNORED_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git']);

// ─────────────────────────────────────────────────────────────────────────────
// Text
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Golden text, compared modulo the line ending and the final newline.
 *
 * Those two are the editor's business, not the build's: a golden that fails
 * because someone's editor added a trailing newline teaches nothing.
 */
export function normaliseGolden(text: string): string {
  return text.replace(/\r\n/gu, '\n').replace(/\n+$/u, '');
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT'
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ─────────────────────────────────────────────────────────────────────────────
// meta.json
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validate one `meta.json` body.
 *
 * Returns the metadata and the problems found; a case with problems still loads
 * with a defaulted level so the rest of the run can proceed and report all of
 * its issues at once, rather than one per invocation.
 */
export function readMeta(value: unknown): {
  readonly meta: CaseMeta;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return {
      meta: { level: 1, tags: [], covers: [] },
      errors: [`${META_FILE} must be a JSON object`],
    };
  }

  for (const key of Object.keys(value)) {
    if (!META_KEYS.has(key)) errors.push(`${META_FILE}: unknown key ${JSON.stringify(key)}`);
  }

  let level: ConformanceLevel = 1;
  const rawLevel = value['level'];
  if (rawLevel === 1 || rawLevel === 2 || rawLevel === 3) level = rawLevel;
  else errors.push(`${META_FILE}: "level" must be 1, 2 or 3, got ${JSON.stringify(rawLevel)}`);

  const tags: string[] = [];
  const rawTags = value['tags'];
  if (rawTags === undefined) {
    // A case with nothing to select it by is legal; it just cannot be filtered.
  } else if (!Array.isArray(rawTags)) {
    errors.push(`${META_FILE}: "tags" must be an array of strings`);
  } else {
    for (const tag of rawTags) {
      if (typeof tag === 'string' && tag !== '') tags.push(tag);
      else
        errors.push(`${META_FILE}: "tags" must hold non-empty strings, got ${JSON.stringify(tag)}`);
    }
  }

  const covers: string[] = [];
  const rawCovers = value['covers'];
  if (rawCovers === undefined) {
    // Coverage is derived from the document; declaring is for what leaves no trace.
  } else if (!Array.isArray(rawCovers)) {
    errors.push(`${META_FILE}: "covers" must be an array of requirement ids`);
  } else {
    for (const id of rawCovers) {
      if (typeof id !== 'string') {
        errors.push(`${META_FILE}: "covers" must hold strings, got ${JSON.stringify(id)}`);
      } else if (!isKnownRequirement(id)) {
        errors.push(
          `${META_FILE}: "covers" names ${JSON.stringify(id)}, which levels.json does not define`,
        );
      } else if (covers.includes(id)) {
        errors.push(`${META_FILE}: "covers" repeats ${JSON.stringify(id)}`);
      } else {
        covers.push(id);
      }
    }
  }

  const note = value['note'];
  if (note !== undefined && typeof note !== 'string') {
    errors.push(`${META_FILE}: "note" must be a string`);
  }

  const meta: CaseMeta =
    typeof note === 'string'
      ? { level, tags, note, covers: [...covers].sort() }
      : { level, tags, covers: [...covers].sort() };
  return { meta, errors };
}

// ─────────────────────────────────────────────────────────────────────────────
// diagnostics.json
// ─────────────────────────────────────────────────────────────────────────────

/** Read the ordered diagnostic goldens. An entry may be a bare code string. */
export function readDiagnostics(value: unknown): {
  readonly diagnostics: readonly DiagnosticFingerprint[];
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    return { diagnostics: [], errors: [`${DIAGNOSTICS_FILE} must be a JSON array`] };
  }

  const diagnostics: DiagnosticFingerprint[] = [];
  value.forEach((entry, index) => {
    const at = `${DIAGNOSTICS_FILE}[${String(index)}]`;
    if (typeof entry === 'string') {
      diagnostics.push({ code: entry });
      return;
    }
    if (!isRecord(entry)) {
      errors.push(`${at}: must be a code string or an object`);
      return;
    }
    const code = entry['code'];
    if (typeof code !== 'string') {
      errors.push(`${at}: "code" must be a string`);
      return;
    }
    const fingerprint: { -readonly [K in keyof DiagnosticFingerprint]: DiagnosticFingerprint[K] } =
      {
        code,
      };
    const severity = entry['severity'];
    if (typeof severity === 'string') fingerprint.severity = severity;
    else if (severity !== undefined) errors.push(`${at}: "severity" must be a string`);

    const source = entry['source'];
    if (typeof source === 'string') fingerprint.source = source;
    else if (source !== undefined) errors.push(`${at}: "source" must be a string`);

    const range = readRange(entry['range']);
    if (range === 'bad') errors.push(`${at}: "range" must be [start, end] offsets or a Range`);
    else if (range !== undefined) fingerprint.range = range;

    diagnostics.push(fingerprint);
  });

  return { diagnostics, errors };
}

/** `[a, b]`, or a SPEC 14.4 `Range` reduced to its offsets (SPEC 19). */
function readRange(value: unknown): readonly [number, number] | undefined | 'bad' {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const [start, end] = value as readonly unknown[];
    if (typeof start === 'number' && typeof end === 'number' && value.length === 2) {
      return [start, end];
    }
    return 'bad';
  }
  if (!isRecord(value)) return 'bad';
  const start = value['start'];
  const end = value['end'];
  if (!isRecord(start) || !isRecord(end)) return 'bad';
  const from = start['offset'];
  const to = end['offset'];
  if (typeof from !== 'number' || typeof to !== 'number') return 'bad';
  return [from, to];
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load every case under `root`.
 *
 * Walks in sorted order so the corpus is a list, not a set: two machines
 * discover the same cases in the same order, which is what lets a report be
 * committed.
 */
export async function loadCorpus(root: string): Promise<Corpus> {
  const cases: FixtureCase[] = [];
  const issues: CorpusIssue[] = [];

  let entries: readonly string[];
  try {
    entries = await directories(root);
  } catch (error) {
    return {
      root,
      cases: [],
      issues: [{ path: '', message: `cannot read corpus root: ${errorText(error)}` }],
    };
  }

  for (const name of entries) {
    if (!isCategory(name)) {
      issues.push({
        path: name,
        message: `not a SPEC 16.2 category (expected one of ${FIXTURE_CATEGORIES.join(', ')})`,
      });
      continue;
    }
    await walk(root, name, name, cases, issues);
  }

  cases.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, cases, issues };
}

function isCategory(name: string): name is FixtureCategory {
  return (FIXTURE_CATEGORIES as readonly string[]).includes(name);
}

async function directories(dir: string): Promise<readonly string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.'),
    )
    .map((entry) => entry.name)
    .sort();
}

async function walk(
  root: string,
  rel: string,
  category: FixtureCategory,
  cases: FixtureCase[],
  issues: CorpusIssue[],
): Promise<void> {
  const dir = join(root, ...rel.split('/'));
  let names: readonly string[];
  let files: readonly string[];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    names = entries
      .filter(
        (entry) =>
          entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && !entry.name.startsWith('.'),
      )
      .map((entry) => entry.name)
      .sort();
    files = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    issues.push({ path: rel, message: `cannot read directory: ${errorText(error)}` });
    return;
  }

  if (files.includes(INPUT_FILE)) {
    const loaded = await loadCase(root, rel, category, files);
    cases.push(loaded.fixture);
    for (const message of loaded.errors) issues.push({ path: rel, message });
    if (names.length > 0) {
      issues.push({
        path: rel,
        message: `a case directory must not contain sub-directories (${names.join(', ')})`,
      });
    }
    return;
  }

  // Not a case. Files that look like a case's are a misplaced or half-deleted one.
  for (const file of files) {
    if (file === META_FILE || file === DIAGNOSTICS_FILE || file.startsWith('expected.')) {
      issues.push({ path: `${rel}/${file}`, message: `${file} beside no ${INPUT_FILE}` });
    }
  }

  for (const name of names) await walk(root, `${rel}/${name}`, category, cases, issues);
}

async function loadCase(
  root: string,
  rel: string,
  category: FixtureCategory,
  files: readonly string[],
): Promise<{ readonly fixture: FixtureCase; readonly errors: readonly string[] }> {
  const dir = join(root, ...rel.split('/'));
  const errors: string[] = [];

  const source = (await readIfPresent(join(dir, INPUT_FILE))) ?? '';

  let meta: CaseMeta = { level: 1, tags: [], covers: [] };
  const rawMeta = await readIfPresent(join(dir, META_FILE));
  if (rawMeta === undefined) {
    errors.push(`${META_FILE} is required`);
  } else {
    const parsed = parseJson(rawMeta);
    if (parsed.error !== undefined) errors.push(`${META_FILE}: ${parsed.error}`);
    else {
      const read = readMeta(parsed.value);
      meta = read.meta;
      errors.push(...read.errors);
    }
  }

  const goldens: { -readonly [K in keyof Goldens]: Goldens[K] } = {};
  for (const [key, file] of Object.entries(GOLDEN_FILES) as readonly [
    keyof typeof GOLDEN_FILES,
    string,
  ][]) {
    const text = await readIfPresent(join(dir, file));
    if (text !== undefined) goldens[key] = normaliseGolden(text);
  }

  const rawDiagnostics = await readIfPresent(join(dir, DIAGNOSTICS_FILE));
  if (rawDiagnostics !== undefined) {
    const parsed = parseJson(rawDiagnostics);
    if (parsed.error !== undefined) errors.push(`${DIAGNOSTICS_FILE}: ${parsed.error}`);
    else {
      const read = readDiagnostics(parsed.value);
      goldens.diagnostics = read.diagnostics;
      errors.push(...read.errors);
    }
  }

  for (const file of files) {
    if (file.startsWith('expected.') && !EXPECTED_FILES.has(file)) {
      errors.push(
        `unrecognised golden ${JSON.stringify(file)} (expected one of ${[...EXPECTED_FILES].join(', ')})`,
      );
    }
  }

  return { fixture: { id: rel, category, dir, meta, source, goldens }, errors };
}

function parseJson(text: string): { readonly value?: unknown; readonly error?: string } {
  try {
    return { value: JSON.parse(text) as unknown };
  } catch (error) {
    return { error: errorText(error) };
  }
}

/** The case id for a directory below `root`, in the slash form ids always take. */
export function caseIdOf(root: string, dir: string): string {
  const rel = dir.startsWith(root) ? dir.slice(root.length) : dir;
  return rel
    .split(sep)
    .filter((part) => part !== '')
    .join('/');
}

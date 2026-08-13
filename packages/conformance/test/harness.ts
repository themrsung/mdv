/**
 * Test harness: a corpus on disk, and a captured {@link ConformanceIo}.
 *
 * The loader's whole subject is a directory tree, so the tests build real ones
 * — inside `mkdtemp`, never in the repository, and every test cleans up after
 * itself. Nothing here spawns a process: `main(argv, io)` is called in-process,
 * which is exactly why it returns a code instead of calling `process.exit`.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { parse, resolve } from '@mdv/core';
import { canonicalAst } from '@mdv/parser';
import type { ConformanceLevel } from '@mdv/spec';

import type { ConformanceIo } from '../src/cli.js';
import { normaliseGolden } from '../src/corpus.js';
import { conformanceConfig } from '../src/run.js';
import type { CaseMeta, CaseResult, FixtureCase, Goldens } from '../src/types.js';

/** A captured invocation. */
export interface Capture extends ConformanceIo {
  /** Everything written to stdout. */
  out: string;
  /** Everything written to stderr. */
  err: string;
}

/** A captured io rooted at `cwd`. */
export function captureIo(cwd: string): Capture {
  const capture: Capture = {
    out: '',
    err: '',
    stdout: {
      write(chunk: string): void {
        capture.out += chunk;
      },
    },
    stderr: {
      write(chunk: string): void {
        capture.err += chunk;
      },
    },
    cwd,
  };
  return capture;
}

/** What a case ships, beyond the defaults. */
export interface CaseSpec {
  /** `meta.json`, serialised verbatim — `{ level: 1 }` when absent. */
  readonly meta?: unknown;
  /** `input.mdv` — {@link BAR_CASE} when absent. */
  readonly source?: string;
  /** Anything else in the case directory, by file name. */
  readonly files?: Readonly<Record<string, string>>;
}

/** A temporary corpus root, plus an io rooted at it. */
export interface TempCorpus {
  /** The absolute corpus root, for `loadCorpus` and `--root`. */
  readonly root: string;
  readonly io: Capture;
  /** Write one case at `id`, e.g. `render/bar/simple`. */
  addCase(id: string, spec?: CaseSpec): Promise<void>;
  /** Write any file below the root; returns its absolute path. */
  write(name: string, contents: string): Promise<string>;
  /** Remove the corpus. */
  cleanup(): Promise<void>;
}

/** Create an empty corpus root. */
export async function tempCorpus(): Promise<TempCorpus> {
  const root = await mkdtemp(join(tmpdir(), 'mdv-conformance-'));
  const io = captureIo(root);

  async function write(name: string, contents: string): Promise<string> {
    const path = join(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
    return path;
  }

  return {
    root,
    io,
    write,
    async addCase(id: string, spec: CaseSpec = {}): Promise<void> {
      await write(`${id}/meta.json`, `${JSON.stringify(spec.meta ?? { level: 1 }, null, 2)}\n`);
      await write(`${id}/input.mdv`, spec.source ?? BAR_CASE);
      for (const [name, contents] of Object.entries(spec.files ?? {})) {
        await write(`${id}/${name}`, contents);
      }
    },
    async cleanup(): Promise<void> {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** One chart and one heading: the smallest case that reaches every check. */
export const BAR_CASE = `---
mdv: "1.0"
title: Revenue by region
---

# Revenue by region

\`\`\`mdv bar
title: Revenue by region
x: region
y: revenue
---
region,revenue
North,120
South,90
East,75
\`\`\`
`;

/** Nothing to draw: the `render` check has to skip rather than pass. */
export const PROSE_CASE = `# Prose only

A case with no visual block still parses, round-trips and resolves.
`;

/**
 * A *declared* dataset with no data. Resolves to exactly one diagnostic, which
 * makes it the stable target for a `diagnostics.json` golden — a case that pins
 * its *diagnostics* pins nothing about the renderer, so the test does not have
 * to reproduce an SVG to exercise a passing golden comparison.
 *
 * A visual block with no data section would not do: it raises nothing at the
 * data stage (the dataset it gets is implicit, SPEC 6.3) and two `MDV3000`s at
 * the encode stage instead, which is three fingerprints and a chart contract.
 */
export const NO_DATA_CASE = `\`\`\`mdv dataset
id: sales
\`\`\`
`;

/** The code {@link NO_DATA_CASE} is guaranteed to raise. */
export const NO_DATA_CODE = 'MDV2100';

/**
 * The one diagnostic {@link BAR_CASE} raises: its data section does not pin a
 * `format`, so auto-detection reports what it decided (info) rather than
 * guessing silently. The canonical case is deliberately not diagnostic-free.
 */
export const BAR_DIAGNOSTIC = 'MDV2101';

/**
 * What a test wants to be different about a fixture.
 *
 * `meta` is merged rather than replaced: a test that is about the level should
 * not have to restate `tags`, `covers` and `pin` to stay well-typed, and every
 * field the loader fills in is one a hand-written fixture would otherwise be
 * free to forget.
 */
export interface FixtureOverrides extends Partial<Omit<FixtureCase, 'meta'>> {
  readonly meta?: Partial<CaseMeta>;
}

/** A fixture built in memory, for tests about running rather than loading. */
export function fixtureCase(overrides: FixtureOverrides = {}): FixtureCase {
  const { meta, ...rest } = overrides;
  return {
    id: 'render/bar/simple',
    category: 'render',
    dir: join(tmpdir(), 'mdv-not-read', 'render', 'bar', 'simple'),
    source: BAR_CASE,
    goldens: {},
    ...rest,
    meta: { level: 1, tags: [], covers: [], pin: [], ...meta },
  };
}

/**
 * A result built in memory, for tests about reporting rather than running.
 *
 * The report is a pure function of these, so the tests that read it never have
 * to run a case to produce one — and can describe results a real corpus would
 * take a broken build to produce.
 */
export function caseResult(overrides: Partial<CaseResult> = {}): CaseResult {
  const { fixture, ...rest } = overrides;
  return {
    fixture: fixture ?? fixtureCase(),
    checks: [{ check: 'parse', status: 'pass' }],
    covered: [],
    status: 'pass',
    ...rest,
  };
}

/** As {@link fixtureCase}, with the goldens replaced rather than merged. */
export function withGoldens(goldens: Goldens, overrides: FixtureOverrides = {}): FixtureCase {
  return fixtureCase({ ...overrides, goldens });
}

/**
 * The `expected.ast.json` a correct build would write for `source`.
 *
 * Deriving the golden rather than checking one in is deliberate: these tests are
 * about whether the runner *compares* correctly, and a checked-in AST would make
 * them fail whenever the AST changes for reasons they do not care about. The
 * cases that pin real output live in the corpus.
 */
export async function astGolden(source: string, level: ConformanceLevel = 1): Promise<string> {
  const resolved = await resolve(parse(source), conformanceConfig(level));
  return normaliseGolden(canonicalAst(resolved.ast));
}

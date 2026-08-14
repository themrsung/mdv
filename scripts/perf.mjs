/**
 * `pnpm perf` — measure this build against the eleven SPEC 24.1 budgets and
 * write `PERF.md`.
 *
 * The nine document rows are measured by `@mdv/conformance`'s perf harness,
 * from the `perf/` fixtures the spec says the budgets are enforced by. The two
 * bundle rows cannot be: a bundle size is a property of the built artifacts and
 * of a bundler's opinion about them, not of any document. They are measured
 * here, and the opinions are stated rather than assumed:
 *
 * - **esbuild, `--minify --format=esm --platform=browser`**, which is the
 *   bundler this repository already depends on.
 * - **`react` and `react-dom` are external.** They are peer dependencies: the
 *   host application ships React whether or not it ships MDV, so counting it
 *   against MDV's budget would measure React.
 * - **gzip level 9**, the level size budgets are conventionally quoted at.
 *
 * The second row, "every Level 2 chart type", is measured as the whole Level 2
 * reader — core, the React binding and every Level 1 *and* Level 2 type — and
 * not as the Level 2 types in isolation. A budget of 140 KB against a bundle
 * that could not draw a document would be a number about nothing; the row it
 * sits under measures a bundle that can draw everything at Level 1, and this is
 * that bundle plus the rest of the types.
 *
 * Usage: node scripts/perf.mjs [--write] [--out <file>] [--runs <n>] [--json]
 *
 * Exit codes match `mdv-conformance`: 0 every budget holds, 1 one fails, 2 the
 * invocation was wrong, 3 the report could not be written.
 */
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gzipSync } from 'node:zlib';

import * as esbuild from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(repoRoot, 'packages/conformance/dist');

const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, io: 3 });

const USAGE = `mdv perf — measure this build against the SPEC 24.1 budgets

Usage: node scripts/perf.mjs [options]

Options:
      --write        Write PERF.md at the repository root
  -o, --out <file>   Write the report here instead
      --runs <n>     Timed runs per document row (default: SPEC 24.1's 20)
      --no-bundles   Skip the two bundle rows (no bundler run)
      --json         Emit the measurements as JSON instead of Markdown
  -h, --help         Show this message

Exit codes: 0 every budget holds, 1 a budget fails, 2 usage, 3 I/O.
`;

/** The two bundle rows of SPEC 24.1, and what has to be in a bundle to be one. */
const BUNDLES = [
  {
    id: 'bundle/level-1',
    spec: 'Bundle: `@mdv/core` + `@mdv/react` + `bar,line,area`',
    budget: 65,
    entry: [
      "export * from '@mdv/react';",
      "export { areaChart, barChart, lineChart } from '@mdv/charts';",
    ].join('\n'),
    note:
      'esbuild `--minify --format=esm --platform=browser`, gzip level 9, with ' +
      '`react` and `react-dom` external — the host ships React with or without MDV.',
  },
  {
    id: 'bundle/level-2',
    spec: 'Bundle: every Level 2 chart type',
    budget: 140,
    entry: [
      "export * from '@mdv/react';",
      "export { level1ChartTypes, level2ChartTypes } from '@mdv/charts';",
    ].join('\n'),
    note:
      'Measured as the whole Level 2 reader — core, the React binding and every ' +
      'Level 1 and Level 2 type — since a bundle holding the Level 2 types alone ' +
      'could not draw a document.',
  },
];

/**
 * Give the throwaway entry point a `node_modules` to resolve through.
 *
 * The entry is written outside the repository, so a bare `@mdv/react` in it
 * resolves through nothing at all. A `node_modules/@mdv/` of symlinks is the
 * shape a consumer's install has, and resolving through it means each package
 * is entered through its own `exports` — the published entry point, not a path
 * this script chose. Returns the packages that have not been built, because an
 * unresolved import and a stale one fail very differently.
 *
 * The empty `tsconfig.json` written beside the entry is the other half, and it
 * is not optional. esbuild reads the nearest `tsconfig.json` **above each input
 * file**, including `.js` inputs, and honours its `paths`; every `dist/*.js`
 * here sits under a per-package `tsconfig.json` that inherits the repository's
 * `@mdv/...` source aliases. Left alone, the bundler walks straight
 * back into the workspace source and the symlinks above measure nothing: the
 * numbers would be a build of `src` that no consumer can obtain, and a package
 * whose `exports` omits half of what its siblings import would still measure
 * clean. Handing esbuild one empty config for the whole build turns those
 * aliases off, so an import that only resolves inside this repository fails
 * here — which is how {@link BUNDLES} found that `@mdv/react` reaches for
 * `@mdv/core/layout/index.js` and for a `@mdv/parser` it never declared.
 */
async function linkWorkspace(workdir) {
  const scope = join(workdir, 'node_modules', '@mdv');
  await mkdir(scope, { recursive: true });
  await writeFile(join(workdir, 'tsconfig.json'), `${JSON.stringify({ compilerOptions: {} })}\n`);

  const unbuilt = [];
  for (const entry of await readdir(join(repoRoot, 'packages'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(repoRoot, 'packages', entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    } catch {
      continue;
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith('@mdv/')) continue;
    await symlink(dir, join(scope, manifest.name.slice('@mdv/'.length)), 'dir');
    const main = resolve(dir, typeof manifest.main === 'string' ? manifest.main : 'dist/index.js');
    if (!existsSync(main)) unbuilt.push(manifest.name);
  }
  return unbuilt;
}

/** Bundle one entry through esbuild and return its gzipped size in KB. */
async function measureBundle(row, workdir) {
  const entryPath = join(workdir, `${row.id.replace(/\W+/g, '-')}.js`);
  await writeFile(entryPath, `${row.entry}\n`, 'utf8');

  const built = await esbuild.build({
    entryPoints: [entryPath],
    absWorkingDir: repoRoot,
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    legalComments: 'none',
    tsconfig: join(workdir, 'tsconfig.json'),
    write: false,
    logLevel: 'silent',
  });

  const output = built.outputFiles[0];
  if (output === undefined) throw new Error(`${row.id}: esbuild produced no output`);
  const gzipped = gzipSync(output.contents, { level: 9 });
  const kb = gzipped.byteLength / 1024;
  const raw = output.contents.byteLength / 1024;

  return {
    id: row.id,
    spec: row.spec,
    budget: row.budget,
    measured: kb,
    unit: 'KB',
    shape: `${raw.toFixed(1)} KB minified`,
    runs: 1,
    verdict: kb <= row.budget ? 'pass' : kb <= row.budget * 1.1 ? 'over' : 'fail',
    note: row.note,
  };
}

/** The machine, so a verdict can be read next to the machine that produced it. */
function hostOf() {
  const cpus = os.cpus();
  return {
    cpu: cpus[0]?.model?.trim() ?? 'unknown',
    cores: cpus.length,
    memoryGb: os.totalmem() / 1024 ** 3,
    platform: `${os.type()} ${os.release()}`,
    arch: process.arch,
    runtime: `Node ${process.versions.node} (V8 ${process.versions.v8})`,
  };
}

let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      write: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      runs: { type: 'string' },
      'no-bundles': { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(EXIT.usage);
}

if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(EXIT.ok);
}

const runs = values.runs === undefined ? undefined : Number(values.runs);
if (runs !== undefined && (!Number.isInteger(runs) || runs < 1)) {
  process.stderr.write(`--runs must be a positive integer, got ${JSON.stringify(values.runs)}\n`);
  process.exit(EXIT.usage);
}

let perf;
let corpusApi;
try {
  perf = await import(join(distEntry, 'perf.js'));
  corpusApi = await import(join(distEntry, 'corpus.js'));
} catch (error) {
  process.stderr.write(
    `cannot load the perf harness — build the workspace first (pnpm build):\n${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(EXIT.io);
}

const corpus = await corpusApi.loadCorpus(resolve(repoRoot, corpusApi.DEFAULT_ROOT));
const { cases, issues } = await perf.perfCasesOf(corpus);

for (const issue of issues) process.stderr.write(`corpus: ${issue}\n`);
if (cases.length === 0) {
  process.stderr.write('no perf cases found: nothing to measure\n');
  process.exit(EXIT.failed);
}

const rows = [];
for (const input of cases) {
  process.stderr.write(`measuring ${input.id}…\n`);
  rows.push(await perf.measureCase(input, runs === undefined ? {} : { runs }));
}

if (values['no-bundles'] !== true) {
  const workdir = await mkdtemp(join(os.tmpdir(), 'mdv-perf-'));
  try {
    const unbuilt = await linkWorkspace(workdir);
    if (unbuilt.length > 0) {
      process.stderr.write(
        `cannot measure the bundle rows: ${unbuilt.join(', ')} ${unbuilt.length === 1 ? 'has' : 'have'} no build. ` +
          'Run `pnpm build`, or pass --no-bundles.\n',
      );
      process.exit(EXIT.io);
    }
    for (const row of BUNDLES) {
      process.stderr.write(`bundling ${row.id}…\n`);
      rows.push(await measureBundle(row, workdir));
    }
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

const host = hostOf();
const text =
  values.json === true
    ? `${JSON.stringify({ host, rows }, undefined, 2)}\n`
    : perf.renderPerfReport(rows, host);

const out = values.write === true ? resolve(repoRoot, 'PERF.md') : values.out;
if (out === undefined) {
  process.stdout.write(text);
} else {
  const path = resolve(repoRoot, out);
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  } catch (error) {
    process.stderr.write(
      `cannot write ${out}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(EXIT.io);
  }
  process.stderr.write(`wrote ${out}\n`);
}

const failed = rows.filter((row) => row.verdict === 'fail');
for (const row of failed) {
  process.stderr.write(
    `FAIL ${row.id}: ${row.measured.toFixed(2)} ${row.unit} against a budget of ${String(row.budget)} ${row.unit}\n`,
  );
}
process.exit(failed.length > 0 || issues.length > 0 ? EXIT.failed : EXIT.ok);

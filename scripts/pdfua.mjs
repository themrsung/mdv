/**
 * `pnpm pdfua` — export the fixture corpus under `profile: "pdf-ua-1"` and
 * validate every file against PDF/UA-1 (ISO 14289-1) with veraPDF (SPEC 28.8,
 * F.2 M6).
 *
 * The harness lives in `@mdv/conformance` (`pdfua.ts`); this file is the process
 * around it — arguments, the temporary directory, the report, the exit code.
 *
 * veraPDF is not a dependency of this repository and cannot be: it is a JVM
 * program, and the corpus is deliberately hermetic. A run without it is a usage
 * failure rather than a skip, because a check that quietly passes when its
 * instrument is missing is worse than no check at all. Install it with
 * `brew install verapdf`, from https://verapdf.org/software/, or point
 * `MDV_VERAPDF` at the binary.
 *
 * Usage: node scripts/pdfua.mjs [--write] [--out <file>] [--keep <dir>] [--json]
 *
 * Exit codes match `mdv-conformance`: 0 every file is compliant, 1 one is not,
 * 2 the invocation was wrong (including a missing validator), 3 I/O.
 */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = join(repoRoot, 'packages/conformance/dist');

const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, io: 3 });

const USAGE = `mdv pdfua — validate the corpus against PDF/UA-1 with veraPDF

Usage: node scripts/pdfua.mjs [options]

Options:
      --write          Write PDFUA.md at the repository root
  -o, --out <file>     Write the report here instead
      --keep <dir>     Keep the exported PDFs here (default: a temp dir)
      --filter <text>  Only cases whose id contains this text
      --embed-source   Attach the .mdv source to each PDF (SPEC 28.9)
      --no-validate    Export only; do not run veraPDF
      --log <file>     Write veraPDF's own output here
      --json           Emit the results as JSON instead of Markdown
  -h, --help           Show this message

veraPDF is found on PATH, or at $MDV_VERAPDF. Install: brew install verapdf.

Exit codes: 0 all compliant, 1 a file failed, 2 usage, 3 I/O.
`;

let values;
try {
  ({ values } = parseArgs({
    options: {
      write: { type: 'boolean' },
      out: { type: 'string', short: 'o' },
      keep: { type: 'string' },
      filter: { type: 'string' },
      'embed-source': { type: 'boolean' },
      validate: { type: 'boolean', default: true },
      log: { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    // `--no-validate` is the documented spelling; without this it is unknown.
    allowNegative: true,
  }));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`);
  process.exit(EXIT.usage);
}

if (values.help === true) {
  process.stdout.write(USAGE);
  process.exit(EXIT.ok);
}

let pdfua;
let corpusApi;
try {
  pdfua = await import(join(distEntry, 'pdfua.js'));
  corpusApi = await import(join(distEntry, 'corpus.js'));
} catch (error) {
  process.stderr.write(
    `cannot load the PDF/UA harness — build the workspace first (pnpm build):\n${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
  process.exit(EXIT.io);
}

// The validator is looked for before anything is exported: fifty files written
// only to discover there is nothing to judge them with is a waste of everyone's
// time, and the fix is the same either way.
let validator;
if (values.validate !== false) {
  validator = await pdfua.findVeraPdf(process.env);
  if (validator === undefined) {
    process.stderr.write(
      'veraPDF not found. Install it (brew install verapdf, or ' +
        'https://verapdf.org/software/), or set MDV_VERAPDF to the binary. ' +
        'Pass --no-validate to export without validating.\n',
    );
    process.exit(EXIT.usage);
  }
}

const loaded = await corpusApi.loadCorpus(resolve(repoRoot, corpusApi.DEFAULT_ROOT));
for (const issue of loaded.issues) {
  process.stderr.write(`corpus: ${issue.path}: ${issue.message}\n`);
}
const cases =
  values.filter === undefined
    ? loaded.cases
    : loaded.cases.filter((c) => c.id.includes(values.filter));
if (cases.length === 0) {
  process.stderr.write('no cases to export\n');
  process.exit(EXIT.failed);
}
const corpus = { ...loaded, cases };

const keep = values.keep !== undefined;
const outDir = keep
  ? resolve(repoRoot, values.keep)
  : await mkdtemp(join(os.tmpdir(), 'mdv-pdfua-'));

let report;
try {
  process.stderr.write(`exporting ${cases.length} case(s) under profile pdf-ua-1…\n`);
  const exports_ = await pdfua.exportCorpus(corpus, outDir, {
    embedSource: values['embed-source'] === true,
  });

  let run;
  if (validator !== undefined) {
    const files = exports_.filter((e) => e.file !== undefined).map((e) => e.file);
    if (files.length === 0) {
      process.stderr.write('every export was refused: nothing to validate\n');
    } else {
      process.stderr.write(`validating ${files.length} file(s) with ${validator}…\n`);
      run = await pdfua.runVeraPdf(validator, files);
      if (values.log !== undefined) {
        const path = resolve(repoRoot, values.log);
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, run.output, 'utf8');
        process.stderr.write(`wrote ${values.log}\n`);
      }
    }
  }

  report = { exports: exports_, generated: new Date().toISOString(), ...(run ? { run } : {}) };
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  if (error !== null && typeof error === 'object' && typeof error.output === 'string') {
    process.stderr.write(`${error.output}\n`);
  }
  process.exit(EXIT.io);
} finally {
  if (!keep) await rm(outDir, { recursive: true, force: true });
}

const text =
  values.json === true
    ? `${JSON.stringify(report, undefined, 2)}\n`
    : pdfua.renderPdfUaReport(report);

const out = values.write === true ? resolve(repoRoot, 'PDFUA.md') : values.out;
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

const tally = pdfua.tallyPdfUa(report);
for (const e of report.exports) {
  if (e.refused !== undefined) process.stderr.write(`REFUSED ${e.id}: ${e.refused}\n`);
}
if (report.run !== undefined) {
  const byFile = new Map(report.run.verdicts.map((v) => [v.file, v.compliant]));
  for (const e of report.exports) {
    if (e.file !== undefined && byFile.get(resolve(e.file)) !== true) {
      process.stderr.write(`FAIL ${e.id}\n`);
    }
  }
}
process.stderr.write(`${tally.passed} passed, ${tally.failed} failed, ${tally.refused} refused\n`);
process.exit(tally.failed > 0 || loaded.issues.length > 0 ? EXIT.failed : EXIT.ok);

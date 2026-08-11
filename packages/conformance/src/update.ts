/**
 * Minting goldens (SPEC 16.2).
 *
 * The read path asks "does this build still agree with what was pinned?"; this
 * is the one place allowed to answer "no, and that was the intention". It runs
 * the same stages {@link runCorpus} runs, through the same functions, and
 * writes what comes out.
 *
 * Three rules keep `--update` from being a way to make failures disappear.
 *
 * 1. **It mints only what the case asked for.** A golden already beside the
 *    case is a standing request to keep it current; a name in `meta.pin` is a
 *    request to create it. Nothing else is written, so running `--update` over
 *    a corpus never widens what the corpus asserts — the decision to pin an
 *    output stays a human edit to `meta.json`.
 * 2. **A stage that throws writes nothing.** An exception is the corpus's own
 *    headline claim failing (SPEC 16.2); overwriting a golden with the state
 *    that produced it would erase the evidence. The case is reported as a
 *    failure and its files are left alone.
 * 3. **It reports what it changed, per file.** "Updated 41 goldens" is not
 *    reviewable. The caller gets the paths, split into written and unchanged,
 *    so a diff can be read before it is committed.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { parse, resolve } from '@mdv/core';
import type { ResolvedDocument } from '@mdv/core';
import { canonicalAst } from '@mdv/parser';
import type { MdvDocument } from '@mdv/parser';
import type { GoldenName } from '@mdv/spec';

import { GOLDEN_FILE_OF, loadCorpus, normaliseGolden, readIfPresent } from './corpus.js';
import {
  conformanceConfig,
  filterReason,
  fingerprintOf,
  NO_BLOCKS,
  svgFor,
  traceOf,
} from './run.js';
import type { RunOptions } from './run.js';
import type { Corpus, CorpusIssue, FixtureCase } from './types.js';

/** What one file's turn came to. */
export interface GoldenWrite {
  /** Path relative to the corpus root, in the slash form ids take. */
  readonly path: string;
  /** Which golden this file holds. */
  readonly name: GoldenName;
  /** The case that owns it, as {@link FixtureCase.id}. */
  readonly case: string;
  /** `created` and `updated` touched the disk; `unchanged` did not. */
  readonly status: 'created' | 'updated' | 'unchanged';
}

/** A case whose artefacts could not be produced, so nothing was written. */
export interface UpdateFailure {
  readonly case: string;
  /** The stage that gave out, named as the check that would have reported it. */
  readonly stage: 'parse' | 'resolve' | 'render' | 'dark' | 'pdf';
  readonly reason: string;
}

/** What a whole update did. */
export interface UpdateReport {
  readonly root: string;
  /** Sorted by {@link GoldenWrite.path}. */
  readonly writes: readonly GoldenWrite[];
  /** Cases that could not be minted. Empty on a clean update. */
  readonly failures: readonly UpdateFailure[];
  /** Corpus problems, exactly as a run reports them. */
  readonly issues: readonly CorpusIssue[];
  /** True when nothing failed and the corpus is sound. */
  readonly ok: boolean;
}

/** How much of the corpus to mint. */
export interface UpdateOptions extends RunOptions {
  /** Print `expected.pdf.json` too. Off for a fast inner loop, as in a run. */
  readonly pdf?: boolean | undefined;
  /** Work out the writes and report them, but do not touch the disk. */
  readonly dryRun?: boolean | undefined;
}

/**
 * Mint every golden the corpus under `root` asks for.
 *
 * Cases are visited in corpus order, one at a time, for the reason a run is
 * sequential: the work is CPU-bound, and an interleaved write order would make
 * the report's line order depend on the scheduler.
 */
export async function updateCorpus(
  root: string,
  options: UpdateOptions = {},
): Promise<UpdateReport> {
  const corpus = await loadCorpus(root);
  return updateCases(corpus, options);
}

/** {@link updateCorpus} against a corpus already in hand. */
export async function updateCases(
  corpus: Corpus,
  options: UpdateOptions = {},
): Promise<UpdateReport> {
  const writes: GoldenWrite[] = [];
  const failures: UpdateFailure[] = [];
  for (const fixture of corpus.cases) {
    if (filterReason(fixture, options) !== undefined) continue;
    const minted = await mint(fixture, options);
    if (minted.failure !== undefined) {
      failures.push(minted.failure);
      continue;
    }
    for (const [name, text] of minted.artefacts) {
      writes.push(await commit(corpus.root, fixture, name, text, options.dryRun === true));
    }
  }
  writes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root: corpus.root,
    writes,
    failures,
    issues: corpus.issues,
    ok: failures.length === 0 && corpus.issues.length === 0,
  };
}

/** The text of every golden this case asked for, or the stage that stopped it. */
async function mint(
  fixture: FixtureCase,
  options: UpdateOptions,
): Promise<{ artefacts: ReadonlyMap<GoldenName, string>; failure?: UpdateFailure }> {
  const artefacts = new Map<GoldenName, string>();
  const none = (stage: UpdateFailure['stage'], reason: string) => ({
    artefacts: new Map<GoldenName, string>(),
    failure: { case: fixture.id, stage, reason },
  });
  const wants = requested(fixture);
  if (wants.size === 0) return { artefacts };

  let parsed: MdvDocument;
  try {
    parsed = parse(fixture.source);
  } catch (error) {
    return none('parse', errorText(error));
  }
  let resolved: ResolvedDocument;
  try {
    resolved = await resolve(parsed, conformanceConfig(fixture.meta.level));
  } catch (error) {
    return none('resolve', errorText(error));
  }

  if (wants.has('ast')) artefacts.set('ast', canonicalAst(resolved.ast));
  if (wants.has('diagnostics')) {
    // Two-space JSON, because the file is read by whoever is deciding whether
    // a new diagnostic was meant to appear.
    artefacts.set('diagnostics', JSON.stringify(resolved.diagnostics.map(fingerprintOf), null, 2));
  }
  const drawn = resolved.blocks.length > 0;
  if (wants.has('svg')) {
    if (!drawn) return none('render', NO_BLOCKS);
    artefacts.set('svg', svgFor(resolved));
  }
  if (wants.has('dark')) {
    if (!drawn) return none('dark', NO_BLOCKS);
    try {
      // Resolved again from the same parse, exactly as the `dark` check does:
      // the theme is chosen during resolution, not at render time.
      const dark = await resolve(parsed, conformanceConfig(fixture.meta.level, 'dark'));
      artefacts.set('dark', svgFor(dark));
    } catch (error) {
      return none('dark', errorText(error));
    }
  }
  if (wants.has('pdf') && options.pdf !== false) {
    try {
      artefacts.set('pdf', canonicalAst(await traceOf(resolved, fixture.source)));
    } catch (error) {
      return none('pdf', errorText(error));
    }
  }
  return { artefacts };
}

/**
 * The goldens this case asked for: the files it already ships, plus the names
 * it pinned in `meta.json` and has yet to produce.
 */
function requested(fixture: FixtureCase): ReadonlySet<GoldenName> {
  const names = new Set<GoldenName>(fixture.meta.pin);
  for (const key of Object.keys(fixture.goldens) as readonly GoldenName[]) {
    if (fixture.goldens[key] !== undefined) names.add(key);
  }
  return names;
}

/**
 * Write one golden, unless it would say exactly what the file already says.
 *
 * Comparison is on the normalised text the runner reads, not the bytes: a file
 * whose only difference is the newline the editor added is not a change, and
 * rewriting it would put noise in the diff the author has to review.
 */
async function commit(
  root: string,
  fixture: FixtureCase,
  name: GoldenName,
  text: string,
  dryRun: boolean,
): Promise<GoldenWrite> {
  const file = GOLDEN_FILE_OF[name];
  const path = `${fixture.id}/${file}`;
  const absolute = join(fixture.dir, file);
  const existing = await readIfPresent(absolute);
  const status =
    existing === undefined
      ? 'created'
      : normaliseGolden(text) === normaliseGolden(existing)
        ? 'unchanged'
        : 'updated';
  if (status !== 'unchanged' && !dryRun) {
    await mkdir(dirname(absolute), { recursive: true });
    // The trailing newline is the one thing a golden may carry that the reader
    // normalises away: it is here for every tool that expects text files to end.
    await writeFile(absolute, `${normaliseGolden(text)}\n`, 'utf8');
  }
  return { path, name, case: fixture.id, status };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * What a conformance run is made of (SPEC 16.2, SPEC 16.3).
 *
 * A run turns a directory of fixture cases into a {@link ConformanceReport}: for
 * every case, which checks ran and how they went; across every case, which SPEC
 * 16.1 requirements were exercised by something that passed. Nothing here is a
 * claim — a report is a record of what this build did with this corpus, and the
 * only claim it supports is "the level whose every requirement is covered".
 */
import type {
  ConformanceLevel,
  FixtureCategory,
  FixtureMeta,
  GoldenName,
  LevelRequirement,
} from '@mdv/spec';

// ─────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One thing a case can be held to.
 *
 * The order is the order they run in and the order they are reported in: each
 * later check needs the earlier ones to have worked, so the first failure is
 * always the informative one.
 *
 * `ast` follows `resolve` rather than `parse` because SPEC 16.2 defines
 * `expected.ast.json` as the canonical AST *after resolution* — the golden is
 * the resolved document, so resolving has to have worked before it can be
 * compared.
 */
export type CheckName =
  'parse' | 'round-trip' | 'resolve' | 'ast' | 'diagnostics' | 'render' | 'dark' | 'pdf';

/** {@link CheckName}s in run order. */
export const CHECK_ORDER: readonly CheckName[] = [
  'parse',
  'round-trip',
  'resolve',
  'ast',
  'diagnostics',
  'render',
  'dark',
  'pdf',
];

/**
 * `skip` is not a soft `fail`: a skipped check contributes no coverage, so a
 * level cannot be substantiated by cases that never ran.
 */
export type CheckStatus = 'pass' | 'fail' | 'skip';

/** The outcome of one {@link CheckName} for one case. */
export interface CheckResult {
  readonly check: CheckName;
  readonly status: CheckStatus;
  /** One line, always present for `fail` and `skip`. */
  readonly reason?: string;
  /** The diff, or the thrown stack — many lines, only for `fail`. */
  readonly detail?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The corpus
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A diagnostic reduced to the part a golden file pins down.
 *
 * Messages are prose and localisable (SPEC 14.2), so comparing them would make
 * the corpus a translation test. The code, the severity, the source and the span
 * are the contract.
 *
 * Every field but {@link code} is optional, and an absent field is not compared:
 * a case pins what it is about. `diagnostics.json` may write an entry as a bare
 * string, which pins the code alone.
 */
export interface DiagnosticFingerprint {
  readonly code: string;
  readonly severity?: string;
  readonly source?: string;
  /** `[startOffset, endOffset]` in the input. */
  readonly range?: readonly [number, number];
}

/** The `expected.*` files a case ships. Absent means "this case does not pin that". */
export interface Goldens {
  /** `expected.ast.json` — the canonical AST (SPEC 19). */
  readonly ast?: string;
  /** `expected.svg` — canonical SVG at 800×400, default theme. */
  readonly svg?: string;
  /** `expected.dark.svg` — the same document under the dark theme. */
  readonly dark?: string;
  /** `expected.pdf.json` — the PDF operator trace (SPEC 28.10), not bytes. */
  readonly pdf?: string;
  /** `diagnostics.json` — ordered, compared on {@link DiagnosticFingerprint}. */
  readonly diagnostics?: readonly DiagnosticFingerprint[];
}

/** `meta.json` after validation: `covers` and `pin` are always lists. */
export interface CaseMeta extends FixtureMeta {
  readonly covers: readonly string[];
  readonly pin: readonly GoldenName[];
}

/** One fixture directory, loaded and validated. */
export interface FixtureCase {
  /** Slash-joined path below the corpus root, e.g. `render/bar/stacked-percent`. */
  readonly id: string;
  /** First path segment (SPEC 16.2 directory skeleton). */
  readonly category: FixtureCategory;
  /** Absolute path to the case directory. */
  readonly dir: string;
  readonly meta: CaseMeta;
  /** `input.mdv`, verbatim. */
  readonly source: string;
  readonly goldens: Goldens;
}

/**
 * Something wrong with the corpus itself rather than with the build: an
 * unreadable `meta.json`, a case that covers an id `levels.json` does not
 * define, a directory that ships goldens but no input.
 *
 * These fail a run. A corpus that cannot be trusted cannot substantiate a level.
 */
export interface CorpusIssue {
  /** Path relative to the corpus root, or `''` for the root itself. */
  readonly path: string;
  readonly message: string;
}

/** Everything under one corpus root. */
export interface Corpus {
  /** Absolute path the cases were discovered under. */
  readonly root: string;
  /** Sorted by {@link FixtureCase.id}. */
  readonly cases: readonly FixtureCase[];
  readonly issues: readonly CorpusIssue[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Results
// ─────────────────────────────────────────────────────────────────────────────

/** How one case came out. */
export interface CaseResult {
  readonly fixture: FixtureCase;
  /** In {@link CHECK_ORDER}. Checks the case does not pin are absent, not skipped. */
  readonly checks: readonly CheckResult[];
  /**
   * Requirement ids this case exercised — declared in `meta.covers` plus what
   * the resolved document shows for itself. Empty when the case did not pass.
   */
  readonly covered: readonly string[];
  /** `fail` if any check failed, `skip` if the case did not run, else `pass`. */
  readonly status: CheckStatus;
  /** Why, when the status is `skip`. */
  readonly reason?: string;
}

/** One row of the coverage table: a requirement and the passing cases that reach it. */
export interface CoverageRow {
  readonly requirement: LevelRequirement;
  /** Case ids, sorted. Empty means the requirement is not substantiated. */
  readonly cases: readonly string[];
}

/** Run totals. Cases and checks are counted separately — a case is not a check. */
export interface Totals {
  readonly cases: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly checks: number;
  readonly checksPassed: number;
  readonly checksFailed: number;
  readonly checksSkipped: number;
}

/**
 * What a run produced.
 *
 * Deterministic by construction: no timestamps, no durations, no absolute paths
 * except {@link root}, and every list sorted. Two runs of the same build over
 * the same corpus serialise byte-for-byte, so `CONFORMANCE.md` can be committed
 * and its diff read as a change in behaviour.
 */
export interface ConformanceReport {
  /** From `levels.json`, so a report says which spec revision it is against. */
  readonly specVersion: string;
  /** The level the run was asked to substantiate; cases above it are skipped. */
  readonly level: ConformanceLevel;
  readonly root: string;
  readonly results: readonly CaseResult[];
  readonly issues: readonly CorpusIssue[];
  /** Every requirement up to {@link level}, in `levels.json` order. */
  readonly coverage: readonly CoverageRow[];
  readonly totals: Totals;
  /** The highest level whose every requirement is covered, or `undefined`. */
  readonly substantiated?: ConformanceLevel;
  /** No failed check, no corpus issue. Coverage gaps do not fail a run. */
  readonly ok: boolean;
}

/**
 * `@mdv/conformance` — runs the normative fixture corpus (SPEC 16.2) and says
 * what this build actually substantiates (SPEC 16.1, SPEC 16.3).
 *
 * The package is a library first and a command second: {@link loadCorpus},
 * {@link runCorpus} and {@link buildReport} are separate steps over plain data,
 * so a harness can run the corpus in a test, keep the results, and render the
 * report without going near a process.
 *
 * {@link updateCorpus} is the one entry point that writes: it mints the goldens
 * the corpus asks for, through the same stages a run checks them with.
 */

export {
  DEFAULT_ROOT,
  DIAGNOSTICS_FILE,
  FIXTURE_CATEGORIES,
  GOLDEN_FILES,
  INPUT_FILE,
  META_FILE,
  caseIdOf,
  loadCorpus,
  normaliseGolden,
  readDiagnostics,
  readMeta,
} from './corpus.js';

export { coverageOf } from './coverage.js';
export type { CoverageInput } from './coverage.js';

export { buildReport, renderReport } from './report.js';

export {
  CONFORMANCE_VERSION,
  CORPUS_WIDTH,
  conformanceConfig,
  conformancePlugin,
  runCase,
  runCorpus,
} from './run.js';
export type { RunOptions } from './run.js';

export { updateCases, updateCorpus } from './update.js';
export type { GoldenWrite, UpdateFailure, UpdateOptions, UpdateReport } from './update.js';

export { CHECK_ORDER } from './types.js';
export type {
  CaseResult,
  CheckName,
  CheckResult,
  CheckStatus,
  ConformanceReport,
  Corpus,
  CorpusIssue,
  CoverageRow,
  DiagnosticFingerprint,
  FixtureCase,
  Goldens,
  Totals,
} from './types.js';

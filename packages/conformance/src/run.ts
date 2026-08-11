/**
 * Running the corpus (SPEC 16.2, SPEC 16.3).
 *
 * A run answers one question per case: *which of the eight checks did this
 * build survive, and what does surviving them prove?* Everything here is
 * arranged around three rules that keep the answer worth having.
 *
 * 1. **Every case runs the whole pipeline, golden or no golden.** The corpus
 *    README's claim is "no case produces an unhandled exception", so `parse`,
 *    `resolve`, `render` and `pdf` run for every case; a case without the
 *    matching `expected.*` file still asserts that the stage did not throw, and
 *    says so in its reason. `ast`, `diagnostics` and `dark` are pure golden
 *    comparisons and are simply *absent* when the case does not pin them.
 * 2. **The first failure stops the case.** Later checks need earlier ones to
 *    have worked; reporting eight failures for one broken parse is noise.
 * 3. **The configuration is pinned, not defaulted** (SPEC 24.3 rule 2): epoch
 *    `buildTime`, `en-US`, `UTC`, no network, no filesystem, no clock. Two runs
 *    of the same build over the same corpus produce byte-identical results, on
 *    any machine, in any timezone.
 */

import { builtinChartTypes } from '@mdv/charts';
import { createLayoutContext, layoutBlock, parse, resolve } from '@mdv/core';
import type {
  ColorScheme,
  MdvConfig,
  MdvPlugin,
  ResolvedBlock,
  ResolvedDocument,
  Scene,
} from '@mdv/core';
import { canonicalAst, sameDocument, toMarkdown } from '@mdv/parser';
import type { Diagnostic } from '@mdv/parser';
import { createStandardFontMetrics, naturalSize, tracePdf } from '@mdv/render-pdf';
import { toSvgString } from '@mdv/render-svg';
import type { ConformanceLevel, GoldenName } from '@mdv/spec';
import { getBuiltinTheme, listBuiltinThemes } from '@mdv/themes';

import { GOLDEN_FILE_OF, INPUT_FILE, META_FILE, normaliseGolden } from './corpus.js';
import { coverageOf } from './coverage.js';
import type {
  CaseResult,
  CheckName,
  CheckResult,
  Corpus,
  DiagnosticFingerprint,
  FixtureCase,
  Goldens,
} from './types.js';

/** Reported as the plugin that contributed the built-ins. */
export const CONFORMANCE_VERSION = '0.0.0';

/**
 * The column the corpus renders at (SPEC 16.2): `expected.svg` is "canonical SVG
 * at 800×400". 400 is not passed — it is what {@link naturalSize} gives a block
 * that sets no `height` or `aspect`, and a case that sets one means it.
 */
export const CORPUS_WIDTH = 800;

/** What to run, and how much of it. */
export interface RunOptions {
  /**
   * Run as a level-*N* implementation: cases above *N* are skipped rather than
   * failed, because a level-1 build is not required to render a level-3 case.
   * @defaultValue the case's own level, i.e. everything runs
   */
  readonly level?: ConformanceLevel | undefined;
  /** Keep only cases carrying at least one of these `meta.tags`. */
  readonly tags?: readonly string[] | undefined;
  /**
   * Run the `pdf` check. Off is for a fast inner loop, and the report says so —
   * a run with PDF disabled cannot substantiate `export.pdf`.
   * @defaultValue true
   */
  readonly pdf?: boolean | undefined;
}

/** The plugin carrying the built-in chart types and themes into a run. */
export function conformancePlugin(): MdvPlugin {
  return {
    name: '@mdv/conformance builtins',
    version: CONFORMANCE_VERSION,
    chartTypes: builtinChartTypes,
    themes: listBuiltinThemes(),
  };
}

/**
 * The pinned configuration every case resolves under.
 *
 * No `capabilities`: a fixture that reaches the network or the disk is a fixture
 * that fails on a plane, so the corpus refuses both and cases that need external
 * data ship it inline.
 */
export function conformanceConfig(
  level: ConformanceLevel,
  colorScheme: ColorScheme = 'light',
): MdvConfig {
  return {
    level,
    colorScheme,
    locale: 'en-US',
    timezone: 'UTC',
    buildTime: new Date(0),
    security: { allowExternal: false, allowFileUrls: false, allowHtml: false },
    plugins: [conformancePlugin()],
    capabilities: {},
  };
}

/**
 * Run every case, in corpus order, one at a time.
 *
 * Sequential on purpose: the checks are CPU-bound, and a run that interleaves
 * them buys nothing but a report whose failure order depends on the scheduler.
 */
export async function runCorpus(
  corpus: Corpus,
  options: RunOptions = {},
): Promise<readonly CaseResult[]> {
  const results: CaseResult[] = [];
  for (const fixture of corpus.cases) results.push(await runCase(fixture, options));
  return results;
}

/**
 * Run one case.
 *
 * Never throws for anything the case does — a thrown error *is* the result being
 * measured. It can still throw if the runner itself is broken.
 */
export async function runCase(fixture: FixtureCase, options: RunOptions = {}): Promise<CaseResult> {
  const filtered = filterReason(fixture, options);
  if (filtered !== undefined) {
    return { fixture, checks: [], covered: [], status: 'skip', reason: filtered };
  }

  const checks: CheckResult[] = [];
  const state: RunState = { checks };

  await pipeline(fixture, options, state);

  const failed = checks.some((check) => check.status === 'fail');
  const ran = checks.some((check) => check.status !== 'skip');
  const status = failed ? 'fail' : ran ? 'pass' : 'skip';

  return {
    fixture,
    checks: sortChecks(checks),
    covered:
      status === 'pass'
        ? coverageOf({
            meta: fixture.meta,
            document: state.resolved,
            svg: state.svg,
            checks,
          })
        : [],
    status,
    ...(status === 'skip' ? { reason: 'every check was skipped' } : {}),
  };
}

/** What one case accumulates as it goes. */
interface RunState {
  readonly checks: CheckResult[];
  resolved?: ResolvedDocument | undefined;
  svg?: string | undefined;
}

/**
 * `undefined` when the case should run; the reason it should not, otherwise.
 *
 * Shared with the write path so `--level` and `--tag` select the same cases
 * whether they are being compared or minted.
 */
export function filterReason(fixture: FixtureCase, options: RunOptions): string | undefined {
  const level = options.level;
  if (level !== undefined && fixture.meta.level > level) {
    return `level ${String(fixture.meta.level)} case, run is level ${String(level)}`;
  }
  const tags = options.tags;
  if (tags !== undefined && tags.length > 0) {
    const wanted = new Set(tags);
    if (!fixture.meta.tags.some((tag) => wanted.has(tag))) {
      return `no tag in ${[...wanted].sort().join(', ')}`;
    }
  }
  return undefined;
}

/**
 * The eight checks, in {@link CHECK_ORDER}, stopping at the first failure.
 *
 * Written as one straight line rather than a table of handlers: the checks are
 * not independent — each one consumes what the last produced — and pretending
 * otherwise costs more in plumbing than the symmetry is worth.
 */
async function pipeline(fixture: FixtureCase, options: RunOptions, state: RunState): Promise<void> {
  const { goldens } = fixture;

  // ── parse ──────────────────────────────────────────────────────────────────
  const parsed = attempt(state, 'parse', 'parsed without error', () => parse(fixture.source));
  if (parsed === FAILED) return;

  // ── round-trip (SPEC 27) ───────────────────────────────────────────────────
  const printed = attempt(state, 'round-trip', undefined, () => {
    const text = toMarkdown(parsed);
    const again = parse(text);
    if (!sameDocument(parsed, again)) {
      throw new RoundTripError(diffOf(canonicalAst(parsed), canonicalAst(again)));
    }
    return text;
  });
  if (printed === FAILED) return;

  // ── resolve ────────────────────────────────────────────────────────────────
  const resolved = await attemptAsync(state, 'resolve', 'resolved without error', async () =>
    resolve(parsed, conformanceConfig(fixture.meta.level)),
  );
  if (resolved === FAILED) return;
  state.resolved = resolved;

  // ── ast ────────────────────────────────────────────────────────────────────
  // SPEC 16.2: `expected.ast.json` is the canonical AST *after resolution*, so
  // it pins the dataset attachment as well as the parse.
  const astOwed = owed(fixture, 'ast');
  if (goldens.ast !== undefined || astOwed !== undefined) {
    const ok = compareOr(state, 'ast', goldens.ast, astOwed, () => canonicalAst(resolved.ast));
    if (ok === FAILED) return;
  }

  // ── diagnostics ────────────────────────────────────────────────────────────
  const diagnosticsOwed = owed(fixture, 'diagnostics');
  if (goldens.diagnostics !== undefined || diagnosticsOwed !== undefined) {
    const ok = attempt(state, 'diagnostics', undefined, () => {
      if (diagnosticsOwed !== undefined) throw new UnmintedError(diagnosticsOwed);
      const mismatch = diagnosticsMismatch(goldens.diagnostics ?? [], resolved.diagnostics);
      if (mismatch !== undefined) throw new GoldenError(mismatch);
      return true;
    });
    if (ok === FAILED) return;
  }

  // ── render ─────────────────────────────────────────────────────────────────
  const svgOwed = owed(fixture, 'svg');
  if (resolved.blocks.length === 0) {
    // A drawn golden and nothing drawn is a broken case, not a quiet skip:
    // skipping here is how an `expected.svg` beside a document that stopped
    // producing blocks would go unnoticed for as long as nobody looked.
    if (goldens.svg !== undefined || svgOwed !== undefined) {
      state.checks.push({ check: 'render', status: 'fail', reason: NO_BLOCKS });
      return;
    }
    state.checks.push({ check: 'render', status: 'skip', reason: 'no visual blocks' });
  } else {
    const svg = compareOr(state, 'render', goldens.svg, svgOwed, () => svgFor(resolved));
    if (svg === FAILED) return;
    state.svg = svg;
  }

  // ── dark ───────────────────────────────────────────────────────────────────
  // Only ever a golden comparison: re-rendering under the dark theme with
  // nothing to compare against re-tests the light path and reports it twice.
  const darkOwed = owed(fixture, 'dark');
  if (goldens.dark !== undefined || darkOwed !== undefined) {
    if (resolved.blocks.length === 0) {
      state.checks.push({ check: 'dark', status: 'fail', reason: NO_BLOCKS });
      return;
    }
    const ok = await compareAsync(state, 'dark', goldens.dark, darkOwed, async () => {
      const dark = await resolve(parsed, conformanceConfig(fixture.meta.level, 'dark'));
      return svgFor(dark);
    });
    if (!ok) return;
  }

  // ── pdf ────────────────────────────────────────────────────────────────────
  if (options.pdf === false) {
    state.checks.push({ check: 'pdf', status: 'skip', reason: 'pdf checks disabled' });
    return;
  }
  await compareAsync(state, 'pdf', goldens.pdf, owed(fixture, 'pdf'), async () =>
    canonicalAst(await traceOf(resolved, fixture.source)),
  );
}

/** Said of a case that pins something drawn and drew nothing. */
export const NO_BLOCKS = 'the case pins a rendered golden but the document has no visual blocks';

/**
 * The complaint for a golden the case promised and did not ship, or `undefined`
 * when it owes nothing.
 *
 * A promise is `meta.pin`; a file beside the case is its own promise, already
 * kept. The debt is reported as a failed *check* rather than as a
 * {@link CorpusIssue} on purpose: `--update` loads the corpus it is about to
 * fill, and a loader that refused the very state the write path exists to
 * repair could never be run.
 */
function owed(fixture: FixtureCase, name: GoldenName): string | undefined {
  if (fixture.goldens[name] !== undefined) return undefined;
  if (!fixture.meta.pin.includes(name)) return undefined;
  return `${META_FILE} pins ${JSON.stringify(name)} but ${GOLDEN_FILE_OF[name]} is missing; run pnpm test:update`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The stages themselves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every block, laid out at the corpus column and serialised, joined by a blank
 * line in document order.
 *
 * One file holds a whole document because a case is a document: a golden per
 * block would let a case silently lose one.
 *
 * `inlineStyles` because a golden is opened in a browser by whoever is deciding
 * whether a rendering change was intended, and `interaction: false` because the
 * hit-rect overlay belongs to a live document (SPEC 7.5) and would pin nothing
 * but its own geometry.
 *
 * Exported so the write path mints the bytes the read path compares: two
 * spellings of "render the corpus" would drift the day one of them was tuned.
 */
export function svgFor(doc: ResolvedDocument): string {
  return doc.blocks
    .map((block) => toSvgString(sceneFor(doc, block), { inlineStyles: true, interaction: false }))
    .join('\n\n');
}

function sceneFor(doc: ResolvedDocument, block: ResolvedBlock): Scene {
  const ctx = createLayoutContext(doc, block);
  return layoutBlock(block, naturalSize(block.attrs, CORPUS_WIDTH, block.theme), ctx);
}

/**
 * The operator trace (SPEC 28.10), not the bytes: a PDF file embeds its own
 * length and offsets, so comparing bytes would report every unrelated change as
 * a diff on every page.
 *
 * Export diagnostics (`MDV5100` and friends) are collected and discarded — the
 * `diagnostics` golden pins the resolve stage, and a corpus that wants to pin an
 * export diagnostic needs a file the corpus does not yet define.
 *
 * Exported for the same reason as {@link svgFor}.
 */
export async function traceOf(doc: ResolvedDocument, source: string): Promise<unknown> {
  const first = doc.blocks[0];
  const registry = first === undefined ? undefined : createLayoutContext(doc, first).registry;
  const discarded: Diagnostic[] = [];
  return tracePdf(doc, {
    fonts: [],
    metrics: createStandardFontMetrics(),
    buildTime: doc.config.buildTime,
    onDiagnostic: (d) => discarded.push(d),
    // SPEC 28.5: the print theme, always. A case that wants its own theme in a
    // PDF is pinning `expected.pdf.json` against a moving target.
    printTheme: getBuiltinTheme('print'),
    source,
    sourceName: INPUT_FILE,
    ...(registry === undefined ? {} : { registry }),
  });
}

/**
 * A diagnostic reduced to the fields a golden is allowed to hold it to.
 *
 * Everything {@link diagnosticsMismatch} can compare is minted, because a
 * minted golden must fail if any of it changes; an author who wants a looser
 * pin deletes fields by hand, which is a decision and looks like one.
 */
export function fingerprintOf(diagnostic: Diagnostic): DiagnosticFingerprint {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    source: diagnostic.source,
    range: [diagnostic.range.start.offset, diagnostic.range.end.offset],
  };
}

/**
 * The first way the produced diagnostics differ from the pinned ones, or
 * `undefined`.
 *
 * A fingerprint compares only the fields it declares (SPEC 16.2): `message` and
 * `detail` are localisable and are never compared, and a golden that omits
 * `range` is asserting the code and nothing about where.
 */
function diagnosticsMismatch(
  expected: readonly DiagnosticFingerprint[],
  actual: readonly Diagnostic[],
): string | undefined {
  const lines: string[] = [];
  for (let i = 0; i < Math.max(expected.length, actual.length); i += 1) {
    const want = expected[i];
    const got = actual[i];
    if (want === undefined) {
      lines.push(`[${String(i)}] unexpected ${describe(got)}`);
      continue;
    }
    if (got === undefined) {
      lines.push(`[${String(i)}] missing ${want.code}`);
      continue;
    }
    const at = `[${String(i)}]`;
    if (want.code !== got.code) lines.push(`${at} code: want ${want.code}, got ${got.code}`);
    if (want.severity !== undefined && want.severity !== got.severity) {
      lines.push(`${at} severity: want ${want.severity}, got ${got.severity}`);
    }
    if (want.source !== undefined && want.source !== got.source) {
      lines.push(`${at} source: want ${want.source}, got ${got.source}`);
    }
    const range = want.range;
    if (range !== undefined) {
      const offsets: readonly [number, number] = [got.range.start.offset, got.range.end.offset];
      if (range[0] !== offsets[0] || range[1] !== offsets[1]) {
        lines.push(`${at} range: want ${rangeText(range)}, got ${rangeText(offsets)}`);
      }
    }
  }
  return lines.length === 0 ? undefined : lines.join('\n');
}

function describe(diagnostic: Diagnostic | undefined): string {
  return diagnostic === undefined ? 'nothing' : `${diagnostic.code} (${diagnostic.severity})`;
}

function rangeText(range: readonly [number, number]): string {
  return `[${String(range[0])}, ${String(range[1])}]`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Check plumbing
// ─────────────────────────────────────────────────────────────────────────────

/** The sentinel a failed stage returns, so `undefined` can stay a real value. */
const FAILED = Symbol('failed');
type Failed = typeof FAILED;

/**
 * A failure the runner raised on purpose.
 *
 * Told apart from an error thrown by the build because its message is already
 * the report line and its {@link detail} is already formatted: printing the
 * stack of the comparison that found a golden mismatch buries the diff under
 * the plumbing.
 */
abstract class ExpectedFailure extends Error {
  constructor(
    message: string,
    /** Many lines, already formatted. Empty when the message says it all. */
    readonly detail: string,
  ) {
    super(message);
  }
}

/** A round-trip difference, already formatted. */
class RoundTripError extends ExpectedFailure {
  constructor(diff: string) {
    super('parse → toMarkdown → parse changed the document', diff);
    this.name = 'RoundTripError';
  }
}

/** A golden mismatch, already formatted. */
class GoldenError extends ExpectedFailure {
  constructor(diff: string) {
    super('output does not match the golden', diff);
    this.name = 'GoldenError';
  }
}

/**
 * A golden the case promised and does not ship.
 *
 * Thrown *after* the artefact was produced, so the stage is still exercised and
 * a case that cannot render yet fails on the render rather than on the paperwork.
 */
class UnmintedError extends ExpectedFailure {
  constructor(message: string) {
    super(message, '');
    this.name = 'UnmintedError';
  }
}

/** Run a stage, recording `pass` or the thrown error as `fail`. */
function attempt<T>(
  state: RunState,
  check: CheckName,
  reason: string | undefined,
  body: () => T,
): T | Failed {
  try {
    const value = body();
    state.checks.push({ check, status: 'pass', ...(reason === undefined ? {} : { reason }) });
    return value;
  } catch (error) {
    state.checks.push(failure(check, error));
    return FAILED;
  }
}

async function attemptAsync<T>(
  state: RunState,
  check: CheckName,
  reason: string | undefined,
  body: () => Promise<T>,
): Promise<T | Failed> {
  try {
    const value = await body();
    state.checks.push({ check, status: 'pass', ...(reason === undefined ? {} : { reason }) });
    return value;
  } catch (error) {
    state.checks.push(failure(check, error));
    return FAILED;
  }
}

function failure(check: CheckName, error: unknown): CheckResult {
  const detail = error instanceof ExpectedFailure ? error.detail : stackOf(error);
  return {
    check,
    status: 'fail',
    reason: errorText(error),
    ...(detail === '' ? {} : { detail }),
  };
}

async function compareAsync(
  state: RunState,
  check: CheckName,
  golden: string | undefined,
  unminted: string | undefined,
  body: () => Promise<string>,
): Promise<boolean> {
  return (
    (await attemptAsync(state, check, unpinned(golden, unminted), async () => {
      const actual = normaliseGolden(await body());
      return held(actual, golden, unminted);
    })) !== FAILED
  );
}

/**
 * Hold a stage to a golden when there is one, and to "it did not throw" when
 * there is not — and say which, because a reader of the report is entitled to
 * know that a passing `render` on a case with no `expected.svg` proves only that
 * the renderer returned.
 */
function compareOr(
  state: RunState,
  check: CheckName,
  golden: string | undefined,
  unminted: string | undefined,
  body: () => string,
): string | Failed {
  return attempt(state, check, unpinned(golden, unminted), () =>
    held(normaliseGolden(body()), golden, unminted),
  );
}

/**
 * The produced text, once it has answered for itself.
 *
 * The order matters: an owed golden is reported only after the artefact exists,
 * so "you never minted this" is never mistaken for "this stage is broken".
 */
function held(actual: string, golden: string | undefined, unminted: string | undefined): string {
  if (unminted !== undefined) throw new UnmintedError(unminted);
  if (golden !== undefined && actual !== golden) throw new GoldenError(diffOf(golden, actual));
  return actual;
}

/** The `pass` reason for a check with nothing to compare against, if it is one. */
function unpinned(golden: string | undefined, unminted: string | undefined): string | undefined {
  return golden === undefined && unminted === undefined ? UNPINNED : undefined;
}

/** Said of a check that ran with no golden to compare against. */
const UNPINNED = 'ran without error; the case pins no golden for it';

/** Report order is {@link CHECK_ORDER}; run order already is, but be sure. */
function sortChecks(checks: readonly CheckResult[]): readonly CheckResult[] {
  return [...checks].sort((a, b) => CHECK_INDEX[a.check] - CHECK_INDEX[b.check]);
}

const CHECK_INDEX: Readonly<Record<CheckName, number>> = {
  parse: 0,
  'round-trip': 1,
  resolve: 2,
  ast: 3,
  diagnostics: 4,
  render: 5,
  dark: 6,
  pdf: 7,
};

/**
 * The first differing line, with a little context.
 *
 * Not a real diff: a golden mismatch is read by opening the two files, and a
 * report that inlines two thousand lines of SVG is a report nobody scrolls.
 */
export function diffOf(expected: string, actual: string): string {
  const want = expected.split('\n');
  const got = actual.split('\n');
  // Walk the longer of the two: a golden that is a prefix of the output differs
  // at the line after it ends, and saying "line 12 of 11" helps nobody.
  const length = Math.max(want.length, got.length);
  let at = -1;
  for (let i = 0; i < length; i += 1) {
    if (want[i] !== got[i]) {
      at = i;
      break;
    }
  }
  if (at === -1) return 'no textual difference';
  if (want[at] === undefined || got[at] === undefined) {
    return `same ${String(Math.min(want.length, got.length))} lines, then ${
      want.length > got.length ? 'the golden continues' : 'the output continues'
    }`;
  }
  return [
    `first difference at line ${String(at + 1)} of ${String(want.length)}`,
    `- ${clip(want[at] ?? '')}`,
    `+ ${clip(got[at] ?? '')}`,
  ].join('\n');
}

function clip(line: string): string {
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0] ?? message;
}

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack !== undefined ? error.stack : String(error);
}

/** Exported for the report, which needs to know what a case *could* pin. */
export function pinned(goldens: Goldens): readonly CheckName[] {
  const names: CheckName[] = [];
  if (goldens.ast !== undefined) names.push('ast');
  if (goldens.diagnostics !== undefined) names.push('diagnostics');
  if (goldens.svg !== undefined) names.push('render');
  if (goldens.dark !== undefined) names.push('dark');
  if (goldens.pdf !== undefined) names.push('pdf');
  return names;
}

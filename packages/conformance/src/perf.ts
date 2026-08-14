/**
 * Measuring this build against the SPEC 24.1 budgets.
 *
 * The corpus (SPEC 16.2) answers *is this build correct*. This answers *is it
 * fast enough*, against the eleven rows of the SPEC 24.1 table. Two of those
 * rows are bundle sizes — a property of the built artifacts rather than of any
 * document — and are measured by `scripts/perf.mjs`. The other nine are
 * document operations and are measured here.
 *
 * The shapes live in the corpus, not in this file:
 *
 * > Budgets are enforced by `perf/` fixtures in CI.
 *
 * So a perf case is an ordinary fixture case — `input.mdv` plus `meta.json`,
 * loadable and runnable by the corpus like any other — that additionally ships
 * a `budget.json` naming the SPEC 24.1 row it stands for. Two consequences
 * worth stating:
 *
 * 1. The committed document stays small and legible. A fixture that shipped ten
 *    thousand literal data rows would be unreadable, would dominate the
 *    repository, and would mint a golden nobody could review. Instead the
 *    budget declares the shape (`repeat`, `rows`) and this harness expands the
 *    fixture to it deterministically before measuring (SPEC 24.3 rule 1: the
 *    expansion is a fixed sequence, never `Math.random()`).
 * 2. The perf cases are checked for correctness too. A benchmark that measures
 *    a document the build cannot actually render is measuring nothing.
 *
 * ## What a number here does and does not mean
 *
 * Every measurement is the median of {@link MEASURED_RUNS} timed runs after
 * {@link WARMUP_RUNS} untimed ones, which is what SPEC 24.1 asks for ("median of
 * 20 runs"). What it cannot promise is the spec's machine — "a 2020-class
 * laptop, 4-core, no GPU" — so the report states the host it ran on and the
 * verdicts are only meaningful next to that line.
 *
 * Three rows are measured against a substitute and say so in their note, rather
 * than quietly reporting a number for something this build does not have:
 *
 * - **canvas** — there is no canvas backend yet, so the scatter row renders
 *   through `@mdv/render-svg`'s string backend.
 * - **the DOM half of a frame** — hover and incremental update are measured up
 *   to the new scene, not through a DOM patch, because this package has no DOM.
 * - **"never drops below 60 fps"** — a sustained-rate claim that a fixture run
 *   cannot substantiate. Only the ≤ 8 ms per-frame half of that row is measured.
 *
 * A number that flatters the build by leaving out the expensive half is worse
 * than no number, so each of those appears in `PERF.md` beside its measurement.
 */

import { performance } from 'node:perf_hooks';
import { join } from 'node:path';

import type {
  HitRegion,
  LegendAttr,
  MdvConfig,
  ReadoutRow,
  ResolvedBlock,
  ResolvedDocument,
  Scene,
} from '@mdv/core';
import { createLayoutContext, layoutBlock, parse, resolve } from '@mdv/core';
import type { Diagnostic } from '@mdv/parser';
import type { PdfExportContext } from '@mdv/render-pdf';
import { createStandardFontMetrics, exportPdf, naturalSize, tracePdf } from '@mdv/render-pdf';
import { toSvgString } from '@mdv/render-svg';
import type { ConformanceLevel } from '@mdv/spec';
import { getBuiltinTheme } from '@mdv/themes';

import { BUDGET_FILE, INPUT_FILE, readIfPresent } from './corpus.js';
import { CORPUS_WIDTH, conformanceConfig } from './run.js';
import type { Corpus } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// The budget file
// ─────────────────────────────────────────────────────────────────────────────

export { BUDGET_FILE } from './corpus.js';

/**
 * The nine document rows of the SPEC 24.1 table.
 *
 * Named for what is measured rather than for the fixture, because two fixtures
 * can stand for one row (the table has two `parse` rows) and the report has to
 * print the spec's own wording either way — which is what {@link PerfBudget.spec}
 * carries.
 */
export type PerfOperation =
  | 'parse'
  | 'prepare-encode-layout'
  | 'layout-render'
  | 'first-chart'
  | 'interaction-frame'
  | 'resize-reflow'
  | 'incremental-update'
  | 'pdf-export';

/** Every legal {@link PerfOperation}, for validation and for error messages. */
export const PERF_OPERATIONS: readonly PerfOperation[] = [
  'parse',
  'prepare-encode-layout',
  'layout-render',
  'first-chart',
  'interaction-frame',
  'resize-reflow',
  'incremental-update',
  'pdf-export',
];

/** A parsed, validated `budget.json`. */
export interface PerfBudget {
  /** Which measurement to take. */
  readonly operation: PerfOperation;
  /** The SPEC 24.1 "Operation" cell, verbatim, so the report quotes the spec. */
  readonly spec: string;
  /** The SPEC 24.1 "Budget" cell in milliseconds. */
  readonly budget: number;
  /**
   * Body repetitions before measuring. `50` turns a one-block fixture into the
   * fifty-block document the spec row names. Front matter is not repeated.
   * @defaultValue 1
   */
  readonly repeat?: number;
  /**
   * Data rows per block before measuring. Omit to measure the rows as authored.
   * @defaultValue as authored
   */
  readonly rows?: number;
  /** Anything the reader of `PERF.md` needs in order to trust the number. */
  readonly note?: string;
}

const BUDGET_KEYS: ReadonlySet<string> = new Set([
  'operation',
  'spec',
  'budget',
  'repeat',
  'rows',
  'note',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isPerfOperation(value: unknown): value is PerfOperation {
  return typeof value === 'string' && (PERF_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Validate one `budget.json` body.
 *
 * Returns the budget and the problems found, all of them at once rather than one
 * per invocation — the same bargain `readMeta` strikes, and for the same reason:
 * a case with two mistakes should report two mistakes.
 */
export function readBudget(value: unknown): {
  readonly budget: PerfBudget | undefined;
  readonly errors: readonly string[];
} {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return { budget: undefined, errors: [`${BUDGET_FILE} must be a JSON object`] };
  }

  for (const key of Object.keys(value)) {
    if (!BUDGET_KEYS.has(key)) errors.push(`${BUDGET_FILE}: unknown key ${JSON.stringify(key)}`);
  }

  const rawOperation = value['operation'];
  if (!isPerfOperation(rawOperation)) {
    errors.push(
      `${BUDGET_FILE}: "operation" must be one of ${PERF_OPERATIONS.join(', ')}, got ` +
        `${JSON.stringify(rawOperation)}`,
    );
  }

  const rawSpec = value['spec'];
  if (typeof rawSpec !== 'string' || rawSpec === '') {
    errors.push(`${BUDGET_FILE}: "spec" must be the SPEC 24.1 operation cell, verbatim`);
  }

  const rawBudget = value['budget'];
  if (typeof rawBudget !== 'number' || !Number.isFinite(rawBudget) || rawBudget <= 0) {
    errors.push(`${BUDGET_FILE}: "budget" must be a positive number of milliseconds`);
  }

  const repeat = readCount(value['repeat'], 'repeat', errors);
  const rows = readCount(value['rows'], 'rows', errors);

  const note = value['note'];
  if (note !== undefined && typeof note !== 'string') {
    errors.push(`${BUDGET_FILE}: "note" must be a string`);
  }

  if (errors.length > 0) return { budget: undefined, errors };
  return {
    budget: {
      operation: rawOperation as PerfOperation,
      spec: rawSpec as string,
      budget: rawBudget as number,
      ...(repeat === undefined ? {} : { repeat }),
      ...(rows === undefined ? {} : { rows }),
      ...(typeof note === 'string' ? { note } : {}),
    },
    errors,
  };
}

function readCount(value: unknown, key: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    errors.push(`${BUDGET_FILE}: ${JSON.stringify(key)} must be a positive integer`);
    return undefined;
  }
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────────

/** A corpus case that carries a budget, ready to measure. */
export interface PerfCase {
  /** The corpus case id, e.g. `perf/parse/100kb`. */
  readonly id: string;
  /** The document under measurement, as committed. */
  readonly source: string;
  /** The level to configure the pipeline at. */
  readonly level: ConformanceLevel;
  readonly budget: PerfBudget;
}

/**
 * Pull the measurable cases out of a loaded corpus.
 *
 * A `perf/` case with no `budget.json` is reported as an issue rather than
 * skipped: a perf fixture that declares no budget is a fixture nobody is
 * enforcing, and silence there is how a budget row quietly stops being checked.
 */
export async function perfCasesOf(corpus: Corpus): Promise<{
  readonly cases: readonly PerfCase[];
  readonly issues: readonly string[];
}> {
  const cases: PerfCase[] = [];
  const issues: string[] = [];

  for (const fixture of corpus.cases) {
    if (fixture.category !== 'perf') continue;
    const raw = await readIfPresent(join(fixture.dir, BUDGET_FILE));
    if (raw === undefined) {
      issues.push(`${fixture.id}: a perf case must ship ${BUDGET_FILE} (SPEC 24.1)`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      issues.push(`${fixture.id}: ${BUDGET_FILE} is not JSON: ${String(error)}`);
      continue;
    }
    const { budget, errors } = readBudget(parsed);
    for (const message of errors) issues.push(`${fixture.id}: ${message}`);
    if (budget === undefined) continue;
    cases.push({ id: fixture.id, source: fixture.source, level: fixture.meta.level, budget });
  }

  return { cases, issues };
}

// ─────────────────────────────────────────────────────────────────────────────
// Growing a fixture to the shape the spec names
// ─────────────────────────────────────────────────────────────────────────────

/** Appendix A: `separator = "---" *WSP LF`. The same line the parser splits on. */
const SEPARATOR = /^---[ \t]*$/;
/** An opening or closing fence, indentation preserved. */
const FENCE = /^(\s*)(```+|~~~+)(.*)$/;

/**
 * Split leading front matter from the body.
 *
 * Repetition must not duplicate the front matter — `mdv: "1.0"` twice is a
 * different document, and a malformed one. Everything before the closing `---`
 * of a leading block stays put; a document without front matter is all body.
 */
export function splitFrontMatter(source: string): { front: string; body: string } {
  const lines = source.split('\n');
  if (lines[0] === undefined || !SEPARATOR.test(lines[0])) return { front: '', body: source };
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (SEPARATOR.test(line) || /^\.\.\.[ \t]*$/.test(line)) {
      const front = lines.slice(0, i + 1).join('\n');
      return { front: `${front}\n`, body: lines.slice(i + 1).join('\n') };
    }
  }
  return { front: '', body: source };
}

/**
 * Repeat the body `count` times, front matter kept once.
 *
 * The fixtures this is applied to declare no `id:`, so the repeated blocks take
 * the deterministic `mdv-{index}` fallback and repeated headings take
 * deterministically de-duplicated slugs — the document is legal, not merely
 * parseable.
 */
export function repeatBody(source: string, count: number): string {
  if (count <= 1) return source;
  const { front, body } = splitFrontMatter(source);
  const trimmed = body.replace(/^\n+/, '').replace(/\n+$/, '');
  const copies: string[] = [];
  for (let i = 0; i < count; i += 1) copies.push(trimmed);
  return `${front}\n${copies.join('\n\n')}\n`;
}

/**
 * Replace the data body of every `mdv` fence with `count` generated rows.
 *
 * The generator is the point of this function: it has to produce rows the type
 * inference of SPEC 5.1 classifies exactly as it classified the committed
 * sample, or the measurement is of a different chart than the one the fixture
 * shows. So each column is grown from its own sample values — numeric columns
 * stay numeric, categorical columns cycle their own distinct values in
 * first-appearance order — and the first column, when numeric, becomes a running
 * index so an x axis stays monotonic over a thousand rows.
 *
 * Deterministic by construction (SPEC 24.3 rule 1): a 32-bit LCG seeded from the
 * column index, no clock and no randomness.
 */
export function growRows(source: string, count: number): string {
  const lines = source.split('\n');
  const out: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const open = FENCE.exec(line);
    if (open === null || !/^\s*mdv\b/.test(open[3] ?? '')) {
      out.push(line);
      continue;
    }

    // Collect the fence body up to its closing marker.
    const marker = open[2] as string;
    const body: string[] = [];
    let close = lines.length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const candidate = lines[j] as string;
      const end = FENCE.exec(candidate);
      if (end !== null && (end[2] as string).startsWith(marker) && (end[3] ?? '').trim() === '') {
        close = j;
        break;
      }
      body.push(candidate);
    }

    out.push(line);
    out.push(...grownFenceBody(body, count));
    if (close < lines.length) out.push(lines[close] as string);
    i = close;
  }

  return out.join('\n');
}

function grownFenceBody(body: readonly string[], count: number): string[] {
  const at = body.findIndex((line) => SEPARATOR.test(line));
  if (at < 0) return [...body];

  const header = body.slice(0, at + 1);
  const data = body.slice(at + 1).filter((line) => line.trim() !== '');
  const first = data[0];
  if (first === undefined) return [...body];

  const indent = /^\s*/.exec(first)?.[0] ?? '';
  const delimiter = first.includes('|') ? '|' : ',';
  const cells = (line: string): string[] => line.split(delimiter).map((cell) => cell.trim());
  const columns = cells(first);
  const sample = data.slice(1).map(cells);
  if (sample.length === 0) return [...body];

  const join = delimiter === '|' ? ' | ' : ',';
  const rows: string[] = [`${indent}${columns.join(join)}`];
  const generators = columns.map((_, column) => columnGenerator(sample, column));
  for (let row = 0; row < count; row += 1) {
    rows.push(`${indent}${generators.map((next) => next(row)).join(join)}`);
  }
  return [...header, ...rows];
}

/** One column's value sequence, grown from that column's own sample values. */
function columnGenerator(
  sample: readonly (readonly string[])[],
  column: number,
): (row: number) => string {
  const values = sample.map((row) => row[column] ?? '');
  const numbers = values.map((value) => Number(value));
  const numeric = values.every(
    (value, index) => value !== '' && Number.isFinite(numbers[index] as number),
  );

  if (!numeric) {
    // First-appearance order, so the palette slots and the legend order of the
    // grown document match the committed one (SPEC 11.2 rule 1).
    const seen: string[] = [];
    for (const value of values) if (!seen.includes(value)) seen.push(value);
    return (row) => seen[row % seen.length] as string;
  }

  // A running index keeps the first column monotonic; other columns walk a
  // deterministic sequence inside the sample's own range, so the scale domain
  // and therefore the tick count stay recognisable.
  if (column === 0) return (row) => String(row + 1);

  const low = Math.min(...(numbers as number[]));
  const high = Math.max(...(numbers as number[]));
  const span = Math.max(1, Math.round(high - low));
  let state = ((column + 1) * 2_654_435_761) >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    return state;
  };
  const cache: string[] = [];
  return (row) => {
    while (cache.length <= row) cache.push(String(Math.round(low) + (next() % (span + 1))));
    return cache[row] as string;
  };
}

/** The document actually measured, after {@link repeatBody} and {@link growRows}. */
export function shapeSource(source: string, budget: PerfBudget): string {
  const grown = budget.rows === undefined ? source : growRows(source, budget.rows);
  return repeatBody(grown, budget.repeat ?? 1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Timing
// ─────────────────────────────────────────────────────────────────────────────

/** Untimed runs before the timed ones, to let the JIT settle. */
export const WARMUP_RUNS = 3;
/** "median of 20 runs" (SPEC 24.1). */
export const MEASURED_RUNS = 20;
/** "a regression beyond 10 % fails the build" (SPEC 24.1). */
export const TOLERANCE = 0.1;

/**
 * One trial: `setup` prepares the state a run consumes and is **not** timed,
 * `body` is.
 *
 * The split is not a nicety. `resolve` populates `MdvDocument.datasets` in place,
 * so timing twenty resolves of one parsed document would time one resolve and
 * nineteen cache hits. Each run gets its own state instead.
 */
export interface Trial<T> {
  setup(): T | Promise<T>;
  body(state: T): unknown;
}

/** Elapsed milliseconds for each timed run, in run order. */
export async function measure<T>(
  trial: Trial<T>,
  runs: number = MEASURED_RUNS,
  warmup: number = WARMUP_RUNS,
): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < warmup + runs; i += 1) {
    const state = await trial.setup();
    // `performance.now()` is the measuring instrument, not the build: SPEC 24.3
    // rule 2 forbids wall-clock reads inside the pipeline, and nothing here is
    // inside it.
    const started = performance.now();
    await trial.body(state);
    const elapsed = performance.now() - started;
    if (i >= warmup) samples.push(elapsed);
  }
  return samples;
}

/** The median, averaging the two middle values of an even sample. */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** `pass` under budget, `over` within the 10 % tolerance, `fail` beyond it. */
export type PerfVerdict = 'pass' | 'over' | 'fail';

/**
 * SPEC 24.1's enforcement rule, read as *exceeding the budget by more than 10 %
 * fails the build*.
 *
 * The other reading — regression against a recorded baseline — needs a baseline
 * that is stable across machines, and a wall-clock number measured on a CI
 * runner is not that. The budgets are, so they are what CI compares against.
 */
export function verdictOf(measured: number, budget: number): PerfVerdict {
  if (measured <= budget) return 'pass';
  if (measured <= budget * (1 + TOLERANCE)) return 'over';
  return 'fail';
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurements
// ─────────────────────────────────────────────────────────────────────────────

/** One row of `PERF.md`. */
export interface Measurement {
  /** Corpus case id, or the artifact name for a bundle row. */
  readonly id: string;
  /** The SPEC 24.1 "Operation" cell, verbatim. */
  readonly spec: string;
  readonly budget: number;
  readonly measured: number;
  readonly unit: 'ms' | 'KB';
  /** What was actually measured — bytes, blocks, rows, pages. */
  readonly shape: string;
  /** Timed runs behind {@link measured}; `1` for a bundle size. */
  readonly runs: number;
  readonly verdict: PerfVerdict;
  /** Substitutions and exclusions, printed beside the number. */
  readonly note?: string;
}

/** Overrides for a measurement run. Tests use them to keep the suite quick. */
export interface PerfRunOptions {
  readonly runs?: number;
  readonly warmup?: number;
}

interface Prepared {
  readonly source: string;
  readonly config: MdvConfig;
  readonly doc: ResolvedDocument;
  readonly block: ResolvedBlock;
}

async function prepare(input: PerfCase, source: string): Promise<Prepared> {
  const config = conformanceConfig(input.level);
  const doc = await resolve(parse(source), config);
  const block = doc.blocks[0];
  if (block === undefined) throw new Error(`${input.id}: the document has no visual block`);
  return { source, config, doc, block };
}

function sceneOf(doc: ResolvedDocument, block: ResolvedBlock, width = CORPUS_WIDTH): Scene {
  const ctx = createLayoutContext(doc, block);
  return layoutBlock(block, naturalSize(block.attrs, width, block.theme), ctx);
}

function renderOf(scene: Scene): string {
  return toSvgString(scene, { inlineStyles: true, interaction: false });
}

/** Bytes of the measured document, and the shape the pipeline saw. */
function shapeOf(prepared: Prepared): string {
  const bytes = Buffer.byteLength(prepared.source, 'utf8');
  const blocks = prepared.doc.blocks.length;
  const rows = prepared.block.table.rows.length;
  const parts = [formatBytes(bytes), `${blocks} block${blocks === 1 ? '' : 's'}`];
  if (rows > 0) parts.push(`${rows.toLocaleString('en-US')} rows`);
  return parts.join(', ');
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024).toString()} KB`;
  return `${bytes.toString()} B`;
}

/**
 * A pointer pick over `Scene.hitIndex`, in painter's order.
 *
 * Harness code, deliberately: the DOM backend has no hit-testing of its own
 * (the browser hits the transparent target rects layout emitted), so a headless
 * frame has to do what a canvas host would — scan the same regions, last match
 * winning. It is the cheap half of the frame either way.
 */
function pickAt(regions: readonly HitRegion[], x: number, y: number): HitRegion | undefined {
  let found: HitRegion | undefined;
  for (const region of regions) {
    if (x >= region.x && x <= region.x + region.w && y >= region.y && y <= region.y + region.h) {
      found = region;
    }
  }
  return found;
}

/** The crosshair column: every region sharing the picked datum's index. */
function crosshairRows(regions: readonly HitRegion[], picked: HitRegion): ReadoutRow[] {
  const rows: ReadoutRow[] = [];
  for (const region of regions) {
    if (region.datumIndex !== picked.datumIndex) continue;
    for (const row of region.readout) {
      rows.push(region.id === picked.id ? { ...row, emphasis: true } : row);
    }
  }
  return rows;
}

/** Deterministic pointer positions across the plot, cycled one per frame. */
function pointerPath(scene: Scene, steps = 16): { x: number; y: number }[] {
  const path: { x: number; y: number }[] = [];
  for (let i = 0; i < steps; i += 1) {
    path.push({
      x: (scene.width * (i + 0.5)) / steps,
      y: scene.height / 2,
    });
  }
  return path;
}

/**
 * The pinned export context (SPEC 28.5), matching the corpus runner's exactly.
 *
 * A PDF measured with a different font set or a different theme than the one the
 * corpus checks is a measurement of a build that does not exist.
 */
function pdfContext(doc: ResolvedDocument, block: ResolvedBlock, source: string): PdfExportContext {
  const discarded: Diagnostic[] = [];
  return {
    fonts: [],
    metrics: createStandardFontMetrics(),
    buildTime: doc.config.buildTime,
    onDiagnostic: (d: Diagnostic) => discarded.push(d),
    printTheme: getBuiltinTheme('print'),
    source,
    sourceName: INPUT_FILE,
    registry: createLayoutContext(doc, block).registry,
  };
}

/**
 * Measure one case against its budget.
 *
 * Each branch times exactly the stages its SPEC 24.1 row names and no more —
 * "Layout + render" does not pay for prepare, "Prepare + encode + layout" does
 * not pay for the render — because a budget that quietly includes a neighbouring
 * stage is a budget nobody can act on when it fails.
 */
export async function measureCase(
  input: PerfCase,
  options: PerfRunOptions = {},
): Promise<Measurement> {
  const runs = options.runs ?? MEASURED_RUNS;
  const warmup = options.warmup ?? WARMUP_RUNS;
  const source = shapeSource(input.source, input.budget);
  const budget = input.budget;
  const config = conformanceConfig(input.level);

  const timed = async <T>(trial: Trial<T>): Promise<number[]> => measure(trial, runs, warmup);
  let samples: number[];
  let shape: string;
  let note = budget.note;

  switch (budget.operation) {
    case 'parse': {
      // Stage 1 alone. No resolve: the row says "Parse".
      const ast = parse(source);
      const blocks = ast.children.filter((node) => node.type === 'mdvBlock').length;
      shape = `${formatBytes(Buffer.byteLength(source, 'utf8'))}, ${blocks.toString()} blocks`;
      samples = await timed({ setup: () => undefined, body: () => parse(source) });
      break;
    }

    case 'prepare-encode-layout': {
      // Prepare is stage 4 and lives inside `resolve`; encode and layout are
      // stages 5 and 6 and live inside `layoutBlock`. Parse is excluded, which
      // is why it happens in setup.
      const prepared = await prepare(input, source);
      shape = shapeOf(prepared);
      samples = await timed({
        setup: () => parse(source),
        body: async (ast) => {
          const doc = await resolve(ast, config);
          const block = doc.blocks[0];
          if (block !== undefined) sceneOf(doc, block);
        },
      });
      break;
    }

    case 'layout-render': {
      const prepared = await prepare(input, source);
      shape = shapeOf(prepared);
      note = note ?? 'canvas: measured through the SVG string backend; there is no canvas yet.';
      samples = await timed({
        setup: () => prepared,
        body: (state) => renderOf(sceneOf(state.doc, state.block)),
      });
      break;
    }

    case 'first-chart': {
      // "after parse": everything from the parsed AST to the first chart on
      // screen — the whole document's resolve, then one block's scene.
      const prepared = await prepare(input, source);
      shape = shapeOf(prepared);
      samples = await timed({
        setup: () => parse(source),
        body: async (ast) => {
          const doc = await resolve(ast, config);
          const block = doc.blocks[0];
          if (block !== undefined) renderOf(sceneOf(doc, block));
        },
      });
      break;
    }

    case 'interaction-frame': {
      const prepared = await prepare(input, source);
      const scene = sceneOf(prepared.doc, prepared.block);
      const path = pointerPath(scene);
      shape = `${shapeOf(prepared)}, ${scene.hitIndex.length.toString()} hit regions`;
      note =
        note ??
        'Pick + readout only: the DOM write half of the frame needs a document, ' +
          'and the "never drops below 60 fps" clause needs a session, not a fixture.';
      let frame = 0;
      samples = await timed({
        setup: () => path[frame++ % path.length] as { x: number; y: number },
        body: (point) => {
          const picked = pickAt(scene.hitIndex, point.x, point.y);
          return picked === undefined ? undefined : crosshairRows(scene.hitIndex, picked);
        },
      });
      break;
    }

    case 'resize-reflow': {
      // A reflow re-lays out every visible block at the new width and repaints
      // it. Widths alternate so no stage boundary can memoise the answer.
      const prepared = await prepare(input, source);
      shape = shapeOf(prepared);
      let tick = 0;
      samples = await timed({
        setup: () => (tick++ % 2 === 0 ? CORPUS_WIDTH : CORPUS_WIDTH - 160),
        body: (width) => {
          for (const block of prepared.doc.blocks) {
            renderOf(sceneOf(prepared.doc, block, width));
          }
        },
      });
      break;
    }

    case 'incremental-update': {
      const prepared = await prepare(input, source);
      shape = shapeOf(prepared);
      note =
        note ??
        'One attribute changed, re-laid out and re-serialised. This build has no ' +
          'incremental cache, so the number is a full recompute of the affected block.';
      let tick = 0;
      samples = await timed({
        setup: (): ResolvedBlock => {
          const legend: LegendAttr = tick++ % 2 === 0 ? false : 'right';
          return { ...prepared.block, attrs: { ...prepared.block.attrs, legend } };
        },
        body: (block) => renderOf(sceneOf(prepared.doc, block)),
      });
      break;
    }

    case 'pdf-export': {
      const prepared = await prepare(input, source);
      const trace = await tracePdf(prepared.doc, pdfContext(prepared.doc, prepared.block, source));
      shape = `${shapeOf(prepared)}, ${trace.pages.length.toString()} pages`;
      samples = await timed({
        setup: () => prepared,
        body: async (state) =>
          exportPdf(state.doc, pdfContext(state.doc, state.block, state.source)),
      });
      break;
    }
  }

  const measured = median(samples);
  return {
    id: input.id,
    spec: budget.spec,
    budget: budget.budget,
    measured,
    unit: 'ms',
    shape,
    runs: samples.length,
    verdict: verdictOf(measured, budget.budget),
    ...(note === undefined ? {} : { note }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/** The host the numbers came from. Without it a verdict means very little. */
export interface PerfHost {
  readonly cpu: string;
  readonly cores: number;
  readonly memoryGb: number;
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
}

const VERDICT_TEXT: Readonly<Record<PerfVerdict, string>> = {
  pass: 'within budget',
  over: `over budget, inside the ${(TOLERANCE * 100).toFixed(0)} % tolerance`,
  fail: 'FAILS',
};

function formatValue(row: Measurement): string {
  if (row.unit === 'KB') return `${row.measured.toFixed(1)} KB`;
  if (row.measured >= 100) return `${row.measured.toFixed(0)} ms`;
  if (row.measured >= 1) return `${row.measured.toFixed(2)} ms`;
  return `${row.measured.toFixed(3)} ms`;
}

function formatBudget(row: Measurement): string {
  return row.unit === 'KB'
    ? `≤ ${row.budget.toFixed(0)} KB`
    : `≤ ${row.budget >= 1000 ? `${(row.budget / 1000).toFixed(0)} s` : `${row.budget.toFixed(0)} ms`}`;
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

/** `PERF.md`: the SPEC 24.1 table with this build's numbers beside it. */
export function renderPerfReport(rows: readonly Measurement[], host: PerfHost): string {
  const out: string[] = [];
  const failures = rows.filter((row) => row.verdict === 'fail').length;
  const over = rows.filter((row) => row.verdict === 'over').length;
  // The prose reports the runs the rows were actually measured over, not the
  // spec's number: a report that says "median of 20" above a row measured once
  // is a report that lies about its own weakest claim.
  const timedRuns = rows.filter((row) => row.unit === 'ms').map((row) => row.runs);
  const runsBehind = timedRuns.length === 0 ? MEASURED_RUNS : Math.min(...timedRuns);

  out.push('# Performance');
  out.push('');
  out.push('<!-- Generated by `pnpm perf`. Do not edit by hand. -->');
  out.push('');
  out.push(
    'What this build measures against the SPEC 24.1 budgets. Every document row is',
    `the median of ${String(runsBehind)} timed runs after ${String(WARMUP_RUNS)} untimed ones,`,
    'measured from fixtures under `packages/spec/tests/perf/`, which are ordinary',
    'corpus cases that also carry a `budget.json`.',
  );
  out.push('');
  out.push(
    'SPEC 24.1 specifies "a 2020-class laptop (4-core, no GPU acceleration assumed)".',
    'These numbers came from:',
  );
  out.push('');
  out.push(`- **CPU** — ${host.cpu} (${String(host.cores)} cores)`);
  out.push(`- **Memory** — ${host.memoryGb.toFixed(0)} GB`);
  out.push(`- **Platform** — ${host.platform} ${host.arch}`);
  out.push(`- **Runtime** — ${host.runtime}`);
  out.push('');
  out.push(
    failures > 0
      ? `**${String(failures)} of ${String(rows.length)} budgets fail.**`
      : over > 0
        ? `All ${String(rows.length)} budgets hold, ${String(over)} inside the tolerance only.`
        : `All ${String(rows.length)} budgets hold.`,
  );
  out.push('');
  out.push('| Operation (SPEC 24.1) | Measured shape | Budget | Median | Verdict |');
  out.push('|---|---|---|---|---|');
  for (const row of rows) {
    out.push(
      `| ${escapeCell(row.spec)} | ${escapeCell(row.shape)} | ${formatBudget(row)} | ` +
        `${formatValue(row)} | ${VERDICT_TEXT[row.verdict]} |`,
    );
  }
  out.push('');

  const noted = rows.filter((row) => row.note !== undefined);
  if (noted.length > 0) {
    out.push('## What these numbers leave out');
    out.push('');
    out.push(
      'A measurement that omits the expensive half of the work is worse than no',
      'measurement, so every substitution is listed here.',
    );
    out.push('');
    for (const row of noted) {
      out.push(`- **${escapeCell(row.spec)}** — ${row.note as string}`);
    }
    out.push('');
  }

  out.push('## Cases');
  out.push('');
  for (const row of rows) {
    out.push(`- \`${row.id}\` — ${escapeCell(row.spec)} (${String(row.runs)} runs)`);
  }
  out.push('');
  return out.join('\n');
}

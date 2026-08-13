/**
 * What a case proves (SPEC 16.1, SPEC 16.3).
 *
 * Coverage is mostly **derived**, not declared: a case that renders a stacked
 * bar chart from a CSV section covers `type.bar` and `data.csv` because the
 * resolved document says so, not because someone remembered to write it in
 * `meta.json`. Derived evidence cannot drift from the case — rename the block
 * type and the coverage moves with it.
 *
 * Some requirements leave no trace in a document: a keyboard contract, a
 * declared-theme file, an SSRF refusal. Those are declared in `meta.covers`,
 * which {@link loadCorpus} has already checked against `levels.json`.
 *
 * Coverage is only ever collected from a case that **passed**. A failing case
 * proves nothing, and a level substantiated by failures would be a lie told
 * with arithmetic. Neither does a case that passed by degrading: see
 * {@link stubbed}.
 */
import { unimplementedChartTypes } from '@mdv/charts';
import { detectFormat, facetWrapOf } from '@mdv/core';
import type {
  DatasetNode,
  ResolvedBlock,
  ResolvedDocument,
  TransformPipeline,
  TransformStep,
} from '@mdv/core';
import type { MdvNode } from '@mdv/parser';
import { isKnownRequirement } from '@mdv/spec';
import type { CaseMeta, CheckResult } from './types.js';

/** Everything the derivation looks at. */
export interface CoverageInput {
  readonly meta: CaseMeta;
  /** Absent when the case failed before resolving. */
  readonly document?: ResolvedDocument | undefined;
  /** The rendered SVG, when the case rendered one. */
  readonly svg?: string | undefined;
  readonly checks: readonly CheckResult[];
}

/**
 * The requirement ids one case exercises, sorted and deduplicated.
 *
 * Unknown ids are dropped rather than reported: a `type.` id for a plugin chart
 * type is not a corpus error, it is simply not a SPEC 16.1 requirement.
 */
export function coverageOf(input: CoverageInput): readonly string[] {
  const found = new Set<string>();
  const add = (id: string): void => {
    if (isKnownRequirement(id)) found.add(id);
  };

  for (const id of input.meta.covers) add(id);

  const doc = input.document;
  if (doc !== undefined) {
    addSyntax(doc, add);
    addData(doc, add);
    addBlocks(doc, add);
    addTheme(doc, add);
  }
  addRender(input, add);

  return [...found].sort();
}

// ─────────────────────────────────────────────────────────────────────────────
// Syntax (SPEC 5, SPEC 9)
// ─────────────────────────────────────────────────────────────────────────────

function addSyntax(doc: ResolvedDocument, add: (id: string) => void): void {
  if (doc.frontmatter !== undefined) add('syntax.frontmatter');

  let sawMarkdown = false;
  let sawBlock = false;
  let sawError = false;

  walk(doc.ast, (node) => {
    switch (node.type) {
      case 'mdvBlock':
        sawBlock = true;
        break;
      case 'mdvError':
        sawError = true;
        break;
      case 'mdvDirective': {
        const directive = node as { name?: unknown; kind?: unknown };
        const name = typeof directive.name === 'string' ? directive.name : '';
        // `syntax.directives` is SPEC 9.1, which is the *block* form; the
        // inline form is SPEC 9.2 and has its own requirement. An inline
        // `:mdv-metric[…]` must not substantiate the container syntax.
        if (directive.kind !== 'inline') add('syntax.directives');
        // The parser spells the sparkline `mdv-spark`, prefix and all — there
        // is no `sparkline` directive to match, and `math` and `include` are
        // not directives at all (`$…$` and a reserved block type).
        if (name === 'mdv-spark' && directive.kind === 'inline') add('syntax.inline-sparkline');
        break;
      }
      case 'root':
        break;
      default:
        // Ordinary CommonMark surviving beside the MDV constructs (SPEC 5).
        sawMarkdown = true;
    }
  });

  if (sawMarkdown) add('syntax.base');
  if (sawBlock) add('syntax.blocks');
  if (sawError) add('render.error-cards');

  // The cascade is only exercised when attributes arrive from more than one
  // level (SPEC 5.5); a lone block with attributes exercises no precedence.
  const attributed = doc.blocks.some((block) => Object.keys(block.attrs).length > 0);
  if (attributed && doc.frontmatter !== undefined) add('attrs.cascade');
}

// ─────────────────────────────────────────────────────────────────────────────
// Data (SPEC 6)
// ─────────────────────────────────────────────────────────────────────────────

function addData(doc: ResolvedDocument, add: (id: string) => void): void {
  const datasets = doc.datasets.list();
  const pipelines: TransformPipeline[] = [];

  for (const node of datasets) {
    const format = concreteFormat(node);
    if (format !== undefined) add(`data.${format}`);
    if (node.src !== undefined) add('data.external');
    if (node.transform !== undefined && node.transform.length > 0) {
      add('data.transforms');
      pipelines.push(node.transform);
    }
    if (node.origin === 'front-matter' || node.origin === 'block') add('data.datasets');
    if (inferred(node.table?.fields)) add('data.inference');
  }

  for (const block of doc.blocks) {
    if (inferred(block.table?.fields)) add('data.inference');
    const pipeline = block.attrs.transform;
    if (pipeline !== undefined && pipeline.length > 0) {
      add('data.transforms');
      pipelines.push(pipeline);
    }
    if (typeof block.attrs.src === 'string') add('data.external');
  }

  if (pipelines.some((pipeline) => pipeline.some(evaluatesExpression)) && !diagnosedMdvx(doc)) {
    add('data.mdvx');
  }
}

/**
 * Whether a step hands MDVX something to evaluate.
 *
 * Only `filter` and `derive` do. Every other step is named fields, numbers and
 * literals, and a field name is not an expression however much `revenue` looks
 * like one — `sort: [-revenue]` proves nothing about the language (SPEC 6.7).
 */
function evaluatesExpression(step: TransformStep): boolean {
  if ('filter' in step) return true;
  return 'derive' in step && Object.keys(step.derive).length > 0;
}

/**
 * Whether the document reported on an expression rather than evaluating one.
 *
 * Appendix C numbers the expression reports `MDV22xx`, at every severity: a
 * malformed expression, a type error that nulled a column, an unknown function.
 * `data.mdvx` is a claim that the language *ran*, so one of those anywhere in
 * the document withdraws it — a case is free to pin the diagnostics and prove
 * the reporting instead, which is what `data/mdvx/diagnostics` does.
 */
function diagnosedMdvx(doc: ResolvedDocument): boolean {
  return doc.diagnostics.some((diagnostic) => diagnostic.code.startsWith('MDV22'));
}

/**
 * The syntax a section actually used.
 *
 * `format:` records what the author wrote, which is usually nothing; SPEC 6.2.6
 * decides the rest, and it is asked rather than re-derived here.
 */
function concreteFormat(node: DatasetNode): string | undefined {
  if (node.format !== undefined && node.format !== 'auto') return node.format;
  if (node.raw === undefined || node.raw.trim() === '') return undefined;
  return detectFormat(node.raw);
}

function inferred(fields: readonly { readonly inferred?: boolean }[] | undefined): boolean {
  return fields !== undefined && fields.some((field) => field.inferred === true);
}

// ─────────────────────────────────────────────────────────────────────────────
// Blocks (SPEC 7, SPEC 8, SPEC 12)
// ─────────────────────────────────────────────────────────────────────────────

function addBlocks(doc: ResolvedDocument, add: (id: string) => void): void {
  for (const block of doc.blocks) {
    if (block.failed) {
      add('render.error-cards');
      continue;
    }
    if (!stubbed(block.blockType)) add(`type.${block.blockType}`);
    if (faceted(block)) add('layout.faceting');
    if (tableView(block)) add('a11y.table-view');
  }
}

/**
 * The spellings that resolve to a table-rendering stub (SPEC 15.2).
 *
 * Read off the stubs this build registers rather than written out again here:
 * the day `sankey` grows a real implementation its entry leaves
 * {@link unimplementedChartTypes}, and the requirement starts being credited
 * without anyone having to remember this file — which is exactly how
 * `type.histogram` began being credited when SPEC 8.7 landed, and
 * `type.ohlc` when SPEC 8.10 did.
 *
 * Aliases are flattened in because a block is spelled whichever way its author
 * wrote it, and each spelling is its own requirement: `type.candlestick` and
 * `type.ohlc` are two ids, so a stub reached through an alias must not credit
 * either. No stub carries an alias today; the flattening is what keeps that
 * from mattering when one does.
 */
const STUBBED: ReadonlySet<string> = new Set(
  unimplementedChartTypes.flatMap((type) => [type.name, ...(type.aliases ?? [])]),
);

/**
 * Whether a block of this type was drawn by a stub.
 *
 * A stub draws a table and says so with `MDV1500`. That is the *graceful
 * degradation* SPEC 15.2 asks for, and it is emphatically not the type: a case
 * whose `sankey` came out as a table has shown a table. Crediting
 * `type.sankey` for it would substantiate Level 2 with the very fallback that
 * exists because Level 2 is unimplemented — the precise over-claim the derived
 * coverage in this module is built to make impossible.
 */
function stubbed(blockType: string): boolean {
  return STUBBED.has(blockType);
}

/** A block facets when it binds `row:`/`column:`, or wraps a small multiple (SPEC 7.6). */
function faceted(block: ResolvedBlock): boolean {
  if (typeof block.attrs.row === 'string' && block.attrs.row !== '') return true;
  if (typeof block.attrs.column === 'string' && block.attrs.column !== '') return true;
  return facetWrapOf(block.attrs) !== undefined;
}

/**
 * `table:` asks for the tabular view of the same data (SPEC 12.3).
 *
 * `none` is the one value that does not: it suppresses the view and earns
 * `MDV3090` for it, which is an accessibility failure being recorded, not an
 * accessibility requirement being exercised.
 */
function tableView(block: ResolvedBlock): boolean {
  const attr = block.attrs.table;
  return attr !== undefined && attr !== 'none';
}

// ─────────────────────────────────────────────────────────────────────────────
// Themes (SPEC 11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A custom theme in force (SPEC 11.6).
 *
 * The requirement is the *override*: front matter's `theme:` map, with its
 * `extends` and its partial token set, resolved against the registered themes
 * and composed onto the base. A bare name is not it — `theme: dark` selects one
 * of the built-ins SPEC 11.1 already requires, and crediting that here would
 * let `theme.custom` be substantiated by a document that customised nothing.
 *
 * An override core cannot honour is reported as `MDV1502` and leaves the base
 * theme standing (SPEC 15.2: degrade, never fail), so a document that earned
 * one has shown the diagnostic rather than the theme. The check is
 * document-wide rather than per-key because `MDV1502` is the code both the
 * document-level and the per-block resolutions emit, and under-crediting a case
 * is the safe direction for a derivation the conformance claim rests on.
 */
function addTheme(doc: ResolvedDocument, add: (id: string) => void): void {
  const setting = doc.frontmatter?.theme;
  if (typeof setting !== 'object' || setting === null || Array.isArray(setting)) return;
  if (doc.diagnostics.some((diagnostic) => diagnostic.code === 'MDV1502')) return;
  add('theme.custom');
}

// ─────────────────────────────────────────────────────────────────────────────
// Output (SPEC 12, SPEC 22, SPEC 28)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the rendered artefacts prove.
 *
 * `theme.tokens` (SPEC 11.1) is claimed by the *dark* render, not the light
 * one. The light render is the default surface, so it is satisfied by a build
 * that hard-codes the light palette and never reads a token at all; only the
 * second render, of the same document under the other theme, can show that the
 * marks are painted *from* the token set. That is why the dark golden exists.
 *
 * A `dark` check that skipped therefore contributes nothing here: skipping is
 * how a case says it pinned no dark golden, and a requirement reached by a
 * check that did not run would be exactly the unsubstantiated claim the
 * coverage rule exists to prevent.
 */
function addRender(input: CoverageInput, add: (id: string) => void): void {
  if (passed(input.checks, 'render')) add('render.marks');
  if (passed(input.checks, 'dark')) add('theme.tokens');
  if (passed(input.checks, 'pdf')) add('export.pdf');

  const svg = input.svg;
  if (svg === undefined) return;

  if (/role="(?:img|figure)"/u.test(svg) && /aria-label(?:ledby)?="/u.test(svg)) {
    add('a11y.names');
  }
  if (drewErrorCard(svg)) add('render.error-cards');
}

/**
 * An error card in the output (SPEC 14.1).
 *
 * The two derivations upstream — an `mdvError` node, a `failed` block — both
 * read a document, and a document is too early: a block whose `y:` names a
 * column that is not there resolves cleanly and only collapses in layout, when
 * the chart type is finally asked to bind its channels. The card is the thing
 * SPEC 14.1 requires, so the card is what is looked for, in the one artefact
 * that is downstream of every way of producing one.
 *
 * Matched as a whole class *token* in a class *attribute*, because neither
 * half of that is pedantry: `mdv-error-card` also appears in the embedded
 * stylesheet, which every SVG carries whether it drew a card or not, and a
 * substring match would accept `mdv-error-card-shadow` — `\b` does not help,
 * since a hyphen is already a word boundary.
 */
function drewErrorCard(svg: string): boolean {
  for (const [, classes] of svg.matchAll(/class="([^"]*)"/gu)) {
    if (classes !== undefined && classes.split(/\s+/u).includes('mdv-error-card')) return true;
  }
  return false;
}

function passed(checks: readonly CheckResult[], name: CheckResult['check']): boolean {
  return checks.some((check) => check.check === name && check.status === 'pass');
}

// ─────────────────────────────────────────────────────────────────────────────
// Walking
// ─────────────────────────────────────────────────────────────────────────────

/** Depth-first over anything with `children`, including directive bodies. */
function walk(node: MdvNode, visit: (node: MdvNode) => void): void {
  visit(node);
  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) return;
  for (const child of children as readonly MdvNode[]) {
    if (typeof child === 'object' && child !== null) walk(child, visit);
  }
}

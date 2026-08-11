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
 * with arithmetic.
 */
import { detectFormat, facetWrapOf } from '@mdv/core';
import type { DatasetNode, ResolvedBlock, ResolvedDocument } from '@mdv/core';
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
        add('syntax.directives');
        const directive = node as { name?: unknown; kind?: unknown };
        const name = typeof directive.name === 'string' ? directive.name : '';
        if (name === 'sparkline' && directive.kind === 'inline') add('syntax.inline-sparkline');
        if (name === 'math') add('syntax.math');
        if (name === 'include') add('syntax.include');
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

  for (const node of datasets) {
    const format = concreteFormat(node);
    if (format !== undefined) add(`data.${format}`);
    if (node.src !== undefined) add('data.external');
    if (node.transform !== undefined && node.transform.length > 0) add('data.transforms');
    if (node.origin === 'front-matter' || node.origin === 'block') add('data.datasets');
    if (inferred(node.table?.fields)) add('data.inference');
  }

  for (const block of doc.blocks) {
    if (inferred(block.table?.fields)) add('data.inference');
    const pipeline = block.attrs.transform;
    if (pipeline !== undefined && pipeline.length > 0) add('data.transforms');
    if (typeof block.attrs.src === 'string') add('data.external');
  }
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
    add(`type.${block.blockType}`);
    if (faceted(block)) add('layout.faceting');
    if (tableView(block)) add('a11y.table-view');
  }
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
// Output (SPEC 12, SPEC 22, SPEC 28)
// ─────────────────────────────────────────────────────────────────────────────

function addRender(input: CoverageInput, add: (id: string) => void): void {
  if (passed(input.checks, 'render')) {
    add('render.marks');
    add('theme.tokens');
  }
  if (passed(input.checks, 'pdf')) add('export.pdf');

  const svg = input.svg;
  if (
    svg !== undefined &&
    /role="(?:img|figure)"/u.test(svg) &&
    /aria-label(?:ledby)?="/u.test(svg)
  ) {
    add('a11y.names');
  }
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

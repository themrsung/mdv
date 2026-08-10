/**
 * mdast → MDV AST.
 *
 * micromark gives back a standard CommonMark + GFM tree; this pass rewrites the
 * four places where MDV differs:
 *
 * 1. fenced code with the info string `mdv` becomes an {@link MdvBlock};
 * 2. directive openers, closers and inline runs become {@link MdvDirective};
 * 3. raw HTML becomes text unless the embedder enabled it (SPEC 4, `MDV4011`);
 * 4. an attribute line attached to a GFM table is lifted off the table body
 *    (SPEC 10.2).
 *
 * Directives are done here rather than in micromark because no directive
 * extension is available to this package, and because the container form has to
 * survive a closer that lands *inside* a paragraph — Appendix E's `mdv-callout`
 * is written with no blank lines, so its opener, body and closer are one
 * paragraph as far as CommonMark is concerned. Working on line ranges and
 * re-parsing the content as a sub-document handles that case and nesting with
 * the same code path, and every position is mapped back to the original
 * document (SPEC 14.4).
 */

import type { PhrasingContent, RootContent, Table, Text } from 'mdast';
import type { MdvContent, MdvDirective, Range } from '../types.js';
import { buildVisualBlock, isMdvInfoString } from './block.js';
import type { DiagnosticBag } from './diagnostics.js';
import {
  isContainerCloser,
  isKnownDirective,
  readDirective,
  readLineDirective,
  type DirectiveMatch,
} from './directives.js';
import { parseAttrBlock } from './inline-attrs.js';
import { runFromMarkdown } from './mdast.js';
import {
  containerStrip,
  makeSubSource,
  remapTree,
  type SourceIndex,
  type SubLine,
} from './source.js';

/** Everything the transform needs that is not in the tree. */
export interface TransformContext {
  readonly root: SourceIndex;
  readonly bag: DiagnosticBag;
  /** SPEC 4 / 13.4: raw HTML is disabled unless the embedder opts in. */
  readonly allowHtml: boolean;
  /** SPEC 9: directives are Level 2 and may be switched off. */
  readonly directives: boolean;
}

/** Node types whose children are flow content. */
const FLOW_PARENTS: ReadonlySet<string> = new Set([
  'root',
  'blockquote',
  'listItem',
  'footnoteDefinition',
]);

/** Rewrite a list of flow nodes into MDV content. */
export function transformFlow(
  children: readonly RootContent[],
  ctx: TransformContext,
): MdvContent[] {
  const out: MdvContent[] = [];
  let i = 0;
  while (i < children.length) {
    const child = children[i];
    if (child === undefined) {
      i += 1;
      continue;
    }
    const opener = ctx.directives ? flowDirectiveAt(child, ctx) : null;
    if (opener === null) {
      out.push(transformNode(child, ctx));
      i += 1;
      continue;
    }
    if (opener.match.kind === 'container') {
      i = consumeContainer(children, i, opener, ctx, out);
      continue;
    }
    out.push(
      makeDirective(opener.match, opener.contentStart, lineEndOffset(ctx, opener.line), ctx),
    );
    out.push(...reparseTail(child, opener.line, ctx));
    i += 1;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-node rewriting
// ─────────────────────────────────────────────────────────────────────────────

function transformNode(node: RootContent, ctx: TransformContext): MdvContent {
  switch (node.type) {
    case 'code': {
      if (!isMdvInfoString(node.lang)) return node;
      const position = node.position;
      if (position === undefined) return node;
      const start = position.start.offset;
      const end = position.end.offset;
      if (start === undefined || end === undefined) return node;
      return buildVisualBlock(ctx.root, ctx.bag, start, end);
    }
    case 'html':
      return escapeHtmlFlow(node, ctx);
    case 'table':
      return transformTable(node, ctx);
    default:
      break;
  }

  const children = (node as { children?: unknown }).children;
  if (!Array.isArray(children)) return node;

  if (FLOW_PARENTS.has(node.type) || node.type === 'list') {
    setChildren(node, transformFlow(children as RootContent[], ctx));
    return node;
  }
  setChildren(node, transformPhrasing(children as PhrasingContent[], ctx));
  return node;
}

/**
 * mdast's `BlockContent` union is closed: augmenting `RootContentMap` (which is
 * what the shared contract does) lets an `mdvBlock` be a child of the root, but
 * not of a blockquote or a list item. The nodes are structurally valid in both
 * places, so the assignment is made through one narrow helper rather than
 * widening the shared types unilaterally.
 */
function setChildren(node: unknown, children: readonly unknown[]): void {
  (node as { children: unknown[] }).children = children.slice();
}

/** SPEC 10.2: `{.mdv-table …}` on the line right after a GFM table. */
function transformTable(table: Table, ctx: TransformContext): MdvContent {
  const rows = table.children;
  const last = rows[rows.length - 1];
  if (rows.length > 1 && last !== undefined && last.children.length === 1) {
    const cell = last.children[0];
    const position = cell?.position;
    if (cell !== undefined && position !== undefined) {
      const start = position.start.offset;
      const end = position.end.offset;
      if (start !== undefined && end !== undefined) {
        const raw = ctx.root.text.slice(start, end).trim();
        if (raw.startsWith('{') && raw.endsWith('}')) {
          const open = ctx.root.text.indexOf('{', start);
          const block = open === -1 ? null : parseAttrBlock(ctx.root.text, open, 0, ctx.root);
          if (block !== null && block.ok) {
            rows.pop();
            shrinkTo(table, rows[rows.length - 1]);
            const data = (table.data ?? {}) as Record<string, unknown>;
            data['mdvAttrs'] = block.attrs;
            data['mdvAttrsPosition'] = block.positions;
            table.data = data;
          }
        }
      }
    }
  }
  for (const row of table.children) {
    for (const cell of row.children) {
      setChildren(cell, transformPhrasing(cell.children, ctx));
    }
  }
  return table;
}

/** Shrink a node's end position to another node's end. */
function shrinkTo(node: unknown, last: unknown): void {
  const target = node as { position?: { start: unknown; end: unknown } | undefined };
  const lastPosition = (last as { position?: { end: unknown } } | undefined)?.position;
  if (target.position === undefined || lastPosition === undefined) return;
  target.position = { start: target.position.start, end: lastPosition.end };
}

/** SPEC 4: HTML blocks are escaped and rendered as text unless enabled. */
function escapeHtmlFlow(node: RootContent & { value?: string }, ctx: TransformContext): MdvContent {
  if (ctx.allowHtml) return node;
  const position = node.position;
  if (position !== undefined) {
    ctx.bag.add('MDV4011', toRange(ctx, position), {
      detail: 'Enable and sanitise HTML in the embedder configuration to render it (SPEC 13.4).',
    });
  }
  const text: Text = {
    type: 'text',
    value: node.value ?? '',
    ...(position !== undefined ? { position } : {}),
  };
  return {
    type: 'paragraph',
    children: [text],
    ...(position !== undefined ? { position } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline directives
// ─────────────────────────────────────────────────────────────────────────────

function transformPhrasing(
  children: readonly PhrasingContent[],
  ctx: TransformContext,
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (const child of children) {
    if (child === undefined) continue;
    if (child.type === 'text' && ctx.directives) {
      const parts = splitInlineDirectives(child, ctx);
      if (parts !== null) {
        out.push(...parts);
        continue;
      }
      out.push(child);
      continue;
    }
    if (child.type === 'html') {
      out.push(escapeHtmlInline(child, ctx));
      continue;
    }
    const nested = (child as { children?: unknown }).children;
    if (Array.isArray(nested)) {
      setChildren(child, transformPhrasing(nested as PhrasingContent[], ctx));
    }
    out.push(child);
  }
  return absorbShortcutLabels(out, ctx);
}

function escapeHtmlInline(
  node: PhrasingContent & { value?: string },
  ctx: TransformContext,
): PhrasingContent {
  if (ctx.allowHtml) return node;
  const position = node.position;
  if (position !== undefined) {
    ctx.bag.add('MDV4011', toRange(ctx, position), {
      detail: 'Enable and sanitise HTML in the embedder configuration to render it (SPEC 13.4).',
    });
  }
  return {
    type: 'text',
    value: node.value ?? '',
    ...(position !== undefined ? { position } : {}),
  };
}

/**
 * Split a text node around any inline directives it contains, or return `null`
 * when it contains none.
 *
 * The scan runs over the **raw** source rather than `node.value`: micromark has
 * already resolved backslash escapes and character references, so the two
 * strings can have different lengths, and only raw offsets are meaningful in a
 * `Range`. {@link decodedToRaw} keeps the two coordinate systems aligned so the
 * surviving text nodes still carry decoded values.
 */
function splitInlineDirectives(node: Text, ctx: TransformContext): PhrasingContent[] | null {
  const position = node.position;
  if (position === undefined) return null;
  const start = position.start.offset;
  const end = position.end.offset;
  if (start === undefined || end === undefined) return null;

  const raw = ctx.root.text.slice(start, end);
  const matches: DirectiveMatch[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (raw.charCodeAt(i) !== 58 /* : */) continue;
    const match = readDirective(raw, i, start, ctx.root);
    if (match === null) continue;
    if (match.kind !== 'inline') continue;
    matches.push(match);
    i = match.end - 1;
  }
  if (matches.length === 0) return null;

  const map = decodedToRaw(raw, node.value);
  const out: PhrasingContent[] = [];
  let cursor = 0; // decoded index
  for (const match of matches) {
    const from = decodedIndex(map, match.start);
    const to = decodedIndex(map, match.end);
    if (from > cursor) {
      out.push(sliceText(node, ctx, map, cursor, from, start));
    }
    out.push(makeDirective(match, start + match.start, start + match.end, ctx));
    cursor = to;
  }
  if (cursor < node.value.length) {
    out.push(sliceText(node, ctx, map, cursor, node.value.length, start));
  }
  return out;
}

function sliceText(
  node: Text,
  ctx: TransformContext,
  map: readonly number[],
  from: number,
  to: number,
  base: number,
): Text {
  const rawFrom = map[from] ?? 0;
  const rawTo = map[to] ?? 0;
  return {
    type: 'text',
    value: node.value.slice(from, to),
    position: ctx.root.range(base + rawFrom, base + rawTo),
  };
}

/**
 * `:mdv-ref[fig-revenue]` where a matching link definition exists parses as a
 * directive with no label followed by a shortcut reference. Fold the reference
 * back into the label so the meaning does not depend on whether some unrelated
 * definition happens to be in the document.
 */
function absorbShortcutLabels(
  children: readonly PhrasingContent[],
  ctx: TransformContext,
): PhrasingContent[] {
  const out: PhrasingContent[] = [];
  for (let i = 0; i < children.length; i += 1) {
    const current = children[i];
    if (current === undefined) continue;
    const next = children[i + 1];
    if (
      current.type === 'mdvDirective' &&
      current.kind === 'inline' &&
      current.label === undefined &&
      next !== undefined &&
      next.type === 'linkReference' &&
      next.referenceType === 'shortcut'
    ) {
      const here = current.position?.end.offset;
      const there = next.position?.start.offset;
      const stop = next.position?.end.offset;
      if (here !== undefined && there === here && stop !== undefined) {
        const raw = ctx.root.text.slice(here, stop);
        if (raw.startsWith('[') && raw.endsWith(']')) {
          current.label = raw.slice(1, -1);
          current.position = ctx.root.range(current.position?.start.offset ?? here, stop);
          out.push(current);
          i += 1;
          continue;
        }
      }
    }
    out.push(current);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Container and leaf directives
// ─────────────────────────────────────────────────────────────────────────────

interface FlowDirective {
  readonly match: DirectiveMatch;
  /** 0-based line of the opener. */
  readonly line: number;
  /** Absolute offset of the first content character of that line. */
  readonly contentStart: number;
  /** 1-based column the opener starts at, for container-prefix stripping. */
  readonly column: number;
}

function flowDirectiveAt(node: RootContent, ctx: TransformContext): FlowDirective | null {
  if (node.type !== 'paragraph') return null;
  const position = node.position;
  if (position === undefined) return null;
  const start = position.start.offset;
  if (start === undefined) return null;
  const line = ctx.root.lineIndexAt(start);
  const text = ctx.root.text.slice(start, ctx.root.lineEnd(line));
  const match = readLineDirective(text, start, ctx.root);
  if (match === null || match.kind === 'inline') return null;
  return { match, line, contentStart: start, column: position.start.column };
}

function consumeContainer(
  children: readonly RootContent[],
  index: number,
  opener: FlowDirective,
  ctx: TransformContext,
  out: MdvContent[],
): number {
  const bound = lastLineOf(children[children.length - 1], ctx, opener.line);
  const protectedLines = collectProtected(children, index, ctx);

  let depth = 1;
  let closer = -1;
  for (let line = opener.line + 1; line <= bound; line += 1) {
    if (protectedLines.some(([from, to]) => line >= from && line <= to)) continue;
    const strip = containerStrip(ctx.root, line, opener.column);
    const text = ctx.root.lineText(line).slice(strip);
    if (isContainerCloser(text)) {
      depth -= 1;
      if (depth === 0) {
        closer = line;
        break;
      }
      continue;
    }
    const base = ctx.root.lineStart(line) + strip;
    const nested = readLineDirective(text, base, ctx.root);
    if (nested !== null && nested.kind === 'container') depth += 1;
  }

  const contentLast = closer === -1 ? bound : closer - 1;
  const content = parseFragment(subLines(ctx, opener.line + 1, contentLast, opener.column), ctx);
  const endOffset = closer === -1 ? lineEndOffset(ctx, bound) : lineEndOffset(ctx, closer);

  const node = makeDirective(opener.match, opener.contentStart, endOffset, ctx);
  node.children = content;
  out.push(node);

  // Every sibling that begins at or before the closer is now part of the
  // container; anything that sibling had *after* the closer is spliced back in.
  let consumed = index;
  const stopLine = closer === -1 ? bound : closer;
  while (consumed + 1 < children.length) {
    const next = children[consumed + 1];
    const startOffset = next?.position?.start.offset;
    if (startOffset === undefined) break;
    if (ctx.root.lineIndexAt(startOffset) > stopLine) break;
    consumed += 1;
  }
  const tailFrom = stopLine + 1;
  const tailTo = lastLineOf(children[consumed], ctx, stopLine);
  if (closer !== -1 && tailTo >= tailFrom) {
    out.push(...parseFragment(subLines(ctx, tailFrom, tailTo, opener.column), ctx));
  }
  return consumed + 1;
}

/** Line ranges that must not be searched for a closer: code and raw HTML. */
function collectProtected(
  children: readonly RootContent[],
  from: number,
  ctx: TransformContext,
): [number, number][] {
  const ranges: [number, number][] = [];
  const stack: unknown[] = [];
  for (let i = from; i < children.length; i += 1) stack.push(children[i]);
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    const typed = node as {
      type?: string;
      position?: { start: { offset?: number }; end: { offset?: number } };
      children?: unknown;
    };
    if (typed.type === 'code' || typed.type === 'html') {
      const start = typed.position?.start.offset;
      const end = typed.position?.end.offset;
      if (start !== undefined && end !== undefined) {
        ranges.push([ctx.root.lineIndexAt(start), ctx.root.lineIndexAt(Math.max(start, end - 1))]);
      }
    }
    if (Array.isArray(typed.children)) {
      for (const child of typed.children) stack.push(child);
    }
  }
  return ranges;
}

/** Re-parse the lines of `node` after `line`, for a directive that split it. */
function reparseTail(node: RootContent, line: number, ctx: TransformContext): MdvContent[] {
  const position = node.position;
  if (position === undefined) return [];
  const last = lastLineOf(node, ctx, line);
  if (last <= line) return [];
  return parseFragment(subLines(ctx, line + 1, last, position.start.column), ctx);
}

function subLines(ctx: TransformContext, from: number, to: number, column: number): SubLine[] {
  const lines: SubLine[] = [];
  for (let line = from; line <= to; line += 1) {
    lines.push({ line, strip: containerStrip(ctx.root, line, column) });
  }
  return lines;
}

/** Parse a selection of source lines as a document fragment (SPEC 14.4). */
function parseFragment(lines: readonly SubLine[], ctx: TransformContext): MdvContent[] {
  if (lines.length === 0) return [];
  const sub = makeSubSource(ctx.root, lines);
  if (sub.text.trim().length === 0) return [];
  const tree = runFromMarkdown(sub.text);
  remapTree(tree, sub);
  return transformFlow(tree.children, ctx);
}

function makeDirective(
  match: DirectiveMatch,
  startOffset: number,
  endOffset: number,
  ctx: TransformContext,
): MdvDirective {
  if (!isKnownDirective(match.name, match.kind)) {
    ctx.bag.add('MDV1503', ctx.root.range(startOffset, endOffset), {
      detail: `\`${match.name}\` is not a directive this version of MDV defines (SPEC 9).`,
    });
  }
  return {
    type: 'mdvDirective',
    kind: match.kind,
    name: match.name,
    attrs: match.attrs,
    attrsPosition: match.positions,
    ...(match.label !== null ? { label: match.label } : {}),
    position: ctx.root.range(startOffset, endOffset),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

function lineEndOffset(ctx: TransformContext, line: number): number {
  return ctx.root.lineEnd(line);
}

function lastLineOf(
  node: RootContent | undefined,
  ctx: TransformContext,
  fallback: number,
): number {
  const end = node?.position?.end.offset;
  if (end === undefined) return fallback;
  return ctx.root.lineIndexAt(Math.max(0, end - 1));
}

function toRange(
  ctx: TransformContext,
  position: { start: { offset?: number | undefined }; end: { offset?: number | undefined } },
): Range {
  const start = position.start.offset ?? 0;
  const end = position.end.offset ?? start;
  return ctx.root.range(start, end);
}

/**
 * Map every index of a decoded string back to its index in the raw source.
 *
 * micromark resolves `\(` and `&amp;` before it builds a `text` node, so the
 * node's value and the source slice it came from can differ in length. The scan
 * walks both in step: where they agree the mapping is one to one, and where they
 * diverge the raw side is a backslash escape or a character reference, which
 * always yields exactly one decoded code point (two code *units* for an
 * astral reference).
 */
export function decodedToRaw(raw: string, value: string): number[] {
  const map: number[] = new Array<number>(value.length + 1);
  if (raw === value) {
    for (let i = 0; i <= value.length; i += 1) map[i] = i;
    return map;
  }
  let i = 0;
  let k = 0;
  while (k < value.length && i < raw.length) {
    if (raw.charCodeAt(i) === value.charCodeAt(k)) {
      map[k] = i;
      i += 1;
      k += 1;
      continue;
    }
    const from = i;
    if (raw.charCodeAt(i) === 92 /* \ */) {
      i += 2;
    } else if (raw.charCodeAt(i) === 38 /* & */) {
      const semi = raw.indexOf(';', i);
      i = semi === -1 ? i + 1 : semi + 1;
    } else {
      i += 1;
    }
    map[k] = from;
    k += 1;
    const high = value.charCodeAt(k - 1);
    const low = value.charCodeAt(k);
    if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) {
      map[k] = from;
      k += 1;
    }
  }
  while (k <= value.length) {
    map[k] = raw.length;
    k += 1;
  }
  return map;
}

/** First decoded index whose raw offset is at or past `rawIndex`. */
function decodedIndex(map: readonly number[], rawIndex: number): number {
  for (let k = 0; k < map.length; k += 1) {
    const at = map[k];
    if (at !== undefined && at >= rawIndex) return k;
  }
  return map.length - 1;
}

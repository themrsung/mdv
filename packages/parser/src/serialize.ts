/**
 * MDV AST → MDV source (SPEC 19, 27).
 *
 * The contract is that `parse → toMarkdown → parse` produces the same document.
 * Two decisions follow from taking that seriously:
 *
 * - **A visual block re-emits `raw.header` and `raw.data` verbatim.** They are
 *   the source of truth for a block's body, and re-generating a header from
 *   `attrs` would silently drop comments, blank lines and the author's chosen
 *   quoting. The cost is that `attrOrder` does not reach inside a block header;
 *   the benefit is that `mdv fmt` cannot lose a byte of it.
 * - **Attributes written in the info string go back into the info string.**
 *   Which ones those are is recovered from `attrsPosition`: a key whose value
 *   sits on the block's first line was written there.
 *
 * Everything that is ordinary Markdown is handed to `mdast-util-to-markdown`,
 * with two extra `unsafe` patterns so that text which merely *looks* like a
 * directive is escaped rather than promoted on the next parse.
 *
 * Three {@link FormatOptions} fields are accepted and deliberately have no
 * effect here, rather than being silently half-honoured:
 *
 * - `indent` — header indentation. Headers are re-emitted verbatim (above), so
 *   there is nothing to re-indent. Only a header *rewriter* could honour it, and
 *   a rewriter cannot preserve comments.
 * - `insertTableDelimiter` — repairing `type: table` data needs the CSV/TSV
 *   reader, which is stage 2 (`@mdv/core`); the parser keeps `raw.data` as bytes.
 * - `lineWidth` — its documented default is `0` (no wrapping) and this
 *   serialiser never wraps prose, so the default is the only behaviour.
 */

import type { Nodes, Root } from 'mdast';
import { toMarkdown as mdastToMarkdown } from 'mdast-util-to-markdown';
import type { Options as ToMarkdownOptions, State } from 'mdast-util-to-markdown';
import { gfmToMarkdown } from 'mdast-util-gfm';
import { stringify as stringifyYaml } from 'yaml';
import { compareStrings } from './internal/source.js';
import { needsQuoting, quoteScalar } from './internal/scalar.js';
import type { FormatOptions } from './options.js';
import type {
  AttrMap,
  AttrRanges,
  AttrValue,
  FrontMatter,
  MdvBlock,
  MdvDirective,
  MdvDocument,
  MdvError,
} from './types.js';

/** Attributes an author expects to read first, before the alphabetical tail. */
const CANONICAL_FIRST = ['id', 'class', 'type', 'title', 'subtitle', 'desc'];

interface Resolved {
  readonly alignTables: boolean;
  readonly attrOrder: 'canonical' | 'alphabetical' | 'preserve';
  readonly bullet: '-' | '*' | '+';
  readonly fence: '`' | '~';
  readonly quote: '"' | "'";
}

/** Serialise a document. See {@link toMarkdown} in the package root. */
export function serializeDocument(doc: MdvDocument, options: FormatOptions = {}): string {
  const resolved: Resolved = {
    alignTables: options.alignTables ?? true,
    attrOrder: options.attrOrder ?? 'canonical',
    bullet: options.bullet ?? '-',
    fence: options.fence ?? '`',
    quote: options.quote ?? '"',
  };

  const tree: Root = { type: 'root', children: doc.children as Root['children'] };
  const body = mdastToMarkdown(tree as Nodes, buildOptions(resolved));
  const front = doc.frontmatter === undefined ? '' : serializeFrontMatter(doc.frontmatter);
  const out = front + body;
  return out.endsWith('\n') || out.length === 0 ? out : `${out}\n`;
}

/** A `mdast-util-to-markdown` node handler, in the shape this module needs it. */
type Handle = (node: unknown, parent: unknown, state: State, info: unknown) => string;

/**
 * Find a handler inside a nested extension bundle.
 *
 * `gfmToMarkdown()` is a bundle of five extensions; the table handler lives in
 * one of them. Wrapping it is the only way to append SPEC 10.2's attribute line
 * without re-implementing GFM table serialisation.
 */
function findHandler(extension: ToMarkdownOptions, type: string): Handle | null {
  const handlers = extension.handlers as Record<string, Handle> | undefined;
  const own = handlers?.[type];
  if (own !== undefined) return own;
  for (const nested of extension.extensions ?? []) {
    const found = findHandler(nested, type);
    if (found !== null) return found;
  }
  return null;
}

function buildOptions(resolved: Resolved): ToMarkdownOptions {
  const gfm = gfmToMarkdown({ tablePipeAlign: resolved.alignTables });
  const baseTable = findHandler(gfm, 'table');
  const handlers: Record<string, Handle> = {
    mdvBlock: (node: unknown) => blockHandler(node as MdvBlock, resolved),
    mdvDirective: (node: unknown, _parent: unknown, state: State, info: unknown) =>
      directiveHandler(node as MdvDirective, state, info, resolved),
    mdvError: (node: unknown) => (node as MdvError).raw,
  };
  if (baseTable !== null) {
    handlers['table'] = (node, parent, state, info) =>
      tableHandler(baseTable, node, parent, state, info, resolved);
  }

  return {
    bullet: resolved.bullet,
    fence: resolved.fence,
    rule: '-',
    emphasis: '*',
    strong: '*',
    // SPEC 27: `mdv fmt` must not rewrap prose, so no line width is applied.
    extensions: [
      gfm,
      {
        handlers: handlers as ToMarkdownOptions['handlers'],
        unsafe: [
          // `:mdv-…` in ordinary text would become a directive on re-parse.
          { character: ':', after: 'mdv-', inConstruct: 'phrasing' },
          // A line starting `::` would become a leaf or container directive.
          { atBreak: true, character: ':', after: ':' },
        ],
      },
    ],
  };
}

/**
 * SPEC 10.2: a GFM table's MDV attributes go back on the line immediately after
 * it — no blank line, or the next parse would not attach them.
 */
function tableHandler(
  base: Handle,
  node: unknown,
  parent: unknown,
  state: State,
  info: unknown,
  resolved: Resolved,
): string {
  const table = base(node, parent, state, info);
  const data = (node as { data?: Record<string, unknown> }).data;
  const attrs = data?.['mdvAttrs'];
  if (attrs === undefined || attrs === null || typeof attrs !== 'object') return table;
  const map = attrs as AttrMap;
  const keys = orderKeys(Object.keys(map), resolved);
  const block = emitAttrBlock(map, keys, resolved);
  return block === '' ? table : `${table}\n${block}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Visual blocks
// ─────────────────────────────────────────────────────────────────────────────

function blockHandler(node: MdvBlock, resolved: Resolved): string {
  // SPEC 19: a line the parser could not fully read is echoed, not rewritten.
  // `raw.info` is set only in that case, and rebuilding the info string from
  // the attributes would silently drop whatever the parser had to reject.
  const head = node.raw.info ?? canonicalHead(node, resolved);
  const fence = chooseFence(node, head, resolved);
  const header = node.raw.header;
  const data = node.raw.data;
  const separator = data === '' ? '' : '---\n';
  return `${fence}${head}\n${header}${separator}${data}${fence}`;
}

/** The info string rebuilt from the attributes that live on it (SPEC 27). */
function canonicalHead(node: MdvBlock, resolved: Resolved): string {
  const positions = node.attrsPosition;
  const line = node.position?.start.line;
  const onInfoLine = (key: string): boolean =>
    line !== undefined && positions[key]?.start.line === line;

  const infoKeys: string[] = [];
  for (const key of Object.keys(node.attrs)) {
    if (key === 'type') continue;
    if (onInfoLine(key)) infoKeys.push(key);
  }

  // The type is written in the info string unless the header claimed it.
  const typeInHeader = positions['type'] !== undefined && !onInfoLine('type');
  return (
    'mdv' +
    (node.blockType !== '' && !typeInHeader ? ` ${node.blockType}` : '') +
    emitInlineAttrs(node.attrs, orderKeys(infoKeys, resolved), resolved, false)
  );
}

/**
 * Pick a fence that cannot be broken by the block's own content: at least as
 * long as any run of the fence character at the start of a body line, and
 * tildes whenever the info string contains a backtick (SPEC 5.1).
 */
function chooseFence(node: MdvBlock, head: string, resolved: Resolved): string {
  const raw = node.raw.fence;
  const preferred = raw.length > 0 ? (raw[0] as string) : resolved.fence;
  const character = head.includes('`') ? '~' : preferred === '~' ? '~' : '`';
  let longest = 0;
  for (const body of [node.raw.header, node.raw.data]) {
    for (const bodyLine of body.split('\n')) {
      let run = 0;
      while (run < bodyLine.length && bodyLine[run] === character) run += 1;
      if (run > longest) longest = run;
    }
  }
  const length = Math.max(3, longest + 1, raw[0] === character ? raw.length : 0);
  return character.repeat(length);
}

// ─────────────────────────────────────────────────────────────────────────────
// Directives
// ─────────────────────────────────────────────────────────────────────────────

function directiveHandler(
  node: MdvDirective,
  state: State,
  info: unknown,
  resolved: Resolved,
): string {
  const colons = node.kind === 'inline' ? ':' : node.kind === 'leaf' ? '::' : ':::';
  const label = node.label === undefined ? '' : `[${escapeLabel(node.label)}]`;
  const keys = orderKeys(Object.keys(node.attrs), resolved);
  const head = `${colons}${node.name}${label}${emitAttrBlock(node.attrs, keys, resolved)}`;
  if (node.kind !== 'container') return head;

  const children = node.children;
  if (children === undefined || children.length === 0) return `${head}\n:::`;
  const parent = { type: 'root', children } as unknown as Parameters<State['containerFlow']>[0];
  const body = state.containerFlow(parent, info as Parameters<State['containerFlow']>[1]);
  return `${head}\n\n${body}\n\n:::`;
}

function escapeLabel(label: string): string {
  return label.replaceAll('\\', '\\\\').replaceAll(']', '\\]').replaceAll('\n', ' ');
}

/** `{#id .class key=value}` (Appendix A), or `''` when there is nothing to emit. */
function emitAttrBlock(attrs: AttrMap, keys: readonly string[], resolved: Resolved): string {
  const parts: string[] = [];
  keys.forEach((key, index) => {
    const value = attrs[key];
    if (value === undefined) return;
    if (key === 'id' && isIdent(value)) {
      parts.push(`#${value}`);
      return;
    }
    // `.a .b` always re-parses with `class` last, so the shorthand is only safe
    // when `class` is already the final key.
    if (key === 'class' && index === keys.length - 1 && isIdentList(value)) {
      for (const name of value.split(' ')) parts.push(`.${name}`);
      return;
    }
    parts.push(`${key}=${emitValue(value, resolved.quote)}`);
  });
  return parts.length === 0 ? '' : `{${parts.join(' ')}}`;
}

/** ` key=value …` for an info string (SPEC 5.2), leading space included. */
function emitInlineAttrs(
  attrs: AttrMap,
  keys: readonly string[],
  resolved: Resolved,
  braces: boolean,
): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = attrs[key];
    if (value === undefined) continue;
    parts.push(`${key}=${emitValue(value, resolved.quote)}`);
  }
  if (parts.length === 0) return '';
  return braces ? `{${parts.join(' ')}}` : ` ${parts.join(' ')}`;
}

function emitValue(value: AttrValue, quote: '"' | "'"): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return formatNumber(value);
  if (typeof value === 'string') {
    return needsQuoting(value) || /[\s'"{}]/.test(value) ? quoteScalar(value, quote) : value;
  }
  // Flow collections are not part of the one-line grammars; keep the value
  // legible rather than dropping it, and say so in the round-trip docs.
  return quoteScalar(JSON.stringify(value), quote);
}

function formatNumber(value: number): string {
  if (Number.isFinite(value)) return String(value);
  return quoteScalar(String(value));
}

function isIdent(value: AttrValue): value is string {
  return typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value);
}

function isIdentList(value: AttrValue): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.split(' ').every((name) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(name))
  );
}

/**
 * Order the attribute keys of one node (SPEC 27).
 *
 * `alphabetical` is not a synonym for `canonical`: the canonical order is a
 * fixed prefix *then* alphabetical, so the two differ for any node carrying one
 * of {@link CANONICAL_FIRST}. Both sorts are total — the comparator falls
 * through to `compareStrings`, which is the same code-unit ordering the rest of
 * the serialiser uses — so neither depends on `Array.prototype.sort` stability
 * or on the order the keys arrived in.
 */
function orderKeys(keys: readonly string[], resolved: Resolved): string[] {
  if (resolved.attrOrder === 'preserve') return keys.slice();
  if (resolved.attrOrder === 'alphabetical') return keys.slice().sort(compareStrings);
  const rank = (key: string): number => {
    const index = CANONICAL_FIRST.indexOf(key);
    return index === -1 ? CANONICAL_FIRST.length : index;
  };
  return keys.slice().sort((a, b) => rank(a) - rank(b) || compareStrings(a, b));
}

// ─────────────────────────────────────────────────────────────────────────────
// Front matter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rebuild the front matter block. Key order is recovered from `attrsPosition`
 * so that a formatted document keeps the author's ordering; keys with no
 * recorded position (a hand-built AST) follow, in insertion order.
 */
function serializeFrontMatter(frontmatter: FrontMatter): string {
  const values = collectFrontMatter(frontmatter);
  const ordered = orderByPosition(Object.keys(values), frontmatter.attrsPosition);
  const out: Record<string, AttrValue> = {};
  for (const key of ordered) {
    const value = values[key];
    if (value !== undefined) out[key] = value;
  }
  if (ordered.length === 0) return '---\n---\n\n';
  const body = stringifyYaml(out, { lineWidth: 0, nullStr: 'null' });
  return `---\n${body}---\n\n`;
}

function collectFrontMatter(frontmatter: FrontMatter): Record<string, AttrValue> {
  const values: Record<string, AttrValue> = {};
  const put = (key: string, value: AttrValue | undefined): void => {
    if (value !== undefined) values[key] = value;
  };
  put('mdv', frontmatter.mdv);
  put('title', frontmatter.title);
  put('subtitle', frontmatter.subtitle);
  put('author', frontmatter.author);
  put('date', frontmatter.date);
  put('lang', frontmatter.lang);
  put('theme', frontmatter.theme);
  put('locale', frontmatter.locale);
  put('timezone', frontmatter.timezone);
  put('defaults', frontmatter.defaults);
  put('datasets', frontmatter.datasets);
  put('pdf', frontmatter.pdf);
  put('security', frontmatter.security);
  put('plugins', frontmatter.plugins === undefined ? undefined : [...frontmatter.plugins]);
  put('toc', frontmatter.toc);
  put('numbering', frontmatter.numbering);
  for (const [key, value] of Object.entries(frontmatter.extra)) put(key, value);
  return values;
}

function orderByPosition(keys: readonly string[], positions: AttrRanges): string[] {
  const offset = (key: string): number => positions[key]?.start.offset ?? Number.MAX_SAFE_INTEGER;
  return keys
    .map((key, index) => ({ key, index, at: offset(key) }))
    .sort((a, b) => a.at - b.at || a.index - b.index)
    .map((entry) => entry.key);
}

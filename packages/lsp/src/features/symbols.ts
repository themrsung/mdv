/**
 * The outline: document symbols and folding (SPEC 29.4).
 *
 * Two requests, one model. `textDocument/documentSymbol` fills the outline view
 * and the breadcrumb bar; `textDocument/foldingRange` decides what a client can
 * collapse. Both answer the same question — where does each construct begin and
 * end — so both are computed from one tree built here, and a disagreement
 * between them is not possible by construction. It is the disagreement that
 * users notice: an outline entry that reveals a different span than the fold
 * with the same name feels broken long before anyone can say why.
 *
 * What SPEC 29.4 asks for:
 *
 * - **Document symbols** — headings, plus one symbol per visual block (`title`
 *   or `type` + index), so the outline and breadcrumbs show charts.
 * - **Folding** — front matter, sections, each visual block, and its data
 *   section independently.
 *
 * And nothing else. Lists, tables and block quotes fold in every client's own
 * markdown support already, and a server that also reports them makes the
 * client merge two sets of ranges that were computed by different rules.
 *
 * A **section** is a heading and everything under it up to the next heading of
 * the same or lower depth — the span an author means by "this section", not the
 * heading line. Trailing blank lines are left out of it, so collapsing a
 * section leaves the blank line that separated it from the next one instead of
 * swallowing the gap and butting two headings together.
 *
 * Headings are read from the top level of the document only. A heading inside a
 * block quote is quoted material — somebody else's document structure — and
 * hoisting it into this one's outline puts a section break in a place the author
 * cannot see. Visual blocks are found wherever they are, including inside a list
 * item or a quote, because the spec row says *every* visual block appears, and a
 * chart is worth navigating to wherever it sits.
 */

import { parse } from '@mdv/parser';
import type { MdvBlock, MdvDocument, UnistNode } from '@mdv/parser';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled, type CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import { SymbolKind } from '../protocol/types.js';
import type {
  DocumentSymbol,
  DocumentSymbolParams,
  FoldingRange,
  FoldingRangeParams,
  Position,
  Range,
  ServerCapabilities,
  SymbolKindValue,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';

/** Blocks sort below every heading depth, so they never open a section. */
const BLOCK_DEPTH = 7;

/** A heading with no text still needs a name, or the outline row is a blank. */
const EMPTY_HEADING = '(empty heading)';

/** A block whose info string never named a type (MDV1201) still gets numbered. */
const UNTYPED = 'mdv';

/**
 * One outline entry while it is still being built.
 *
 * `end` moves: a section does not know where it stops until the next heading
 * arrives, or the document does.
 */
interface Draft {
  readonly name: string;
  readonly detail: string | undefined;
  readonly kind: SymbolKindValue;
  readonly depth: number;
  readonly start: Position;
  end: Position;
  readonly selection: Range;
  /** Set for a visual block, which folds its data section separately. */
  readonly block: MdvBlock | undefined;
  readonly children: Draft[];
}

/**
 * The plain text of a heading, for its name in the outline.
 *
 * Markup is dropped rather than rendered: a breadcrumb showing `` `parse()` ``
 * with the backticks is noise, and one showing `<b>` is a lie about what the
 * heading says. An image contributes its alt text, which is the only text it
 * has, and an inline directive contributes its label for the same reason.
 */
function plainText(node: unknown): string {
  if (typeof node !== 'object' || node === null) return '';
  const typed = node as {
    readonly type?: unknown;
    readonly value?: unknown;
    readonly alt?: unknown;
    readonly label?: unknown;
    readonly children?: unknown;
  };
  switch (typed.type) {
    case 'text':
    case 'inlineCode':
      return typeof typed.value === 'string' ? typed.value : '';
    case 'image':
      return typeof typed.alt === 'string' ? typed.alt : '';
    case 'mdvDirective':
      return typeof typed.label === 'string' ? typed.label : '';
    // A hard break is a space once the line structure is gone.
    case 'break':
      return ' ';
    // Raw markup and the error card's preserved source are not names.
    case 'html':
    case 'mdvError':
      return '';
    default:
      return Array.isArray(typed.children) ? typed.children.map(plainText).join('') : '';
  }
}

/** Outline rows are one line high, so the name has to be too. */
function oneLine(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/**
 * What to call a visual block.
 *
 * `title` is the author's own name for it and always wins. Failing that the
 * block is numbered within its type — `bar 2` is the second bar chart in the
 * document, counting the titled ones, because an author looking for "the second
 * bar chart" counts the ones they can see.
 */
function blockName(block: MdvBlock, ordinal: number): { name: string; detail: string | undefined } {
  const type = block.blockType.length > 0 ? block.blockType : UNTYPED;
  const title = block.attrs['title'];
  if (typeof title === 'string' && oneLine(title).length > 0) {
    return { name: oneLine(title), detail: type };
  }
  return { name: `${type} ${ordinal}`, detail: undefined };
}

/** Every visual block in the document, in source order, wherever it is nested. */
function visualBlocks(document: MdvDocument): MdvBlock[] {
  const found: MdvBlock[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const typed = node as { readonly type?: unknown; readonly children?: unknown };
    if (typed.type === 'mdvBlock') found.push(node as MdvBlock);
    // A block inside a block is not a thing, but a block inside a list item
    // inside a quote is, so the walk does not stop at the first one it finds.
    if (Array.isArray(typed.children)) for (const child of typed.children) walk(child);
  };
  walk(document);
  found.sort((a, b) => startOf(a) - startOf(b));
  return found;
}

/**
 * A node's offsets, or 0 for a node that has none.
 *
 * Every node `@mdv/parser` produces is positioned, so the fallback is dead
 * code — but it is dead code that keeps a synthesised node out of the middle of
 * the outline rather than crashing the request that asked for it.
 */
function startOf(node: UnistNode): number {
  return node.position?.start.offset ?? 0;
}

function endOf(node: UnistNode): number {
  return node.position?.end.offset ?? 0;
}

/** The position just past the last character of a line, terminator excluded. */
function endOfLine(document: TextDocument, line: number): Position {
  return { line, character: document.lineText(line).length };
}

/**
 * Where a construct that ends at `offset` really ends.
 *
 * A node whose end offset is one past its terminator reports a position at
 * character 0 of the *next* line, which would fold a line that belongs to
 * whatever comes after it. Nothing in `@mdv/parser` does this today; a range
 * that quietly claims someone else's line is not worth the three lines it costs
 * to rule out.
 */
function lastPosition(document: TextDocument, offset: number, notBefore: number): Position {
  const position = document.positionAt(offset);
  if (position.character > 0 || position.line <= notBefore) return position;
  return endOfLine(document, position.line - 1);
}

/**
 * The last line of a section that runs up to `limit`, blank lines given back.
 *
 * Never earlier than `notBefore`, which is the heading's own line: a section
 * with nothing but blank lines in it still owns its heading.
 */
function lastContentLine(document: TextDocument, limit: number, notBefore: number): number {
  let line = Math.max(notBefore, document.positionAt(limit).line - 1);
  while (line > notBefore && document.lineText(line).trim().length === 0) line -= 1;
  return line;
}

/** Close a section at `limit`, keeping it wide enough to hold its children. */
function close(draft: Draft, document: TextDocument, limit: number): void {
  const line = lastContentLine(document, limit, draft.start.line);
  const end = endOfLine(document, line);
  // The containment rule is not advisory: a client given a child that pokes out
  // of its parent drops one of the two, and which one is anybody's guess.
  const last = draft.children.at(-1);
  draft.end = last !== undefined && before(end, last.end) ? last.end : end;
}

function before(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.character < b.character);
}

/**
 * Build the outline tree.
 *
 * One pass over headings and blocks together in source order: a heading closes
 * every open section at its own depth or deeper and opens its own; a block joins
 * whichever section is innermost at that point.
 */
function outline(document: TextDocument, parsed: MdvDocument): Draft[] {
  const roots: Draft[] = [];
  const open: Draft[] = [];
  const ordinals = new Map<string, number>();

  const add = (draft: Draft): void => {
    const parent = open.at(-1);
    if (parent === undefined) roots.push(draft);
    else parent.children.push(draft);
  };

  const items = [
    ...parsed.children
      .filter((child) => child.type === 'heading')
      .map((heading) => ({ heading, block: undefined, start: startOf(heading) })),
    ...visualBlocks(parsed).map((block) => ({ heading: undefined, block, start: startOf(block) })),
  ].sort((a, b) => a.start - b.start);

  for (const item of items) {
    const { heading, block, start } = item;
    if (block !== undefined) {
      const type = block.blockType.length > 0 ? block.blockType : UNTYPED;
      const ordinal = (ordinals.get(type) ?? 0) + 1;
      ordinals.set(type, ordinal);
      const { name, detail } = blockName(block, ordinal);
      const from = document.positionAt(start);
      const to = lastPosition(document, endOf(block), from.line);
      add({
        name,
        detail,
        kind: SymbolKind.object,
        depth: BLOCK_DEPTH,
        start: from,
        end: to,
        // Revealing a block reveals its fence line: the header is the part an
        // author edits, and jumping to the last row of a 400-row table is not
        // what "go to symbol" meant.
        selection: { start: from, end: endOfLine(document, from.line) },
        block,
        children: [],
      });
      continue;
    }
    if (heading === undefined) continue;

    const depth = typeof heading.depth === 'number' ? heading.depth : 1;
    for (let last = open.at(-1); last !== undefined && last.depth >= depth; last = open.at(-1)) {
      close(last, document, start);
      open.pop();
    }
    const from = document.positionAt(start);
    const to = lastPosition(document, endOf(heading), from.line);
    const name = oneLine(plainText(heading));
    const draft: Draft = {
      name: name.length > 0 ? name : EMPTY_HEADING,
      detail: undefined,
      // What VS Code's own markdown support uses for a heading, so the outline
      // icons match the ones next to every other `.md` file in the workspace.
      kind: SymbolKind.string,
      depth,
      start: from,
      end: to,
      selection: { start: from, end: to },
      block: undefined,
      children: [],
    };
    add(draft);
    open.push(draft);
  }

  // Innermost first, for the same reason the loop above pops before it closes:
  // a section is widened to hold its last child, and a child that has not been
  // closed yet still claims only its heading line.
  const end = document.text.length;
  for (const draft of open.reverse()) close(draft, document, end);
  return roots;
}

function toSymbol(draft: Draft): DocumentSymbol {
  const symbol: DocumentSymbol = {
    name: draft.name,
    kind: draft.kind,
    range: { start: draft.start, end: draft.end },
    selectionRange: draft.selection,
    ...(draft.detail === undefined ? {} : { detail: draft.detail }),
  };
  if (draft.children.length === 0) return symbol;
  return { ...symbol, children: draft.children.map(toSymbol) };
}

/**
 * Turn the tree into folding ranges, adding the two things that fold but are not
 * symbols: front matter, and a block's data section.
 *
 * Every range here is whole lines, which is all a client that set
 * `lineFoldingOnly` will accept and all any of these constructs need — so there
 * is no second code path for the clients that would take characters.
 */
function folds(
  document: TextDocument,
  parsed: MdvDocument,
  drafts: readonly Draft[],
  labels: boolean,
): FoldingRange[] {
  const ranges: FoldingRange[] = [];

  const push = (startLine: number, endLine: number, collapsed?: string): void => {
    // A one-line range hides nothing: the start line stays visible when a range
    // is collapsed, so `startLine === endLine` is a fold with no body.
    if (endLine <= startLine) return;
    ranges.push({
      startLine,
      endLine,
      ...(labels && collapsed !== undefined ? { collapsedText: collapsed } : {}),
    });
  };

  const front = parsed.frontmatter;
  if (front !== undefined) {
    const start = document.positionAt(front.range.start.offset).line;
    push(start, lastPosition(document, front.range.end.offset, start).line, front.title ?? '---');
  }

  const walk = (draft: Draft): void => {
    push(draft.start.line, draft.end.line, draft.name);
    const data = draft.block?.dataPosition;
    if (data !== undefined && data.start.offset < data.end.offset) {
      // The separator is the line above the first row — `@mdv/parser` puts the
      // data section's first row on the line after it, which is the one fact
      // about the separator a host is allowed to rely on. Folding from the
      // separator leaves `---` on screen, so a collapsed table still says that
      // it is a table.
      const first = document.positionAt(data.start.offset).line;
      const last = lastPosition(document, data.end.offset, first);
      push(first - 1, last.line, `--- ${last.line - first + 1} rows`);
    }
    for (const child of draft.children) walk(child);
  };
  for (const draft of drafts) walk(draft);

  ranges.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return ranges;
}

class Symbols {
  readonly #context: ServerContext;

  constructor(context: ServerContext) {
    this.#context = context;
  }

  listen(): void {
    this.#context.onRequest('textDocument/documentSymbol', (params, token) =>
      this.symbols(params as DocumentSymbolParams, token),
    );
    this.#context.onRequest('textDocument/foldingRange', (params, token) =>
      this.folding(params as FoldingRangeParams, token),
    );
  }

  /**
   * The document the request names, or the error LSP expects when it is gone.
   *
   * As everywhere else in this server, only open documents are answered for: an
   * outline read off the disk would be an outline of text the author is not
   * looking at.
   */
  #document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }

  /**
   * The outline is parsed per request rather than cached.
   *
   * A cache keyed by version is easy and would halve the parses, and it is also
   * the wrong place for one: diagnostics and formatting parse the same text
   * again anyway. When this costs enough to fix, the fix is one AST per document
   * version on the server context, not a private copy in this file that only
   * two of the four readers can see.
   */
  #parse(uri: string, token: CancellationToken): { document: TextDocument; parsed: MdvDocument } {
    const document = this.#document(uri);
    const parsed = parse(document.text);
    // The parse is the expensive half; a client that has already moved on
    // (another keystroke, another file) is told so before the tree is walked.
    throwIfCancelled(token);
    return { document, parsed };
  }

  /** `textDocument/documentSymbol`. */
  symbols(params: DocumentSymbolParams, token: CancellationToken): DocumentSymbol[] {
    const { document, parsed } = this.#parse(params.textDocument.uri, token);
    return outline(document, parsed).map(toSymbol);
  }

  /** `textDocument/foldingRange`. */
  folding(params: FoldingRangeParams, token: CancellationToken): FoldingRange[] {
    const { document, parsed } = this.#parse(params.textDocument.uri, token);
    const labels =
      this.#context.client().textDocument?.foldingRange?.foldingRange?.collapsedText === true;
    return folds(document, parsed, outline(document, parsed), labels);
  }
}

/**
 * Install document symbols and folding.
 *
 * ```ts
 * createServer(transport, { features: [symbols()] });
 * ```
 */
export function symbols(): Feature {
  return (context): Partial<ServerCapabilities> => {
    new Symbols(context).listen();
    return { documentSymbolProvider: true, foldingRangeProvider: true };
  };
}

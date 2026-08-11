/**
 * Semantic tokens (SPEC 29.4).
 *
 * The TextMate grammar in `apps/vscode` already colours an MDV block on sight:
 * it knows a fence from an attribute key, a quoted value from a bare one, and a
 * `@name` from the word beside it. What a regex cannot know is whether any of
 * those names *mean* anything — and that is the whole of this feature. SPEC 29.7
 * puts it exactly: semantic tokens "refine what the grammar can only guess at:
 * which identifiers are real column names, which references resolve."
 *
 * So one rule decides everything below: **a token is emitted only where MDV can
 * point at what the name means.**
 *
 * ```mdv bar
 * x: quarter          ← `quarter` is painted: the header declares it
 * y: turnover         ← nothing: no such column, and MDV says so in a diagnostic
 * data: "@sales"      ← `sales` is painted: a dataset in this document declares it
 * ---
 * quarter | revenue   ← both painted, as declarations
 * ```
 *
 * The colour an unpainted name keeps is the grammar's guess, which is the right
 * outcome: `y: turnover` still looks like a column reference, because that is
 * what the author was trying to write, and the squiggle under it is the thing
 * telling them it is not one yet. Going the other way — painting every candidate
 * — would make the editor agree with a mistake.
 *
 * Two token types, which is as many as there are kinds of name here. A column is
 * a `variable`, chosen over `property` or `parameter` because the grammar
 * already paints its guesses `variable.parameter.column.mdv`, so a theme that
 * distinguishes the two shows the refinement rather than repeating it. A dataset
 * id is a `namespace`: it is document-scoped and names a table the rest of the
 * document reads through it (SPEC 6.3). One modifier, `declaration`, marks the
 * header cell that introduces a column and the block or front-matter key that
 * introduces an id, so a theme can show a name's origin differently from its
 * uses. Nothing marks the *unresolved* case, because the unresolved case is
 * absence: there is no token to hang a modifier on.
 *
 * Attribute keys are not tokenised, even though the SPEC 29.4 row mentions them.
 * `MdvBlock` publishes `attrsPosition` — where each *value* is written — and no
 * key ranges; only front matter carries `attrsKeyPosition`. Finding a key would
 * mean scanning the header text for the identifier before the colon, which is
 * MDV block syntax reimplemented in the server, and SPEC 29.4 is explicit that
 * "the server is a thin adapter: it must contain no MDV semantics of its own".
 * The grammar matches keys by regex and there is nothing about a key to guess
 * at, so there is no refinement being given up.
 *
 * This is a parse and two locator calls, with no resolve. A client asks for
 * tokens on very nearly every keystroke, and none of what is painted depends on
 * a table: whether a name is a column is a question about the header row, and
 * whether an id resolves is a question about the ids the document declares.
 * Resolving would buy the same answer at the price of running every transform
 * between two characters being typed.
 */

import { locateColumns, locateDatasets, locateHeader, visualBlocks } from '@mdv/core';
import type { ColumnSite, DatasetSite } from '@mdv/core';
import { parse } from '@mdv/parser';
import type { MdvBlock, MdvDocument } from '@mdv/parser';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type {
  Range,
  SemanticTokens,
  SemanticTokensParams,
  ServerCapabilities,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { exactColumnRange } from './column.js';
import { exactRange } from './dataset.js';

/**
 * The legend's `tokenTypes`, published in the capability and indexed into by
 * every token this server sends.
 *
 * Both are standard LSP types. A client that has never heard of MDV maps them
 * onto its own theme without being told anything, which a custom type would not
 * get, and neither name is a lie: a dataset id really is a namespace over the
 * document's tables, and a column name really is bound to a value per row.
 */
export const TOKEN_TYPES = ['namespace', 'variable'] as const;

/** The legend's `tokenModifiers`. See the note on `declaration` above. */
export const TOKEN_MODIFIERS = ['declaration'] as const;

/** Indices into {@link TOKEN_TYPES}, which is what goes on the wire. */
const NAMESPACE = TOKEN_TYPES.indexOf('namespace');
const VARIABLE = TOKEN_TYPES.indexOf('variable');

/** A bitset over {@link TOKEN_MODIFIERS}: bit 0 is `declaration`. */
const DECLARATION = 1 << TOKEN_MODIFIERS.indexOf('declaration');
const NO_MODIFIER = 0;

/** One token, before the deltas: absolute, and easier to sort than to decode. */
interface Token {
  readonly line: number;
  readonly start: number;
  readonly length: number;
  readonly type: number;
  readonly modifiers: number;
}

class Tokens {
  readonly #context: ServerContext;

  constructor(context: ServerContext) {
    this.#context = context;
  }

  listen(): void {
    this.#context.onRequest('textDocument/semanticTokens/full', (params, token) =>
      this.#tokens(params as SemanticTokensParams, token),
    );
  }

  /** `textDocument/semanticTokens/full`: every token in the document. */
  #tokens(params: SemanticTokensParams, token: CancellationToken): SemanticTokens {
    const document = this.#document(params.textDocument.uri);
    const parsed = parse(document.text);
    // The parse is the whole cost; a client that has moved on is told here.
    throwIfCancelled(token);

    const found = [...columnTokens(document, parsed, token), ...datasetTokens(document, parsed)];
    // No `resultId`: this server does not answer `semanticTokens/full/delta`,
    // and an id offered without one is an invitation a client would take.
    return { data: encode(found) };
  }

  /** As everywhere else here, only an open document is answered for. */
  #document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }
}

/** Every column name, block by block; names are block-scoped (SPEC 29.4). */
function* columnTokens(
  document: TextDocument,
  doc: MdvDocument,
  token: CancellationToken,
): Generator<Token> {
  for (const node of visualBlocks(doc)) {
    throwIfCancelled(token);
    yield* blockColumns(document, node);
  }
}

/**
 * One block's columns: the header row, then the uses of it.
 *
 * The two come from different locators on purpose. `locateHeader` says which
 * characters of the header row spell a name, and every one of them declares a
 * column by definition — including in a `dataset` block, whose header is the
 * one thing about it the whole document reads. `locateColumns` is the stricter
 * question: which *other* text in the block names one of those columns. It
 * declines for a block carrying an `id`, and it drops a name written in two
 * header cells, because neither is safe to rewrite. Both refusals are about
 * editing rather than painting, and this feature only borrows the part of the
 * answer that is about meaning — so the repeated header cells still light up as
 * the columns they are, and the block with an `id` keeps its header while its
 * attributes fall back to the grammar's guess.
 */
function* blockColumns(document: TextDocument, node: MdvBlock): Generator<Token> {
  const header = locateHeader(node);
  for (const cell of header?.cells ?? []) {
    // An empty cell names nothing; `| |` is a delimiter with a gap in it.
    if (cell.name === '') continue;
    const found = columnToken(document, cell, DECLARATION);
    if (found !== undefined) yield found;
  }

  const map = locateColumns(node);
  if (map === undefined) return;
  for (const column of map.columns) {
    for (const site of column.sites) {
      // Already yielded above, out of the locator that sees every cell.
      if (site.kind === 'header') continue;
      const found = columnToken(document, site, NO_MODIFIER);
      if (found !== undefined) yield found;
    }
  }
}

function columnToken(
  document: TextDocument,
  site: ColumnSite,
  modifiers: number,
): Token | undefined {
  return tokenAt(exactColumnRange(document, site), VARIABLE, modifiers);
}

/**
 * Every dataset id that resolves, declaration and references alike.
 *
 * A reference to an id nothing declares gets no token — that is SPEC 29.7's
 * "which references resolve", and it is decided by the same document-scoped id
 * equality that go-to-definition jumps with (SPEC 6.3), so a `@sales` this
 * paints is a `@sales` that jump lands on. Front-matter datasets and dataset
 * blocks share the one namespace, so a declaration in either satisfies a
 * reference in the other, and there is no workspace scan here.
 */
function* datasetTokens(document: TextDocument, doc: MdvDocument): Generator<Token> {
  const sites = locateDatasets(doc);
  const declared = new Set<string>();
  for (const site of sites) {
    if (site.kind === 'declaration') declared.add(site.id);
  }

  for (const site of sites) {
    if (!declared.has(site.id)) continue;
    const found = datasetToken(document, site);
    if (found !== undefined) yield found;
  }
}

function datasetToken(document: TextDocument, site: DatasetSite): Token | undefined {
  const modifiers = site.kind === 'declaration' ? DECLARATION : NO_MODIFIER;
  // `exactRange` and not `idRange`: the fallback covers `"@sales[date]"` whole,
  // and painting the quotes and the projection as the id would be a worse
  // answer than leaving the grammar's.
  return tokenAt(exactRange(document, site), NAMESPACE, modifiers);
}

/**
 * A range as the wire format can carry it, or nothing.
 *
 * A token is a length on one line — there is no way to spell a second line in
 * five integers — and a client given a length that ran off the end would paint
 * whatever followed. A name cannot legitimately straddle a newline in MDV, so a
 * range that does is a range something has already gone wrong with, and it is
 * dropped rather than truncated into a plausible-looking lie.
 */
function tokenAt(range: Range | undefined, type: number, modifiers: number): Token | undefined {
  if (range === undefined) return undefined;
  if (range.start.line !== range.end.line) return undefined;
  const length = range.end.character - range.start.character;
  if (length <= 0) return undefined;
  return { line: range.start.line, start: range.start.character, length, type, modifiers };
}

/**
 * The five-integers-per-token wire format: line delta, start delta, length,
 * type, modifiers.
 *
 * Sorted here rather than by construction, because the tokens arrive in two
 * passes over the document and the deltas are only decodable in document order.
 * Overlaps are dropped for the same class of reason `tokenAt` drops a multi-line
 * range: a client that receives two tokens over the same characters is entitled
 * to render either, so an overlap is a coin toss rather than a colour. They are
 * reachable — `locateDatasets` warns that a document with no key range on a
 * front-matter dataset falls back to the value, and then a declaration site
 * contains the references written under it — and the wider site sorts first, so
 * keeping the earlier one keeps the one that was found the more directly.
 */
function encode(tokens: readonly Token[]): number[] {
  const sorted = [...tokens].sort(
    (left, right) => left.line - right.line || left.start - right.start,
  );

  const data: number[] = [];
  let line = 0;
  let character = 0;
  let previous: Token | undefined;

  for (const token of sorted) {
    if (previous !== undefined && token.line === previous.line) {
      if (token.start < previous.start + previous.length) continue;
    }
    const deltaLine = token.line - line;
    const deltaStart = deltaLine === 0 ? token.start - character : token.start;
    data.push(deltaLine, deltaStart, token.length, token.type, token.modifiers);
    line = token.line;
    character = token.start;
    previous = token;
  }
  return data;
}

/**
 * Install semantic tokens for column names and dataset ids.
 *
 * ```ts
 * createServer(transport, { features: [semanticTokens()] });
 * ```
 */
export function semanticTokens(): Feature {
  return (context): Partial<ServerCapabilities> => {
    new Tokens(context).listen();
    return {
      semanticTokensProvider: {
        legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: [...TOKEN_MODIFIERS] },
        // Whole-document only. A range request would re-parse for a slice of
        // the answer it already computes, and delta needs a `resultId` and a
        // cache of what was last sent, which is a lot of state for a document
        // small enough to fit in an editor window.
        full: true,
      },
    };
  };
}

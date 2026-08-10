/**
 * Signature help (SPEC 29.4).
 *
 * A tool that answers questions about a half-written call — signature help, a
 * CLI `--explain` — needs two facts that nothing else in this package has:
 *
 * - **Which attribute values are expressions at all**, and which offset inside
 *   the document an expression starts at. `filter` and `derive` are expressions
 *   and `sort` is a field name, and that is the parser's business, not this
 *   server's: `expressionAt` says it.
 * - **Where the cursor is inside one**: which callee it is under, and which
 *   argument of it. Half-typed source never parses, so the reading is a
 *   character scan and `callAt` owns it.
 *
 * Both live in `@mdv/core`, so the rules that decide what a call is are the
 * evaluator's own and cannot drift from it. The names and their parameters come
 * from `@mdv/spec`'s published signature table, which `packages/core/test`
 * pins against the evaluator's whitelist. What is left here is the translation:
 * document offsets to expression offsets, and a signature to a `SignatureHelp`.
 *
 * The one thing this file must get right on its own is the offset arithmetic.
 * `attrsPosition` records the value as it is *written* — with its quotes — and
 * the parser keeps the expression as it is *meant*, without them, so the two
 * are the same characters at a shift. Point at the wrong argument and the
 * author is told about the wrong parameter, which is worse than silence.
 */

import { callAt, expressionAt } from '@mdv/core';
import type { CallSite } from '@mdv/core';
import { lookupSignature, renderSignature } from '@mdv/spec';
import type { FunctionSignature, SignatureParam } from '@mdv/spec';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { MarkupKind } from '../protocol/types.js';
import type {
  MarkupContent,
  ParameterInformation,
  Position,
  Range,
  ServerCapabilities,
  SignatureHelp,
  TextDocumentPositionParams,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { Sites, valueAt } from './site.js';
import type { BlockSettings, Site } from './site.js';

/**
 * Named against the grain of `DiagnosticsOptions` and `FormatterOptions`: the
 * protocol's own `SignatureHelpOptions` is the shape that goes in
 * `ServerCapabilities`.
 */
export type SignatureSettings = BlockSettings;

/**
 * The two characters that ask the question: opening a call, and finishing an
 * argument. Everything else re-asks it only because the client already had help
 * open, which is the client's decision and not ours to trigger.
 */
const TRIGGER_CHARACTERS: readonly string[] = ['(', ','];

class Signatures {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: SignatureSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Signature help');
  }

  listen(): void {
    this.#context.onRequest('textDocument/signatureHelp', (params, token) =>
      this.#help(params as TextDocumentPositionParams, token),
    );
  }

  /** `undefined` is the answer to every cursor that is not inside a known call. */
  #help(params: TextDocumentPositionParams, token: CancellationToken): SignatureHelp | undefined {
    const document = this.#sites.document(params.textDocument.uri);
    const site = this.#sites.at(document, params.position, token);
    if (site === undefined) return undefined;
    throwIfCancelled(token);

    const call = callUnder(site, document, params.position);
    if (call === undefined) return undefined;
    // A name that is not on the SPEC 6.8.2 whitelist is `MDV2220`, which the
    // author is already being told by the diagnostic. Inventing a shape for it
    // here would describe a call that cannot run.
    const signature = lookupSignature(call.name);
    if (signature === undefined) return undefined;
    return helpFor(signature, call.argument);
  }
}

/**
 * The call the cursor is inside, or `undefined` when it is not in one.
 *
 * Four narrowings, each of which is allowed to fail: the cursor is in the
 * header (below the separator the author is writing data, and their words are
 * their own), it is inside a recorded value, that value is an expression, and
 * the offset within it stands inside a call.
 */
function callUnder(site: Site, document: TextDocument, position: Position): CallSite | undefined {
  if (position.line > site.lastHeaderLine) return undefined;
  const value = valueAt(site.block, document, anchor(document, position));
  if (value === undefined) return undefined;

  const source = expressionAt(site.block.node.attrs, value.key);
  if (source === undefined) return undefined;

  // Where the expression begins inside the value as written: past the opening
  // quote, or past a block scalar's header and indent. Searching for it keeps
  // this ignorant of which of those it is. A value YAML *rewrote* rather than
  // trimmed — one with an escape in it, or a folded scalar whose newlines
  // became spaces — is not found, and gets silence: there is no offset in it
  // that can be trusted, and pointing at the wrong argument is worse than
  // pointing at none.
  const shift = read(document, value.range).indexOf(source);
  if (shift === -1) return undefined;

  const start = document.offsetAt(value.range.start) + shift;
  // `callAt` clamps, so the cursor sitting one past the end of what YAML kept —
  // the trailing space after a comma — reads as the end of the expression.
  return callAt(source, document.offsetAt(position) - start);
}

/**
 * The cursor, moved back over the blanks it trails.
 *
 * `attrsPosition` records the value as YAML kept it, and YAML drops the space
 * after a comma. Typing `,` and then a space — how the next argument gets
 * written, and one of the two characters that trigger this request — leaves the
 * cursor past the end of every recorded range, where there is no value to be
 * inside of. Trailing blanks are never part of a call, so stepping back over
 * them changes no answer except that one, and a newline stops the walk: the
 * question is about this line.
 */
function anchor(document: TextDocument, position: Position): Position {
  const text = document.text;
  let offset = document.offsetAt(position);
  while (offset > 0 && (text[offset - 1] === ' ' || text[offset - 1] === '\t')) offset -= 1;
  return document.positionAt(offset);
}

/** The source text a range covers. */
function read(document: TextDocument, range: Range): string {
  return document.text.slice(document.offsetAt(range.start), document.offsetAt(range.end));
}

/** One signature, because a whitelisted name has exactly one (SPEC 6.8.2). */
function helpFor(signature: FunctionSignature, argument: number): SignatureHelp {
  const label = renderSignature(signature);
  const labels = parameterLabels(label);
  return {
    signatures: [
      {
        label,
        documentation: markup(summaryOf(signature)),
        parameters: signature.params.map((param, index) => parameter(param, labels[index])),
      },
    ],
    activeSignature: 0,
    activeParameter: activeParameter(signature, argument),
  };
}

/**
 * The parameter labels, taken back out of the signature `@mdv/spec` rendered.
 *
 * A client highlights a parameter by finding its label inside the signature
 * label, so the two must agree to the character — and the rules that put a `…`
 * on a variadic tail and a `?` on an optional one belong to the package that
 * publishes the table. Splitting what it rendered is how this adapter gets
 * those rules without keeping a second copy of them that could be right today
 * and wrong after a spec revision.
 */
function parameterLabels(label: string): readonly string[] {
  const open = label.indexOf('(');
  const close = label.lastIndexOf(')');
  if (open === -1 || close < open) return [];
  const inner = label.slice(open + 1, close);
  return inner === '' ? [] : inner.split(', ');
}

/** A parameter, labelled as the signature prints it and documented as SPEC 6.8.2 has it. */
function parameter(param: SignatureParam, label: string | undefined): ParameterInformation {
  const text = label ?? param.name;
  return param.summary === undefined
    ? { label: text }
    : { label: text, documentation: markup(param.summary) };
}

/**
 * What the function means, plus the one thing a call site cannot show: `count`
 * and `mean` are legal only where a group is being aggregated (SPEC 6.8.2), and
 * a signature is exactly where an author is about to need to know that.
 */
function summaryOf(signature: FunctionSignature): string {
  return signature.aggregateOnly === true
    ? `${signature.summary} (aggregate only)`
    : signature.summary;
}

/**
 * Which parameter to highlight for the argument the cursor is in.
 *
 * A `rest` parameter is last and takes every argument from its position on
 * (SPEC 6.8.2), so the cursor in the fourth argument of `coalesce` is still in
 * `value…`. An argument past a fixed list is one the function does not have —
 * `MDV2201`, already reported — and the index is passed through out of range so
 * that the client highlights nothing, which is what is true of it.
 */
function activeParameter(signature: FunctionSignature, argument: number): number {
  const rest = signature.params.findIndex((param) => param.rest === true);
  return rest !== -1 && argument > rest ? rest : argument;
}

/**
 * A summary is one line of prose with nothing in it to mark up, so it is sent
 * as plain text and there is no client capability to negotiate — the same call
 * `completion` makes for the same reason.
 */
function markup(value: string): MarkupContent {
  return { kind: MarkupKind.plainText, value };
}

/**
 * Install signature help.
 *
 * ```ts
 * createServer(transport, { features: [signature({ config })] });
 * ```
 */
export function signature(options: SignatureSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Signatures(context, options);
    feature.listen();
    return { signatureHelpProvider: { triggerCharacters: TRIGGER_CHARACTERS } };
  };
}

/**
 * Where the cursor is (SPEC 29.4).
 *
 * Completion and hover ask the same question before either can say anything:
 * *which block is the cursor in, what type is that block, and which of the
 * block's three parts is this line?*
 *
 * ```mdv bar        ← fenceLine — the info string, whose only word is a type
 * x: quarter        ← header — keys and their values, down to lastHeaderLine
 * ---
 * Q1 | 100          ← data — the author's own words, and none of our business
 * ```
 *
 * Answering it means resolving the document, which is the pipeline the
 * `diagnostics` feature runs and the pipeline the renderer runs: a chart type
 * exists here only because a configured plugin registered it, and a block's
 * columns are the ones stage 4 actually read. Nothing in this file knows any
 * MDV key by name — it locates words, and leaves what they mean to the caller.
 */

import { registryFromPlugins, resolveSync } from '@mdv/core';
import type { ChartType, ChartTypeRegistry, MdvConfig, ResolvedBlock } from '@mdv/core';
import { parse } from '@mdv/parser';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type { Position, Range } from '../protocol/types.js';
import type { ServerContext } from '../server.js';

/** A trailing `[0]`, so `y[0]` is read the way `y` is. */
export const INDEX_SUFFIX = /\[\d+\]$/u;

/** A key, or as much of one as the author has typed. */
export const KEY_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/**
 * What a position feature needs from its host.
 *
 * Named against the grain of `DiagnosticsOptions` and `FormatterOptions`,
 * because the protocol's own `CompletionOptions` and `HoverOptions` are the
 * shapes that go in `ServerCapabilities` and both names are already taken.
 */
export interface BlockSettings {
  /**
   * The configuration whose plugins decide which chart types exist, or a
   * function of the document for a host that scopes config per workspace
   * folder — the same shape {@link DiagnosticsOptions.config} takes, so a host
   * can pass one value to every feature it installs.
   */
  readonly config?: MdvConfig | ((document: TextDocument) => MdvConfig | undefined);
}

/**
 * The host's configuration for a document, minus its diagnostic sink.
 *
 * Every feature but `diagnostics` runs the pipeline to answer a request, and
 * that run produces the same diagnostics `diagnostics` already reported. A sink
 * that heard them twice would have no way to tell which run it was listening
 * to, so it hears neither: the sink comes off before any of them runs. Shared
 * from here because a feature that forgot would corrupt a host's problem list,
 * and the mistake is invisible in that feature's own tests.
 */
export function configFor(
  config: BlockSettings['config'],
  document: TextDocument,
): MdvConfig | undefined {
  const resolved = typeof config === 'function' ? config(document) : config;
  if (resolved?.onDiagnostic === undefined) return resolved;
  const { onDiagnostic: _sink, ...rest } = resolved;
  return rest;
}

/** Where the cursor sits in a block, which is the whole question. */
export interface Site {
  readonly block: ResolvedBlock;
  /** Every type the configuration registered; the fence line completes from it. */
  readonly registry: ChartTypeRegistry;
  /** This block's type, or `undefined` when the info string names none of them. */
  readonly chartType: ChartType | undefined;
  /** Line of the opening fence. */
  readonly fenceLine: number;
  /** Last line that is still header; below it lies data or the closing fence. */
  readonly lastHeaderLine: number;
}

/**
 * The document-to-block half of a position feature, shared so that completion
 * and hover cannot disagree about what the cursor is in.
 */
export class Sites {
  readonly #context: ServerContext;
  readonly #options: BlockSettings;
  /** Capitalised feature name; it appears in log lines and nowhere else. */
  readonly #feature: string;

  constructor(context: ServerContext, options: BlockSettings, feature: string) {
    this.#context = context;
    this.#options = options;
    this.#feature = feature;
  }

  /** The open document, or the error LSP has for a request about a closed one. */
  document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }

  /**
   * Resolve the document and find the block the cursor is inside, if any.
   *
   * Computed from scratch on every keystroke. A block is small and the parse is
   * already the cost of a diagnostics run, so a cache would buy back less than
   * the staleness it would cost — and a stale answer is worse than a slow one,
   * because the author acts on it.
   *
   * The token is checked once the registry is built and before the document is
   * parsed, which is where the work is.
   */
  at(document: TextDocument, position: Position, token: CancellationToken): Site | undefined {
    const config = this.#configFor(document);
    const registry = this.#registry(config);
    if (registry === undefined) return undefined;
    throwIfCancelled(token);

    const offset = document.offsetAt(position);
    let block: ResolvedBlock | undefined;
    try {
      const resolved = resolveSync(parse(document.text), config);
      block = resolved.blocks.find(
        (candidate) =>
          candidate.range.start.offset <= offset && offset <= candidate.range.end.offset,
      );
    } catch (error) {
      this.#context.logger.error(
        `${this.#feature} could not read ${document.uri}: ${reasonOf(error)}`,
      );
      return undefined;
    }
    if (block === undefined) return undefined;

    const fenceLine = document.positionAt(block.range.start.offset).line;
    const dataStart = block.node.dataPosition?.start.offset;
    // With a separator, the data starts on the line below it — and when the
    // separator is the last line, on the separator itself. Either way the line
    // above the data is the last one a key can be written on, and a separator
    // that may still be sitting there is the caller's to recognise.
    const lastHeaderLine =
      (dataStart === undefined
        ? document.positionAt(block.range.end.offset).line
        : document.positionAt(dataStart).line) - 1;

    return { block, registry, chartType: registry.get(block.blockType), fenceLine, lastHeaderLine };
  }

  #configFor(document: TextDocument): MdvConfig | undefined {
    return configFor(this.#options.config, document);
  }

  /**
   * `registryFromPlugins` throws `MdvConfigError` for a malformed plugin — host
   * programmer error, already reported by every other feature. A keystroke is
   * not the place to learn it, so it is logged once and the author gets nothing
   * back rather than a broken server.
   */
  #registry(config: MdvConfig | undefined): ChartTypeRegistry | undefined {
    try {
      return registryFromPlugins(config);
    } catch (error) {
      this.#context.logger.error(`${this.#feature} has no registry: ${reasonOf(error)}`);
      return undefined;
    }
  }
}

/**
 * The attribute whose *value* the cursor is inside. `attrsPosition` records a
 * range per key — zero-width when the value is still empty, which is exactly
 * where a cursor asking about a value tends to be — so the narrowest range that
 * contains the cursor is the answer, and nesting decides itself.
 */
export function valueAt(
  block: ResolvedBlock,
  document: TextDocument,
  position: Position,
): { key: string; range: Range } | undefined {
  const offset = document.offsetAt(position);
  let key: string | undefined;
  let width = Infinity;
  let found: Range | undefined;
  for (const [candidate, range] of Object.entries(block.node.attrsPosition)) {
    const { start, end } = range;
    if (start.offset > offset || offset > end.offset) continue;
    const span = end.offset - start.offset;
    if (span >= width) continue;
    width = span;
    key = candidate;
    found = { start: document.positionAt(start.offset), end: document.positionAt(end.offset) };
  }
  if (key === undefined || found === undefined) return undefined;
  return { key, range: found };
}

/**
 * The key the cursor is standing on — empty when nothing has been typed there
 * yet, which a completion is asked for and a hover has nothing to say about.
 *
 * A colon to the left means the cursor is past a key and inside a value that
 * `attrsPosition` did not claim — an unparsed line, most likely, mid-edit — and
 * reading the word as a key there would be wrong in a way the author cannot see
 * coming. A line indented past the fence belongs to a nested map, whose keys are
 * the parent attribute's business and not the block's.
 */
export function keyAt(document: TextDocument, position: Position, site: Site): Key | undefined {
  const text = document.lineText(position.line);
  const before = text.slice(0, position.character);
  const key = before.slice(wordStart(before));
  if (key !== '' && !KEY_TOKEN.test(key)) return undefined;
  const indent = before.slice(0, before.length - key.length);
  if (indent.includes(':')) return undefined;
  if (indent.length > shared(indent, document.lineText(site.fenceLine)).length) return undefined;
  const end = wordEnd(text, position.character);
  return {
    key,
    word: text.slice(indent.length, end),
    range: spanning(position, indent.length, end),
  };
}

/**
 * A key under the cursor: the part of it that has been typed, and all of it.
 *
 * The two differ mid-word, and each feature wants a different one. Completion
 * is being asked to *finish* `wid‸th`, so it matches on what precedes the
 * cursor; hover is being asked what `wid‸th` **is**, which is `width` however
 * far along the word the author stopped. Both act on the same range, so the
 * span that completion would replace is the span hover underlines.
 */
export interface Key {
  /** The word up to the cursor — empty where nothing has been typed yet. */
  readonly key: string;
  /** The whole word the range covers, on both sides of the cursor. */
  readonly word: string;
  readonly range: Range;
}

/** The prefix two lines of the same block share: the quote marker, the indent. */
function shared(left: string, right: string): string {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left.charAt(index) === right.charAt(index)
  ) {
    index += 1;
  }
  return left.slice(0, index);
}

/** Index of the first character of the word ending at the end of `before`. */
export function wordStart(before: string): number {
  let start = before.length;
  while (start > 0 && isWordChar(before.charAt(start - 1))) start -= 1;
  return start;
}

/** Index one past the word the cursor is standing in. */
export function wordEnd(text: string, character: number): number {
  let end = Math.min(character, text.length);
  while (end < text.length && isWordChar(text.charAt(end))) end += 1;
  return end;
}

function isWordChar(character: string): boolean {
  return /[A-Za-z0-9_-]/u.test(character);
}

/** A range on the cursor's own line, which is every range these features make. */
export function spanning(position: Position, start: number, end: number): Range {
  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
  };
}

export function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

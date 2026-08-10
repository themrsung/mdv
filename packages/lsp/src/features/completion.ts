/**
 * `textDocument/completion` (SPEC 29.4).
 *
 * An MDV block asks the author for four different kinds of word, and the only
 * thing that separates them is where the cursor is:
 *
 * ```mdv bar        ← a block type, from the registry the config built
 * x: quarter        ← a key, then a column name from this block's own data
 * legend: top       ← a value from a closed set the schema names
 * ---               ← below here the author is writing data, and we say nothing
 * ```
 *
 * So this file is mostly a careful answer to "which of those four is it?", and
 * the answers themselves are one-liners over the same pipeline everything else
 * in this server runs. Nothing here has its own idea of what a chart type is or
 * which channels it takes: `registryFromPlugins` says, exactly as it says to the
 * renderer, so a plugin's chart type completes the moment it is configured and
 * a host that configures none is offered none.
 *
 * Nothing common is written down here either. `COMMON_ATTRS` and
 * `CLOSED_VALUES` are read from `@mdv/spec`, which publishes
 * `schemas/common/block.json` (SPEC Appendix D) as values rather than as a file
 * on disk, so a key the schema grows is offered without anyone editing this
 * server. Per-type values are the one thing still taken from
 * `ChartType.defaults`, which names one value per key rather than the whole
 * enum: those enums live in the per-type schemas
 * (`stack: none | normal | percent | center`), which Appendix D does not
 * publish yet. When it does, this file should offer the set instead of the
 * default; until then a suggestion the runtime can vouch for beats one this
 * file invented.
 *
 * The one honest limitation: a partially typed key is completed against the
 * block's *type as it currently parses*. Type a block type wrong and the keys
 * offered are the common ones only — which is also what the diagnostics say, so
 * the two features tell the author the same story.
 */

import { registryFromPlugins, resolveSync } from '@mdv/core';
import type { ChartType, ChartTypeRegistry, MdvConfig, ResolvedBlock, Table } from '@mdv/core';
import { parse } from '@mdv/parser';
import { CLOSED_VALUES, COMMON_ATTRS } from '@mdv/spec';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import { CompletionItemKind, MarkupKind } from '../protocol/types.js';
import type {
  CompletionItem,
  CompletionItemKindValue,
  CompletionParams,
  Position,
  Range,
  ServerCapabilities,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';

/** The two facet keys take a column name like a channel does (SPEC 11). */
const FACET_CHANNELS: readonly string[] = ['row', 'column'];

/**
 * The info string, up to the point where the type is written. Lazy on the left
 * so a block quote's `> ` and a list item's indent are simply whatever came
 * before the fence, and the capture is what stays put when the type is replaced.
 */
const FENCE_PREFIX = /^(.*?(?:`{3,}|~{3,})mdv[ \t]+)([A-Za-z][A-Za-z0-9_-]*)?$/u;

/** A key, or as much of one as the author has typed. */
const KEY_TOKEN = /^[A-Za-z][A-Za-z0-9_-]*$/u;

/** `SEPARATOR` from the parser, loosened by the container prefix it strips first. */
const DATA_SEPARATOR = /^[\s>]*---[ \t]*$/u;

/** A field name that needs no brackets to be written in a channel (SPEC 6.1.2). */
const BARE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** A trailing `[0]`, so `y[0]` completes the way `y` does. */
const INDEX_SUFFIX = /\[\d+\]$/u;

/** What the client may type to summon the list without asking for it. */
const TRIGGER_CHARACTERS: readonly string[] = [':', ' '];

/**
 * Named against the grain of `DiagnosticsOptions` and `FormatterOptions`: the
 * protocol's own `CompletionOptions` is the shape that goes in
 * `ServerCapabilities`, and both are exported from this package's index.
 */
export interface CompletionSettings {
  /**
   * The configuration whose plugins decide which chart types exist, or a
   * function of the document for a host that scopes config per workspace
   * folder — the same shape {@link DiagnosticsOptions.config} takes, so a host
   * can pass one value to both.
   */
  readonly config?: MdvConfig | ((document: TextDocument) => MdvConfig | undefined);
}

/** Where the cursor sits in a block, which is the whole question. */
interface Site {
  readonly block: ResolvedBlock;
  readonly chartType: ChartType | undefined;
  /** Line of the opening fence. */
  readonly fenceLine: number;
  /** Last line that is still header; below it lies data or the closing fence. */
  readonly lastHeaderLine: number;
}

class Completion {
  readonly #context: ServerContext;
  readonly #options: CompletionSettings;

  constructor(context: ServerContext, options: CompletionSettings) {
    this.#context = context;
    this.#options = options;
  }

  listen(): void {
    this.#context.onRequest('textDocument/completion', (params, token) =>
      this.#complete(params as CompletionParams, token),
    );
  }

  /**
   * The list is computed from scratch on every keystroke. A block is small and
   * the parse is already the cost of a diagnostics run, so a cache would buy
   * back less than the staleness it would cost — and a stale completion list is
   * worse than a slow one, because the author acts on it.
   */
  #complete(params: CompletionParams, token: CancellationToken): CompletionItem[] {
    const document = this.#document(params.textDocument.uri);
    const config = this.#configFor(document);

    const registry = this.#registry(config);
    if (registry === undefined) return [];
    throwIfCancelled(token);

    const site = this.#siteAt(document, params.position, config, registry);
    if (site === undefined) return [];
    throwIfCancelled(token);

    // The info string, where the only word is a block type.
    if (params.position.line === site.fenceLine) {
      return this.#fenceTypes(document, params.position, registry);
    }
    // Below the separator the author is writing data. Their column names are
    // their own business and we have nothing to add.
    if (params.position.line > site.lastHeaderLine) return [];

    const value = this.#valueSite(site.block, document, params.position);
    if (value !== undefined) {
      return this.#values(value.key, value.range, site, registry);
    }
    return this.#keys(document, params.position, site);
  }

  #document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }

  /**
   * The host's configuration, minus its diagnostic sink. Resolving a document
   * to answer a keystroke produces the same diagnostics the `diagnostics`
   * feature already reported; a sink that heard them twice would have no way to
   * tell which run it was listening to.
   */
  #configFor(document: TextDocument): MdvConfig | undefined {
    const { config } = this.#options;
    const resolved = typeof config === 'function' ? config(document) : config;
    if (resolved?.onDiagnostic === undefined) return resolved;
    const { onDiagnostic: _sink, ...rest } = resolved;
    return rest;
  }

  /**
   * `registryFromPlugins` throws `MdvConfigError` for a malformed plugin — host
   * programmer error, already reported by every other feature. Completion is
   * not the place to learn it, so it is logged once and the author gets no list
   * rather than a broken server.
   */
  #registry(config: MdvConfig | undefined): ChartTypeRegistry | undefined {
    try {
      return registryFromPlugins(config);
    } catch (error) {
      this.#context.logger.error(`Completion has no registry: ${reasonOf(error)}`);
      return undefined;
    }
  }

  /** Resolve the document and find the block the cursor is inside, if any. */
  #siteAt(
    document: TextDocument,
    position: Position,
    config: MdvConfig | undefined,
    registry: ChartTypeRegistry,
  ): Site | undefined {
    const offset = document.offsetAt(position);
    let block: ResolvedBlock | undefined;
    try {
      const resolved = resolveSync(parse(document.text), config);
      block = resolved.blocks.find(
        (candidate) =>
          candidate.range.start.offset <= offset && offset <= candidate.range.end.offset,
      );
    } catch (error) {
      this.#context.logger.error(`Completion could not read ${document.uri}: ${reasonOf(error)}`);
      return undefined;
    }
    if (block === undefined) return undefined;

    const fenceLine = document.positionAt(block.range.start.offset).line;
    const dataStart = block.node.dataPosition?.start.offset;
    // With a separator, the data starts on the line below it — and when the
    // separator is the last line, on the separator itself. Either way the line
    // above the data is the last one a key can be written on, and the separator
    // that may still be sitting there is caught by {@link DATA_SEPARATOR}.
    const lastHeaderLine =
      (dataStart === undefined
        ? document.positionAt(block.range.end.offset).line
        : document.positionAt(dataStart).line) - 1;

    return { block, chartType: registry.get(block.blockType), fenceLine, lastHeaderLine };
  }

  /** Every registered type, replacing whatever the author has typed so far. */
  #fenceTypes(
    document: TextDocument,
    position: Position,
    registry: ChartTypeRegistry,
  ): CompletionItem[] {
    const text = document.lineText(position.line);
    const match = FENCE_PREFIX.exec(text.slice(0, position.character));
    if (match === null) return [];
    const range = spanning(position, match[1]?.length ?? 0, wordEnd(text, position.character));

    return registry.list().map((type) => ({
      label: type.name,
      kind: CompletionItemKind.class,
      detail: detailOf(type),
      sortText: `${type.level}${type.name}`,
      textEdit: { range, newText: type.name },
    }));
  }

  /**
   * The attribute whose *value* the cursor is inside. `attrsPosition` records a
   * range per key — zero-width when the value is still empty, which is exactly
   * where a cursor asking for a value tends to be — so the narrowest range that
   * contains the cursor is the answer, and nesting decides itself.
   */
  #valueSite(
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

  /** What may stand to the right of `key:`. */
  #values(key: string, range: Range, site: Site, registry: ChartTypeRegistry): CompletionItem[] {
    const path = key.replace(INDEX_SUFFIX, '');
    // A dotted path is inside a nested map (`axis.x.grid`). Those are per-type
    // and unpublished; saying nothing is better than guessing.
    if (path.includes('.') || path.includes('[')) return [];

    // `type:` in the header is the info string written the long way, so it
    // completes the same way. Only reachable from a header line: the fence line
    // is answered before this.
    if (path === 'type') {
      return registry.list().map((type) => ({
        label: type.name,
        kind: CompletionItemKind.class,
        detail: detailOf(type),
        sortText: `${type.level}${type.name}`,
        textEdit: { range, newText: type.name },
      }));
    }

    const closed = CLOSED_VALUES[path];
    if (closed !== undefined) {
      return closed.map((value) => ({
        label: value,
        kind: CompletionItemKind.enumMember,
        textEdit: { range, newText: value },
      }));
    }

    if (isChannel(path, site.chartType)) return columns(site.block.table, range);

    // One value, vouched for by the type that will read it.
    const fallback = site.chartType?.defaults?.[path];
    if (typeof fallback === 'string' || typeof fallback === 'boolean') {
      return [
        {
          label: String(fallback),
          kind: CompletionItemKind.enumMember,
          detail: 'default',
          textEdit: { range, newText: String(fallback) },
        },
      ];
    }
    return [];
  }

  /**
   * Keys, on a header line where nothing has been written before the cursor but
   * whitespace and the container's own prefix. A colon to the left means the
   * cursor is past the key and in a value that `attrsPosition` did not claim —
   * an unparsed line, most likely, mid-edit — and a key completion there would
   * be wrong in a way the author cannot see coming.
   */
  #keys(document: TextDocument, position: Position, site: Site): CompletionItem[] {
    const text = document.lineText(position.line);
    if (DATA_SEPARATOR.test(text)) return [];

    const end = wordEnd(text, position.character);
    const before = text.slice(0, position.character);
    const token = before.slice(wordStart(before));
    if (token !== '' && !KEY_TOKEN.test(token)) return [];
    const indent = before.slice(0, before.length - token.length);
    if (indent.includes(':')) return [];
    // A line indented past the fence belongs to a nested map whose keys are the
    // parent attribute's business, not the block's.
    if (indent.length > shared(indent, document.lineText(site.fenceLine)).length) return [];

    const written = new Set(
      Object.keys(site.block.node.attrsPosition)
        .map((key) => key.replace(INDEX_SUFFIX, ''))
        .filter((key) => !key.includes('.')),
    );
    written.delete(token);

    const range = spanning(position, before.length - token.length, end);
    // A key that already has its colon is being renamed, not written.
    const suffix = text.slice(end).trimStart().startsWith(':') ? '' : ': ';
    const item = (
      label: string,
      kind: CompletionItemKindValue,
      group: number,
      detail?: string,
    ): CompletionItem => ({
      label,
      kind,
      ...(detail === undefined ? {} : { detail }),
      sortText: `${group}${label}`,
      textEdit: { range, newText: `${label}${suffix}` },
    });

    const items: CompletionItem[] = [];
    for (const channel of site.chartType?.channels ?? []) {
      if (written.has(channel.name)) continue;
      items.push({
        ...item(channel.name, CompletionItemKind.field, 0, channel.accepts.join(' | ')),
        // Plain text, because the docs are prose and every client renders it.
        documentation: { kind: MarkupKind.plainText, value: channel.doc },
        ...(channel.required ? { preselect: true } : {}),
      });
    }
    for (const [key, value] of Object.entries(site.chartType?.defaults ?? {})) {
      if (written.has(key)) continue;
      items.push(item(key, CompletionItemKind.property, 1, `default: ${String(value)}`));
    }
    for (const key of COMMON_ATTRS) {
      if (written.has(key)) continue;
      items.push(item(key, CompletionItemKind.property, 2, CLOSED_VALUES[key]?.join(' | ')));
    }
    return items;
  }
}

/** The block's own columns — stage 4 read them, so they are the real names. */
function columns(table: Table, range: Range): CompletionItem[] {
  return table.fields.map((field) => ({
    label: field.name,
    kind: CompletionItemKind.value,
    detail: field.type,
    filterText: field.name,
    // A name that is not an identifier has to be bracketed to survive being
    // read back (SPEC 6.1.2), and the author should not have to remember that.
    // The brackets are quoted because the header is YAML: written bare, `x:
    // [net gain]` reads back as a one-item flow list rather than as a name.
    textEdit: {
      range,
      newText: BARE_FIELD.test(field.name) ? field.name : `"[${field.name}]"`,
    },
  }));
}

/** `bar` reads as `mark · level 1`; an alias is worth saying out loud. */
function detailOf(type: ChartType): string {
  const aliases = type.aliases ?? [];
  const also = aliases.length === 0 ? '' : ` · also ${aliases.join(', ')}`;
  return `${type.family} · level ${type.level}${also}`;
}

function isChannel(key: string, chartType: ChartType | undefined): boolean {
  if (FACET_CHANNELS.includes(key)) return true;
  return chartType?.channels.some((channel) => channel.name === key) ?? false;
}

/** Index of the first character of the word ending at the end of `before`. */
function wordStart(before: string): number {
  let start = before.length;
  while (start > 0 && isWordChar(before.charAt(start - 1))) start -= 1;
  return start;
}

/** Index one past the word the cursor is standing in. */
function wordEnd(text: string, character: number): number {
  let end = Math.min(character, text.length);
  while (end < text.length && isWordChar(text.charAt(end))) end += 1;
  return end;
}

function isWordChar(character: string): boolean {
  return /[A-Za-z0-9_-]/u.test(character);
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

function spanning(position: Position, start: number, end: number): Range {
  return {
    start: { line: position.line, character: start },
    end: { line: position.line, character: end },
  };
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install completion.
 *
 * ```ts
 * createServer(transport, { features: [completion({ config })] });
 * ```
 */
export function completion(options: CompletionSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Completion(context, options);
    feature.listen();
    return {
      completionProvider: {
        triggerCharacters: TRIGGER_CHARACTERS,
        // Everything a client needs is in the item already; there is no second
        // round of work to do, and claiming otherwise costs a request per item.
        resolveProvider: false,
      },
    };
  };
}

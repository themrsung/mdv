/**
 * `textDocument/hover` (SPEC 29.4).
 *
 * The question hover answers is the one completion answers a beat earlier — the
 * author has stopped over a word and wants to know what it is — so it is asked
 * the same way, of `site.ts`, and answered from the same two places: a channel
 * is described by the chart type that declares it, and a common attribute by
 * Appendix D, which `@mdv/spec` publishes as values.
 *
 * ```mdv bar        ← the type: what it is, and every channel it takes
 * x: quarter        ← the channel, on the key and on the column name alike
 * legend: top       ← the attribute, its allowed values and its default
 * ---               ← below here the author is writing data, and we say nothing
 * ```
 *
 * Hovering a value shows what its *key* means, because that is what the author
 * is asking: standing on `top` in `legend: top` is a question about `legend`.
 * The one exception is `type:`, whose value is a block type and reads as one —
 * the same exception completion makes, so the two features agree about every
 * word in the block.
 *
 * Content is rendered twice, once as Markdown and once as plain text, and the
 * client is asked which it wants. LSP's default for a client that says nothing
 * is plain text; a server that assumes otherwise leaves asterisks on the screen
 * of the one client that meant it.
 */

import type { ChannelSpec, ChartType } from '@mdv/core';
import { attrDoc } from '@mdv/spec';
import type { AttrDoc } from '@mdv/spec';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { MarkupKind } from '../protocol/types.js';
import type {
  Hover,
  MarkupKindValue,
  Position,
  Range,
  ServerCapabilities,
  TextDocumentPositionParams,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { channelDetail, channelOf, detailOf } from './doc.js';
import { INDEX_SUFFIX, Sites, keyAt, spanning, valueAt, wordEnd, wordStart } from './site.js';
import type { BlockSettings, Site } from './site.js';

/**
 * Named against the grain of `DiagnosticsOptions` and `FormatterOptions`: the
 * protocol's own `HoverOptions` is the shape that goes in `ServerCapabilities`.
 */
export type HoverSettings = BlockSettings;

/** One labelled value: `Default: 100%`. */
interface Fact {
  readonly label: string;
  readonly value: string;
}

/** One line of a list: a channel of the type being hovered. */
interface Bullet {
  readonly name: string;
  readonly detail?: string;
  readonly doc?: string;
}

/**
 * What there is to say about a word, before it is said in either format.
 *
 * Splitting the two apart is worth the interface: a hover built once and
 * rendered twice cannot say two different things to two clients, which is the
 * bug that a `strip the asterisks` pass would eventually ship.
 */
interface Doc {
  /** The word itself. */
  readonly term: string;
  /** What kind of word it is, in a few: `mark · level 1`, `dimension`. */
  readonly detail?: string;
  /** Prose, as the plugin or the schema wrote it. */
  readonly body?: string;
  readonly bullets?: readonly Bullet[];
  readonly facts?: readonly Fact[];
  /** One header line the author can copy. */
  readonly example?: string;
}

class Hovers {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: HoverSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Hover');
  }

  listen(): void {
    this.#context.onRequest('textDocument/hover', (params, token) =>
      this.#hover(params as TextDocumentPositionParams, token),
    );
  }

  /** `undefined` is the connection's `null`: a word with nothing to say about it. */
  #hover(params: TextDocumentPositionParams, token: CancellationToken): Hover | undefined {
    const document = this.#sites.document(params.textDocument.uri);
    const site = this.#sites.at(document, params.position, token);
    if (site === undefined) return undefined;
    throwIfCancelled(token);

    const found =
      params.position.line === site.fenceLine
        ? this.#type(document, params.position, site)
        : this.#attribute(document, params.position, site);
    if (found === undefined) return undefined;

    const [doc, range] = found;
    const kind = this.#kind();
    return {
      contents: { kind, value: kind === MarkupKind.markdown ? toMarkdown(doc) : toPlainText(doc) },
      range,
    };
  }

  /**
   * The block type, on the fence line. Any other word up there — `mdv` itself,
   * a container's own text — resolves to no type and is left alone, so the
   * registry decides what is hoverable without a rule about columns.
   */
  #type(document: TextDocument, position: Position, site: Site): [Doc, Range] | undefined {
    const text = document.lineText(position.line);
    const start = wordStart(text.slice(0, position.character));
    const end = wordEnd(text, position.character);
    const word = text.slice(start, end);
    if (word === '') return undefined;
    const type = site.registry.get(word.toLowerCase());
    if (type === undefined) return undefined;
    return [typeDoc(type), spanning(position, start, end)];
  }

  /** A key or its value, on a header line. */
  #attribute(document: TextDocument, position: Position, site: Site): [Doc, Range] | undefined {
    // Below the separator the author is writing data, and their column names
    // are their own business.
    if (position.line > site.lastHeaderLine) return undefined;

    const value = valueAt(site.block, document, position);
    if (value !== undefined) {
      const key = value.key.replace(INDEX_SUFFIX, '');
      // A dotted path is inside a nested map (`axis.x.grid`). Those are
      // per-type and unpublished; saying nothing is better than guessing.
      if (key.includes('.') || key.includes('[')) return undefined;
      if (key === 'type') {
        const named = site.registry.get(read(document, value.range).trim().toLowerCase());
        if (named !== undefined) return [typeDoc(named), value.range];
      }
      const doc = documentFor(key, site);
      return doc === undefined ? undefined : [doc, value.range];
    }

    // `word`, not `key`: the author has stopped in the middle of `wid‸th` and
    // is asking about `width`, where completion would be asking about `wid`.
    const at = keyAt(document, position, site);
    if (at === undefined || at.word === '') return undefined;
    const doc = documentFor(at.word, site);
    return doc === undefined ? undefined : [doc, at.range];
  }

  /**
   * What the client asked for. LSP reads a missing `contentFormat` as plain
   * text only, and this server takes it at its word: the cost of believing a
   * client that can render Markdown is a hover full of punctuation, and the
   * cost of not believing one is a hover that is merely plain.
   */
  #kind(): MarkupKindValue {
    const formats = this.#context.client().textDocument?.hover?.contentFormat;
    return formats?.includes(MarkupKind.markdown) === true
      ? MarkupKind.markdown
      : MarkupKind.plainText;
  }
}

/** The type, and every channel it takes — the list an author comes to hover for. */
function typeDoc(type: ChartType): Doc {
  const defaults = Object.entries(type.defaults ?? {});
  return {
    term: type.name,
    detail: detailOf(type),
    bullets: type.channels.map((channel) => ({
      name: channel.name,
      detail: channelDetail(channel),
      doc: channel.doc,
    })),
    facts:
      defaults.length === 0
        ? []
        : [
            {
              label: 'Defaults',
              value: defaults.map(([key, value]) => `${key}: ${written(value)}`).join(', '),
            },
          ],
  };
}

/** A channel of this block's type, described by the type that declares it. */
function channelDoc(name: string, channel: ChannelSpec): Doc {
  return {
    term: name,
    detail: channelDetail(channel),
    body: channel.doc,
    facts: factOf('Scale', channel.defaultScale),
  };
}

/** A common attribute, described by Appendix D (SPEC Appendix D). */
function attributeDoc(attr: AttrDoc): Doc {
  return {
    term: attr.name,
    detail: attr.type,
    ...(attr.description === undefined ? {} : { body: attr.description }),
    facts: [...factOf('Values', attr.values?.join(' | ')), ...factOf('Default', attr.default)],
    ...(attr.example === undefined ? {} : { example: attr.example }),
  };
}

/**
 * A key the block's type declares a default for but no one documents. Thin, and
 * still worth saying: it tells the author the key is real and what happens if
 * they leave it alone, which is the whole of what this server knows.
 */
function typeDefaultDoc(key: string, type: ChartType, value: unknown): Doc {
  return {
    term: key,
    body: `Set by the ${type.name} block type.`,
    facts: factOf('Default', written(value)),
  };
}

/** The three doors, in the order a key goes through them. */
function documentFor(key: string, site: Site): Doc | undefined {
  const channel = channelOf(key, site.chartType);
  if (channel !== undefined) return channelDoc(key, channel);

  const attr = attrDoc(key);
  if (attr !== undefined) return attributeDoc(attr);

  const fallback = site.chartType?.defaults?.[key];
  if (fallback !== undefined && site.chartType !== undefined) {
    return typeDefaultDoc(key, site.chartType, fallback);
  }
  return undefined;
}

function toMarkdown(doc: Doc): string {
  const sections = [term(`**${doc.term}**`, doc.detail)];
  if (doc.body !== undefined) sections.push(doc.body);
  for (const bullet of doc.bullets ?? []) {
    sections.push(`- ${line(`**${bullet.name}**`, bullet)}`);
  }
  for (const fact of doc.facts ?? []) sections.push(`**${fact.label}:** \`${fact.value}\``);
  // The header is YAML (SPEC 5.4), so an example highlights as YAML — and as
  // nothing at all in a client that has no grammar for it, which is no loss.
  if (doc.example !== undefined) sections.push(`\`\`\`yaml\n${doc.example}\n\`\`\``);
  return sections.join('\n\n');
}

function toPlainText(doc: Doc): string {
  const sections = [term(doc.term, doc.detail)];
  if (doc.body !== undefined) sections.push(doc.body);
  for (const bullet of doc.bullets ?? []) sections.push(`- ${line(bullet.name, bullet)}`);
  for (const fact of doc.facts ?? []) sections.push(`${fact.label}: ${fact.value}`);
  if (doc.example !== undefined) sections.push(doc.example);
  return sections.join('\n\n');
}

/**
 * Bullets are paragraphs of their own so that both renderings survive the trip:
 * a Markdown client draws a list of one-line items either way, and a plain-text
 * one gets a blank line between them instead of a wall.
 */
function line(name: string, bullet: Bullet): string {
  return `${term(name, bullet.detail)}${bullet.doc === undefined ? '' : ` — ${bullet.doc}`}`;
}

function term(name: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? name : `${name} · ${detail}`;
}

function factOf(label: string, value: string | undefined): readonly Fact[] {
  return value === undefined ? [] : [{ label, value }];
}

/** A default as an author would have written it, which for a map is JSON's way. */
function written(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/** The source text a range covers. */
function read(document: TextDocument, range: Range): string {
  return document.text.slice(document.offsetAt(range.start), document.offsetAt(range.end));
}

/**
 * Install hover.
 *
 * ```ts
 * createServer(transport, { features: [hover({ config })] });
 * ```
 */
export function hover(options: HoverSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Hovers(context, options);
    feature.listen();
    return { hoverProvider: true };
  };
}

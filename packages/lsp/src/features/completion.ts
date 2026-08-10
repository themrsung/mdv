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
 * Which of the four it is, is `site.ts`'s question; this file is the four
 * answers, and each is a one-liner over the same pipeline everything else in
 * this server runs. Nothing here has its own idea of what a chart type is or
 * which channels it takes: `registryFromPlugins` says, exactly as it says to
 * the renderer, so a plugin's chart type completes the moment it is configured
 * and a host that configures none is offered none.
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

import type { ChartTypeRegistry, Table } from '@mdv/core';
import { CLOSED_VALUES, COMMON_ATTRS } from '@mdv/spec';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
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
import { acceptsOf, detailOf, isChannel } from './doc.js';
import { INDEX_SUFFIX, Sites, keyAt, spanning, valueAt, wordEnd } from './site.js';
import type { BlockSettings, Site } from './site.js';

/**
 * The info string, up to the point where the type is written. Lazy on the left
 * so a block quote's `> ` and a list item's indent are simply whatever came
 * before the fence, and the capture is what stays put when the type is replaced.
 */
const FENCE_PREFIX = /^(.*?(?:`{3,}|~{3,})mdv[ \t]+)([A-Za-z][A-Za-z0-9_-]*)?$/u;

/** `SEPARATOR` from the parser, loosened by the container prefix it strips first. */
const DATA_SEPARATOR = /^[\s>]*---[ \t]*$/u;

/** A field name that needs no brackets to be written in a channel (SPEC 6.1.2). */
const BARE_FIELD = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** What the client may type to summon the list without asking for it. */
const TRIGGER_CHARACTERS: readonly string[] = [':', ' '];

/**
 * Named against the grain of `DiagnosticsOptions` and `FormatterOptions`: the
 * protocol's own `CompletionOptions` is the shape that goes in
 * `ServerCapabilities`, and both are exported from this package's index.
 */
export type CompletionSettings = BlockSettings;

class Completion {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: CompletionSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Completion');
  }

  listen(): void {
    this.#context.onRequest('textDocument/completion', (params, token) =>
      this.#complete(params as CompletionParams, token),
    );
  }

  #complete(params: CompletionParams, token: CancellationToken): CompletionItem[] {
    const document = this.#sites.document(params.textDocument.uri);
    const site = this.#sites.at(document, params.position, token);
    if (site === undefined) return [];
    throwIfCancelled(token);

    // The info string, where the only word is a block type.
    if (params.position.line === site.fenceLine) {
      return this.#fenceTypes(document, params.position, site.registry);
    }
    // Below the separator the author is writing data. Their column names are
    // their own business and we have nothing to add.
    if (params.position.line > site.lastHeaderLine) return [];

    const value = valueAt(site.block, document, params.position);
    if (value !== undefined) {
      return this.#values(value.key, value.range, site);
    }
    return this.#keys(document, params.position, site);
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

    return this.#types(registry, range);
  }

  /** What may stand to the right of `key:`. */
  #values(key: string, range: Range, site: Site): CompletionItem[] {
    const path = key.replace(INDEX_SUFFIX, '');
    // A dotted path is inside a nested map (`axis.x.grid`). Those are per-type
    // and unpublished; saying nothing is better than guessing.
    if (path.includes('.') || path.includes('[')) return [];

    // `type:` in the header is the info string written the long way, so it
    // completes the same way. Only reachable from a header line: the fence line
    // is answered before this.
    if (path === 'type') return this.#types(site.registry, range);

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

  /** The registry, as a list of block types — the same list in both places. */
  #types(registry: ChartTypeRegistry, range: Range): CompletionItem[] {
    return registry.list().map((type) => ({
      label: type.name,
      kind: CompletionItemKind.class,
      detail: detailOf(type),
      sortText: `${type.level}${type.name}`,
      textEdit: { range, newText: type.name },
    }));
  }

  /**
   * Keys, on a header line where nothing has been written before the cursor but
   * whitespace and the container's own prefix — {@link keyAt} decides that, and
   * hover reads the same line the same way.
   */
  #keys(document: TextDocument, position: Position, site: Site): CompletionItem[] {
    const text = document.lineText(position.line);
    // A separator is not a key that has yet to be finished.
    if (DATA_SEPARATOR.test(text)) return [];

    const at = keyAt(document, position, site);
    if (at === undefined) return [];
    const { key: token, range } = at;

    const written = new Set(
      Object.keys(site.block.node.attrsPosition)
        .map((key) => key.replace(INDEX_SUFFIX, ''))
        .filter((key) => !key.includes('.')),
    );
    written.delete(token);

    // A key that already has its colon is being renamed, not written.
    const suffix = text.slice(range.end.character).trimStart().startsWith(':') ? '' : ': ';
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
        ...item(channel.name, CompletionItemKind.field, 0, acceptsOf(channel)),
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

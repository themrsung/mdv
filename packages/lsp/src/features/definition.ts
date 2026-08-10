/**
 * Go to definition, and find references (SPEC 29.4).
 *
 * Both requests are the same question asked in two directions: *which id is
 * under the cursor, and where else in this document is it written?* The half
 * that could go wrong is knowing where an id may be written at all — `data:` and
 * `from:` carry references, `src:` carries a path, `sort:` carries a field name,
 * and a `mdv dataset` block wears its id bare — and none of that is this
 * server's to decide. `locateDatasets` publishes it, out of the same file the
 * resolver routes with, so a jump lands where the renderer actually looked.
 *
 * Ids are document-scoped: front-matter datasets and dataset blocks share one
 * namespace (SPEC 6.3), and one document's `@sales` is nothing to the document
 * next to it. So there is no workspace scan here and every `Location` returned
 * carries the uri that was asked about.
 */

import { locateDatasets } from '@mdv/core';
import type { DatasetSite } from '@mdv/core';
import { parse } from '@mdv/parser';

import { toLspRange } from '../convert.js';
import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import type {
  Location,
  Range,
  ReferenceParams,
  ServerCapabilities,
  TextDocumentPositionParams,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { Sites } from './site.js';
import type { BlockSettings } from './site.js';

/**
 * Accepted for symmetry and unused.
 *
 * Every other position feature takes the host's configuration because plugins
 * decide what a block *means*; where an id is written is the parser's grammar
 * and no configuration changes it. Taking the option anyway lets a host pass one
 * settings object to every feature it installs, which is the shape the rest of
 * this package promises.
 */
export type DefinitionSettings = BlockSettings;

class Definitions {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: DefinitionSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Definition');
  }

  listen(): void {
    this.#context.onRequest('textDocument/definition', (params, token) =>
      this.#definition(params as TextDocumentPositionParams, token),
    );
    this.#context.onRequest('textDocument/references', (params, token) =>
      this.#references(params as ReferenceParams, token),
    );
  }

  /**
   * The declaration of the id under the cursor.
   *
   * A cursor on a declaration answers with itself, which is what a client that
   * peeks rather than jumps expects, and is how "is this the one that wins?"
   * gets asked of a duplicated id.
   */
  #definition(params: TextDocumentPositionParams, token: CancellationToken): Location | undefined {
    const { document, sites, site } = this.#read(params, token);
    if (site === undefined) return undefined;

    // SPEC 6.3 gives a duplicated id to its *later* declaration — that is the
    // one the reader will see — so the search runs from the end.
    const declaration = last(
      sites,
      (candidate) => candidate.kind === 'declaration' && candidate.id === site.id,
    );
    if (declaration === undefined) return undefined;
    return { uri: params.textDocument.uri, range: idRange(document, declaration) };
  }

  /**
   * Every site that writes the id under the cursor.
   *
   * In source order, because that is the order the locator lists them in and a
   * client renders the list as it arrives.
   */
  #references(params: ReferenceParams, token: CancellationToken): Location[] {
    const { document, sites, site } = this.#read(params, token);
    if (site === undefined) return [];

    const include = params.context?.includeDeclaration ?? false;
    return sites
      .filter(
        (candidate) => candidate.id === site.id && (include || candidate.kind === 'reference'),
      )
      .map((candidate) => ({
        uri: params.textDocument.uri,
        range: idRange(document, candidate),
      }));
  }

  /** The document, every site in it, and the one the cursor is in. */
  #read(
    params: TextDocumentPositionParams,
    token: CancellationToken,
  ): { document: TextDocument; sites: readonly DatasetSite[]; site: DatasetSite | undefined } {
    const document = this.#sites.document(params.textDocument.uri);
    throwIfCancelled(token);
    const sites = locateDatasets(parse(document.text));
    return { document, sites, site: siteAt(sites, document.offsetAt(params.position)) };
  }
}

/**
 * The site the cursor is in.
 *
 * A declaration contains the references written inside it — a front-matter
 * dataset's `from:` lives in the middle of its own declaration — and the locator
 * lists the wider site first, so the *last* one that contains the cursor is the
 * most specific thing it is standing on.
 */
function siteAt(sites: readonly DatasetSite[], offset: number): DatasetSite | undefined {
  return last(
    sites,
    (site) => site.range.start.offset <= offset && offset <= site.range.end.offset,
  );
}

/** `Array.prototype.findLast`, which is a lib newer than this package targets. */
function last(
  sites: readonly DatasetSite[],
  match: (site: DatasetSite) => boolean,
): DatasetSite | undefined {
  for (let index = sites.length - 1; index >= 0; index -= 1) {
    const site = sites[index] as DatasetSite;
    if (match(site)) return site;
  }
  return undefined;
}

/**
 * The id alone, rather than the value that carries it.
 *
 * A site's range covers the text as written — quotes, `@`, and any projection —
 * and highlighting all of that for `@sales[date, revenue]` would tell an author
 * the name of their dataset is twenty characters long. `text` and `offset` say
 * where the bare id sits inside the parsed value, and the value is the same
 * characters as the written one at a shift, which is found by looking for it.
 *
 * A value YAML rewrote rather than trimmed is not found and falls back to the
 * whole range: a range that is too wide is still a range that lands in the right
 * place, which is the point of the jump.
 */
function idRange(document: TextDocument, site: DatasetSite): Range {
  const { start, end } = site.range;
  const written = document.text.slice(start.offset, end.offset);
  const shift = site.offset < 0 ? -1 : written.indexOf(site.text);
  if (shift === -1) return toLspRange(document, site.range);

  const from = start.offset + shift + site.offset;
  return toLspRange(document, {
    start: { ...start, offset: from },
    end: { ...end, offset: from + site.id.length },
  });
}

/**
 * Install go-to-definition and find-references.
 *
 * ```ts
 * createServer(transport, { features: [definition()] });
 * ```
 */
export function definition(options: DefinitionSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Definitions(context, options);
    feature.listen();
    return { definitionProvider: true, referencesProvider: true };
  };
}

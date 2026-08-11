/**
 * Rename a dataset id (SPEC 29.4).
 *
 * Rename is find-references with the answer written back, so it is built on the
 * same module `definition.ts` hit-tests with rather than beside it: an edit
 * derived from arithmetic that had drifted from the highlight would rename a
 * position the author never saw. `locateDatasets` says where an id may be
 * written, `exactRange` says which characters of that spell it, and this file
 * only decides whether the whole set can be replaced at once.
 *
 * "At once" is the whole of the contract. A rename that edited three of four
 * sites would leave a reference pointing at a dataset that no longer exists and
 * a document that renders worse than it did before, so every refusal below is
 * the same refusal: if any part cannot be done, none of it is.
 *
 * Ids are document-scoped (SPEC 6.3), so the `WorkspaceEdit` touches exactly the
 * one file that was asked about and no workspace is scanned.
 */

import { DATASET_ID_PATTERN, isDatasetId } from '@mdv/core';
import type { DatasetSite } from '@mdv/core';

import type { TextDocument } from '../documents.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type {
  PrepareRenameResult,
  Range,
  RenameParams,
  ServerCapabilities,
  TextDocumentPositionParams,
  TextEdit,
  WorkspaceEdit,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { datasetsAt, exactRange } from './dataset.js';
import { Sites } from './site.js';
import type { BlockSettings } from './site.js';

/** Accepted for symmetry with the other position features, and unused. */
export type RenameSettings = BlockSettings;

class Renames {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: RenameSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Rename');
  }

  listen(): void {
    this.#context.onRequest('textDocument/prepareRename', (params, token) =>
      this.#prepare(params as TextDocumentPositionParams, token),
    );
    this.#context.onRequest('textDocument/rename', (params, token) =>
      this.#rename(params as RenameParams, token),
    );
  }

  /**
   * Whether there is an id here, and which characters of the line it is.
   *
   * Answered before the author types anything, so it is also where a rename
   * that cannot be done is declined most cheaply: a client that is told `null`
   * says "you cannot rename this" and never opens the box, which is a better
   * end than an error thrown at a name already typed.
   */
  #prepare(
    params: TextDocumentPositionParams,
    token: CancellationToken,
  ): PrepareRenameResult | undefined {
    const document = this.#sites.document(params.textDocument.uri);
    const { sites, site } = datasetsAt(document, params.position, token);
    if (site === undefined) return undefined;

    const range = exactRange(document, site);
    if (range === undefined) return undefined;
    // The box would otherwise open on an id whose declaration cannot be edited,
    // and accepting it would strand every reference the rename did manage.
    if (this.#editable(document, sites, site.id) === undefined) return undefined;
    return { range, placeholder: site.id };
  }

  /** Every edit that renaming the id under the cursor to `newName` takes. */
  #rename(params: RenameParams, token: CancellationToken): WorkspaceEdit | undefined {
    const document = this.#sites.document(params.textDocument.uri);
    const { sites, site } = datasetsAt(document, params.position, token);
    if (site === undefined) {
      throw new ResponseErrorException(
        ErrorCodes.invalidParams,
        'There is no dataset id at this position',
      );
    }
    // An unchanged name is valid by construction — it came out of the document
    // — and an empty edit is still an edit, so there is nothing to send.
    if (site.id === params.newName) return undefined;
    this.#check(sites, site.id, params.newName);

    const ranges = this.#editable(document, sites, site.id);
    if (ranges === undefined) {
      throw new ResponseErrorException(
        ErrorCodes.requestFailed,
        `\`${site.id}\` is not written plainly enough to be renamed automatically`,
      );
    }

    const edits: TextEdit[] = ranges.map((range) => ({ range, newText: params.newName }));
    return { changes: { [params.textDocument.uri]: edits } };
  }

  /**
   * The characters to overwrite for every use of `id`, in source order, or
   * `undefined` if one of them cannot be cut out of the text as written.
   *
   * The unrangeable case is a front-matter key the parser could not position on
   * its own: the locator falls back to the value, which names a *different*
   * dataset, and overwriting that would replace the wrong id.
   */
  #editable(
    document: TextDocument,
    sites: readonly DatasetSite[],
    id: string,
  ): Range[] | undefined {
    const ranges: Range[] = [];
    for (const site of sites) {
      if (site.id !== id) continue;
      const range = exactRange(document, site);
      if (range === undefined) return undefined;
      ranges.push(range);
    }
    return ranges;
  }

  /**
   * Refuse a new name the document could not hold.
   *
   * An illegal id is dropped outright by `declareDatasets` (MDV1220), and a
   * second declaration of a name already taken shadows the first (MDV2140) —
   * both are renames whose result is a document that does not say what the
   * author meant, and both are cheaper to refuse than to undo.
   *
   * Re-pointing references is not a collision: a dangling `@sale` renamed to a
   * `sales` that exists declares nothing, and is the typo fix rename is for.
   */
  #check(sites: readonly DatasetSite[], id: string, newName: string): void {
    if (!isDatasetId(newName)) {
      throw new ResponseErrorException(
        ErrorCodes.requestFailed,
        `\`${newName}\` is not a valid dataset id — it must match \`${DATASET_ID_PATTERN.source}\` (SPEC 6.3)`,
      );
    }

    const declares = sites.some((site) => site.id === id && site.kind === 'declaration');
    const taken = sites.some((site) => site.id === newName && site.kind === 'declaration');
    if (declares && taken) {
      throw new ResponseErrorException(
        ErrorCodes.requestFailed,
        `This document already declares \`${newName}\``,
      );
    }
  }
}

/**
 * Install rename for dataset ids.
 *
 * ```ts
 * createServer(transport, { features: [rename()] });
 * ```
 */
export function rename(options: RenameSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new Renames(context, options);
    feature.listen();
    return { renameProvider: { prepareProvider: true } };
  };
}

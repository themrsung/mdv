/**
 * Rename a dataset id, or a column of one block (SPEC 29.4).
 *
 * Rename is find-references with the answer written back, so it is built on the
 * same modules `definition.ts` hit-tests with rather than beside them: an edit
 * derived from arithmetic that had drifted from the highlight would rename a
 * position the author never saw. `locateDatasets` and `locateColumns` say where
 * a name may be written, `exactRange` and `exactColumnRange` say which
 * characters of that spell it, and this file only decides whether the whole set
 * can be replaced at once.
 *
 * "At once" is the whole of the contract. A rename that edited three of four
 * sites would leave a reference pointing at something that no longer exists and
 * a document that renders worse than it did before, so every refusal below is
 * the same refusal: if any part cannot be done, none of it is.
 *
 * The two halves are asked in that order and never both: an id is written in a
 * dataset-bearing attribute, a column name in a channel, a transform argument or
 * the header row, and no position is both. Ids are document-scoped (SPEC 6.3)
 * and columns are block-scoped, so either way the `WorkspaceEdit` touches
 * exactly the one file that was asked about and no workspace is scanned.
 */

import { DATASET_ID_PATTERN, checkColumnName, isDatasetId } from '@mdv/core';
import type { ColumnLocation, DatasetSite } from '@mdv/core';

import type { TextDocument } from '../documents.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type {
  Position,
  PrepareRenameResult,
  Range,
  RenameParams,
  ServerCapabilities,
  TextDocumentPositionParams,
  TextEdit,
  WorkspaceEdit,
} from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { columnsAt, exactColumnRange } from './column.js';
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
    if (site === undefined) return this.#prepareColumn(document, params.position, token);

    const range = exactRange(document, site);
    if (range === undefined) return undefined;
    // The box would otherwise open on an id whose declaration cannot be edited,
    // and accepting it would strand every reference the rename did manage.
    if (this.#editable(document, sites, site.id) === undefined) return undefined;
    return { range, placeholder: site.id };
  }

  /** {@link #prepare} for a header column, asked where no id is written. */
  #prepareColumn(
    document: TextDocument,
    position: Position,
    token: CancellationToken,
  ): PrepareRenameResult | undefined {
    const { column, site } = columnsAt(document, position, token);
    if (column === undefined || site === undefined) return undefined;

    // `columnsAt` hit-tests on the resolved span, so a site it hands back has
    // one; this is the type's `undefined`, not a case that reaches an author.
    const range = exactColumnRange(document, site);
    if (range === undefined) return undefined;
    if (this.#columnRanges(document, column) === undefined) return undefined;
    return { range, placeholder: column.name };
  }

  /** Every edit that renaming the name under the cursor to `newName` takes. */
  #rename(params: RenameParams, token: CancellationToken): WorkspaceEdit | undefined {
    const document = this.#sites.document(params.textDocument.uri);
    const { sites, site } = datasetsAt(document, params.position, token);
    const edits =
      site === undefined
        ? this.#columnEdits(document, params, token)
        : this.#datasetEdits(document, sites, site, params.newName);

    if (edits === undefined) return undefined;
    return { changes: { [params.textDocument.uri]: edits } };
  }

  /** The dataset half: an id and every reference to it, across the document. */
  #datasetEdits(
    document: TextDocument,
    sites: readonly DatasetSite[],
    site: DatasetSite,
    newName: string,
  ): TextEdit[] | undefined {
    // An unchanged name is valid by construction — it came out of the document
    // — and an empty edit is still an edit, so there is nothing to send.
    if (site.id === newName) return undefined;
    this.#check(sites, site.id, newName);

    const ranges = this.#editable(document, sites, site.id);
    if (ranges === undefined) throw unwritable(site.id);
    return ranges.map((range) => ({ range, newText: newName }));
  }

  /**
   * The column half: a header cell and every reference to it, within the block.
   *
   * This is also where a position that names nothing at all lands, because the
   * column locator is the second of the two asked and so the last to say no.
   */
  #columnEdits(
    document: TextDocument,
    params: RenameParams,
    token: CancellationToken,
  ): TextEdit[] | undefined {
    const { map, column } = columnsAt(document, params.position, token);
    if (map === undefined || column === undefined) {
      throw new ResponseErrorException(
        ErrorCodes.invalidParams,
        'There is no dataset id or column name at this position',
      );
    }
    if (column.name === params.newName) return undefined;

    // What a column may be called is the grammar's business and depends on how
    // this block writes it — a bare name in an expression cannot become two
    // words — so the answer comes from `@mdv/core` and is passed on verbatim.
    const why = checkColumnName(map, column.name, params.newName);
    if (why !== undefined) throw new ResponseErrorException(ErrorCodes.requestFailed, why);

    const ranges = this.#columnRanges(document, column);
    if (ranges === undefined) throw unwritable(column.name);
    return ranges.map((range) => ({ range, newText: params.newName }));
  }

  /**
   * {@link #editable} for a column, or `undefined` if one use cannot be cut out
   * of the text as written.
   *
   * Sorted rather than taken in the locator's order: that order puts the header
   * cell first because it is the declaration, while in the source it comes last,
   * below the attributes that reference it. A client applying edits back to
   * front needs the source order, and the locator's is the reading order.
   */
  #columnRanges(document: TextDocument, column: ColumnLocation): Range[] | undefined {
    const ranges: Range[] = [];
    for (const site of column.sites) {
      const range = exactColumnRange(document, site);
      if (range === undefined) return undefined;
      ranges.push(range);
    }
    return ranges.sort(
      (a, b) => a.start.line - b.start.line || a.start.character - b.start.character,
    );
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
 * The one refusal both halves make: the name is there, and the characters that
 * spell it are not all reachable, so none of them are touched.
 */
function unwritable(name: string): ResponseErrorException {
  return new ResponseErrorException(
    ErrorCodes.requestFailed,
    `\`${name}\` is not written plainly enough to be renamed automatically`,
  );
}

/**
 * Install rename for dataset ids and column names.
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

/**
 * Inlay hints (SPEC 29.4).
 *
 * Two facts a reader of an MDV block cannot get from reading it, because both
 * are produced by running the pipeline:
 *
 * ```mdv bar                        2 rows
 * x: quarter
 * ---
 * quarter: string | revenue: number
 * Q1 | 1240.5
 * Q2 | 1510.25
 * ```
 *
 * *What type did inference decide this column is*, and *how many rows came out
 * the other end of the transforms*. The first is the question behind almost
 * every "why is my axis wrong": a `revenue` column with one stray `n/a` in it is
 * a `string`, the chart bins it as a category, and nothing in the document says
 * so. The second is the question behind "why is my chart empty": a `filter` that
 * matched nothing looks exactly like a `filter` that matched everything.
 *
 * Only *inferred* types are annotated. A type the author wrote in `fields:` is
 * already on the screen, and an editor that repeats it back is an editor with
 * noise in it — the hint appears precisely where MDV guessed, so its presence is
 * itself the information.
 *
 * Both numbers come from one table per block, the one that block resolved to,
 * so a hint cannot disagree with the chart beside it. Nothing here reads the
 * data section or counts a delimiter: `locateHeader` says which characters spell
 * a name, `Column.inferred` says whether the type was guessed, and `Table.rows`
 * says how many rows survived (SPEC 29.4 — the server owns no MDV semantics).
 */

import { DATASET_BLOCK, locateHeader, visualBlocks } from '@mdv/core';
import type { Column, ColumnSite, ResolvedDocument, Table } from '@mdv/core';
import type { MdvBlock } from '@mdv/parser';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { InlayHintKind } from '../protocol/types.js';
import type { InlayHint, InlayHintParams, ServerCapabilities } from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';
import { exactColumnRange } from './column.js';
import { Sites } from './site.js';
import type { BlockSettings } from './site.js';

/** Accepted for symmetry with the other block features, and unused. */
export type InlayHintSettings = BlockSettings;

/** A block that resolved to a table, and where in the document it is written. */
interface Resolved {
  readonly node: MdvBlock;
  /** The table this block resolved to, after its transforms. */
  readonly table: Table;
  /** Offsets of the whole fenced block, for the requested-range test. */
  readonly from: number;
  readonly to: number;
}

class InlayHints {
  readonly #context: ServerContext;
  readonly #sites: Sites;

  constructor(context: ServerContext, options: InlayHintSettings) {
    this.#context = context;
    this.#sites = new Sites(context, options, 'Inlay hints');
  }

  listen(): void {
    this.#context.onRequest('textDocument/inlayHint', (params, token) =>
      this.#hints(params as InlayHintParams, token),
    );
  }

  /**
   * Every hint the requested range contains.
   *
   * The client asks about the lines it is showing, and asks again on every
   * scroll, so the range is the whole of the throttling this feature gets: one
   * resolve per request, and the blocks outside the range never looked at.
   */
  #hints(params: InlayHintParams, token: CancellationToken): InlayHint[] | null {
    const document = this.#sites.document(params.textDocument.uri);
    const resolved = this.#sites.all(document, token);
    if (resolved === undefined) return null;

    const from = document.offsetAt(params.range.start);
    const to = document.offsetAt(params.range.end);
    const hints: InlayHint[] = [];
    for (const block of tables(resolved)) {
      throwIfCancelled(token);
      if (block.to < from || to < block.from) continue;
      for (const hint of blockHints(document, block)) {
        const offset = document.offsetAt(hint.position);
        if (from <= offset && offset <= to) hints.push(hint);
      }
    }
    return hints;
  }
}

/**
 * Each block that has a table, paired with it.
 *
 * Two walks because there are two kinds of block and only one of them is a
 * `ResolvedBlock`: a `dataset` block declares data and draws nothing, so stage 2
 * files it in the registry and it never reaches `blocks`. Its rows are worth
 * counting all the same — a dataset the whole document reads is the block a
 * surprising row count matters most in.
 *
 * A table with nothing in it at all is skipped: that is what an unresolvable
 * dataset leaves behind, and `0 rows` beside the error card is a second
 * complaint about the first one. A block that failed with a table still
 * standing keeps its hints — a transform step MDV would not run hands its input
 * straight on (`MDV2500`), so the block shows an error card over rows that are
 * perfectly real, and what those rows are is the first thing anyone reading the
 * error wants to know. Going quiet there would take the answer away at the
 * moment it is being looked for.
 */
function* tables(resolved: ResolvedDocument): Generator<Resolved> {
  for (const block of resolved.blocks) {
    if (empty(block.table)) continue;
    const located = locate(block.node);
    if (located !== undefined) yield { ...located, table: block.table };
  }
  for (const node of visualBlocks(resolved.ast)) {
    if (node.blockType !== DATASET_BLOCK) continue;
    const id = node.attrs['id'];
    if (typeof id !== 'string') continue;
    const dataset = resolved.datasets.get(id);
    // `declared`, `loading`, `blocked` and `failed` have no table to count.
    if (dataset?.state !== 'ready' || dataset.table === undefined) continue;
    if (empty(dataset.table)) continue;
    const located = locate(node);
    if (located !== undefined) yield { ...located, table: dataset.table };
  }
}

/** No fields and no rows: the shape of a table that was never read. */
function empty(table: Table): boolean {
  return table.fields.length === 0 && table.rows.length === 0;
}

/** A block the parser gave no position is a block nothing can be placed in. */
function locate(node: MdvBlock): { node: MdvBlock; from: number; to: number } | undefined {
  const from = node.position?.start.offset;
  const to = node.position?.end.offset;
  if (from === undefined || to === undefined) return undefined;
  return { node, from, to };
}

/**
 * The row count, then a type per header cell that got one.
 *
 * The count goes at the end of the info string rather than beside the data,
 * because it is the one hint every block can have: a block that reads `@sales`,
 * or writes its rows as JSON, has no header line to hang anything off and is
 * exactly the block whose row count is hardest to work out by eye.
 */
function* blockHints(document: TextDocument, block: Resolved): Generator<InlayHint> {
  const line = document.positionAt(block.from).line;
  yield {
    position: { line, character: document.lineText(line).length },
    label: rows(block.table.rows.length),
    paddingLeft: true,
  };
  yield* typeHints(document, block.node, block.table.fields);
}

/**
 * `: number` after the header cell that resolved to a `number` column.
 *
 * Paired by name and not by position, because a `select` or a `rename` between
 * the header row and the table reorders and drops columns, and the cell that
 * *used* to be third is not the third field. A name with no field is a column
 * the pipeline removed, and it gets no hint rather than the next one's type.
 */
function* typeHints(
  document: TextDocument,
  node: MdvBlock,
  fields: readonly Column[],
): Generator<InlayHint> {
  const header = locateHeader(node);
  if (header === undefined) return;
  const once = spelledOnce(header.cells);
  for (const cell of header.cells) {
    if (!once.has(cell.name)) continue;
    const field = fields.find((candidate) => candidate.name === cell.name);
    if (field?.inferred !== true) continue;
    const range = exactColumnRange(document, cell);
    if (range === undefined) continue;
    yield { position: range.end, label: `: ${field.type}`, kind: InlayHintKind.type };
  }
}

/**
 * The names that appear exactly once, which are the ones a hint can be trusted
 * beside.
 *
 * A header that repeats a name is `MDV2110`, and the repeats become `x_2` and
 * `x_3` in the table — so the second `x` on the line and the `x` field are not
 * the same column, and no arithmetic here can tell which cell became which
 * without re-deciding a question `@mdv/core` already decided. Empty cells are
 * dropped for the same reason: there is nothing to annotate.
 */
function spelledOnce(cells: readonly ColumnSite[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const cell of cells) counts.set(cell.name, (counts.get(cell.name) ?? 0) + 1);
  const once = new Set<string>();
  for (const [name, count] of counts) {
    if (count === 1 && name !== '') once.add(name);
  }
  return once;
}

function rows(count: number): string {
  return count === 1 ? '1 row' : `${String(count)} rows`;
}

/**
 * Install inlay hints for inferred column types and resolved row counts.
 *
 * ```ts
 * createServer(transport, { features: [inlay()] });
 * ```
 */
export function inlay(options: InlayHintSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    const feature = new InlayHints(context, options);
    feature.listen();
    return { inlayHintProvider: true };
  };
}

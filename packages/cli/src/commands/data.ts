/**
 * `mdv data` (SPEC 27).
 *
 * ```text
 * mdv data report.mdv --block revenue --to csv
 * mdv data report.mdv --to json | jq '.rows[0]'
 * ```
 *
 * Prints the table a block actually renders from — after `src:`, after the
 * transforms, after type inference — which is the fastest way to answer "why is
 * this chart empty?".
 */

import type { GlobalFlags } from '../args.js';
import { usageError } from '../exit.js';
import type { CliIo } from '../io.js';
import { loadDocument, outcomeFor, singleInput } from '../pipeline.js';
import { selectBlock } from '../scene.js';
import { tableToCsv, tableToJson, tableToText } from '../table.js';
import { createTerm } from '../term.js';

/** Flags `mdv data` accepts on top of the global ones. */
export interface DataFlags extends GlobalFlags {
  block?: string;
  to?: string;
}

/** `mdv data` — print a block's resolved table. */
export async function dataCommand(
  io: CliIo,
  files: readonly string[],
  flags: DataFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const input = singleInput(files, 'data');
  const loaded = await loadDocument(io, flags, input, term);

  if (loaded.resolved.blocks.length === 0) {
    throw usageError(`${loaded.display} has no visual blocks`, 'There is no table to print.');
  }

  // No `--block` means the first one, which is the common case for a document
  // written to hold a single chart.
  const block = selectBlock(loaded.resolved, flags.block ?? '0');
  const to = flags.to ?? (io.isTty ? 'text' : 'csv');

  switch (to) {
    case 'csv':
      term.out(tableToCsv(block.table));
      break;
    case 'json':
      term.out(tableToJson(block.table));
      break;
    case 'text':
      term.out(tableToText(block.table));
      break;
    default:
      throw usageError(`Unknown --to \`${to}\` for mdv data`, '--to accepts csv, json, text');
  }

  term.status(
    `${loaded.display}: block \`${block.id}\` (${block.blockType}), ` +
      `${block.table.rows.length} row${block.table.rows.length === 1 ? '' : 's'} × ${block.table.fields.length} field${block.table.fields.length === 1 ? '' : 's'}`,
  );
  return outcomeFor(loaded, term);
}

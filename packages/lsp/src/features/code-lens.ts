/**
 * Code lenses above each block (SPEC 29.4).
 *
 * A grey row above every fenced block:
 *
 * > `Preview` · `Export PNG` · `Export SVG` · `Show data`
 *
 * A lens is the one piece of editor UI that is *about a block* rather than
 * about the cursor, and that is the whole of the design problem here. The
 * author clicks `Show data` above the third chart without going near it, so a
 * command that meant "the block the cursor is in" would open the first chart's
 * table and look, from the outside, like the lens had lied. Every lens
 * therefore carries the document it came from and a position inside its own
 * block — the point-in-a-block lookup the position features already do — and no
 * lens depends on where the caret happens to be.
 *
 * Nothing here resolves the document. The row of lenses is the same four
 * commands for every block, so running the pipeline would buy no different
 * answer, and it would buy one bad behaviour: lenses that come and go while the
 * author is mid-edit and the pipeline cannot finish. A block that fails to
 * resolve is precisely the block whose `Show data` is wanted, and a client asks
 * for lenses again on every change, so this stays a parse and a walk.
 *
 * The command ids are settings with SPEC 29.5's defaults, because this server
 * does not implement any of them — it names them. A host whose commands live
 * under another prefix renames them; a host that cannot do one of them at all
 * passes `false` and the lens is left out, which is better than a lens that
 * only ever explains why it does nothing. (That case is real: the VS Code
 * extension in this tree has no PNG export.)
 *
 * There is no `enable` setting to match SPEC 29.6's `mdv.codeLens.enable`. A
 * feature that is installed and always answers with nothing still costs a round
 * trip per change; a host that wants lenses off leaves {@link codeLens} out of
 * its feature list, which is the same thing the extension does by disposing the
 * provider.
 */

import { DATASET_BLOCK, visualBlocks } from '@mdv/core';
import { parse } from '@mdv/parser';
import type { MdvBlock } from '@mdv/parser';

import type { TextDocument } from '../documents.js';
import { throwIfCancelled } from '../protocol/connection.js';
import type { CancellationToken } from '../protocol/connection.js';
import { ErrorCodes, ResponseErrorException } from '../protocol/jsonrpc.js';
import type { CodeLens, CodeLensParams, Position, ServerCapabilities } from '../protocol/types.js';
import type { Feature, ServerContext } from '../server.js';

/** The four lenses SPEC 29.4 names, in the order it names them. */
export type LensName = 'preview' | 'exportPng' | 'exportSvg' | 'showData';

/**
 * Which command each lens invokes: an id, or `false` to leave that lens out.
 *
 * Omitting a key takes {@link CODE_LENS_COMMANDS}; `false` is how a host says
 * it has no such command, which is not the same thing.
 */
export type CodeLensCommands = {
  readonly [Name in LensName]?: string | false;
};

export interface CodeLensSettings {
  readonly commands?: CodeLensCommands;
}

/**
 * SPEC 29.5's ids, as far as they go.
 *
 * `Preview` opens beside rather than over: the lens was clicked from inside the
 * editor, and a preview that replaced that editor would take away the thing the
 * author was looking at. Both exports are `mdv.exportBlock` — "Export Block as
 * Image", the only per-block export SPEC 29.5 has — and which image is the
 * lens's third argument, because one command with two lenses above it has to
 * say somewhere which one was pressed.
 */
export const CODE_LENS_COMMANDS: Readonly<Record<LensName, string>> = {
  preview: 'mdv.showPreviewToSide',
  exportPng: 'mdv.exportBlock',
  exportSvg: 'mdv.exportBlock',
  showData: 'mdv.showData',
};

/** The title each lens shows, verbatim from the SPEC 29.4 row. */
const TITLES: Readonly<Record<LensName, string>> = {
  preview: 'Preview',
  exportPng: 'Export PNG',
  exportSvg: 'Export SVG',
  showData: 'Show data',
};

/** The extra argument the export lenses carry; the other two have none. */
const FORMATS: Readonly<Partial<Record<LensName, string>>> = {
  exportPng: 'png',
  exportSvg: 'svg',
};

/** The ids in force, with a lens the host disowned left out entirely. */
type Ids = Readonly<Partial<Record<LensName, string>>>;

class CodeLenses {
  readonly #context: ServerContext;
  /** Resolved once: settings are fixed for the life of the server. */
  readonly #ids: Ids;

  constructor(context: ServerContext, options: CodeLensSettings) {
    this.#context = context;
    this.#ids = idsOf(options.commands ?? {});
  }

  listen(): void {
    this.#context.onRequest('textDocument/codeLens', (params, token) =>
      this.#lenses(params as CodeLensParams, token),
    );
  }

  /** `textDocument/codeLens`: one row of lenses per block, in document order. */
  #lenses(params: CodeLensParams, token: CancellationToken): CodeLens[] {
    const uri = params.textDocument.uri;
    const document = this.#document(uri);
    const parsed = parse(document.text);
    // The parse is the whole cost; a client that has moved on is told here.
    throwIfCancelled(token);

    const lenses: CodeLens[] = [];
    for (const node of visualBlocks(parsed)) {
      const at = anchor(document, node);
      if (at === undefined) continue;
      lenses.push(...row(uri, at, node.blockType, this.#ids));
    }
    return lenses;
  }

  /** As everywhere else here, only an open document is answered for. */
  #document(uri: string): TextDocument {
    const document = this.#context.documents.get(uri);
    if (document === undefined) {
      throw new ResponseErrorException(ErrorCodes.invalidParams, `No open document at \`${uri}\``);
    }
    return document;
  }
}

/**
 * The point the lenses hang off: the first character of the opening fence.
 *
 * Not column 0 of that line. A block indented into a list item or quoted with
 * `>` shares its line with somebody else's syntax, and a range that started at
 * the margin would claim it. A block the parser gave no position is a block
 * nothing can be placed above, and it is skipped rather than anchored at the
 * top of the file.
 */
function anchor(document: TextDocument, node: MdvBlock): Position | undefined {
  const offset = node.position?.start.offset;
  if (offset === undefined) return undefined;
  return document.positionAt(offset);
}

/**
 * One block's lenses.
 *
 * They share a range, which is how a client knows to draw them as one row
 * rather than four.
 *
 * A `dataset` block gets `Show data` and nothing else. It declares rows for the
 * rest of the document to read and draws no picture of its own, so `Preview`
 * and the two exports would be lenses over an empty image — while its table is
 * the one thing about it worth opening.
 */
function* row(uri: string, at: Position, blockType: string, ids: Ids): Generator<CodeLens> {
  const range = { start: at, end: at };
  const names: readonly LensName[] =
    blockType === DATASET_BLOCK ? ['showData'] : ['preview', 'exportPng', 'exportSvg', 'showData'];

  for (const name of names) {
    const command = ids[name];
    if (command === undefined) continue;
    const format = FORMATS[name];
    const where = [uri, at];
    yield {
      range,
      command: {
        title: TITLES[name],
        command,
        arguments: format === undefined ? where : [...where, format],
      },
    };
  }
}

function idsOf(commands: CodeLensCommands): Ids {
  const ids: Partial<Record<LensName, string>> = {};
  for (const name of Object.keys(TITLES) as LensName[]) {
    const setting = commands[name];
    if (setting === false) continue;
    ids[name] = setting ?? CODE_LENS_COMMANDS[name];
  }
  return ids;
}

/**
 * Install code lenses above every block.
 *
 * ```ts
 * createServer(transport, { features: [codeLens({ commands: { exportPng: false } })] });
 * ```
 */
export function codeLens(options: CodeLensSettings = {}): Feature {
  return (context): Partial<ServerCapabilities> => {
    new CodeLenses(context, options).listen();
    // Every lens arrives with its command already on it, so there is nothing
    // for `codeLens/resolve` to fill in later.
    return { codeLensProvider: { resolveProvider: false } };
  };
}

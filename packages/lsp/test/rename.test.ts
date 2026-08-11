/**
 * Renaming a dataset id, checked by doing it (SPEC 29.4).
 *
 * A `WorkspaceEdit` asserted as a list of ranges is a test that goes green while
 * the document it edits turns to nonsense, so almost nothing here looks at the
 * edits: they are applied to the fixture and the resulting *document* is what is
 * written down. That is also the only way to state the claim that matters — that
 * `"@sales[date, revenue]"` keeps its quotes and its projection.
 *
 * No chart registry is installed, for the reason `definition.test.ts` gives:
 * where an id may be written is grammar, not configuration.
 */

import { describe, expect, it } from 'vitest';
import { rename } from '../src/features/rename.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type {
  InitializeResult,
  Position,
  PrepareRenameResult,
  Range,
  WorkspaceEdit,
} from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** Where the cursor is. Stripped from the fixture before the server sees it. */
const CURSOR = '‸';

/**
 * `sales` is declared long-hand and used twice — once inside a projection, which
 * is the value a careless rename would flatten — and `q1` is the front-matter
 * shorthand that declares one id while referring to another on the same line.
 */
const DOC = [
  '---',
  'mdv: "1.0"',
  'datasets:',
  '  sales:',
  '    src: sales.csv',
  '  q1: "@sales[date, revenue]"',
  '---',
  '',
  '# Report',
  '',
  '```mdv line',
  'data: "@q1"',
  'x: date',
  '```',
  '',
  '```mdv bar',
  'from: "@sales"',
  'x: date',
  '```',
  '',
].join('\n');

/** A server with rename installed, past the handshake. */
async function started(): Promise<{ client: TestClient; result: InitializeResult }> {
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: () => {} },
    features: [rename()],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, result };
}

/** A fixture with its cursor marker removed, and the position it marked. */
function at(source: string): { text: string; position: Position } {
  const offset = source.indexOf(CURSOR);
  if (offset === -1) throw new Error(`the fixture has no ${CURSOR}`);
  const before = source.slice(0, offset);
  return {
    text: before + source.slice(offset + CURSOR.length),
    position: {
      line: before.split('\n').length - 1,
      character: offset - (before.lastIndexOf('\n') + 1),
    },
  };
}

/** Open the fixture and ask at the marker. */
async function asking(source: string, method: string, extra: object = {}): Promise<unknown> {
  const { text, position } = at(source);
  const { client } = await started();
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  return client.call(method, { textDocument: { uri: URI }, position, ...extra });
}

function prepareAt(source: string): Promise<PrepareRenameResult | null> {
  return asking(source, 'textDocument/prepareRename') as Promise<PrepareRenameResult | null>;
}

function renameAt(source: string, newName: string): Promise<WorkspaceEdit | null> {
  return asking(source, 'textDocument/rename', { newName }) as Promise<WorkspaceEdit | null>;
}

/** The error a refused rename came back with. */
async function refusalAt(
  source: string,
  newName: string,
): Promise<{ code?: number; message?: string }> {
  const { text, position } = at(source);
  const { client } = await started();
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  const response = await client.request('textDocument/rename', {
    textDocument: { uri: URI },
    position,
    newName,
  });
  return response.error ?? {};
}

/** Offset of an LSP position in `text`, the whole document being one line list. */
function offsetOf(text: string, position: Position): number {
  const lines = text.split('\n');
  return (
    lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) +
    position.character
  );
}

/** The text a range selects, which is what the author sees highlighted. */
function covered(source: string, range: Range): string {
  const text = source.replace(CURSOR, '');
  return text.slice(offsetOf(text, range.start), offsetOf(text, range.end));
}

/**
 * The document as the client would leave it.
 *
 * Applied back to front so that an earlier edit's ranges stay true, which is
 * also the check that the server sent them in source order — they are reversed
 * as they arrive, not sorted.
 */
function applied(source: string, edit: WorkspaceEdit | null): string {
  const text = source.replace(CURSOR, '');
  const edits = edit?.changes?.[URI] ?? [];
  let out = text;
  for (const one of [...edits].reverse()) {
    const start = offsetOf(text, one.range.start);
    const end = offsetOf(text, one.range.end);
    if (end > out.length || out.slice(0, start) !== text.slice(0, start)) {
      throw new Error('edits are not in source order');
    }
    out = out.slice(0, start) + one.newText + out.slice(end);
  }
  return out;
}

describe('textDocument/rename', () => {
  it('advertises that it wants to be asked first', async () => {
    const { result } = await started();
    // Without `prepareProvider` a client renames whatever word it finds under
    // the cursor, which in `"@sales[date, revenue]"` is not the id.
    expect(result.capabilities.renameProvider).toEqual({ prepareProvider: true });
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const { client } = await started();
    for (const method of ['textDocument/prepareRename', 'textDocument/rename']) {
      const response = await client.request(method, {
        textDocument: { uri: 'file:///gone.mdv' },
        position: { line: 0, character: 0 },
        newName: 'costs',
      });
      expect(response.error?.code).toBe(ErrorCodes.invalidParams);
      expect(response.error?.message).toContain('file:///gone.mdv');
    }
  });

  it('offers the id alone, and fills the box with it', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    const prepared = await prepareAt(source);
    expect(covered(source, prepared?.range as Range)).toBe('sales');
    expect(prepared?.placeholder).toBe('sales');
  });

  it('declines where nothing is named', async () => {
    expect(await prepareAt(DOC.replace('# Report', '# Rep‸ort'))).toBeNull();
    // A field name is a name, but it is not a dataset id, and the column half
    // of rename is a different question asked of a different locator.
    expect(
      await prepareAt(DOC.replace('from: "@sales"\nx: date', 'from: "@sales"\nx: da‸te')),
    ).toBeNull();
  });

  it('rewrites the declaration and every use, from a use', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    expect(applied(source, await renameAt(source, 'turnover'))).toBe(
      DOC.replace('  sales:', '  turnover:')
        .replace('"@sales[date, revenue]"', '"@turnover[date, revenue]"')
        .replace('from: "@sales"', 'from: "@turnover"'),
    );
  });

  it('rewrites the same set from the declaration', async () => {
    const from = DOC.replace('  sales:', '  sa‸les:');
    const use = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    // Rename is find-references with the answer written back, so where the
    // author started it cannot change what it does.
    expect(applied(from, await renameAt(from, 'turnover'))).toBe(
      applied(use, await renameAt(use, 'turnover')),
    );
  });

  it('leaves the value alone when the key is what is being renamed', async () => {
    const source = DOC.replace('  q1: "@sales', '  q‸1: "@sales');
    // One line, two ids: `q1` is worn by the key and `sales` by the value.
    expect(applied(source, await renameAt(source, 'first'))).toBe(
      DOC.replace('  q1: "@sales', '  first: "@sales').replace('data: "@q1"', 'data: "@first"'),
    );
  });

  it('does nothing when the name has not changed', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    // An empty edit still marks a file dirty, and a client that asked for a
    // rename to the same name has nothing it wants saved.
    expect(await renameAt(source, 'sales')).toBeNull();
  });

  it('refuses a name that is not a dataset id', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    // `declareDatasets` drops an id that fails the pattern (MDV1220), so the
    // rename would delete the dataset rather than move it.
    const error = await refusalAt(source, '2024 sales');
    expect(error.code).toBe(ErrorCodes.requestFailed);
    expect(error.message).toContain('2024 sales');
  });

  it('refuses a name the document already declares', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    // Two declarations of one id shadow rather than merge (MDV2140), and the
    // author would be left with a chart reading rows it never asked for.
    const error = await refusalAt(source, 'q1');
    expect(error.code).toBe(ErrorCodes.requestFailed);
    expect(error.message).toContain('q1');
  });

  it('allows a dangling reference to be pointed at a dataset that exists', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sale‸"');
    // Nothing declares `sale`, so nothing is being declared twice — this is the
    // typo fix rename exists for, and refusing it would be the collision rule
    // applied where there is no collision.
    expect(applied(source, await renameAt(source, 'sales'))).toBe(DOC);
  });

  it('renames an id a block declares bare', async () => {
    const source = [
      '```mdv dataset',
      'id: co‸sts',
      '---',
      'date,cost',
      '2026-01-01,1',
      '```',
      '',
      '```mdv line',
      'data: "@costs"',
      '```',
      '',
    ].join('\n');
    expect(applied(source, await renameAt(source, 'spend'))).toBe(
      source.replace(CURSOR, '').replace('id: costs', 'id: spend').replace('"@costs"', '"@spend"'),
    );
  });

  it('reads the transform pipeline, where a join names its other side', async () => {
    const source = [
      '```mdv dataset',
      'id: costs',
      '---',
      'date,cost',
      '2026-01-01,1',
      '```',
      '',
      '```mdv line',
      'data: rows.csv',
      'transform:',
      '  - join:',
      '      with: "@co‸sts"',
      '      on: date',
      '```',
      '',
    ].join('\n');
    expect(applied(source, await renameAt(source, 'spend'))).toBe(
      source.replace(CURSOR, '').replace('id: costs', 'id: spend').replace('"@costs"', '"@spend"'),
    );
  });

  it('has the protocol’s answer for a rename asked of prose', async () => {
    const error = await refusalAt(DOC.replace('# Report', '# Rep‸ort'), 'costs');
    // `prepareRename` already said no; a client that asked anyway gets told
    // what it did wrong rather than an empty edit it would apply happily.
    expect(error.code).toBe(ErrorCodes.invalidParams);
  });
});

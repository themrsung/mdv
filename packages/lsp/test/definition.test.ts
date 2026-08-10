/**
 * Go to definition and find references, from where the author is sitting
 * (SPEC 29.4).
 *
 * Every assertion here is about *text*: a location is checked by slicing the
 * fixture with the range that came back, because a range asserted as a pair of
 * numbers stays green while the document underneath it moves. What the author
 * sees selected is the whole claim of both requests, so that is what is written
 * down.
 *
 * No chart registry is installed. Where an id may be written is grammar — the
 * parser's, published by `locateDatasets` — and a feature that needed a plugin
 * to find a `from:` would be deciding something that is not its to decide.
 */

import { describe, expect, it } from 'vitest';
import { definition } from '../src/features/definition.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { InitializeResult, Location, Position, Range } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** Where the cursor is. Stripped from the fixture before the server sees it. */
const CURSOR = '‸';

/**
 * Two declarations and three references, which is enough for every direction:
 * `sales` is declared long-hand and used twice, `q1` is the front-matter
 * shorthand that is a declaration and a reference at once, and the `line`
 * block's `x: date` is a field name that no one should jump from.
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

/** A server with definition installed, past the handshake. */
async function started(): Promise<{ client: TestClient; result: InitializeResult }> {
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: () => {} },
    features: [definition()],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, result };
}

/** Open `source` with its cursor marker removed, and ask at the marker. */
async function asking(source: string, method: string, context?: unknown): Promise<unknown> {
  const offset = source.indexOf(CURSOR);
  if (offset === -1) throw new Error(`the fixture has no ${CURSOR}`);
  const text = source.slice(0, offset) + source.slice(offset + CURSOR.length);
  const before = source.slice(0, offset);
  const position: Position = {
    line: before.split('\n').length - 1,
    character: offset - (before.lastIndexOf('\n') + 1),
  };

  const { client } = await started();
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  return client.call(method, {
    textDocument: { uri: URI },
    position,
    ...(context === undefined ? {} : { context }),
  });
}

function definitionAt(source: string): Promise<Location | null> {
  return asking(source, 'textDocument/definition') as Promise<Location | null>;
}

function referencesAt(source: string, includeDeclaration = false): Promise<Location[]> {
  return asking(source, 'textDocument/references', { includeDeclaration }) as Promise<Location[]>;
}

/** The text a range selects, which is what the author will see highlighted. */
function covered(source: string, range: Range): string {
  const text = source.replace(CURSOR, '');
  const lines = text.split('\n');
  const at = (position: Position): number =>
    lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) +
    position.character;
  return text.slice(at(range.start), at(range.end));
}

/** Every location as `line: selected text`, in the order the server sent them. */
function listing(source: string, locations: readonly Location[]): string[] {
  return locations.map(
    (location) => `${location.range.start.line}: ${covered(source, location.range)}`,
  );
}

/** The line `needle` is written on, so a jump can be checked against the source. */
function lineOf(source: string, needle: string): number {
  return source
    .replace(CURSOR, '')
    .split('\n')
    .findIndex((line) => line.includes(needle));
}

describe('textDocument/definition', () => {
  it('is advertised in both directions, which is one feature', async () => {
    const { result } = await started();
    expect(result.capabilities.definitionProvider).toBe(true);
    expect(result.capabilities.referencesProvider).toBe(true);
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const { client } = await started();
    for (const method of ['textDocument/definition', 'textDocument/references']) {
      const response = await client.request(method, {
        textDocument: { uri: 'file:///gone.mdv' },
        position: { line: 0, character: 0 },
        context: { includeDeclaration: true },
      });
      expect(response.error?.code).toBe(ErrorCodes.invalidParams);
      expect(response.error?.message).toContain('file:///gone.mdv');
    }
  });

  it('jumps from a reference to the declaration that owns the id', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    const found = await definitionAt(source);
    expect(found?.uri).toBe(URI);
    // `sales` is declared long-hand, and the parser ranges a mapping at its
    // value, so the jump lands on the body of the declaration rather than on
    // the key it is filed under. It is the right line either way.
    expect(found?.range.start.line).toBe(lineOf(source, 'src: sales.csv'));
  });

  it('selects the id, not the value that carries it', async () => {
    const source = DOC.replace('data: "@q1"', 'data: "@q1‸"');
    const found = await definitionAt(source);
    // The alias is a declaration written as a reference: the id is worn by the
    // key, which nothing ranges, so the value it aliases is the best there is.
    expect(covered(source, found?.range as Range)).toBe('"@sales[date, revenue]"');

    const uses = await referencesAt(source);
    // A reference, though, knows exactly where its id sits inside the quotes —
    // selecting `"@q1"` would tell an author their dataset is five characters.
    expect(listing(source, uses)).toEqual([`${lineOf(source, 'data:')}: q1`]);
  });

  it('answers a cursor standing on a declaration with itself', async () => {
    const source = [
      '```mdv dataset',
      'id: co‸sts',
      '---',
      'date,cost',
      '2026-01-01,1',
      '```',
      '',
    ].join('\n');
    const found = await definitionAt(source);
    // Which is what a client that peeks rather than jumps expects, and is how
    // "is this the declaration that wins?" gets asked of a duplicated id.
    expect(found?.range.start.line).toBe(lineOf(source, 'id: costs'));
    expect(covered(source, found?.range as Range)).toBe('costs');
  });

  it('says nothing where no id is written', async () => {
    const source = DOC.replace('# Report', '# Rep‸ort');
    expect(await definitionAt(source)).toBeNull();
    expect(await referencesAt(source)).toEqual([]);
  });

  it('says nothing about a key that holds a field name', async () => {
    const source = DOC.replace('from: "@sales"\nx: date', 'from: "@sales"\nx: da‸te');
    expect(await definitionAt(source)).toBeNull();
  });

  it('gives a duplicated id to the later declaration (SPEC 6.3)', async () => {
    const source = [
      '---',
      'datasets:',
      '  costs:',
      '    src: old.csv',
      '---',
      '',
      '```mdv dataset',
      'id: costs',
      '---',
      'date,cost',
      '2026-01-01,1',
      '```',
      '',
      '```mdv line',
      'data: "@co‸sts"',
      '```',
      '',
    ].join('\n');
    const found = await definitionAt(source);
    // The reader sees the block, because the later declaration wins, so the
    // author had better be sent to the one the renderer will read.
    expect(found?.range.start.line).toBe(lineOf(source, 'id: costs'));
    expect(covered(source, found?.range as Range)).toBe('costs');
  });

  it('lists every use of the id under the cursor, in source order', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    // Including the one the cursor is in: a client counts the list, and an
    // author who is about to rename wants the count to be the whole truth.
    expect(listing(source, await referencesAt(source))).toEqual([
      `${lineOf(source, 'q1:')}: sales`,
      `${lineOf(source, 'from:')}: sales`,
    ]);
  });

  it('adds the declaration when the client asks for it', async () => {
    const source = DOC.replace('from: "@sales"', 'from: "@sa‸les"');
    const uses = await referencesAt(source, true);
    expect(uses.map((use) => use.range.start.line)).toEqual([
      lineOf(source, 'src: sales.csv'),
      lineOf(source, 'q1:'),
      lineOf(source, 'from:'),
    ]);
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
    const found = await definitionAt(source);
    expect(found?.range.start.line).toBe(lineOf(source, 'id: costs'));
  });
});

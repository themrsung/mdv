/**
 * Semantic tokens, read back as the characters they paint (SPEC 29.4, 29.7).
 *
 * A token on the wire is five integers relative to the token before it, which
 * is unreadable and — more to the point — untestable by inspection: a suite that
 * asserted the integers would pass just as happily on a document where every
 * token had slipped one line. So almost everything here decodes the deltas back
 * into *the text under each range*, and asserts that. If the arithmetic drifts,
 * the assertion reads `uarter` and says so.
 *
 * One test does assert the raw array, because the decoder shares its
 * understanding of the format with the encoder and two wrongs would agree.
 *
 * The feature's whole claim is a negative one — that it paints a name only when
 * MDV knows what the name means — so the fixtures are mostly built around names
 * that look right and are not: a channel naming a column that does not exist, a
 * reference to a dataset nobody declares.
 */

import { describe, expect, it } from 'vitest';
import { TOKEN_MODIFIERS, TOKEN_TYPES, semanticTokens } from '../src/features/semantic-tokens.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { InitializeResult, SemanticTokens } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** A `bar` block over its own table: one channel, two columns, one row. */
const BLOCK = ['```mdv bar', 'x: quarter', '---', 'quarter | revenue', 'Q1 | 1240', '```', ''];

/** A `dataset` block, which declares `sales` for the rest of the document. */
const DATASET = ['```mdv dataset id=sales', '---', 'region | units', 'APAC | 1204', '```', ''];

/** One decoded token: where it is, what it covers, and what it was called. */
interface Painted {
  readonly line: number;
  readonly character: number;
  /** The source the token's range covers, which is the point of the token. */
  readonly text: string;
  readonly type: string;
  readonly modifiers: readonly string[];
}

/** A server with semantic tokens installed, past the handshake. */
async function started(): Promise<TestClient> {
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: () => {} },
    features: [semanticTokens()],
  });
  server.listen();
  await client.call('initialize', INITIALIZE_PARAMS);
  client.notify('initialized', {});
  await settle();
  return client;
}

/** Open `source` and ask for its tokens, still encoded. */
async function data(source: string): Promise<readonly number[]> {
  const client = await started();
  client.notify('textDocument/didOpen', openParams(URI, source));
  await settle();
  const found = (await client.call('textDocument/semanticTokens/full', {
    textDocument: { uri: URI },
  })) as SemanticTokens;
  return found.data;
}

/** Undo the delta encoding, and cut each token out of the document. */
function decode(source: string, encoded: readonly number[]): Painted[] {
  const lines = source.split('\n');
  const painted: Painted[] = [];
  let line = 0;
  let character = 0;

  for (let at = 0; at + 4 < encoded.length; at += 5) {
    const deltaLine = encoded[at] as number;
    const deltaStart = encoded[at + 1] as number;
    const length = encoded[at + 2] as number;
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;
    painted.push({
      line,
      character,
      text: (lines[line] ?? '').slice(character, character + length),
      type: TOKEN_TYPES[encoded[at + 3] as number] ?? '?',
      modifiers: TOKEN_MODIFIERS.filter(
        (_, bit) => ((encoded[at + 4] as number) & (1 << bit)) !== 0,
      ),
    });
  }
  return painted;
}

/** Every token of `source`, decoded. */
async function tokens(source: string): Promise<Painted[]> {
  return decode(source, await data(source));
}

/** The tokens as a theme applies them: `text:type.modifier`, in document order. */
async function painted(source: string): Promise<string[]> {
  return (await tokens(source)).map(
    (token) => `${token.text}:${[token.type, ...token.modifiers].join('.')}`,
  );
}

describe('textDocument/semanticTokens/full', () => {
  it('publishes the legend it indexes into, and offers whole documents only', async () => {
    const { client, server: transport } = duplex();
    const server = createServer(transport, {
      version: '0.0.0',
      logger: { info: () => {}, error: () => {} },
      features: [semanticTokens()],
    });
    server.listen();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.semanticTokensProvider).toEqual({
      legend: { tokenTypes: ['namespace', 'variable'], tokenModifiers: ['declaration'] },
      full: true,
    });
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const client = await started();
    const response = await client.request('textDocument/semanticTokens/full', {
      textDocument: { uri: 'file:///gone.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing about prose', async () => {
    expect(await data('# Report\n\nNo blocks here.\n')).toEqual([]);
  });

  it('marks the header cells as declarations and the channel as a use', async () => {
    expect(await painted(BLOCK.join('\n'))).toEqual([
      'quarter:variable',
      'quarter:variable.declaration',
      'revenue:variable.declaration',
    ]);
  });

  it('sends the five integers per token that the format is, in document order', async () => {
    // `x: quarter` on line 1 at column 3; then the two header cells on line 3,
    // at columns 0 and 10. Deltas: down one line to the first, down two more to
    // the second, and ten characters along the same line to the third.
    const rows = [
      [1, 3, 7, 1, 0],
      [2, 0, 7, 1, 1],
      [0, 10, 7, 1, 1],
    ];
    expect(await data(BLOCK.join('\n'))).toEqual(rows.flat());
  });

  it('leaves a name that is not a column to the grammar’s guess', async () => {
    // `turnover` is spelled like a column and is not one, which is the whole
    // reason this feature exists: the editor must not agree with the mistake.
    const wrong = ['```mdv bar', 'x: quarter', 'y: turnover', '---', ...BLOCK.slice(3)];
    expect(await painted(wrong.join('\n'))).toEqual([
      'quarter:variable',
      'quarter:variable.declaration',
      'revenue:variable.declaration',
    ]);
  });

  it('paints both cells of a repeated header name, which are both columns', async () => {
    // A repeated name is `MDV2110` and no rename may touch either cell — but
    // the question here is what they *are*, and both of them are column names.
    const twice = ['```mdv bar', '---', 'quarter | quarter', 'Q1 | Q2', '```', ''];
    expect(await painted(twice.join('\n'))).toEqual([
      'quarter:variable.declaration',
      'quarter:variable.declaration',
    ]);
  });

  it('paints a `dataset` block’s id and its header, though it owns neither move', async () => {
    expect(await painted(DATASET.join('\n'))).toEqual([
      'sales:namespace.declaration',
      'region:variable.declaration',
      'units:variable.declaration',
    ]);
  });

  it('paints a reference to an id this document declares', async () => {
    const source = [...DATASET, '```mdv bar', 'data: "@sales"', 'x: region', '```', ''].join('\n');
    expect(await painted(source)).toEqual([
      'sales:namespace.declaration',
      'region:variable.declaration',
      'units:variable.declaration',
      'sales:namespace',
    ]);
  });

  it('says nothing about a reference nothing in the document declares', async () => {
    const source = ['```mdv bar', 'data: "@nope"', 'x: region', '```', ''].join('\n');
    expect(await painted(source)).toEqual([]);
  });

  it('paints the id and not the quotes or the projection around it', async () => {
    const source = [...DATASET, '```mdv bar', 'data: "@sales[region]"', '```', ''].join('\n');
    const reference = (await tokens(source)).at(-1);
    expect(reference?.text).toBe('sales');
    expect(reference?.character).toBe(8);
  });

  it('measures from the start of the line, not the start of the block', async () => {
    // Indented into a list item, every column on every line has moved right.
    const nested = BLOCK.map((line) => (line === '' ? '' : `  ${line}`)).join('\n');
    expect(await tokens(nested)).toEqual([
      { line: 1, character: 5, text: 'quarter', type: 'variable', modifiers: [] },
      { line: 3, character: 2, text: 'quarter', type: 'variable', modifiers: ['declaration'] },
      { line: 3, character: 12, text: 'revenue', type: 'variable', modifiers: ['declaration'] },
    ]);
  });

  it('keeps each block’s columns to itself, and keeps them in document order', async () => {
    const second = ['```mdv bar', 'x: region', '---', 'region | units', 'APAC | 1204', '```', ''];
    const found = await tokens([...BLOCK, ...second].join('\n'));
    expect(found.map((token) => `${String(token.line)}:${token.text}`)).toEqual([
      '1:quarter',
      '3:quarter',
      '3:revenue',
      '8:region',
      '10:region',
      '10:units',
    ]);
  });
});

/**
 * Inlay hints, from where the author is sitting (SPEC 29.4).
 *
 * Every assertion here is about a number the document does not contain. The
 * fixtures are written to make inference *decide* something — four rows over two
 * quarters is a `category` and not a `string` (SPEC 6.1.1 rule 5) — and the test
 * then reads the hint back.
 *
 * The two halves of the feature come from different stages, and the `filter`
 * test is the pair that says so: the count is the table after the transforms,
 * while the type was decided before them, on the data as the author wrote it. A
 * hint that re-inferred from the surviving rows would call the same column
 * something else on a day the filter matched fewer of them.
 *
 * The chart type below is a stub, because a hint about a column is not a fact
 * about `bar`. It exists so the block has somewhere to hang `x:` and `y:`.
 */

import { resolveSync } from '@mdv/core';
import { parse } from '@mdv/parser';
import { describe, expect, it } from 'vitest';
import { inlay } from '../src/features/inlay.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { InlayHintKind } from '../src/protocol/types.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { InitializeResult, InlayHint, Range } from '../src/protocol/types.js';
import type { ChartType, MdvConfig } from '@mdv/core';

const URI = 'file:///a.mdv';

/** Nothing in this file draws a chart; a stub that is asked to should say so. */
function unreachable(): never {
  throw new Error('the inlay hint tests never render');
}

const BAR: ChartType = {
  name: 'bar',
  level: 1,
  family: 'mark',
  channels: [
    { name: 'x', required: true, accepts: ['category', 'date'], doc: 'The category axis.' },
    { name: 'y', required: true, accepts: ['number'], doc: 'The value axis.' },
  ],
  defaultEncoding: {},
  validate: () => [],
  encode: unreachable,
  layout: unreachable,
};

const CONFIG: MdvConfig = {
  plugins: [{ name: 'stubs', version: '0.0.0', chartTypes: [BAR] }],
};

/**
 * Two quarters over four rows, which is the only reason `quarter` is a
 * `category` (SPEC 6.1.1 rule 5) and not a `string`.
 */
const DATA = ['quarter | revenue', 'Q1 | 1240.5', 'Q1 | 300.25', 'Q2 | 1510.75', 'Q2 | 220.5'];

/** A `bar` block: attribute lines, then a data section, fence to fence. */
function block(attrs: readonly string[], data: readonly string[] = DATA): string {
  return ['```mdv bar', ...attrs, '---', ...data, '```', ''].join('\n');
}

/** The channels the stub requires, for a block that is about something else. */
const CHANNELS = ['x: quarter', 'y: revenue'];

/** Every line of the document, which is what a client asks about on open. */
const ALL: Range = { start: { line: 0, character: 0 }, end: { line: 1_000, character: 0 } };

/** A server with inlay hints installed, past the handshake. */
async function started(config: MdvConfig = CONFIG): Promise<TestClient> {
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: () => {} },
    features: [inlay({ config })],
  });
  server.listen();
  await client.call('initialize', INITIALIZE_PARAMS);
  client.notify('initialized', {});
  await settle();
  return client;
}

/** Open `source` and ask for the hints in `range`. */
async function hints(source: string, range: Range = ALL): Promise<InlayHint[]> {
  const client = await started();
  client.notify('textDocument/didOpen', openParams(URI, source));
  await settle();
  const found = (await client.call('textDocument/inlayHint', {
    textDocument: { uri: URI },
    range,
  })) as InlayHint[] | null;
  if (found === null) throw new Error('the fixture resolved to nothing');
  return found;
}

/** The hints as an author reads them: in document order, label only. */
async function labels(source: string, range?: Range): Promise<string[]> {
  return (await hints(source, range)).map((hint) => hint.label);
}

describe('textDocument/inlayHint', () => {
  it('is advertised', async () => {
    const { client, server: transport } = duplex();
    const server = createServer(transport, {
      version: '0.0.0',
      logger: { info: () => {}, error: () => {} },
      features: [inlay()],
    });
    server.listen();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.inlayHintProvider).toBe(true);
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const client = await started();
    const response = await client.request('textDocument/inlayHint', {
      textDocument: { uri: 'file:///gone.mdv' },
      range: ALL,
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing about prose', async () => {
    expect(await hints('# Report\n\nNo blocks here.\n')).toEqual([]);
  });

  it('puts the inferred type after the header cell and the count on the fence', async () => {
    expect(await hints(block(CHANNELS))).toEqual([
      { position: { line: 0, character: 10 }, label: '4 rows', paddingLeft: true },
      { position: { line: 4, character: 7 }, label: ': category', kind: InlayHintKind.type },
      { position: { line: 4, character: 17 }, label: ': number', kind: InlayHintKind.type },
    ]);
  });

  it('counts the rows a transform left, and keeps the type inference decided', async () => {
    const filtered = block([...CHANNELS, 'transform:', '  - filter: "revenue > 1000"']);
    expect(await labels(filtered)).toEqual(['2 rows', ': category', ': number']);
  });

  it('says `1 row` when there is one', async () => {
    const one = block([...CHANNELS, 'transform:', '  - filter: "revenue > 1500"']);
    expect((await labels(one))[0]).toBe('1 row');
  });

  it('says nothing about a type the author declared', async () => {
    const declared = block([...CHANNELS, 'fields:', '  revenue: {type: number}']);
    expect(await labels(declared)).toEqual(['4 rows', ': category']);
  });

  it('leaves a renamed column alone, because the name on the line is gone', async () => {
    const renamed = block([
      'x: quarter',
      'y: turnover',
      'transform:',
      '  - rename: {revenue: turnover}',
    ]);
    expect(await labels(renamed)).toEqual(['4 rows', ': category']);
  });

  it('leaves a repeated name alone, because no cell of it can be trusted', async () => {
    const repeated = block(CHANNELS, ['quarter | quarter', 'Q1 | Q1', 'Q2 | Q2']);
    expect(await labels(repeated)).toEqual(['2 rows']);
  });

  it('counts a `dataset` block, which draws nothing and is read everywhere', async () => {
    const dataset = ['```mdv dataset id=sales', '---', 'region | units', 'APAC | 1204', '```', ''];
    expect(await labels(dataset.join('\n'))).toEqual(['1 row', ': string', ': integer']);
  });

  it('says nothing at all about a block whose table was never read', async () => {
    const missing = ['```mdv bar', 'data: "@nope"', 'x: quarter', 'y: revenue', '```', ''];
    expect(await hints(missing.join('\n'))).toEqual([]);
  });

  it('still explains the columns of a block that failed', async () => {
    // An unrecognised step is `MDV2500`, an error, and it hands its input on
    // untouched — so the block shows an error card over four real rows, which
    // are the rows the author is about to go looking at. The premise is
    // asserted rather than described, because a hint that survived a failure
    // only in the test's title would prove nothing.
    const broken = block([...CHANNELS, 'transform:', '  - sortt: {by: revenue}']);
    expect(resolveSync(parse(broken), CONFIG).blocks[0]?.failed).toBe(true);
    expect(await labels(broken)).toEqual(['4 rows', ': category', ': number']);
  });

  it('answers only for the lines the client is showing', async () => {
    const header: Range = { start: { line: 4, character: 0 }, end: { line: 4, character: 20 } };
    expect(await labels(block(CHANNELS), header)).toEqual([': category', ': number']);
  });

  it('answers for the block the range is in, and not its neighbour', async () => {
    const dataset = ['```mdv dataset id=sales', '---', 'region | units', 'APAC | 1204', '```', ''];
    const source = block(CHANNELS) + dataset.join('\n');
    const second: Range = { start: { line: 10, character: 0 }, end: { line: 15, character: 0 } };
    expect(await labels(source, second)).toEqual(['1 row', ': string', ': integer']);
  });
});

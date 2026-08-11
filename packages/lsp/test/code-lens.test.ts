/**
 * Code lenses, read as a client draws them (SPEC 29.4).
 *
 * Two properties carry most of the weight. A lens row belongs to *one* block,
 * so every test with two blocks in it checks that the second row's arguments
 * point at the second block — that is the failure that would be invisible in a
 * one-block fixture and obvious to anybody using the editor. And the four
 * lenses of a block share a range, because a client groups by range and four
 * ranges would stack four rows above the fence.
 *
 * Nothing here configures a plugin, and none of the fixtures resolve to a
 * chart. That is deliberate: a lens is offered on the strength of the fence
 * line alone, and a suite that only ever asked about blocks the pipeline liked
 * would not notice the day that stopped being true.
 */

import { describe, expect, it } from 'vitest';
import { CODE_LENS_COMMANDS, codeLens } from '../src/features/code-lens.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { CodeLens, CodeLensSettings } from '../src/index.js';
import type { InitializeResult, Position } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** A `bar` block: fence, one attribute, a data section, and the closing fence. */
const BLOCK = ['```mdv bar', 'x: quarter', '---', 'quarter | revenue', 'Q1 | 1240', '```', ''];

const DATASET = ['```mdv dataset id=sales', '---', 'region | units', 'APAC | 1204', '```', ''];

/** A server with lenses installed, past the handshake. */
async function started(options: CodeLensSettings = {}): Promise<TestClient> {
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: () => {} },
    features: [codeLens(options)],
  });
  server.listen();
  await client.call('initialize', INITIALIZE_PARAMS);
  client.notify('initialized', {});
  await settle();
  return client;
}

/** Open `source` and ask for its lenses. */
async function lenses(source: string, options: CodeLensSettings = {}): Promise<CodeLens[]> {
  const client = await started(options);
  client.notify('textDocument/didOpen', openParams(URI, source));
  await settle();
  return (await client.call('textDocument/codeLens', {
    textDocument: { uri: URI },
  })) as CodeLens[];
}

/** The lens row as an author reads it: titles, left to right. */
async function titles(source: string, options: CodeLensSettings = {}): Promise<string[]> {
  return (await lenses(source, options)).map((lens) => lens.command?.title ?? '');
}

describe('textDocument/codeLens', () => {
  it('is advertised, and promises nothing to resolve later', async () => {
    const { client, server: transport } = duplex();
    const server = createServer(transport, {
      version: '0.0.0',
      logger: { info: () => {}, error: () => {} },
      features: [codeLens()],
    });
    server.listen();
    const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
    expect(result.capabilities.codeLensProvider).toEqual({ resolveProvider: false });
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const client = await started();
    const response = await client.request('textDocument/codeLens', {
      textDocument: { uri: 'file:///gone.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing about prose', async () => {
    expect(await lenses('# Report\n\nNo blocks here.\n')).toEqual([]);
  });

  it('offers SPEC 29.4’s four lenses, in SPEC 29.4’s order', async () => {
    expect(await titles(BLOCK.join('\n'))).toEqual([
      'Preview',
      'Export PNG',
      'Export SVG',
      'Show data',
    ]);
  });

  it('names SPEC 29.5’s commands, and tells the two exports apart', async () => {
    const found = await lenses(BLOCK.join('\n'));
    const at: Position = { line: 0, character: 0 };
    expect(found.map((lens) => lens.command)).toEqual([
      { title: 'Preview', command: 'mdv.showPreviewToSide', arguments: [URI, at] },
      { title: 'Export PNG', command: 'mdv.exportBlock', arguments: [URI, at, 'png'] },
      { title: 'Export SVG', command: 'mdv.exportBlock', arguments: [URI, at, 'svg'] },
      { title: 'Show data', command: 'mdv.showData', arguments: [URI, at] },
    ]);
  });

  it('draws one row and not four, by giving the four lenses one range', async () => {
    const found = await lenses(BLOCK.join('\n'));
    const zeroWidth = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
    for (const lens of found) expect(lens.range).toEqual(zeroWidth);
  });

  it('points each row at its own block, and not at the first one', async () => {
    const source = ['# Sales', '', ...BLOCK, '## Detail', '', ...BLOCK].join('\n');
    const found = await lenses(source);
    const positions = found.map((lens) => (lens.command?.arguments ?? [])[1]);
    expect(positions.slice(0, 4)).toEqual(Array<Position>(4).fill({ line: 2, character: 0 }));
    expect(positions.slice(4)).toEqual(Array<Position>(4).fill({ line: 11, character: 0 }));
  });

  it('anchors on the fence itself, not the margin of the line it shares', async () => {
    const quoted = BLOCK.map((line) => (line === '' ? '' : `> ${line}`)).join('\n');
    const found = await lenses(quoted);
    expect(found[0]?.range.start).toEqual({ line: 0, character: 2 });
  });

  it('offers a `dataset` block its table, and no picture of nothing', async () => {
    expect(await titles(DATASET.join('\n'))).toEqual(['Show data']);
  });

  it('leaves out a lens the host says it cannot do', async () => {
    const without: CodeLensSettings = { commands: { exportPng: false } };
    expect(await titles(BLOCK.join('\n'), without)).toEqual(['Preview', 'Export SVG', 'Show data']);
  });

  it('takes a host’s own command ids, keeping the title and the format', async () => {
    const renamed: CodeLensSettings = {
      commands: { preview: 'acme.preview', exportSvg: 'acme.export' },
    };
    const found = await lenses(BLOCK.join('\n'), renamed);
    expect(found[0]?.command?.command).toBe('acme.preview');
    expect(found[2]?.command).toEqual({
      title: 'Export SVG',
      command: 'acme.export',
      arguments: [URI, { line: 0, character: 0 }, 'svg'],
    });
  });

  it('publishes the defaults it used, so a host can override one of them', () => {
    expect(CODE_LENS_COMMANDS).toEqual({
      preview: 'mdv.showPreviewToSide',
      exportPng: 'mdv.exportBlock',
      exportSvg: 'mdv.exportBlock',
      showData: 'mdv.showData',
    });
  });

  it('offers the lenses on a block nothing can draw, which is when they matter', async () => {
    // No plugin is configured here, so `bar` is not a registered type and this
    // block renders an error card. `Preview` is how the author sees the card
    // and `Show data` is how they see what reached it; going quiet would take
    // both away at the moment they are being reached for.
    const broken = ['```mdv nosuchtype', 'x: quarter', '```', ''];
    expect(await titles(broken.join('\n'))).toEqual([
      'Preview',
      'Export PNG',
      'Export SVG',
      'Show data',
    ]);
  });
});

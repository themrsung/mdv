/**
 * The outline and the folds, driven the way an editor drives them (SPEC 29.4).
 *
 * Both answers are read off the same tree, and the tests are written the way a
 * reader looks at them:
 *
 * 1. **The outline is a map of the document, not of the AST.** Headings nest by
 *    depth, every visual block is on it wherever it sits, and a chart is named
 *    the way its author named it. A test that asserted the tree's shape would
 *    pass while the names were useless.
 * 2. **A fold hides something.** Every range is whole lines, ends on the last
 *    line with content on it, and a range with no body is not sent at all.
 *
 * Line numbers are quoted from `DOC` below, which is numbered for that purpose.
 */

import { describe, expect, it } from 'vitest';
import { symbols } from '../src/features/symbols.js';
import { createServer } from '../src/server.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { DocumentSymbol, FoldingRange, InitializeResult } from '../src/protocol/types.js';
import { SymbolKind } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** A document with one of everything the two features have to say about. */
const DOC = [
  '---', //                     0
  'title: Report', //           1
  '---', //                     2
  '', //                        3
  '# Overview', //              4
  '', //                        5
  'Intro text.', //             6
  '', //                        7
  '## Sales', //                8
  '', //                        9
  '```mdv bar', //             10
  'title: Quarterly sales', // 11
  'x: quarter', //             12
  'y: revenue', //             13
  '---', //                    14
  'Q1 | 100', //               15
  'Q2 | 120', //               16
  '```', //                    17
  '', //                       18
  '## Costs', //               19
  '', //                       20
  '```mdv line', //            21
  'x: month', //               22
  'y: spend', //               23
  '```', //                    24
  '', //                       25
  'Trailing.', //              26
  '', //                       27
].join('\n');

/** The `initialize` params of a client that renders collapsed-range labels. */
const WITH_LABELS = {
  ...INITIALIZE_PARAMS,
  capabilities: {
    ...INITIALIZE_PARAMS.capabilities,
    textDocument: {
      ...INITIALIZE_PARAMS.capabilities.textDocument,
      foldingRange: { lineFoldingOnly: true, foldingRange: { collapsedText: true } },
    },
  },
};

interface Started {
  readonly client: TestClient;
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with the outline installed, past the handshake. */
async function started(params: unknown = INITIALIZE_PARAMS): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [symbols()],
  });
  server.listen();
  const result = (await client.call('initialize', params)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

/** A started server holding one open document. */
async function opened(source: string, params?: unknown): Promise<Started> {
  const state = await started(params);
  state.client.notify('textDocument/didOpen', openParams(URI, source));
  await settle();
  return state;
}

async function outlineOf(source: string): Promise<DocumentSymbol[]> {
  const { client } = await opened(source);
  return (await client.call('textDocument/documentSymbol', {
    textDocument: { uri: URI },
  })) as DocumentSymbol[];
}

async function foldsOf(source: string, labels = false): Promise<FoldingRange[]> {
  const { client } = await opened(source, labels ? WITH_LABELS : INITIALIZE_PARAMS);
  return (await client.call('textDocument/foldingRange', {
    textDocument: { uri: URI },
  })) as FoldingRange[];
}

/** The outline as `name` alone, one array per level, for shape assertions. */
function names(entries: readonly DocumentSymbol[] | undefined): unknown[] {
  return (entries ?? []).map((entry) =>
    entry.children === undefined || entry.children.length === 0
      ? entry.name
      : [entry.name, names(entry.children)],
  );
}

describe('textDocument/documentSymbol', () => {
  it('is advertised', async () => {
    const { result } = await started();
    expect(result.capabilities.documentSymbolProvider).toBe(true);
  });

  it('nests headings by depth and hangs every block off its section', async () => {
    expect(names(await outlineOf(DOC))).toEqual([
      [
        'Overview',
        [
          ['Sales', ['Quarterly sales']],
          ['Costs', ['line 1']],
        ],
      ],
    ]);
  });

  it('names a block by its title, and says the type as the detail', async () => {
    const outline = await outlineOf(DOC);
    const chart = outline[0]?.children?.[0]?.children?.[0];
    expect(chart?.name).toBe('Quarterly sales');
    expect(chart?.detail).toBe('bar');
    expect(chart?.kind).toBe(SymbolKind.object);
  });

  it('numbers the untitled blocks by type, so `bar 2` is the second bar', async () => {
    const source = [
      '```mdv bar',
      'x: a',
      '```',
      '',
      '```mdv line',
      'x: a',
      '```',
      '',
      '```mdv bar',
      'x: a',
      '```',
      '',
    ].join('\n');
    expect(names(await outlineOf(source))).toEqual(['bar 1', 'line 1', 'bar 2']);
  });

  it('calls a block with no type what its fence calls it', async () => {
    expect(names(await outlineOf('```mdv\nx: a\n```\n'))).toEqual(['mdv 1']);
  });

  it('gives a heading with no text a name anyway', async () => {
    expect(names(await outlineOf('#\n\ntext\n'))).toEqual(['(empty heading)']);
  });

  it('reveals a block at its fence line, not at its last row', async () => {
    const outline = await outlineOf(DOC);
    const chart = outline[0]?.children?.[0]?.children?.[0];
    // The whole block, closing fence included…
    expect(chart?.range).toEqual({
      start: { line: 10, character: 0 },
      end: { line: 17, character: 3 },
    });
    // …but "go to symbol" lands on the header, which is the part an author edits.
    expect(chart?.selectionRange).toEqual({
      start: { line: 10, character: 0 },
      end: { line: 10, character: 10 },
    });
  });

  it('ends a section on its last line of content, not on the blank ones', async () => {
    const outline = await outlineOf(DOC);
    const sales = outline[0]?.children?.[0];
    // Line 17 is the closing fence; line 18 is blank and belongs to nobody.
    expect(sales?.range.end).toEqual({ line: 17, character: 3 });
    // The document ends with a blank line too, and the top section stops before it.
    expect(outline[0]?.range.end).toEqual({ line: 26, character: 9 });
  });

  it('closes a section when a heading of the same depth arrives', async () => {
    const source = ['## A', '', 'text', '', '## B', '', 'text', ''].join('\n');
    expect(names(await outlineOf(source))).toEqual(['A', 'B']);
  });

  it('does not let a deeper heading escape the section it is in', async () => {
    const source = ['# A', '', '### Deep', '', '# B', ''].join('\n');
    expect(names(await outlineOf(source))).toEqual([['A', ['Deep']], 'B']);
  });

  it('finds a block that is quoted, because a chart is worth navigating to', async () => {
    const source = ['> ```mdv metric', '> label: Revenue', '> value: 10', '> ```', ''].join('\n');
    expect(names(await outlineOf(source))).toEqual(['metric 1']);
  });

  it('says nothing about a document that says nothing', async () => {
    expect(await outlineOf('---\ntitle: Report\n---\n')).toEqual([]);
  });

  it('refuses a document it has never seen', async () => {
    const { client } = await started();
    const response = await client.request('textDocument/documentSymbol', {
      textDocument: { uri: 'file:///gone.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('answers the document as it is now, not as it was opened', async () => {
    const { client } = await opened('# One\n');
    client.notify('textDocument/didChange', {
      textDocument: { uri: URI, version: 2 },
      contentChanges: [{ text: '# Two\n\n## Under\n' }],
    });
    await settle();
    const outline = (await client.call('textDocument/documentSymbol', {
      textDocument: { uri: URI },
    })) as DocumentSymbol[];
    expect(names(outline)).toEqual([['Two', ['Under']]]);
  });
});

describe('textDocument/foldingRange', () => {
  it('is advertised', async () => {
    const { result } = await started();
    expect(result.capabilities.foldingRangeProvider).toBe(true);
  });

  it('folds the front matter, the sections, the blocks and the data', async () => {
    expect(await foldsOf(DOC)).toEqual([
      { startLine: 0, endLine: 2 }, //   front matter
      { startLine: 4, endLine: 26 }, //  # Overview
      { startLine: 8, endLine: 17 }, //  ## Sales
      { startLine: 10, endLine: 17 }, // the bar block
      { startLine: 14, endLine: 16 }, // its data, from the separator
      { startLine: 19, endLine: 26 }, // ## Costs
      { startLine: 21, endLine: 24 }, // the line block
    ]);
  });

  it('folds a data section from its separator, so `---` stays on screen', async () => {
    const ranges = await foldsOf(DOC);
    const data = ranges.find((range) => range.startLine === 14);
    expect(data).toEqual({ startLine: 14, endLine: 16 });
  });

  it('sends no range for a construct with nothing under it', async () => {
    // A one-line section and a block with no data rows: the start line stays
    // visible when a range collapses, so neither would hide anything.
    const source = ['# Only', '', '```mdv bar', 'x: a', '```', ''].join('\n');
    expect(await foldsOf(source)).toEqual([
      { startLine: 0, endLine: 4 },
      { startLine: 2, endLine: 4 },
    ]);
  });

  it('labels a collapsed range for the clients that show one', async () => {
    expect(await foldsOf(DOC, true)).toEqual([
      { startLine: 0, endLine: 2, collapsedText: 'Report' },
      { startLine: 4, endLine: 26, collapsedText: 'Overview' },
      { startLine: 8, endLine: 17, collapsedText: 'Sales' },
      { startLine: 10, endLine: 17, collapsedText: 'Quarterly sales' },
      { startLine: 14, endLine: 16, collapsedText: '--- 2 rows' },
      { startLine: 19, endLine: 26, collapsedText: 'Costs' },
      { startLine: 21, endLine: 24, collapsedText: 'line 1' },
    ]);
  });

  it('says nothing about labels to a client that never asked for them', async () => {
    for (const range of await foldsOf(DOC)) {
      expect(range.collapsedText).toBeUndefined();
    }
  });

  it('folds front matter that has no title under its own fence', async () => {
    const ranges = await foldsOf('---\nmdv: "1.0"\nauthor: A\n---\n\ntext\n', true);
    expect(ranges[0]).toEqual({ startLine: 0, endLine: 3, collapsedText: '---' });
  });

  it('refuses a document it has never seen', async () => {
    const { client } = await started();
    const response = await client.request('textDocument/foldingRange', {
      textDocument: { uri: 'file:///gone.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });
});

/**
 * The feature set as one thing (SPEC 29.4).
 *
 * Every feature already has a file of tests here and none of them are repeated
 * below. What is left is what only the whole set can get wrong: a feature
 * missing from the list, or a setting that reaches eleven of the twelve
 * features that wanted it. Both of those are an editor with one menu item
 * quietly absent, and neither is visible from inside a per-feature suite.
 *
 * So the assertions are about coverage rather than behaviour — the capability
 * set, the answered methods, and each setting arriving where it was addressed.
 */

import { describe, expect, it } from 'vitest';
import { CODE_LENS_COMMANDS } from '../src/features/code-lens.js';
import { VALIDATE_DEBOUNCE_MS } from '../src/features/diagnostics.js';
import { mdvFeatures } from '../src/preset.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { Schedule } from '../src/features/diagnostics.js';
import type { MdvFeatureSettings } from '../src/preset.js';
import type { CodeLens, InitializeResult } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** One block with an attribute the position features have something to say about. */
const SOURCE = [
  '```mdv bar',
  'x: quarter',
  'y: revenue',
  '---',
  'quarter | revenue',
  'Q1 | 1240',
  '```',
  '',
].join('\n');

/** Inside the value of `x:`, which is a site every position feature recognises. */
const POSITION = { line: 1, character: 5 };

/** The whole document, for the features that take a range. */
const RANGE = { start: { line: 0, character: 0 }, end: { line: 7, character: 0 } };

/** A `setTimeout` the test owns, remembering what delay it was asked for. */
interface ManualClock {
  readonly schedule: Schedule;
  /** Every delay handed to {@link schedule}, in order. */
  readonly delays: number[];
  tick(): void;
}

function manualClock(): ManualClock {
  const waiting = new Map<number, () => void>();
  const delays: number[] = [];
  let nextId = 1;
  return {
    delays,
    schedule: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      delays.push(delayMs);
      waiting.set(id, callback);
      return () => {
        waiting.delete(id);
      };
    },
    tick() {
      const due = [...waiting.values()];
      waiting.clear();
      for (const callback of due) callback();
    },
  };
}

interface Started {
  readonly client: TestClient;
  /** Only what the server logged as an error; a feature that gave up says so here. */
  readonly errors: string[];
  readonly result: InitializeResult;
  readonly timers: ManualClock;
}

/** A server with the whole set installed, past the handshake, one document open. */
async function started(settings: MdvFeatureSettings = {}): Promise<Started> {
  const timers = manualClock();
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: {
      info: () => {},
      error: (message) => errors.push(message),
    },
    // The clock comes first so a test can take it back; nothing else here is a
    // default, because a default would be this file testing itself.
    features: mdvFeatures({ schedule: timers.schedule, ...settings }),
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', openParams(URI, SOURCE));
  await settle();
  return { client, errors, result, timers };
}

/** SPEC 29.4's table, read back as the keys a client sees. */
const CAPABILITIES = [
  'codeActionProvider',
  'codeLensProvider',
  'completionProvider',
  'definitionProvider',
  'diagnosticProvider',
  'documentFormattingProvider',
  'documentRangeFormattingProvider',
  'documentSymbolProvider',
  'foldingRangeProvider',
  'hoverProvider',
  'inlayHintProvider',
  'referencesProvider',
  'renameProvider',
  'semanticTokensProvider',
  'signatureHelpProvider',
  // Not a feature's: the server syncs documents whatever is installed on it.
  'positionEncoding',
  'textDocumentSync',
];

const DOCUMENT = { textDocument: { uri: URI } };

/** A keystroke: the only event the debounce is for. */
function edit(client: TestClient, text: string): void {
  client.notify('textDocument/didChange', {
    textDocument: { uri: URI, version: 2 },
    contentChanges: [{ text }],
  });
}

/** Every request the capabilities above promise an answer to. */
const REQUESTS: readonly (readonly [string, unknown])[] = [
  ['textDocument/diagnostic', DOCUMENT],
  ['textDocument/completion', { ...DOCUMENT, position: POSITION }],
  ['textDocument/hover', { ...DOCUMENT, position: POSITION }],
  ['textDocument/signatureHelp', { ...DOCUMENT, position: POSITION }],
  ['textDocument/codeAction', { ...DOCUMENT, range: RANGE, context: { diagnostics: [] } }],
  ['textDocument/formatting', { ...DOCUMENT, options: { tabSize: 2, insertSpaces: true } }],
  [
    'textDocument/rangeFormatting',
    { ...DOCUMENT, range: RANGE, options: { tabSize: 2, insertSpaces: true } },
  ],
  ['textDocument/documentSymbol', DOCUMENT],
  ['textDocument/foldingRange', DOCUMENT],
  ['textDocument/definition', { ...DOCUMENT, position: POSITION }],
  [
    'textDocument/references',
    { ...DOCUMENT, position: POSITION, context: { includeDeclaration: true } },
  ],
  ['textDocument/prepareRename', { ...DOCUMENT, position: POSITION }],
  ['textDocument/rename', { ...DOCUMENT, position: POSITION, newName: 'period' }],
  ['textDocument/inlayHint', { ...DOCUMENT, range: RANGE }],
  ['textDocument/codeLens', DOCUMENT],
  ['textDocument/semanticTokens/full', DOCUMENT],
];

/**
 * The requests whose answer depends on what a block *means*, so on `config`.
 *
 * The rest are either document-only by construction — where an id is written is
 * the parser's grammar, which no plugin changes — or take no `config` at all.
 */
const CONFIGURED = [
  'textDocument/diagnostic',
  'textDocument/completion',
  'textDocument/hover',
  'textDocument/signatureHelp',
  'textDocument/codeAction',
  'textDocument/inlayHint',
];

describe('mdvFeatures', () => {
  it('advertises a capability for every row of the SPEC 29.4 table', async () => {
    const { result } = await started();
    expect(Object.keys(result.capabilities).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('answers every request those capabilities promise', async () => {
    // A feature left out of the list is a `MethodNotFound` here and nothing at
    // all in that feature's own suite, which installs it by hand.
    const { client, errors } = await started();
    const failures: string[] = [];
    for (const [method, params] of REQUESTS) {
      const response = await client.request(method, params);
      if (response.error !== undefined) failures.push(`${method}: ${response.error.message}`);
    }

    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('hands the shared config to every feature that runs the pipeline', async () => {
    // Given as a function, which is the shape a host with per-folder settings
    // uses and the only shape whose arrival can be observed.
    const asked: string[] = [];
    const { client } = await started({
      config: (document) => {
        asked.push(document.uri);
        return undefined;
      },
    });

    const missed: string[] = [];
    for (const [method, params] of REQUESTS) {
      if (!CONFIGURED.includes(method)) continue;
      asked.length = 0;
      await client.request(method, params);
      if (!asked.includes(URI)) missed.push(method);
    }

    expect(missed).toEqual([]);
  });

  it('hands the command ids to the lenses', async () => {
    const { client } = await started({
      commands: { preview: 'acme.preview', showData: false },
    });

    const lenses = (await client.call('textDocument/codeLens', DOCUMENT)) as CodeLens[];
    const ids = lenses.map((lens) => lens.command?.command);

    expect(ids).toContain('acme.preview');
    // `false` is a host saying it has no such command, not a host saying nothing.
    expect(ids).not.toContain(CODE_LENS_COMMANDS.showData);
  });

  it('hands the format options to the formatter', async () => {
    let asked = 0;
    const { client } = await started({
      format: () => {
        asked += 1;
        return { alignTables: false };
      },
    });

    await client.call('textDocument/formatting', {
      ...DOCUMENT,
      options: { tabSize: 2, insertSpaces: true },
    });

    expect(asked).toBe(1);
  });

  it('hands the clock and the debounce to diagnostics', async () => {
    const { client, timers } = await started({ debounceMs: 42 });
    const published = (): number =>
      client.notificationsOf('textDocument/publishDiagnostics').length;
    const onOpen = published();

    // An edit waits for the author to stop typing; an open does not.
    edit(client, SOURCE.replace('Q1', 'Q2'));
    await settle();

    expect(timers.delays).toEqual([42]);
    expect(published()).toBe(onOpen);

    timers.tick();
    await settle();

    expect(published()).toBe(onOpen + 1);
  });

  it('leaves the debounce at the default when the host says nothing', async () => {
    const { client, timers } = await started();
    edit(client, SOURCE.replace('Q1', 'Q2'));
    await settle();
    expect(timers.delays).toEqual([VALIDATE_DEBOUNCE_MS]);
  });
});

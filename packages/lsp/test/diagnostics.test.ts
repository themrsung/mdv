/**
 * Validation, driven the way an editor drives it (SPEC 29.4).
 *
 * The clock is the test's, not the platform's: `diagnostics` takes its
 * `setTimeout` as an option, so a 300 ms debounce is proved by firing the timer
 * rather than by waiting for it. A test that sleeps is a test that is slow when
 * it passes and flaky when it fails.
 *
 * `plain.mdv` is a document with no MDV block at all, which still produces
 * exactly one diagnostic — MDV1100, "no `mdv:` version declared" — at a
 * **zero-width** range. That makes it the honest fixture for both halves of this
 * file: the plumbing, and the widening in `convert.ts` that a zero-width range
 * needs before a client can draw it.
 */

import { describe, expect, it } from 'vitest';
import { toLspRange } from '../src/convert.js';
import { TextDocument } from '../src/documents.js';
import { diagnostics } from '../src/features/diagnostics.js';
import { createServer } from '../src/server.js';
import { ErrorCodes, isRequestMessage } from '../src/protocol/jsonrpc.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { Schedule } from '../src/features/diagnostics.js';
import type {
  ClientCapabilities,
  Diagnostic,
  DocumentDiagnosticReport,
  InitializeResult,
  PublishDiagnosticsParams,
} from '../src/protocol/types.js';
import type { MdvConfig } from '@mdv/core';
import type { Range as MdvRange } from '@mdv/parser';

/** A document with no MDV block: one info diagnostic, at offset 0. */
const PLAIN = '# Hello\n\nNothing to see.\n';

/** A block with no data section: MDV2100, a *warning*, so `strict` can bite. */
const EMPTY_BLOCK = '```mdv\ntype: bar\nx: a\ny: b\n```\n';

const URI = 'file:///a.mdv';

/** A `setTimeout` the test owns. Nothing fires until {@link ManualClock.tick}. */
interface ManualClock {
  readonly schedule: Schedule;
  /** How many callbacks are waiting. */
  readonly pending: number;
  tick(): void;
}

function manualClock(): ManualClock {
  const waiting = new Map<number, () => void>();
  let nextId = 1;
  return {
    schedule: (callback) => {
      const id = nextId;
      nextId += 1;
      waiting.set(id, callback);
      return () => {
        waiting.delete(id);
      };
    },
    get pending() {
      return waiting.size;
    },
    tick() {
      const due = [...waiting.values()];
      waiting.clear();
      for (const callback of due) callback();
    },
  };
}

interface StartOptions {
  readonly config?: MdvConfig | ((document: TextDocument) => MdvConfig | undefined);
  readonly capabilities?: ClientCapabilities;
}

interface Started {
  readonly client: TestClient;
  readonly clock: ManualClock;
  /** Only what the server logged as an error; the info line is noise here. */
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with validation installed, past the handshake. */
async function started(options: StartOptions = {}): Promise<Started> {
  const clock = manualClock();
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [
      diagnostics({
        ...(options.config === undefined ? {} : { config: options.config }),
        schedule: clock.schedule,
      }),
    ],
  });
  server.listen();
  const result = (await client.call('initialize', {
    ...INITIALIZE_PARAMS,
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
  })) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, clock, errors, result };
}

function published(client: TestClient): PublishDiagnosticsParams[] {
  return client
    .notificationsOf('textDocument/publishDiagnostics')
    .map((message) => message.params as PublishDiagnosticsParams);
}

/**
 * Let the pipeline run until `condition` holds.
 *
 * Validation is several awaits deep behind a notification, and the number is an
 * implementation detail of `@mdv/core`; polling asks the only question the test
 * actually has.
 */
async function until(condition: () => boolean, attempts = 40): Promise<void> {
  for (let attempt = 0; attempt < attempts && !condition(); attempt += 1) await settle(1);
  if (!condition()) throw new Error('the condition never became true');
}

/** Wait for the next publish beyond the ones already seen. */
async function nextPublish(client: TestClient, after: number): Promise<PublishDiagnosticsParams> {
  await until(() => published(client).length > after);
  return published(client)[after] as PublishDiagnosticsParams;
}

function change(client: TestClient, version: number, text: string): void {
  client.notify('textDocument/didChange', {
    textDocument: { uri: URI, version },
    contentChanges: [{ text }],
  });
}

const PULLS: ClientCapabilities = {
  ...INITIALIZE_PARAMS.capabilities,
  textDocument: {
    ...INITIALIZE_PARAMS.capabilities.textDocument,
    diagnostic: { dynamicRegistration: false },
  },
};

describe('push', () => {
  it('validates a document when it opens', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));

    const first = await nextPublish(client, 0);
    expect(first.uri).toBe(URI);
    // The version says which text the ranges belong to; a client that has moved
    // on can throw the report away instead of drawing it in the wrong place.
    expect(first.version).toBe(1);
    expect(first.diagnostics).toEqual([
      {
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
        severity: 3,
        code: 'MDV1100',
        codeDescription: { href: 'https://mdv.dev/spec/errors#mdv1100' },
        source: 'mdv (parse)',
        message:
          'No `mdv:` version declared; assuming the reader\'s version\n\nAdd `mdv: "1.0"` to the front matter to pin the version.',
      },
    ]);
  });

  it('collapses a burst of changes into one run', async () => {
    const { client, clock } = await started();
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await nextPublish(client, 0);

    change(client, 2, '# H\n');
    change(client, 3, '# He\n');
    change(client, 4, '# Hel\n');
    await settle();

    // Three keystrokes, one pending run, and nothing published for any of them.
    expect(clock.pending).toBe(1);
    expect(published(client)).toHaveLength(1);

    clock.tick();
    const second = await nextPublish(client, 1);
    expect(second.version).toBe(4);
    expect(published(client)).toHaveLength(2);
  });

  it('validates a save without waiting for the debounce', async () => {
    const { client, clock } = await started();
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await nextPublish(client, 0);

    change(client, 2, '# Saved\n');
    await settle();
    expect(clock.pending).toBe(1);

    client.notify('textDocument/didSave', { textDocument: { uri: URI } });
    const second = await nextPublish(client, 1);
    expect(second.version).toBe(2);
    // The save superseded the pending run rather than queueing behind it.
    expect(clock.pending).toBe(0);
  });

  it('drops a result whose document moved on while it ran', async () => {
    // The edit is applied from inside the config callback, which runs at the
    // start of a validation — the one place a test can land a change in the
    // middle of a pipeline run without racing it.
    let interfered = false;
    const { client, clock, errors } = await started({
      config: (document) => {
        if (!interfered) {
          interfered = true;
          document.update([{ text: '# Interfered\n' }], 2);
        }
        return {};
      },
    });

    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await settle();
    expect(interfered).toBe(true);
    // Version 1's ranges describe text the mirror no longer holds.
    expect(published(client)).toEqual([]);
    expect(errors).toEqual([]);

    change(client, 3, PLAIN);
    await settle();
    clock.tick();
    const first = await nextPublish(client, 0);
    expect(first.version).toBe(3);
  });

  it('clears a document as it closes', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await nextPublish(client, 0);

    client.notify('textDocument/didClose', { textDocument: { uri: URI } });
    const second = await nextPublish(client, 1);
    expect(second).toEqual({ uri: URI, diagnostics: [] });
  });

  it('does not validate a document that closed while the debounce waited', async () => {
    const { client, clock } = await started();
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await nextPublish(client, 0);

    change(client, 2, '# Gone\n');
    await settle();
    client.notify('textDocument/didClose', { textDocument: { uri: URI } });
    await nextPublish(client, 1);
    clock.tick();
    await settle(8);

    // The clear, and nothing after it.
    expect(published(client)).toHaveLength(2);
    expect(published(client)[1]?.diagnostics).toEqual([]);
  });

  it('re-validates every open document when the configuration changes', async () => {
    let strict = false;
    const { client } = await started({ config: () => ({ strict }) });
    client.notify('textDocument/didOpen', openParams(URI, EMPTY_BLOCK));

    const first = await nextPublish(client, 0);
    expect(severityOf(first, 'MDV2100')).toBe(2);

    strict = true;
    client.notify('workspace/didChangeConfiguration', { settings: {} });

    // Same text, same version, different answer: `strict` promotes the warning.
    const second = await nextPublish(client, 1);
    expect(second.version).toBe(1);
    expect(severityOf(second, 'MDV2100')).toBe(1);
  });
});

function severityOf(params: PublishDiagnosticsParams, code: string): number | undefined {
  return params.diagnostics.find((diagnostic: Diagnostic) => diagnostic.code === code)?.severity;
}

describe('pull', () => {
  it('advertises a diagnostic provider', async () => {
    const { result } = await started();
    expect(result.capabilities.diagnosticProvider).toEqual({
      identifier: 'mdv',
      interFileDependencies: false,
      workspaceDiagnostics: false,
    });
  });

  it('does not push to a client that asks', async () => {
    const { client } = await started({ capabilities: PULLS });
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await settle(8);
    expect(published(client)).toEqual([]);

    const report = (await client.call('textDocument/diagnostic', {
      textDocument: { uri: URI },
    })) as DocumentDiagnosticReport;
    expect(report.kind).toBe('full');
    expect(report.kind === 'full' && report.items.map((item) => item.code)).toEqual(['MDV1100']);
  });

  it('answers unchanged until the document or the configuration moves', async () => {
    let strict = false;
    const { client } = await started({ capabilities: PULLS, config: () => ({ strict }) });
    client.notify('textDocument/didOpen', openParams(URI, EMPTY_BLOCK));
    await settle();

    const pull = async (previousResultId?: string): Promise<DocumentDiagnosticReport> =>
      (await client.call('textDocument/diagnostic', {
        textDocument: { uri: URI },
        ...(previousResultId === undefined ? {} : { previousResultId }),
      })) as DocumentDiagnosticReport;

    const first = await pull();
    expect(first.kind).toBe('full');
    const resultId = first.kind === 'full' ? first.resultId : undefined;
    expect(resultId).toBeTypeOf('string');

    expect(await pull(resultId)).toEqual({ kind: 'unchanged', resultId });

    change(client, 2, PLAIN);
    await settle();
    const afterEdit = await pull(resultId);
    expect(afterEdit.kind).toBe('full');

    // A configuration change is a change too, even though the text stands still.
    const stable = await pull(afterEdit.kind === 'full' ? afterEdit.resultId : undefined);
    expect(stable.kind).toBe('unchanged');
    strict = true;
    client.notify('workspace/didChangeConfiguration', { settings: {} });
    await settle();
    expect((await pull(afterEdit.kind === 'full' ? afterEdit.resultId : undefined)).kind).toBe(
      'full',
    );
  });

  it('refuses a document it was never sent', async () => {
    const { client } = await started({ capabilities: PULLS });
    const response = await client.request('textDocument/diagnostic', {
      textDocument: { uri: 'file:///never-opened.mdv' },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('never-opened.mdv');
  });

  it('asks a pulling client to refresh when the configuration changes', async () => {
    const { client } = await started({
      capabilities: { ...PULLS, workspace: { diagnostics: { refreshSupport: true } } },
    });
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    await settle();

    client.notify('workspace/didChangeConfiguration', { settings: {} });
    await until(() => client.received.some((message) => isRequestMessage(message)));

    expect(client.received.filter(isRequestMessage).map((message) => message.method)).toEqual([
      'workspace/diagnostic/refresh',
    ]);
    expect(published(client)).toEqual([]);
  });

  it('says nothing to a client that cannot refresh', async () => {
    const { client } = await started({ capabilities: PULLS });
    client.notify('textDocument/didOpen', openParams(URI, PLAIN));
    client.notify('workspace/didChangeConfiguration', { settings: {} });
    await settle(8);
    expect(client.received.filter(isRequestMessage)).toEqual([]);
    expect(published(client)).toEqual([]);
  });
});

/**
 * SPEC 14.4: the range is the one the parser computed, in the original
 * document. These convert offsets, because offsets are what the parser is sure
 * about.
 */
describe('ranges', () => {
  function document(text: string): TextDocument {
    return new TextDocument(URI, 'mdv', 1, text);
  }

  /** An MDV range built from offsets, with the line/column pair it implies. */
  function range(source: TextDocument, start: number, end: number): MdvRange {
    const position = (offset: number) => {
      const { line, character } = source.positionAt(offset);
      return { offset, line: line + 1, column: character + 1 };
    };
    return { start: position(start), end: position(end) };
  }

  it('converts a range through its offsets', () => {
    const source = document('one\ntwo\nthree\n');
    expect(toLspRange(source, range(source, 4, 7))).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 3 },
    });
  });

  it('widens a zero-width range onto the character it points at', () => {
    const source = document('one\ntwo\n');
    expect(toLspRange(source, range(source, 4, 4))).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 1 },
    });
  });

  it('widens a zero-width range at the end of a line onto the next one', () => {
    const source = document('one\ntwo\n');
    expect(toLspRange(source, range(source, 3, 3))).toEqual({
      start: { line: 0, character: 3 },
      end: { line: 1, character: 0 },
    });
  });

  it('leaves a zero-width range at the end of the document collapsed', () => {
    const source = document('one');
    expect(toLspRange(source, range(source, 3, 3))).toEqual({
      start: { line: 0, character: 3 },
      end: { line: 0, character: 3 },
    });
  });

  it('does not widen into the middle of a surrogate pair', () => {
    const source = document('a\u{1F600}b\n');
    // The emoji is two UTF-16 units; half of one is not a character a client can
    // slice, so the squiggle covers both.
    expect(toLspRange(source, range(source, 1, 1))).toEqual({
      start: { line: 0, character: 1 },
      end: { line: 0, character: 3 },
    });
  });

  it('clamps an offset from a stale run to the document', () => {
    const source = document('one\n');
    expect(toLspRange(source, range(source, 400, 900))).toEqual({
      start: { line: 1, character: 0 },
      end: { line: 1, character: 0 },
    });
  });
});

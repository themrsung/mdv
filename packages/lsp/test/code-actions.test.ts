/**
 * Code actions (SPEC 14.2, 29.4).
 *
 * The feature owns no fixes, so the tests do not check what a fix says — the
 * parser's own suite does that. What is tested here is the surfacing: that a
 * fix reaches the client attached to the diagnostic it belongs to, that the
 * client's range and `only` list decide which ones travel, and that asking a
 * question never writes anything back.
 */

import { describe, expect, it } from 'vitest';
import { createServer } from '../src/server.js';
import { codeActions } from '../src/features/code-actions.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { CodeActionSettings } from '../src/features/code-actions.js';
import type { CodeAction, InitializeResult, Range, TextEdit } from '../src/protocol/types.js';

const URI = 'file:///a.mdv';

/** A block whose two data-looking lines sit above no separator (MDV1203). */
const UNSEPARATED = '```mdv pie\nregion | revenue\nAPAC   | 4210\n```\n';

/** One offending line, on line 2, spanning characters 0-11. */
const ONE_LINE = '```mdv bar\ntitle: T\nAPAC | 4210\n```\n';

interface Started {
  readonly client: TestClient;
  readonly errors: string[];
  readonly result: InitializeResult;
}

async function started(options: CodeActionSettings = {}): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [codeActions(options)],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

/** A range on one line, given as characters. */
function at(line: number, start: number, end = start): Range {
  return { start: { line, character: start }, end: { line, character: end } };
}

/** Ask for the actions covering a range of an already-open document. */
async function actionsFor(
  client: TestClient,
  range: Range,
  only?: readonly string[],
): Promise<CodeAction[]> {
  const actions = await client.call('textDocument/codeAction', {
    textDocument: { uri: URI },
    range,
    context: { diagnostics: [], ...(only === undefined ? {} : { only }) },
  });
  return actions as CodeAction[];
}

/** The document an action's edit produces, applied back to front. */
function apply(source: string, action: CodeAction | undefined): string {
  const edits = action?.edit?.changes?.[URI];
  if (edits === undefined) throw new Error('action carried no edit for this document');
  const lines = source.split('\n');
  const offsetOf = (line: number, character: number): number =>
    lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + character;
  const ordered = [...edits].sort(
    (a: TextEdit, b: TextEdit) =>
      offsetOf(b.range.start.line, b.range.start.character) -
      offsetOf(a.range.start.line, a.range.start.character),
  );
  let text = source;
  for (const edit of ordered) {
    text =
      text.slice(0, offsetOf(edit.range.start.line, edit.range.start.character)) +
      edit.newText +
      text.slice(offsetOf(edit.range.end.line, edit.range.end.character));
  }
  return text;
}

describe('textDocument/codeAction', () => {
  it('advertises the one kind it can produce', async () => {
    const { result } = await started();
    expect(result.capabilities.codeActionProvider).toEqual({ codeActionKinds: ['quickfix'] });
  });

  it("hands over the parser's fix, attached to the diagnostic that carries it", async () => {
    const { client, errors } = await started();
    client.notify('textDocument/didOpen', openParams(URI, UNSEPARATED));
    await settle();

    const actions = await actionsFor(client, at(1, 0, 16));
    expect(actions).toHaveLength(1);
    expect(actions[0]?.kind).toBe('quickfix');
    expect(actions[0]?.title).toBe('Add a `---` separator above this line');
    // The action names the diagnostic it answers, so a client can dismiss the
    // squiggle the moment the edit lands.
    expect(actions[0]?.diagnostics?.map((diagnostic) => diagnostic.code)).toEqual(['MDV1203']);
    expect(actions[0]?.diagnostics?.[0]?.range).toEqual(at(1, 0, 16));
    expect(actions[0]?.isPreferred).toBeUndefined();
    expect(apply(UNSEPARATED, actions[0])).toBe(
      '```mdv pie\n---\nregion | revenue\nAPAC   | 4210\n```\n',
    );
    expect(errors).toEqual([]);
  });

  it('offers a fix per offending line when the range spans several', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, UNSEPARATED));
    await settle();

    const actions = await client.call('textDocument/codeAction', {
      textDocument: { uri: URI },
      range: { start: { line: 1, character: 0 }, end: { line: 2, character: 13 } },
      context: { diagnostics: [] },
    });
    expect((actions as CodeAction[]).map((action) => action.diagnostics?.[0]?.range.start.line))
      // Document order, which is the order the pipeline reported them in.
      .toEqual([1, 2]);
  });

  it('puts the preferred fix first when the pipeline marks one', async () => {
    const source = '```mdv bar\ntitle: T\n----\nnot data\n```\n';
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, source));
    await settle();

    const actions = await actionsFor(client, at(2, 0, 4));
    expect(actions.map((action) => action.title)).toEqual([
      'Change this line to the `---` separator',
      'Add a `---` separator above this line',
    ]);
    expect(actions[0]?.isPreferred).toBe(true);
    expect(actions[1]?.isPreferred).toBeUndefined();
    expect(apply(source, actions[0])).toBe('```mdv bar\ntitle: T\n---\nnot data\n```\n');
  });

  it('answers a cursor that only touches the diagnostic', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, ONE_LINE));
    await settle();

    // A caret at either edge of the squiggle is a caret the author put there to
    // ask about it.
    expect(await actionsFor(client, at(2, 0))).toHaveLength(1);
    expect(await actionsFor(client, at(2, 11))).toHaveLength(1);
    expect(await actionsFor(client, at(2, 5))).toHaveLength(1);
  });

  it('says nothing about a range the diagnostic does not reach', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, ONE_LINE));
    await settle();

    expect(await actionsFor(client, at(1, 0, 8))).toEqual([]);
    expect(await actionsFor(client, at(0, 0, 10))).toEqual([]);
  });

  it('ignores diagnostics the pipeline could not fix', async () => {
    // An unterminated fence is a real diagnostic with no mechanical answer.
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, '```mdv bar\ntitle: T\n'));
    await settle();

    expect(await actionsFor(client, at(0, 0, 10))).toEqual([]);
  });

  it('respects the kinds the client asked for', async () => {
    const { client } = await started();
    client.notify('textDocument/didOpen', openParams(URI, ONE_LINE));
    await settle();

    expect(await actionsFor(client, at(2, 0, 11), ['quickfix'])).toHaveLength(1);
    // A prefix matches whole segments only, in both directions.
    expect(await actionsFor(client, at(2, 0, 11), ['quickfix.mdv'])).toEqual([]);
    expect(await actionsFor(client, at(2, 0, 11), ['source.fixAll'])).toEqual([]);
    expect(await actionsFor(client, at(2, 0, 11), ['refactor'])).toEqual([]);
    // An empty list is a client asking for nothing.
    expect(await actionsFor(client, at(2, 0, 11), [])).toEqual([]);
  });

  it('refuses a document it has never seen', async () => {
    const { client } = await started();
    const response = await client.request('textDocument/codeAction', {
      textDocument: { uri: 'file:///gone.mdv' },
      range: at(0, 0),
      context: { diagnostics: [] },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('never fires the host’s diagnostic sink', async () => {
    // The sink belongs to the run the host asked for. A question asked about a
    // document is not that run, and answering it must not look like one.
    const seen: string[] = [];
    const { client, errors } = await started({
      config: { onDiagnostic: (diagnostic) => seen.push(diagnostic.code) },
    });
    client.notify('textDocument/didOpen', openParams(URI, UNSEPARATED));
    await settle();

    expect(await actionsFor(client, at(1, 0, 16))).toHaveLength(1);
    expect(seen).toEqual([]);
    expect(errors).toEqual([]);
  });
});

/**
 * Signature help, from where the author is sitting (SPEC 29.4).
 *
 * Not one label, parameter or sentence is spelled out in this file: they are
 * read back out of `@mdv/spec`'s published table, because a signature the
 * server invented would look exactly as convincing in a test that wrote it
 * down. What is asserted here is the part that is this package's own — which
 * call the cursor stands in, which argument of it, and that the parameter
 * labels are spans of the label a client is asked to highlight inside.
 *
 * The fixtures put their calls in a `transform` pipeline, because that is where
 * expressions live (SPEC 6.7): `filter` and `derive` hold them and `sort` holds
 * a field name, and the tests below prove the server does not decide which is
 * which — the parser does.
 */

import { describe, expect, it } from 'vitest';
import { FUNCTION_SIGNATURES, lookupSignature, renderSignature } from '@mdv/spec';
import { signature } from '../src/features/signature.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { MarkupKind } from '../src/protocol/types.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { FunctionSignature } from '@mdv/spec';
import type {
  InitializeResult,
  Position,
  SignatureHelp,
  SignatureInformation,
} from '../src/protocol/types.js';
import type { ChartType, MdvConfig } from '@mdv/core';

const URI = 'file:///a.mdv';

/** Where the cursor is. Stripped from the fixture before the server sees it. */
const CURSOR = '‸';

/** Nothing in this file draws a chart; a stub that is asked to should say so. */
function unreachable(): never {
  throw new Error('the signature tests never render');
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

/** A `bar` block with `header` between the fence and three columns of data. */
function block(...header: string[]): string {
  return [
    '```mdv bar',
    'x: quarter',
    'y: revenue',
    ...header,
    '---',
    'quarter | revenue | profit',
    'Q1 | 100 | 12',
    'Q2 | 120 | 20',
    '```',
    '',
  ].join('\n');
}

/** The same block, with `steps` as its pipeline. */
function piped(...steps: string[]): string {
  return block('transform:', ...steps.map((step) => `  - ${step}`));
}

/** The published signature for `name`, which is what the server may relay. */
function fn(name: string): FunctionSignature {
  const found = lookupSignature(name);
  if (found === undefined) throw new Error(`the table has no \`${name}\``);
  return found;
}

interface Cursor {
  readonly text: string;
  readonly position: Position;
}

function cursorIn(source: string): Cursor {
  const offset = source.indexOf(CURSOR);
  if (offset === -1) throw new Error(`the fixture has no ${CURSOR}`);
  const text = source.slice(0, offset) + source.slice(offset + CURSOR.length);
  const before = source.slice(0, offset);
  const line = before.split('\n').length - 1;
  return { text, position: { line, character: offset - (before.lastIndexOf('\n') + 1) } };
}

interface Started {
  readonly client: TestClient;
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with signature help installed, past the handshake. */
async function started(config?: MdvConfig): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [signature(config === undefined ? {} : { config })],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

/** Open `source` with its cursor marker removed, and ask at the marker. */
async function helping(source: string): Promise<SignatureHelp | null> {
  const { text, position } = cursorIn(source);
  const { client } = await started(CONFIG);
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  return (await client.call('textDocument/signatureHelp', {
    textDocument: { uri: URI },
    position,
  })) as SignatureHelp | null;
}

/** The help there had better be. */
async function help(source: string): Promise<SignatureHelp> {
  const found = await helping(source);
  if (found === null) throw new Error('the fixture stands in no call');
  return found;
}

/** A whitelisted name has one signature and no other (SPEC 6.8.2). */
function only(found: SignatureHelp): SignatureInformation {
  const [first, ...rest] = found.signatures;
  if (first === undefined) throw new Error('the help carries no signature');
  expect(rest).toHaveLength(0);
  expect(found.activeSignature).toBe(0);
  return first;
}

describe('textDocument/signatureHelp', () => {
  it('is advertised, with the characters that ask the question', async () => {
    const { result } = await started();
    expect(result.capabilities.signatureHelpProvider).toEqual({ triggerCharacters: ['(', ','] });
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const { client } = await started(CONFIG);
    const response = await client.request('textDocument/signatureHelp', {
      textDocument: { uri: 'file:///gone.mdv' },
      position: { line: 0, character: 0 },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing in the prose around a block', async () => {
    expect(await helping(`# sum(‸)\n\n${piped('filter: revenue > 0')}`)).toBeNull();
  });

  it('says nothing below the separator, where the author is writing data', async () => {
    const source = piped('filter: revenue > 0').replace('Q1 | 100', 'sum(1‸) | 100');
    expect(await helping(source)).toBeNull();
  });

  it('says nothing about a step whose parameter is not an expression', async () => {
    expect(await helping(piped('sort: round(reven‸ue)'))).toBeNull();
  });

  it('says nothing about a key that holds a field name', async () => {
    expect(await helping(piped('filter: revenue > 0').replace('x: quarter', 'x: quar‸ter'))).toBe(
      null,
    );
  });

  it('names the call the cursor stands in', async () => {
    const found = await help(piped('filter: clamp(reven‸ue, 0, 1) > 0'));
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
    expect(found.activeParameter).toBe(0);
  });

  it('answers the innermost call, which is the one being written', async () => {
    const found = await help(piped('filter: round(clamp(reven‸ue, 0, 1)) > 0'));
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
  });

  it('counts the commas to the argument the cursor is in', async () => {
    const found = await help(piped('filter: clamp(revenue, 0, ‸1) > 0'));
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
    expect(found.activeParameter).toBe(2);
  });

  it('survives the space after a comma, which is where the trigger leaves the cursor', async () => {
    const found = await help(piped('filter: clamp(revenue, ‸'));
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
    expect(found.activeParameter).toBe(1);
  });

  it('reads through the quotes a value was written in', async () => {
    // The cursor is pressed against the comma, where one character of drift
    // between the value as written and the expression as kept would answer
    // with the argument after this one.
    const found = await help(piped(`filter: "clamp(revenue‸, 0, 1) > 0"`));
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
    expect(found.activeParameter).toBe(0);
  });

  it('reads through a block scalar’s header and indent', async () => {
    const found = await help(
      block('transform:', '  - filter: >-', '      clamp(revenue‸, 0, 1) > 0'),
    );
    expect(only(found).label).toBe(renderSignature(fn('clamp')));
    expect(found.activeParameter).toBe(0);
  });

  it('says nothing in a value YAML rewrote, where no offset can be trusted', async () => {
    const source = piped(`filter: "substr(quarter‸, 0, 1) == \\"Q\\""`);
    expect(await helping(source)).toBeNull();
  });

  it('reads a derived field’s expression', async () => {
    const found = await help(block('transform:', '  - derive:', '      margin: round(reven‸ue)'));
    expect(only(found).label).toBe(renderSignature(fn('round')));
  });

  it('holds a rest parameter for every argument past it', async () => {
    const found = await help(piped('filter: sum(revenue, profit, 1‸) > 0'));
    const params = only(found).parameters ?? [];
    expect(params).toHaveLength(1);
    expect(found.activeParameter).toBe(0);
  });

  it('points past the end for an argument the function does not have', async () => {
    const found = await help(piped('filter: pow(revenue, 2, 3‸) > 0'));
    expect(only(found).parameters).toHaveLength(fn('pow').params.length);
    expect(found.activeParameter).toBe(2);
  });

  it('says nothing for a name that is not on the whitelist', async () => {
    expect(await helping(piped('filter: bogus(reven‸ue) > 0'))).toBeNull();
  });

  it('relays the published summaries and nothing of its own', async () => {
    const found = only(await help(piped('filter: substr(quarter, 0, ‸1) == "Q"')));
    const published = fn('substr');
    expect(found.documentation).toEqual({
      kind: MarkupKind.plainText,
      value: published.summary,
    });
    const params = found.parameters ?? [];
    expect(params.map((param) => param.documentation?.value)).toEqual(
      published.params.map((param) => param.summary),
    );
  });

  it('says when a function is legal only over a group', async () => {
    const found = only(await help(piped('filter: sum(reven‸ue) > 0')));
    expect(fn('sum').aggregateOnly).toBe(true);
    expect(found.documentation?.value).toContain(fn('sum').summary);
    expect(found.documentation?.value).toContain('aggregate only');
  });

  it('labels each parameter with a span of the signature label', async () => {
    const found = only(await help(piped('filter: substr(quarter, 0, ‸1) == "Q"')));
    const params = found.parameters ?? [];
    expect(params).toHaveLength(fn('substr').params.length);
    for (const [index, published] of fn('substr').params.entries()) {
      const label = params[index]?.label ?? '';
      // Exactly once, because that is how a client finds the span to highlight.
      expect(label).toContain(published.name);
      expect(found.label.split(label)).toHaveLength(2);
    }
  });

  it('is what the published table says, for every function in it', () => {
    // The feature renders one signature per name and takes the parameter spans
    // back out of it, so the two can only agree if this holds of the table.
    for (const published of FUNCTION_SIGNATURES) {
      const label = renderSignature(published);
      for (const param of published.params) {
        expect(label.split(param.name).length).toBeGreaterThan(1);
      }
    }
  });
});

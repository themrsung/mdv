/**
 * Completion, from where the author is sitting (SPEC 29.4).
 *
 * Every fixture marks the cursor with `‸` and hands the whole string to
 * {@link complete}, because "line 1, character 9" is a fact about the test and
 * "`legend: t‸`" is a fact about the block. The marker is stripped before the
 * document is opened; the server never sees it.
 *
 * The chart types are stubs registered through `plugins`, which is the only way
 * a type exists at all — this server has no built-ins, so `bar` is `bar` here
 * because the configuration says so, exactly as it would be in an editor with a
 * plugin installed. What the stubs are asked for is what completion reads:
 * channel names, what each channel accepts, and the per-type defaults.
 *
 * The last test is the reason the two hand-written lists in `completion.ts` are
 * allowed to be hand-written: it reads `schemas/common/block.json` and fails the
 * moment the schema grows a key, or an enum member, that this server would then
 * quietly never offer.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CLOSED_VALUES, COMMON_ATTRS, completion } from '../src/features/completion.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { CompletionItemKind, MarkupKind } from '../src/protocol/types.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { CompletionItem, InitializeResult, Position } from '../src/protocol/types.js';
import type { ChartType, MdvConfig } from '@mdv/core';

const URI = 'file:///a.mdv';

/** Where the cursor is. Stripped from the fixture before the server sees it. */
const CURSOR = '‸';

/**
 * The common keys still worth offering inside a fence that names its type.
 *
 * `type` is written by the info string itself, so the parser has already
 * recorded it by the time the cursor reaches the header and the server does not
 * offer it a second time.
 */
const WRITABLE_COMMON = COMMON_ATTRS.filter((key) => key !== 'type');

/** Nothing in this file draws a chart; a stub that is asked to should say so. */
function unreachable(): never {
  throw new Error('the completion tests never render');
}

/** Two required channels, one optional, and two per-type defaults to offer. */
const BAR: ChartType = {
  name: 'bar',
  level: 1,
  family: 'mark',
  channels: [
    { name: 'x', required: true, accepts: ['category', 'date'], doc: 'The category axis.' },
    { name: 'y', required: true, accepts: ['number'], doc: 'The value axis.' },
    { name: 'color', required: false, accepts: ['category'], doc: 'One series per value.' },
  ],
  defaultEncoding: {},
  defaults: { stack: 'none', barWidth: 0.8 },
  validate: () => [],
  encode: unreachable,
  layout: unreachable,
};

/** Level 2 and aliased, so `detail` and `sortText` have something to distinguish. */
const LINE: ChartType = {
  name: 'line',
  level: 2,
  family: 'mark',
  aliases: ['spline'],
  channels: [{ name: 'x', required: true, accepts: ['number'], doc: 'The horizontal axis.' }],
  defaultEncoding: {},
  validate: () => [],
  encode: unreachable,
  layout: unreachable,
};

const CONFIG: MdvConfig = {
  plugins: [{ name: 'stubs', version: '0.0.0', chartTypes: [BAR, LINE] }],
};

/** A `bar` block with `header` between the fence and three columns of data. */
function block(...header: string[]): string {
  return [
    '```mdv bar',
    ...header,
    '---',
    'quarter | revenue | net gain',
    'Q1 | 100 | 12',
    'Q2 | 120 | 20',
    '```',
    '',
  ].join('\n');
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

interface Options {
  readonly config?: MdvConfig | ((document: { readonly uri: string }) => MdvConfig | undefined);
}

interface Started {
  readonly client: TestClient;
  /** Only what the server logged as an error; the info line is noise here. */
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with completion installed, past the handshake. */
async function started(options: Options = {}): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [completion(options.config === undefined ? {} : { config: options.config })],
  });
  server.listen();
  const result = (await client.call('initialize', INITIALIZE_PARAMS)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

interface Answer {
  readonly items: CompletionItem[];
  readonly errors: string[];
}

/** Open `source` with its cursor marker removed, and ask at the marker. */
async function complete(source: string, options: Options = { config: CONFIG }): Promise<Answer> {
  const { text, position } = cursorIn(source);
  const { client, errors } = await started(options);
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  const items = (await client.call('textDocument/completion', {
    textDocument: { uri: URI },
    position,
  })) as CompletionItem[];
  return { items, errors };
}

function labels(items: readonly CompletionItem[]): string[] {
  return items.map((item) => item.label);
}

function named(items: readonly CompletionItem[], label: string): CompletionItem {
  const found = items.find((item) => item.label === label);
  if (found === undefined) throw new Error(`no completion labelled \`${label}\``);
  return found;
}

/** A single-line range, the way every edit in this file is shaped. */
function range(line: number, start: number, end: number): unknown {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('textDocument/completion', () => {
  it('is advertised, with the two characters that summon it unasked', async () => {
    const { result } = await started();
    expect(result.capabilities.completionProvider).toEqual({
      triggerCharacters: [':', ' '],
      resolveProvider: false,
    });
  });

  it('refuses a document it has never seen', async () => {
    const { client } = await started({ config: CONFIG });
    const response = await client.request('textDocument/completion', {
      textDocument: { uri: 'file:///gone.mdv' },
      position: { line: 0, character: 0 },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing in the prose around a block', async () => {
    const { items } = await complete(`# Report‸\n\n${block('x: quarter')}`);
    expect(items).toEqual([]);
  });

  it('says nothing below the separator, where the author is writing data', async () => {
    const { items } = await complete(block('x: quarter').replace('Q1 | 100', 'Q1‸ | 100'));
    expect(items).toEqual([]);
  });

  it('says nothing on the separator itself', async () => {
    const { items } = await complete(block('x: quarter').replace('\n---\n', '\n---‸\n'));
    expect(items).toEqual([]);
  });
});

describe('the info string', () => {
  it('offers every registered type, and nothing a plugin did not register', async () => {
    const { items } = await complete(['```mdv b‸', 'x: quarter', '```', ''].join('\n'));
    expect(items).toEqual([
      {
        label: 'bar',
        kind: CompletionItemKind.class,
        detail: 'mark · level 1',
        sortText: '1bar',
        textEdit: { range: range(0, 7, 8), newText: 'bar' },
      },
      {
        label: 'line',
        kind: CompletionItemKind.class,
        detail: 'mark · level 2 · also spline',
        sortText: '2line',
        textEdit: { range: range(0, 7, 8), newText: 'line' },
      },
    ]);
  });

  it('replaces the whole word, not the part the cursor sits after', async () => {
    const { items } = await complete(['```mdv b‸ar', 'x: quarter', '```', ''].join('\n'));
    expect(named(items, 'line').textEdit).toEqual({
      range: range(0, 7, 10),
      newText: 'line',
    });
  });

  it('leaves the fence itself alone: only the type is replaced', async () => {
    const { items } = await complete(['``‸`mdv bar', 'x: quarter', '```', ''].join('\n'));
    expect(items).toEqual([]);
  });

  it('offers nothing at all when the configuration registers no types', async () => {
    const { items } = await complete(['```mdv b‸', 'x: quarter', '```', ''].join('\n'), {});
    expect(items).toEqual([]);
  });
});

describe('attribute keys', () => {
  it("offers the type's channels, then its defaults, then the common keys", async () => {
    const { items } = await complete(block('‸'));
    expect(labels(items).slice(0, 5)).toEqual(['x', 'y', 'color', 'stack', 'barWidth']);
    expect(labels(items).slice(5)).toEqual(WRITABLE_COMMON);
    expect(items.map((item) => item.sortText).slice(0, 6)).toEqual([
      '0x',
      '0y',
      '0color',
      '1stack',
      '1barWidth',
      '2title',
    ]);
  });

  it('says what a channel accepts, quotes its documentation, and preselects it', async () => {
    const { items } = await complete(block('‸'));
    expect(named(items, 'x')).toEqual({
      label: 'x',
      kind: CompletionItemKind.field,
      detail: 'category | date',
      documentation: { kind: MarkupKind.plainText, value: 'The category axis.' },
      sortText: '0x',
      preselect: true,
      textEdit: { range: range(1, 0, 0), newText: 'x: ' },
    });
    expect(named(items, 'color').preselect).toBeUndefined();
  });

  it('names the value a per-type default will take, and the set a common key allows', async () => {
    const { items } = await complete(block('‸'));
    expect(named(items, 'stack')).toEqual({
      label: 'stack',
      kind: CompletionItemKind.property,
      detail: 'default: none',
      sortText: '1stack',
      textEdit: { range: range(1, 0, 0), newText: 'stack: ' },
    });
    expect(named(items, 'legend').detail).toBe(
      'auto | top | right | bottom | left | inline | false',
    );
    expect(named(items, 'title').detail).toBeUndefined();
  });

  it('does not offer a key the block already has', async () => {
    const { items } = await complete(block('x: quarter', 'title: Sales', '‸'));
    expect(labels(items)).not.toContain('x');
    expect(labels(items)).not.toContain('title');
    expect(labels(items)).toContain('y');
  });

  it('completes a partial key over the whole word, and adds the colon', async () => {
    const { items } = await complete(block('ti‸'));
    expect(named(items, 'title').textEdit).toEqual({
      range: range(1, 0, 2),
      newText: 'title: ',
    });
  });

  it('renames a key that already has its colon without writing a second one', async () => {
    const { items } = await complete(block('ti‸: Sales'));
    expect(named(items, 'title').textEdit).toEqual({
      range: range(1, 0, 2),
      newText: 'title',
    });
  });

  it('says nothing on a line indented into a nested map', async () => {
    const { items } = await complete(block('axis:', '  ‸'));
    expect(items).toEqual([]);
  });

  it('offers the common keys, and only those, for a type nobody registered', async () => {
    const source = block('‸').replace('```mdv bar', '```mdv nope');
    const { items } = await complete(source);
    expect(labels(items)).toEqual(WRITABLE_COMMON);
  });

  it('leaves `type:` out when the fence already names one, and in when it does not', async () => {
    const fenced = await complete(block('‸'));
    expect(labels(fenced.items)).not.toContain('type');
    const bare = await complete(block('‸').replace('```mdv bar', '```mdv'));
    expect(labels(bare.items)).toEqual([...COMMON_ATTRS]);
  });
});

describe('attribute values', () => {
  it('completes a closed set from the schema, over what is written so far', async () => {
    const { items } = await complete(block('legend: t‸'));
    expect(labels(items)).toEqual([...(CLOSED_VALUES['legend'] ?? [])]);
    expect(named(items, 'top')).toEqual({
      label: 'top',
      kind: CompletionItemKind.enumMember,
      textEdit: { range: range(1, 8, 9), newText: 'top' },
    });
  });

  it('treats a boolean attribute as the enum of two that it is', async () => {
    const { items } = await complete(block('animate: ‸'));
    expect(labels(items)).toEqual(['true', 'false']);
  });

  it('completes `type:` in the header the way the fence line does', async () => {
    const source = block('type: b‸').replace('```mdv bar', '```mdv');
    const { items } = await complete(source);
    expect(labels(items)).toEqual(['bar', 'line']);
    expect(named(items, 'bar').textEdit).toEqual({ range: range(1, 6, 7), newText: 'bar' });
  });

  it("offers a channel the block's own column names", async () => {
    const { items } = await complete(block('x: ‸'));
    expect(labels(items)).toEqual(['quarter', 'revenue', 'net gain']);
    expect(named(items, 'revenue').kind).toBe(CompletionItemKind.value);
  });

  it('brackets a column name that could not be read back bare, and quotes it', async () => {
    // SPEC 6.1.2 spells the reference `"[Net revenue (USD)]"`: the brackets say
    // "this is one name", and the quotes stop YAML reading them as a list.
    const { items } = await complete(block('x: ‸'));
    expect(named(items, 'net gain').textEdit).toEqual({
      range: range(1, 3, 3),
      newText: '"[net gain]"',
    });
    expect(named(items, 'quarter').textEdit).toEqual({
      range: range(1, 3, 3),
      newText: 'quarter',
    });
  });

  it('completes the facet keys with columns too, because that is what they take', async () => {
    const { items } = await complete(block('row: ‸'));
    expect(labels(items)).toEqual(['quarter', 'revenue', 'net gain']);
  });

  it('completes inside a flow list, where a channel takes more than one column', async () => {
    // `y: [a, b]` is how a channel carries two columns, and the parser records
    // the members as `y[0]` and `y[1]`. Each one completes like `y` itself.
    const { items } = await complete(block('y: [revenue, n‸]'));
    expect(labels(items)).toEqual(['quarter', 'revenue', 'net gain']);
    expect(named(items, 'net gain').textEdit).toEqual({
      range: range(1, 13, 14),
      newText: '"[net gain]"',
    });
  });

  it('offers the one value the type vouches for, and nothing where it names none', async () => {
    const withDefault = await complete(block('stack: ‸'));
    expect(withDefault.items).toEqual([
      {
        label: 'none',
        kind: CompletionItemKind.enumMember,
        detail: 'default',
        textEdit: { range: range(1, 7, 7), newText: 'none' },
      },
    ]);
    const numeric = await complete(block('barWidth: ‸'));
    expect(numeric.items).toEqual([]);
  });

  it('guesses nothing inside a nested map', async () => {
    const { items } = await complete(block('axis:', '  x: ‸'));
    expect(items).toEqual([]);
  });

  it('has nothing to say about a free-text attribute', async () => {
    const { items } = await complete(block('title: Sa‸'));
    expect(items).toEqual([]);
  });
});

describe('the configuration', () => {
  it('can be a function of the document, for a host with more than one folder', async () => {
    const { items } = await complete(['```mdv b‸', 'x: quarter', '```', ''].join('\n'), {
      config: (document) => (document.uri === URI ? CONFIG : undefined),
    });
    expect(labels(items)).toEqual(['bar', 'line']);
  });

  it("never lets the host's diagnostic sink hear a keystroke", async () => {
    const heard: string[] = [];
    const { items } = await complete(block('‸'), {
      config: { ...CONFIG, onDiagnostic: (diagnostic) => heard.push(diagnostic.code) },
    });
    expect(items.length).toBeGreaterThan(0);
    expect(heard).toEqual([]);
  });

  it('logs a malformed plugin once and answers with an empty list', async () => {
    const broken = { name: 'broken', version: '0.0.0', chartTypes: [{ name: 'half' }] };
    const { items, errors } = await complete(block('‸'), {
      config: { plugins: [broken] } as unknown as MdvConfig,
    });
    expect(items).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Completion has no registry');
  });
});

/**
 * The drift test.
 *
 * `@mdv/spec` ships the schemas as files rather than exports, so the two lists
 * in `completion.ts` are typed out by hand. This reads the file they were typed
 * out of: the keys, in schema order, and — for every property whose value comes
 * from an enum, or from a boolean, which is an enum of two — the members, taking
 * the property's own `oneOf`/`anyOf` branches as alternatives. A schema that
 * grows `legend: overlay` fails here rather than silently never being offered.
 */
describe('schemas/common/block.json', () => {
  interface Branch {
    readonly enum?: readonly unknown[];
    readonly type?: string;
    readonly oneOf?: readonly Branch[];
    readonly anyOf?: readonly Branch[];
  }

  const schema = JSON.parse(
    readFileSync(new URL('../../spec/schemas/common/block.json', import.meta.url), 'utf8'),
  ) as { readonly properties: Readonly<Record<string, Branch>> };

  function closedValues(property: Branch): string[] {
    const values: string[] = [];
    for (const branch of [property, ...(property.oneOf ?? []), ...(property.anyOf ?? [])]) {
      for (const member of branch.enum ?? []) values.push(String(member));
      if (branch.type === 'boolean') values.push('true', 'false');
    }
    return values;
  }

  it('names every key the server offers, in the order it offers them', () => {
    expect(Object.keys(schema.properties)).toEqual([...COMMON_ATTRS]);
  });

  it('names every value the server offers from a closed set', () => {
    const closed: Record<string, string[]> = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      const values = closedValues(property);
      if (values.length > 0) closed[key] = values;
    }
    expect(closed).toEqual(CLOSED_VALUES);
  });
});

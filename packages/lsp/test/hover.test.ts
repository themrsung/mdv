/**
 * Hover, from where the author is sitting (SPEC 29.4).
 *
 * The fixtures are completion's, marker and all, because the two features read
 * the same block the same way and a difference between them is the bug most
 * worth catching: a word that completes and then explains itself as something
 * else is worse than one that says nothing.
 *
 * What the stubs below say about `bar` is the whole of what hover can say about
 * `bar` — there are no built-in types here, and no prose written in the server.
 * Everything else comes from `@mdv/spec`, so the assertions name the schema's
 * fields rather than repeating their text: a description reworded upstream must
 * not be a test to fix here.
 */

import { describe, expect, it } from 'vitest';
import { attrDoc } from '@mdv/spec';
import { hover } from '../src/features/hover.js';
import { ErrorCodes } from '../src/protocol/jsonrpc.js';
import { MarkupKind } from '../src/protocol/types.js';
import { createServer } from '../src/server.js';
import { INITIALIZE_PARAMS, duplex, openParams, settle } from './harness.js';
import type { TestClient } from './harness.js';
import type { AttrDoc } from '@mdv/spec';
import type { Hover, InitializeResult, MarkupKindValue, Position } from '../src/protocol/types.js';
import type { ChartType, MdvConfig } from '@mdv/core';

const URI = 'file:///a.mdv';

/** Where the cursor is. Stripped from the fixture before the server sees it. */
const CURSOR = '‸';

/** Nothing in this file draws a chart; a stub that is asked to should say so. */
function unreachable(): never {
  throw new Error('the hover tests never render');
}

/** Two required channels, one optional, and two per-type defaults to describe. */
const BAR: ChartType = {
  name: 'bar',
  level: 1,
  family: 'mark',
  channels: [
    { name: 'x', required: true, accepts: ['category', 'date'], doc: 'The category axis.' },
    { name: 'y', required: true, accepts: ['number'], doc: 'The value axis.' },
    {
      name: 'color',
      required: false,
      accepts: ['category'],
      list: true,
      defaultScale: 'ordinal',
      doc: 'One series per value.',
    },
  ],
  defaultEncoding: {},
  defaults: { stack: 'none', barWidth: 0.8 },
  validate: () => [],
  encode: unreachable,
  layout: unreachable,
};

/** Level 2 and aliased, so the type line has something more to say. */
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

/** The same block inside a block quote, prefix and all (SPEC 4.2). */
function quote(source: string): string {
  return source
    .split('\n')
    .map((line) => (line === '' ? line : `> ${line}`))
    .join('\n');
}

/** Appendix D's entry for a key, which is what hover is expected to relay. */
function attr(name: string): AttrDoc {
  const doc = attrDoc(name);
  if (doc === undefined) throw new Error(`the schema documents no \`${name}\``);
  return doc;
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
  readonly config?: MdvConfig;
  /** What the client claims it can render; absent is LSP's plain text only. */
  readonly formats?: readonly MarkupKindValue[];
}

interface Started {
  readonly client: TestClient;
  readonly errors: string[];
  readonly result: InitializeResult;
}

/** A server with hover installed, past the handshake. */
async function started(options: Options = {}): Promise<Started> {
  const errors: string[] = [];
  const { client, server: transport } = duplex();
  const server = createServer(transport, {
    version: '0.0.0',
    logger: { info: () => {}, error: (message) => errors.push(message) },
    features: [hover(options.config === undefined ? {} : { config: options.config })],
  });
  server.listen();
  const params =
    options.formats === undefined
      ? INITIALIZE_PARAMS
      : {
          ...INITIALIZE_PARAMS,
          capabilities: { textDocument: { hover: { contentFormat: options.formats } } },
        };
  const result = (await client.call('initialize', params)) as InitializeResult;
  client.notify('initialized', {});
  await settle();
  return { client, errors, result };
}

interface Answer {
  readonly found: Hover | null;
  readonly errors: string[];
}

/** Open `source` with its cursor marker removed, and ask at the marker. */
async function hovering(source: string, options: Options = { config: CONFIG }): Promise<Answer> {
  const { text, position } = cursorIn(source);
  const { client, errors } = await started(options);
  client.notify('textDocument/didOpen', openParams(URI, text));
  await settle();
  const found = (await client.call('textDocument/hover', {
    textDocument: { uri: URI },
    position,
  })) as Hover | null;
  return { found, errors };
}

/** The hover there had better be, as text. */
async function text(source: string, options?: Options): Promise<string> {
  const { found } = await hovering(source, options);
  if (found === null) throw new Error('the fixture hovers nothing');
  return found.contents.value;
}

/** A single-line range, the shape of every range this feature returns. */
function range(line: number, start: number, end: number): unknown {
  return { start: { line, character: start }, end: { line, character: end } };
}

describe('textDocument/hover', () => {
  it('is advertised', async () => {
    const { result } = await started();
    expect(result.capabilities.hoverProvider).toBe(true);
  });

  it('has the protocol’s answer for a document that is not open', async () => {
    const { client } = await started({ config: CONFIG });
    const response = await client.request('textDocument/hover', {
      textDocument: { uri: 'file:///gone.mdv' },
      position: { line: 0, character: 0 },
    });
    expect(response.error?.code).toBe(ErrorCodes.invalidParams);
    expect(response.error?.message).toContain('file:///gone.mdv');
  });

  it('says nothing in the prose around a block', async () => {
    const { found } = await hovering(`# Repo‸rt\n\n${block('x: quarter')}`);
    expect(found).toBeNull();
  });

  it('says nothing below the separator, where the author is writing data', async () => {
    const { found } = await hovering(block('x: quarter').replace('Q1 | 100', 'Q‸1 | 100'));
    expect(found).toBeNull();
  });

  describe('on the fence line', () => {
    it('reads the block type, its channels and its defaults', async () => {
      expect(await text(block('x: quarter').replace('mdv bar', 'mdv b‸ar'))).toBe(
        [
          'bar · mark · level 1',
          '- x · category | date · required — The category axis.',
          '- y · number · required — The value axis.',
          '- color · category · list — One series per value.',
          'Defaults: stack: none, barWidth: 0.8',
        ].join('\n\n'),
      );
    });

    it('marks the type it read, and nothing around it', async () => {
      const { found } = await hovering(block().replace('mdv bar', 'mdv ba‸r'));
      expect(found?.range).toEqual(range(0, 7, 10));
    });

    it('says nothing about the words that are not a type', async () => {
      const { found } = await hovering(block().replace('mdv bar', 'm‸dv bar'));
      expect(found).toBeNull();
    });

    it('says nothing about a type no plugin registered', async () => {
      const { found } = await hovering(block().replace('mdv bar', 'mdv gan‸tt'));
      expect(found).toBeNull();
    });
  });

  describe('on a header key', () => {
    it('describes a channel the way the type that declares it does', async () => {
      expect(await text(block('‸x: quarter'))).toBe(
        'x · category | date · required\n\nThe category axis.',
      );
    });

    it('adds the scale a channel would pick for itself', async () => {
      expect(await text(block('col‸or: revenue'))).toBe(
        ['color · category · list', 'One series per value.', 'Scale: ordinal'].join('\n\n'),
      );
    });

    it('reads a common attribute out of the schema', async () => {
      const width = attr('width');
      expect(await text(block('wid‸th: 320px'))).toBe(
        [
          `width · ${width.type}`,
          width.description,
          `Default: ${String(width.default)}`,
          width.example,
        ].join('\n\n'),
      );
    });

    it('lists the values a closed set allows', async () => {
      const table = attr('table');
      expect(await text(block('ta‸ble: details'))).toContain(
        `Values: ${(table.values ?? []).join(' | ')}`,
      );
    });

    it('falls back to what the block type defaults a key to', async () => {
      expect(await text(block('sta‸ck: normal'))).toBe(
        ['stack', 'Set by the bar block type.', 'Default: none'].join('\n\n'),
      );
    });

    it('marks the key it read, and not what the container put in front of it', async () => {
      // Quoted rather than merely indented: a key indented past its own fence
      // is inside a nested map, which both features decline to talk about.
      const { found } = await hovering(quote(block('wid‸th: 320px')));
      expect(found?.range).toEqual(range(1, 2, 7));
    });

    it('says nothing about a key no one has documented', async () => {
      const { found } = await hovering(block('nones‸uch: 1'));
      expect(found).toBeNull();
    });

    it('says nothing about a key inside a nested map', async () => {
      const { found } = await hovering(block('axis:', '  y:', '    gr‸id: true'));
      expect(found).toBeNull();
    });
  });

  describe('on a value', () => {
    it('answers with the key the value belongs to', async () => {
      expect(await text(block('x: qua‸rter'))).toBe(
        'x · category | date · required\n\nThe category axis.',
      );
    });

    it('marks the value it read', async () => {
      const { found } = await hovering(block('x: qua‸rter'));
      expect(found?.range).toEqual(range(1, 3, 10));
    });

    it('reads the value of `type` as the block type it is', async () => {
      expect(await text(block('type: li‸ne'))).toContain('line · mark · level 2 · also spline');
    });

    it('falls back to the key when the value names no type', async () => {
      const type = attr('type');
      expect(await text(block('type: gan‸tt'))).toContain(`type · ${type.type}`);
    });

    it('says nothing inside a nested map', async () => {
      const { found } = await hovering(block('axis: {y: {grid: tr‸ue}}'));
      expect(found).toBeNull();
    });
  });

  describe('markup', () => {
    it('is plain text for a client that did not say otherwise', async () => {
      const { found } = await hovering(block('wid‸th: 320px'));
      expect(found?.contents.kind).toBe(MarkupKind.plainText);
      expect(found?.contents.value).not.toContain('**');
    });

    it('is Markdown for a client that asked for it', async () => {
      const { found } = await hovering(block('wid‸th: 320px'), {
        config: CONFIG,
        formats: [MarkupKind.markdown, MarkupKind.plainText],
      });
      const width = attr('width');
      expect(found?.contents.kind).toBe(MarkupKind.markdown);
      expect(found?.contents.value).toBe(
        [
          `**width** · ${width.type}`,
          width.description,
          `**Default:** \`${String(width.default)}\``,
          `\`\`\`yaml\n${String(width.example)}\n\`\`\``,
        ].join('\n\n'),
      );
    });

    it('writes the channel list as a Markdown list', async () => {
      const found = await text(block().replace('mdv bar', 'mdv b‸ar'), {
        config: CONFIG,
        formats: [MarkupKind.markdown],
      });
      expect(found).toContain('- **x** · category | date · required — The category axis.');
    });
  });

  it('never lets the host’s diagnostic sink hear a hover', async () => {
    const heard: string[] = [];
    const { found } = await hovering(block('‸x: quarter'), {
      config: { ...CONFIG, onDiagnostic: (diagnostic) => heard.push(diagnostic.code) },
    });
    expect(found).not.toBeNull();
    expect(heard).toEqual([]);
  });

  it('logs a malformed plugin once and says nothing', async () => {
    const broken = { name: 'broken', version: '0.0.0', chartTypes: [{ name: 'half' }] };
    const { found, errors } = await hovering(block('‸x: quarter'), {
      config: { plugins: [broken] } as unknown as MdvConfig,
    });
    expect(found).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Hover has no registry');
  });
});

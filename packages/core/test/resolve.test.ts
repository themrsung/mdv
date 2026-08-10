import { describe, expect, it } from 'vitest';
import type { AttrMap, FrontMatter, MdvBlock, MdvDocument, Range } from '@mdv/parser';
import type { FetchInit, FetchResult, MdvConfig } from '../src/types/config.js';
import type { DatasetNode } from '../src/types/data.js';
import { createCollector } from '../src/data/diag.js';
import {
  collectDatasets,
  dataOptionsFrom,
  emptyDocumentData,
  formatFromPath,
  resolveDocumentData,
  resolveDocumentDataSync,
  visualBlocks,
  type ResolveDataOptions,
} from '../src/resolve.js';

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — synthetic AST nodes, so the test exercises core alone
// ─────────────────────────────────────────────────────────────────────────────

const RANGE: Range = {
  start: { offset: 0, line: 1, column: 1 },
  end: { offset: 40, line: 4, column: 1 },
};

function block(blockType: string, attrs: AttrMap = {}, data = ''): MdvBlock {
  return {
    type: 'mdvBlock',
    blockType,
    attrs,
    attrsPosition: {},
    raw: { header: '', data, fence: '```' },
    level: 1,
    position: {
      start: { offset: 0, line: 3, column: 1 },
      end: { offset: 40, line: 8, column: 1 },
    },
  };
}

function frontmatter(partial: Partial<FrontMatter> = {}): FrontMatter {
  return { extra: {}, range: RANGE, attrsPosition: {}, attrsKeyPosition: {}, ...partial };
}

function document(children: readonly MdvBlock[], front?: FrontMatter): MdvDocument {
  return {
    type: 'root',
    children: [...children] as MdvDocument['children'],
    diagnostics: [],
    datasets: {},
    ...(front !== undefined ? { frontmatter: front } : {}),
  };
}

const CSV = 'quarter,revenue\nQ1,1240\nQ2,1510\n';

function collector() {
  return createCollector('data');
}

function codes(diagnostics: readonly { code: string }[]): string[] {
  return diagnostics.map((diagnostic) => diagnostic.code);
}

// ─────────────────────────────────────────────────────────────────────────────
// Options (SPEC 25)
// ─────────────────────────────────────────────────────────────────────────────

describe('dataOptionsFrom', () => {
  it('applies the SPEC 25 defaults when nothing is configured', () => {
    const options = dataOptionsFrom(undefined);

    expect(options.level).toBe(2);
    expect(options.timezone).toBe('UTC');
    expect(options.format.locale).toBe('en-US');
    expect(options.security).toEqual({
      allowExternal: false,
      allowedOrigins: [],
      allowFileUrls: false,
      fetchTimeoutMs: options.limits.fetchTimeoutMs,
    });
    expect(options.capabilities).toEqual({});
  });

  it('never reads the clock: the default build time is the epoch', () => {
    expect(dataOptionsFrom(undefined).buildTime.getTime()).toBe(0);
  });

  it('takes locale, timezone and build time from front matter', () => {
    const doc = document(
      [],
      frontmatter({ locale: 'de-DE', timezone: 'Europe/Berlin', date: '2026-01-31' }),
    );
    const options = dataOptionsFrom(undefined, doc);

    expect(options.format.locale).toBe('de-DE');
    expect(options.timezone).toBe('Europe/Berlin');
    // 2026-01-31T00:00 in Europe/Berlin is 23:00 UTC the day before.
    expect(options.buildTime.toISOString()).toBe('2026-01-30T23:00:00.000Z');
  });

  it('falls back from `locale:` to `lang:`', () => {
    const doc = document([], frontmatter({ lang: 'fr-FR' }));
    expect(dataOptionsFrom(undefined, doc).format.locale).toBe('fr-FR');
  });

  it('lets configuration outrank the document (SPEC 25)', () => {
    const doc = document(
      [],
      frontmatter({ locale: 'de-DE', timezone: 'Europe/Berlin', date: '2026-01-31' }),
    );
    const config: MdvConfig = {
      locale: 'en-GB',
      timezone: 'UTC',
      buildTime: new Date('2026-08-10T12:00:00Z'),
      level: 1,
    };
    const options = dataOptionsFrom(config, doc);

    expect(options.format.locale).toBe('en-GB');
    expect(options.timezone).toBe('UTC');
    expect(options.buildTime.toISOString()).toBe('2026-08-10T12:00:00.000Z');
    expect(options.level).toBe(1);
  });

  it('ignores a `date:` that is not a date', () => {
    const doc = document([], frontmatter({ date: 'last Thursday' }));
    expect(dataOptionsFrom(undefined, doc).buildTime.getTime()).toBe(0);
  });

  it('carries the security slice and the capabilities through', () => {
    const options = dataOptionsFrom({
      security: {
        allowExternal: true,
        allowedOrigins: ['https://data.example.com'],
        allowFileUrls: true,
        fetchTimeoutMs: 250,
      },
      capabilities: { readFile: async () => new Uint8Array() },
    });

    expect(options.security.allowExternal).toBe(true);
    expect(options.security.allowedOrigins).toEqual(['https://data.example.com']);
    expect(options.security.allowFileUrls).toBe(true);
    expect(options.security.fetchTimeoutMs).toBe(250);
    expect(options.limits.fetchTimeoutMs).toBe(250);
    expect(options.capabilities.readFile).toBeTypeOf('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Collecting (SPEC 6.3)
// ─────────────────────────────────────────────────────────────────────────────

describe('collectDatasets', () => {
  it('reads a front-matter alias written in shorthand', () => {
    const doc = document([], frontmatter({ datasets: { q1: '@sales' } }));
    const collected = collectDatasets(doc, collector());

    expect(collected.declarations).toEqual([
      { id: 'q1', origin: 'front-matter', from: '@sales', range: RANGE },
    ]);
  });

  it('reads a front-matter mapping, including its reader options', () => {
    const doc = document(
      [],
      frontmatter({
        datasets: { sales: { src: 'sales.csv', format: 'csv', delimiter: ';', header: false } },
      }),
    );
    const collected = collectDatasets(doc, collector());
    const declaration = collected.declarations[0];

    expect(declaration?.id).toBe('sales');
    expect(declaration?.origin).toBe('front-matter');
    expect(declaration?.src).toBe('sales.csv');
    expect(declaration?.format).toBe('csv');
    expect(collected.sectionOptions['sales']).toEqual({ delimiter: ';', header: false });
  });

  it('keeps a malformed front-matter declaration but states why it has no data', () => {
    const doc = document([], frontmatter({ datasets: { sales: 42 } }));
    const diag = collector();
    const collected = collectDatasets(doc, diag);

    expect(collected.declarations).toEqual([{ id: 'sales', origin: 'front-matter', range: RANGE }]);
    expect(codes(diag.diagnostics)).toEqual(['MDV1220']);
  });

  it('reads a `dataset` block and its data section', () => {
    const doc = document([block('dataset', { id: 'sales', format: 'csv' }, CSV)]);
    const collected = collectDatasets(doc, collector());

    expect(collected.blocks).toEqual([]);
    expect(collected.declarations[0]?.id).toBe('sales');
    expect(collected.declarations[0]?.origin).toBe('block');
    expect(collected.declarations[0]?.raw).toBe(CSV);
  });

  it('ignores a `dataset` block with no string id, with a diagnostic', () => {
    const doc = document([block('dataset', {}, CSV)]);
    const diag = collector();
    const collected = collectDatasets(doc, diag);

    expect(collected.declarations).toEqual([]);
    expect(codes(diag.diagnostics)).toEqual(['MDV1220']);
  });

  it('turns an inline data section into a synthetic dataset', () => {
    const doc = document([block('bar', { format: 'csv', delimiter: ',' }, CSV)]);
    const collected = collectDatasets(doc, collector());

    expect(collected.declarations[0]?.id).toBe('#block-0');
    expect(collected.declarations[0]?.origin).toBe('inline');
    expect(collected.declarations[0]?.raw).toBe(CSV);
    expect(collected.blocks[0]?.reference).toBe('@#block-0');
    expect(collected.sectionOptions['#block-0']).toEqual({ delimiter: ',' });
  });

  it('passes a `data:` reference through without declaring anything', () => {
    const doc = document([
      block('dataset', { id: 'sales', format: 'csv' }, CSV),
      block('bar', { data: ' @sales[quarter, revenue] ' }),
    ]);
    const collected = collectDatasets(doc, collector());

    expect(collected.declarations.map((declaration) => declaration.id)).toEqual(['sales']);
    expect(collected.blocks).toHaveLength(1);
    expect(collected.blocks[0]?.reference).toBe('@sales[quarter, revenue]');
    expect(collected.sectionOptions['#block-0']).toBeUndefined();
  });

  it('numbers blocks in document order, skipping `dataset` blocks', () => {
    const doc = document([
      block('bar', {}, CSV),
      block('dataset', { id: 'sales' }, CSV),
      block('line', {}, CSV),
    ]);
    const collected = collectDatasets(doc, collector());

    expect(collected.blocks.map((request) => request.index)).toEqual([0, 1]);
    expect(collected.blocks.map((request) => request.reference)).toEqual([
      '@#block-0',
      '@#block-1',
    ]);
  });

  it('reads a block-level `transform:` pipeline', () => {
    const doc = document([
      block('bar', { format: 'csv', transform: [{ filter: 'revenue > 1300' }] }, CSV),
    ]);
    const collected = collectDatasets(doc, collector());

    expect(collected.blocks[0]?.transform).toEqual([{ filter: 'revenue > 1300' }]);
  });
});

describe('visualBlocks', () => {
  it('finds nested blocks in document order', () => {
    const first = block('bar');
    const nested = block('line');
    const last = block('area');
    const doc = document([first, last]);
    doc.children.splice(1, 0, {
      type: 'mdvDirective',
      kind: 'container',
      name: 'mdv-grid',
      attrs: {},
      attrsPosition: {},
      children: [nested],
    });

    expect(visualBlocks(doc).map((found) => found.blockType)).toEqual(['bar', 'line', 'area']);
  });

  it('returns nothing for a document with no blocks', () => {
    expect(visualBlocks(document([]))).toEqual([]);
  });
});

describe('formatFromPath', () => {
  it.each([
    ['https://example.com/a.csv', 'csv'],
    ['https://example.com/a.tsv', 'tsv'],
    ['https://example.com/a.TAB', 'tsv'],
    ['https://example.com/a.json?v=2', 'json'],
    ['https://example.com/a.ndjson#frag', 'ndjson'],
    ['https://example.com/a.jsonl', 'ndjson'],
    ['data/a.md', 'table'],
    ['data/a.markdown', 'table'],
  ])('reads %s as %s', (url, expected) => {
    expect(formatFromPath(url)).toBe(expected);
  });

  it('has no opinion about an unknown or missing extension', () => {
    expect(formatFromPath('https://example.com/data')).toBeUndefined();
    expect(formatFromPath('https://example.com/data.bin')).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The synchronous stage
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveDocumentDataSync', () => {
  it('gives an inline block its table', () => {
    const doc = document([block('bar', { format: 'csv' }, CSV)]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));
    const first = data.blocks[0];

    expect(data.blocks).toHaveLength(1);
    expect(first?.state).toBe('ready');
    expect(first?.table.fields.map((field) => field.name)).toEqual(['quarter', 'revenue']);
    expect(first?.table.rows).toEqual([
      ['Q1', 1240],
      ['Q2', 1510],
    ]);
    expect(data.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
  });

  it('attaches the ref to the AST and the nodes to the document', () => {
    const source = block('bar', { format: 'csv' }, CSV);
    const doc = document([source]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(source.data).toEqual(data.blocks[0]?.ref);
    expect(source.data?.datasetId).toBe('#block-0');
    expect(Object.keys(doc.datasets)).toEqual(['#block-0']);
    // `MdvDocument.datasets` is `unknown`-valued by design (SPEC 17.2).
    expect((doc.datasets['#block-0'] as DatasetNode | undefined)?.state).toBe('ready');
  });

  it('resolves a reference to a declared dataset, projection included', () => {
    const doc = document([
      block('dataset', { id: 'sales', format: 'csv' }, CSV),
      block('bar', { data: '@sales[revenue]' }),
    ]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(data.blocks[0]?.state).toBe('ready');
    expect(data.blocks[0]?.table.fields.map((field) => field.name)).toEqual(['revenue']);
    expect(data.blocks[0]?.table.rows).toEqual([[1240], [1510]]);
    expect(data.registry.list().map((node) => node.id)).toEqual(['sales']);
  });

  it('evaluates one dataset once for N charts (SPEC 6.7)', () => {
    const doc = document([
      block('dataset', { id: 'sales', format: 'csv' }, CSV),
      block('bar', { data: '@sales' }),
      block('line', { data: '@sales' }),
    ]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(data.blocks[0]?.ref.key).toBe(data.blocks[1]?.ref.key);
    expect(data.blocks[0]?.table).toBe(data.blocks[1]?.table);
  });

  it('applies a block-level transform without disturbing the dataset', () => {
    const doc = document([
      block('dataset', { id: 'sales', format: 'csv' }, CSV),
      block('bar', { data: '@sales', transform: [{ filter: 'revenue > 1300' }] }),
      block('line', { data: '@sales' }),
    ]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(data.blocks[0]?.table.rows).toEqual([['Q2', 1510]]);
    expect(data.blocks[1]?.table.rows).toHaveLength(2);
    expect(data.blocks[0]?.ref.key).not.toBe(data.blocks[1]?.ref.key);
  });

  it('refuses to fetch, and says so, rather than drawing an empty chart', () => {
    const doc = document([block('bar', { src: 'https://example.com/a.csv' })]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(data.nodes[0]?.state).toBe('blocked');
    expect(data.nodes[0]?.stateReason).toBe('MDV4001');
    expect(data.blocks[0]?.state).toBe('blocked');
    expect(data.blocks[0]?.reason).toBe('MDV4001');
    expect(data.blocks[0]?.table.rows).toEqual([]);
    expect(codes(data.diagnostics)).toContain('MDV4001');
  });

  it('reports an unresolved reference and hands back an empty table', () => {
    const doc = document([block('bar', { data: '@missing' })]);
    const data = resolveDocumentDataSync(doc, dataOptionsFrom(undefined, doc));

    expect(data.blocks[0]?.state).toBe('failed');
    expect(data.blocks[0]?.reason).toBe('MDV2142');
    expect(data.blocks[0]?.table).toEqual({ fields: [], rows: [] });
    expect(codes(data.diagnostics)).toContain('MDV2142');
  });

  it('holds a document with nothing in it', () => {
    const data = resolveDocumentDataSync(document([]), dataOptionsFrom(undefined));

    expect(data.blocks).toEqual([]);
    expect(data.nodes).toEqual([]);
    expect(data.diagnostics).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The asynchronous stage (SPEC 18 stage 2)
// ─────────────────────────────────────────────────────────────────────────────

/** A `fetch` capability that answers from a fixed table of URLs. */
function fetchFrom(
  responses: Record<string, { body: string; contentType?: string; status?: number }>,
  log?: string[],
): (url: string, init: FetchInit) => Promise<FetchResult> {
  return async (url) => {
    log?.push(url);
    const answer = responses[url];
    if (answer === undefined) return { status: 404, url, body: new Uint8Array() };
    return {
      status: answer.status ?? 200,
      url,
      body: new TextEncoder().encode(answer.body),
      ...(answer.contentType !== undefined ? { contentType: answer.contentType } : {}),
    };
  };
}

function allowing(
  responses: Record<string, { body: string; contentType?: string; status?: number }>,
  log?: string[],
): ResolveDataOptions {
  return dataOptionsFrom({
    security: { allowExternal: true, allowedOrigins: ['https://data.example.com'] },
    capabilities: { fetch: fetchFrom(responses, log) },
  });
}

describe('resolveDocumentData', () => {
  it('loads a `src:` dataset through the injected capability', async () => {
    const log: string[] = [];
    const doc = document([
      block('dataset', { id: 'sales', src: 'https://data.example.com/sales.csv' }),
      block('bar', { data: '@sales' }),
    ]);
    const data = await resolveDocumentData(
      doc,
      allowing({ 'https://data.example.com/sales.csv': { body: CSV } }, log),
    );

    expect(log).toEqual(['https://data.example.com/sales.csv']);
    expect(data.nodes[0]?.state).toBe('ready');
    expect(data.nodes[0]?.format).toBe('csv');
    expect(data.blocks[0]?.state).toBe('ready');
    expect(data.blocks[0]?.table.rows).toEqual([
      ['Q1', 1240],
      ['Q2', 1510],
    ]);
  });

  it('takes the format from the content type when the URL has no extension', async () => {
    const doc = document([
      block('dataset', { id: 'sales', src: 'https://data.example.com/latest' }),
      block('bar', { data: '@sales' }),
    ]);
    const data = await resolveDocumentData(
      doc,
      allowing({ 'https://data.example.com/latest': { body: CSV, contentType: 'text/csv' } }),
    );

    expect(data.nodes[0]?.format).toBe('csv');
    expect(data.blocks[0]?.table.rows).toHaveLength(2);
  });

  it('blocks an external source that policy never allowed', async () => {
    const doc = document([block('bar', { src: 'https://data.example.com/sales.csv' })]);
    const data = await resolveDocumentData(doc, dataOptionsFrom(undefined, doc));

    expect(data.nodes[0]?.state).toBe('blocked');
    expect(data.nodes[0]?.stateReason).toBe('MDV4002');
    expect(data.blocks[0]?.table.rows).toEqual([]);
    expect(codes(data.diagnostics)).toContain('MDV4002');
  });

  it('blocks an origin that is not on the allowlist', async () => {
    const doc = document([block('bar', { src: 'https://elsewhere.example.com/sales.csv' })]);
    const data = await resolveDocumentData(doc, allowing({}));

    expect(data.nodes[0]?.state).toBe('blocked');
    expect(data.nodes[0]?.stateReason).toBe('MDV4003');
    expect(data.blocks[0]?.state).toBe('blocked');
  });

  it('fails, with a reason, when the server does not answer with the data', async () => {
    const doc = document([block('bar', { src: 'https://data.example.com/gone.csv' })]);
    const data = await resolveDocumentData(doc, allowing({}));

    expect(data.nodes[0]?.state).toBe('failed');
    expect(data.nodes[0]?.stateReason).toBe('MDV4023');
    expect(data.blocks[0]?.state).toBe('failed');
    expect(data.blocks[0]?.table).toEqual({ fields: [], rows: [] });
  });

  it('orders diagnostics by declaration, not by which server answered first', async () => {
    const doc = document([
      block('dataset', { id: 'first', src: 'https://data.example.com/first.csv' }),
      block('dataset', { id: 'second', src: 'https://elsewhere.example.com/second.csv' }),
    ]);
    const data = await resolveDocumentData(doc, allowing({}));

    expect(codes(data.diagnostics)).toEqual(['MDV4023', 'MDV4003']);
  });

  it('leaves an inline block alone: nothing is fetched for it', async () => {
    const log: string[] = [];
    const doc = document([block('bar', { format: 'csv' }, CSV)]);
    const data = await resolveDocumentData(doc, allowing({}, log));

    expect(log).toEqual([]);
    expect(data.blocks[0]?.state).toBe('ready');
  });
});

describe('emptyDocumentData', () => {
  it('answers like a populated result, with nothing in it', () => {
    const data = emptyDocumentData();

    expect(data.blocks).toEqual([]);
    expect(data.nodes).toEqual([]);
    expect(data.diagnostics).toEqual([]);
    expect(data.registry.list()).toEqual([]);
    expect(data.registry.has('sales')).toBe(false);
    expect(data.registry.get('sales')).toBeUndefined();
    expect(data.registry.resolve({ datasetId: 'sales', key: 'sales' })).toBeUndefined();
  });

  it('is a fresh result every time', () => {
    expect(emptyDocumentData().cache).not.toBe(emptyDocumentData().cache);
  });
});

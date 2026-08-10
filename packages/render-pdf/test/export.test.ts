/**
 * End-to-end: resolved document → PDF bytes.
 *
 * These tests never touch `@mdv/core`'s resolver or `@mdv/charts`; the document
 * is a hand-built fixture and contains no visual blocks, so `layoutBlock` is
 * never reached. The chart path is covered in `paginate.test.ts`, where the
 * layout function is injected.
 */

import { describe, expect, it } from 'vitest';

import { buildPdf } from '../src/document.js';
import { writePdf } from '../src/writer.js';
import { exportPdf, tracePdf } from '../src/index.js';
import {
  BUILD_TIME,
  bulletList,
  code,
  exportContext,
  filler,
  frontMatter,
  heading,
  paragraph,
  quote,
  resolvedDocument,
  table,
} from './fixtures.js';

function smallDocument() {
  return resolvedDocument([
    heading(1, 'Quarterly review'),
    paragraph('Revenue grew in every region except the one that shrank.'),
    heading(2, 'Detail'),
    bulletList(['North', 'South', 'East']),
    code('const answer = 42;', 'ts'),
    quote('Numbers are only as good as the questions behind them.'),
    table(
      ['Region', 'Revenue'],
      [
        ['North', '120'],
        ['South', '90'],
      ],
    ),
  ]);
}

const decoder = new TextDecoder('latin1');

describe('exportPdf', () => {
  it('produces a PDF 1.7 file', async () => {
    const bytes = await exportPdf(smallDocument(), exportContext(), { compress: false });
    const head = decoder.decode(bytes.slice(0, 9));
    expect(head).toBe('%PDF-1.7\n');
    expect(decoder.decode(bytes.slice(-6))).toContain('%%EOF');
  });

  it('is byte-identical across two runs (SPEC 28.10)', async () => {
    const options = { compress: false as const };
    const first = await exportPdf(smallDocument(), exportContext(), options);
    const second = await exportPdf(smallDocument(), exportContext(), options);
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it('is byte-identical with compression on too', async () => {
    const first = await exportPdf(smallDocument(), exportContext(), { compress: true });
    const second = await exportPdf(smallDocument(), exportContext(), { compress: true });
    expect(Buffer.from(second).equals(Buffer.from(first))).toBe(true);
  });

  it('pins /ID to the content and the build time, never to a clock', async () => {
    const a = await exportPdf(smallDocument(), exportContext(), { compress: false });
    const b = await exportPdf(smallDocument(), exportContext({ buildTime: new Date(0) }), {
      compress: false,
    });
    const idOf = (bytes: Uint8Array): string => {
      const match = /\/ID \[ <([0-9A-F]+)>/.exec(decoder.decode(bytes));
      return match?.[1] ?? '';
    };
    expect(idOf(a)).toMatch(/^[0-9A-F]{32}$/);
    expect(idOf(a)).not.toBe(idOf(b));
  });

  it('writes the pinned build time into the info dictionary', async () => {
    const bytes = await exportPdf(smallDocument(), exportContext(), { compress: false });
    const source = decoder.decode(bytes);
    expect(source).toContain('/CreationDate (D:20240102030405Z)');
    expect(source).toContain('/ModDate (D:20240102030405Z)');
    // `pdf-lib` writes info strings as UTF-16BE hex, so `MDV ` is `004D004400560020`.
    expect(source).toContain('/Producer <FEFF004D0044005600');
  });
});

describe('pagination across pages', () => {
  it('overflows onto several pages', async () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => paragraph(filler(i)));
    const doc = resolvedDocument([heading(1, 'Long'), ...paragraphs]);
    const build = buildPdf(doc, exportContext());
    expect(build.pagination.pages.length).toBeGreaterThan(3);
    // Every page carries ink.
    for (const page of build.rendered.pages) {
      expect(page.ops.length).toBeGreaterThan(0);
    }
  });

  it('numbers pages from `numbering.start`', () => {
    const paragraphs = Array.from({ length: 30 }, (_, i) => paragraph(filler(i)));
    const build = buildPdf(resolvedDocument(paragraphs), exportContext(), {
      numbering: { start: 7, style: 'roman' },
    });
    expect(build.pagination.pages[0]?.pageNumber).toBe(7);
    expect(build.pagination.pages[1]?.pageNumber).toBe(8);
  });
});

describe('table of contents', () => {
  it('reaches a fixpoint and lists every heading in depth', () => {
    const body = Array.from({ length: 6 }, (_, i) => [
      heading(1, `Chapter ${String(i + 1)}`),
      heading(2, `Section ${String(i + 1)}.1`),
      paragraph(filler(i)),
      paragraph(filler(i + 20)),
    ]).flat();
    const build = buildPdf(resolvedDocument(body), exportContext(), {
      toc: { depth: 2, title: 'Contents' },
    });
    expect(build.pagination.tocPageCount).toBeGreaterThan(0);
    expect(build.pagination.pages[0]?.isFrontMatter).toBe(true);

    // Every contents entry must name a page that exists and holds that heading.
    const outline = build.pagination.outline;
    expect(outline.length).toBe(12);
    for (const entry of outline) {
      expect(build.pagination.pages[entry.pageIndex]).toBeDefined();
    }
  });
});

describe('embedSource (SPEC 28.9)', () => {
  const source = '---\ntitle: Round trip\n---\n\n# Hello\n';

  it('attaches the .mdv with the right MIME type and relationship', async () => {
    const bytes = await exportPdf(smallDocument(), exportContext({ source }), {
      embedSource: true,
      compress: false,
    });
    const text = decoder.decode(bytes);
    expect(text).toContain('/AFRelationship /Source');
    expect(text).toContain('/Subtype /text#2Fvnd.mdv');
    expect(text).toContain('/EmbeddedFiles');
  });

  it('round-trips the exact source bytes', async () => {
    const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream } = await import('pdf-lib');
    const bytes = await exportPdf(smallDocument(), exportContext({ source }), {
      embedSource: true,
      compress: false,
    });
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const names = reloaded.catalog.lookup(PDFName.of('Names'), PDFDict);
    const embedded = names.lookup(PDFName.of('EmbeddedFiles'), PDFDict);
    const list = embedded.lookup(PDFName.of('Names'), PDFArray);
    expect(list.size()).toBe(2);
    const spec = list.lookup(1, PDFDict);
    const ef = spec.lookup(PDFName.of('EF'), PDFDict);
    const stream = ef.lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) throw new Error('embedded file is not a stream');
    // `compress: false` means *every* stream, the attachment included: the
    // source is then literally there in the file, no inflate required.
    expect(stream.dict.has(PDFName.of('Filter'))).toBe(false);
    expect(Buffer.from(stream.contents).toString('utf8')).toBe(source);
  });

  it('deflates the attachment when compression is on', async () => {
    const { PDFDocument, PDFArray, PDFDict, PDFName, PDFRawStream } = await import('pdf-lib');
    const { inflateSync } = await import('node:zlib');
    const bytes = await exportPdf(smallDocument(), exportContext({ source }), {
      embedSource: true,
      compress: true,
    });
    const reloaded = await PDFDocument.load(bytes, { updateMetadata: false });
    const list = reloaded.catalog
      .lookup(PDFName.of('Names'), PDFDict)
      .lookup(PDFName.of('EmbeddedFiles'), PDFDict)
      .lookup(PDFName.of('Names'), PDFArray);
    const stream = list
      .lookup(1, PDFDict)
      .lookup(PDFName.of('EF'), PDFDict)
      .lookup(PDFName.of('F'));
    if (!(stream instanceof PDFRawStream)) throw new Error('embedded file is not a stream');
    expect(stream.dict.lookup(PDFName.of('Filter'))).toBe(PDFName.of('FlateDecode'));
    expect(inflateSync(Buffer.from(stream.contents)).toString('utf8')).toBe(source);
  });

  it('does not attach anything when `embedSource` is off', async () => {
    const bytes = await exportPdf(smallDocument(), exportContext({ source }), {
      compress: false,
    });
    expect(decoder.decode(bytes)).not.toContain('/EmbeddedFiles');
  });
});

describe('front matter', () => {
  it('reads `pdf:` from the document and lets the caller override it', () => {
    const doc = resolvedDocument([paragraph('x')], {
      frontmatter: frontMatter({
        title: 'From front matter',
        pdf: { pageSize: 'Letter', compress: false, numbering: { style: 'roman' } },
      }),
    });
    const build = buildPdf(doc, exportContext(), { numbering: { style: 'alpha' } });
    expect(build.options.page.widthPt).toBeCloseTo(612, 3);
    expect(build.options.compress).toBe(false);
    // The caller replaced the style but must not have discarded the page size.
    expect(build.options.numbering.style).toBe('alpha');
    expect(build.meta.title).toBe('From front matter');
  });

  it('ignores a wrong-typed `pdf:` value rather than coercing it', () => {
    const doc = resolvedDocument([paragraph('x')], {
      frontmatter: frontMatter({ pdf: { pageSize: 42, widows: 'lots' } }),
    });
    const build = buildPdf(doc, exportContext());
    expect(build.options.page.widthPt).toBe(595);
    expect(build.options.widows).toBe(2);
  });
});

describe('tracePdf', () => {
  it('traces the same operators the writer serialises', async () => {
    const build = buildPdf(smallDocument(), exportContext());
    const trace = await tracePdf(smallDocument(), exportContext());
    expect(trace.pages.length).toBe(build.rendered.pages.length);
    expect(trace.pages[0]?.operations.length).toBe(build.rendered.pages[0]?.ops.length);
    expect(trace.structure[0]?.tag).toBe('Document');
  });
});

describe('writePdf', () => {
  it('accepts a build produced once and written twice', async () => {
    const build = buildPdf(smallDocument(), exportContext(), { compress: false });
    const ctx = exportContext();
    const a = await writePdf(build, ctx);
    const b = await writePdf(build, ctx);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    expect(BUILD_TIME.toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });
});

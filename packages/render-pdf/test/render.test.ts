/**
 * Operators, links and the structure tree (SPEC 28.7, 28.8, 28.10).
 */

import { describe, expect, it } from 'vitest';

import { buildPdf } from '../src/document.js';
import { buildTrace } from '../src/trace.js';
import { buildFlow } from '../src/flow.js';
import { createDocStyle } from '../src/style.js';
import { createStandardFontMetrics } from '../src/fonts.js';
import { resolveOptions } from '../src/options.js';
import { paginate } from '../src/paginate.js';
import type { BlockLayout, BlockSize } from '../src/paginate.js';
import { render, interpolateRunning } from '../src/render.js';
import type { StructElement } from '../src/render.js';
import { naturalSize } from '../src/size.js';
import { PdfProfileError } from '../src/diagnostics.js';
import type { PdfExportOptions } from '../src/options.js';
import type { PdfOp } from '../src/ops.js';
import {
  TEST_THEME,
  directive,
  exportContext,
  filler,
  heading,
  mdvBlock,
  paragraph,
  resolvedBlock,
  resolvedDocument,
  stubScene,
  table,
  text,
} from './fixtures.js';
import type { ResolvedDocument } from '@mdv/core';
import type { Paragraph } from '@mdv/parser';

const metrics = createStandardFontMetrics();
const style = createDocStyle(TEST_THEME);

function renderDoc(
  doc: ResolvedDocument,
  opts: PdfExportOptions = {},
  scene: (width: number, height: number) => ReturnType<typeof stubScene> = (w, h) =>
    stubScene(w, h, 'Revenue', 'Two bars.'),
) {
  const options = resolveOptions(opts);
  const layout: BlockLayout = (_block, w, h) => scene(w, h);
  const size: BlockSize = (block, columnPx) => naturalSize(block.attrs, columnPx, TEST_THEME);
  const pagination = paginate({
    flow: buildFlow(doc),
    style,
    metrics,
    options,
    layout,
    size,
  });
  return render({
    pages: pagination.pages,
    style,
    metrics,
    options,
    destinations: pagination.destinations,
    running: { title: 'Report', subtitle: 'Q1', author: 'Ada', date: '2024-01-02' },
    lang: 'en',
  });
}

/** Depth-first list of `type` for the whole structure tree. */
function tags(node: StructElement, out: string[] = []): string[] {
  out.push(node.type);
  for (const kid of node.kids) if (kid.kind !== 'mcid') tags(kid, out);
  return out;
}

/** How many `/Artifact BDC` sequences a page opens. */
function artifactCount(ops: readonly PdfOp[]): number {
  return ops.filter(
    (op) => op.op === 'BDC' && op.args[0]?.k === 'name' && op.args[0].v === 'Artifact',
  ).length;
}

function countMcids(node: StructElement): number {
  let total = 0;
  for (const kid of node.kids) {
    if (kid.kind === 'mcid') total += 1;
    else total += countMcids(kid);
  }
  return total;
}

describe('operator trace (SPEC 28.10)', () => {
  it('matches the recorded trace for a small document', () => {
    const doc = resolvedDocument([
      heading(1, 'Title'),
      paragraph('One short line.'),
    ]);
    const build = buildPdf(doc, exportContext(), { compress: false });
    expect(buildTrace(build)).toMatchSnapshot();
  });

  it('reports the page resources it used', () => {
    const doc = resolvedDocument([heading(1, 'Title'), paragraph('Body text.')]);
    const build = buildPdf(doc, exportContext());
    // Bold heading and regular body are two faces.
    expect(build.rendered.pages[0]?.pool.names()).toEqual(['F0', 'F1']);
  });
});

describe('structure tree (SPEC 28.8)', () => {
  it('gives each paragraph its own /P and each wrapped line its own MCID', () => {
    const doc = resolvedDocument([paragraph('short one'), paragraph(filler(1))]);
    const result = renderDoc(doc);
    const kids = result.structure.kids.filter(
      (kid): kid is StructElement => kid.kind === 'element',
    );
    expect(kids.map((kid) => kid.type)).toEqual(['P', 'P']);
    expect(countMcids(kids[0] as StructElement)).toBe(1);
    // The filler wraps onto several lines but stays one paragraph.
    expect(countMcids(kids[1] as StructElement)).toBeGreaterThan(1);
  });

  it('nests a table as Table › TR › TD, under its numbered caption', () => {
    const doc = resolvedDocument([table(['A', 'B'], [['1', '2']])]);
    const result = renderDoc(doc);
    // Tables are numbered (SPEC 28.7), so the label alone is a caption.
    expect(tags(result.structure)).toEqual([
      'Document',
      'Caption',
      'Table',
      'TR',
      'TH',
      'TH',
      'TR',
      'TD',
      'TD',
    ]);
  });

  it('keeps consecutive list items apart', () => {
    const doc = resolvedDocument([
      {
        type: 'list',
        ordered: false,
        spread: false,
        children: ['alpha', 'beta'].map((value) => ({
          type: 'listItem' as const,
          spread: false,
          checked: null,
          children: [paragraph(value)],
        })),
      },
    ]);
    const result = renderDoc(doc);
    expect(tags(result.structure)).toEqual([
      'Document',
      'L',
      'LI',
      'LBody',
      'P',
      'LI',
      'LBody',
      'P',
    ]);
  });

  it('marks running heads and rules as artifacts', () => {
    const doc = resolvedDocument([paragraph('x'), { type: 'thematicBreak' }, paragraph('y')]);
    const result = renderDoc(doc, {
      header: { center: '{title}' },
      headerOnFirstPage: true,
    });
    // Two paragraphs only; the rule and the header contribute no MCIDs.
    expect(countMcids(result.structure)).toBe(2);
    expect(artifactCount(result.pages[0]?.ops ?? [])).toBeGreaterThanOrEqual(2);
  });

  it('fails a PDF/UA export when a figure has no description (MDV5110)', () => {
    const block = mdvBlock('bar');
    const doc = resolvedDocument([block], { blocks: [resolvedBlock(block, 0)] });
    expect(() =>
      renderDoc(doc, { profile: 'pdf-ua-1' }, (w, h) => {
        const scene = stubScene(w, h, '');
        return { ...scene, a11y: { ...scene.a11y, name: '', descGenerated: true } };
      }),
    ).toThrow(PdfProfileError);
  });

  it('accepts a PDF/UA export when the description is there', () => {
    const block = mdvBlock('bar', { title: 'Revenue' });
    const doc = resolvedDocument([block], {
      blocks: [resolvedBlock(block, 0, { title: 'Revenue' })],
    });
    const result = renderDoc(doc, { profile: 'pdf-ua-1' });
    expect(tags(result.structure)).toContain('Figure');
  });
});

describe('links (SPEC 28.7)', () => {
  const linked: Paragraph = {
    type: 'paragraph',
    children: [
      { type: 'link', url: 'https://example.org/a(b)', children: [text('external')] },
      text(' and '),
      {
        type: 'mdvDirective',
        kind: 'inline',
        name: 'mdv-ref',
        // `:mdv-ref[target]` — the bracketed label *is* the destination name.
        label: 'target',
        attrs: {},
        attrsPosition: {},
      },
    ],
  };

  it('emits an external /Link with the URL', () => {
    const doc = resolvedDocument([linked, { ...heading(2, 'Target'), depth: 2 }]);
    const result = renderDoc(doc);
    const link = result.pages[0]?.links.find((l) => l.url !== undefined);
    expect(link?.url).toBe('https://example.org/a(b)');
    expect(link?.rect[2]).toBeGreaterThan(link?.rect[0] ?? 0);
  });

  it('resolves an internal reference to a page position', () => {
    const doc = resolvedDocument([linked, heading(2, 'Target')]);
    const result = renderDoc(doc);
    const internal = result.pages[0]?.links.find((l) => l.dest !== undefined);
    expect(internal?.dest?.pageIndex).toBe(0);
    expect(internal?.dest?.yPt).toBeGreaterThan(0);
  });

  it('emits no annotation for a reference with no target', () => {
    const doc = resolvedDocument([linked]);
    const result = renderDoc(doc);
    expect(result.pages[0]?.links.filter((l) => l.dest !== undefined)).toHaveLength(0);
  });

  it('drops every annotation when `links: false`', () => {
    const doc = resolvedDocument([linked, heading(2, 'Target')]);
    const result = renderDoc(doc, { links: false });
    expect(result.pages[0]?.links.filter((l) => l.dest !== undefined)).toHaveLength(0);
  });

  it('appends the link appendix when asked (SPEC 28.7)', () => {
    const doc = resolvedDocument([linked]);
    const build = buildPdf(doc, exportContext(), { linkAppendix: true });
    const printed = build.rendered.pages
      .flatMap((page) => page.ops)
      .filter((op) => op.op === 'Tj')
      .map((op) => op.args[0])
      .filter((arg): arg is { k: 'text'; v: string; font: string } =>
        typeof arg === 'object' && arg.k === 'text',
      )
      .map((arg) => arg.v)
      .join(' ');
    expect(printed).toContain('https://example.org/a(b)');
  });
});

describe('running heads (SPEC 28.2)', () => {
  it('interpolates every documented slot', () => {
    const values = {
      title: 'T',
      subtitle: 'S',
      author: 'A',
      date: 'D',
      page: '3',
      pages: '9',
      section: 'Sec',
      chapter: 'Ch',
    };
    expect(
      interpolateRunning('{title}/{subtitle}/{author}/{date}/{page}/{pages}/{section}/{chapter}', values),
    ).toBe('T/S/A/D/3/9/Sec/Ch');
  });

  it('leaves an unknown slot visible rather than blanking it', () => {
    expect(interpolateRunning('{nope}', { title: 'T' })).toBe('{nope}');
  });

  it('skips the header on the first page unless asked', () => {
    const doc = resolvedDocument(Array.from({ length: 40 }, (_, i) => paragraph(filler(i))));
    const result = renderDoc(doc, { header: { center: '{title}' } });
    const drawnOn = (index: number): string =>
      (result.pages[index]?.ops ?? [])
        .flatMap((op) => op.args)
        .filter((arg) => arg.k === 'text')
        .map((arg) => arg.v)
        .join(' ');
    expect(drawnOn(0)).not.toContain('Report');
    expect(drawnOn(1)).toContain('Report');
  });

  it('draws the header on page one when `headerOnFirstPage` is set', () => {
    const doc = resolvedDocument([paragraph('body')]);
    const result = renderDoc(doc, {
      header: { center: '{title} — {page}/{pages}' },
      headerOnFirstPage: true,
    });
    const drawn = (result.pages[0]?.ops ?? [])
      .flatMap((op) => op.args)
      .filter((arg) => arg.k === 'text')
      .map((arg) => arg.v)
      .join(' ');
    expect(drawn).toContain('Report');
    expect(drawn).toContain('1/1');
  });
});

describe('figures keep their caption on one page end to end', () => {
  it('places Figure and Caption on the same rendered page', () => {
    const block = mdvBlock('bar', { title: 'Revenue', height: 200 });
    const fig = directive('mdv-figure', { caption: 'Revenue by region.' }, [block]);
    const doc = resolvedDocument(
      [...Array.from({ length: 18 }, (_, i) => paragraph(filler(i))), fig],
      { blocks: [resolvedBlock(block, 0, { title: 'Revenue', height: 200 })] },
    );
    const result = renderDoc(doc);
    const pageOf = (tag: string): number =>
      result.pages.findIndex((page) =>
        page.mcidOwners.some((owner) => owner.type === tag),
      );
    expect(pageOf('Figure')).toBeGreaterThanOrEqual(0);
    expect(pageOf('Caption')).toBe(pageOf('Figure'));
  });
});

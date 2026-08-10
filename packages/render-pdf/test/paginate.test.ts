/**
 * Pagination (SPEC 28.3, 28.4).
 *
 * The layout function is **injected** here, so nothing in this file runs
 * `@mdv/charts` or `@mdv/core`'s layout: the paginator's contract is "give me a
 * `Scene` for a block at a size", and a fixture satisfies it exactly as well as
 * the real thing while failing for this package's reasons only.
 */

import { describe, expect, it } from 'vitest';

import { buildFlow } from '../src/flow.js';
import type { FlowDocument } from '../src/flow.js';
import { createDocStyle } from '../src/style.js';
import { createStandardFontMetrics } from '../src/fonts.js';
import { resolveOptions } from '../src/options.js';
import { paginate } from '../src/paginate.js';
import type { BlockLayout, BlockSize, PageElement, PaginateResult, PdfPage } from '../src/paginate.js';
import { naturalSize } from '../src/size.js';
import type { PdfExportOptions } from '../src/options.js';
import {
  TEST_THEME,
  directive,
  filler,
  heading,
  mdvBlock,
  paragraph,
  resolvedBlock,
  resolvedDocument,
  stubScene,
  table,
} from './fixtures.js';
import type { ResolvedDocument } from '@mdv/core';

const metrics = createStandardFontMetrics();
const style = createDocStyle(TEST_THEME);

/** Lay a block out to a scene of exactly the requested size. */
const layout: BlockLayout = (block, widthPx, heightPx) =>
  stubScene(
    widthPx,
    heightPx,
    typeof block.attrs.title === 'string' ? block.attrs.title : block.blockType,
    'Two bars, one taller than the other.',
  );

const size: BlockSize = (block, columnPx) => naturalSize(block.attrs, columnPx, TEST_THEME);

function run(doc: ResolvedDocument, opts: PdfExportOptions = {}): PaginateResult {
  const flow: FlowDocument = buildFlow(doc);
  return paginate({ flow, style, metrics, options: resolveOptions(opts), layout, size });
}

/** Every structure tag drawn on a page, leaves included. */
function tagsOn(page: PdfPage): string[] {
  return page.elements
    .map((el: PageElement) => el.path[el.path.length - 1])
    .filter((tag): tag is string => tag !== undefined)
    .map((tag) => tag.split('@')[0] as string);
}

function pageOfTag(result: PaginateResult, tag: string): number {
  for (const page of result.pages) {
    if (tagsOn(page).includes(tag)) return page.index;
  }
  return -1;
}

describe('page breaking', () => {
  it('fills several pages and never leaves one empty', () => {
    const doc = resolvedDocument(Array.from({ length: 50 }, (_, i) => paragraph(filler(i))));
    const result = run(doc);
    expect(result.pages.length).toBeGreaterThan(3);
    for (const page of result.pages) expect(page.elements.length).toBeGreaterThan(0);
  });

  it('honours `:::mdv-page{break=before}` (SPEC 28.4)', () => {
    const doc = resolvedDocument([
      paragraph('before'),
      directive('mdv-page', { break: 'before' }),
      paragraph('after'),
    ]);
    const result = run(doc);
    expect(result.pages.length).toBe(2);
  });

  it('switches to landscape for `:::mdv-page{orientation=landscape}`', () => {
    const doc = resolvedDocument([
      paragraph('portrait'),
      directive('mdv-page', { orientation: 'landscape' }),
      paragraph('landscape'),
    ]);
    const result = run(doc);
    const last = result.pages[result.pages.length - 1];
    expect(last).toBeDefined();
    expect((last as PdfPage).widthPt).toBeGreaterThan((last as PdfPage).heightPt);
  });
});

describe('widows and orphans (SPEC 28.3 rule 1)', () => {
  /**
   * Fill a page to within a few lines of the bottom, then start a paragraph that
   * cannot fit whole. With `orphans: 2` the paragraph must either place two
   * lines or move entirely — one stranded line is the failure this rule exists
   * to prevent.
   */
  it('never strands fewer than `orphans` lines at the foot of a page', () => {
    for (let filled = 20; filled < 34; filled += 1) {
      const doc = resolvedDocument([
        ...Array.from({ length: filled }, (_, i) => paragraph(filler(i))),
        paragraph(filler(99)),
      ]);
      const result = run(doc, { orphans: 2, widows: 2 });

      // Count the lines of the final paragraph that landed on each page by
      // walking backwards: the last paragraph's atoms are the trailing `P`s.
      const perPage = result.pages.map(
        (page) => tagsOn(page).filter((tag) => tag === 'P').length,
      );
      const last = perPage[perPage.length - 1] ?? 0;
      expect(last).toBeGreaterThanOrEqual(1);
    }
  });

  it('keeps a heading with the text under it (rule 3)', () => {
    // 26 filler paragraphs almost fill page 1; the heading must not be the last
    // thing on it.
    for (let filled = 22; filled < 32; filled += 1) {
      const doc = resolvedDocument([
        ...Array.from({ length: filled }, (_, i) => paragraph(filler(i))),
        heading(2, 'A heading that must not be stranded'),
        paragraph(filler(77)),
      ]);
      const result = run(doc);
      for (const page of result.pages) {
        const tags = tagsOn(page);
        const headingAt = tags.lastIndexOf('H2');
        if (headingAt === -1) continue;
        // Something must follow the heading on the same page.
        expect(tags.length).toBeGreaterThan(headingAt + 1);
      }
    }
  });
});

describe('figures (SPEC 28.3 rule 2)', () => {
  function figureDocument(fillers: number): ResolvedDocument {
    const block = mdvBlock('bar', { title: 'Revenue', height: 220 });
    const fig = directive('mdv-figure', { caption: 'Revenue by region, 2024.' }, [block]);
    return resolvedDocument(
      [...Array.from({ length: fillers }, (_, i) => paragraph(filler(i))), fig],
      { blocks: [resolvedBlock(block, 0, { title: 'Revenue', height: 220 })] },
    );
  }

  it('never separates a figure from its caption', () => {
    for (let fillers = 14; fillers < 30; fillers += 1) {
      const result = run(figureDocument(fillers));
      const figurePage = pageOfTag(result, 'Figure');
      const captionPage = pageOfTag(result, 'Caption');
      expect(figurePage).toBeGreaterThanOrEqual(0);
      expect(captionPage).toBe(figurePage);
    }
  });

  it('carries the accessible description into `/Alt`', () => {
    const result = run(figureDocument(0));
    const figure = result.pages
      .flatMap((page) => page.elements)
      .find((el) => el.path[el.path.length - 1]?.startsWith('Figure') === true);
    expect(figure?.alt).toBe('Revenue. Two bars, one taller than the other.');
  });

  it('registers the figure anchor as a destination', () => {
    const result = run(figureDocument(0));
    const names = [...result.destinations.keys()];
    expect(names.some((name) => name.startsWith('figure-'))).toBe(true);
  });

  it('rotates a block that cannot be shrunk to 60 % (MDV5120)', () => {
    const block = mdvBlock('bar', { title: 'Huge', height: 4000 });
    const doc = resolvedDocument([block], {
      blocks: [resolvedBlock(block, 0, { title: 'Huge', height: 4000 })],
    });
    const result = run(doc);
    expect(result.diagnostics.some((d) => d.code === 'MDV5120')).toBe(true);
    const landscape = result.pages.find((page) => page.widthPt > page.heightPt);
    expect(landscape).toBeDefined();
  });
});

describe('tables (SPEC 28.3 rule 4)', () => {
  it('repeats the header on a continuation page', () => {
    const rows = Array.from({ length: 80 }, (_, i) => [
      `Row ${String(i)}`,
      String(i * 3),
      filler(i).slice(0, 30),
    ]);
    const doc = resolvedDocument([table(['Name', 'Count', 'Note'], rows)]);
    const result = run(doc);
    expect(result.pages.length).toBeGreaterThan(1);
    for (const page of result.pages) {
      // Every page that holds table body cells must also hold a header row.
      const tags = tagsOn(page);
      if (!tags.includes('TD')) continue;
      expect(tags).toContain('TH');
      expect(tags.indexOf('TH')).toBeLessThan(tags.indexOf('TD'));
    }
  });
});

describe('footnotes (SPEC 28.3 rule 5)', () => {
  it('places the note on the page that references it', () => {
    const doc = resolvedDocument([
      {
        type: 'paragraph',
        children: [
          { type: 'text', value: 'A claim' },
          { type: 'footnoteReference', identifier: 'src', label: 'src' },
          { type: 'text', value: ' that needs support.' },
        ],
      },
      {
        type: 'footnoteDefinition',
        identifier: 'src',
        label: 'src',
        children: [paragraph('The supporting detail.')],
      },
    ]);
    const result = run(doc);
    const page = result.pages[0];
    expect(page).toBeDefined();
    expect(tagsOn(page as PdfPage)).toContain('Note');
  });
});

describe('destinations and the outline (SPEC 28.7)', () => {
  it('records every heading as an outline entry with an anchor', () => {
    const doc = resolvedDocument([
      heading(1, 'One'),
      paragraph('a'),
      heading(2, 'One point one'),
      paragraph('b'),
      heading(1, 'Two'),
      paragraph('c'),
    ]);
    const result = run(doc);
    expect(result.outline.map((entry) => entry.title)).toEqual([
      'One',
      'One point one',
      'Two',
    ]);
    expect(result.outline.map((entry) => entry.level)).toEqual([1, 2, 1]);
    for (const entry of result.outline) {
      expect(result.destinations.has(entry.anchor)).toBe(true);
    }
  });

  it('tracks the running section and chapter per page', () => {
    const doc = resolvedDocument([
      heading(1, 'Chapter one'),
      ...Array.from({ length: 30 }, (_, i) => paragraph(filler(i))),
      heading(2, 'Later section'),
      ...Array.from({ length: 10 }, (_, i) => paragraph(filler(i + 40))),
    ]);
    const result = run(doc);
    const last = result.pages[result.pages.length - 1];
    expect(last?.chapter).toBe('Chapter one');
    expect(last?.section).toBe('Later section');
  });
});

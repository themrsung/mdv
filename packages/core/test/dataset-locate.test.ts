/**
 * The dataset locator (SPEC 6.3, 6.7).
 *
 * The locator's whole claim is that it routes exactly the way `resolve.ts`
 * routes: a site it lists is one the resolver reads, and a key it skips is one
 * the resolver ignores. So these cases are written as pairs — the live key and
 * the dead one beside it — because a locator that finds one id too many sends
 * an editor to a definition the renderer never followed.
 */

import { parse, type MdvDocument } from '@mdv/parser';
import { describe, expect, it } from 'vitest';
import { locateDatasets, type DatasetSite } from '../src/dataset/locate.js';

const SOURCE = [
  '---',
  'mdv: "1.0"',
  'datasets:',
  '  sales:',
  '    src: sales.csv',
  '  q1: "@sales[date, revenue]"',
  '  joined:',
  '    from: "@sales"',
  '    transform:',
  '      - join:',
  '          with: "@costs"',
  '          on: date',
  '---',
  '',
  '# Report',
  '',
  '```mdv dataset',
  'id: costs',
  '---',
  'date,cost',
  '2026-01-01,1',
  '```',
  '',
  '```mdv line',
  'data: "@q1"',
  'from: "@sales"',
  'x: date',
  '```',
  '',
  '```mdv bar',
  'from: "@joined"',
  'transform:',
  '  - join:',
  '      with: "@costs"',
  '      on: date',
  '```',
  '',
].join('\n');

/** Every site, as `kind path → id`, which is the whole of what a caller reads. */
function summary(source: string): string[] {
  return locateDatasets(parse(source)).map((site) => `${site.kind} ${site.path} → ${site.id}`);
}

/** The one site at `path`, or a failure that names what was found instead. */
function siteAt(doc: MdvDocument, path: string): DatasetSite {
  const found = locateDatasets(doc).filter((site) => site.path === path);
  if (found.length !== 1) {
    throw new Error(`expected one site at ${path}, got ${found.length}`);
  }
  return found[0] as DatasetSite;
}

describe('locateDatasets (SPEC 6.3)', () => {
  it('lists every id a document writes, in source order', () => {
    expect(summary(SOURCE)).toEqual([
      'declaration datasets.sales → sales',
      'declaration datasets.q1 → q1',
      'reference datasets.q1 → sales',
      'declaration datasets.joined → joined',
      'reference datasets.joined.from → sales',
      'reference datasets.joined.transform[0].join.with → costs',
      'declaration id → costs',
      'reference data → q1',
      'reference from → joined',
      'reference transform[0].join.with → costs',
    ]);
  });

  it('ranges a reference as it was written, quotes and all', () => {
    const site = siteAt(parse(SOURCE), 'datasets.joined.from');
    const written = SOURCE.slice(site.range.start.offset, site.range.end.offset);
    expect(written).toBe('"@sales"');
    // The quotes are why `text` and `offset` exist: a caller that wants to
    // underline the id alone cannot get there from the range by itself.
    expect(site.text.slice(site.offset, site.offset + site.id.length)).toBe('sales');
  });

  it('reads a front-matter alias as a declaration and a reference at once', () => {
    const sites = locateDatasets(parse(SOURCE)).filter((site) => site.path === 'datasets.q1');
    expect(sites.map((site) => site.kind)).toEqual(['declaration', 'reference']);
    // One line, two ids, two ranges: `q1` is worn by the key and `sales` by the
    // value, so a rename of either touches only the half that spells it.
    const written = (site: DatasetSite | undefined): string =>
      site === undefined ? '' : SOURCE.slice(site.range.start.offset, site.range.end.offset);
    expect(written(sites[0])).toBe('q1');
    expect(written(sites[1])).toBe('"@sales[date, revenue]"');
    expect(sites[0]).toMatchObject({ id: 'q1', text: 'q1', offset: 0 });
  });

  it('writes a declaration ahead of the references hanging off it', () => {
    const doc = parse(SOURCE);
    const outer = siteAt(doc, 'datasets.joined');
    const inner = siteAt(doc, 'datasets.joined.transform[0].join.with');
    // The ordering contract for hit-testing: a declaration is listed before
    // everything written under it. It does not swallow them — the declaration
    // is the key, not the pipeline it introduces — so a cursor anywhere in the
    // front matter is inside at most one site.
    expect(outer.range.start.offset).toBeLessThan(inner.range.start.offset);
    expect(outer.range.end.offset).toBeLessThanOrEqual(inner.range.start.offset);
  });

  it('names a dataset block by its id, which wears no `@`', () => {
    const site = siteAt(parse(SOURCE), 'id');
    expect(site).toMatchObject({ id: 'costs', kind: 'declaration', text: 'costs', offset: 0 });
  });

  it('ignores the `from:` beside a `data:` reference', () => {
    // The block in the fixture writes both; `blockRequest` stops at `data:`,
    // so `from:` is inert and pointing at it would be a lie.
    expect(summary(SOURCE)).not.toContain('reference from → sales');
  });

  it('reads `from:` on a block whose data is not a reference', () => {
    const source = ['```mdv line', 'from: "@sales"', 'data: rows.csv', '```', ''].join('\n');
    expect(summary(source)).toEqual(['reference from → sales']);
  });

  it('reads a lone transform step written unwrapped', () => {
    // `readPipeline` accepts a bare mapping, and the parser paths it bare too.
    const source = ['```mdv line', 'transform:', '  join:', '    with: "@costs"', '```', ''].join(
      '\n',
    );
    expect(summary(source)).toEqual(['reference transform.join.with → costs']);
  });

  it('says nothing about a value that is not a reference', () => {
    const source = [
      '---',
      'datasets:',
      '  sales:',
      '    src: sales.csv',
      '---',
      '',
      '```mdv line',
      'data: sales.csv',
      'x: date',
      'transform:',
      '  - sort: date',
      '```',
      '',
    ].join('\n');
    expect(summary(source)).toEqual(['declaration datasets.sales → sales']);
  });

  it('finds a block that is not a child of the root', () => {
    const source = ['> ```mdv line', '> data: "@sales"', '> ```', ''].join('\n');
    expect(summary(source)).toEqual(['reference data → sales']);
  });

  it('holds nothing for a document that declares nothing', () => {
    expect(locateDatasets(parse('# Just prose\n'))).toEqual([]);
  });
});

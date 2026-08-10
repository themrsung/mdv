/**
 * The stage memos (SPEC 24.2, 22.3).
 *
 * > **Resize:** … re-running stages **6–7 only**.
 *
 * The counters on `Caches.stats` exist so that claim can be *checked* rather
 * than asserted. Two things are proved here:
 *
 * 1. A resize re-lays-out and does nothing above that — no parse, no resolve.
 * 2. Editing one block's title re-parses the document once (the source changed,
 *    so it must) and re-lays-out **only the block that changed**; its sibling
 *    gets its previous scene back by identity.
 *
 * Both are driven through the real components, at two widths, with a cache set
 * the test owns — which is also the shape a server reusing memos across requests
 * would use.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '@mdv/parser';
import { createChartRegistry } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import { createTableMetrics } from '@mdv/core/metrics/index.js';
import { getBuiltinTheme } from '@mdv/themes';
import {
  MdvDocument,
  MdvProvider,
  blockKey,
  composeSync,
  contentHash,
  createCaches,
  layoutCached,
  parseCached,
  resolveCachedSync,
  tableKey,
  type LayoutSettings,
} from '../src/index.js';
import { Lru } from '../src/internal/lru.js';
import { GOOD, TWO_BLOCKS, TWO_BLOCKS_EDITED } from './fixtures.js';

const SETTINGS: LayoutSettings = {
  theme: getBuiltinTheme('default'),
  metrics: createTableMetrics(),
  locale: 'en-US',
  timezone: 'UTC',
  level: 2,
  buildTime: new Date(0),
  colorScheme: 'light',
  a11y: { texture: false, tableView: 'details', generateDesc: true },
  animate: true,
};

describe('a resize re-runs stages 6–7 only', () => {
  it('does not re-parse or re-resolve when the width changes', () => {
    const caches = createCaches();
    const at = (width: number): string =>
      renderToStaticMarkup(
        <MdvProvider renderPolicy="eager" unstyled caches={caches} width={width}>
          <MdvDocument source={GOOD} />
        </MdvProvider>,
      );

    at(800);
    expect(caches.stats.parses).toBe(1);
    expect(caches.stats.resolves).toBe(1);
    const layoutsAfterFirst = caches.stats.layouts;
    expect(layoutsAfterFirst).toBe(1);

    // Five widths, i.e. five frames of a window drag.
    for (const width of [640, 720, 900, 1024, 1200]) at(width);

    expect(caches.stats.parses).toBe(1);
    expect(caches.stats.resolves).toBe(1);
    expect(caches.stats.layouts).toBe(layoutsAfterFirst + 5);
  });

  it('does not re-hash the table on every resize', () => {
    // Hashing ten thousand rows per animation frame would cost more than the
    // layout the memo is there to skip.
    const caches = createCaches();
    const at = (width: number): string =>
      renderToStaticMarkup(
        <MdvProvider renderPolicy="eager" unstyled caches={caches} width={width}>
          <MdvDocument source={GOOD} />
        </MdvProvider>,
      );

    at(800);
    const hashes = caches.stats.tableHashes;
    at(640);
    at(900);
    expect(caches.stats.tableHashes).toBe(hashes);
  });

  it('returns the identical scene for a width it has already seen', () => {
    const caches = createCaches();
    const doc = composeSync(parse(GOOD));
    const block = doc.blocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;
    const registry = createChartRegistry(builtinChartTypes);

    const first = layoutCached(caches, block, { width: 800, height: 300 }, SETTINGS, registry);
    const wider = layoutCached(caches, block, { width: 900, height: 300 }, SETTINGS, registry);
    const again = layoutCached(caches, block, { width: 800, height: 300 }, SETTINGS, registry);

    expect(first.computed).toBe(true);
    expect(wider.computed).toBe(true);
    expect(again.computed).toBe(false);
    // Identity, so the SVG subtree reconciles to nothing (SPEC 22.2).
    expect(again.scene).toBe(first.scene);
    expect(wider.scene).not.toBe(first.scene);
  });

  it('replays the memoised diagnostics rather than re-announcing them', () => {
    const caches = createCaches();
    const doc = composeSync(parse(GOOD));
    const block = doc.blocks[0];
    if (block === undefined) return;
    const registry = createChartRegistry(builtinChartTypes);
    const size = { width: 800, height: 300 };

    const first = layoutCached(caches, block, size, SETTINGS, registry);
    const second = layoutCached(caches, block, size, SETTINGS, registry);
    expect(second.diagnostics).toBe(first.diagnostics);
  });
});

describe('editing one block', () => {
  it('re-parses once and re-lays-out only the block that changed', () => {
    const caches = createCaches();
    const registry = createChartRegistry(builtinChartTypes);
    const size = { width: 800, height: 300 };

    const before = resolveCachedSync(
      caches,
      parseCached(caches, TWO_BLOCKS),
      {},
      contentHash(TWO_BLOCKS),
    );
    const firstBefore = before.blocks[0];
    const secondBefore = before.blocks[1];
    expect(firstBefore).toBeDefined();
    expect(secondBefore).toBeDefined();
    if (firstBefore === undefined || secondBefore === undefined) return;

    const sceneOne = layoutCached(caches, firstBefore, size, SETTINGS, registry);
    const sceneTwo = layoutCached(caches, secondBefore, size, SETTINGS, registry);
    expect(caches.stats.parses).toBe(1);
    expect(caches.stats.layouts).toBe(2);

    // The edit. A different source, so of course it re-parses and re-resolves.
    const after = resolveCachedSync(
      caches,
      parseCached(caches, TWO_BLOCKS_EDITED),
      {},
      contentHash(TWO_BLOCKS_EDITED),
    );
    expect(caches.stats.parses).toBe(2);
    expect(caches.stats.resolves).toBe(2);

    const firstAfter = after.blocks[0];
    const secondAfter = after.blocks[1];
    if (firstAfter === undefined || secondAfter === undefined) return;

    // Different `ResolvedBlock` objects — resolve rebuilt them both.
    expect(firstAfter).not.toBe(firstBefore);
    expect(secondAfter).not.toBe(secondBefore);

    const redrawnOne = layoutCached(caches, firstAfter, size, SETTINGS, registry);
    const redrawnTwo = layoutCached(caches, secondAfter, size, SETTINGS, registry);

    // The edited block was laid out again; the untouched one was not.
    expect(redrawnOne.computed).toBe(true);
    expect(redrawnOne.scene).not.toBe(sceneOne.scene);
    expect(redrawnTwo.computed).toBe(false);
    expect(redrawnTwo.scene).toBe(sceneTwo.scene);
    expect(caches.stats.layouts).toBe(3);
  });

  it('keys a block on its content, not on its position in the file', () => {
    // The same block, moved down the document by an edit above it, must keep its
    // key: its `position` changed and its content did not.
    const caches = createCaches();
    const a = composeSync(parse(TWO_BLOCKS));
    const b = composeSync(parse(`# A new heading\n\n${TWO_BLOCKS}`));
    const first = a.blocks[1];
    const second = b.blocks[1];
    if (first === undefined || second === undefined) return;
    expect(blockKey(caches, first)).toBe(blockKey(caches, second));
  });

  it('gives two different tables two different keys', () => {
    const caches = createCaches();
    const doc = composeSync(parse(TWO_BLOCKS));
    const [one, two] = doc.blocks;
    if (one === undefined || two === undefined) return;
    expect(tableKey(caches, one.table)).not.toBe(tableKey(caches, two.table));
    // And the same table object hashes once.
    const hashes = caches.stats.tableHashes;
    tableKey(caches, one.table);
    expect(caches.stats.tableHashes).toBe(hashes);
  });
});

describe('the memo keys', () => {
  it('separate two themes', () => {
    const caches = createCaches();
    const doc = composeSync(parse(GOOD));
    const block = doc.blocks[0];
    if (block === undefined) return;
    const registry = createChartRegistry(builtinChartTypes);
    const size = { width: 800, height: 300 };

    layoutCached(caches, block, size, SETTINGS, registry);
    const dark = layoutCached(
      caches,
      block,
      size,
      { ...SETTINGS, theme: getBuiltinTheme('dark'), colorScheme: 'dark' },
      registry,
    );
    expect(dark.computed).toBe(true);
  });

  it('separate two locales', () => {
    const caches = createCaches();
    const doc = composeSync(parse(GOOD));
    const block = doc.blocks[0];
    if (block === undefined) return;
    const registry = createChartRegistry(builtinChartTypes);
    const size = { width: 800, height: 300 };

    layoutCached(caches, block, size, SETTINGS, registry);
    expect(
      layoutCached(caches, block, size, { ...SETTINGS, locale: 'de-DE' }, registry).computed,
    ).toBe(true);
  });
});

describe('Lru', () => {
  it('evicts the least recently used entry', () => {
    const lru = new Lru<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.get('a');
    lru.set('c', 3);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(false);
    expect(lru.has('c')).toBe(true);
    expect(lru.size).toBe(2);
  });

  it('computes at most once per key', () => {
    const lru = new Lru<number>(4);
    let calls = 0;
    const compute = (): number => {
      calls += 1;
      return 7;
    };
    expect(lru.getOrCompute('k', compute)).toBe(7);
    expect(lru.getOrCompute('k', compute)).toBe(7);
    expect(calls).toBe(1);
  });

  it('holds at least one entry however small it is told to be', () => {
    const lru = new Lru<number>(0);
    lru.set('a', 1);
    expect(lru.get('a')).toBe(1);
  });
});

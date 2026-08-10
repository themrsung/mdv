/**
 * Keyboard focus order (SPEC 12.4).
 *
 * > - The chart container is **one tab stop** (`tabindex="0"`).
 * > - Arrow keys move between marks … `Esc` exits to the container.
 * > - `T` toggles the table view when it is collapsed.
 *
 * Two orders have to be right and they are different things:
 *
 * 1. The **tab order** through the rendered document: chart, then table-view
 *    summary, then the next block. One tab stop per chart, not one per mark —
 *    forty bars must not become forty tab stops.
 * 2. The **traversal order** inside a chart: `Scene.a11y.focusOrder`, which the
 *    interaction layer walks with the arrow keys. Every id in it must name a hit
 *    region that actually exists in the markup, or an arrow press lands nowhere.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { parse } from '@mdv/parser';
import { createChartRegistry } from '@mdv/core';
import { layoutBlock, makeLayoutContext } from '@mdv/core/layout/index.js';
import { createTableMetrics } from '@mdv/core/metrics/index.js';
import { builtinChartTypes } from '@mdv/charts';
import { MdvDocument, MdvProvider, composeSync } from '../src/index.js';
import { GOOD, TWO_BLOCKS, indexOfTag, tags } from './fixtures.js';

function render(source: string): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={source} />
    </MdvProvider>,
  );
}

describe('tab order', () => {
  it('gives each chart exactly one tab stop', () => {
    const html = render(TWO_BLOCKS);
    const stops = html.match(/tabindex="0"/g) ?? [];
    expect(stops).toHaveLength(2);
  });

  it('puts the tab stop on the chart, not on a mark', () => {
    const html = render(GOOD);
    const line = tags(html).find((t) => t.includes('tabindex="0"'));
    expect(line).toBeDefined();
    expect(line).toMatch(/^<svg /);
    expect(line).toContain('role="img"');
  });

  it('orders the chart before its table view', () => {
    const html = render(GOOD);
    const chart = indexOfTag(html, /^<svg /);
    const summary = indexOfTag(html, /^<summary/);
    expect(chart).toBeGreaterThanOrEqual(0);
    expect(summary).toBeGreaterThan(chart);
  });

  it('orders block one entirely before block two', () => {
    const html = render(TWO_BLOCKS);
    const lines = tags(html);
    const firstBlockEnd = lines.findIndex((t) => t.includes('data-mdv-block-id="mdv-1"'));
    const summaries = lines
      .map((t, i) => (t.startsWith('<summary') ? i : -1))
      .filter((i) => i >= 0);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toBeLessThan(firstBlockEnd);
    expect(summaries[1]).toBeGreaterThan(firstBlockEnd);
  });

  it('adds no tab stop to a placeholder or an error card', () => {
    // Nothing but the chart and the summary is focusable; a `div` wrapper that
    // picked up a `tabindex` would double every block's tab stops.
    const html = render(GOOD);
    expect(html.match(/tabindex=/g) ?? []).toHaveLength(1);
  });
});

describe('traversal order inside a chart', () => {
  const doc = composeSync(parse(GOOD));
  const block = doc.blocks[0];

  it('has a focus order', () => {
    expect(block).toBeDefined();
    if (block === undefined) return;
    const scene = layoutBlock(
      block,
      { width: 800, height: 300 },
      makeLayoutContext({ theme: block.theme, blockIndex: 0, metrics: createTableMetrics() }),
      createChartRegistry(builtinChartTypes),
    );
    expect(scene.a11y.focusOrder.length).toBe(4);
  });

  it('names hit regions that exist in the rendered markup', () => {
    expect(block).toBeDefined();
    if (block === undefined) return;
    const scene = layoutBlock(
      block,
      { width: 800, height: 300 },
      makeLayoutContext({ theme: block.theme, blockIndex: 0, metrics: createTableMetrics() }),
      createChartRegistry(builtinChartTypes),
    );

    const html = render(GOOD);
    for (const id of scene.a11y.focusOrder) {
      expect(html, `focus order names ${id}, which is not in the markup`).toContain(
        `data-mdv-region="${id}"`,
      );
    }
  });

  it('is in document order, so arrow keys read left to right', () => {
    expect(block).toBeDefined();
    if (block === undefined) return;
    const scene = layoutBlock(
      block,
      { width: 800, height: 300 },
      makeLayoutContext({ theme: block.theme, blockIndex: 0, metrics: createTableMetrics() }),
      createChartRegistry(builtinChartTypes),
    );

    const html = render(GOOD);
    const positions = scene.a11y.focusOrder.map((id) => html.indexOf(`data-mdv-region="${id}"`));
    for (const position of positions) expect(position).toBeGreaterThan(0);
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions).toEqual(sorted);
  });
});

describe('the live region and the readout', () => {
  it('are not in the server markup — they are attached at hydration', () => {
    // SPEC 22.3: "Hydration attaches interaction only". A tooltip in the SSR
    // output would be a mismatch the moment the interaction layer added its own.
    const html = render(GOOD);
    expect(html).not.toContain('mdv-tooltip');
    expect(html).not.toContain('mdv-live');
    // The hit overlay, by contrast, is part of the scene and must be present in
    // both, or hydration would rewrite the whole subtree.
    expect(html).toContain('data-mdv-region=');
  });
});

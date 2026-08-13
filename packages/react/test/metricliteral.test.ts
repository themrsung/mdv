/**
 * A stat tile whose number is written in the block, not read from a table.
 *
 * ```mdv
 * mdv metric
 * label: Monthly recurring revenue
 * value: 1284000
 * format: "$~s"
 * ```
 *
 * That is the form SPEC 8.13 documents first and the one the editor's slash
 * menu inserts, so it is the one an author meets before any other. It has no
 * data section at all: `value` is a literal, and `metric` reads it off `attrs`
 * (`resolveValue` in `@mdv/charts`), because as a *channel* the same key is
 * `{value: 1284000}` — a constant that binds no field, which is not a binding.
 *
 * The React binding used to **move** channel-named keys off `attrs` when it
 * split the cascaded map, while `@mdv/core` **copies** them. So this document
 * resolved one way through `@mdv/react` and another through the core pipeline,
 * and the tile came back as an error card reading "`value` is required by
 * `metric` and is not bound" (MDV3000) for a block that binds it perfectly
 * well. The split lifts, it does not move; these tests hold the two paths
 * together.
 */

import { describe, expect, it } from 'vitest';
import { parse } from '@mdv/parser';
import { createChartRegistry, type Diagnostic, type ResolvedBlock, type Scene } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import { layoutBlock, makeLayoutContext } from '@mdv/core/layout/index.js';
import { createTableMetrics } from '@mdv/core/metrics/index.js';
import { composeSync } from '../src/index.js';

const LITERAL = [
  '```mdv metric',
  'label: Monthly recurring revenue',
  'value: 1284000',
  'format: "$~s"',
  '```',
  '',
].join('\n');

/** Lay a block out, keeping whatever the render stage reported. */
function render(block: ResolvedBlock): { scene: Scene; codes: readonly string[] } {
  const diagnostics: Diagnostic[] = [];
  const scene = layoutBlock(
    block,
    { width: 400, height: 200 },
    makeLayoutContext({
      theme: block.theme,
      blockIndex: 0,
      metrics: createTableMetrics(),
      onDiagnostic: (d) => diagnostics.push(d),
    }),
    createChartRegistry(builtinChartTypes),
  );
  return { scene, codes: diagnostics.map((d) => d.code) };
}

describe('a metric block with a literal value (SPEC 8.13)', () => {
  const doc = composeSync(parse(LITERAL));
  const block = doc.blocks[0];

  it('resolves to one metric block', () => {
    expect(doc.blocks).toHaveLength(1);
    expect(block?.blockType).toBe('metric');
  });

  it('keeps the literal on `attrs`, which is where the chart type reads it', () => {
    expect(block?.attrs['value']).toBe(1284000);
    expect(block?.attrs['label']).toBe('Monthly recurring revenue');
  });

  it('lays out without MDV3000 — the value is bound', () => {
    expect(block).toBeDefined();
    if (block === undefined) return;

    expect(render(block).codes).not.toContain('MDV3000');
  });

  it('paints the formatted number rather than the em dash', () => {
    expect(block).toBeDefined();
    if (block === undefined) return;

    const text = JSON.stringify(render(block).scene);
    expect(text).toContain('$1.28M');
    expect(text).not.toContain('—');
  });
});

/**
 * The conformance level a construct requires (SPEC 16.1).
 *
 * `MdvBlock.level` and the directive machinery both need this. It lives in the
 * parser rather than in `@mdv/core` because the parser is what stamps the level
 * onto the node, and it is pure data with no dependency on the type registry:
 * an unknown type is Level 1 so that it degrades to a table (SPEC 15.2) instead
 * of being suppressed by a level filter.
 */

import type { ConformanceLevel } from '@mdv/spec';

/** Level 1 block types (SPEC 16.1), plus the non-chart types usable at Level 1. */
const LEVEL_1: ReadonlySet<string> = new Set([
  'bar',
  'line',
  'area',
  'pie',
  'donut',
  'scatter',
  'table',
  'metric',
  // Reserved non-chart types (SPEC 5.2). `dataset`, `config` and `raw` are
  // Level 1 machinery; `theme` and `include` are not (see below).
  'dataset',
  'config',
  'raw',
]);

/** Level 2 block types (SPEC 16.1). Custom themes are also Level 2. */
const LEVEL_2: ReadonlySet<string> = new Set([
  'histogram',
  'box',
  'heatmap',
  'ohlc',
  'ohlcv',
  'candlestick',
  'radar',
  'gauge',
  'funnel',
  'waterfall',
  'treemap',
  'sankey',
  'sparkline',
  'theme',
]);

/** Level 3 block types (SPEC 16.1). */
const LEVEL_3: ReadonlySet<string> = new Set(['map', 'network', 'gantt', 'math', 'include']);

/**
 * The level a block type belongs to.
 *
 * Unknown types report Level 1: SPEC 15.2 requires them to render as a table
 * with a notice in *every* reader, so gating them behind a higher level would
 * make a conforming Level 1 reader drop content it is obliged to show.
 */
export function levelOfBlockType(blockType: string): ConformanceLevel {
  if (LEVEL_3.has(blockType)) return 3;
  if (LEVEL_2.has(blockType)) return 2;
  if (LEVEL_1.has(blockType)) return 1;
  return 1;
}

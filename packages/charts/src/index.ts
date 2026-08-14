/**
 * `@mdv/charts` — per-type encoders and layout algorithms, registered into core.
 *
 * Every export here is a {@link ChartType} conforming to the contract documented
 * at the top of `@mdv/core/registry`. **Read that file first**: it states which
 * side owns the plot frame, the axes, the legend and the a11y tree, and which
 * side owns the marks.
 *
 * Tree-shakeable per type: import `barChart` alone and no other type's code is
 * pulled in. `builtinChartTypes` exists for the common case of "give me
 * everything at my conformance level".
 */

import type { ChartType, ConformanceLevel } from '@mdv/core';
import { areaChart } from './area.js';
import { barChart } from './bar.js';
import { boxChart } from './box.js';
import { bubbleChart, scatterChart } from './scatter.js';
import { funnelChart } from './funnel.js';
import { donutChart, pieChart } from './pie.js';
import { gaugeChart } from './gauge.js';
import { heatmapChart } from './heatmap.js';
import { histogramChart } from './histogram.js';
import { lineChart } from './line.js';
import { metricChart } from './metric.js';
import { ohlcChart, ohlcvChart } from './ohlc.js';
import { radarChart } from './radar.js';
import { sankeyChart } from './sankey.js';
import { sparklineChart } from './sparkline.js';
import { tableChart } from './table.js';
import { treemapChart } from './treemap.js';
import { unimplementedChartTypes } from './unimplemented.js';
import { waterfallChart } from './waterfall.js';

export { areaChart } from './area.js';
export { barChart } from './bar.js';
export { boxChart } from './box.js';
export { bubbleChart, scatterChart } from './scatter.js';
export { donutChart, pieChart } from './pie.js';
export { funnelChart } from './funnel.js';
export { gaugeChart } from './gauge.js';
export type { GaugeEncodeResult } from './gauge.js';
export { heatmapChart } from './heatmap.js';
export { histogramChart } from './histogram.js';
export { lineChart } from './line.js';
export { metricChart } from './metric.js';
export { ohlcChart, ohlcvChart } from './ohlc.js';
export { radarChart } from './radar.js';
export type { RadarEncodeResult } from './radar.js';
export { sankeyChart } from './sankey.js';
export type { SankeyEncodeResult } from './sankey.js';
export { sparklineChart } from './sparkline.js';
export type { SparklineEncodeResult } from './sparkline.js';
export { tableChart } from './table.js';
export { treemapChart } from './treemap.js';
export type { TreemapEncodeResult } from './treemap.js';
export {
  UNIMPLEMENTED_TYPES,
  createUnimplementedChartType,
  unimplementedChartTypes,
} from './unimplemented.js';
export { waterfallChart } from './waterfall.js';

export type { Annotation } from './internal/annotations.js';

/**
 * Sparkline geometry, shared with the renderers (SPEC 9.2).
 *
 * `:mdv-spark[1,4,2,8]` is a chart drawn inside a sentence: no axes, no legend,
 * no `chart` block, and — in the React renderer — no encode pass at all, since
 * the numbers are written in the directive rather than read from a dataset. It
 * still has to place its points exactly where the `sparkline` chart type places
 * them, or the inline strip and the block chart of the same data would disagree
 * about what "flat" looks like. Exporting the primitives is what makes that
 * agreement structural rather than a coincidence of two similar loops.
 */
export { parseSeries, sparkExtent, sparkPoints, sparkX, sparkY } from './internal/spark.js';
export type { SparkStrip } from './internal/spark.js';

/**
 * The deterministic formatter, shared with the renderers (SPEC 9.2, 24.3).
 *
 * `:mdv-metric[1284000]{format="$~s"}` and `:mdv-value[@sales.revenue.sum]` are
 * numbers printed in a sentence, and the sentence must agree with the tile
 * beside it down to the last digit — including which digit is last. That is a
 * property of *this* formatter and not of the platform's: SPEC 24.3 requires
 * byte-identical output for the same input, so the whole thing is hand-rolled
 * rather than delegated to `Intl`, whose rounding and grouping move with the ICU
 * version. A renderer that reached for `toLocaleString()` instead would produce
 * a document whose prose and charts disagree on some machines and not others.
 */
export {
  expandTemplate,
  formatDate,
  formatNumber,
  formatValue,
  humanise,
  keyValue,
  parseNumberFormat,
} from './internal/format.js';
export type { NumberFormatSpec } from './internal/format.js';

/**
 * The delta rules, shared with the renderers (SPEC 8.13, 9.2, 16.2).
 *
 * `:mdv-delta[-0.03]{goodDirection=down}` in a sentence and a `metric` tile with
 * the same `delta` are one claim written twice, and they have to spell the
 * number the same way and call the same direction good. Exporting the rules is
 * what makes the sentence and the tile beside it structurally unable to
 * disagree — see `internal/delta.ts` for why the tone stops short of the colour.
 */
export { GOOD_DIRECTIONS, defaultDeltaFormat, deltaTone } from './internal/delta.js';
export type { DeltaTone, GoodDirection } from './internal/delta.js';

/**
 * Level 1 types (SPEC 16.1): `bar`, `line`, `area`, `pie`, `donut`, `scatter`,
 * `table`, `metric`.
 *
 * `bubble` is not on this list because SPEC 8.6 makes it a variant of `scatter`
 * with a required `size` channel rather than a ninth type, but it is a separate
 * registration so that `bubble` in an info string resolves without an alias.
 */
export const LEVEL_1_TYPE_NAMES = [
  'area',
  'bar',
  'donut',
  'line',
  'metric',
  'pie',
  'scatter',
  'table',
] as const;

/**
 * Level 2 types (SPEC 16.1): `histogram`, `box`, `heatmap`, `ohlc`, `ohlcv`,
 * `candlestick`, `radar`, `gauge`, `funnel`, `waterfall`, `treemap`, `sankey`,
 * `sparkline`.
 *
 * All thirteen are **drawn** (see {@link level2ChartTypes}) — nothing at this
 * level degrades to a table with `MDV1500` any more. `candlestick` resolves
 * through `ohlc`'s alias, so there are twelve registrations for thirteen names.
 */
export const LEVEL_2_TYPE_NAMES = [
  'box',
  'candlestick',
  'funnel',
  'gauge',
  'heatmap',
  'histogram',
  'ohlc',
  'ohlcv',
  'radar',
  'sankey',
  'sparkline',
  'treemap',
  'waterfall',
] as const;

/** Level 3 types (SPEC 16.1): `map`, `network`, `gantt`. Also table-degrading. */
export const LEVEL_3_TYPE_NAMES = ['gantt', 'map', 'network'] as const;

/**
 * The eight Level 1 types plus `bubble`, sorted by name.
 *
 * Separate from {@link builtinChartTypes} so a Level 1 reader can register
 * exactly what it draws, and so tests can assert the implemented set without the
 * stubs.
 */
export const level1ChartTypes: readonly ChartType[] = [
  areaChart,
  barChart,
  bubbleChart,
  donutChart,
  lineChart,
  metricChart,
  pieChart,
  scatterChart,
  tableChart,
];

/**
 * The Level 2 types this reader actually draws, sorted by name.
 *
 * Every name in {@link LEVEL_2_TYPE_NAMES} is now here, `candlestick` by way of
 * `ohlc`'s alias. The list stays separate from {@link builtinChartTypes} anyway:
 * it is what a Level 2 claim means, and keeping it apart from the Level 3 stubs
 * keeps `chartTypesForLevel` honest — a type is in the list for its own level
 * whether it draws or degrades, and this is the set that draws.
 */
export const level2ChartTypes: readonly ChartType[] = [
  boxChart,
  funnelChart,
  gaugeChart,
  heatmapChart,
  histogramChart,
  ohlcChart,
  ohlcvChart,
  radarChart,
  sankeyChart,
  sparklineChart,
  treemapChart,
  waterfallChart,
];

/**
 * Every built-in chart type, sorted by name.
 *
 * Includes the Level 3 **stubs**, which is deliberate: registering a
 * type this reader cannot draw is what turns "unknown block type, hope core
 * copes" into a table with a diagnostic that names the type and the conformance
 * level the document needs (SPEC 15.2). Filter with {@link chartTypesForLevel}
 * if you want only the types that actually draw.
 *
 * Pass straight to `createChartRegistry` — a registry, not a module-level `Map`,
 * because SPEC 17.3 invariant 4 forbids global mutable state.
 *
 * @example
 * ```ts
 * import { createChartRegistry } from '@mdv/core';
 * import { builtinChartTypes } from '@mdv/charts';
 *
 * const registry = createChartRegistry(builtinChartTypes);
 * registry.freeze();
 * ```
 *
 * The shape of this declaration is load-bearing, and both halves of it were paid
 * for in bundle bytes. `Array.prototype.sort` mutates its receiver, so a bundler
 * cannot prove `[...].sort(...)` is pure; unannotated, this becomes a side effect
 * at module scope that can never be dropped, and because it names every type,
 * *importing `barChart` alone pulls all twenty in*. Hence the call and the
 * `@__PURE__`, which says "drop me if nobody reads me" — true here, since the
 * array never escapes.
 *
 * The annotation alone is not enough, which is the subtle half. `@__PURE__`
 * licenses dropping the *call*, but the argument is evaluated separately, and
 * `[...a, ...b]` is not droppable: spreading runs `a[Symbol.iterator]`, which any
 * object is free to define, so the array literal stays, the three lists it names
 * stay, and all twenty modules come with them — a barrel that tree-shakes to
 * 72 KB instead of 14 KB, with the annotation sitting right there looking
 * correct. Passing the lists as *arguments* and spreading inside the callee
 * leaves nothing but identifier references at module scope, and identifiers go
 * away with the statement that reads them.
 *
 * `packages/charts/test/index.test.ts` asserts the order this produces, and the
 * `bundle/level-1` row of `pnpm perf` fails loudly if either half stops working.
 */
export const builtinChartTypes: readonly ChartType[] = /* @__PURE__ */ sortedByName(
  level1ChartTypes,
  level2ChartTypes,
  unimplementedChartTypes,
);

/**
 * Alphabetical by {@link ChartType.name}.
 *
 * Takes the groups rather than the joined array so that the join — a spread, and
 * therefore opaque to a bundler — happens behind the `@__PURE__` above rather
 * than in front of it. The concatenation is fresh and does not escape, so sorting
 * it in place is safe.
 */
function sortedByName(...groups: readonly (readonly ChartType[])[]): readonly ChartType[] {
  return groups.flat().sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * The built-in types at or below `level`.
 *
 * Note that this **excludes** the higher-level stubs, so a Level 1 reader built
 * from `chartTypesForLevel(1)` falls back to core's own unknown-type handling
 * for `sankey`. Registering {@link builtinChartTypes} instead gives the better
 * message. Both satisfy SPEC 15.2.
 *
 * @param level - the conformance level in force (SPEC 16.1). A reader MUST
 * implement every feature of the levels below the one it claims, so this is a
 * cumulative filter, not an exact match.
 */
export function chartTypesForLevel(level: ConformanceLevel): readonly ChartType[] {
  return builtinChartTypes.filter((type) => type.level <= level);
}

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
import { donutChart, pieChart } from './pie.js';
import { heatmapChart } from './heatmap.js';
import { histogramChart } from './histogram.js';
import { lineChart } from './line.js';
import { metricChart } from './metric.js';
import { tableChart } from './table.js';
import { unimplementedChartTypes } from './unimplemented.js';

export { areaChart } from './area.js';
export { barChart } from './bar.js';
export { boxChart } from './box.js';
export { bubbleChart, scatterChart } from './scatter.js';
export { donutChart, pieChart } from './pie.js';
export { heatmapChart } from './heatmap.js';
export { histogramChart } from './histogram.js';
export { lineChart } from './line.js';
export { metricChart } from './metric.js';
export { tableChart } from './table.js';
export {
  UNIMPLEMENTED_TYPES,
  createUnimplementedChartType,
  unimplementedChartTypes,
} from './unimplemented.js';

export type { Annotation } from './internal/annotations.js';

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
 * `histogram` and `box` are drawn (see {@link level2ChartTypes}). The rest are registered
 * as known-but-unimplemented: they render their data as a table with `MDV1500`
 * (SPEC 15.2) rather than erroring. `candlestick` resolves through `ohlcv`'s
 * alias, so there are twelve registrations for thirteen names.
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
 * Everything in {@link LEVEL_2_TYPE_NAMES} that is **not** here is still
 * registered, as a stub that degrades to a table. Registering the drawn ones
 * separately keeps `chartTypesForLevel` honest: a type is in the list for its
 * own level whether it draws or degrades, and this is the set that draws.
 */
export const level2ChartTypes: readonly ChartType[] = [boxChart, heatmapChart, histogramChart];

/**
 * Every built-in chart type, sorted by name.
 *
 * Includes the Level 2 and Level 3 **stubs**, which is deliberate: registering a
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
 */
export const builtinChartTypes: readonly ChartType[] = [
  ...level1ChartTypes,
  ...level2ChartTypes,
  ...unimplementedChartTypes,
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

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

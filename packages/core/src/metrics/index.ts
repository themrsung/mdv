/**
 * Text measurement (SPEC 21).
 *
 * `TableMetrics` is the deterministic default and is what core uses when no
 * provider is injected. `CanvasMetrics` is offered for interactive hosts and
 * takes a context *from* the host — core has no DOM (SPEC 17.3 invariant 1).
 * `FontkitMetrics` lives in `@mdv/render-pdf`, next to the embedded font it
 * reads.
 */

export type { TableMetricsOptions } from './table-metrics.js';
export { createTableMetrics, defaultTableMetrics } from './table-metrics.js';

export type { CanvasLike } from './canvas-metrics.js';
export {
  createCanvasMetrics,
  CanvasMetricsUnavailableError,
  isCanvasLike,
  cssFontShorthand,
} from './canvas-metrics.js';

export {
  codePointWidth,
  stringWidthEm,
  weightFactor,
  styleFactor,
  DEFAULT_ASCENT,
  DEFAULT_DESCENT,
} from './width-table.js';

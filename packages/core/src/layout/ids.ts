/**
 * Deterministic element ids (SPEC 24.3 rule 7).
 *
 * > Element ids are `mdv-{blockIndex}-{counter}`, never content-derived (which
 * > would leak content into markup) and never random.
 *
 * Content-derived ids leak a document's data into its markup, which is a privacy
 * problem in an embedded chart and a churn problem in a diff. Random ids break
 * SSR hydration and every golden file. A counter does neither, and the block
 * index keeps two blocks on one page from colliding.
 */

import type { IdFactory } from '../types/layout.js';

/**
 * Build an id factory for one block.
 *
 * The counter is shared between plain and infixed ids, so the sequence is a
 * total order over everything the block allocated: two layouts of the same block
 * allocate in the same order and produce the same ids.
 */
export function createIdFactory(blockIndex: number): IdFactory {
  const prefix = `mdv-${Number.isFinite(blockIndex) ? Math.trunc(blockIndex) : 0}`;
  let counter = 0;
  return {
    next(infix?: string): string {
      const n = counter++;
      return infix === undefined || infix === '' ? `${prefix}-${n}` : `${prefix}-${infix}-${n}`;
    },
  };
}

/** The stable class tokens SPEC 22.4 makes part of the public API. */
export const CLS = Object.freeze({
  root: 'mdv-chart',
  surface: 'mdv-surface',
  plot: 'mdv-plot',
  marks: 'mdv-marks',
  axis: 'mdv-axis',
  axisX: 'mdv-axis mdv-axis-x',
  axisY: 'mdv-axis mdv-axis-y',
  axisLine: 'mdv-axis-line',
  axisTick: 'mdv-axis-tick',
  axisLabel: 'mdv-axis-label',
  axisTitle: 'mdv-axis-title',
  grid: 'mdv-grid',
  gridLine: 'mdv-grid-line',
  legend: 'mdv-legend',
  legendItem: 'mdv-legend-item',
  legendSwatch: 'mdv-legend-swatch',
  legendLabel: 'mdv-legend-label',
  legendTitle: 'mdv-legend-title',
  title: 'mdv-title',
  subtitle: 'mdv-subtitle',
  caption: 'mdv-caption',
  label: 'mdv-label',
  facet: 'mdv-facet',
  facetTitle: 'mdv-facet-title',
  error: 'mdv-error-card',
  errorCode: 'mdv-error-code',
  errorMessage: 'mdv-error-message',
});

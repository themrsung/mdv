/**
 * Legend models (SPEC 7.4).
 *
 * `auto` resolves to **no legend for a single series** — the title already names
 * it and a one-swatch box is pure overhead — then top for six series or fewer,
 * right for more. Six is where a horizontal strip stops fitting on a narrow
 * block without wrapping into a second row that competes with the subtitle.
 *
 * Symbols mirror the mark, because a legend that draws a square for a line is
 * asking the reader to translate.
 */

import type { LegendAttr } from '../types/attrs.js';
import type {
  LegendEntry,
  LegendModel,
  LegendPosition,
  LegendSymbol,
  SeriesDescriptor,
} from '../types/encode.js';
import type { ChartFamily } from '../registry.js';
import { OTHER_SERIES_ID } from './series.js';

/** `maxItems` default (SPEC 7.4). */
export const DEFAULT_LEGEND_MAX_ITEMS = 12;

/** Above this many series, `auto` puts the legend on the right (SPEC 7.4). */
export const LEGEND_TOP_SERIES_LIMIT = 6;

/** The author's `legend:` attribute, normalised. */
export interface LegendRequest {
  position: 'auto' | LegendPosition | false;
  title: string | false | undefined;
  orient: 'horizontal' | 'vertical' | undefined;
  columns: number | undefined;
  maxItems: number;
}

/** Normalise `legend:` from any of its three spellings (SPEC 7.4). */
export function normalizeLegendAttr(attr: LegendAttr | undefined): LegendRequest {
  if (attr === false) {
    return {
      position: false,
      title: undefined,
      orient: undefined,
      columns: undefined,
      maxItems: DEFAULT_LEGEND_MAX_ITEMS,
    };
  }
  if (attr === undefined || attr === 'auto') {
    return {
      position: 'auto',
      title: undefined,
      orient: undefined,
      columns: undefined,
      maxItems: DEFAULT_LEGEND_MAX_ITEMS,
    };
  }
  if (typeof attr === 'string') {
    return {
      position: attr,
      title: undefined,
      orient: undefined,
      columns: undefined,
      maxItems: DEFAULT_LEGEND_MAX_ITEMS,
    };
  }
  return {
    position: attr.position ?? 'auto',
    title: attr.title,
    orient: attr.orient,
    columns: attr.columns,
    maxItems: attr.maxItems ?? DEFAULT_LEGEND_MAX_ITEMS,
  };
}

/** The symbol a family's marks look like (SPEC 7.4). */
export function symbolForFamily(family: ChartFamily): LegendSymbol {
  switch (family) {
    case 'crosshair':
      return 'line';
    case 'nearest':
      return 'point';
    case 'mark':
    case 'none':
    default:
      return 'rect';
  }
}

/** Options for {@link buildLegendModel}. */
export interface LegendModelOptions {
  series: readonly SeriesDescriptor[];
  request: LegendRequest;
  /** Selects the default symbol. */
  family: ChartFamily;
  /** Overrides the family's symbol, e.g. an area chart inside the line family. */
  symbol?: LegendSymbol;
}

/**
 * Build the legend model, or `undefined` for "no legend".
 *
 * `undefined` is the correct answer for a single series and for `legend: false`;
 * an empty `entries` array would make every downstream consumer check `.length`
 * before reserving space.
 */
export function buildLegendModel(options: LegendModelOptions): LegendModel | undefined {
  const { request, series } = options;
  if (request.position === false) return undefined;
  if (series.length === 0) return undefined;

  const resolved: LegendPosition =
    request.position === 'auto'
      ? series.length <= LEGEND_TOP_SERIES_LIMIT
        ? 'top'
        : 'right'
      : request.position;

  // SPEC 7.4: no legend for a single series under `auto`. An explicit position
  // is an explicit request and is honoured — the author may want the swatch.
  if (request.position === 'auto' && series.length < 2) return undefined;

  const symbol = options.symbol ?? symbolForFamily(options.family);
  const entries: LegendEntry[] = series.map((descriptor) => {
    const entry: LegendEntry = {
      seriesId: descriptor.id,
      label: descriptor.label,
      color: descriptor.color,
      symbol,
    };
    if (descriptor.isOther === true || descriptor.id === OTHER_SERIES_ID) entry.isOther = true;
    if (descriptor.patternDef !== undefined) entry.patternDef = descriptor.patternDef;
    return entry;
  });

  const model: LegendModel = {
    position: resolved,
    entries,
    maxItems: request.maxItems,
  };
  if (request.title !== undefined) model.title = request.title;
  if (request.orient !== undefined) model.orient = request.orient;
  else model.orient = resolved === 'left' || resolved === 'right' ? 'vertical' : 'horizontal';
  if (request.columns !== undefined) model.columns = request.columns;
  return model;
}

/**
 * Fold entries past `maxItems` into a single "Other" entry (SPEC 7.4).
 *
 * Applied by core at layout time rather than by the chart type, so the fold
 * point is identical everywhere and the `MDV3062` diagnostic is emitted once.
 *
 * @returns the folded entries and how many were absorbed
 */
export function foldLegendEntries(
  entries: readonly LegendEntry[],
  maxItems: number,
  otherColor: string,
  otherLabel = 'Other',
): { entries: LegendEntry[]; folded: number } {
  const limit = Math.max(1, maxItems);
  if (entries.length <= limit) return { entries: [...entries], folded: 0 };

  const kept = entries.slice(0, limit - 1);
  const absorbed = entries.slice(limit - 1);
  const existingOther = absorbed.find((entry) => entry.isOther === true);
  kept.push({
    seriesId: existingOther?.seriesId ?? OTHER_SERIES_ID,
    label: existingOther?.label ?? otherLabel,
    color: existingOther?.color ?? otherColor,
    symbol: (entries[0] as LegendEntry).symbol,
    isOther: true,
  });
  return { entries: kept, folded: absorbed.length };
}

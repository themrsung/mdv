/**
 * Series identity, palette allocation and the legend model (SPEC 7.1.1, 7.4,
 * 11.2).
 *
 * **Color follows the entity, not its rank** (SPEC 11.2 rule 1). Identity is the
 * series' value in the `series` field, or the bound field name in wide form —
 * never an array index into the filtered data. Slots come from the
 * {@link PaletteAllocator} core built over the *unfiltered* domain, so a series
 * keeps its color when a filter or a sort removes another.
 */

import type {
  BlockAttrs,
  Encoding,
  LegendAttr,
  LegendModel,
  LegendPosition,
  LegendSymbol,
  PaletteAllocator,
  SeriesDescriptor,
  Table,
} from '@mdv/core';
import { cell, channelList, findColumn, humaniseColumn } from './table.js';

/** The synthetic identity every over-cap series folds into (SPEC 7.4, `MDV3062`). */
export const OTHER_SERIES_ID = 'Other';

/** How rows became series. */
export type SeriesForm = 'single' | 'wide' | 'long';

/** One resolved series, plus the data location it reads. */
export interface SeriesPlan {
  descriptor: SeriesDescriptor;
  /**
   * Column holding this series' measure. In wide form each series has its own
   * column; in long form every series shares one.
   */
  valueColumn: number;
  /**
   * Long form only: the identity value that selects this series' rows. `undefined`
   * in wide and single form, where every row belongs to the series.
   */
  matchKey?: string;
}

/** The outcome of {@link buildSeries}. */
export interface SeriesResolution {
  form: SeriesForm;
  plans: SeriesPlan[];
  /** `true` when at least one series folded into "Other" (`MDV3062`). */
  folded: boolean;
}

/** Inputs to {@link buildSeries}. */
export interface BuildSeriesInput {
  table: Table;
  encoding: Encoding;
  palette: PaletteAllocator;
  /** Value channel: `y` for cartesian types, `value` for pie. */
  valueChannel: 'y' | 'value';
  /** Label for the implicit series when there is only one (usually the field title). */
  singleLabel?: string;
}

/**
 * Resolve rows into series (SPEC 7.1.1).
 *
 * Wide form (`y: [ios, android]`) yields one series per field, in the order the
 * author wrote them. Long form (`series: metric`) yields one per distinct value,
 * in **first-appearance order** over the table. Neither yields a single unnamed
 * series whose id is `''`, which is what {@link MarkBase.seriesId} documents for
 * an unsplit chart.
 */
export function buildSeries(input: BuildSeriesInput): SeriesResolution {
  const { table, encoding, palette } = input;
  const valueChannels = channelList(encoding, input.valueChannel);
  const seriesChannel = channelList(encoding, 'series')[0];
  const seriesColumn = findColumn(table, seriesChannel?.field);

  // Long form: one series per distinct value of the `series` field.
  if (seriesColumn !== undefined) {
    const valueColumn = findColumn(table, valueChannels[0]?.field);
    if (valueColumn === undefined) return { form: 'long', plans: [], folded: false };
    const seen = new Set<string>();
    const identities: string[] = [];
    for (let row = 0; row < table.rows.length; row += 1) {
      const value = cell(table, row, seriesColumn.index);
      if (value === null) continue;
      const key = value instanceof Date ? value.toISOString() : String(value);
      if (seen.has(key)) continue;
      seen.add(key);
      identities.push(key);
    }
    return foldAndDescribe(
      identities.map((id) => ({
        id,
        label: id,
        source: seriesChannel?.field ?? '',
        valueColumn: valueColumn.index,
        matchKey: id,
      })),
      palette,
      'long',
    );
  }

  // Wide form: one series per bound field.
  if (valueChannels.length > 1) {
    const entries: RawSeries[] = [];
    for (const channel of valueChannels) {
      const column = findColumn(table, channel.field);
      if (column === undefined) continue;
      const id = column.column.name;
      entries.push({
        id,
        label: typeof channel.title === 'string' ? channel.title : humaniseColumn(column.column),
        source: id,
        valueColumn: column.index,
      });
    }
    return foldAndDescribe(entries, palette, 'wide');
  }

  // Single series.
  const only = findColumn(table, valueChannels[0]?.field);
  if (only === undefined) return { form: 'single', plans: [], folded: false };
  const label = input.singleLabel ?? humaniseColumn(only.column);
  return {
    form: 'single',
    folded: false,
    plans: [
      {
        descriptor: {
          id: '',
          label,
          slot: palette.slot(only.column.name),
          color: palette.color(only.column.name),
          source: only.column.name,
          ...withPattern(palette, only.column.name),
        },
        valueColumn: only.index,
      },
    ],
  };
}

interface RawSeries {
  id: string;
  label: string;
  source: string;
  valueColumn: number;
  matchKey?: string;
}

/** Apply the palette cap, folding the overflow into one "Other" series. */
function foldAndDescribe(
  entries: readonly RawSeries[],
  palette: PaletteAllocator,
  form: SeriesForm,
): SeriesResolution {
  const plans: SeriesPlan[] = [];
  let folded = false;
  let otherAdded = false;
  for (const entry of entries) {
    if (palette.isOverflow(entry.id)) {
      folded = true;
      if (!otherAdded) {
        otherAdded = true;
        plans.push({
          descriptor: {
            id: OTHER_SERIES_ID,
            label: OTHER_SERIES_ID,
            slot: -1,
            color: palette.color(entry.id),
            source: entry.source,
            isOther: true,
            ...withPattern(palette, entry.id),
          },
          valueColumn: entry.valueColumn,
          ...(entry.matchKey === undefined ? {} : { matchKey: entry.matchKey }),
        });
      }
      continue;
    }
    plans.push({
      descriptor: {
        id: entry.id,
        label: entry.label,
        slot: palette.slot(entry.id),
        color: palette.color(entry.id),
        source: entry.source,
        ...withPattern(palette, entry.id),
      },
      valueColumn: entry.valueColumn,
      ...(entry.matchKey === undefined ? {} : { matchKey: entry.matchKey }),
    });
  }
  return { form, plans, folded };
}

/**
 * Spread the texture def only when there is one.
 *
 * `exactOptionalPropertyTypes` forbids assigning `undefined` to an optional
 * property, so an absent texture must be an absent key.
 */
function withPattern(palette: PaletteAllocator, id: string): { patternDef?: string } {
  const def = palette.patternDef(id);
  return def === undefined ? {} : { patternDef: def };
}

// ─────────────────────────────────────────────────────────────────────────────
// Legend (SPEC 7.4)
// ─────────────────────────────────────────────────────────────────────────────

/** Resolve `legend: auto` (SPEC 7.4). */
function autoPosition(count: number): LegendPosition {
  return count <= 6 ? 'top' : 'right';
}

/**
 * Build the legend model, or `undefined` for none.
 *
 * `auto` means **no legend for a single series**: the title names it, and a
 * one-swatch box is pure overhead (SPEC 7.4).
 */
export function buildLegend(
  attrs: BlockAttrs,
  series: readonly SeriesDescriptor[],
  symbol: LegendSymbol,
): LegendModel | undefined {
  const request: LegendAttr = attrs.legend ?? 'auto';
  if (request === false) return undefined;

  const named = series.filter((s) => s.id !== '');
  const object = typeof request === 'object' ? request : undefined;
  const requested = typeof request === 'string' ? request : (object?.position ?? 'auto');

  if (requested === 'auto' && named.length < 2) return undefined;
  if (named.length === 0) return undefined;

  const position: LegendPosition = requested === 'auto' ? autoPosition(named.length) : requested;
  const model: LegendModel = {
    position,
    entries: named.map((s) => ({
      seriesId: s.id,
      label: s.label,
      color: s.color,
      symbol,
      ...(s.isOther === true ? { isOther: true as const } : {}),
      ...(s.patternDef === undefined ? {} : { patternDef: s.patternDef }),
    })),
  };
  if (object?.title !== undefined) model.title = object.title;
  if (object?.orient !== undefined) model.orient = object.orient;
  if (object?.columns !== undefined) model.columns = object.columns;
  model.maxItems = object?.maxItems ?? 12;
  return model;
}

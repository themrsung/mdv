/**
 * Series identity (SPEC 7.1.1, 11.2 rule 1).
 *
 * A "series" is whatever the legend would name. Long form gets it from the
 * `series` column; wide form gets it from the bound field names. Either way the
 * identity is a **string that came from the data or from the document**, never
 * an index, so it survives a filter, a sort, a re-order of the encoding and a
 * re-render.
 */

import type { PaletteAllocator } from '../registry.js';
import type { Table } from '../types/data.js';
import type { Encoding, SeriesDescriptor } from '../types/encode.js';
import { channelList, encodingForm } from './normalize.js';
import { columnTitle, columnValues, column, identityKey } from './table-access.js';

/** An identity before it is given a slot. */
export interface SeriesIdentity {
  /** Stable identity: the `series` cell, or the field name. */
  id: string;
  /** Display name for the legend and the readout. */
  label: string;
  /** Source field name in wide form; the `series` field value in long form. */
  source: string;
}

/**
 * Identities in **first-appearance order** over the rows given.
 *
 * First appearance, not sorted: SPEC 11.2 rule 1 fixes colour to identity
 * resolved in first-appearance order, and sorting would make a series' colour
 * depend on what its neighbours are called.
 */
export function identitiesFromSeriesColumn(table: Table, field: string): SeriesIdentity[] {
  const values = columnValues(table, field);
  const seen = new Set<string>();
  const out: SeriesIdentity[] = [];
  for (const value of values) {
    const id = identityKey(value);
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id, source: field });
  }
  return out;
}

/** Identities for wide form: one per bound field, in the author's order. */
export function identitiesFromFields(table: Table, fields: readonly string[]): SeriesIdentity[] {
  const seen = new Set<string>();
  const out: SeriesIdentity[] = [];
  for (const field of fields) {
    if (seen.has(field)) continue;
    seen.add(field);
    out.push({ id: field, label: columnTitle(column(table, field), field), source: field });
  }
  return out;
}

/**
 * The identities of an encoding, whichever form it is written in.
 *
 * @param valueChannel - the channel that carries the measure: `y` for most
 * types, `value` for pie and heatmap.
 */
export function seriesIdentities(
  table: Table,
  encoding: Encoding,
  valueChannel: 'y' | 'value' | 'x' = 'y',
): SeriesIdentity[] {
  const form = encodingForm(encoding, valueChannel);
  if (form === 'wide') {
    const fields = channelList(encoding, valueChannel)
      .map((channel) => channel.field)
      .filter((field): field is string => field !== undefined);
    return identitiesFromFields(table, fields);
  }
  if (form === 'long') {
    const field = channelList(encoding, 'series')[0]?.field;
    if (field !== undefined) return identitiesFromSeriesColumn(table, field);
  }
  // Single series: identity is the measure field itself, so a one-series chart
  // still has a stable id for hit regions and focus order.
  const field = channelList(encoding, valueChannel)[0]?.field;
  if (field === undefined) return [];
  return [{ id: field, label: columnTitle(column(table, field), field), source: field }];
}

/** Options for {@link buildSeriesDescriptors}. */
export interface SeriesDescriptorOptions {
  identities: readonly SeriesIdentity[];
  palette: PaletteAllocator;
  /** Label for the folded series (SPEC 7.4). @defaultValue 'Other' */
  otherLabel?: string;
  /** Fold overflow identities into one synthetic series. @defaultValue true */
  fold?: boolean;
}

/**
 * Turn identities into {@link SeriesDescriptor}s with palette slots.
 *
 * Overflow identities collapse into a single synthetic series with `slot: -1`
 * and `isOther: true`. Its id is `'__other__'`: a value a data column could
 * plausibly hold would collide with a real series, and a colliding identity is a
 * silently wrong legend.
 */
export function buildSeriesDescriptors(options: SeriesDescriptorOptions): {
  series: SeriesDescriptor[];
  folded: string[];
} {
  const series: SeriesDescriptor[] = [];
  const folded: string[] = [];

  for (const identity of options.identities) {
    if (options.palette.isOverflow(identity.id)) {
      folded.push(identity.id);
      continue;
    }
    const patternDef = options.palette.patternDef(identity.id);
    series.push({
      id: identity.id,
      label: identity.label,
      slot: options.palette.slot(identity.id),
      color: options.palette.color(identity.id),
      source: identity.source,
      ...(patternDef !== undefined ? { patternDef } : {}),
    });
  }

  if (folded.length > 0 && options.fold !== false) {
    series.push({
      id: OTHER_SERIES_ID,
      label: options.otherLabel ?? 'Other',
      slot: -1,
      color: options.palette.color(OTHER_SERIES_ID),
      source: OTHER_SERIES_ID,
      isOther: true,
    });
  }

  return { series, folded };
}

/** The identity of the synthetic folded series (SPEC 7.4, `MDV3062`). */
export const OTHER_SERIES_ID = '__other__';

/** Look a descriptor up by identity. Linear: a block has at most a dozen series. */
export function findSeries(
  series: readonly SeriesDescriptor[],
  id: string,
): SeriesDescriptor | undefined {
  for (const entry of series) if (entry.id === id) return entry;
  return undefined;
}

/**
 * The descriptor a datum belongs to, following the fold.
 *
 * An identity that overflowed resolves to the "Other" descriptor rather than to
 * nothing, so a folded row is still drawn and still hit-testable.
 */
export function resolveSeries(
  series: readonly SeriesDescriptor[],
  id: string,
): SeriesDescriptor | undefined {
  return findSeries(series, id) ?? findSeries(series, OTHER_SERIES_ID);
}

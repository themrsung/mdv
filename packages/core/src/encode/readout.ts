/**
 * Readout construction (SPEC 7.5, 12.4) — **data on the scene, never behaviour.**
 *
 * A readout is the row list a hover *or* a keyboard focus shows; the two are
 * required to be identical (SPEC 12.4), so they are built once, here, and stored
 * on the {@link HitRegion}. Core emits no listeners: the interaction layer lives
 * in a renderer, reads `hitIndex`, and cannot invent a value the scene does not
 * already carry.
 *
 * Three rules from SPEC 7.5 are enforced by construction:
 *
 * - **The value is the prominent element**, the series name is secondary — the
 *   reader already knows which series they are pointing at.
 * - **Tooltips enhance, never gate.** Every value here also appears in the table
 *   view, which is what makes PDF export lossless.
 * - Series and field names come from untrusted data and are carried as **plain
 *   strings**; a renderer inserts them as text nodes, never as markup (SPEC 13.3).
 */

import type { TooltipAttr } from '../types/attrs.js';
import type { Table, Value } from '../types/data.js';
import type { SeriesDescriptor } from '../types/encode.js';
import type { ReadoutRow } from '../types/scene.js';
import type { ColorString } from '../types/theme.js';
import { formatValue } from '../scale/format.js';
import { cell, column, columnTitle } from './table-access.js';

/** The `tooltip:` attribute, normalised (SPEC 7.5). */
export interface TooltipRequest {
  /** `false` disables the hover layer entirely. */
  enabled: boolean;
  /** Extra fields added to the readout, in author order. */
  extraFields: readonly string[];
}

/** Normalise `tooltip:` from any of its three spellings. */
export function normalizeTooltipAttr(attr: TooltipAttr | undefined): TooltipRequest {
  if (attr === false) return { enabled: false, extraFields: [] };
  if (attr === undefined || attr === true) return { enabled: true, extraFields: [] };
  return { enabled: true, extraFields: [...attr] };
}

/** One row of a readout before formatting. */
export interface ReadoutInput {
  label: string;
  value: Value;
  /** Format pattern for this row's value. */
  format?: string | undefined;
  swatch?: ColorString | undefined;
  /** Marks the row the pointer or focus is actually on. */
  emphasis?: boolean;
}

/** Formatting context for a readout. */
export interface ReadoutContext {
  locale: string;
  timezone: string;
}

/** Format one row. Missing values render blank, never as the word "null". */
export function buildReadoutRow(input: ReadoutInput, ctx: ReadoutContext): ReadoutRow {
  const row: ReadoutRow = {
    label: input.label,
    value: formatValue(input.value, input.format, ctx),
  };
  if (input.swatch !== undefined) row.swatch = input.swatch;
  if (input.emphasis === true) row.emphasis = true;
  return row;
}

/** Options for {@link buildReadout}. */
export interface ReadoutOptions {
  table: Table;
  /** Row index in the prepared table. */
  datum: number;
  /** The series this mark belongs to, for the swatch and the label. */
  series?: SeriesDescriptor | undefined;
  /** The category or x value, shown first as the row's heading. */
  keyLabel?: string | undefined;
  keyValue?: Value;
  keyFormat?: string | undefined;
  /** The measure. */
  valueLabel?: string | undefined;
  value?: Value;
  valueFormat?: string | undefined;
  /** Fields from `tooltip: [field, …]`. */
  extraFields?: readonly string[];
  ctx: ReadoutContext;
}

/**
 * Build the readout for one mark.
 *
 * Row order is fixed: the key (the x value, the category), then the measure,
 * then any `tooltip:` fields in author order. Fixed order matters more than
 * cleverness — a reader moving along a line should not see rows re-arrange.
 */
export function buildReadout(options: ReadoutOptions): ReadoutRow[] {
  const rows: ReadoutRow[] = [];

  if (options.keyLabel !== undefined) {
    rows.push(
      buildReadoutRow(
        { label: options.keyLabel, value: options.keyValue ?? null, format: options.keyFormat },
        options.ctx,
      ),
    );
  }

  const measureLabel = options.series?.label ?? options.valueLabel ?? 'Value';
  rows.push(
    buildReadoutRow(
      {
        label: measureLabel,
        value: options.value ?? null,
        format: options.valueFormat,
        swatch: options.series?.color,
        emphasis: true,
      },
      options.ctx,
    ),
  );

  for (const field of options.extraFields ?? []) {
    const field_ = column(options.table, field);
    if (field_ === undefined) continue;
    rows.push(
      buildReadoutRow(
        {
          label: columnTitle(field_, field),
          value: cell(options.table, options.datum, field),
          format: field_.format,
        },
        options.ctx,
      ),
    );
  }

  return rows;
}

/**
 * Build the crosshair readout: every series at one x (SPEC 7.5, line/area/OHLC).
 *
 * The reader aims at a date, never at a 2 px stroke, so the row list is keyed on
 * the shared x and lists each series once. `emphasis` marks the series nearest
 * the pointer, which the caller determines from geometry.
 */
export function buildCrosshairReadout(
  keyLabel: string,
  keyValue: Value,
  keyFormat: string | undefined,
  entries: readonly {
    series: SeriesDescriptor;
    value: Value;
    format?: string | undefined;
    emphasis?: boolean;
  }[],
  ctx: ReadoutContext,
): ReadoutRow[] {
  const rows: ReadoutRow[] = [
    buildReadoutRow({ label: keyLabel, value: keyValue, format: keyFormat }, ctx),
  ];
  for (const entry of entries) {
    rows.push(
      buildReadoutRow(
        {
          label: entry.series.label,
          value: entry.value,
          format: entry.format,
          swatch: entry.series.color,
          ...(entry.emphasis === true ? { emphasis: true } : {}),
        },
        ctx,
      ),
    );
  }
  return rows;
}

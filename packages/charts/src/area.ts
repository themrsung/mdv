/**
 * `area` — magnitude over a continuous domain (SPEC 8.4).
 *
 * Identical encoding to `line`, plus `stack`, `fillOpacity`, `line` and `band`.
 * Two differences are load-bearing:
 *
 * - The y-domain **includes zero**. A filled area encodes magnitude by height, so
 *   truncating its axis misstates that magnitude (`MDV3021`).
 * - Unstacked overlapping areas are limited to **two series** (`MDV3040`): three
 *   translucent fills over one another are unreadable, and the correct form is a
 *   line chart or small multiples.
 */

import type {
  ChartLayoutResult,
  ChartType,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  LineMark,
  Rect,
  ResolvedBlock,
  Table,
} from '@mdv/core';
import {
  LINE_CHANNELS,
  describeLineArea,
  encodeLineArea,
  layoutLineArea,
} from './internal/line-area.js';
import { findColumn, firstChannel, humaniseColumn } from './internal/table.js';
import { validateLineLike } from './line.js';

/** `area` (SPEC 8.4). */
export const areaChart: ChartType<LineMark> = {
  name: 'area',
  level: 1,
  family: 'crosshair',
  channels: LINE_CHANNELS,
  defaultEncoding: {},
  defaults: { curve: 'linear', fillOpacity: 0.1, line: true, nullPolicy: 'gap', baseline: 0 },
  schemaId: 'https://mdv.dev/schema/1.0/block/area.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    return validateLineLike(block, table, 'area');
  },

  encode(input: EncodeInput): EncodeResult<LineMark> {
    return encodeLineArea(input, 'area');
  },

  layout(encoded: EncodeResult<LineMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    return layoutLineArea(encoded, frame, ctx);
  },

  describe(input: DescribeInput<LineMark>): string {
    const xChannel = firstChannel(input.block.encoding, 'x');
    const xColumn = findColumn(input.table, xChannel?.field)?.column;
    return describeLineArea(
      'Area chart',
      input.encoded,
      xColumn === undefined ? undefined : humaniseColumn(xColumn),
    );
  },
};

export default areaChart;

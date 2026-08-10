/**
 * `line` — change over a continuous domain (SPEC 8.3).
 *
 * **Use when** the x-domain is ordered and continuous and the *shape of change*
 * matters more than individual magnitudes. A line may be truncated — its y-domain
 * does not include zero by default — because it encodes change, not magnitude
 * (SPEC 7.2).
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
import { LINE_CHANNELS, describeLineArea, encodeLineArea, layoutLineArea } from './internal/line-area.js';
import {
  bindField,
  channelList,
  findColumn,
  firstChannel,
  humaniseColumn,
  isChannelList,
  isQuantitative,
} from './internal/table.js';
import { blockDiagnostic, incompatibleField, missingChannel } from './internal/diagnostics.js';

/** `line` (SPEC 8.3). */
export const lineChart: ChartType<LineMark> = {
  name: 'line',
  level: 1,
  // A vertical crosshair snaps to the nearest x and the readout lists *every*
  // series there: the reader aims at a date, never at a 2 px stroke (SPEC 7.5).
  family: 'crosshair',
  channels: LINE_CHANNELS,
  defaultEncoding: {},
  defaults: { curve: 'linear', strokeWidth: 2, points: 'none', pointSize: 8, nullPolicy: 'gap' },
  schemaId: 'https://mdv.dev/schema/1.0/block/line.json',
  minWidth: 240,

  validate(block: ResolvedBlock, table: Table): Diagnostic[] {
    return validateLineLike(block, table, 'line');
  },

  encode(input: EncodeInput): EncodeResult<LineMark> {
    return encodeLineArea(input, 'line');
  },

  layout(encoded: EncodeResult<LineMark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
    return layoutLineArea(encoded, frame, ctx);
  },

  describe(input: DescribeInput<LineMark>): string {
    const xChannel = firstChannel(input.block.encoding, 'x');
    const xColumn = findColumn(input.table, xChannel?.field)?.column;
    return describeLineArea('Line chart', input.encoded, xColumn === undefined ? undefined : humaniseColumn(xColumn));
  },
};

/**
 * Semantic validation shared by `line` and `area`.
 *
 * Only what a JSON Schema cannot express: channel/field-type compatibility and
 * the wide-vs-long exclusivity rule.
 */
export function validateLineLike(block: ResolvedBlock, table: Table, typeName: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const xChannel = firstChannel(block.encoding, 'x');
  const yChannels = channelList(block.encoding, 'y');

  if (xChannel?.field === undefined) {
    diagnostics.push(missingChannel(block, 'x', 'the ordered domain the series runs along'));
  } else if (findColumn(table, xChannel.field) === undefined && table.fields.length > 0) {
    diagnostics.push(
      blockDiagnostic('MDV3000', block, 'encode', `\`x\` names \`${xChannel.field}\`, which is not a column`),
    );
  }

  if (yChannels.length === 0 || yChannels.every((channel) => channel.field === undefined)) {
    diagnostics.push(missingChannel(block, 'y', 'the measure the line traces'));
  }

  if (isChannelList(block.encoding, 'y') && firstChannel(block.encoding, 'series')?.field !== undefined) {
    diagnostics.push(
      blockDiagnostic(
        'MDV3010',
        block,
        'encode',
        'A list-valued `y` and `series` both split the data into series',
        `Use a list \`y\` for wide data, or \`series\` with a single \`y\` for long data — not both on a \`${typeName}\` block.`,
      ),
    );
  }

  for (const channel of yChannels) {
    const bound = bindField(table, channel);
    if (bound === undefined) continue;
    if (!isQuantitative(bound.column.type) && bound.column.type !== 'unknown') {
      diagnostics.push(
        incompatibleField(block, 'y', bound.column.name, bound.column.type, ['number', 'integer', 'duration']),
      );
    }
  }
  return diagnostics;
}

export default lineChart;

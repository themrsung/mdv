/**
 * Known-but-unimplemented types — the graceful-degradation path (SPEC 15.2).
 *
 * SPEC 15.2 is unambiguous about what a reader does with a block type it cannot
 * draw:
 *
 * > Render the data as a table with a notice naming the type. `MDV1500`
 * > (warning). Never an error: a document using a Level 3 type must stay
 * > readable in a Level 1 reader.
 *
 * There are two ways to reach that outcome, and they are not equivalent:
 *
 * 1. **Leave the type unregistered.** `registry.get(name)` returns `undefined`,
 *    and core is responsible for the notice and the table. This works, but core
 *    cannot say anything true about the type beyond its spelling — it does not
 *    know whether `sankey` is a real MDV type the reader is too low a level for,
 *    or a typo for `snakey`, or a plugin the user forgot to load.
 * 2. **Register a type that knows it is unimplemented.** The registry then
 *    answers `has('sankey') === true`, the diagnostic can name the *conformance
 *    level* the author's document actually requires, and — critically — the
 *    block still flows through the ordinary encode/layout seam, so it gets the
 *    real enhanced-table renderer, the real `a11yTable`, the real hit regions
 *    and the real PDF export rather than a bespoke fallback widget.
 *
 * This module implements (2). Every Level 2 and Level 3 type in SPEC 16.1 is
 * registered here as a stub whose `encode` emits `MDV1500` and then delegates to
 * `table`'s encoder, and whose `layout` is `table`'s layout verbatim. The result
 * is that upgrading `sankey` from "known" to "drawn" later is purely additive:
 * delete its entry from {@link UNIMPLEMENTED_TYPES}, add the real module, and
 * every other seam is unchanged.
 *
 * **`validate` never returns an error.** An error would make core render the
 * error card, which is exactly the outcome SPEC 15.2 forbids. Nothing about an
 * unimplemented type is the author's fault.
 */

import type {
  ChannelSpec,
  ChartLayoutResult,
  ChartType,
  ConformanceLevel,
  DescribeInput,
  Diagnostic,
  EncodeInput,
  EncodeResult,
  LayoutContext,
  Mark,
  Rect,
  ResolvedBlock,
  Table,
} from '@mdv/core';
import { blockDiagnostic } from './internal/diagnostics.js';
import { encodeTableView, layoutTableView, tableChart } from './table.js';

/**
 * Channels the stubs accept.
 *
 * Declared permissively and identically for every stub, on purpose. A stub is
 * not going to draw anything, so rejecting `x` on a `treemap` would produce a
 * second, misleading diagnostic (`MDV3020`, "unknown channel") on top of the one
 * that actually explains the situation. The author's encoding is *correct* — the
 * reader is simply too low a level to honour it — so the stub accepts everything
 * and says nothing about it.
 *
 * `accepts` is every {@link DataType} for the same reason: no field can be the
 * wrong type for a chart that will not be drawn.
 */
const PERMISSIVE_CHANNELS: readonly ChannelSpec[] = [
  {
    name: 'x',
    required: false,
    accepts: [],
    list: true,
    constant: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'y',
    required: false,
    accepts: [],
    list: true,
    constant: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'series',
    required: false,
    accepts: [],
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'color',
    required: false,
    accepts: [],
    constant: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'size',
    required: false,
    accepts: [],
    constant: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'shape',
    required: false,
    accepts: [],
    constant: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'label',
    required: false,
    accepts: [],
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'value',
    required: false,
    accepts: [],
    list: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'category',
    required: false,
    accepts: [],
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'group',
    required: false,
    accepts: [],
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'detail',
    required: false,
    accepts: [],
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
  {
    name: 'tooltip',
    required: false,
    accepts: [],
    list: true,
    doc: 'Not interpreted: this type is not implemented at this conformance level.',
  },
];

/** What we know about a type we do not draw. */
interface UnimplementedSpec {
  /** The block type token as written in the info string. */
  readonly name: string;
  /** The conformance level that must be implemented before this type appears. */
  readonly level: ConformanceLevel;
  /** Alternative spellings the registry should resolve to this type (SPEC 16.1). */
  readonly aliases?: readonly string[];
  /** One clause naming what the reader would have drawn, for the diagnostic. */
  readonly summary: string;
}

/**
 * Every Level 2 and Level 3 type in SPEC 16.1 this reader does not draw, sorted
 * by name.
 *
 * `box`, `funnel`, `gauge`, `heatmap`, `histogram`, `ohlc`, `ohlcv`, `radar`
 * and `waterfall` are absent because they are drawn for real; `candlestick` is
 * absent because SPEC 8.11 makes it an **alias** of `ohlc`, and the registry
 * resolves aliases, so registering it separately would produce two types that
 * disagree about their own name.
 */
export const UNIMPLEMENTED_TYPES: readonly UnimplementedSpec[] = [
  { name: 'gantt', level: 3, summary: 'a Gantt chart of the schedule' },
  { name: 'map', level: 3, summary: 'a choropleth or point map' },
  { name: 'network', level: 3, summary: 'a node-link diagram' },
  { name: 'sankey', level: 2, summary: 'a Sankey diagram of the flows' },
  { name: 'sparkline', level: 2, summary: 'an inline sparkline' },
  { name: 'treemap', level: 2, summary: 'a treemap of the nested magnitudes' },
];

/**
 * Build a stub {@link ChartType} that renders its data as a table and warns.
 *
 * Exported so a host that ships its own partial implementations can build the
 * same degradation for a type this package does not list — the shape of the
 * fallback should not vary between types.
 *
 * @param spec - the type's name, level and one-clause summary
 */
export function createUnimplementedChartType(spec: UnimplementedSpec): ChartType<Mark> {
  const { name, level, summary } = spec;

  const type: ChartType<Mark> = {
    name,
    level,
    ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    // The row is the target, because a table is what is actually on screen.
    family: 'mark',
    channels: PERMISSIVE_CHANNELS,
    defaultEncoding: {},
    // Table defaults apply, since a table is what gets drawn.
    ...(tableChart.defaults === undefined ? {} : { defaults: tableChart.defaults }),
    minWidth: tableChart.minWidth ?? 240,

    /**
     * Never an error, and never a complaint about the author's attributes.
     *
     * `table`'s own `validate` is deliberately *not* delegated to: it would emit
     * `MDV1501` for every attribute of the original type (`bins`, `whisker`,
     * `nodeWidth`) that is not a table attribute, burying the one diagnostic
     * that matters under a dozen that do not.
     */
    validate(_block: ResolvedBlock, _table: Table): Diagnostic[] {
      return [];
    },

    encode(input: EncodeInput): EncodeResult<Mark> {
      input.diagnostic(
        blockDiagnostic(
          'MDV1500',
          input.block,
          'encode',
          `\`${name}\` is a Level ${level} block type and this reader implements Level ${input.level} — rendered as a table`,
          `A Level ${level} reader would draw ${summary}. The data is shown in full below; no rows were dropped.`,
        ),
      );
      return encodeTableView(input);
    },

    layout(encoded: EncodeResult<Mark>, frame: Rect, ctx: LayoutContext): ChartLayoutResult {
      return layoutTableView(encoded, frame, ctx);
    },

    describe(input: DescribeInput<Mark>): string {
      const table = tableChart.describe?.(input) ?? '';
      const notice = `Shown as a table: this reader does not implement the \`${name}\` block type.`;
      return table === '' ? notice : `${notice} ${table}`;
    },
  };

  return type;
}

/**
 * Every Level 2 and Level 3 type, as table-rendering stubs, sorted by name.
 *
 * Registering these alongside the Level 1 types is what makes a Level 2 document
 * *readable* rather than *broken* in a Level 1 reader.
 */
export const unimplementedChartTypes: readonly ChartType[] = UNIMPLEMENTED_TYPES.map(
  createUnimplementedChartType,
);

/**
 * Axis models (SPEC 7.3) and the enforcement of **the one-axis rule** (SPEC
 * 7.3.1).
 *
 * > A block MUST NOT define two independent y-scales. There is no `y2`, no
 * > `secondaryAxis`, no `axis.right.scale`.
 *
 * The rule is not stylistic. A dual-axis chart lets the author choose an
 * arbitrary alignment between two unrelated scales; slide one axis and the
 * crossing point moves, so two readers draw opposite conclusions from the same
 * numbers. MDV therefore refuses the construction outright and points at the
 * three supported answers, all of which preserve a single interpretation:
 *
 * 1. two blocks stacked in a `:::mdv-grid{cols=1}`, sharing an x-domain with
 *    `syncX:`;
 * 2. small multiples (`row:` / `column:` faceting);
 * 3. indexing both measures to a common base with a `derive` transform.
 *
 * Enforcement happens twice, because there are two ways to ask: the author can
 * write `y2:` ({@link detectSecondAxisRequest}), and a chart type can return two
 * independent axes on opposite edges ({@link enforceOneAxisRule}). Both are
 * caught here so that no chart type has to remember to.
 */

import type { Diagnostic, DiagnosticSource } from '@mdv/parser';
import type { BlockAttrs } from '../types/attrs.js';
import type { AxisModel, AxisSpec, ChannelName, Scale } from '../types/encode.js';
import type { ResolvedBlock } from '../types/resolved.js';
import type { Reporter } from './report.js';
import { createReporter } from './report.js';

/** Which of the two plot dimensions an edge belongs to. */
export type AxisDimension = 'horizontal' | 'vertical';

/** The dimension an axis position lies on. */
export function axisDimension(position: AxisModel['position']): AxisDimension {
  return position === 'left' || position === 'right' ? 'vertical' : 'horizontal';
}

/** The default edge for a channel (SPEC 7.3, `position` default). */
export function defaultAxisPosition(channel: ChannelName): AxisModel['position'] {
  return channel === 'x' ? 'bottom' : 'left';
}

/** What {@link buildAxisModel} needs to turn a request into a model. */
export interface AxisRequest {
  channel: ChannelName;
  /** The scale the marks used. Must be the same instance core will tick. */
  scale: Scale;
  /** The author's `axis:` entry for this channel, or `false` to suppress. */
  spec?: AxisSpec | false | undefined;
  /** Title when the author did not give one: the humanised field name. */
  defaultTitle: string;
  /** Gridlines default to on for the value axis, off for the category axis. */
  defaultGrid?: boolean;
  /** Draw the axis baseline. @defaultValue true */
  baseline?: boolean;
  /** Overrides the channel's default edge. */
  position?: AxisModel['position'];
  /** Field format, used when the axis declares none. */
  format?: string | undefined;
}

/**
 * Build one {@link AxisModel}.
 *
 * @returns `undefined` when the author wrote `axis: {x: false}` — a suppressed
 * axis is absent from the model, not present-and-invisible, so nothing
 * downstream has to check a flag before reserving space for it.
 */
export function buildAxisModel(request: AxisRequest): AxisModel | undefined {
  if (request.spec === false) return undefined;
  const spec = request.spec ?? {};

  const title: string | false = spec.title === false ? false : (spec.title ?? request.defaultTitle);

  const model: AxisModel = {
    channel: request.channel,
    position: spec.position ?? request.position ?? defaultAxisPosition(request.channel),
    scale: request.scale,
    title,
    grid: spec.grid ?? request.defaultGrid ?? false,
    ticks: spec.ticks ?? 'auto',
    baseline: request.baseline ?? true,
  };
  if (spec.tickValues !== undefined) model.tickValues = spec.tickValues;
  if (spec.tickRotate !== undefined) model.tickRotate = spec.tickRotate;
  const format = spec.format ?? request.format;
  if (format !== undefined) model.format = format;
  return model;
}

/** The three supported alternatives, quoted into every one-axis diagnostic. */
const ONE_AXIS_DETAIL =
  'A block must not define two independent y-scales (SPEC 7.3.1): the alignment ' +
  'between them is arbitrary, so every reader draws a different conclusion. Use ' +
  'two blocks in a `:::mdv-grid{cols=1}` sharing `syncX:`, small multiples via ' +
  '`row:`/`column:`, or index both measures to a common base with ' +
  '`transform: [{derive: {idx: "value / first(value) * 100"}}]`.';

/**
 * Attribute spellings that ask for a second value axis.
 *
 * Listed rather than pattern-matched so the diagnostic can name the exact key
 * the author wrote, and so a legitimate `x-y2` extension attribute (SPEC 15.1)
 * is untouched.
 */
const SECOND_AXIS_KEYS: readonly string[] = Object.freeze([
  'y2',
  'yRight',
  'y_right',
  'secondaryAxis',
  'secondary_axis',
  'rightAxis',
  'right_axis',
  'dualAxis',
  'dual_axis',
]);

/** Keys inside `axis:` that ask for a second value axis. */
const SECOND_AXIS_SUBKEYS: readonly string[] = Object.freeze(['y2', 'right', 'secondary']);

/**
 * Report any author request for a second value axis (SPEC 7.3.1).
 *
 * Reported as `MDV1501` — the attribute is unknown and is ignored — but promoted
 * to `warning`, because a spec-level MUST NOT that renders differently from what
 * the author wrote has to be visible in `mdv lint --max-severity warning`, not
 * buried in `info`.
 *
 * @returns the keys that were rejected, in the order they were found
 */
export function detectSecondAxisRequest(attrs: BlockAttrs, reporter: Reporter): string[] {
  const rejected: string[] = [];
  const record = attrs as Record<string, unknown>;

  for (const key of SECOND_AXIS_KEYS) {
    if (record[key] === undefined) continue;
    rejected.push(key);
    reporter.emit('MDV1501', {
      message: `\`${key}\` is not an MDV attribute: there is no second value axis`,
      detail: ONE_AXIS_DETAIL,
      severity: 'warning',
    });
  }

  const axis = attrs.axis as Record<string, unknown> | undefined;
  if (axis !== undefined && axis !== null && typeof axis === 'object') {
    for (const key of SECOND_AXIS_SUBKEYS) {
      if (axis[key] === undefined) continue;
      // `axis: {y: {position: right}}` is legal — one axis, drawn on the right.
      // `axis: {right: …}` is a second axis, and is not.
      rejected.push(`axis.${key}`);
      reporter.emit('MDV1501', {
        message: `\`axis.${key}\` is not an MDV attribute: there is no second value axis`,
        detail: `${ONE_AXIS_DETAIL} To move the single value axis to the right edge, write \`axis: {y: {position: right}}\`.`,
        severity: 'warning',
      });
    }
  }

  return rejected;
}

/**
 * Enforce the one-axis rule over a chart type's axis models.
 *
 * At most one **independent** scale per dimension. Two models on the same
 * dimension are allowed only when they carry the *same scale instance* — a
 * mirrored ladder on both edges of a wide plot is one axis drawn twice, and it
 * cannot mislead because both ladders say the same thing.
 *
 * Rejected models are dropped, not silently redrawn onto the surviving scale:
 * painting series B against series A's axis would be a quieter lie than the one
 * the rule forbids.
 *
 * @returns the surviving models, in input order
 */
export function enforceOneAxisRule(axes: readonly AxisModel[], reporter: Reporter): AxisModel[] {
  const kept: AxisModel[] = [];
  const scaleByDimension = new Map<AxisDimension, Scale>();

  for (const axis of axes) {
    const dimension = axisDimension(axis.position);
    const existing = scaleByDimension.get(dimension);
    if (existing === undefined) {
      scaleByDimension.set(dimension, axis.scale);
      kept.push(axis);
      continue;
    }
    if (existing === axis.scale) {
      // Same scale, second edge: a mirrored ladder. Legal.
      kept.push(axis);
      continue;
    }
    reporter.emit('MDV1501', {
      message: `Second independent ${dimension === 'vertical' ? 'y' : 'x'}-axis on \`${axis.position}\` dropped`,
      detail: ONE_AXIS_DETAIL,
      severity: 'warning',
    });
  }

  return kept;
}

/**
 * `true` when two axes would form a dual-axis chart.
 *
 * Exposed for chart types and for the validator, which can reject the
 * construction before encode runs and produce a `CodeFix` for the LSP.
 */
export function isDualAxis(axes: readonly AxisModel[]): boolean {
  const byDimension = new Map<AxisDimension, Scale>();
  for (const axis of axes) {
    const dimension = axisDimension(axis.position);
    const existing = byDimension.get(dimension);
    if (existing !== undefined && existing !== axis.scale) return true;
    byDimension.set(dimension, axis.scale);
  }
  return false;
}

/**
 * Collect the one-axis diagnostics for a block without wiring a sink.
 *
 * Used by `validate`, which returns diagnostics rather than emitting them, so
 * the LSP can underline `y2:` before anything is drawn.
 */
export function oneAxisDiagnostics(
  block: ResolvedBlock,
  source: DiagnosticSource = 'encode',
): Diagnostic[] {
  const collected: Diagnostic[] = [];
  const reporter = createReporter((d) => collected.push(d), block.range, source, block.id);
  detectSecondAxisRequest(block.attrs, reporter);
  return collected;
}

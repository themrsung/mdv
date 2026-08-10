/**
 * One entry point from an author's {@link ScaleSpec} to a constructed
 * {@link Scale} (SPEC 7.2).
 *
 * Every chart type routes through this so that "what does `scale: {type: log}`
 * mean on a date column" has exactly one answer, and so the `zero`/`nice`/
 * `domain` precedence is applied identically everywhere.
 */

import type { DataType, Value } from '../types/data.js';
import type { Scale, ScaleInput, ScaleSpec, ScaleType } from '../types/encode.js';
import { createBandScale } from './band.js';
import { computeContinuousDomain, createContinuousScale } from './continuous.js';
import { distinctInOrder } from './ordinal.js';
import { computeTimeDomain, createTimeScale } from './time.js';

/**
 * The default scale type for a field type (SPEC 7.2, the "Applies to" column).
 *
 * `point` rather than `band` for a discrete axis is the caller's decision — a
 * line over categories wants points, a bar wants bands — so this returns `band`
 * and the caller downgrades.
 */
export function defaultScaleType(type: DataType | undefined): ScaleType {
  switch (type) {
    case 'number':
    case 'integer':
    case 'duration':
      return 'linear';
    case 'date':
    case 'datetime':
    case 'time':
      return 'time';
    case 'string':
    case 'category':
    case 'boolean':
      return 'band';
    default:
      return 'linear';
  }
}

/** What {@link buildPositionalScale} needs to construct a positional scale. */
export interface PositionalScaleRequest {
  /** The author's request, after the cascade. */
  spec?: ScaleSpec | undefined;
  /** The bound field's inferred type; selects the default scale type. */
  fieldType?: DataType | undefined;
  /** Every value the channel binds, including rows a filter would remove. */
  values: readonly Value[];
  /** `[start, end]` in scene units. */
  range: readonly [number, number];
  /** Force `point` instead of `band` for a discrete domain (lines, scatter). */
  discrete?: 'band' | 'point';
  /** Include zero unless the author says otherwise (bar, area). */
  zeroDefault?: boolean;
  /** Field or channel format, used for tick labels. */
  format?: string | undefined;
  /** @defaultValue 'en-US' */
  locale?: string;
  /** @defaultValue 'UTC' */
  timezone?: string;
  /** Tick-count hint. @defaultValue 5 */
  tickCount?: number;
  /**
   * Called once per row dropped because a log scale cannot represent it
   * (`MDV3020`). Reported, never silent.
   */
  onNonPositive?: (value: number) => void;
}

/**
 * Build the scale for a positional channel.
 *
 * @returns a frozen scale. Never throws: an impossible request (a log scale over
 * a category column) degrades to the sensible scale for the data rather than
 * failing the block, because a document always renders (SPEC 14.1).
 */
export function buildPositionalScale(request: PositionalScaleRequest): Scale {
  const locale = request.locale ?? 'en-US';
  const timezone = request.timezone ?? 'UTC';
  const tickCount = request.tickCount ?? 5;
  const spec = request.spec;
  const requested = spec?.type ?? defaultScaleType(request.fieldType);
  const reverse = spec?.reverse === true;
  const range: [number, number] = [request.range[0], request.range[1]];

  const kind = normaliseType(requested, request);

  if (kind === 'band' || kind === 'point') {
    const domain =
      spec?.domain !== undefined && spec.domain.length > 0
        ? spec.domain.filter((v): v is string | number | Date => v !== null).map(keyOf)
        : distinctInOrder(request.values.map(scalarOf));
    const options = {
      domain,
      range,
      reverse,
      point: kind === 'point',
      ...(spec?.padding !== undefined ? { paddingInner: spec.padding } : {}),
    };
    return createBandScale(options) as unknown as Scale;
  }

  if (kind === 'time') {
    const dates: (Date | number | null)[] = [];
    for (const value of request.values) {
      if (value instanceof Date) dates.push(value);
      else if (typeof value === 'number' && Number.isFinite(value)) dates.push(value);
    }
    const domain = computeTimeDomain(dates, {
      ...(spec?.nice !== undefined ? { nice: spec.nice } : {}),
      ...(spec?.domain !== undefined
        ? {
            explicit: spec.domain.map((v) =>
              v instanceof Date || typeof v === 'number' ? v : null,
            ),
          }
        : {}),
      tickCount,
      timezone,
    });
    return createTimeScale({
      domain,
      range,
      reverse,
      timezone,
      tickCount,
      ...(spec?.clamp !== undefined ? { clamp: spec.clamp } : {}),
      ...(request.format !== undefined ? { format: request.format } : {}),
    }) as unknown as Scale;
  }

  // Continuous.
  const positive = kind === 'log';
  const numbers: number[] = [];
  for (const value of request.values) {
    const n = numberOf(value);
    if (n === undefined) continue;
    if (positive && n <= 0) {
      request.onNonPositive?.(n);
      continue;
    }
    numbers.push(n);
  }
  const domain = computeContinuousDomain(numbers, {
    zero: spec?.zero ?? request.zeroDefault ?? false,
    ...(spec?.nice !== undefined ? { nice: spec.nice } : {}),
    ...(spec?.domain !== undefined
      ? { explicit: spec.domain.map((v) => (typeof v === 'number' ? v : null)) }
      : {}),
    tickCount,
    positive,
  });

  return createContinuousScale({
    type: kind,
    domain,
    range,
    reverse,
    locale,
    tickCount,
    ...(spec?.base !== undefined ? { base: spec.base } : {}),
    ...(spec?.exponent !== undefined ? { exponent: spec.exponent } : {}),
    ...(spec?.constant !== undefined ? { constant: spec.constant } : {}),
    ...(spec?.clamp !== undefined ? { clamp: spec.clamp } : {}),
    ...(request.format !== undefined ? { format: request.format } : {}),
  }) as unknown as Scale;
}

/**
 * Reconcile the requested scale type with what the data can actually support.
 *
 * A `linear` request over a string column is not an error the author can act on
 * mid-render; it is a mismatch that validation reports (`MDV3001`) and that
 * layout survives by using the scale the data needs.
 */
function normaliseType(
  requested: ScaleType,
  request: PositionalScaleRequest,
): 'linear' | 'log' | 'sqrt' | 'pow' | 'symlog' | 'time' | 'band' | 'point' {
  const discreteData =
    request.fieldType === 'string' ||
    request.fieldType === 'category' ||
    request.fieldType === 'boolean';
  const temporalData =
    request.fieldType === 'date' ||
    request.fieldType === 'datetime' ||
    request.fieldType === 'time';

  switch (requested) {
    case 'band':
    case 'point':
      return request.discrete ?? requested;
    case 'ordinal':
    case 'quantize':
    case 'quantile':
    case 'threshold':
      // Not positional scales. Fall back to what the data is.
      return discreteData ? (request.discrete ?? 'band') : temporalData ? 'time' : 'linear';
    case 'time':
      return discreteData ? (request.discrete ?? 'band') : 'time';
    case 'log':
    case 'sqrt':
    case 'pow':
    case 'symlog':
    case 'linear':
    default:
      if (discreteData) return request.discrete ?? 'band';
      if (temporalData) return 'time';
      return requested;
  }
}

/** A cell as a scale input, or `null`. */
function scalarOf(value: Value): ScaleInput | null {
  if (value === null) return null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return value;
}

/** A cell as a band key. Dates use ISO so two equal instants share a band. */
function keyOf(value: ScaleInput): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** A cell as a finite number, or `undefined`. */
function numberOf(value: Value): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return undefined;
}

/**
 * Place a non-numeric-range scale into a {@link ScaleBundle}.
 *
 * `ScaleBundle` is typed `Scale<ScaleInput, number>` (see `types/encode.ts`), so
 * a colour scale — whose range is `ColorString` — cannot be assigned directly.
 * The cast lives here, in one named place, rather than being sprinkled through
 * every chart type.
 *
 * CONTRACT: `packages/core/src/types/encode.ts`, `ScaleBundle` — widening it to
 * `Scale<ScaleInput, unknown>` would remove the need for this.
 */
export function asBundleScale<D extends ScaleInput, R>(scale: Scale<D, R>): Scale {
  return scale as unknown as Scale;
}

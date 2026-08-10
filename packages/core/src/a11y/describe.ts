/**
 * Generated accessible descriptions (SPEC 12.2).
 *
 * > When absent, the reader MUST generate one from the encoding and the data —
 * > chart type, series count, domain extent, and the notable extreme:
 * >
 * > "Bar chart. Revenue by quarter, 4 categories. Values range from 1,240 in Q1
 * > to 1,893 in Q4. Highest: Q4."
 *
 * A chart type may override this with `describe()`, and should: it knows that a
 * candlestick's story is the close, not the high. What is here is the fallback,
 * and it is a real one — it reads the marks, finds the extremes, and names them.
 * A screen-reader user gets the shape of the data, not "chart".
 *
 * Everything is marked `descGenerated: true` so an authoring tool can prompt for
 * a better one. When even this cannot produce a sentence, the caller emits
 * `MDV3091`.
 */

import type { Mark, ScaleInput, SeriesDescriptor } from '../types/encode.js';
import { formatNumber, formatValue } from '../scale/format.js';

/** A value and the key it sits at, extracted from a mark. */
export interface MarkSample {
  key: ScaleInput | undefined;
  value: number;
  seriesId: string;
}

/**
 * Reduce any built-in mark to the one number a description should talk about.
 *
 * Deliberately opinionated per mark kind: a box plot's number is its median, an
 * OHLC bar's is its close. Marks that carry no measure — a rule, an annotation —
 * contribute nothing rather than a zero.
 */
export function sampleMark(mark: Mark): MarkSample[] {
  switch (mark.mark) {
    case 'bar':
      return [{ key: mark.x, value: mark.y1, seriesId: mark.seriesId }];
    case 'line-point':
      return mark.y === null ? [] : [{ key: mark.x, value: mark.y, seriesId: mark.seriesId }];
    case 'line':
      return mark.points
        .filter((point) => point.y !== null)
        .map((point) => ({ key: point.x, value: point.y as number, seriesId: mark.seriesId }));
    case 'point':
      return [{ key: mark.x, value: mark.y, seriesId: mark.seriesId }];
    case 'arc':
      return [{ key: mark.category, value: mark.value, seriesId: mark.seriesId }];
    case 'cell':
      return mark.value === null
        ? []
        : [{ key: mark.x, value: mark.value, seriesId: mark.seriesId }];
    case 'ohlc':
      return [{ key: mark.x, value: mark.close, seriesId: mark.seriesId }];
    case 'box':
      return [{ key: mark.x, value: mark.median, seriesId: mark.seriesId }];
    case 'node':
      return [{ key: mark.key, value: mark.value, seriesId: mark.seriesId }];
    case 'link':
      return [
        { key: `${mark.source} → ${mark.target}`, value: mark.value, seriesId: mark.seriesId },
      ];
    case 'rule':
    case 'text':
    default:
      return [];
  }
}

/** Options for {@link generateDescription}. */
export interface DescriptionOptions {
  /** Block type token, e.g. `'bar'`. */
  blockType: string;
  marks: readonly Mark[];
  series: readonly SeriesDescriptor[];
  /** Title of the measure channel, e.g. `Revenue`. */
  valueTitle?: string | undefined;
  /** Title of the key channel, e.g. `Quarter`. */
  keyTitle?: string | undefined;
  /** Format for values, so the description matches the axis. */
  valueFormat?: string | undefined;
  /** Format for keys. */
  keyFormat?: string | undefined;
  locale: string;
  timezone: string;
}

/**
 * Generate a description.
 *
 * @returns a sentence, or `''` when there is nothing truthful to say — which the
 * caller turns into `MDV3091` rather than into a description that claims the
 * chart is empty when it merely could not be read.
 */
export function generateDescription(options: DescriptionOptions): string {
  const samples: MarkSample[] = [];
  for (const mark of options.marks) samples.push(...sampleMark(mark));

  const kind = `${capitalise(options.blockType)} chart.`;
  const ctx = { locale: options.locale, timezone: options.timezone };

  if (samples.length === 0) {
    // No measurable marks. Still say what the block is and how much data it has,
    // which is more use than silence.
    if (options.series.length === 0) return '';
    return `${kind} ${countPhrase(options.series.length, 'series')}.`;
  }

  const parts: string[] = [kind];

  // "Revenue by quarter, 4 categories." — the subject line.
  const subject = subjectPhrase(options, samples);
  if (subject !== '') parts.push(subject);

  let min = samples[0] as MarkSample;
  let max = samples[0] as MarkSample;
  for (const sample of samples) {
    if (sample.value < min.value) min = sample;
    if (sample.value > max.value) max = sample;
  }

  const minValue = formatNumber(min.value, options.valueFormat, options.locale);
  const maxValue = formatNumber(max.value, options.valueFormat, options.locale);
  const minKey = keyText(min.key, options.keyFormat, ctx);
  const maxKey = keyText(max.key, options.keyFormat, ctx);

  if (min.value === max.value) {
    parts.push(`All values are ${maxValue}.`);
  } else if (minKey !== '' && maxKey !== '') {
    parts.push(`Values range from ${minValue} in ${minKey} to ${maxValue} in ${maxKey}.`);
    parts.push(`Highest: ${maxKey}.`);
  } else {
    parts.push(`Values range from ${minValue} to ${maxValue}.`);
  }

  return parts.join(' ');
}

/** The "Revenue by quarter, 4 categories" clause. */
function subjectPhrase(options: DescriptionOptions, samples: readonly MarkSample[]): string {
  const measure = options.valueTitle;
  const key = options.keyTitle;
  const distinctKeys = new Set<string>();
  for (const sample of samples) {
    if (sample.key !== undefined) distinctKeys.add(String(sample.key));
  }

  const clauses: string[] = [];
  if (measure !== undefined && measure !== '' && key !== undefined && key !== '') {
    clauses.push(`${measure} by ${lowerFirst(key)}`);
  } else if (measure !== undefined && measure !== '') {
    clauses.push(measure);
  } else if (key !== undefined && key !== '') {
    clauses.push(`by ${lowerFirst(key)}`);
  }

  if (distinctKeys.size > 0) clauses.push(countPhrase(distinctKeys.size, 'category', 'categories'));
  const realSeries = options.series.filter((s) => s.isOther !== true);
  if (realSeries.length > 1) clauses.push(countPhrase(realSeries.length, 'series', 'series'));

  return clauses.length === 0 ? '' : `${clauses.join(', ')}.`;
}

/** `4 categories`, `1 series`. */
function countPhrase(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function keyText(
  key: ScaleInput | undefined,
  format: string | undefined,
  ctx: { locale: string; timezone: string },
): string {
  if (key === undefined) return '';
  return formatValue(key, format, ctx);
}

function capitalise(text: string): string {
  if (text === '') return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function lowerFirst(text: string): string {
  if (text === '') return '';
  // Only lower an initial capital that starts a normal word; an acronym stays.
  if (text.length > 1 && text.slice(0, 2) === text.slice(0, 2).toUpperCase()) return text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

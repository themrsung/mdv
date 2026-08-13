/**
 * Typed readers over {@link BlockAttrs}' per-type attribute bag (SPEC 8.1).
 *
 * Core models the common attributes; everything a single type owns (`stack`,
 * `curve`, `innerRadius`, …) arrives through the index signature as `unknown`.
 * These readers are the only place that `unknown` is narrowed, and every one of
 * them is **total**: a value of the wrong shape falls back to the documented
 * default rather than throwing, because a bad attribute must never take out a
 * block (SPEC 14.1, SPEC 15.2 "unknown enum value → default, `MDV1502`").
 */

import type { BlockAttrs, ColorString } from '@mdv/core';
import { isFiniteNumber } from './num.js';

/** Read a per-type attribute as `unknown`, or `undefined` when absent. */
export function rawAttr(attrs: BlockAttrs, name: string): unknown {
  const value = (attrs as Readonly<Record<string, unknown>>)[name];
  return value === null ? undefined : value;
}

/** Read a boolean attribute. Accepts the strings `"true"`/`"false"`. */
export function boolAttr(attrs: BlockAttrs, name: string, fallback: boolean): boolean {
  const value = rawAttr(attrs, name);
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
}

/** Read a numeric attribute, optionally clamped into `[min, max]`. */
export function numberAttr(
  attrs: BlockAttrs,
  name: string,
  fallback: number,
  min?: number,
  max?: number,
): number {
  const value = rawAttr(attrs, name);
  let numeric: number | undefined;
  if (isFiniteNumber(value)) numeric = value;
  else if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) numeric = parsed;
  }
  if (numeric === undefined) return fallback;
  if (min !== undefined && numeric < min) return min;
  if (max !== undefined && numeric > max) return max;
  return numeric;
}

/**
 * Read a numeric attribute that may also be the literal `"auto"`.
 *
 * @returns `undefined` for `auto` or an unusable value — the caller then derives
 * the number from the layout, which is what `auto` means.
 */
export function autoNumberAttr(
  attrs: BlockAttrs,
  name: string,
  min?: number,
  max?: number,
): number | undefined {
  const value = rawAttr(attrs, name);
  if (value === undefined || value === 'auto') return undefined;
  const numeric = numberAttr(attrs, name, Number.NaN, min, max);
  return Number.isFinite(numeric) ? numeric : undefined;
}

/** Read a string attribute. */
export function stringAttr(attrs: BlockAttrs, name: string): string | undefined {
  const value = rawAttr(attrs, name);
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a color attribute, falling back to a status role (SPEC 11.3.1).
 *
 * The cast is the honest one: `ColorString` is a branded string and an author's
 * `up-color: rebeccapurple` is a string like any other. Nothing here validates
 * the color — an unparseable one lands in the SVG and the browser drops it,
 * which is the same degradation the rest of the paint path takes.
 */
export function colorAttr(attrs: BlockAttrs, name: string, fallback: ColorString): ColorString {
  const value = stringAttr(attrs, name);
  return value === undefined ? fallback : (value as ColorString);
}

/**
 * Read an enum attribute, folding an unrecognised spelling to the default.
 *
 * @param onUnknown - invoked with the offending text so the caller can emit
 * `MDV1502`; the value still degrades to `fallback` (SPEC 15.2).
 */
export function enumAttr<T extends string>(
  attrs: BlockAttrs,
  name: string,
  allowed: readonly T[],
  fallback: T,
  onUnknown?: (text: string) => void,
): T {
  const value = rawAttr(attrs, name);
  if (value === undefined) return fallback;
  if (typeof value === 'string') {
    for (const candidate of allowed) if (candidate === value) return candidate;
    onUnknown?.(value);
    return fallback;
  }
  onUnknown?.(String(value));
  return fallback;
}

/**
 * Read an attribute that is either a boolean or a string (`label: true`,
 * `label: end`, `label: revenue`).
 */
export function boolOrStringAttr(
  attrs: BlockAttrs,
  name: string,
): { kind: 'bool'; value: boolean } | { kind: 'string'; value: string } | undefined {
  const value = rawAttr(attrs, name);
  if (typeof value === 'boolean') return { kind: 'bool', value };
  if (value === 'true') return { kind: 'bool', value: true };
  if (value === 'false') return { kind: 'bool', value: false };
  if (typeof value === 'string') return { kind: 'string', value };
  return undefined;
}

/** Read a list attribute, accepting a single value as a one-element list. */
export function listAttr(attrs: BlockAttrs, name: string): readonly unknown[] {
  const value = rawAttr(attrs, name);
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Coerce one attribute element to a finite number, or `undefined`. */
export function numberOf(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : undefined;
  }
  return undefined;
}

/**
 * Read a `[min, max]` attribute; `undefined` when absent or not a usable pair.
 *
 * An inverted or degenerate pair is *not* usable: `domain: [10, 10]` cannot say
 * what the middle of the ramp means, and honouring `[10, 0]` would silently
 * flip the reader's sense of which end is "more" (SPEC 15.2 — fall back to the
 * data extent rather than draw a lie).
 */
export function extentAttr(attrs: BlockAttrs, name: string): [number, number] | undefined {
  const list = listAttr(attrs, name);
  if (list.length !== 2) return undefined;
  const lo = numberOf(list[0]);
  const hi = numberOf(list[1]);
  if (lo === undefined || hi === undefined || !(lo < hi)) return undefined;
  return [lo, hi];
}

/** Read an object-valued attribute. Arrays are rejected: they are not records. */
export function recordAttr(
  attrs: BlockAttrs,
  name: string,
): Readonly<Record<string, unknown>> | undefined {
  const value = rawAttr(attrs, name);
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    value instanceof Date
  ) {
    return undefined;
  }
  return value as Readonly<Record<string, unknown>>;
}

/**
 * Read a dimension that may be a fraction of a reference length: `0.6`, `"60%"`
 * or `"96"` (SPEC 8.5 `innerRadius`).
 *
 * A bare number ≤ 1 is a fraction; a larger one is absolute pixels.
 */
export function fractionOrPxAttr(
  attrs: BlockAttrs,
  name: string,
  reference: number,
  fallbackFraction: number,
): number {
  const value = rawAttr(attrs, name);
  const ref = isFiniteNumber(reference) && reference > 0 ? reference : 0;
  if (typeof value === 'string' && value.trim().endsWith('%')) {
    const percent = Number(value.trim().slice(0, -1));
    if (Number.isFinite(percent)) return (percent / 100) * ref;
  }
  const numeric = numberAttr(attrs, name, Number.NaN);
  if (Number.isFinite(numeric)) {
    return numeric <= 1 && numeric >= 0 ? numeric * ref : numeric;
  }
  return fallbackFraction * ref;
}

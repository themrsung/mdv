/**
 * Channel normalisation (SPEC 7.1.1, 7.1.2).
 *
 * Two author-facing shapes collapse into one internal shape here:
 *
 * - **shorthand** — `y: revenue` is exactly `y: {field: revenue}` (SPEC 7.1.2);
 * - **wide form** — `y: [revenue, profit]` is one series per field, which is
 *   equivalent to a long-form table with a `series` column (SPEC 7.1.1).
 *
 * Everything downstream sees long form with an explicit series list, so no chart
 * type has to handle both. Both remain first-class to the *author*; only the
 * reader normalises.
 */

import type { Channel, ChannelName, Encoding } from '../types/encode.js';

/** Every binding on a channel, in author order. Absent channels give `[]`. */
export function channelList(encoding: Encoding, name: ChannelName): Channel[] {
  const raw = encoding[name];
  if (raw === undefined) return [];
  return Array.isArray(raw) ? [...raw] : [raw];
}

/** The first binding on a channel, or `undefined`. */
export function firstChannel(encoding: Encoding, name: ChannelName): Channel | undefined {
  const list = channelList(encoding, name);
  return list[0];
}

/** The field a channel binds, or `undefined` when it carries a constant. */
export function channelField(encoding: Encoding, name: ChannelName): string | undefined {
  const channel = firstChannel(encoding, name);
  return channel?.field;
}

/** `true` when a channel is bound to more than one field (wide form). */
export function isWideForm(encoding: Encoding, name: ChannelName = 'y'): boolean {
  return channelList(encoding, name).filter((c) => c.field !== undefined).length > 1;
}

/**
 * `true` when the author asked for both a list-valued `y` and a `series` field.
 *
 * Mutually exclusive per SPEC 7.1: the two describe the same split twice, and
 * there is no defensible way to merge them. Reported as `MDV3010`.
 */
export function hasFormConflict(encoding: Encoding): boolean {
  return isWideForm(encoding, 'y') && channelField(encoding, 'series') !== undefined;
}

/** The shape an encoding is written in (SPEC 7.1.1). */
export type EncodingForm = 'wide' | 'long' | 'single';

/** Classify an encoding. `single` is one measure with no series split. */
export function encodingForm(encoding: Encoding, valueChannel: ChannelName = 'y'): EncodingForm {
  if (isWideForm(encoding, valueChannel)) return 'wide';
  if (channelField(encoding, 'series') !== undefined) return 'long';
  return 'single';
}

/**
 * Normalise an encoding: collapse single bindings to arrays of one, drop empty
 * bindings, and copy nothing else.
 *
 * The result is a **new** object; the author's encoding on the resolved block is
 * shared with the AST and must never be mutated.
 */
export function normalizeEncoding(encoding: Encoding): Readonly<Record<string, Channel[]>> {
  const out: Record<string, Channel[]> = {};
  // Object key order is the author's order, preserved by the parser; iterating it
  // directly is the insertion order SPEC 24.3 rule 5 requires.
  for (const key of Object.keys(encoding)) {
    const name = key as ChannelName;
    const list = channelList(encoding, name).filter(
      (channel) => channel.field !== undefined || channel.value !== undefined,
    );
    if (list.length > 0) out[key] = list;
  }
  return out;
}

/**
 * The channel title an axis or a legend should show.
 *
 * `title: false` suppresses it; an explicit string wins; otherwise the caller
 * humanises the field name. Returning `undefined` means "no explicit request",
 * which is different from `false`, which means "suppress".
 */
export function channelTitle(channel: Channel | undefined): string | false | undefined {
  if (channel === undefined) return undefined;
  if (channel.title === false) return false;
  if (typeof channel.title === 'string' && channel.title !== '') return channel.title;
  return undefined;
}

/** Fields named by `tooltip: [a, b]` (SPEC 7.5), in author order. */
export function tooltipFields(encoding: Encoding): string[] {
  return channelList(encoding, 'tooltip')
    .map((channel) => channel.field)
    .filter((field): field is string => field !== undefined);
}

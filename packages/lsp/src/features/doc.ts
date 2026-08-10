/**
 * What a word means (SPEC 29.4).
 *
 * Once a feature knows where the cursor is, everything it has to say comes from
 * one of two places, and this file is the pair of doors:
 *
 * - a **channel** is described by the chart type that declares it, which is the
 *   only thing that knows `x` takes a category on a bar and a number on a line;
 * - every **common attribute** is described by `@mdv/spec`, which publishes
 *   Appendix D — prose, type, default and one example per key — as values.
 *
 * Neither door opens onto a list written here. A plugin that ships a channel
 * documents it, and a key the schema grows is documented the day it lands.
 */

import type { ChannelSpec, ChartType } from '@mdv/core';

/** The two facet keys take a column name like a channel does (SPEC 11). */
export const FACET_CHANNELS: readonly string[] = ['row', 'column'];

/** `bar` reads as `mark · level 1`; an alias is worth saying out loud. */
export function detailOf(type: ChartType): string {
  const aliases = type.aliases ?? [];
  const also = aliases.length === 0 ? '' : ` · also ${aliases.join(', ')}`;
  return `${type.family} · level ${type.level}${also}`;
}

/** The channel this key binds, when the block's type declares one by that name. */
export function channelOf(key: string, chartType: ChartType | undefined): ChannelSpec | undefined {
  return chartType?.channels.find((channel) => channel.name === key);
}

/**
 * Whether the value of `key` is a column name.
 *
 * A facet key is one without being a channel of the type: `row` and `column`
 * are core's, not any chart's, so they are true even for a block whose type is
 * misspelled and therefore unknown.
 */
export function isChannel(key: string, chartType: ChartType | undefined): boolean {
  if (FACET_CHANNELS.includes(key)) return true;
  return channelOf(key, chartType) !== undefined;
}

/** What a channel will take, as one line: `category | date`. */
export function acceptsOf(channel: ChannelSpec): string {
  return channel.accepts.join(' | ');
}

/**
 * The same line, plus the three facts a channel carries beyond its type:
 * `category | date · required · list · constant`. The words are the spec's own
 * ({@link ChannelSpec}), so an author who has read SPEC 5.5 recognises them and
 * one who has not is no worse off than with a sentence this file made up.
 */
export function channelDetail(channel: ChannelSpec): string {
  const facts = [acceptsOf(channel)];
  if (channel.required) facts.push('required');
  if (channel.list === true) facts.push('list');
  if (channel.constant === true) facts.push('constant');
  return facts.join(' · ');
}

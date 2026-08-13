/**
 * The attribute cascade (SPEC 5.5) and the split into `BlockAttrs` + `Encoding`.
 *
 * ```text
 * 1 built-in defaults for the block type
 * 2 active theme
 * 3 document `defaults:` in front matter
 * 4 reader/embedder configuration
 * 5 block info-string attributes   ┐ already merged by the parser, header winning
 * 6 block header attributes        ┘
 * ```
 *
 * > Merging is **deep for mappings, replacing for sequences and scalars**.
 *
 * Levels 5 and 6 arrive pre-merged on `MdvBlock.attrs` (the parser does that,
 * because only it can see the info string). Level 2 contributes nothing here:
 * every themed value the layout needs is read from `LayoutContext.theme`
 * directly rather than being copied into the attribute map, which is what keeps
 * one theme switch from invalidating every block's attribute hash.
 *
 * This module belongs in `@mdv/core`'s facade — see the note in
 * `packages/core/src/resolve.ts`, "the facade composes the three". The facade is
 * still a stub, so the React binding carries it locally.
 */

import type { AttrMap, AttrValue } from '@mdv/parser';
import type { BlockAttrs, Channel, ChannelName, Encoding } from '@mdv/core';

/**
 * Every channel name in SPEC 7.1, in the order the spec lists them.
 *
 * A `Set` rather than an array: the split below asks "is this key a channel?"
 * once per attribute per block.
 */
const CHANNEL_NAMES: ReadonlySet<string> = new Set<ChannelName>([
  'x',
  'y',
  'series',
  'color',
  'size',
  'shape',
  'label',
  'value',
  'category',
  'group',
  'detail',
  'tooltip',
  'row',
  'column',
]);

/*
 * A channel is **lifted** into `encoding`, never **moved** there: the key stays
 * on `attrs` as well. That is what `@mdv/core` does — `cascadeAttrs` returns the
 * whole merged map and `encodingFromAttrs` copies the channel keys out of it —
 * and the two have to agree, because the same block resolved by the two paths
 * must produce the same diagnostics.
 *
 * Several readers depend on the attribute surviving:
 *
 * - `metric` reads a literal `value: 1284000` off `attrs` (SPEC 8.13); as a
 *   channel it is `{value: 1284000}` with no `field`, which is not a binding,
 *   so moving it would make every literal stat tile fail `MDV3000`.
 * - `row`/`column` drive faceting, which `layoutBlock` reads off `attrs`
 *   (SPEC 7.6) while a chart type may read the channel.
 * - `tooltip` is `boolean | string[]` as an attribute (SPEC 8.1) and a field list
 *   as a channel (SPEC 7.5). `tooltip: false` is only ever the attribute.
 */

/** Keys that are structurally a mapping and therefore merge deeply. */
function isMapping(value: unknown): value is AttrMap {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/**
 * Merge `over` onto `under`: deep for mappings, replacing for everything else.
 *
 * Key order follows `under` first, then keys `over` introduces — so a document
 * `defaults:` cannot reorder a block's own attributes, which would change the
 * attribute hash without changing the meaning.
 */
export function mergeAttrs(under: AttrMap, over: AttrMap): AttrMap {
  const out: AttrMap = {};
  for (const key of Object.keys(under)) {
    const u = under[key];
    if (u !== undefined) out[key] = u;
  }
  for (const key of Object.keys(over)) {
    const next = over[key];
    if (next === undefined) continue;
    const prev = out[key];
    out[key] = isMapping(prev) && isMapping(next) ? mergeAttrs(prev, next) : next;
  }
  return out;
}

/** Merge a whole chain, lowest precedence first. */
export function cascade(...layers: readonly (AttrMap | undefined)[]): AttrMap {
  let out: AttrMap = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    out = mergeAttrs(out, layer);
  }
  return out;
}

/**
 * Built-in defaults, cascade level 1 (SPEC 5.5, 8.1).
 *
 * Only the two the host needs before layout runs. Everything else defaults
 * inside `layoutBlock`, where the block type can have an opinion — duplicating
 * those here would give two places to change and one of them would rot.
 */
export const BUILTIN_DEFAULTS: AttrMap = Object.freeze({
  width: '100%',
  height: 300,
});

/** One channel binding, from any of the shorthand forms of SPEC 7.1.2. */
function toChannel(value: AttrValue): Channel | undefined {
  if (value === null || value === undefined) return undefined;
  // `y: revenue` is exactly `y: {field: revenue}`.
  if (typeof value === 'string') return value === '' ? undefined : { field: value };
  // A bare number or boolean can only be a constant: there is no field named `3`.
  if (typeof value === 'number' || typeof value === 'boolean') return { value };
  if (Array.isArray(value)) return undefined; // handled by the caller
  if (!isMapping(value)) return undefined;

  const channel: Record<string, unknown> = {};
  // Copy in the source's own key order so the hash is stable, and only the keys
  // `Channel` declares — an unknown key belongs to the chart type's schema, not
  // to the shared channel model.
  for (const key of Object.keys(value)) {
    if (
      key === 'field' ||
      key === 'value' ||
      key === 'title' ||
      key === 'format' ||
      key === 'aggregate' ||
      key === 'scale' ||
      key === 'axis' ||
      key === 'type'
    ) {
      channel[key] = value[key];
    }
  }
  return Object.keys(channel).length === 0 ? undefined : (channel as Channel);
}

/** A channel that may be a list (`y: [a, b]` — wide form, SPEC 7.1.1). */
function toChannels(value: AttrValue): Channel | Channel[] | undefined {
  if (Array.isArray(value)) {
    const list: Channel[] = [];
    for (const item of value) {
      const channel = toChannel(item);
      if (channel !== undefined) list.push(channel);
    }
    return list.length === 0 ? undefined : list;
  }
  return toChannel(value);
}

/** The result of splitting a cascaded attribute map. */
export interface SplitAttrs {
  attrs: BlockAttrs;
  encoding: Encoding;
}

/**
 * Split a cascaded attribute map into block attributes and channel bindings.
 *
 * Unknown keys stay on `attrs`: `BlockAttrs` has an index signature precisely so
 * a chart type's own attributes (`stack`, `barWidth`, `bins`) survive to
 * validation, and `x-*` extensions are collected separately and never
 * interpreted (SPEC 15.1). Channel keys stay on `attrs` too — see the note above
 * `CHANNEL_NAMES`: the split lifts them into `encoding`, it does not move them.
 */
export function splitAttrs(merged: AttrMap): SplitAttrs {
  const attrs: Record<string, unknown> = {};
  const encoding: Record<string, Channel | Channel[]> = {};
  const extensions: Record<string, AttrValue> = {};
  let sawExtension = false;

  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value === undefined) continue;

    if (key.startsWith('x-')) {
      extensions[key] = value;
      sawExtension = true;
      continue;
    }

    if (CHANNEL_NAMES.has(key)) {
      // `tooltip: false` / `tooltip: true` is the attribute, never a channel.
      const channelForm =
        key === 'tooltip' && typeof value === 'boolean' ? undefined : toChannels(value);
      if (channelForm !== undefined) encoding[key] = channelForm;
    }

    attrs[key] = value;
  }

  if (sawExtension) attrs['extensions'] = extensions;
  return { attrs: attrs as BlockAttrs, encoding: encoding as Encoding };
}

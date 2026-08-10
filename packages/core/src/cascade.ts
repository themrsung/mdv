/**
 * The attribute cascade (SPEC 5.5) and encoding normalisation (SPEC 7.1).
 *
 * SPEC 18 stage 2 assembles a `ResolvedBlock` from a parsed block: cascade the
 * attributes, lift the channel attributes into an {@link Encoding}, attach the
 * prepared table and the theme. This module is the first two of those four, and
 * `resolve()` in `index.ts` is its only caller in this package.
 *
 * **Provenance.** This code was written in `apps/vscode/src/pipeline/cascade.ts`
 * while `resolve()` was a stub, with a header that said so and promised the
 * module would be deleted "when `@mdv/core`'s `resolve()` lands". It has landed.
 * The file moved here verbatim rather than being rewritten, and the extension's
 * copy is now a re-export of this one, so the preview and the library cannot
 * disagree about what a cascade is. Its tests (`apps/vscode/test/cascade.test.ts`)
 * still pass unchanged, which is the point of moving rather than reimplementing.
 */

import type { AttrMap, AttrValue, MdvBlock } from '@mdv/parser';
import type { BlockAttrs } from './types/attrs.js';
import type { Channel, ChannelName, Encoding } from './types/encode.js';

/**
 * Every channel name of SPEC 7.1, in the order the spec lists them.
 *
 * A frozen array rather than a `Set` literal so iteration order is fixed: the
 * `Encoding` we build has its keys in this order, and SPEC 24.3 rule 5 makes
 * object key order load-bearing downstream (series identity is first-appearance
 * order).
 */
export const CHANNEL_NAMES: readonly ChannelName[] = Object.freeze([
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

const CHANNEL_SET: ReadonlySet<string> = new Set<string>(CHANNEL_NAMES);

/** `true` for a plain object (an `AttrMap`), `false` for arrays and scalars. */
function isMap(value: unknown): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * SPEC 5.5: "deep for mappings, replacing for sequences and scalars".
 *
 * `over` wins. A sequence in `over` replaces a sequence in `under` wholesale —
 * `y: [a, b]` does not merge element-wise with an inherited `y`.
 */
export function mergeAttrs(under: AttrMap, over: AttrMap): AttrMap {
  const out: AttrMap = {};
  // `under`'s keys first, in source order, so an inherited key keeps its
  // position and a new key is appended — deterministic for two runs.
  for (const key of Object.keys(under)) {
    const value = under[key];
    if (value !== undefined) out[key] = value;
  }
  for (const key of Object.keys(over)) {
    const next = over[key];
    if (next === undefined) continue;
    const prev = out[key];
    out[key] = isMap(prev) && isMap(next) ? mergeAttrs(prev, next) : next;
  }
  return out;
}

/**
 * Run the cascade for one block (SPEC 5.5), lowest precedence first.
 *
 * | # | Source | Supplied by |
 * |---|---|---|
 * | 1 | built-in defaults for the block type | `ChartType.defaults` |
 * | 2 | active theme | not an attribute source — the theme is a separate input to layout |
 * | 3 | document `defaults:` | front matter |
 * | 4 | reader configuration | {@link CascadeInput.configDefaults} |
 * | 5 | block info-string attributes | already merged into `block.attrs` by the parser… |
 * | 6 | block header attributes | …with the header winning, per SPEC 5.5 |
 *
 * Levels 5 and 6 arrive pre-merged: `MdvBlock.attrs` is documented as
 * "header attributes ∪ info-string attributes, header winning", so re-deriving
 * them here would only risk disagreeing with the parser.
 */
export interface CascadeInput {
  /** Cascade level 1. */
  readonly typeDefaults?: Partial<BlockAttrs> | undefined;
  /** Cascade level 3. */
  readonly documentDefaults?: AttrMap | undefined;
  /** Cascade level 4 — the embedder's house style. */
  readonly configDefaults?: AttrMap | undefined;
}

export function cascadeAttrs(block: MdvBlock, input: CascadeInput): BlockAttrs {
  let merged: AttrMap = {};
  if (input.typeDefaults !== undefined) {
    merged = mergeAttrs(merged, input.typeDefaults as AttrMap);
  }
  if (input.documentDefaults !== undefined) merged = mergeAttrs(merged, input.documentDefaults);
  if (input.configDefaults !== undefined) merged = mergeAttrs(merged, input.configDefaults);
  merged = mergeAttrs(merged, block.attrs);
  // `BlockAttrs` carries an index signature for per-type attributes, so an
  // `AttrMap` satisfies it structurally; the declared members are validated
  // downstream against the type's JSON Schema, not here.
  return merged as BlockAttrs;
}

/**
 * Turn one attribute value into a {@link Channel} (SPEC 7.1.2).
 *
 * Three author spellings collapse to one shape:
 * - `y: revenue` → `{ field: 'revenue' }`
 * - `color: "#f00"` → `{ value: '#f00' }` when the string is not a column
 * - `y: { field: revenue, title: "USD" }` → passed through, `field` coerced
 *
 * A bare string is a **field reference** unless the table has no such column and
 * the string looks like a constant; that ambiguity is SPEC 7.1.2's, and the
 * tie-break here is the table's own column list, which is the only evidence
 * available at this stage.
 */
function toChannel(value: AttrValue, columns: ReadonlySet<string>): Channel | undefined {
  if (value === null || value === undefined) return undefined;

  if (typeof value === 'string') {
    if (value.length === 0) return undefined;
    return columns.has(value) ? { field: value } : { value };
  }
  if (typeof value === 'number' || typeof value === 'boolean') return { value };

  if (isMap(value)) {
    const channel: { -readonly [K in keyof Channel]: Channel[K] } = {};
    const field = value['field'];
    if (typeof field === 'string' && field.length > 0) channel.field = field;
    const constant = value['value'];
    if (typeof constant === 'string' || typeof constant === 'number' || typeof constant === 'boolean') {
      channel.value = constant;
    }
    const title = value['title'];
    if (title === false || typeof title === 'string') channel.title = title;
    const aggregate = value['aggregate'];
    if (typeof aggregate === 'string') {
      channel.aggregate = aggregate as NonNullable<Channel['aggregate']>;
    }
    const scale = value['scale'];
    if (isMap(scale)) channel.scale = scale as unknown as NonNullable<Channel['scale']>;
    else if (typeof scale === 'string') {
      channel.scale = { type: scale } as unknown as NonNullable<Channel['scale']>;
    }
    const axis = value['axis'];
    if (axis === false) channel.axis = false;
    else if (isMap(axis)) channel.axis = axis as unknown as NonNullable<Channel['axis']>;
    // No `field` and no `value` is not a binding at all (SPEC 7.1.2); dropping it
    // here keeps `normalizeEncoding` from having to filter twice.
    if (channel.field === undefined && channel.value === undefined) return undefined;
    return channel;
  }
  return undefined;
}

/**
 * Lift the channel attributes out of a cascaded attribute map (SPEC 7.1).
 *
 * A list value produces a list of channels — wide form, one series per field
 * (SPEC 7.1.1). The result's key order follows {@link CHANNEL_NAMES}, not the
 * author's, because a stable channel order is what makes two runs produce the
 * same series identities.
 *
 * @param columns - the prepared table's column names, used to tell a field
 * reference from a constant
 */
export function encodingFromAttrs(
  attrs: BlockAttrs,
  columns: ReadonlySet<string>,
  typeDefaults?: Encoding,
): Encoding {
  const encoding: { -readonly [K in ChannelName]?: Channel | Channel[] } = {};

  for (const name of CHANNEL_NAMES) {
    const raw = (attrs as Record<string, unknown>)[name] as AttrValue | undefined;
    if (raw === undefined) continue;

    if (Array.isArray(raw)) {
      const list: Channel[] = [];
      for (const item of raw) {
        const channel = toChannel(item, columns);
        if (channel !== undefined) list.push(channel);
      }
      if (list.length > 0) encoding[name] = list;
      continue;
    }
    const channel = toChannel(raw, columns);
    if (channel !== undefined) encoding[name] = channel;
  }

  if (typeDefaults === undefined) return encoding;

  // Cascade level 1 for the encoding: the type's defaults go *under* the
  // author's, never over (registry.ts, `ChartType.defaultEncoding`). Iterate
  // CHANNEL_NAMES again rather than Object.keys(typeDefaults) so the merged
  // result keeps one canonical key order regardless of how the type spelled it.
  const withDefaults: { -readonly [K in ChannelName]?: Channel | Channel[] } = {};
  for (const name of CHANNEL_NAMES) {
    const authored = encoding[name];
    if (authored !== undefined) {
      withDefaults[name] = authored;
      continue;
    }
    const fallback = typeDefaults[name];
    if (fallback !== undefined) withDefaults[name] = fallback;
  }
  return withDefaults;
}

/** `true` when `key` names a channel rather than an ordinary attribute. */
export function isChannelName(key: string): key is ChannelName {
  return CHANNEL_SET.has(key);
}

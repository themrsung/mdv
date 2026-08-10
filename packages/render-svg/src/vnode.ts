/**
 * The intermediate form every SVG output path shares.
 *
 * `toSvgString`, `toSvgElement` and `toReactElements` all build one of these and
 * then walk it. That is not indirection for its own sake: three independent
 * emitters would be three chances to disagree about attribute order, about
 * escaping, or about whether a `defs` block is present — and only one of the
 * three (the string) is covered by golden files. One builder means the DOM path
 * is byte-for-byte the same drawing as the snapshot that was reviewed.
 *
 * Attributes are an **ordered array**, not an object. Object key order is an
 * engine detail this implementation is forbidden from depending on
 * (SPEC 24.3 rule 5), and the string serialiser needs a fixed order to be
 * byte-stable at all (SPEC 23.1).
 */

/** One attribute, already stringified and ready to escape. */
export type VAttr = readonly [name: string, value: string];

/** An element node. `children` and `text` are mutually exclusive in practice. */
export interface VNode {
  readonly tag: string;
  readonly attrs: readonly VAttr[];
  readonly children: readonly VNode[];
  /** Literal text content, for `<title>`, `<desc>` and `<text>`. */
  readonly text?: string;
}

/** Build a {@link VNode}, dropping attributes whose value is `undefined`. */
export function el(
  tag: string,
  attrs: readonly (readonly [string, string | undefined])[],
  children: readonly VNode[] = [],
  text?: string,
): VNode {
  const kept: VAttr[] = [];
  for (const [name, value] of attrs) {
    if (value === undefined) continue;
    kept.push([name, value]);
  }
  return text === undefined ? { tag, attrs: kept, children } : { tag, attrs: kept, children, text };
}

/** Count the nodes in a tree, for diagnostics and tests. */
export function countNodes(node: VNode): number {
  let n = 1;
  for (const child of node.children) n += countNodes(child);
  return n;
}

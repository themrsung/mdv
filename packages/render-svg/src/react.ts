/**
 * {@link VNode} → React elements (SPEC 22.3).
 *
 * The DOM is React-owned in the React binding, so charts must be ordinary JSX
 * that reconciles normally. React is **not** imported here: `@mdv/render-svg` is
 * universal and must not pull React into a Node or CLI bundle (SPEC 17.2), so the
 * host passes its own `createElement`.
 *
 * Two translations are needed, and both are React's, not SVG's:
 *
 * - **Prop names are camelCased.** React accepts `stroke-width` on SVG elements
 *   in modern versions, but it warns on some and normalises others; the camelCase
 *   spelling is the one that is stable across React 18 and 19.
 * - **Keys are positional.** The virtual tree is built deterministically from the
 *   scene, so index `i` at a given depth always denotes the same drawing element
 *   across renders — which is the condition under which positional keys are
 *   correct rather than a bug.
 */

import { assertAllowedAttribute } from './allowlist.js';
import type { VNode } from './vnode.js';

/** Attributes React spells differently from SVG. */
const SPECIAL_PROPS: Readonly<Record<string, string>> = Object.freeze({
  class: 'className',
  'xml:lang': 'xmlLang',
  'xml:space': 'xmlSpace',
  tabindex: 'tabIndex',
});

/** Prefixes React passes through verbatim. */
function isPassThrough(name: string): boolean {
  return name.startsWith('aria-') || name.startsWith('data-');
}

/** `stroke-width` → `strokeWidth`. */
function camelise(name: string): string {
  return name.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
}

/** Translate one attribute name to its React prop name. */
export function reactPropName(name: string): string {
  const special = SPECIAL_PROPS[name];
  if (special !== undefined) return special;
  if (isPassThrough(name)) return name;
  // `viewBox`, `preserveAspectRatio`, `gradientUnits` etc. are already camelCase
  // and contain no hyphen, so this is a no-op for them.
  return camelise(name);
}

/** The host's element factory — React's `createElement`, structurally. */
export type CreateElement = (
  type: string,
  props: Record<string, unknown>,
  ...children: unknown[]
) => unknown;

/** Convert a virtual node and its subtree to host elements. */
export function toHostElements(node: VNode, createElement: CreateElement, key?: string): unknown {
  const props: Record<string, unknown> = {};
  for (const [name, value] of node.attrs) {
    assertAllowedAttribute(name);
    props[reactPropName(name)] = value;
  }
  if (key !== undefined) props['key'] = key;

  const children: unknown[] = [];
  // Text content becomes a child string, which React inserts as a text node —
  // never `dangerouslySetInnerHTML`, so there is no markup path at all (SPEC 13.3).
  if (node.text !== undefined && node.text.length > 0) children.push(node.text);
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i];
    if (child === undefined) continue;
    children.push(toHostElements(child, createElement, `${child.tag}-${i}`));
  }

  return createElement(node.tag, props, ...children);
}

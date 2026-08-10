/**
 * {@link VNode} → SVG string (SPEC 23.1, 23.3).
 *
 * > The string serialiser is deterministic: attribute order fixed, numbers
 * > rounded to 3 decimals with `-0` normalised to `0`, no whitespace between
 * > elements.
 *
 * No whitespace between elements is not cosmetic. Whitespace inside `<text>` is
 * significant in SVG, so a pretty-printer that indents children changes the
 * rendering; and any inserted newline is a byte a golden file has to agree on.
 */

import { assertAllowedAttribute } from './allowlist.js';
import { escapeXml } from './format.js';
import type { VNode } from './vnode.js';

/**
 * Elements that must be written as `<x></x>` rather than `<x/>`.
 *
 * `<title>` and `<desc>` are here because a self-closing form of an element that
 * holds text confuses some XML-to-HTML adapters into swallowing the next
 * sibling. Everything else self-closes when empty, which is smaller.
 */
const NEVER_SELF_CLOSE = new Set(['svg', 'g', 'title', 'desc', 'defs', 'text', 'clipPath', 'pattern']);

function serialiseInto(node: VNode, out: string[]): void {
  out.push('<', node.tag);
  for (const [name, value] of node.attrs) {
    assertAllowedAttribute(name);
    out.push(' ', name, '="', escapeXml(value), '"');
  }

  const hasText = node.text !== undefined && node.text.length > 0;
  const hasChildren = node.children.length > 0;

  if (!hasText && !hasChildren && !NEVER_SELF_CLOSE.has(node.tag)) {
    out.push('/>');
    return;
  }

  out.push('>');
  if (hasText) out.push(escapeXml(node.text ?? ''));
  for (const child of node.children) serialiseInto(child, out);
  out.push('</', node.tag, '>');
}

/** Serialise one node and its subtree. */
export function serialiseVNode(node: VNode): string {
  const out: string[] = [];
  serialiseInto(node, out);
  return out.join('');
}

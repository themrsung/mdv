/**
 * {@link VNode} → real DOM, plus an in-place patcher.
 *
 * Two properties matter here and neither is obvious:
 *
 * **The owning `Document` is injected.** Reading a global `document` would make
 * this module useless in jsdom-with-multiple-documents, in a worker holding a
 * synthetic document, and in a VS Code webview — all three of which SPEC 29.3
 * and SPEC 22.3 require.
 *
 * **`update` patches rather than replaces.** A `ResizeObserver` fires on every
 * frame of a drag (SPEC 22.3); rebuilding the tree each time would drop keyboard
 * focus and clear the user's text selection on every pixel. So the patcher walks
 * the old DOM against the new virtual tree and only touches what differs,
 * falling back to replacement when the shapes diverge.
 */

import { assertAllowedAttribute } from './allowlist.js';
import type { VNode } from './vnode.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const XML_NS = 'http://www.w3.org/XML/1998/namespace';

/** Attribute names that live in the XML namespace rather than in no namespace. */
function namespaceFor(name: string): string | null {
  return name.startsWith('xml:') ? XML_NS : null;
}

function setAttribute(element: Element, name: string, value: string): void {
  assertAllowedAttribute(name);
  const ns = namespaceFor(name);
  if (ns === null) element.setAttribute(name, value);
  else element.setAttributeNS(ns, name, value);
}

/** Materialise a virtual tree as SVG DOM in `doc`. */
export function createElementTree(node: VNode, doc: Document): Element {
  const element = doc.createElementNS(SVG_NS, node.tag);
  for (const [name, value] of node.attrs) setAttribute(element, name, value);
  if (node.text !== undefined && node.text.length > 0) {
    // `createTextNode`, never `innerHTML` (SPEC 13.3). Document-derived strings
    // reach the DOM as text and only as text.
    element.appendChild(doc.createTextNode(node.text));
  }
  for (const child of node.children) element.appendChild(createElementTree(child, doc));
  return element;
}

/**
 * Patch `element` to match `next`, in place, returning the element that now
 * represents `next`.
 *
 * When the tags differ the subtree is replaced wholesale — a `rect` cannot become
 * a `path` by attribute surgery, and pretending otherwise produces an element in
 * an invalid state. When they match, attributes are reconciled (added, updated,
 * removed) and children recurse; surplus children are dropped and missing ones
 * appended.
 */
export function patchElementTree(element: Element, next: VNode, doc: Document): Element {
  if (element.tagName !== next.tag && element.localName !== next.tag) {
    const replacement = createElementTree(next, doc);
    element.replaceWith(replacement);
    return replacement;
  }

  const wanted = new Set<string>();
  for (const [name, value] of next.attrs) {
    wanted.add(name);
    const ns = namespaceFor(name);
    const current =
      ns === null ? element.getAttribute(name) : element.getAttributeNS(ns, name.slice(4));
    if (current !== value) setAttribute(element, name, value);
  }
  // Remove attributes the new tree no longer wants. Snapshot the list first:
  // `attributes` is live, and removing while iterating skips entries.
  for (const name of Array.from(element.getAttributeNames())) {
    if (!wanted.has(name)) element.removeAttribute(name);
  }

  const nextText = next.text ?? '';
  if (nextText.length > 0) {
    const first = element.firstChild;
    if (first !== null && first.nodeType === 3 /* TEXT_NODE */) {
      if (first.nodeValue !== nextText) first.nodeValue = nextText;
    } else {
      element.insertBefore(doc.createTextNode(nextText), element.firstChild);
    }
  }

  // Element children only: a leading text node is handled above and must not be
  // consumed by the child walk.
  const existing: Element[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === 1 /* ELEMENT_NODE */) existing.push(child as Element);
    else if (nextText.length === 0 && child.nodeType === 3) element.removeChild(child);
  }

  for (let i = 0; i < next.children.length; i += 1) {
    const child = next.children[i];
    if (child === undefined) continue;
    const old = existing[i];
    if (old === undefined) element.appendChild(createElementTree(child, doc));
    else patchElementTree(old, child, doc);
  }
  for (let i = next.children.length; i < existing.length; i += 1) {
    existing[i]?.remove();
  }

  return element;
}

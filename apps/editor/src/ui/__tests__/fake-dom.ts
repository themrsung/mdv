/**
 * A fake DOM, for the modules that map between the browser and the engine.
 *
 * No jsdom. The mapping code takes the narrow structural types in
 * `../dom/contract.ts` precisely so it can be driven by something this small,
 * and a fake keeps the tests honest about what the production code is allowed
 * to touch: if a change here starts needing `querySelector` or `Range`, that is
 * the signal that a pure function has grown a dependency on a real browser.
 *
 * The tree is mutable while it is built and frozen in shape afterwards; parents
 * are wired up by {@link element} so `parentNode` walks work.
 */

import type { ElementLike, NodeLike, TextLike } from '../dom/contract.js';

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export interface FakeText extends TextLike {
  readonly nodeType: 3;
  data: string;
  parentNode: NodeLike | null;
  readonly childNodes: readonly NodeLike[];
}

export interface FakeElement extends ElementLike {
  readonly nodeType: 1;
  readonly tag: string;
  readonly attributes: Record<string, string>;
  parentNode: NodeLike | null;
  readonly childNodes: NodeLike[];
  getAttribute(name: string): string | null;
}

/** A text node. */
export function text(data: string): FakeText {
  return { nodeType: TEXT_NODE, data, parentNode: null, childNodes: [] };
}

/** An element, with its children adopted. */
export function element(
  tag: string,
  attributes: Readonly<Record<string, string>> = {},
  children: readonly NodeLike[] = [],
): FakeElement {
  const node: FakeElement = {
    nodeType: ELEMENT_NODE,
    tag,
    attributes: { ...attributes },
    parentNode: null,
    childNodes: [...children],
    getAttribute(name: string): string | null {
      return Object.prototype.hasOwnProperty.call(this.attributes, name)
        ? (this.attributes[name] ?? null)
        : null;
    },
  };
  for (const child of node.childNodes) {
    (child as { parentNode: NodeLike | null }).parentNode = node;
  }
  return node;
}

/**
 * One editable container, rendered the way `../blocks/Editable.tsx` renders it:
 * a tagged host, one wrapper per run, one text node inside each.
 */
export function container(
  blockId: string,
  path: readonly number[],
  runs: readonly string[],
  options: { readonly tag?: string } = {},
): FakeElement {
  const children: NodeLike[] = runs.map((run, index) =>
    element('span', { 'data-mdv-run': String(index) }, [text(run)]),
  );
  if (runs.length === 0 || runs.join('') === '') {
    children.push(element('br', { 'data-mdv-filler': 'true' }));
  }
  return element(
    options.tag ?? 'p',
    { 'data-mdv-container': blockId, 'data-mdv-path': path.join(',') },
    children,
  );
}

/** A block wrapper around one or more containers. */
export function block(blockId: string, children: readonly NodeLike[]): FakeElement {
  return element('div', { 'data-mdv-block': blockId }, children);
}

/** The first text node beneath `node`, for pointing a fake selection at one. */
export function firstText(node: NodeLike): FakeText {
  if (node.nodeType === TEXT_NODE) return node as FakeText;
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    if (child !== undefined) {
      const found = maybeText(child);
      if (found !== null) return found;
    }
  }
  throw new Error('no text node in subtree');
}

function maybeText(node: NodeLike): FakeText | null {
  if (node.nodeType === TEXT_NODE) return node as FakeText;
  for (let index = 0; index < node.childNodes.length; index += 1) {
    const child = node.childNodes[index];
    if (child !== undefined) {
      const found = maybeText(child);
      if (found !== null) return found;
    }
  }
  return null;
}

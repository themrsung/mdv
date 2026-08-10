/**
 * The DOM contract between the React block views and the selection mapper.
 *
 * There is exactly one rule and everything else follows from it:
 *
 * > **A container element's text content, read in document order, is
 * > character-for-character the engine container's text.**
 *
 * Not "the same runs" and not "the same elements" — the same *characters*. That
 * is the weakest invariant that still lets a caret round-trip, and it is the
 * only one that survives an IME: while the user is composing, the browser
 * rewrites the subtree however it likes, and we can still say where the caret
 * is because the character count is all we ever needed.
 *
 * Concretely:
 *
 * - The editable host for an inline container carries
 *   {@link CONTAINER_ATTR} (its block id) and {@link PATH_ATTR} (the container
 *   path, `''` for a paragraph/heading/code block and `'r,c'` for a table cell).
 * - Every run inside it is wrapped in one element carrying {@link RUN_ATTR}.
 *   Marks nest *inside* that wrapper, so the run index is always on the
 *   outermost element and there is exactly one text node at the bottom.
 * - Nothing else inside a container may contribute text. Decorations are
 *   `::before`/`::after` or an absolutely-positioned sibling outside the host.
 *
 * The run wrappers are a convenience for styling and for placing the caret
 * quickly; the mapper never *requires* them to line up with the engine's runs,
 * because it works in absolute character offsets.
 */

/** Marks the outer wrapper of a block. Value is the block id. */
export const BLOCK_ATTR = 'data-mdv-block';

/** Marks the block kind on the wrapper, for styling and hit-testing. */
export const KIND_ATTR = 'data-mdv-kind';

/** Marks an editable inline container. Value is the owning block's id. */
export const CONTAINER_ATTR = 'data-mdv-container';

/** Container path within the block: `''`, or `'row,col'` for a table cell. */
export const PATH_ATTR = 'data-mdv-path';

/** Marks one run wrapper. Value is the run's index within its container. */
export const RUN_ATTR = 'data-mdv-run';

/** Marks a decorative node that carries no document text (a trailing `<br>`). */
export const FILLER_ATTR = 'data-mdv-filler';

/** Encode a container path for {@link PATH_ATTR}. */
export function encodePath(path: readonly number[]): string {
  return path.join(',');
}

/**
 * Decode a {@link PATH_ATTR} value.
 *
 * Takes `null` and `undefined` as well as a string, because that is what
 * `getAttribute` returns and a missing attribute means the same thing as an
 * empty one: the container is the block itself, at path `[]`. A malformed value
 * decodes the same way rather than throwing — the mapper's job is to return
 * "not an edit position", never to break the render that is reading it.
 */
export function decodePath(value: string | null | undefined): readonly number[] {
  if (value === null || value === undefined || value === '') return [];
  const out: number[] = [];
  for (const part of value.split(',')) {
    const parsed = Number.parseInt(part, 10);
    if (!Number.isFinite(parsed)) return [];
    out.push(parsed);
  }
  return out;
}

/** What a container element says about itself. */
export interface ContainerDescriptor {
  readonly blockId: string;
  readonly path: readonly number[];
}

/* -------------------------------------------------------------------------- */
/* Structural helpers                                                          */
/* -------------------------------------------------------------------------- */

/*
 * These take the narrowest structural types they can rather than `Node` and
 * `Element`, so the unit tests can drive them with a 100-line fake tree instead
 * of a DOM implementation the repo is not allowed to install. Real DOM nodes
 * satisfy them structurally.
 */

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** The subset of `Node` the mapper reads. */
export interface NodeLike {
  readonly nodeType: number;
  readonly parentNode: NodeLike | null;
  readonly childNodes: ArrayLike<NodeLike>;
}

/** The subset of `Element` the mapper reads. */
export interface ElementLike extends NodeLike {
  getAttribute(name: string): string | null;
}

/** The subset of `Text` the mapper reads. */
export interface TextLike extends NodeLike {
  readonly data: string;
}

/** True when `node` is an element node. */
export function isElement(node: NodeLike | null | undefined): node is ElementLike {
  return node != null && node.nodeType === ELEMENT_NODE;
}

/** True when `node` is a text node. */
export function isText(node: NodeLike | null | undefined): node is TextLike {
  return node != null && node.nodeType === TEXT_NODE;
}

/** Children as a plain array, so `noUncheckedIndexedAccess` stays cheap. */
export function childrenOf(node: NodeLike): readonly NodeLike[] {
  const list = node.childNodes;
  const out: NodeLike[] = [];
  for (let index = 0; index < list.length; index += 1) {
    const child = list[index];
    if (child != null) out.push(child);
  }
  return out;
}

/** Nearest self-or-ancestor element carrying `attribute`, or `null`. */
export function closestWithAttribute(
  node: NodeLike | null | undefined,
  attribute: string,
): ElementLike | null {
  let current: NodeLike | null | undefined = node;
  while (current != null) {
    if (isElement(current) && current.getAttribute(attribute) !== null) return current;
    current = current.parentNode;
  }
  return null;
}

/** Nearest self-or-ancestor editable container element, or `null`. */
export function closestContainer(node: NodeLike | null | undefined): ElementLike | null {
  return closestWithAttribute(node, CONTAINER_ATTR);
}

/** Nearest self-or-ancestor block wrapper, or `null`. */
export function closestBlock(node: NodeLike | null | undefined): ElementLike | null {
  return closestWithAttribute(node, BLOCK_ATTR);
}

/** Read a container element's identity, or `null` if it is not one. */
export function describeContainer(element: ElementLike): ContainerDescriptor | null {
  const blockId = element.getAttribute(CONTAINER_ATTR);
  if (blockId === null) return null;
  return { blockId, path: decodePath(element.getAttribute(PATH_ATTR) ?? '') };
}

/** True when `ancestor` contains `node` (or is it). */
export function contains(ancestor: NodeLike, node: NodeLike | null | undefined): boolean {
  let current: NodeLike | null | undefined = node;
  while (current != null) {
    if (current === ancestor) return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * Depth-first search for the first descendant satisfying `predicate`.
 *
 * Deliberately not `querySelector`: keeping the search here means the mapper
 * needs only `childNodes` and `getAttribute` from its host, which is what makes
 * it testable without a DOM.
 */
export function findDescendant(
  root: NodeLike,
  predicate: (element: ElementLike) => boolean,
): ElementLike | null {
  for (const child of childrenOf(root)) {
    if (isElement(child) && predicate(child)) return child;
    const nested = findDescendant(child, predicate);
    if (nested !== null) return nested;
  }
  return null;
}

/** Locate the editable host for `(blockId, path)` beneath `root`. */
export function findContainerElement(
  root: NodeLike,
  blockId: string,
  path: readonly number[],
): ElementLike | null {
  const wanted = encodePath(path);
  if (isElement(root) && root.getAttribute(CONTAINER_ATTR) === blockId) {
    if ((root.getAttribute(PATH_ATTR) ?? '') === wanted) return root;
  }
  return findDescendant(
    root,
    (element) =>
      element.getAttribute(CONTAINER_ATTR) === blockId &&
      (element.getAttribute(PATH_ATTR) ?? '') === wanted,
  );
}

/** Locate the wrapper for `blockId` beneath `root`. */
export function findBlockElement(root: NodeLike, blockId: string): ElementLike | null {
  if (isElement(root) && root.getAttribute(BLOCK_ATTR) === blockId) return root;
  return findDescendant(root, (element) => element.getAttribute(BLOCK_ATTR) === blockId);
}

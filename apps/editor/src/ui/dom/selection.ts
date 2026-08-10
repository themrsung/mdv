/**
 * The bridge between the browser's selection and the engine's.
 *
 * The editing surface is a forest of small `contenteditable` containers, each
 * tagged by `../blocks/Editable.tsx` with the block id and container path it
 * renders. That tagging is what makes the mapping total in both directions:
 *
 * ```text
 *   DOM (element, childIndex) or (textNode, codeUnit)
 *     → nearest [data-mdv-container] ancestor → blockId + path
 *     → offsetInContainer()                   → absolute offset in the container
 *     → engine fromAbsolute()                 → Point { blockId, path, offset }
 * ```
 *
 * and back the other way through `positionAtOffset`. Neither direction guesses:
 * if a DOM position is not inside a tagged container the mapping returns `null`
 * and the caller leaves the engine selection alone, which is the correct
 * response to a click on the toolbar or in a dialog, and to the transient
 * positions the browser reports while React is mid-commit.
 *
 * {@link domSelectionMatches} exists to break the feedback loop. Writing the
 * engine selection into the DOM makes the browser fire `selectionchange`, which
 * would map back and dispatch another selection, forever. Rather than a flag
 * with a timing assumption, both selections are reduced to *container offsets*
 * and compared: if the DOM already says what the engine says, nothing happens.
 * This is self-correcting and has no window in which an event can slip through.
 * It also absorbs the many DOM spellings of one caret — `(textNode, 3)` and
 * `(runWrapper, 1)` can be the same place — which a node-identity comparison
 * would report as a difference and resync forever.
 */

import type { MdvDocument, Point, Selection } from '../../engine/index.js';
import { containerPath, fromAbsolute, resolveContainer, toAbsolute } from '../../engine/index.js';
import type { ElementLike, NodeLike } from './contract.js';
import { closestContainer, describeContainer, findContainerElement } from './contract.js';
import type { DomPosition } from './offsets.js';
import { offsetInContainer, positionAtOffset } from './offsets.js';

/** A DOM selection reduced to the four fields this module needs. */
export interface DomSelectionLike {
  readonly anchorNode: NodeLike | null;
  readonly anchorOffset: number;
  readonly focusNode: NodeLike | null;
  readonly focusOffset: number;
}

/** Where a selection should be placed in the DOM. */
export interface DomTarget {
  readonly anchor: DomPosition;
  readonly focus: DomPosition;
}

/**
 * Map a DOM position to an engine point.
 *
 * Returns `null` when the position is outside every container, or inside one
 * the document no longer has — both mean "not an edit position".
 */
export function pointFromDom(
  doc: MdvDocument,
  node: NodeLike | null,
  offset: number,
): Point | null {
  if (node === null) return null;
  const host = closestContainer(node);
  if (host === null) return null;

  const descriptor = describeContainer(host);
  if (descriptor === null) return null;

  // `path` addresses the container; a `Point` addresses a run inside it, so the
  // probe borrows run 0 and `fromAbsolute` returns the real run index.
  const probe: Point = { blockId: descriptor.blockId, path: [...descriptor.path, 0], offset: 0 };
  const container = resolveContainer(doc, probe);
  if (container === undefined) return null;

  return fromAbsolute(container, offsetInContainer(host, node, offset));
}

/**
 * Map an engine point to a DOM position beneath `root`.
 *
 * Returns `null` when the point does not resolve, or when the container it
 * names has not been rendered — normal during the commit in which a block is
 * created, and harmless because the layout effect runs again on the next
 * revision.
 */
export function pointToDom(root: NodeLike, doc: MdvDocument, at: Point): DomPosition | null {
  const container = resolveContainer(doc, at);
  if (container === undefined) return null;
  const element = findContainerElement(root, at.blockId, containerPath(at));
  if (element === null) return null;
  return positionAtOffset(element, toAbsolute(container, at));
}

/**
 * Read the browser's selection as an engine selection.
 *
 * Only text selections are produced: a `node` or `cells` selection has no
 * faithful DOM spelling, so those are driven by the engine alone and this
 * returns `null` rather than clobbering them. A missing focus end collapses to
 * the anchor, which is what the browser reports mid-drag on some platforms.
 */
export function readDomSelection(doc: MdvDocument, selection: DomSelectionLike): Selection | null {
  const anchor = pointFromDom(doc, selection.anchorNode, selection.anchorOffset);
  if (anchor === null) return null;
  const focus = pointFromDom(doc, selection.focusNode, selection.focusOffset) ?? anchor;
  return { kind: 'text', anchor, focus };
}

/** Where in the DOM a text selection belongs, or `null` if it cannot be placed. */
export function domTargetFor(
  root: NodeLike,
  doc: MdvDocument,
  selection: Selection,
): DomTarget | null {
  if (selection.kind !== 'text') return null;
  const anchor = pointToDom(root, doc, selection.anchor);
  if (anchor === null) return null;
  const focus =
    selection.anchor === selection.focus
      ? anchor
      : (pointToDom(root, doc, selection.focus) ?? anchor);
  return { anchor, focus };
}

/**
 * True when the browser's selection already addresses what `target` says.
 *
 * Compared in container coordinates rather than by node identity, so the
 * equivalent spellings of one caret compare equal and the sync loop terminates.
 */
export function domSelectionMatches(current: DomSelectionLike, target: DomTarget): boolean {
  return (
    samePosition(current.anchorNode, current.anchorOffset, target.anchor) &&
    samePosition(current.focusNode, current.focusOffset, target.focus)
  );
}

function samePosition(node: NodeLike | null, offset: number, wanted: DomPosition): boolean {
  if (node === null) return false;
  if (node === wanted.node && offset === wanted.offset) return true;

  const host = closestContainer(node);
  const wantedHost = closestContainer(wanted.node);
  if (host === null || wantedHost === null || host !== wantedHost) return false;

  return (
    offsetInContainer(host, node, offset) ===
    offsetInContainer(wantedHost, wanted.node, wanted.offset)
  );
}

/**
 * The container element a DOM node sits in, together with what it renders.
 *
 * Exposed for the pointer code, which needs the block id of whatever was hit
 * before it has a document to resolve it against.
 */
export function containerAt(
  node: NodeLike | null,
): { element: ElementLike; blockId: string; path: readonly number[] } | null {
  if (node === null) return null;
  const element = closestContainer(node);
  if (element === null) return null;
  const descriptor = describeContainer(element);
  if (descriptor === null) return null;
  return { element, blockId: descriptor.blockId, path: descriptor.path };
}

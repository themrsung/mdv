/**
 * Caret geometry.
 *
 * Two things the engine cannot answer because they depend on how the text was
 * laid out rather than on what it says: "which character is under this pixel?"
 * and "is the caret on the first visual line of its block?". Both are needed
 * for mouse selection and for Up/Down arrow behaviour at a block boundary.
 */

/** A DOM position under a screen point. */
export interface HitPosition {
  readonly node: Node;
  readonly offset: number;
}

interface CaretPositionResult {
  offsetNode: Node;
  offset: number;
}

interface CaretCapableDocument {
  caretPositionFromPoint?: (x: number, y: number) => CaretPositionResult | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

/**
 * The text position under `(x, y)`.
 *
 * `caretPositionFromPoint` is the standard; `caretRangeFromPoint` is WebKit's
 * older spelling and is still the only one Safari ships. Both are tried, in
 * that order, because Chromium now has the first and kept the second.
 */
export function caretFromPoint(x: number, y: number): HitPosition | null {
  const host = document as unknown as CaretCapableDocument;

  if (typeof host.caretPositionFromPoint === 'function') {
    const position = host.caretPositionFromPoint(x, y);
    if (position !== null) return { node: position.offsetNode, offset: position.offset };
  }
  if (typeof host.caretRangeFromPoint === 'function') {
    const range = host.caretRangeFromPoint(x, y);
    if (range !== null) return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

/** The bounding rectangle of a collapsed position, or `null`. */
export function rectAt(node: Node, offset: number): DOMRect | null {
  const range = document.createRange();
  try {
    range.setStart(node, offset);
    range.collapse(true);
  } catch {
    return null;
  }
  const rects = range.getClientRects();
  const first = rects.item(0);
  if (first !== null && first.height > 0) return first;

  // A collapsed range at an element boundary can have no rects of its own; fall
  // back to the element's box, which is the right answer for an empty block.
  const fallback = range.getBoundingClientRect();
  if (fallback.height > 0 || fallback.width > 0) return fallback;
  if (node instanceof Element) return node.getBoundingClientRect();
  const parent = node.parentElement;
  return parent === null ? null : parent.getBoundingClientRect();
}

/** The current caret rectangle, or `null` when there is no selection. */
export function caretRect(): DOMRect | null {
  const selection = document.getSelection();
  if (selection === null || selection.focusNode === null) return null;
  return rectAt(selection.focusNode, selection.focusOffset);
}

/** Where the caret sits vertically inside its editing host. */
export type LinePosition = 'first' | 'last' | 'both' | 'middle';

/**
 * Which visual line the caret is on within `host`.
 *
 * Compared with a half-line tolerance rather than exactly, because the caret
 * rectangle and the line box do not share a baseline: an inline `code` span
 * with a larger font makes the caret taller than the line it sits on.
 */
export function linePositionIn(host: Element, rect: DOMRect | null): LinePosition {
  if (rect === null) return 'both';
  const box = host.getBoundingClientRect();
  const tolerance = Math.max(2, rect.height * 0.5);
  const first = rect.top - box.top <= tolerance;
  const last = box.bottom - rect.bottom <= tolerance;
  if (first && last) return 'both';
  if (first) return 'first';
  if (last) return 'last';
  return 'middle';
}

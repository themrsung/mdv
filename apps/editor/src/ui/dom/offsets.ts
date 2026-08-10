/**
 * Character-offset mapping between the DOM and an inline container.
 *
 * Both directions are pure functions of the subtree, which is what makes the
 * editor's selection handling testable at all. The engine side of the
 * conversion (absolute offset ↔ `Point`) already exists as `toAbsolute` and
 * `fromAbsolute`; this module supplies the missing half.
 *
 * Text nodes are counted in UTF-16 code units, matching the engine's `offset`
 * and the DOM's own `Range` offsets. Nodes marked with `data-mdv-filler` are
 * skipped: a trailing `<br>` that gives an empty paragraph its line box is not
 * document text.
 */

import type { NodeLike, TextLike } from './contract.js';
import { childrenOf, FILLER_ATTR, isElement, isText, RUN_ATTR } from './contract.js';

/** A DOM position: a node and an offset within it. */
export interface DomPosition {
  readonly node: NodeLike;
  readonly offset: number;
}

/** True when this node and its subtree contribute no document text. */
function isFiller(node: NodeLike): boolean {
  return isElement(node) && node.getAttribute(FILLER_ATTR) !== null;
}

/** Every text node beneath `root`, in document order, skipping filler. */
export function textNodesOf(root: NodeLike): readonly TextLike[] {
  const out: TextLike[] = [];
  const visit = (node: NodeLike): void => {
    if (isFiller(node)) return;
    if (isText(node)) {
      out.push(node);
      return;
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return out;
}

/** Total document text beneath `root`. */
export function textOf(root: NodeLike): string {
  let out = '';
  for (const node of textNodesOf(root)) out += node.data;
  return out;
}

/** Length in UTF-16 code units of the document text beneath `root`. */
export function textLengthOf(root: NodeLike): number {
  let total = 0;
  for (const node of textNodesOf(root)) total += node.data.length;
  return total;
}

/**
 * The number of characters inside `root` that precede the DOM position
 * `(node, offset)`.
 *
 * Returns the full length when the position is not inside `root` at all, which
 * is the right answer for a selection that has run off the end of the container
 * and keeps `readSelection` from having to special-case it.
 */
export function offsetInContainer(root: NodeLike, node: NodeLike, offset: number): number {
  let count = 0;
  let found = false;

  const visit = (current: NodeLike): void => {
    if (found) return;

    if (current === node) {
      if (isText(current)) {
        count += clamp(offset, 0, current.data.length);
      } else {
        // An element boundary: the position sits before child index `offset`.
        const children = childrenOf(current);
        const limit = clamp(offset, 0, children.length);
        for (let index = 0; index < limit; index += 1) {
          const child = children[index];
          if (child !== undefined) count += textLengthOf(child);
        }
      }
      found = true;
      return;
    }

    if (isFiller(current)) return;
    if (isText(current)) {
      count += current.data.length;
      return;
    }
    for (const child of childrenOf(current)) {
      visit(child);
      if (found) return;
    }
  };

  visit(root);
  return found ? count : textLengthOf(root);
}

/**
 * The DOM position `offset` characters into `root`.
 *
 * At a boundary between two text nodes this prefers the *end of the earlier*
 * one, which is what every browser does natively and what keeps a caret typed
 * up against the right edge of a bold run from jumping outside it.
 *
 * A container with no text at all — an empty paragraph — has no text node to
 * point at, so the position is the first run wrapper (or the container itself)
 * at element offset 0. Both are valid `Range` endpoints.
 */
export function positionAtOffset(root: NodeLike, offset: number): DomPosition {
  const nodes = textNodesOf(root);
  if (nodes.length === 0) {
    const first = childrenOf(root).find(
      (child) => isElement(child) && child.getAttribute(RUN_ATTR) !== null,
    );
    return { node: first ?? root, offset: 0 };
  }

  const target = Math.max(0, offset);
  let accumulated = 0;
  for (const node of nodes) {
    const length = node.data.length;
    if (target <= accumulated + length) {
      return { node, offset: target - accumulated };
    }
    accumulated += length;
  }

  const last = nodes[nodes.length - 1];
  /* c8 ignore next -- `nodes` is non-empty here, so `last` cannot be undefined. */
  if (last === undefined) return { node: root, offset: 0 };
  return { node: last, offset: last.data.length };
}

/** Index of the run wrapper containing `node`, or `-1`. */
export function runIndexOf(root: NodeLike, node: NodeLike): number {
  let current: NodeLike | null = node;
  while (current !== null && current !== root.parentNode) {
    if (isElement(current)) {
      const value = current.getAttribute(RUN_ATTR);
      if (value !== null) {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : -1;
      }
    }
    current = current.parentNode;
  }
  return -1;
}

/**
 * The shortest replacement that turns `before` into `after`.
 *
 * Used to reconcile the engine with a subtree the browser rewrote behind our
 * back — the end of an IME composition, or a non-cancelable `beforeinput`. It
 * is deliberately a single splice rather than a real diff: an input method
 * commits one contiguous edit at a time, and pretending otherwise would invent
 * undo steps the user never made.
 *
 * The common prefix and suffix are trimmed to whole code points, so a splice
 * can never land between the halves of a surrogate pair and produce a lone
 * surrogate — which matters immediately for emoji and for any script outside
 * the BMP.
 */
export interface TextSplice {
  /** Offset of the first replaced code unit. */
  readonly start: number;
  /** Offset just past the last replaced code unit, in `before`'s coordinates. */
  readonly end: number;
  /** What was put there instead. */
  readonly inserted: string;
}

/** Compute the minimal splice from `before` to `after`, or `null` if equal. */
export function diffText(before: string, after: string): TextSplice | null {
  if (before === after) return null;

  const max = Math.min(before.length, after.length);
  let prefix = 0;
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix += 1;
  // Never split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(before.charCodeAt(prefix - 1))) prefix -= 1;

  let suffix = 0;
  const suffixMax = max - prefix;
  while (
    suffix < suffixMax &&
    before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix > 0 && isLowSurrogate(before.charCodeAt(before.length - suffix))) suffix -= 1;

  return {
    start: prefix,
    end: before.length - suffix,
    inserted: after.slice(prefix, after.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

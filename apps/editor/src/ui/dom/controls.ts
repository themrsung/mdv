/**
 * Chrome that lives inside the editing surface but is not the document.
 *
 * A block may render controls of its own — the code fence's language field, an
 * image's alt box and width spinner — and those controls take a caret the same
 * way the content does. Every path that answers "the browser's focus moved, so
 * the engine should follow" has to ask first whether the browser is focusing a
 * control, because for a control the answer is no: the engine's selection still
 * names the block the field belongs to, and pulling focus back into the content
 * would empty the field after a single keystroke.
 *
 * The test is by tag rather than by a marker attribute, so a block author gets
 * the behaviour by writing an ordinary `<input>` and not by remembering a rule.
 */

import type { ElementLike, NodeLike } from './contract.js';
import { CONTAINER_ATTR, isElement } from './contract.js';

/** Focusable form elements. `option` and `label` route focus to a control. */
const CONTROL_TAGS: ReadonlySet<string> = new Set([
  'BUTTON',
  'INPUT',
  'LABEL',
  'OPTION',
  'SELECT',
  'TEXTAREA',
]);

/** The subset of `Element` this module reads beyond {@link ElementLike}. */
interface TagNamed extends ElementLike {
  readonly tagName?: unknown;
}

/** An element's tag name, upper-cased as the DOM reports it, or `null`. */
function tagOf(node: NodeLike | null | undefined): string | null {
  if (!isElement(node)) return null;
  const tag = (node as TagNamed).tagName;
  return typeof tag === 'string' ? tag.toUpperCase() : null;
}

/**
 * True when `node` is, or sits inside, a form control.
 *
 * The walk stops at the nearest editable container: a control cannot contain
 * document content, so anything found above one belongs to the chrome around
 * the block rather than to the caret the engine is tracking.
 */
export function isControl(node: NodeLike | null | undefined): boolean {
  let current: NodeLike | null | undefined = node;
  while (current != null) {
    if (isElement(current) && current.getAttribute(CONTAINER_ATTR) !== null) {
      return false;
    }
    const tag = tagOf(current);
    if (tag !== null && CONTROL_TAGS.has(tag)) return true;
    current = current.parentNode;
  }
  return false;
}

/**
 * True when the browser's focus is on a control rather than on the document.
 *
 * Reads `activeElement` at the moment of the call, because the events that ask
 * this question — `selectionchange`, a settled `focusout`, the effect that
 * reconciles the engine's selection into the DOM — all run after focus has
 * already moved and none of them carries the element with it.
 */
export function focusIsControl(root: Document | null | undefined): boolean {
  const active = root?.activeElement;
  if (active == null) return false;
  return isControl(active as unknown as NodeLike);
}

/**
 * Where the caret goes when the link dialog closes.
 *
 * Linking is the one formatting command the writer leaves the surface to run.
 * The others are a keystroke: the selection they were applied to is still the
 * selection the writer is looking at, and keeping it is right — bold a phrase
 * and you may well want to italicise it too. A link is a round trip through a
 * dialog, and by the time it lands the writer has typed a URL, pressed Return
 * and come back to a sentence they were part-way through. Keeping the words
 * selected means the next character they type deletes them.
 *
 * So the dialog collapses. To the *end* of the linked run, because that is
 * where the sentence continues — and because the mark is non-inclusive at its
 * right edge (Bug 8 in the authoring log), a caret there types outside the
 * link, which is what the punctuation after a link wants.
 *
 * This is the caller's rule, not the command's: `toggleMark` maps the selection
 * through the edit and hands back the same range deliberately, so that marking
 * from the keyboard can go on marking.
 */

import type { MdvDocument, Selection } from '../../engine/index.js';
import { caret, isCollapsed, orderedPoints } from '../../engine/index.js';

/**
 * The selection to leave behind after a link intent applies.
 *
 * A collapsed selection is already a caret — the writer linked at a caret and
 * the mark is pending, so there is nothing to move away from. A cell selection
 * is not a text range at all and passes through untouched.
 */
export function caretAfterLink(doc: MdvDocument, selection: Selection): Selection {
  if (selection.kind !== 'text') return selection;
  if (isCollapsed(selection)) return selection;
  const [, end] = orderedPoints(doc, selection);
  return caret(end);
}

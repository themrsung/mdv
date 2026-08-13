/**
 * Keeping a caret across a trip out of the surface.
 *
 * Focus restored is not a caret restored. A `<dialog>` hands focus back to
 * whatever opened it, and an editing host that is focused while holding no
 * range of its own is given one at its very start; the `selectionchange` that
 * follows reports that as though the writer had clicked there, and the engine
 * believes it. Insert a link and the caret comes back to the top of the block
 * instead of to the words that were linked.
 *
 * The surface answers this by parking: a departure remembers that the engine's
 * selection is the real one, and the return writes it back over whatever the
 * browser supplied. This module is the rule that decides when — a switch small
 * enough to read, kept out of the component so it can be specified without a
 * browser. The restoration itself needs one and is in `__tests__/README.md`.
 */

/** What just happened to the surface's focus. */
export type FocusMove =
  /** `focusout` whose `relatedTarget` named an element outside the surface. */
  | 'left-for'
  /** `focusout` naming no successor: a real blur, or a render swapping hosts. */
  | 'left-unknown'
  /** `focusin`: the surface holds the focus again. */
  | 'returned'
  /** `pointerdown` inside the surface. */
  | 'pressed';

/**
 * Whether the engine's selection is parked after `move`.
 *
 * - `left-for` parks. Something outside the surface named itself as the next
 *   focus, so this is a real departure and there is something to come back to.
 * - `left-unknown` decides nothing. A `focusout` with no `relatedTarget` is how
 *   the browser reports a render tearing out the editing host — a paragraph
 *   becoming a heading — and treating that as a departure would park on every
 *   block-type change. The surface settles those separately, by asking after
 *   the commit whether the element that lost focus is still in the document.
 * - `returned` unparks, whether or not anything is put back: the park answers
 *   one homecoming, not every later one.
 * - `pressed` unparks. A press is the writer choosing where the caret goes, and
 *   that outranks a selection parked before they went away. Without this,
 *   clicking somewhere else in the document on the way back from the dialog
 *   would be undone by the park.
 */
export function parkedAfter(parked: boolean, move: FocusMove): boolean {
  switch (move) {
    case 'left-for':
      return true;
    case 'left-unknown':
      return parked;
    case 'returned':
    case 'pressed':
      return false;
  }
}

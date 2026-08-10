/**
 * The block-level keyboard shortcuts of SPEC 12.4.
 *
 * > - The chart container is one tab stop (`tabindex="0"`).
 * > - Arrow keys move between marks; Home/End jump to the extremes;
 * >   Page Up/Page Down move between series; Esc exits to the container.
 * > - The focused mark shows the **same readout as hover**, in a polite live
 * >   region.
 * > - **T toggles the table view when it is collapsed.**
 *
 * Mark traversal, the readout and the live region belong to
 * `@mdv/render-svg`'s `attachInteraction`: it is the module that owns the single
 * `show(region)` function through which hover *and* focus both go, which is what
 * makes "the same readout as hover" true rather than merely intended.
 *
 * What is left is the last bullet, and it cannot live there: the table view is a
 * React element in this package, and its open state is React state. So this
 * module owns exactly the shortcuts that act on the *block* rather than on the
 * marks, as a pure function of the key and the current state — no DOM, and
 * therefore testable without one.
 *
 * The handler is installed on the block surface rather than on the `<svg>`, so
 * it works for two cases the imperative layer cannot reach:
 *
 * - a chart with **no hit regions** (an empty dataset, a metric tile), where
 *   `attachInteraction` correctly declines to attach anything at all;
 * - a key pressed while focus is **inside the table view**, which is a sibling
 *   of the `<svg>` and outside its listeners.
 */

/** How a key press affects the block. */
export type BlockShortcut = 'toggle-table' | 'close-table' | 'none';

/** The parts of a keyboard event this decision depends on. */
export interface KeyDescriptor {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** The block state the decision depends on. */
export interface BlockKeyState {
  /** How the table view is presented (SPEC 12.3). */
  presentation: 'details' | 'visible' | 'hidden' | 'none';
  /** Whether the `details` disclosure is currently open. */
  tableOpen: boolean;
  /**
   * `true` when focus is in a text field, a `contenteditable`, or anything else
   * that owns its own typing. A single-letter shortcut that steals a keystroke
   * from an input is a bug, not a feature.
   */
  typing?: boolean;
}

/**
 * Decide what a key press does to the block.
 *
 * Any modifier disqualifies the key outright: <kbd>Ctrl</kbd>+<kbd>T</kbd> opens
 * a browser tab and <kbd>Cmd</kbd>+<kbd>T</kbd> does the same on macOS, and a
 * chart that swallowed either would be worse than a chart with no shortcuts.
 * <kbd>Shift</kbd> is the exception — `T` *is* shift-t on most layouts.
 */
export function classifyKey(event: KeyDescriptor, state: BlockKeyState): BlockShortcut {
  if (event.altKey || event.ctrlKey || event.metaKey) return 'none';
  if (state.typing === true) return 'none';
  // Only the collapsed presentation has anything to toggle: `visible` is always
  // shown, `hidden` is for assistive technology, and `none` has no table.
  if (state.presentation !== 'details') return 'none';

  if (event.key === 't' || event.key === 'T') return 'toggle-table';

  // "Esc exits to the container." The imperative layer drops the readout; at the
  // block level, exiting also collapses a table the reader opened with `T`, so
  // Escape returns the block to the state they found it in. A table that was
  // never opened is left alone, so Escape does not become a no-op that swallows
  // a host's own dialog shortcut.
  if (event.key === 'Escape' && state.tableOpen) return 'close-table';

  return 'none';
}

/** Apply a shortcut to the open state. */
export function applyShortcut(shortcut: BlockShortcut, open: boolean): boolean {
  switch (shortcut) {
    case 'toggle-table':
      return !open;
    case 'close-table':
      return false;
    default:
      return open;
  }
}

/** Element names that own their own typing. */
const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/** `true` when the event target is a field the reader is typing into. */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (element.isContentEditable === true) return true;
  return typeof element.tagName === 'string' && TYPING_TAGS.has(element.tagName);
}

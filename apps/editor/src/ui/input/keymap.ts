/**
 * Keyboard shortcuts: the commands that have no `beforeinput` of their own.
 *
 * `../surface/EditorSurface.tsx` handles everything structural — Tab, Enter in
 * a table, the arrow keys at a block boundary — because those depend on where
 * the caret is. What is left is the flat, position-independent set that belongs
 * in a table: formatting, block types, history, the file commands the shell
 * owns. {@link resolveShortcut} is a pure function of the event, so the whole
 * table is testable without a browser.
 *
 * ## Two details that decide whether this works outside a US keyboard
 *
 * **Digits are matched on `code`, letters on `key`.** `Ctrl+Shift+8` for a
 * bulleted list reports `key: '*'` on a US layout and something else again on a
 * German or French one; only `code: 'Digit8'` is the physical key the label
 * promises. Letters are the opposite case: on AZERTY the bold key is physically
 * `KeyQ` but everyone, including the platform's own apps, calls it `Ctrl+B`, so
 * matching `key` is what keeps `⌘B` on the key marked B.
 *
 * **`Alt` combinations must also come from `code`.** On macOS, Option+1 does
 * not report `key: '1'`, it reports `key: '¡'` — Option is a character
 * modifier there. A heading shortcut matched on `key` would simply never fire.
 */

import type { MarkType } from '../../engine/index.js';
import type { BlockTypeSpec } from '../../engine/commands/index.js';

/** Which physical modifier is the "command" modifier on this platform. */
export type ModKey = 'meta' | 'ctrl';

/** The slice of `KeyboardEvent` the table reads. A React event satisfies it. */
export interface KeyEventLike {
  readonly key: string;
  /** Physical key, e.g. `Digit8`. Absent on very old browsers; then `key` is used. */
  readonly code?: string | undefined;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** A shortcut the editor or its shell knows how to run. */
export type KeyAction =
  | { readonly kind: 'mark'; readonly mark: MarkType }
  | { readonly kind: 'clearMarks' }
  | { readonly kind: 'blockType'; readonly spec: BlockTypeSpec }
  | { readonly kind: 'undo' }
  | { readonly kind: 'redo' }
  | { readonly kind: 'selectAll' }
  | { readonly kind: 'slashMenu' }
  | { readonly kind: 'link' }
  | { readonly kind: 'save' }
  | { readonly kind: 'saveAs' }
  | { readonly kind: 'open' }
  | { readonly kind: 'toggleSource' };

/** A key combination, as written in the table below. */
interface Combo {
  /** Matched against `event.key`, lower-cased. Mutually exclusive with `code`. */
  readonly key?: string;
  /** Matched against `event.code`. Use for digits and for anything with Alt. */
  readonly code?: string;
  /** What the label should show for a `code` binding. */
  readonly label?: string;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

interface Binding {
  readonly combo: Combo;
  readonly action: KeyAction;
}

/**
 * Which modifier means "command" here.
 *
 * Read from the platform string rather than the user agent's browser name: it
 * is the keyboard that decides this, and iPadOS with a Magic Keyboard is a Mac
 * for this purpose even though it does not say so.
 */
export function detectModKey(platform: string): ModKey {
  return /mac|iphone|ipad|ipod/i.test(platform) ? 'meta' : 'ctrl';
}

const BINDINGS: readonly Binding[] = [
  // Formatting.
  { combo: { key: 'b' }, action: { kind: 'mark', mark: 'strong' } },
  { combo: { key: 'i' }, action: { kind: 'mark', mark: 'emphasis' } },
  { combo: { key: 'e' }, action: { kind: 'mark', mark: 'code' } },
  { combo: { key: 'x', shift: true }, action: { kind: 'mark', mark: 'strikethrough' } },
  { combo: { key: '\\' }, action: { kind: 'clearMarks' } },
  { combo: { key: 'k' }, action: { kind: 'link' } },

  // Block types. Digits and Alt: `code`, per the note at the top of the file.
  {
    combo: { code: 'Digit0', label: '0', alt: true },
    action: { kind: 'blockType', spec: { kind: 'paragraph' } },
  },
  {
    combo: { code: 'Digit1', label: '1', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 1 } },
  },
  {
    combo: { code: 'Digit2', label: '2', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 2 } },
  },
  {
    combo: { code: 'Digit3', label: '3', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 3 } },
  },
  {
    combo: { code: 'Digit4', label: '4', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 4 } },
  },
  {
    combo: { code: 'Digit5', label: '5', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 5 } },
  },
  {
    combo: { code: 'Digit6', label: '6', alt: true },
    action: { kind: 'blockType', spec: { kind: 'heading', level: 6 } },
  },
  {
    combo: { code: 'KeyC', label: 'C', alt: true },
    action: { kind: 'blockType', spec: { kind: 'code' } },
  },
  {
    combo: { code: 'Digit7', label: '7', shift: true },
    action: { kind: 'blockType', spec: { kind: 'orderedList' } },
  },
  {
    combo: { code: 'Digit8', label: '8', shift: true },
    action: { kind: 'blockType', spec: { kind: 'bulletList' } },
  },
  {
    combo: { code: 'Digit9', label: '9', shift: true },
    action: { kind: 'blockType', spec: { kind: 'quote' } },
  },

  // History. `Ctrl+Y` is the Windows spelling of redo and costs nothing to keep.
  { combo: { key: 'z' }, action: { kind: 'undo' } },
  { combo: { key: 'z', shift: true }, action: { kind: 'redo' } },
  { combo: { key: 'y' }, action: { kind: 'redo' } },

  // Selection and menus.
  { combo: { key: 'a' }, action: { kind: 'selectAll' } },
  { combo: { key: '/' }, action: { kind: 'slashMenu' } },

  // The shell's own.
  { combo: { key: 's' }, action: { kind: 'save' } },
  { combo: { key: 's', shift: true }, action: { kind: 'saveAs' } },
  { combo: { key: 'o' }, action: { kind: 'open' } },
  { combo: { key: 'm', shift: true }, action: { kind: 'toggleSource' } },
];

function matches(event: KeyEventLike, combo: Combo): boolean {
  if ((combo.shift ?? false) !== event.shiftKey) return false;
  if ((combo.alt ?? false) !== event.altKey) return false;

  if (combo.code !== undefined) {
    // Fall back to the label when the browser reports no `code`; on a US layout
    // that is the same key, and on any other it is the best guess available.
    const code = event.code;
    if (code !== undefined && code !== '') return code === combo.code;
    return combo.label !== undefined && event.key.toLowerCase() === combo.label.toLowerCase();
  }
  return combo.key !== undefined && event.key.toLowerCase() === combo.key;
}

/**
 * The action this key event runs, or `null`.
 *
 * The command modifier must be held and the *other* one must not be: on Windows
 * `AltGr` is reported as `Ctrl+Alt`, so a `Ctrl` binding that ignored `Alt`
 * would swallow the key that types `@` on a German keyboard.
 */
export function resolveShortcut(event: KeyEventLike, mod: ModKey): KeyAction | null {
  const command = mod === 'meta' ? event.metaKey : event.ctrlKey;
  const other = mod === 'meta' ? event.ctrlKey : event.metaKey;
  if (!command || other) return null;

  for (const binding of BINDINGS) {
    if (matches(event, binding.combo)) return binding.action;
  }
  return null;
}

const KEY_GLYPHS: Readonly<Record<string, string>> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↵',
  backspace: '⌫',
  escape: 'Esc',
  ' ': 'Space',
};

/**
 * Render a combination the way this platform writes it.
 *
 * macOS uses the glyphs with no separator, everything else uses `Ctrl+Shift+S`.
 * Both are what the platform's own menus show, and a shortcut hint that does
 * not match the platform reads as a bug.
 */
export function shortcutLabel(mod: ModKey, combo: Combo): string {
  const name = combo.label ?? combo.key ?? '';
  const glyph = KEY_GLYPHS[name.toLowerCase()];
  const printable = glyph ?? (name.length === 1 ? name.toUpperCase() : name);

  if (mod === 'meta') {
    return `${(combo.alt ?? false) ? '⌥' : ''}${(combo.shift ?? false) ? '⇧' : ''}⌘${printable}`;
  }
  const parts = ['Ctrl'];
  if (combo.alt ?? false) parts.push('Alt');
  if (combo.shift ?? false) parts.push('Shift');
  parts.push(printable);
  return parts.join('+');
}

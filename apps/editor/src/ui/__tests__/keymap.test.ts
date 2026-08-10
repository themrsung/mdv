/**
 * The shortcut table.
 *
 * Half of these assertions are about keyboards that are not American. That is
 * deliberate: the bugs this table can have are invisible on the machine it was
 * written on and total for everyone else — a bulleted-list shortcut that never
 * fires on a German layout, a heading shortcut that never fires on a Mac, an
 * AltGr keystroke swallowed on Windows so `@` cannot be typed.
 */

import { describe, expect, it } from 'vitest';
import type { KeyEventLike, ModKey } from '../input/keymap.js';
import { detectModKey, resolveShortcut, shortcutLabel } from '../input/keymap.js';

function key(partial: Partial<KeyEventLike> & { readonly key: string }): KeyEventLike {
  return { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, ...partial };
}

describe('detectModKey', () => {
  it('is the command key on Apple platforms', () => {
    expect(detectModKey('MacIntel')).toBe('meta');
    expect(detectModKey('iPhone')).toBe('meta');
    expect(detectModKey('iPad')).toBe('meta');
  });

  it('is control everywhere else', () => {
    expect(detectModKey('Win32')).toBe('ctrl');
    expect(detectModKey('Linux x86_64')).toBe('ctrl');
    expect(detectModKey('')).toBe('ctrl');
  });
});

describe('resolveShortcut', () => {
  it('requires the platform modifier', () => {
    expect(resolveShortcut(key({ key: 'b' }), 'ctrl')).toBeNull();
    expect(resolveShortcut(key({ key: 'b', ctrlKey: true }), 'ctrl')).toEqual({
      kind: 'mark',
      mark: 'strong',
    });
  });

  it('does not answer to the other platform’s modifier', () => {
    expect(resolveShortcut(key({ key: 'b', metaKey: true }), 'ctrl')).toBeNull();
    expect(resolveShortcut(key({ key: 'b', ctrlKey: true }), 'meta')).toBeNull();
  });

  it('leaves AltGr alone so it can still type a character', () => {
    // Windows reports AltGr as Ctrl+Alt; `Ctrl+Alt+Q` types `@` on several
    // layouts and must not be eaten by a shortcut.
    const altGr = key({ key: 'q', code: 'KeyQ', ctrlKey: true, altKey: true });
    expect(resolveShortcut(altGr, 'ctrl')).toBeNull();
  });

  it('matches the formatting marks', () => {
    expect(resolveShortcut(key({ key: 'i', ctrlKey: true }), 'ctrl')).toEqual({
      kind: 'mark',
      mark: 'emphasis',
    });
    expect(resolveShortcut(key({ key: 'e', ctrlKey: true }), 'ctrl')).toEqual({
      kind: 'mark',
      mark: 'code',
    });
    // Shift+X reports an upper-case `key`.
    expect(resolveShortcut(key({ key: 'X', ctrlKey: true, shiftKey: true }), 'ctrl')).toEqual({
      kind: 'mark',
      mark: 'strikethrough',
    });
  });

  it('distinguishes undo from redo by the shift key', () => {
    expect(resolveShortcut(key({ key: 'z', ctrlKey: true }), 'ctrl')).toEqual({ kind: 'undo' });
    expect(resolveShortcut(key({ key: 'Z', ctrlKey: true, shiftKey: true }), 'ctrl')).toEqual({
      kind: 'redo',
    });
    expect(resolveShortcut(key({ key: 'y', ctrlKey: true }), 'ctrl')).toEqual({ kind: 'redo' });
  });

  it('matches list shortcuts on the physical digit, not the shifted character', () => {
    // A US keyboard reports `*` for Shift+8; a German one reports `(`.
    const shifted = key({ key: '*', code: 'Digit8', ctrlKey: true, shiftKey: true });
    expect(resolveShortcut(shifted, 'ctrl')).toEqual({
      kind: 'blockType',
      spec: { kind: 'bulletList' },
    });

    const german = key({ key: '(', code: 'Digit8', ctrlKey: true, shiftKey: true });
    expect(resolveShortcut(german, 'ctrl')).toEqual({
      kind: 'blockType',
      spec: { kind: 'bulletList' },
    });
  });

  it('matches heading shortcuts on macOS, where Option rewrites the character', () => {
    // Option+1 on a Mac reports `key: '¡'`.
    const mac = key({ key: '¡', code: 'Digit1', metaKey: true, altKey: true });
    expect(resolveShortcut(mac, 'meta')).toEqual({
      kind: 'blockType',
      spec: { kind: 'heading', level: 1 },
    });
  });

  it('falls back to the label when the browser reports no code', () => {
    const noCode = key({ key: '3', ctrlKey: true, altKey: true });
    expect(resolveShortcut(noCode, 'ctrl')).toEqual({
      kind: 'blockType',
      spec: { kind: 'heading', level: 3 },
    });
  });

  it('does not fire a plain binding when a modifier it does not want is held', () => {
    expect(resolveShortcut(key({ key: 'b', ctrlKey: true, altKey: true }), 'ctrl')).toBeNull();
    expect(resolveShortcut(key({ key: 'b', ctrlKey: true, shiftKey: true }), 'ctrl')).toBeNull();
  });

  it('routes the shell commands', () => {
    expect(resolveShortcut(key({ key: 's', metaKey: true }), 'meta')).toEqual({ kind: 'save' });
    expect(resolveShortcut(key({ key: 'S', metaKey: true, shiftKey: true }), 'meta')).toEqual({
      kind: 'saveAs',
    });
    expect(resolveShortcut(key({ key: 'o', metaKey: true }), 'meta')).toEqual({ kind: 'open' });
  });

  it('returns null for an unbound key', () => {
    expect(resolveShortcut(key({ key: 'q', ctrlKey: true }), 'ctrl')).toBeNull();
  });
});

describe('shortcutLabel', () => {
  const cases: readonly (readonly [ModKey, Parameters<typeof shortcutLabel>[1], string])[] = [
    ['meta', { key: 's' }, '⌘S'],
    ['meta', { key: 's', shift: true }, '⇧⌘S'],
    ['meta', { label: '1', alt: true }, '⌥⌘1'],
    ['ctrl', { key: 's' }, 'Ctrl+S'],
    ['ctrl', { key: 's', shift: true }, 'Ctrl+Shift+S'],
    ['ctrl', { label: '1', alt: true }, 'Ctrl+Alt+1'],
  ];

  it('writes each combination the way its platform does', () => {
    for (const [mod, combo, expected] of cases) {
      expect(shortcutLabel(mod, combo)).toBe(expected);
    }
  });

  it('uses glyphs for the named keys', () => {
    expect(shortcutLabel('meta', { key: 'Enter' })).toBe('⌘↵');
    expect(shortcutLabel('ctrl', { key: 'ArrowUp' })).toBe('Ctrl+↑');
  });
});

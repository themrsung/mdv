/**
 * The colour scheme: what the user chose, and what that resolves to now.
 *
 * Three choices, not two. "Follow system" is a real answer and the default one:
 * an editor that ignores `prefers-color-scheme` is a bright rectangle in a dark
 * room, and one that latches whatever the system said at first paint is worse,
 * because it stops following when the system flips at sunset.
 *
 * The resolution rule is a pure function of the choice and one boolean, so the
 * interesting part is testable; the hook around it does the two impure things —
 * subscribe to the media query, persist the choice — and nothing else.
 *
 * The choice is published as `data-theme` on the document element, which is the
 * attribute `src/styles/tokens.css` already keys its dark set on. Note what is
 * published: the *choice*, not the resolved scheme. The stylesheet answers
 * "system" itself with a `prefers-color-scheme` query, so writing a resolved
 * `data-theme="light"` for a system-light viewer would pin the page light and
 * stop it following the system at sunset. `system` therefore removes the
 * attribute entirely and lets the media query do its job.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ColorScheme } from './view-prefs.js';
import type { StorageLike } from './persistence.js';

/** What the user picked in the theme control. */
export type ThemeChoice = 'light' | 'dark' | 'system';

/** Where the choice is remembered between sessions. */
export const THEME_STORAGE_KEY = 'mdv.theme';

const MEDIA_QUERY = '(prefers-color-scheme: dark)';

/** Read a stored value back, defaulting anything unrecognised to `system`. */
export function parseThemeChoice(raw: string | null | undefined): ThemeChoice {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** What `choice` means right now, given what the system currently prefers. */
export function resolveScheme(choice: ThemeChoice, systemPrefersDark: boolean): ColorScheme {
  if (choice === 'system') return systemPrefersDark ? 'dark' : 'light';
  return choice;
}

/** The subset of `MediaQueryList` this module uses. */
export interface MediaQueryLike {
  readonly matches: boolean;
  addEventListener(type: 'change', listener: () => void): void;
  removeEventListener(type: 'change', listener: () => void): void;
}

interface ThemeHost {
  matchMedia?(query: string): MediaQueryLike;
}

function mediaQuery(): MediaQueryLike | null {
  const host = globalThis as ThemeHost;
  if (typeof host.matchMedia !== 'function') return null;
  try {
    return host.matchMedia(MEDIA_QUERY);
  } catch {
    /* c8 ignore next -- a browser that has the method but rejects the query. */
    return null;
  }
}

/**
 * Subscribe to `prefers-color-scheme`.
 *
 * `useSyncExternalStore` rather than `useState` + an effect: the media query is
 * external state that can change between render and commit, and this is the
 * hook that exists to read exactly that without tearing.
 */
function useSystemPrefersDark(): boolean {
  const query = useMemo(mediaQuery, []);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (query === null) return () => undefined;
      query.addEventListener('change', onChange);
      return () => {
        query.removeEventListener('change', onChange);
      };
    },
    [query],
  );

  return useSyncExternalStore(
    subscribe,
    () => query?.matches ?? false,
    () => false,
  );
}

export interface ThemeState {
  readonly choice: ThemeChoice;
  /** What the choice resolves to right now. */
  readonly scheme: ColorScheme;
  setChoice(choice: ThemeChoice): void;
}

/**
 * The theme, persisted.
 *
 * `storage` is injected so a test can drive the whole hook without touching a
 * real `localStorage`, and so a browser in private mode — where reading it can
 * throw — degrades to an unremembered but working theme.
 */
export function useTheme(storage: StorageLike | null = defaultStorage()): ThemeState {
  const [choice, setChoice] = useState<ThemeChoice>(() => {
    try {
      return parseThemeChoice(storage?.getItem(THEME_STORAGE_KEY) ?? null);
    } catch {
      return 'system';
    }
  });

  const systemPrefersDark = useSystemPrefersDark();
  const scheme = resolveScheme(choice, systemPrefersDark);

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (root === undefined) return;
    if (choice === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', choice);
  }, [choice]);

  const choose = useCallback(
    (next: ThemeChoice): void => {
      setChoice(next);
      try {
        storage?.setItem(THEME_STORAGE_KEY, next);
      } catch {
        // A full or disabled store must not stop the theme from changing.
      }
    },
    [storage],
  );

  return useMemo(() => ({ choice, scheme, setChoice: choose }), [choice, scheme, choose]);
}

function defaultStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    /* c8 ignore next -- blocked by a cookie policy; the theme just stops persisting. */
    return null;
  }
}

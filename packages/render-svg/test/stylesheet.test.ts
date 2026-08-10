/**
 * The scoped stylesheet (SPEC 22.4, 13.5, 11.7).
 *
 * > One stylesheet of ~2 KB using custom properties for every token and **no
 * > global selectors** — all rules are scoped under `.mdv-root`.
 *
 * "No global selectors" is the requirement worth a real test rather than a
 * spot check: a single unscoped rule silently restyles the host page, and it is
 * exactly the kind of thing that gets added later by someone fixing a layout
 * bug. So the sheet is parsed and every selector is checked, including the ones
 * inside media queries.
 */

import { describe, expect, it } from 'vitest';
import { CLASS_NAMES, stylesheet } from '../src/index.js';

/** Top-level and nested selectors, with the media query wrappers removed. */
function selectors(sheet: string): string[] {
  return sheet
    .replace(/@media[^{]+\{/g, '')
    .split('}')
    .map((rule) => rule.split('{')[0]?.trim() ?? '')
    .filter((s) => s.length > 0);
}

describe('no global selectors (SPEC 22.4)', () => {
  it('scopes every selector under .mdv-root', () => {
    const found = selectors(stylesheet());
    // Non-empty, or the parse is wrong and the test proves nothing.
    expect(found.length).toBeGreaterThan(15);
    for (const selector of found) {
      for (const alternative of selector.split(',')) {
        expect(alternative.trim().startsWith('.mdv-root')).toBe(true);
      }
    }
  });

  it('styles no bare element type', () => {
    // `svg{…}` or `text{…}` would reach the host document's own content.
    for (const selector of selectors(stylesheet())) {
      expect(selector).not.toMatch(/(^|,)\s*[a-z]/);
    }
  });

  it('uses only namespaced class names', () => {
    for (const cls of stylesheet().match(/\.[a-zA-Z][\w-]*/g) ?? []) {
      expect(cls.startsWith('.mdv-')).toBe(true);
    }
  });
});

describe('CSP-safe (SPEC 13.5: default-src none, no unsafe-inline)', () => {
  it('makes no external reference and runs no code', () => {
    const sheet = stylesheet();
    expect(sheet).not.toContain('url(');
    expect(sheet).not.toContain('@import');
    expect(sheet).not.toContain('expression(');
    expect(sheet.toLowerCase()).not.toContain('javascript:');
    expect(sheet).not.toContain('@font-face');
  });

  it('is returned as a string rather than injected', () => {
    // The embedder serves it as an external sheet or on a nonced <style>; only
    // the embedder knows which, so this function must not touch the document.
    expect(typeof stylesheet()).toBe('string');
  });
});

describe('the sheet is not a second theme system (SPEC 20: "No CSS")', () => {
  it('never sets a colour on a mark', () => {
    // Marks carry resolved absolutes from the scene. A rule that could recolour
    // them would compete with the theme and win only sometimes.
    const sheet = stylesheet();
    expect(sheet).not.toContain('.mdv-mark');
    expect(sheet).not.toContain('.mdv-bar');
    expect(sheet).not.toContain('.mdv-line{');
  });

  it('sets fill on nothing at all', () => {
    expect(stylesheet()).not.toMatch(/[{;]fill:/);
  });
});

describe('colour scheme (SPEC 11.7)', () => {
  it('goes dark under the system preference and under an explicit attribute', () => {
    const sheet = stylesheet();
    expect(sheet).toContain('@media (prefers-color-scheme:dark)');
    expect(sheet).toContain('.mdv-root[data-theme=dark]');
  });

  it('lets an explicit light choice win over a dark system preference', () => {
    // Without the `:not([data-theme=light])`, a viewer's explicit toggle would
    // only work in the direction that already agreed with the OS.
    expect(stylesheet()).toContain('.mdv-root:not([data-theme=light])');
  });

  it('defines the same token set in both schemes', () => {
    const sheet = stylesheet();
    const tokensIn = (block: string): string[] =>
      [...new Set(block.match(/--mdv-[\w-]+(?=:)/g) ?? [])].sort();
    const dark = /\.mdv-root\[data-theme=dark\]\{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    const media = /@media \(prefers-color-scheme:dark\)\{[^{]*\{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(tokensIn(dark).length).toBeGreaterThan(5);
    expect(tokensIn(media)).toStrictEqual(tokensIn(dark));
  });

  it('honours forced-colors with system colour keywords (SPEC 11.7)', () => {
    const sheet = stylesheet();
    expect(sheet).toContain('@media (forced-colors:active)');
    expect(sheet).toContain('CanvasText');
    expect(sheet).toContain('forced-color-adjust:none');
  });

  it('honours prefers-reduced-motion by removing motion entirely (SPEC 12.5)', () => {
    const sheet = stylesheet();
    expect(sheet).toContain('@media (prefers-reduced-motion:reduce)');
    expect(sheet).toContain('transition-duration:0.01ms !important');
    expect(sheet).toContain('animation-duration:0.01ms !important');
  });
});

describe('CLASS_NAMES is public API (SPEC 22.4)', () => {
  it('is frozen, so a consumer cannot mutate another consumer view', () => {
    expect(Object.isFrozen(CLASS_NAMES)).toBe(true);
  });

  it('is namespaced and free of collisions', () => {
    const values = Object.values(CLASS_NAMES);
    for (const value of values) expect(value).toMatch(/^mdv-[a-z-]+$/);
    expect(new Set(values).size).toBe(values.length);
  });

  it('names the root the sheet scopes to', () => {
    expect(CLASS_NAMES.root).toBe('mdv-root');
    expect(stylesheet().startsWith(`.${CLASS_NAMES.root}{`)).toBe(true);
  });

  it('styles every class it names that carries appearance', () => {
    // `mdv-surface` and `mdv-interaction` are structural hooks with nothing to
    // style — they exist so a consumer can select them — so they are listed
    // here rather than silently excluded by a loose assertion.
    const structuralOnly = new Set(['mdv-surface', 'mdv-interaction']);
    const sheet = stylesheet();
    for (const value of Object.values(CLASS_NAMES)) {
      if (structuralOnly.has(value)) {
        expect(sheet).not.toContain(`.${value}`);
      } else {
        expect(sheet).toContain(`.${value}`);
      }
    }
  });
});

describe('the sheet itself', () => {
  it('is the same string every call', () => {
    expect(stylesheet()).toBe(stylesheet());
  });

  it('stays close to the ~2 KB SPEC 22.4 budgets for', () => {
    // A guard against the sheet growing into a framework, not a hard limit.
    expect(stylesheet().length).toBeLessThan(4096);
  });

  it('defines its tokens as custom properties rather than literals', () => {
    const sheet = stylesheet();
    expect(sheet).toContain('--mdv-text-primary:');
    expect(sheet).toContain('color:var(--mdv-text-primary)');
  });

  it('hides the live region without hiding it from assistive technology', () => {
    // `display:none` and `visibility:hidden` remove it from the accessibility
    // tree, so announcements would stop (SPEC 12.4).
    const live = /\.mdv-live\{([^}]*)\}/.exec(stylesheet())?.[1] ?? '';
    expect(live).toContain('clip-path:inset(50%)');
    expect(live).not.toContain('display:none');
    expect(live).not.toContain('visibility:hidden');
  });
});

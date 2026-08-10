/**
 * The stylesheet (SPEC 22.4).
 *
 * > One stylesheet … using custom properties for every token and **no global
 * > selectors** — all rules are scoped under `.mdv-root`. Class names are stable
 * > and namespaced … and are part of the public API.
 *
 * "No global selectors" is the load-bearing clause: a reader is embedded in
 * someone else's page, and one unscoped `table { border-collapse: collapse }`
 * would restyle their whole site. This file checks every selector.
 */

import { describe, expect, it } from 'vitest';
import { CLASS_NAMES, REACT_CLASS_NAMES, reactStylesheet, stylesheet } from '../src/index.js';

/** Split a sheet into top-level selectors, stepping over `@media` blocks. */
function selectors(css: string): string[] {
  const out: string[] = [];
  let i = 0;
  let start = 0;
  let depth = 0;

  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) {
        const head = css.slice(start, i).trim();
        if (!head.startsWith('@')) out.push(head);
        else start = i + 1;
      }
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth < 0) throw new Error(`unbalanced } at ${String(i)}`);
      if (depth === 0) start = i + 1;
      // Leaving a media block: the next selector starts here too.
      if (depth === 1) start = i + 1;
    }
    i += 1;
  }
  if (depth !== 0) throw new Error('unbalanced braces');
  return out.filter((s) => s.length > 0);
}

describe('the sheet is well formed', () => {
  it('has balanced braces', () => {
    expect(() => selectors(stylesheet())).not.toThrow();
  });

  it('has no stray newlines — it is emitted as one line', () => {
    expect(reactStylesheet()).not.toContain('\n');
  });

  it('is the chart sheet plus this package’s, in that order', () => {
    expect(stylesheet().endsWith(reactStylesheet())).toBe(true);
    expect(stylesheet().length).toBeGreaterThan(reactStylesheet().length);
  });
});

describe('no global selectors (SPEC 22.4)', () => {
  it('scopes every rule under .mdv-root', () => {
    for (const selector of selectors(stylesheet())) {
      for (const part of selector.split(',')) {
        expect(part.trim(), `unscoped selector: ${part.trim()}`).toMatch(/^\.mdv-root\b/);
      }
    }
  });

  it('has something to check — the extraction is not vacuous', () => {
    expect(selectors(stylesheet()).length).toBeGreaterThan(20);
  });
});

describe('the page-break marker (SPEC 28.4)', () => {
  it('has no visuals on screen', () => {
    // Everything outside `@media print` that mentions the marker.
    const screen = reactStylesheet()
      .split('@media')[0]
      ?.match(/\.mdv-root \.mdv-page-break[^{]*\{[^}]*\}/g);
    expect(screen).toEqual(['.mdv-root .mdv-page-break{display:block}']);
  });

  it('maps to CSS fragmentation when printed, so print agrees with the PDF', () => {
    const print = /@media print\{(.*?\})\}/.exec(reactStylesheet())?.[1] ?? '';
    expect(print).toContain('[data-mdv-break=before]');
    expect(print).toContain('break-before:page');
    expect(print).toContain('break-after:page');
    expect(print).toContain('break-inside:avoid');
  });
});

describe('the class-name table', () => {
  it('names every class the sheet styles', () => {
    const css = reactStylesheet();
    for (const name of Object.values(REACT_CLASS_NAMES)) {
      expect(css, `${name} is exported but never styled`).toContain(`.${name}`);
    }
  });

  it('merges the chart package’s names in', () => {
    expect(CLASS_NAMES.root).toBe('mdv-root');
    expect(CLASS_NAMES.tooltip).toBe('mdv-tooltip');
    expect(CLASS_NAMES.dataTable).toBe('mdv-data-table');
  });

  it('is frozen, so one embedder cannot restyle another document', () => {
    expect(Object.isFrozen(REACT_CLASS_NAMES)).toBe(true);
    expect(Object.isFrozen(CLASS_NAMES)).toBe(true);
  });

  it('namespaces every name', () => {
    for (const name of Object.values(CLASS_NAMES)) expect(name).toMatch(/^mdv-/);
  });
});

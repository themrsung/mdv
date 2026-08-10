/**
 * The React emitter (SPEC 22.3).
 *
 * React is deliberately absent from this package's dependencies — `@mdv/render-svg`
 * is universal and must not pull React into a Node or CLI bundle (SPEC 17.2) —
 * so the host passes its own `createElement`. That is what makes this testable
 * without React: the factory below records what React would have been asked to
 * build, and the assertions are about the request, not about React's rendering.
 */

import { describe, expect, it } from 'vitest';
import { reactPropName, toHostElements, toReactElements } from '../src/index.js';
import { buildScene } from '../src/build.js';
import { el } from '../src/vnode.js';
import { RECT, TEXT, kitchenSink, scene } from './fixtures.js';

interface Rec {
  readonly type: string;
  readonly props: Record<string, unknown>;
  readonly children: readonly unknown[];
}

/** A `createElement` with React's signature, recording instead of rendering. */
function recorder(): { create: (t: string, p: Record<string, unknown>, ...c: unknown[]) => Rec } {
  return {
    create: (type, props, ...children) => ({ type, props, children }),
  };
}

/** Depth-first walk of a recorded tree. */
function walk(node: Rec, visit: (n: Rec) => void): void {
  visit(node);
  for (const child of node.children) {
    if (typeof child === 'object' && child !== null) walk(child as Rec, visit);
  }
}

describe('reactPropName', () => {
  it('camelCases hyphenated SVG attributes', () => {
    expect(reactPropName('stroke-width')).toBe('strokeWidth');
    expect(reactPropName('stroke-linecap')).toBe('strokeLinecap');
    expect(reactPropName('font-family')).toBe('fontFamily');
    expect(reactPropName('clip-path')).toBe('clipPath');
    expect(reactPropName('stroke-dasharray')).toBe('strokeDasharray');
    expect(reactPropName('text-anchor')).toBe('textAnchor');
  });

  it('uses React spellings where they differ from the DOM', () => {
    expect(reactPropName('class')).toBe('className');
    expect(reactPropName('tabindex')).toBe('tabIndex');
    expect(reactPropName('xml:lang')).toBe('xmlLang');
    expect(reactPropName('xml:space')).toBe('xmlSpace');
  });

  it('passes aria-* and data-* through verbatim, as React requires', () => {
    // React special-cases these two prefixes; camelCasing them would silently
    // drop the attribute from the DOM.
    expect(reactPropName('aria-labelledby')).toBe('aria-labelledby');
    expect(reactPropName('aria-hidden')).toBe('aria-hidden');
    expect(reactPropName('data-mdv-region')).toBe('data-mdv-region');
    expect(reactPropName('data-mdv-mark')).toBe('data-mdv-mark');
  });

  it('leaves already-camelCase SVG attributes untouched', () => {
    for (const name of ['viewBox', 'preserveAspectRatio', 'gradientUnits', 'patternTransform']) {
      expect(reactPropName(name)).toBe(name);
    }
  });

  it('is idempotent, so a double translation cannot corrupt a name', () => {
    for (const name of ['stroke-width', 'viewBox', 'aria-hidden', 'class']) {
      expect(reactPropName(reactPropName(name))).toBe(reactPropName(name));
    }
  });
});

describe('toReactElements', () => {
  it('asks the host factory for the whole tree, root first', () => {
    const { create } = recorder();
    const tree = toReactElements(scene(), create) as Rec;
    expect(tree.type).toBe('svg');
    expect(tree.props['viewBox']).toBe('0 0 320 180');
    expect(tree.props['className']).toBe('mdv-root mdv-chart');
  });

  it('emits the same elements the string serialiser emits', () => {
    const { create } = recorder();
    const tags: string[] = [];
    walk(toReactElements(kitchenSink(), create) as Rec, (n) => tags.push(n.type));
    // Every node kind of SPEC 20 reaches React, not just the ones with a
    // one-to-one SVG mapping.
    for (const tag of [
      'svg',
      'title',
      'desc',
      'defs',
      'g',
      'rect',
      'line',
      'path',
      'circle',
      'text',
      'image',
      'use',
    ]) {
      expect(tags).toContain(tag);
    }
  });

  it('gives every child a key, since React reconciles a list', () => {
    const { create } = recorder();
    const tree = toReactElements(kitchenSink(), create) as Rec;
    // The root has no key — it is not in a list — but everything below does.
    expect(tree.props['key']).toBeUndefined();
    walk(tree, (n) => {
      for (const child of n.children) {
        if (typeof child === 'object' && child !== null) {
          expect((child as Rec).props['key']).toBeTypeOf('string');
        }
      }
    });
  });

  it('keys positionally, and the same scene always yields the same keys', () => {
    const { create } = recorder();
    const keys = (): unknown[] => {
      const out: unknown[] = [];
      walk(toReactElements(kitchenSink(), create) as Rec, (n) => out.push(n.props['key']));
      return out;
    };
    expect(keys()).toStrictEqual(keys());
  });

  it('passes text as a child string, never as innerHTML', () => {
    const { create } = recorder();
    const tree = toReactElements(
      scene({ root: { kind: 'group', children: [TEXT] } }),
      create,
    ) as Rec;
    let text: Rec | undefined;
    walk(tree, (n) => {
      if (n.type === 'text') text = n;
    });
    expect(text?.children[0]).toBeTypeOf('string');
    // The one property that would reintroduce a markup path (SPEC 13.3).
    expect(text?.props).not.toHaveProperty('dangerouslySetInnerHTML');
  });

  it('leaves hostile text unescaped, because React escapes on render', () => {
    // Double-escaping would show `&lt;script&gt;` to the reader as literal text.
    // The safety here is React's text-node insertion, not an escape of ours.
    const { create } = recorder();
    const hostile = '<script>alert(1)</script>';
    const tree = toReactElements(
      scene({ root: { kind: 'group', children: [{ ...TEXT, text: hostile }] } }),
      create,
    ) as Rec;
    let text: Rec | undefined;
    walk(tree, (n) => {
      if (n.type === 'text') text = n;
    });
    expect(text?.children[0]).toBe(hostile);
  });

  it('enforces the attribute allowlist before React ever sees a prop', () => {
    const { create } = recorder();
    expect(() => toHostElements(el('rect', [['onload', 'alert(1)']]), create)).toThrow(/allowlist/);
    expect(() => toHostElements(el('rect', [['style', 'color:red']]), create)).toThrow(/allowlist/);
  });

  it('honours the same options as the other two emitters', () => {
    const { create } = recorder();
    const plain = toReactElements(scene({ root: { kind: 'group', children: [RECT] } }), create, {
      classes: false,
      interaction: false,
    }) as Rec;
    walk(plain, (n) => {
      expect(n.props['className']).toBeUndefined();
    });
  });

  it('builds from the same virtual tree as the string path', () => {
    // The three emitters share one tree; if React were built separately the two
    // could disagree about which elements exist.
    const { create } = recorder();
    const viaScene = toReactElements(kitchenSink(), create) as Rec;
    const viaTree = toHostElements(buildScene(kitchenSink()), create) as Rec;
    expect(JSON.stringify(viaScene)).toBe(JSON.stringify(viaTree));
  });
});

/**
 * The DOM output path (SPEC 22.3, 23.1).
 *
 * Two things are being checked. First, that the DOM tree is the *same drawing*
 * as the string — the whole reason all three emitters share one virtual tree is
 * that only the string is covered by golden files, so the DOM has to be pinned
 * against it. Second, that `update` patches rather than replaces: a
 * `ResizeObserver` fires on every frame of a window drag, and a renderer that
 * rebuilds drops keyboard focus and the user's text selection each time.
 */

import { describe, expect, it } from 'vitest';
import { createElementTree, patchElementTree } from '../src/dom.js';
import { buildScene } from '../src/build.js';
import { toSvgElement, toSvgString } from '../src/index.js';
import type { FakeElement } from './fake-dom.js';
import { XML_NS, fakeDocument } from './fake-dom.js';
import { PLAIN_RECT, a11y, kitchenSink, root, scene } from './fixtures.js';

/** The fake document's elements, with their inspection helpers visible. */
function build(sceneArg: Parameters<typeof toSvgElement>[0]): FakeElement {
  return toSvgElement(sceneArg, fakeDocument()) as unknown as FakeElement;
}

describe('toSvgElement', () => {
  it('produces the same markup as the string serialiser', () => {
    // The DOM path and the string path must not be able to drift.
    for (const s of [scene(), kitchenSink()]) {
      expect(build(s).toMarkup()).toBe(toSvgString(s));
    }
  });

  it('creates elements in the SVG namespace', () => {
    const svg = build(scene());
    expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
    expect(svg.localName).toBe('svg');
  });

  it('puts xml:lang in the XML namespace, not in no namespace', () => {
    const s = scene();
    const svg = build({ ...s, a11y: { ...s.a11y, lang: 'ko' } });
    expect(svg.getAttributeNS(XML_NS, 'lang')).toBe('ko');
    expect(svg.getAttribute('xml:lang')).toBeNull();
  });

  it('inserts document text as a text node, never as markup (SPEC 13.3)', () => {
    const svg = build(scene({ a11y: a11y({ name: '<script>alert(1)</script>' }) }));
    const title = svg.children[0];
    // The DOM holds the raw string; it is markup only if something re-parses it,
    // and `createTextNode` guarantees nothing will.
    expect(title?.textContent).toBe('<script>alert(1)</script>');
    expect(title?.children).toHaveLength(0);
  });

  it('refuses an attribute outside the allowlist on the DOM path too', () => {
    const doc = fakeDocument();
    expect(() =>
      createElementTree({ tag: 'rect', attrs: [['onload', 'x']], children: [] }, doc),
    ).toThrow(/allowlist/);
  });
});

describe('patchElementTree (SPEC 22.3: survive a ResizeObserver storm)', () => {
  const doc = fakeDocument();

  it('keeps element identity when only attributes change', () => {
    const first = createElementTree(buildScene(scene()), doc);
    const rect = first;
    const next = buildScene(scene({ width: 640 }));
    const patched = patchElementTree(first, next, doc);
    // Same object: focus and selection live on the node, so replacing it loses them.
    expect(patched).toBe(rect);
    expect((patched as unknown as FakeElement).getAttribute('width')).toBe('640');
  });

  it('converges on exactly the tree a fresh render would produce', () => {
    // Compared against a *fresh DOM tree*, not against the golden string, and
    // with attributes sorted: `setAttribute` appends, so an attribute the first
    // scene did not have lands at the end of the patched element rather than in
    // the emitter's order. A real DOM does the same, and SVG attaches no
    // meaning to attribute order — the guarantee here is that the patched tree
    // ends up carrying the same elements, children and attribute values, which
    // sorting makes visible without weakening.
    const a = scene();
    const b = kitchenSink();
    const patched = patchElementTree(createElementTree(buildScene(a), doc), buildScene(b), doc);
    const fresh = createElementTree(buildScene(b), doc) as unknown as FakeElement;
    const sorted = { sortAttributes: true } as const;
    expect((patched as unknown as FakeElement).toMarkup(sorted)).toBe(fresh.toMarkup(sorted));
  });

  it('is stable when patched to the same scene twice', () => {
    const s = kitchenSink();
    const element = createElementTree(buildScene(s), doc);
    patchElementTree(element, buildScene(s), doc);
    patchElementTree(element, buildScene(s), doc);
    expect((element as unknown as FakeElement).toMarkup()).toBe(toSvgString(s));
  });

  it('removes attributes the new tree no longer wants', () => {
    const withClasses = createElementTree(buildScene(scene()), doc);
    patchElementTree(withClasses, buildScene(scene(), { classes: false }), doc);
    expect((withClasses as unknown as FakeElement).getAttribute('class')).toBeNull();
  });

  it('appends missing children and drops surplus ones', () => {
    const one = scene({ root: root([PLAIN_RECT]) });
    const three = scene({ root: root([PLAIN_RECT, PLAIN_RECT, PLAIN_RECT]) });
    const element = createElementTree(buildScene(one), doc);

    patchElementTree(element, buildScene(three), doc);
    expect((element as unknown as FakeElement).toMarkup()).toBe(toSvgString(three));

    patchElementTree(element, buildScene(one), doc);
    expect((element as unknown as FakeElement).toMarkup()).toBe(toSvgString(one));
  });

  it('replaces the subtree when the tag changes, because a rect is not a path', () => {
    // A radius turns a rect into a path; attribute surgery would leave an
    // element in an invalid state.
    const asRect = scene({ root: root([{ kind: 'rect', x: 0, y: 0, w: 4, h: 4 }]) });
    const asPath = scene({
      root: root([{ kind: 'rect', x: 0, y: 0, w: 4, h: 4, r: [2, 2, 0, 0] }]),
    });
    const element = createElementTree(buildScene(asRect), doc);
    patchElementTree(element, buildScene(asPath), doc);
    expect((element as unknown as FakeElement).toMarkup()).toBe(toSvgString(asPath));
  });

  it('updates text in place rather than stacking text nodes', () => {
    const a = scene({ a11y: a11y({ name: 'First' }) });
    const b = scene({ a11y: a11y({ name: 'Second' }) });
    const element = createElementTree(buildScene(a), doc) as unknown as FakeElement;
    patchElementTree(element as unknown as Element, buildScene(b), doc);
    const title = element.children[0];
    expect(title?.textContent).toBe('Second');
    expect(title?.childNodes).toHaveLength(1);
  });
});

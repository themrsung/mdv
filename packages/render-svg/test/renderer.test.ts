/**
 * The imperative backend (SPEC 21 `Renderer`, SPEC 22.3).
 *
 * The behaviour worth testing here is `update`. A `ResizeObserver` fires on
 * every frame of a window drag, so `update` runs dozens of times a second; a
 * renderer that rebuilt the tree would drop keyboard focus and the reader's text
 * selection each time, and one that re-attached the interaction layer without
 * detaching the old one would leak a listener per frame.
 */

import { describe, expect, it } from 'vitest';
import { createSvgRenderer } from '../src/index.js';
import type { FakeDocument, FakeElement } from './fake-dom.js';
import {
  FakeElement as FakeElementClass,
  fakeDocument,
  fakeHost,
  installElementGlobal,
} from './fake-dom.js';
import { PLAIN_RECT, hit, root, scene } from './fixtures.js';

installElementGlobal();

const interactive = scene({ hitIndex: [hit('r0'), hit('r1')] });

function setup(): { doc: FakeDocument; host: FakeElement } {
  const doc = fakeDocument();
  return {
    doc: doc as unknown as FakeDocument,
    host: fakeHost(doc) as unknown as FakeElement,
  };
}

describe('the Renderer contract (SPEC 21)', () => {
  it('declares itself total: no scene-node kind is unsupported', () => {
    const renderer = createSvgRenderer();
    expect(renderer.target).toBe('svg');
    // SPEC 17.3 invariant 3: every kind in SPEC 20 is drawn, so nothing to list.
    expect(renderer.unsupported).toStrictEqual([]);
  });

  it('refuses a host that is not attached to a document, loudly', () => {
    // The alternative — reaching for a global `document` — is what breaks in a
    // worker and in VS Code's webview.
    const orphan = new FakeElementClass('http://www.w3.org/1999/xhtml', 'div');
    expect(() => createSvgRenderer().render(scene(), orphan as unknown as Element)).toThrow(
      TypeError,
    );
    expect(() => createSvgRenderer().render(scene(), orphan as unknown as Element)).toThrow(
      /not attached to a Document/,
    );
  });
});

describe('render', () => {
  it('appends the chart to the host', () => {
    const { host } = setup();
    createSvgRenderer().render(scene(), host as unknown as Element);
    expect(host.children.map((c) => c.localName)).toStrictEqual(['svg']);
    expect(host.children[0]?.getAttribute('viewBox')).toBe('0 0 320 180');
  });

  it('attaches the interaction layer when the scene has hit regions', () => {
    const { host } = setup();
    createSvgRenderer().render(interactive, host as unknown as Element);
    expect(host.children.map((c) => c.className)).toContain('mdv-tooltip');
    expect(host.children.map((c) => c.className)).toContain('mdv-live');
  });

  it('attaches nothing when interaction is switched off', () => {
    const { host } = setup();
    createSvgRenderer({ interaction: false }).render(interactive, host as unknown as Element);
    expect(host.children.map((c) => c.localName)).toStrictEqual(['svg']);
    // The overlay is not drawn either, so a static export carries no dead rects.
    expect(host.children[0]?.querySelectorAll('[data-mdv-region]')).toHaveLength(0);
  });

  it('passes its options through to the build', () => {
    const { host } = setup();
    createSvgRenderer({ classes: false, idPrefix: 'x' }).render(
      scene(),
      host as unknown as Element,
    );
    const svg = host.children[0];
    expect(svg?.getAttribute('class')).toBeNull();
    expect(svg?.getAttribute('aria-labelledby')).toBe('x-title x-desc');
  });
});

describe('update patches rather than replaces (SPEC 22.3)', () => {
  it('keeps the same element, so focus and selection survive', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(scene(), host as unknown as Element);
    const before = host.children[0];
    handle.update(scene({ width: 640 }));
    expect(host.children[0]).toBe(before);
    expect(before?.getAttribute('width')).toBe('640');
  });

  it('survives a storm of updates without leaking chrome', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(interactive, host as unknown as Element);
    for (let i = 0; i < 60; i += 1) handle.update(scene({ width: 320 + i, hitIndex: [hit('r0')] }));
    // One tooltip and one live region, not sixty.
    expect(host.children.filter((c) => c.className === 'mdv-tooltip')).toHaveLength(1);
    expect(host.children.filter((c) => c.className === 'mdv-live')).toHaveLength(1);
  });

  it('leaves no listener behind on the element it keeps', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(interactive, host as unknown as Element);
    const svg = host.children[0];
    const after = svg?.listenerCount() ?? 0;
    for (let i = 0; i < 5; i += 1) handle.update(interactive);
    expect(svg?.listenerCount()).toBe(after);
  });

  it('re-indexes against the new scene, not the one it was rendered with', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(scene(), host as unknown as Element);
    handle.update(interactive);
    const svg = host.children[0];
    expect(svg?.querySelectorAll('[data-mdv-region]')).toHaveLength(2);
    // A scene that gained hit regions gains a working interaction layer too.
    expect(host.children.map((c) => c.className)).toContain('mdv-tooltip');
  });

  it('handles a scene that changes shape entirely', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(scene(), host as unknown as Element);
    handle.update(scene({ root: root([PLAIN_RECT, PLAIN_RECT]) }));
    handle.update(scene({ root: root([]) }));
    expect(host.children[0]?.localName).toBe('svg');
  });
});

describe('destroy', () => {
  it('removes the chart and everything the interaction layer added', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(interactive, host as unknown as Element);
    handle.destroy();
    expect(host.children).toHaveLength(0);
    expect(host.listenerCount()).toBe(0);
  });

  it('is safe to call after an update', () => {
    const { host } = setup();
    const handle = createSvgRenderer().render(interactive, host as unknown as Element);
    handle.update(scene());
    handle.destroy();
    expect(host.children).toHaveLength(0);
  });

  it('leaves the host reusable by a second render', () => {
    const { host } = setup();
    createSvgRenderer()
      .render(scene(), host as unknown as Element)
      .destroy();
    createSvgRenderer().render(interactive, host as unknown as Element);
    expect(host.children.map((c) => c.localName)).toStrictEqual(['svg', 'div', 'div']);
  });
});

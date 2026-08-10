/**
 * The DOM interaction layer (SPEC 7.5, 12.4).
 *
 * The property under test throughout is the normative one:
 *
 * > Keyboard focus MUST produce the same readout as hover.
 *
 * and the structural claim that makes it hold — that this layer does no
 * hit-testing. Every target it reacts to is a rect emitted from `Scene.hitIndex`,
 * so a pointer event that lands anywhere else must produce nothing at all. If
 * this file could be made to pass while the layer measured marks or sorted by
 * distance, DOM and Canvas would be free to drift.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { attachInteraction, toSvgElement } from '../src/index.js';
import type { InteractionHandlers } from '../src/index.js';
import type { Scene } from '@mdv/core';
import type { FakeDocument, FakeElement } from './fake-dom.js';
import { fakeDocument, fakeHost, installElementGlobal } from './fake-dom.js';
import { RECT, a11y, hit, root, scene } from './fixtures.js';

installElementGlobal();

/** A chart with two hit regions, which is the smallest scene that can traverse. */
function interactive(overrides: Partial<Scene> = {}): Scene {
  return scene({
    root: root([RECT]),
    hitIndex: [
      hit('r0', { x: 10, y: 20, anchor: { x: 22, y: 20 }, group: 'a', markNodeId: 'bar-0' }),
      hit('r1', {
        x: 40,
        y: 20,
        anchor: { x: 52, y: 30 },
        group: 'b',
        datumIndex: 1,
        readout: [{ label: 'Revenue', value: '1,850', swatch: '#2a78d6' }],
      }),
    ],
    ...overrides,
  });
}

interface Mounted {
  readonly doc: FakeDocument;
  readonly host: FakeElement;
  readonly svg: FakeElement;
  readonly detach: () => void;
  readonly events: string[];
  region(id: string): FakeElement;
  tooltip(): FakeElement | undefined;
  live(): FakeElement | undefined;
}

/** Render a scene into a detached host and attach the interaction layer. */
function mount(sceneArg: Scene, handlers: InteractionHandlers = {}): Mounted {
  const doc = new (fakeDocument().constructor as new () => FakeDocument)();
  const host = fakeHost(doc as unknown as Document) as unknown as FakeElement;
  const svg = toSvgElement(sceneArg, doc as unknown as Document) as unknown as FakeElement;
  host.appendChild(svg);
  // A 320×180 scene drawn into a 640×360 box: scale 2, no letterboxing.
  svg.box = { left: 0, top: 0, width: 640, height: 360 };

  const events: string[] = [];
  const recorded: InteractionHandlers = {
    onActivate: (id) => events.push(`activate:${id}`),
    onDeactivate: () => events.push('deactivate'),
    onSelect: (id) => events.push(`select:${id}`),
    onToggleTable: () => events.push('toggle'),
    ...handlers,
  };

  const detach = attachInteraction(host as unknown as Element, sceneArg, recorded);

  const byClass = (name: string): FakeElement | undefined =>
    host.children.find((c) => c.className === name);

  return {
    doc,
    host,
    svg,
    detach,
    events,
    region: (id) => {
      const found = svg.querySelector(`[data-mdv-region="${id}"]`);
      if (found === null) throw new Error(`no hit rect for ${id}`);
      return found;
    },
    tooltip: () => byClass('mdv-tooltip'),
    live: () => byClass('mdv-live'),
  };
}

function hover(m: Mounted, id: string): void {
  m.region(id).dispatchEvent({ type: 'pointerover' });
}

function key(
  m: Mounted,
  k: string,
  modifiers: Partial<Record<'altKey' | 'ctrlKey' | 'metaKey', boolean>> = {},
): void {
  m.svg.dispatchEvent({ type: 'keydown', key: k, ...modifiers });
}

describe('hover', () => {
  let m: Mounted;
  beforeEach(() => {
    m = mount(interactive());
  });

  it('shows the readout for the region under the pointer', () => {
    hover(m, 'r0');
    const tooltip = m.tooltip();
    expect(tooltip?.hidden).toBe(false);
    expect(tooltip?.textContent).toBe('1,200Revenue');
    expect(m.events).toStrictEqual(['activate:r0']);
  });

  it('puts the value before the label, since the value is the prominent part', () => {
    hover(m, 'r1');
    const rows = m.tooltip()?.children ?? [];
    expect(rows).toHaveLength(1);
    const cells = rows[0]?.children.map((c) => c.className) ?? [];
    // Swatch, then value, then series name (SPEC 7.5).
    expect(cells).toStrictEqual(['mdv-readout-swatch', 'mdv-readout-value', 'mdv-readout-label']);
  });

  it('carries the swatch colour as a style property, not a style string', () => {
    hover(m, 'r1');
    const swatch = m.tooltip()?.children[0]?.children[0];
    expect(swatch?.style.getPropertyValue('background-color')).toBe('#2a78d6');
    // No `style` attribute was ever assembled from data, so there is no CSS
    // injection path (SPEC 13.3).
    expect(swatch?.getAttribute('style')).toBeNull();
  });

  it('replaces the previous readout rather than appending to it', () => {
    hover(m, 'r0');
    hover(m, 'r1');
    expect(m.tooltip()?.children).toHaveLength(1);
    expect(m.tooltip()?.textContent).toBe('1,850Revenue');
  });

  it('anchors the tooltip through the xMidYMid meet transform', () => {
    hover(m, 'r0');
    // scale 2, no offset: anchor (22, 20) → (44px, 40px).
    expect(m.tooltip()?.style.getPropertyValue('left')).toBe('44px');
    expect(m.tooltip()?.style.getPropertyValue('top')).toBe('40px');
  });

  it('centres the remainder when the box is the wrong shape for the scene', () => {
    m.svg.box = { left: 0, top: 0, width: 640, height: 720 };
    hover(m, 'r0');
    // `meet` scales by the smaller ratio (2) and centres: offsetY = (720-360)/2.
    expect(m.tooltip()?.style.getPropertyValue('top')).toBe('220px');
  });

  it('does not announce on hover — a live region would fight the pointer', () => {
    hover(m, 'r0');
    expect(m.live()?.textContent).toBe('');
  });

  it('hides when the pointer leaves the chart', () => {
    hover(m, 'r0');
    m.host.dispatchEvent({ type: 'pointerleave' });
    expect(m.tooltip()?.hidden).toBe(true);
    expect(m.tooltip()?.children).toHaveLength(0);
    expect(m.events).toStrictEqual(['activate:r0', 'deactivate']);
  });

  it('stays open on pointer leave while the chart holds keyboard focus', () => {
    hover(m, 'r0');
    m.doc.activeElement = m.svg;
    m.host.dispatchEvent({ type: 'pointerleave' });
    expect(m.tooltip()?.hidden).toBe(false);
  });
});

describe('this layer does no hit-testing of its own (SPEC 20)', () => {
  it('ignores a pointer event on an element that is not a hit region', () => {
    const m = mount(interactive());
    const mark = m.svg.querySelector('[id="mdv-0-bar-0"]');
    expect(mark).not.toBeNull();
    mark?.dispatchEvent({ type: 'pointerover' });
    // The mark is drawn *under* the overlay; only the overlay is a target.
    expect(m.tooltip()?.hidden).toBe(true);
    expect(m.events).toStrictEqual([]);
  });

  it('ignores a hit rect whose id is not in the scene index', () => {
    const m = mount(interactive());
    m.region('r0').setAttribute('data-mdv-region', 'ghost');
    hover(m, 'ghost');
    expect(m.tooltip()?.hidden).toBe(true);
  });

  it('attaches nothing at all to a scene with no hit regions', () => {
    const m = mount(scene({ a11y: a11y({ focusOrder: [] }) }));
    expect(m.host.children).toHaveLength(1);
    expect(m.svg.listenerCount()).toBe(0);
    expect(() => m.detach()).not.toThrow();
  });
});

describe('keyboard (SPEC 12.4)', () => {
  let m: Mounted;
  beforeEach(() => {
    m = mount(interactive());
  });

  it('produces exactly the readout hover produces — the normative equivalence', () => {
    hover(m, 'r1');
    const byPointer = m.tooltip()?.toMarkup();
    m.host.dispatchEvent({ type: 'pointerleave' });

    key(m, 'End');
    const byKeyboard = m.tooltip()?.toMarkup();
    expect(byKeyboard).toBe(byPointer);
  });

  it('traverses focusOrder with the arrow keys in both axes', () => {
    key(m, 'ArrowRight');
    expect(m.tooltip()?.textContent).toBe('1,200Revenue');
    key(m, 'ArrowRight');
    expect(m.tooltip()?.textContent).toBe('1,850Revenue');
    key(m, 'ArrowLeft');
    expect(m.tooltip()?.textContent).toBe('1,200Revenue');
    key(m, 'ArrowDown');
    expect(m.tooltip()?.textContent).toBe('1,850Revenue');
    key(m, 'ArrowUp');
    expect(m.tooltip()?.textContent).toBe('1,200Revenue');
  });

  it('clamps at both ends instead of wrapping', () => {
    key(m, 'Home');
    key(m, 'ArrowLeft');
    expect(m.events.filter((e) => e.startsWith('activate'))).toStrictEqual([
      'activate:r0',
      'activate:r0',
    ]);
    key(m, 'End');
    key(m, 'ArrowRight');
    expect(m.tooltip()?.textContent).toBe('1,850Revenue');
  });

  it('moves between series with Page Up and Page Down', () => {
    key(m, 'Home');
    key(m, 'PageDown');
    // r1 is the first region of the next `group`.
    expect(m.tooltip()?.textContent).toBe('1,850Revenue');
    key(m, 'PageUp');
    expect(m.tooltip()?.textContent).toBe('1,200Revenue');
  });

  it('announces on the live region and points aria-activedescendant at the rect', () => {
    key(m, 'Home');
    expect(m.live()?.textContent).toBe('1,200Revenue');
    expect(m.svg.getAttribute('aria-activedescendant')).toBe('mdv-0-hit-r0');
  });

  it('rings the mark, not the larger hit rectangle, when a bbox is available', () => {
    const mark = m.svg.querySelector('[id="mdv-0-bar-0"]');
    // The hit rect is the 24 × 24 minimum; the bar itself is narrower.
    Object.assign(mark as object, {
      getBBox: () => ({ x: 12, y: 40.5, width: 24, height: 100.25 }),
    });
    key(m, 'Home');
    const ring = m.svg.children.find((c) => c.className === 'mdv-focus-ring');
    expect(ring?.getAttribute('x')).toBe('12');
    expect(ring?.getAttribute('height')).toBe('100.25');
  });

  it('falls back to the hit rect when the mark cannot be measured', () => {
    key(m, 'Home');
    const ring = m.svg.children.find((c) => c.className === 'mdv-focus-ring');
    expect(ring?.getAttribute('x')).toBe('10');
    expect(ring?.getAttribute('width')).toBe('24');
  });

  it('draws one focus ring however many times focus moves', () => {
    key(m, 'Home');
    key(m, 'End');
    key(m, 'Home');
    expect(m.svg.children.filter((c) => c.className === 'mdv-focus-ring')).toHaveLength(1);
  });

  it('selects with Enter and Space, and toggles the table with T', () => {
    key(m, 'Home');
    key(m, 'Enter');
    key(m, ' ');
    key(m, 'T');
    key(m, 't');
    expect(m.events.filter((e) => !e.startsWith('activate'))).toStrictEqual([
      'select:r0',
      'select:r0',
      'toggle',
      'toggle',
    ]);
  });

  it('Escape hides the readout but keeps the tab stop', () => {
    key(m, 'Home');
    key(m, 'Escape');
    expect(m.tooltip()?.hidden).toBe(true);
    expect(m.svg.getAttribute('tabindex')).toBe('0');
    expect(m.svg.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('hides when the chart loses focus', () => {
    key(m, 'Home');
    m.svg.dispatchEvent({ type: 'blur' });
    expect(m.tooltip()?.hidden).toBe(true);
  });

  it('claims the keys it handles and leaves the rest to the page', () => {
    const handled = { type: 'keydown', key: 'ArrowRight' };
    m.svg.dispatchEvent(handled);
    expect(handled).toHaveProperty('defaultPrevented', true);

    const ignored = { type: 'keydown', key: 'Tab' };
    m.svg.dispatchEvent(ignored);
    expect(ignored).toHaveProperty('defaultPrevented', false);
  });

  it('ignores a chorded key, which belongs to the browser or the OS', () => {
    key(m, 'ArrowRight', { ctrlKey: true });
    key(m, 'ArrowRight', { metaKey: true });
    key(m, 'ArrowRight', { altKey: true });
    expect(m.events).toStrictEqual([]);
  });
});

describe('the crosshair follows the chart family (SPEC 7.5)', () => {
  const crosshairOf = (m: Mounted): FakeElement | undefined =>
    m.svg.children.find((c) => c.className === 'mdv-crosshair');

  it('is drawn for a line chart, at the anchor and the full scene height', () => {
    const s = interactive();
    const m = mount({ ...s, meta: { ...s.meta, type: 'line' } });
    hover(m, 'r1');
    expect(crosshairOf(m)?.getAttribute('x1')).toBe('52');
    expect(crosshairOf(m)?.getAttribute('x2')).toBe('52');
    expect(crosshairOf(m)?.getAttribute('y2')).toBe('180');
  });

  it('is not drawn for a bar chart, where the mark itself is the target', () => {
    const m = mount(interactive());
    hover(m, 'r0');
    expect(crosshairOf(m)).toBeUndefined();
  });

  it('is removed again when the readout hides', () => {
    const s = interactive();
    const m = mount({ ...s, meta: { ...s.meta, type: 'area' } });
    hover(m, 'r0');
    key(m, 'Escape');
    expect(crosshairOf(m)).toBeUndefined();
  });
});

describe('untrusted strings reach the tooltip as text, never as markup (SPEC 13.3)', () => {
  it('inserts a hostile series name as a text node', () => {
    const s = interactive();
    const m = mount({
      ...s,
      hitIndex: [
        hit('r0', {
          readout: [{ label: '<img src=x onerror=alert(1)>', value: '</div><script>alert(1)' }],
        }),
      ],
    });
    hover(m, 'r0');
    const tooltip = m.tooltip();
    // The characters survive as *content* — nothing is mangled — and that is
    // safe precisely because they are a text node.
    expect(tooltip?.textContent).toContain('<script>alert(1)');

    // The structural claim, which is the one that matters: no element was
    // created from the string. Asserting on serialised markup would only prove
    // the comparison serialiser escapes, which is not the property under test.
    const descendants = tooltip?.querySelectorAll('span') ?? [];
    expect(descendants.map((e) => e.localName)).toStrictEqual(['span', 'span']);
    expect(tooltip?.querySelectorAll('img')).toHaveLength(0);
    expect(tooltip?.querySelectorAll('script')).toHaveLength(0);
    for (const node of descendants) {
      expect(node.getAttributeNames()).toStrictEqual(['class']);
    }
  });
});

describe('the disposer leaves the document as it found it', () => {
  it('removes every listener and every element it added', () => {
    const m = mount(interactive());
    hover(m, 'r0');
    key(m, 'Home');
    const before = m.svg.toMarkup();
    m.detach();

    expect(m.host.children.map((c) => c.localName)).toStrictEqual(['svg']);
    expect(m.svg.listenerCount()).toBe(0);
    expect(m.host.listenerCount()).toBe(0);
    expect(m.svg.getAttribute('aria-activedescendant')).toBeNull();
    // The chart itself is untouched apart from the attribute it set.
    expect(before).toContain('aria-activedescendant');
  });

  it('is inert afterwards, so a stale handle cannot resurrect a tooltip', () => {
    const m = mount(interactive());
    const tooltip = m.tooltip();
    m.detach();
    hover(m, 'r0');
    expect(tooltip?.hidden).toBe(true);
    expect(m.events).toStrictEqual([]);
  });

  it('restores the container position it borrowed', () => {
    const m = mount(interactive());
    m.doc.defaultView = { getComputedStyle: () => ({ position: 'static' }) };
    const detach = attachInteraction(m.host as unknown as Element, interactive());
    expect(m.host.style.position).toBe('relative');
    detach();
    expect(m.host.style.position).toBe('');
  });

  it('leaves a container that was already positioned alone', () => {
    const m = mount(interactive());
    m.host.style.setProperty('position', 'absolute');
    m.doc.defaultView = { getComputedStyle: () => ({ position: 'absolute' }) };
    const detach = attachInteraction(m.host as unknown as Element, interactive());
    detach();
    expect(m.host.style.position).toBe('absolute');
  });
});

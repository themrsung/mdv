/**
 * Virtualisation and measurement on the server (SPEC 22.3).
 *
 * > Blocks below the fold render a **correctly-sized placeholder** and mount on
 * > `IntersectionObserver` … `renderPolicy: 'eager'` disables this for printing.
 * > … Server rendering works … markup MUST match.
 *
 * Those two requirements are in tension, and the resolution is
 * `useSyncExternalStore`'s server snapshot: the server has no viewport, so it
 * renders everything, and the *hydration* render is handed the same value. This
 * file pins that behaviour — a regression to `useState(false)` would show up as
 * a document of empty boxes here, and as a hydration mismatch in a browser.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement, useRef, type ReactElement } from 'react';
import { MdvDocument, MdvProvider, useElementSize, useVisible } from '../src/index.js';
import { TWO_BLOCKS } from './fixtures.js';

function render(policy: 'lazy' | 'eager'): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy={policy} unstyled>
      <MdvDocument source={TWO_BLOCKS} />
    </MdvProvider>,
  );
}

describe('the server renders every block', () => {
  it('under the lazy policy, because the server has no viewport', () => {
    const html = render('lazy');
    expect(html.match(/<svg/g) ?? []).toHaveLength(2);
    expect(html).not.toContain('mdv-placeholder');
  });

  it('under the eager policy, which is what printing needs', () => {
    expect(render('eager')).toBe(render('lazy'));
  });

  it('so the two policies cannot produce different markup to hydrate against', () => {
    expect(render('lazy')).toBe(render('eager'));
  });
});

describe('useVisible on the server', () => {
  function Probe(): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const visible = useVisible(ref, { enabled: true });
    return <div ref={ref} data-visible={String(visible)} />;
  }

  it('reports visible, which is the server snapshot', () => {
    expect(renderToStaticMarkup(createElement(Probe))).toContain('data-visible="true"');
  });

  it('reports visible when virtualisation is off', () => {
    function Off(): ReactElement {
      const ref = useRef<HTMLDivElement | null>(null);
      return <div ref={ref} data-visible={String(useVisible(ref, { enabled: false }))} />;
    }
    expect(renderToStaticMarkup(createElement(Off))).toContain('data-visible="true"');
  });
});

describe('useElementSize on the server', () => {
  function Probe({ w, h }: { w: number; h: number }): ReactElement {
    const ref = useRef<HTMLDivElement | null>(null);
    const size = useElementSize(ref, { fallback: { width: w, height: h } });
    return <div ref={ref} data-w={String(size.width)} data-h={String(size.height)} />;
  }

  it('returns the fallback, never a measurement', () => {
    // A measurement during render is the hydration mismatch this hook exists to
    // avoid; on the server there is nothing to measure and it must say so.
    const html = renderToStaticMarkup(<Probe w={640} h={480} />);
    expect(html).toContain('data-w="640"');
    expect(html).toContain('data-h="480"');
  });

  it('defaults to zero, which the caller reads as "not measured yet"', () => {
    function Bare(): ReactElement {
      const ref = useRef<HTMLDivElement | null>(null);
      const size = useElementSize(ref);
      return <div ref={ref} data-w={String(size.width)} />;
    }
    expect(renderToStaticMarkup(createElement(Bare))).toContain('data-w="0"');
  });
});

describe('the fallback width', () => {
  it('is what the server lays out at, and it is configurable', () => {
    const at = (width: number): string =>
      renderToStaticMarkup(
        <MdvProvider renderPolicy="eager" unstyled width={width}>
          <MdvDocument source={TWO_BLOCKS} />
        </MdvProvider>,
      );
    expect(at(800)).toContain('viewBox="0 0 800 300"');
    expect(at(1024)).toContain('viewBox="0 0 1024 300"');
  });
});

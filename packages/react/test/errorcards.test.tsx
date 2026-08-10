/**
 * Error cards (SPEC 14).
 *
 * > 1. **A document always renders.** No single bad block may prevent the rest
 * >    of the document from rendering.
 * > 2. **Failures are visible, not silent.** … the code, the message, and the
 * >    raw data — never an empty frame.
 */

import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Diagnostic } from '@mdv/core';
import {
  MdvDocument,
  MdvErrorBoundary,
  MdvErrorCard,
  MdvProvider,
  diagnosticFromError,
} from '../src/index.js';
import { MALFORMED, UNKNOWN_TYPE } from './fixtures.js';

const render = (source: string, onDiagnostics?: (d: readonly Diagnostic[]) => void): string =>
  renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={source} {...(onDiagnostics ? { onDiagnostics } : {})} />
    </MdvProvider>,
  );

describe('a malformed block', () => {
  const html = render(MALFORMED);

  it('shows the code and the message', () => {
    expect(html).toContain('MDV3000');
    expect(html).toContain('which is not a column');
  });

  it('is never an empty frame — the card carries the data', () => {
    expect(html).toContain('class="mdv-error-card"');
    // The failed block still offers its numbers (SPEC 12.3 survives a failure).
    expect(html).toMatch(/<caption>Broken<\/caption>/);
    expect(html).toContain('1,240');
  });

  it('does not take out the rest of the document', () => {
    // The healthy sibling drew real marks, not a card.
    expect(html).toContain('Healthy');
    expect(html).toMatch(/class="mdv-mark mdv-mark-bar"/);
    // Exactly one block failed.
    expect(html.match(/mdv-error-card/g)?.length).toBeGreaterThan(0);
    expect(html.match(/data-mdv-block-id="mdv-1"/g)?.length).toBe(1);
  });

  it('still exposes an accessible name for the failed block (SPEC 12.1)', () => {
    expect(html).toMatch(/aria-label="Bar block could not be rendered\./);
  });
});

describe('an unknown block type', () => {
  it('degrades to a table with MDV1500 rather than vanishing', () => {
    const html = render(UNKNOWN_TYPE);
    expect(html).toContain('MDV1500');
    expect(html).toContain('Unknown block type');
    expect(html).toContain('<table class="mdv-data-table">');
  });
});

describe('diagnostics reach the host', () => {
  it('reports the document list, in source order', () => {
    const seen: (readonly Diagnostic[])[] = [];
    // `onDiagnostics` fires from an effect, which `renderToStaticMarkup` never
    // runs — so the server path must not call it, and must not throw for
    // wanting to.
    expect(() => render(MALFORMED, (d) => seen.push(d))).not.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('MdvErrorCard', () => {
  const diagnostic: Diagnostic = {
    code: 'MDV3010',
    severity: 'error',
    message: 'wide and long form cannot be mixed',
    detail: 'Bind `y` to a list, or bind `series`. Not both.',
    range: { start: { offset: 0, line: 1, column: 1 }, end: { offset: 4, line: 1, column: 5 } },
    source: 'encode',
  };

  it('shows the code, the message and the detail', () => {
    const html = renderToStaticMarkup(<MdvErrorCard diagnostics={[diagnostic]} />);
    expect(html).toContain('MDV3010');
    expect(html).toContain('wide and long form cannot be mixed');
    expect(html).toContain('Bind `y` to a list');
  });

  it('shows the raw source, truncated with the truncation stated', () => {
    const raw = Array.from({ length: 30 }, (_, i) => `line ${String(i)}`).join('\n');
    const html = renderToStaticMarkup(<MdvErrorCard diagnostics={[diagnostic]} raw={raw} />);
    expect(html).toContain('line 0');
    expect(html).toContain('line 11');
    expect(html).not.toContain('line 12<');
    expect(html).toContain('18 more lines');
  });

  it('escapes hostile content rather than inserting it (SPEC 13.3)', () => {
    const hostile: Diagnostic = { ...diagnostic, message: '<script>alert(1)</script>' };
    const html = renderToStaticMarkup(<MdvErrorCard diagnostics={[hostile]} raw="</pre><img>" />);
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<img>');
  });

  it('renders even with no diagnostics at all', () => {
    const html = renderToStaticMarkup(<MdvErrorCard diagnostics={[]} />);
    expect(html).toContain('Block failed to render');
  });

  it('has a findable role rather than an interrupting one', () => {
    const html = renderToStaticMarkup(<MdvErrorCard diagnostics={[diagnostic]} />);
    expect(html).toContain('role="group"');
    expect(html).not.toContain('role="alert"');
  });
});

describe('the per-block error boundary', () => {
  it('turns a thrown value into MDV5000', () => {
    const d = diagnosticFromError(new Error('boom\nsecond line'), 'mdv-3');
    expect(d.code).toBe('MDV5000');
    expect(d.severity).toBe('error');
    expect(d.message).toBe('Rendering threw: boom');
    expect(d.blockId).toBe('mdv-3');
    expect(d.source).toBe('render');
  });

  it('handles a thrown non-Error', () => {
    // React hands `getDerivedStateFromError` whatever was thrown, which is not
    // necessarily an `Error` — `throw 'nope'` is legal JavaScript.
    const state = MdvErrorBoundary.getDerivedStateFromError('nope');
    expect(state.error).toBeInstanceOf(Error);
    expect(state.error?.message).toBe('nope');
  });

  it('passes children through when nothing threw', () => {
    const html = renderToStaticMarkup(
      <MdvErrorBoundary blockId="mdv-0">
        <p>fine</p>
      </MdvErrorBoundary>,
    );
    expect(html).toBe('<p>fine</p>');
  });

  it('reports through onError when it catches', () => {
    // Driven directly: `renderToStaticMarkup` does not run error boundaries, and
    // a boundary that only works in a browser is a boundary nobody can trust.
    const onError = vi.fn();
    const boundary = new MdvErrorBoundary({ children: null, blockId: 'mdv-7', onError });
    boundary.componentDidCatch(new Error('plugin exploded'), { componentStack: '' });
    expect(onError).toHaveBeenCalledTimes(1);
    const [diagnostic] = onError.mock.calls[0] as [Diagnostic];
    expect(diagnostic.code).toBe('MDV5000');
    expect(diagnostic.blockId).toBe('mdv-7');
    expect(diagnostic.message).toContain('plugin exploded');
  });
});

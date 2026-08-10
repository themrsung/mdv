/**
 * The editor's page-break reader (SPEC 28.4).
 *
 * The engine hands `:::mdv-page` to the UI as a `raw` block — a slab of source
 * — and this is the function that decides whether to draw a page rule instead.
 * Two things matter. It must never claim a block it does not understand, because
 * the fallback view is the only thing standing between an author and silently
 * hidden source; and it must read the attributes the way the parser does, or the
 * rule would describe a page the exporter is not going to produce.
 */

import { describe, expect, it } from 'vitest';
import { readPageBreak } from '../blocks/page-break.js';

describe('what it recognises', () => {
  it('reads the marker form', () => {
    const view = readPageBreak(':::mdv-page{break=before}\n:::');
    expect(view?.edge).toBe('before');
    expect(view?.wrapping).toBe(false);
    expect(view?.body).toBe('');
  });

  it('reads the wrapping form, and keeps the body verbatim', () => {
    const view = readPageBreak(':::mdv-page{break=avoid}\n### Pricing\n\nBody\n:::');
    expect(view?.wrapping).toBe(true);
    expect(view?.body).toBe('### Pricing\n\nBody');
  });

  it('accepts a bare directive with no attributes', () => {
    expect(readPageBreak(':::mdv-page\n:::')?.edge).toBeNull();
  });

  it('accepts the optional label of SPEC 9.1 without mistaking it for an attribute', () => {
    const view = readPageBreak(':::mdv-page[Appendix] {break=after}\n:::');
    expect(view?.edge).toBe('after');
  });

  it('accepts more than three colons, and the matching longer close', () => {
    const view = readPageBreak('::::mdv-page{break=before}\n:::mdv-note\nx\n:::\n::::');
    expect(view?.edge).toBe('before');
    // The inner `:::` is content, not the close: only the last line ends it.
    expect(view?.body).toBe(':::mdv-note\nx\n:::');
  });

  it('draws a break the author has not finished typing', () => {
    // The engine hands over the opening line alone when the close is missing.
    const view = readPageBreak(':::mdv-page{break=before}');
    expect(view?.edge).toBe('before');
    expect(view?.wrapping).toBe(false);
  });
});

describe('what it refuses', () => {
  it('leaves other containers to the raw view', () => {
    expect(readPageBreak(':::mdv-note\nx\n:::')).toBeNull();
    expect(readPageBreak(':::mdv-pages\n:::')).toBeNull();
    expect(readPageBreak(':::mdv-page-two\n:::')).toBeNull();
  });

  it('is not fooled by a mention of the directive inside a block', () => {
    expect(readPageBreak('```\n:::mdv-page\n```')).toBeNull();
  });

  it('refuses trailing junk on the opening line rather than guessing', () => {
    expect(readPageBreak(':::mdv-page nonsense\n:::')).toBeNull();
  });
});

describe('attributes', () => {
  it('honours quotes, because the grammar allows them', () => {
    const view = readPageBreak(':::mdv-page{size="US Legal" orientation=landscape}\n:::');
    expect(view?.size).toBe('US Legal');
    expect(view?.orientation).toBe('landscape');
  });

  it('ignores an unrecognised value rather than failing (SPEC 15.2)', () => {
    const view = readPageBreak(':::mdv-page{break=sideways orientation=diagonal}\n:::');
    expect(view?.edge).toBeNull();
    expect(view?.orientation).toBeNull();
  });

  it('takes the last value of a repeated key, matching the parser', () => {
    expect(readPageBreak(':::mdv-page{break=before break=after}\n:::')?.edge).toBe('after');
  });

  it('skips a bare token instead of inventing a value for it', () => {
    const view = readPageBreak(':::mdv-page{landscape break=before}\n:::');
    expect(view?.edge).toBe('before');
    expect(view?.orientation).toBeNull();
  });

  it('passes any page size through — the size table lives in the exporter', () => {
    expect(readPageBreak(':::mdv-page{size=A3}\n:::')?.size).toBe('A3');
  });
});

describe('the label', () => {
  it('says where the page ends', () => {
    expect(readPageBreak(':::mdv-page{break=before}\n:::')?.label).toBe('Page break');
    expect(readPageBreak(':::mdv-page{break=after}\n:::')?.label).toBe('Page break after');
  });

  it('says what is being kept together, but only when there is content to keep', () => {
    expect(readPageBreak(':::mdv-page{break=avoid}\nBody\n:::')?.label).toBe('Keep together');
    expect(readPageBreak(':::mdv-page{break=avoid}\n:::')?.label).toBe('Page');
  });

  it('reports geometry, which persists past the directive (SPEC 28.4)', () => {
    expect(readPageBreak(':::mdv-page{size=A3 orientation=landscape}\n:::')?.label).toBe(
      'A3 landscape from here',
    );
    expect(readPageBreak(':::mdv-page{orientation=landscape}\n:::')?.label).toBe(
      'Landscape from here',
    );
  });

  it('combines a break with the geometry it introduces', () => {
    expect(readPageBreak(':::mdv-page{break=before orientation=landscape}\n:::')?.label).toBe(
      'Page break · Landscape from here',
    );
  });

  it('is never empty, so the block always has an accessible name', () => {
    expect(readPageBreak(':::mdv-page\n:::')?.label).toBe('Page');
  });
});

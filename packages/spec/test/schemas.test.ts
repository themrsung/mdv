/**
 * Appendix D, read back (SPEC Appendix D, SPEC 29.4).
 *
 * Two different things are pinned here and they fail for different reasons:
 *
 * 1. **The schema is complete enough to document.** Every property carries prose
 *    and exactly one example. A tool that shows an author what an attribute means
 *    can only be as good as the file it reads, and the file is easy to extend
 *    without remembering that.
 * 2. **The accessors say what the file says.** The expected values below are
 *    written out rather than computed from `BLOCK_SCHEMA`, because a test that
 *    derives its expectation the way the code does agrees with any bug they
 *    share. These lists are the ones `@mdv/lsp` used to keep by hand.
 */

import { describe, expect, it } from 'vitest';
import { BLOCK_SCHEMA, CLOSED_VALUES, COMMON_ATTRS, attrDoc, attrSchema } from '@mdv/spec';

/** Every common attribute, in the order Appendix D lists them. */
const EXPECTED_ATTRS = [
  'type',
  'title',
  'subtitle',
  'caption',
  'desc',
  'id',
  'data',
  'src',
  'integrity',
  'format',
  'fields',
  'transform',
  'width',
  'height',
  'aspect',
  'padding',
  'theme',
  'palette',
  'legend',
  'tooltip',
  'animate',
  'class',
  'fallback',
  'table',
  'row',
  'column',
  'columns',
  'shareX',
  'shareY',
  'facetHeight',
  'axis',
];

describe('schemas/common/block.json', () => {
  it('is the schema it says it is', () => {
    expect(BLOCK_SCHEMA.$id).toContain('block.json');
    expect(BLOCK_SCHEMA.patternProperties?.['^x-']).toBe(true);
  });

  it('lists every common attribute in schema order', () => {
    expect([...COMMON_ATTRS]).toEqual(EXPECTED_ATTRS);
  });

  it('documents every attribute it defines', () => {
    for (const name of COMMON_ATTRS) {
      const node = attrSchema(name);
      expect(node?.description, name).toBeTypeOf('string');
      expect(node?.description?.length ?? 0, name).toBeGreaterThan(0);
    }
  });

  it('gives every attribute exactly one example', () => {
    // One, not several: a hover has room for a line, and the first of a list is
    // a silent choice about which one matters.
    for (const name of COMMON_ATTRS) {
      expect(attrSchema(name)?.examples, name).toHaveLength(1);
    }
  });

  it('has nothing to say about a key it does not define', () => {
    expect(attrSchema('x-vendor')).toBeUndefined();
    expect(attrSchema('nonesuch')).toBeUndefined();
    expect(attrDoc('nonesuch')).toBeUndefined();
    // Not the Object prototype, either.
    expect(attrSchema('toString')).toBeUndefined();
    expect(attrSchema('constructor')).toBeUndefined();
  });
});

describe('CLOSED_VALUES', () => {
  it('names every attribute whose value set is closed, and only those', () => {
    expect(CLOSED_VALUES).toEqual({
      format: ['auto', 'table', 'csv', 'tsv', 'json', 'ndjson', 'columns', 'matrix'],
      legend: ['auto', 'top', 'right', 'bottom', 'left', 'inline', 'false'],
      tooltip: ['true', 'false'],
      animate: ['true', 'false'],
      table: ['details', 'visible', 'hidden', 'none'],
      shareX: ['true', 'false'],
      shareY: ['true', 'false'],
    });
  });

  it('counts a boolean as the enum of two that it is', () => {
    // `animate` is `{"type": "boolean"}` with no enum anywhere in it.
    expect(CLOSED_VALUES['animate']).toEqual(['true', 'false']);
  });

  it('reaches into a union without inventing a member', () => {
    // `legend` is `enum | object`: the enum closes, the object does not, and
    // the enum's members include the boolean `false`, written as an author does.
    expect(CLOSED_VALUES['legend']).toContain('false');
    expect(CLOSED_VALUES['legend']).not.toContain('object');
  });

  it('says nothing about an open value', () => {
    expect(CLOSED_VALUES['title']).toBeUndefined();
    expect(CLOSED_VALUES['palette']).toBeUndefined();
    expect(CLOSED_VALUES['padding']).toBeUndefined();
  });
});

describe('attrDoc', () => {
  it('reads a plain string attribute', () => {
    expect(attrDoc('caption')).toEqual({
      name: 'caption',
      type: 'string',
      description:
        'Rendered below the plot; the figure caption in PDF. A caption makes the block a figure.',
      example: "caption: 'Source: the billing export.'",
    });
  });

  it('quotes an example only when the header syntax needs it', () => {
    // A colon inside the value would end the key, so it is quoted…
    expect(attrDoc('caption')?.example).toContain("'Source: the billing export.'");
    // …and a value that reads as itself is left alone.
    expect(attrDoc('title')?.example).toBe('title: Quarterly revenue');
    expect(attrDoc('integrity')?.example).toBe(
      'integrity: sha256-BpfBw7ivV8q2jLiT13fxDYAe2tJllusRSZ273h2nFSE=',
    );
  });

  it('names an enum by its members and repeats them as values', () => {
    const doc = attrDoc('table');
    expect(doc?.type).toBe('details | visible | hidden | none');
    expect(doc?.values).toEqual(['details', 'visible', 'hidden', 'none']);
    expect(doc?.default).toBe('details');
  });

  it('names a referenced type by the schema it points at', () => {
    expect(attrDoc('width')).toEqual({
      name: 'width',
      type: 'dimension',
      default: '100%',
      description: 'Outer width; `100%` fills the container (SPEC 8.1).',
      example: 'width: 320px',
    });
  });

  it('spells a union as a union', () => {
    expect(attrDoc('palette')?.type).toBe('string | string[]');
    expect(attrDoc('padding')?.type).toBe('dimension | object');
    expect(attrDoc('tooltip')?.type).toBe('boolean | string[]');
    expect(attrDoc('legend')?.type).toBe(
      'auto | top | right | bottom | left | inline | false | object',
    );
  });

  it('writes a structured example in MDV syntax, not in JSON', () => {
    expect(attrDoc('padding')?.example).toBe('padding: {top: 16, bottom: 24}');
    expect(attrDoc('padding')?.default).toBe('{top: 8, right: 8, bottom: 8, left: 8}');
    expect(attrDoc('axis')?.example).toBe('axis: {y: {grid: true}}');
    // The format spec is quoted because a bare `,` would end the entry.
    expect(attrDoc('fields')?.example).toBe("fields: {revenue: {type: number, format: '$,.0f'}}");
    expect(attrDoc('transform')?.example).toBe("transform: [{filter: 'revenue > 0'}]");
    expect(attrDoc('palette')?.example).toBe("palette: ['#1f77b4', '#ff7f0e']");
  });

  it('is an array of a union, not a union with an array', () => {
    expect(attrDoc('transform')?.type).toBe('object[]');
    expect(attrDoc('columns')?.type).toBe('integer');
    expect(attrDoc('aspect')?.type).toBe('number');
  });

  it('omits what the schema does not say', () => {
    const doc = attrDoc('subtitle');
    expect(doc?.default).toBeUndefined();
    expect(doc?.values).toBeUndefined();
    expect(Object.keys(doc ?? {})).toEqual(['name', 'type', 'description', 'example']);
  });

  it('keeps a false default, which is a default like any other', () => {
    // `shareY` defaults to true; the point is that a falsy default survives.
    expect(attrDoc('shareY')?.default).toBe('true');
    expect(attrDoc('shareY')?.example).toBe('shareY: false');
  });
});

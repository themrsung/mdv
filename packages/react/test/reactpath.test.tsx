/**
 * The `toReactElements` path must not lose attributes (SPEC 20, 22.3).
 *
 * React silently drops a prop it does not recognise — with a `console.error` in
 * development and nothing at all in production. That failure mode is exactly the
 * one SPEC 20 forbids: the SVG string would carry `font-variant-numeric` and the
 * React tree would not, so the same scene would render two ways.
 *
 * So this file watches `console.error` while a whole document renders, and
 * compares the React output against the string serialiser attribute by
 * attribute.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { toSvgString } from '@mdv/render-svg';
import { layoutBlock, makeLayoutContext } from '@mdv/core/layout/index.js';
import { createChartRegistry } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import { createTableMetrics } from '@mdv/core/metrics/index.js';
import { parse } from '@mdv/parser';
import { MdvChart, MdvDocument, MdvProvider, composeSync } from '../src/index.js';
import { GOOD, MALFORMED } from './fixtures.js';

let errors: unknown[][];

beforeEach(() => {
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderDocument(source: string): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={source} />
    </MdvProvider>,
  );
}

describe('React accepts everything the scene emits', () => {
  it('renders a healthy document with no React warnings', () => {
    renderDocument(GOOD);
    expect(errors).toEqual([]);
  });

  it('renders a failing document with no React warnings', () => {
    renderDocument(MALFORMED);
    expect(errors).toEqual([]);
  });
});

describe('the React tree matches the string serialiser', () => {
  it('emits the same attributes on the same elements', () => {
    const doc = composeSync(parse(GOOD));
    const block = doc.blocks[0];
    expect(block).toBeDefined();
    if (block === undefined) return;

    const scene = layoutBlock(
      block,
      { width: 800, height: 300 },
      makeLayoutContext({ theme: block.theme, blockIndex: 0, metrics: createTableMetrics() }),
      createChartRegistry(builtinChartTypes),
    );

    const asString = toSvgString(scene);
    const asReact = renderToStaticMarkup(
      <MdvChart scene={scene} interactive={false} showTableView={false} />,
    );

    expect(errors).toEqual([]);

    // Every attribute name the serialiser emits must also appear in the React
    // markup. Values can differ in quoting and ordering; a *missing name* is the
    // failure this is looking for.
    const names = new Set([...asString.matchAll(/\s([a-zA-Z-]+)="/g)].map((m) => m[1]));
    for (const name of names) {
      if (name === undefined) continue;
      expect(asReact, `attribute ${name} is missing from the React tree`).toContain(`${name}=`);
    }
  });
});

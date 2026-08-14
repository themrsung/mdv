/**
 * Every Visuals starter must draw.
 *
 * A menu item whose whole job is to show a chart has failed if the first thing
 * the writer sees is a diagnostic. That is Bug 11 in the authoring log: `/pie`
 * inserted a block whose header named only `title`, and `pie` requires both a
 * `category` and a `value` channel, so the starter rendered
 * "MDV3000: `category` is required by `pie` and is not bound."
 *
 * The check has to be the real pipeline, because the failure is a *resolve*
 * failure: the block parses, serialises and round-trips perfectly, and only the
 * chart's channel contract rejects it. So each starter's commands are run
 * through the engine exactly as the menu runs them, the document is serialised
 * the way the Source pane serialises it, and the result goes through the same
 * `@mdv/react/auto` render the preview uses — where a failure is an error card
 * rather than an exception (SPEC 14.1: a bad block never takes out a document).
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MdvDocument, MdvProvider } from '@mdv/react/auto';
import { editorFor, source } from '../../engine/__tests__/helpers.js';
import { SLASH_ITEMS, type SlashItem } from '../menus/slash-items.js';

/** The `.mdv` source a starter leaves behind, in an otherwise empty document. */
function sourceFor(item: SlashItem): string {
  if (item.effect.kind !== 'commands') throw new Error(`${item.id} runs no commands`);
  const editor = editorFor('');
  for (const command of item.effect.run()) editor.dispatch(command);
  return source(editor.getDocument());
}

/**
 * The preview's markup for a source string.
 *
 * `renderPolicy="eager"` because the suite runs without a DOM, so the
 * below-the-fold virtualisation that the browser would resolve on scroll would
 * otherwise leave every block unrendered and every assertion vacuous.
 */
function markupFor(text: string): string {
  return renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={text} />
    </MdvProvider>,
  );
}

const VISUALS = SLASH_ITEMS.filter((item) => item.group === 'Visuals');

describe('the Visuals starters', () => {
  it('are the five the menu advertises', () => {
    // A new one must be added below deliberately, not silently skipped.
    expect(VISUALS.map((item) => item.id)).toEqual([
      'chart-bar',
      'chart-line',
      'chart-pie',
      'metric',
      'mdv-table',
    ]);
  });

  for (const item of VISUALS) {
    describe(item.id, () => {
      it('inserts one mdv fence', () => {
        const text = sourceFor(item);
        expect(text.match(/^```mdv /gm)?.length).toBe(1);
      });

      it('renders without a diagnostic', () => {
        const html = markupFor(sourceFor(item));
        // The error card carries the code in its own element, so an assertion
        // that fails says *which* contract the starter broke.
        expect(html, html.slice(html.indexOf('mdv-error-card'), 400)).not.toContain(
          'mdv-error-card',
        );
      });

      it('draws something', () => {
        const html = markupFor(sourceFor(item));
        expect(html.includes('<svg') || html.includes('<table')).toBe(true);
      });
    });
  }
});

describe('the pie starter in particular', () => {
  it('binds both channels pie requires', () => {
    const text = sourceFor(SLASH_ITEMS.find((item) => item.id === 'chart-pie') as SlashItem);
    expect(text).toContain('category: region');
    expect(text).toContain('value: revenue');
  });

  it('names columns its data actually has', () => {
    // The channels have to match the starter table, or the block resolves to a
    // different diagnostic instead of the one that was fixed.
    const text = sourceFor(SLASH_ITEMS.find((item) => item.id === 'chart-pie') as SlashItem);
    expect(text).toContain('region | revenue');
  });
});

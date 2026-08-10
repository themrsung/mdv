/**
 * The table view (SPEC 12.3) and the <kbd>T</kbd> shortcut (SPEC 12.4).
 *
 * > **Every visual block MUST make its underlying data reachable as a table.**
 *
 * The toggle is exercised through the pure classifier the component uses, which
 * is the whole of the decision; there is no DOM in this environment and a test
 * that needed one would be testing jsdom.
 */

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { A11yTable } from '@mdv/core';
import { MdvDocument, MdvProvider, MdvTableView } from '../src/index.js';
import { applyShortcut, classifyKey, isTypingTarget } from '../src/internal/keyboard.js';
import { GOOD } from './fixtures.js';

const TABLE: A11yTable = {
  caption: 'Revenue by quarter',
  columns: [
    { name: 'Quarter', type: 'category', align: 'left' },
    { name: 'Revenue', type: 'number', align: 'right' },
  ],
  rows: [
    ['Q1', '1,240'],
    ['Q2', '1,500'],
  ],
  presentation: 'details',
};

const KEY = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };

describe('MdvTableView', () => {
  it('is a real table, not a visually-hidden dump', () => {
    const html = renderToStaticMarkup(<MdvTableView table={TABLE} />);
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('<table class="mdv-data-table">');
    expect(html).toContain('<caption>Revenue by quarter</caption>');
    expect(html).not.toContain('mdv-visually-hidden');
  });

  it('scopes its headers (SPEC 12.3)', () => {
    const html = renderToStaticMarkup(<MdvTableView table={TABLE} />);
    expect(html).toContain('<th scope="col" class="mdv-align-left">Quarter</th>');
    expect(html).toContain('<th scope="col" class="mdv-align-right">Revenue</th>');
    // The category column identifies its row, so it is a row header.
    expect(html).toContain('<th scope="row" class="mdv-align-left">Q1</th>');
    expect(html).toContain('<td class="mdv-align-right">1,240</td>');
  });

  it('does not make a quantity into a row header', () => {
    const numeric: A11yTable = {
      ...TABLE,
      columns: [
        { name: 'X', type: 'number', align: 'right' },
        { name: 'Y', type: 'number', align: 'right' },
      ],
      rows: [['1', '2']],
    };
    const html = renderToStaticMarkup(<MdvTableView table={numeric} />);
    expect(html).not.toContain('scope="row"');
  });

  it('shows formatted values verbatim — it never re-formats', () => {
    // Layout formatted these once; a second formatter here is how the screen and
    // the PDF start disagreeing.
    const html = renderToStaticMarkup(<MdvTableView table={TABLE} />);
    expect(html).toContain('1,240');
    expect(html).toContain('1,500');
  });

  it('respects the open state', () => {
    expect(renderToStaticMarkup(<MdvTableView table={TABLE} open={false} />)).not.toContain(
      'open=',
    );
    expect(renderToStaticMarkup(<MdvTableView table={TABLE} open />)).toContain('open=""');
  });

  it('honours every presentation of SPEC 12.3', () => {
    const visible = renderToStaticMarkup(
      <MdvTableView table={{ ...TABLE, presentation: 'visible' }} />,
    );
    expect(visible).toContain('<table');
    expect(visible).not.toContain('<details');

    const hidden = renderToStaticMarkup(
      <MdvTableView table={{ ...TABLE, presentation: 'hidden' }} />,
    );
    expect(hidden).toContain('mdv-visually-hidden');
    expect(hidden).toContain('<table');

    const none = renderToStaticMarkup(<MdvTableView table={{ ...TABLE, presentation: 'none' }} />);
    expect(none).toBe('');
  });

  it('renders short rows as empty cells rather than as `undefined`', () => {
    const ragged: A11yTable = { ...TABLE, rows: [['Q1']] };
    const html = renderToStaticMarkup(<MdvTableView table={ragged} />);
    expect(html).not.toContain('undefined');
    expect(html).toContain('<td class="mdv-align-right"></td>');
  });
});

describe('the table view inside a document', () => {
  const html = renderToStaticMarkup(
    <MdvProvider renderPolicy="eager" unstyled>
      <MdvDocument source={GOOD} />
    </MdvProvider>,
  );

  it('follows the chart, collapsed, with the block data in it', () => {
    expect(html).toContain('<details class="mdv-table-view"');
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html.indexOf('</svg>')).toBeLessThan(html.indexOf('<details'));
    expect(html).toContain('1,893');
  });
});

describe('the T shortcut (SPEC 12.4)', () => {
  const collapsed = { presentation: 'details' as const, tableOpen: false };

  it('toggles the table view', () => {
    expect(classifyKey({ ...KEY, key: 't' }, collapsed)).toBe('toggle-table');
    expect(classifyKey({ ...KEY, key: 'T', shiftKey: true }, collapsed)).toBe('toggle-table');
    expect(applyShortcut('toggle-table', false)).toBe(true);
    expect(applyShortcut('toggle-table', true)).toBe(false);
  });

  it('never steals a browser shortcut', () => {
    expect(classifyKey({ ...KEY, key: 't', ctrlKey: true }, collapsed)).toBe('none');
    expect(classifyKey({ ...KEY, key: 't', metaKey: true }, collapsed)).toBe('none');
    expect(classifyKey({ ...KEY, key: 't', altKey: true }, collapsed)).toBe('none');
  });

  it('never steals a keystroke from a text field', () => {
    expect(classifyKey({ ...KEY, key: 't' }, { ...collapsed, typing: true })).toBe('none');
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('applies only where there is something to collapse', () => {
    for (const presentation of ['visible', 'hidden', 'none'] as const) {
      expect(classifyKey({ ...KEY, key: 't' }, { presentation, tableOpen: false })).toBe('none');
    }
  });

  it('closes an open table on Escape, and is inert otherwise', () => {
    expect(classifyKey({ ...KEY, key: 'Escape' }, { ...collapsed, tableOpen: true })).toBe(
      'close-table',
    );
    expect(classifyKey({ ...KEY, key: 'Escape' }, collapsed)).toBe('none');
    expect(applyShortcut('close-table', true)).toBe(false);
  });

  it('leaves every other key to the interaction layer', () => {
    for (const key of [
      'ArrowRight',
      'ArrowLeft',
      'Home',
      'End',
      'PageUp',
      'PageDown',
      'Enter',
      ' ',
    ]) {
      expect(classifyKey({ ...KEY, key }, collapsed)).toBe('none');
    }
  });

  it('leaves the open state alone for a key it did not claim', () => {
    expect(applyShortcut('none', true)).toBe(true);
    expect(applyShortcut('none', false)).toBe(false);
  });
});

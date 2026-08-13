/**
 * The slash menu's catalogue and its matcher.
 *
 * Pure: an item is a label plus the commands it runs, and matching is a
 * function from a query string to an ordered list. Ranking is deterministic —
 * a numeric score, then the catalogue's own order as the tie-break — so the
 * same keystrokes always produce the same first item and muscle memory works.
 * No `localeCompare`, which would reorder the menu by the machine's locale.
 */

import type { Command } from '../../engine/index.js';
import { commands } from '../../engine/index.js';

/** What choosing an entry does. */
export type SlashEffect =
  | { readonly kind: 'commands'; run(): readonly Command[] }
  /** Needs the host: opens a file picker, then goes through image ingestion. */
  | { readonly kind: 'pickImage' };

export interface SlashItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly group: 'Text' | 'Lists' | 'Blocks' | 'Visuals';
  readonly keywords: readonly string[];
  readonly effect: SlashEffect;
}

function fromCommands(...factories: readonly (() => Command)[]): SlashEffect {
  return { kind: 'commands', run: () => factories.map((factory) => factory()) };
}

/** A starter body for a visual block, so the preview has something to show. */
const STARTER_BAR = ['title: Revenue by quarter', 'x: quarter', 'y: revenue'].join('\n');

const STARTER_DATA = [
  'quarter | revenue',
  'Q1      |    1240',
  'Q2      |    1516',
  'Q3      |    1402',
  'Q4      |    1893',
].join('\n');

export const SLASH_ITEMS: readonly SlashItem[] = [
  {
    id: 'paragraph',
    label: 'Text',
    hint: 'Plain paragraph',
    group: 'Text',
    keywords: ['paragraph', 'body', 'plain'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'paragraph' })),
  },
  {
    id: 'h1',
    label: 'Heading 1',
    hint: 'Top-level section',
    group: 'Text',
    keywords: ['title', 'h1', '#'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'heading', level: 1 })),
  },
  {
    id: 'h2',
    label: 'Heading 2',
    hint: 'Section',
    group: 'Text',
    keywords: ['h2', '##'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'heading', level: 2 })),
  },
  {
    id: 'h3',
    label: 'Heading 3',
    hint: 'Subsection',
    group: 'Text',
    keywords: ['h3', '###'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'heading', level: 3 })),
  },
  {
    id: 'quote',
    label: 'Quote',
    hint: 'Block quote',
    group: 'Text',
    keywords: ['blockquote', 'citation', '>'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'quote' })),
  },
  {
    id: 'bullet',
    label: 'Bulleted list',
    hint: 'Unordered items',
    group: 'Lists',
    keywords: ['ul', 'unordered', 'bullet', '-'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'bulletList' })),
  },
  {
    id: 'ordered',
    label: 'Numbered list',
    hint: 'Ordered items',
    group: 'Lists',
    keywords: ['ol', 'ordered', 'number', '1.'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'orderedList' })),
  },
  {
    id: 'code',
    label: 'Code block',
    hint: 'Fenced, monospaced',
    group: 'Blocks',
    keywords: ['pre', 'fence', '```'],
    effect: fromCommands(() => commands.setBlockType({ kind: 'code' })),
  },
  {
    id: 'table',
    label: 'Table',
    hint: '3 columns, 2 rows',
    group: 'Blocks',
    keywords: ['grid', 'cells', 'gfm'],
    effect: fromCommands(() => commands.insertTable(3, 2)),
  },
  {
    id: 'divider',
    label: 'Divider',
    hint: 'Thematic break',
    group: 'Blocks',
    keywords: ['hr', 'rule', 'separator', '---'],
    effect: fromCommands(() => commands.insertThematicBreak()),
  },
  {
    id: 'image',
    label: 'Image…',
    hint: 'Choose a file to embed',
    group: 'Blocks',
    keywords: ['picture', 'photo', 'png', 'jpeg', 'paste'],
    effect: { kind: 'pickImage' },
  },
  {
    id: 'chart-bar',
    label: 'Bar chart',
    hint: 'mdv bar — magnitude by category',
    group: 'Visuals',
    keywords: ['mdv', 'column', 'visual'],
    effect: fromCommands(() =>
      commands.insertVisualBlock('bar', { header: STARTER_BAR, data: STARTER_DATA }),
    ),
  },
  {
    id: 'chart-line',
    label: 'Line chart',
    hint: 'mdv line — change over a continuous domain',
    group: 'Visuals',
    keywords: ['mdv', 'trend', 'series', 'visual'],
    effect: fromCommands(() =>
      commands.insertVisualBlock('line', {
        header: 'title: Trend\nx: quarter\ny: revenue',
        data: STARTER_DATA,
      }),
    ),
  },
  {
    id: 'chart-pie',
    label: 'Pie chart',
    hint: 'mdv pie — parts of one whole',
    group: 'Visuals',
    keywords: ['mdv', 'donut', 'share', 'visual'],
    effect: fromCommands(() =>
      commands.insertVisualBlock('pie', {
        // `pie` requires both channels; a starter that names only the title
        // renders a diagnostic instead of a chart. See charts/src/pie.ts.
        header: 'title: Share by region\ncategory: region\nvalue: revenue',
        data: 'region | revenue\nAPAC   | 4210\nEMEA   | 3180',
      }),
    ),
  },
  {
    id: 'metric',
    label: 'Metric tile',
    hint: 'mdv metric — one number',
    group: 'Visuals',
    keywords: ['mdv', 'kpi', 'stat', 'visual'],
    effect: fromCommands(() =>
      commands.insertVisualBlock('metric', {
        header: 'label: Monthly recurring revenue\nvalue: 1284000\nformat: "$~s"',
        data: null,
      }),
    ),
  },
  {
    id: 'mdv-table',
    label: 'Enhanced table',
    hint: 'mdv table — bars, heat, sparklines',
    group: 'Visuals',
    keywords: ['mdv', 'visual', 'columns'],
    effect: fromCommands(() =>
      commands.insertVisualBlock('table', {
        header: 'title: Summary',
        data: 'region | revenue\nAPAC   | 4210\nEMEA   | 3180',
      }),
    ),
  },
];

/** Score an item against a lower-cased query. Higher is better; 0 is no match. */
function score(item: SlashItem, query: string): number {
  const label = item.label.toLowerCase();
  if (label === query) return 100;
  if (label.startsWith(query)) return 80;
  for (const keyword of item.keywords) {
    const lower = keyword.toLowerCase();
    if (lower === query) return 70;
    if (lower.startsWith(query)) return 60;
  }
  if (label.includes(query)) return 40;
  for (const keyword of item.keywords) {
    if (keyword.toLowerCase().includes(query)) return 20;
  }
  return 0;
}

/**
 * Items matching `query`, best first.
 *
 * An empty query returns the whole catalogue in its declared order, which is
 * grouped the way the menu displays it.
 */
export function matchSlashItems(query: string): readonly SlashItem[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return SLASH_ITEMS;

  const scored: { readonly item: SlashItem; readonly score: number; readonly order: number }[] = [];
  SLASH_ITEMS.forEach((item, order) => {
    const value = score(item, needle);
    if (value > 0) scored.push({ item, score: value, order });
  });
  scored.sort((a, b) => (b.score - a.score !== 0 ? b.score - a.score : a.order - b.order));
  return scored.map((entry) => entry.item);
}

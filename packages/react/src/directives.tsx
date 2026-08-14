/**
 * The MDV directives, rendered into the middle of a Markdown document (SPEC 9).
 *
 * `markdown.tsx` renders CommonMark and GFM; this file renders the seven block
 * directives of SPEC 9.1 and the six inline directives of SPEC 9.2 that appear
 * inside it. The two modules are one renderer split along the seam where the
 * shared vocabulary ends: they share their structural readers through
 * `internal/mdast.ts`, and the walk hands each directive the callback that
 * renders its children, so recursion travels down while imports travel up and
 * there is no cycle.
 *
 * Four rules hold everywhere here:
 *
 * - **The other renderers are the specification.** A figure numbered `3.1` on
 *   screen must be `3.1` in the export, a callout must carry the same icon and
 *   the same word, and `:mdv-ref[fig-revenue]` must print the same string in
 *   both. The arithmetic lives in `@mdv/core`'s `numbering.ts` and the pre-pass
 *   in `internal/numbering.ts`, both written against `render-pdf/src/flow.ts`,
 *   so agreement is structural rather than a coincidence of two similar loops.
 * - **Numbers come from the shared formatter.** `:mdv-metric[]`, `:mdv-value[]`
 *   and `:mdv-delta[]` are numbers printed in a sentence beside a chart making
 *   the same claim, so they go through `@mdv/charts`' `formatNumber` and
 *   `@mdv/core`'s `aggregateColumn` — never `toLocaleString`, whose rounding
 *   moves with the ICU version (SPEC 24.3).
 * - **Status is never colour alone (SPEC 16.2).** Every callout, badge and delta
 *   ships a glyph *and* a word or a sign. The glyph is `aria-hidden`, because
 *   the word beside it is what a screen reader should read, and the colour is a
 *   `data-*` attribute the stylesheet keys off rather than an inline `style`,
 *   which `style-src 'self' 'nonce-…'` would block anyway (SPEC 13.5).
 * - **An unknown directive renders its content** rather than vanishing
 *   (SPEC 15.2). Core reports it as `MDV1503`, an info; losing the paragraphs
 *   inside a plugin's container would be a far worse outcome than an unstyled
 *   one.
 *
 * Directive *chrome* — a callout's heading, a figure's caption, a tab's button —
 * is deliberately **not** built through `host()`. A `components={{ p: Prose }}`
 * override addresses the author's paragraphs, and repainting our own furniture
 * with it would make every override a surprise. `:::mdv-page` is the exception,
 * and only because it was overridable before this file existed.
 */

import {
  Fragment,
  createElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { aggregateColumn, tableKey, type DataRegistry } from '@mdv/core';
import {
  GOOD_DIRECTIONS,
  defaultDeltaFormat,
  deltaTone,
  formatNumber,
  formatValue,
  parseSeries,
  sparkPoints,
  type GoodDirection,
} from '@mdv/charts';
import {
  attr,
  host,
  kids,
  oneOf,
  str,
  type HostContext,
  type MdastNode,
} from './internal/mdast.js';
import { missingRefLabel, refLabel, type DocumentNumbering } from './internal/numbering.js';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/** What a directive needs from the document around it. */
export interface DirectiveContext extends HostContext {
  /**
   * Figure numbers, anchors and reference targets from the pre-pass.
   *
   * Absent means "nobody numbered this document": figures still render, without
   * a counter, and a `:mdv-ref[]` prints its not-found form. That is the right
   * answer for a caller rendering a fragment, which has no document to number.
   */
  numbering?: DocumentNumbering | undefined;
  /**
   * The document's datasets, for `:mdv-value[@sales.revenue.sum]`.
   *
   * Absent — or not `ready` — means the reference renders as its source text,
   * which is what tells the author the number they are reading is theirs and not
   * the data's (SPEC 6.4, 15.2).
   */
  data?: DataRegistry | undefined;
}

/** The walk's own child renderer, handed down so this file need not import it. */
export type RenderChildren<C> = (ctx: C, node: MdastNode, prefix: string) => ReactNode[];

/**
 * Render one `mdvDirective` node.
 *
 * @param ctx - the render context, carrying the numbering and the datasets
 * @param node - the directive node, read structurally
 * @param key - this node's React key, and the prefix for its children's
 * @param children - the caller's child renderer (`markdown.tsx`'s
 *   `renderChildren`), which is what keeps the recursion in one place
 */
export function renderDirective<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactNode {
  const label = str(node, 'label') ?? '';
  switch (str(node, 'name')) {
    // ── Block directives (SPEC 9.1) ──────────────────────────────────────────
    case 'mdv-page':
      return pageBreak(ctx, node, key, children);
    case 'mdv-figure':
      return figure(ctx, node, key, children);
    case 'mdv-callout':
      return callout(ctx, node, key, children);
    case 'mdv-tabs':
      return tabs(ctx, node, key, children);
    case 'mdv-tab':
      return loneTab(ctx, node, key, children);
    case 'mdv-details':
      return details(ctx, node, key, children);
    case 'mdv-grid':
      return grid(ctx, node, key, children);
    case 'mdv-columns':
      return columns(ctx, node, key, children);

    // ── Inline directives (SPEC 9.2) ─────────────────────────────────────────
    case 'mdv-ref':
      return reference(ctx, node, key, label);
    case 'mdv-value':
      return datasetValue(ctx, node, key, label);
    case 'mdv-metric':
      return metric(node, key, label);
    case 'mdv-delta':
      return delta(node, key, label);
    case 'mdv-badge':
      return badge(node, key, label);
    case 'mdv-spark':
      return spark(node, key, label);

    default: {
      // Unknown: the content, as ordinary content (SPEC 15.2). An inline
      // directive whose label was never parsed into children still has the
      // label, and printing it beats printing nothing.
      const rendered = children(ctx, node, key);
      if (rendered.length === 0 && label !== '') return label;
      return createElement(Fragment, { key }, ...rendered);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Block directives (SPEC 9.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `:::mdv-page` — a marker with no visuals of its own (SPEC 28.4).
 *
 * A screen has no pages, so an embedded document must not grow a rule the
 * embedder never asked for. What survives is the *intent*, in attributes a host
 * stylesheet can act on, and — under `@media print` — the CSS fragmentation
 * properties they map to, so printing the HTML agrees with exporting the PDF.
 * In the wrapping form the children render inside the marker, which is what
 * makes `break=avoid` expressible as `break-inside: avoid`.
 */
function pageBreak<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const props: Record<string, unknown> = { key, className: CLS.pageBreak };
  const kind = oneOf(attr(node, 'break'), ['before', 'after', 'avoid']);
  const orientation = oneOf(attr(node, 'orientation'), ['portrait', 'landscape']);
  const size = attr(node, 'size');
  if (kind !== undefined) props['data-mdv-break'] = kind;
  if (orientation !== undefined) props['data-mdv-orientation'] = orientation;
  if (size !== undefined) props['data-mdv-size'] = size;
  if (kids(node).length === 0) return host(ctx, 'div', props, null);
  return host(ctx, 'div', props, children(ctx, node, key));
}

/**
 * `:::mdv-figure` — numbered content, and the target of `:mdv-ref[]` (SPEC 9.1).
 *
 * The number and the anchor both come from the pre-pass, which walked the whole
 * document before this render began: a figure cannot know its own number from
 * where it stands, because `numbering.restartAt` makes it a function of the
 * headings above it. The caption is `Figure 3.1. …` with the label in bold,
 * which is `flow.ts`'s caption paragraph spelled in HTML.
 *
 * `<figure>` even when the caption is absent: the element says "this content is
 * referenced from elsewhere", which is exactly what a figure with an `id` and no
 * caption is for.
 */
function figure<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const anchor = ctx.numbering?.anchors.get(node) ?? attr(node, 'id');
  const label = ctx.numbering?.labels.get(node);
  const caption = attr(node, 'caption');
  const props: Record<string, unknown> = { key, className: CLS.figure };
  if (anchor !== undefined) props['id'] = anchor;

  const body: ReactNode[] = children(ctx, node, key);
  if (caption !== undefined && caption !== '') {
    body.push(
      createElement(
        'figcaption',
        { key: `${key}-caption`, className: CLS.figureCaption },
        label === undefined
          ? caption
          : [createElement('strong', { key: 'label' }, `${label}. `), caption],
      ),
    );
  }
  return createElement('figure', props, ...body);
}

/** The four admonition kinds (SPEC 9.1). Anything else is a `note`. */
const CALLOUT_KINDS = ['note', 'tip', 'warning', 'danger'] as const;
type CalloutKind = (typeof CALLOUT_KINDS)[number];

const CALLOUT_LABEL: Readonly<Record<CalloutKind, string>> = {
  note: 'Note',
  tip: 'Tip',
  warning: 'Warning',
  danger: 'Danger',
};

/**
 * The marks a callout and a badge carry, on screen and on paper.
 *
 * Identical to `flow.ts`'s table, and chosen there for the tighter constraint:
 * the standard 14 PDF fonts are WinAnsi, and a glyph they lack would be
 * `MDV5100` noise. Screen typography could afford something prettier, but then
 * the same warning would wear two different faces in two exports of one
 * document, and the reader would have to learn both.
 */
const CALLOUT_ICON: Readonly<Record<CalloutKind, string>> = {
  note: 'i',
  tip: '*',
  warning: '!',
  danger: '×',
};

function calloutKind(value: string | undefined): CalloutKind {
  return (oneOf(value, CALLOUT_KINDS) as CalloutKind | undefined) ?? 'note';
}

/**
 * `:::mdv-callout` — an admonition (SPEC 9.1).
 *
 * > Status colors ship with an icon and a label, never color alone.
 *
 * So the heading is always rendered, even unstyled: the icon is a shape, the
 * label is a word, and the colour is the third signal rather than the only one
 * (SPEC 16.2). When the author supplies a `title`, the kind is still announced —
 * visually by the icon, and to a screen reader by a visually hidden word — since
 * "Method" alone does not tell a listener they are being warned.
 */
function callout<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const kind = calloutKind(attr(node, 'type'));
  const title = attr(node, 'title');
  const titled = title !== undefined && title !== '';
  const heading: ReactNode[] = [
    createElement(
      'span',
      { key: 'icon', className: CLS.calloutIcon, 'aria-hidden': 'true' },
      CALLOUT_ICON[kind],
    ),
  ];
  if (titled) {
    heading.push(
      createElement(
        'span',
        { key: 'kind', className: CLS.visuallyHidden },
        `${CALLOUT_LABEL[kind]}: `,
      ),
      title,
    );
  } else {
    heading.push(CALLOUT_LABEL[kind]);
  }

  return createElement(
    'aside',
    { key, className: CLS.callout, 'data-mdv-callout': kind },
    createElement('p', { key: `${key}-head`, className: CLS.calloutHead }, ...heading),
    ...children(ctx, node, key),
  );
}

/** One tab's title and its rendered content. */
interface TabItem {
  key: string;
  title: string;
  content: ReactNode[];
}

/**
 * `:::mdv-tabs` — tabbed panels (SPEC 9.1).
 *
 * A real tab widget, not a stack of headings: the PDF exporter is the renderer
 * that flattens tabs into sequential subheadings, and it says so because paper
 * has no selection. On screen the panels are what the author asked for, with the
 * APG's manual-activation keyboard model — arrows move focus, Enter or Space
 * selects — because a panel may hold a chart, and mounting one per arrow press
 * to look at the tab *after* it is a real cost.
 *
 * Only the selected panel is mounted. A hidden panel measures zero, and a chart
 * that laid itself out inside one would come back with an empty scene.
 */
function tabs<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const items: TabItem[] = [];
  const loose: ReactNode[] = [];
  let initial = 0;

  const childNodes = kids(node);
  for (let i = 0; i < childNodes.length; i += 1) {
    const child = childNodes[i];
    if (child === undefined) continue;
    const childKey = `${key}-${String(i)}`;
    if (child.type !== 'mdvDirective' || str(child, 'name') !== 'mdv-tab') {
      // Whitespace between panels, or content the author put outside a tab. It
      // is still theirs, so it renders — after the widget, where it cannot break
      // the `tablist` up into pieces that are no longer a tablist.
      //
      // The walk renders a node's *children*, so the stray node is handed over
      // inside a parent of its own: rendering its children directly would strip
      // the element it needs, and a bare `<li>` outside a list is worse markup
      // than the one the author wrote.
      loose.push(...children(ctx, { type: 'root', children: [child] }, childKey));
      continue;
    }
    if (truthy(attr(child, 'default'))) initial = items.length;
    items.push({
      key: childKey,
      title: attr(child, 'title') ?? str(child, 'label') ?? `Tab ${String(items.length + 1)}`,
      content: children(ctx, child, childKey),
    });
  }

  return createElement(TabsView, { key, tabs: items, loose, initial });
}

/**
 * A `:::mdv-tab` that is not inside a `:::mdv-tabs`.
 *
 * One panel is not a tab strip, so it renders as its title and its content —
 * which is what the exporter does with every tab, and the closest thing to the
 * author's intent that a lone panel can be.
 */
function loneTab<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const title = attr(node, 'title') ?? str(node, 'label') ?? '';
  const body = children(ctx, node, key);
  if (title === '') return createElement(Fragment, { key }, ...body);
  return createElement(
    'section',
    { key, className: CLS.tabPanel },
    createElement('p', { key: `${key}-title`, className: CLS.tabTitle }, title),
    ...body,
  );
}

function TabsView({
  tabs: items,
  loose,
  initial,
}: {
  tabs: readonly TabItem[];
  loose: readonly ReactNode[];
  initial: number;
}): ReactElement {
  const [selected, setSelected] = useState(initial);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const base = useId();

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number, count: number): void => {
      const next = nextTab(event.key, index, count);
      if (next === undefined) return;
      // The arrow keys are the tab strip's, not the scroll container's.
      event.preventDefault();
      buttons.current[next]?.focus();
    },
    [],
  );

  if (items.length === 0) {
    return createElement('div', { className: CLS.tabs }, ...loose);
  }

  const active = Math.min(Math.max(selected, 0), items.length - 1);
  const strip = items.map((item, index) => {
    const chosen = index === active;
    return createElement(
      'button',
      {
        key: item.key,
        type: 'button',
        role: 'tab',
        id: `${base}-tab-${String(index)}`,
        className: CLS.tab,
        'aria-selected': chosen ? 'true' : 'false',
        'aria-controls': `${base}-panel-${String(index)}`,
        tabIndex: chosen ? 0 : -1,
        ref: (element: HTMLButtonElement | null) => {
          buttons.current[index] = element;
        },
        onClick: () => {
          setSelected(index);
        },
        onKeyDown: (event: ReactKeyboardEvent<HTMLButtonElement>) => {
          onKeyDown(event, index, items.length);
        },
      },
      item.title,
    );
  });

  const panel = items[active];
  return createElement(
    'div',
    { className: CLS.tabs },
    createElement('div', { key: 'list', role: 'tablist', className: CLS.tabList }, ...strip),
    panel === undefined
      ? null
      : createElement(
          'div',
          {
            key: 'panel',
            role: 'tabpanel',
            id: `${base}-panel-${String(active)}`,
            className: CLS.tabPanel,
            'aria-labelledby': `${base}-tab-${String(active)}`,
            tabIndex: 0,
          },
          ...panel.content,
        ),
    ...loose,
  );
}

/** The APG's roving-focus map, or `undefined` for a key the strip ignores. */
function nextTab(key: string, index: number, count: number): number | undefined {
  switch (key) {
    case 'ArrowRight':
      return (index + 1) % count;
    case 'ArrowLeft':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return undefined;
  }
}

/**
 * `:::mdv-details` — a collapsible section (SPEC 9.1).
 *
 * `<details>`, so the disclosure is the platform's: it works with no JavaScript,
 * it is in the accessibility tree without an ARIA attribute, and — the reason
 * that matters here — the browser's own in-page find expands it, which a
 * hand-rolled widget hiding its content in state cannot do.
 */
function details<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const summary = attr(node, 'summary') ?? str(node, 'label') ?? '';
  const props: Record<string, unknown> = { key, className: CLS.details };
  if (truthy(attr(node, 'open'))) props['open'] = true;
  const body: ReactNode[] = [];
  if (summary !== '') {
    body.push(
      createElement('summary', { key: `${key}-summary`, className: CLS.detailsSummary }, summary),
    );
  }
  body.push(...children(ctx, node, key));
  return createElement('details', props, ...body);
}

/**
 * `:::mdv-grid` — the canonical KPI row (SPEC 9.1).
 *
 * The column count travels as a `data-*` attribute rather than a custom
 * property, and the stylesheet carries a rule per count. That is more CSS than a
 * `grid-template-columns` computed here, and it is worth it: an attribute is in
 * the server's HTML, so a three-column KPI row renders as three columns in the
 * first paint instead of reflowing when an effect runs. The gap has no such
 * bounded set, so it goes through `setProperty` in an effect — a few pixels of
 * spacing settling after hydration is not a layout jump.
 *
 * `breakpoint` is passed through for a host stylesheet: a media query cannot
 * read a custom property, so the sheet here implements the documented 640 px
 * default and nothing narrower or wider.
 */
function grid<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  const attrs: Record<string, string> = { 'data-mdv-cols': String(count(attr(node, 'cols'), 2)) };
  const align = oneOf(attr(node, 'align'), ['start', 'center', 'end', 'stretch']);
  if (align !== undefined) attrs['data-mdv-align'] = align;
  const breakpoint = attr(node, 'breakpoint');
  if (breakpoint !== undefined) attrs['data-mdv-breakpoint'] = breakpoint;
  return createElement(
    GapBox,
    { key, className: CLS.grid, gap: pixels(attr(node, 'gap')), attrs },
    ...children(ctx, node, key),
  );
}

/** `:::mdv-columns` — multi-column text flow (SPEC 9.1). */
function columns<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  children: RenderChildren<C>,
): ReactElement {
  return createElement(
    GapBox,
    {
      key,
      className: CLS.columns,
      gap: pixels(attr(node, 'gap')),
      attrs: { 'data-mdv-count': String(count(attr(node, 'count'), 2)) },
    },
    ...children(ctx, node, key),
  );
}

/**
 * A box whose gap is a custom property set through the CSSOM.
 *
 * Not a `style` prop: React renders one as a `style` *attribute*, and SPEC 13.5's
 * `style-src 'self' 'nonce-…'` forbids exactly that. `setProperty` is not
 * subject to CSP — the same trade `blockview.tsx` makes for a placeholder's
 * height, and for the same reason.
 */
function GapBox({
  className,
  gap,
  attrs,
  children,
}: {
  className: string;
  gap: number | undefined;
  attrs: Record<string, string>;
  children?: ReactNode;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (gap === undefined) element.style.removeProperty('--mdv-directive-gap');
    else element.style.setProperty('--mdv-directive-gap', `${String(gap)}px`);
  }, [gap]);

  return createElement('div', { ref, className, ...attrs }, children);
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline directives (SPEC 9.2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `:mdv-ref[fig-revenue]` — a cross-reference (SPEC 9.2, 28.7).
 *
 * The link text is whatever the target *is* — `Figure 3.1` for a captioned
 * figure, `§Results` for a heading — so a reference reads as a name rather than
 * as a slug. An unresolved reference prints `[fig-revenue?]`, the same form the
 * PDF exporter prints, and is not a link: a href to an anchor that does not
 * exist is a promise the page cannot keep.
 */
function reference<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  label: string,
): ReactElement {
  const name = label.trim();
  const target = ctx.numbering === undefined ? undefined : refLabel(ctx.numbering, name);
  if (target === undefined) {
    return createElement(
      'span',
      { key, className: CLS.ref, 'data-mdv-unresolved': 'true' },
      missingRefLabel(name),
    );
  }
  return createElement(
    'a',
    { key, className: CLS.ref, href: `#${encodeURIComponent(name)}` },
    target,
  );
}

/**
 * `:mdv-value[@sales.revenue.sum]` — a number read from the data (SPEC 9.2).
 *
 * > the paragraph and the chart read from the same dataset, so an updated CSV
 * > updates both.
 *
 * Which is only true if the sentence runs the *same* reducer as the chart, so
 * the arithmetic is `@mdv/core`'s `aggregateColumn` — the pipeline's own — and
 * not a `sum` written here. A reference that resolves to nothing renders as its
 * source text rather than as a blank or a zero: the author must be able to see
 * that the number in their sentence is missing, and a `0` in prose is a claim.
 */
function datasetValue<C extends DirectiveContext>(
  ctx: C,
  node: MdastNode,
  key: string,
  label: string,
): ReactElement {
  const value = lookup(ctx.data, label);
  if (value === undefined) {
    return createElement(
      'span',
      { key, className: CLS.value, 'data-mdv-unresolved': 'true' },
      label,
    );
  }
  return createElement(
    'span',
    { key, className: CLS.value },
    formatValue(value, attr(node, 'format')),
  );
}

/** Resolve `@dataset.field.op` against the registry, or `undefined`. */
function lookup(data: DataRegistry | undefined, reference: string): unknown {
  if (data === undefined) return undefined;
  const spec = reference.trim();
  if (!spec.startsWith('@')) return undefined;
  const parts = spec.slice(1).split('.');
  // Dataset, field and operator: three at least. A field may itself contain
  // dots — a CSV header is not required to be an identifier — so the *outer*
  // segments are the fixed ones and the middle is the field.
  if (parts.length < 3) return undefined;
  const datasetId = parts[0];
  const op = parts[parts.length - 1];
  if (datasetId === undefined || op === undefined) return undefined;
  const field = parts.slice(1, -1).join('.');

  const table = data.resolve({ datasetId, key: tableKey(datasetId, undefined, undefined) });
  if (table === undefined) return undefined;
  return aggregateColumn(table, field, op);
}

/**
 * `:mdv-metric[1284000]{format="$~s"}` — an inline formatted number (SPEC 9.2).
 *
 * A label that is not a number is printed as written. `:mdv-metric[n/a]` is an
 * author saying something, and `NaN` is not it.
 */
function metric(node: MdastNode, key: string, label: string): ReactElement {
  const value = Number(label.trim());
  if (label.trim() === '' || !Number.isFinite(value)) {
    return createElement('span', { key, className: CLS.metric }, label);
  }
  return createElement(
    'span',
    { key, className: CLS.metric },
    formatNumber(value, attr(node, 'format')),
  );
}

/**
 * `:mdv-delta[0.082]{good=up}` — SPEC 9.2's "signed, colored delta with an arrow
 * glyph *and* a sign".
 *
 * All three, and in that order of importance: the sign is in the text, so a
 * screen reader and a monochrome print both get it; the arrow is a shape, and is
 * `aria-hidden` because "▲ +8.2%" would otherwise be read as "black up-pointing
 * triangle, plus eight point two percent"; the colour is a `data-mdv-tone`
 * attribute, and is the only one of the three a reader can lose without losing
 * the meaning (SPEC 16.2).
 *
 * `good=up` and `goodDirection=up` are both accepted — SPEC 9.2 spells the
 * attribute one way and the `metric` block of SPEC 8.13 the other, and an author
 * who has written one is not wrong to expect the other.
 */
function delta(node: MdastNode, key: string, label: string): ReactElement {
  const value = Number(label.trim());
  if (label.trim() === '' || !Number.isFinite(value)) {
    return createElement('span', { key, className: CLS.delta }, label);
  }
  const good = (oneOf(attr(node, 'good') ?? attr(node, 'goodDirection'), GOOD_DIRECTIONS) ??
    'up') as GoodDirection;
  const text = formatNumber(value, attr(node, 'format') ?? defaultDeltaFormat(value));
  const arrow = value > 0 ? '▲' : value < 0 ? '▼' : '';
  const parts: ReactNode[] = [];
  if (arrow !== '') {
    parts.push(
      createElement(
        'span',
        { key: 'arrow', className: CLS.deltaArrow, 'aria-hidden': 'true' },
        arrow,
      ),
    );
  }
  parts.push(text);
  return createElement(
    'span',
    { key, className: CLS.delta, 'data-mdv-tone': deltaTone(value, good) },
    ...parts,
  );
}

/**
 * `:mdv-badge[Beta]{type=note}` — a status pill (SPEC 9.2).
 *
 * Icon *and* label, like the callout it shares its palette with: a pill that
 * said "Beta" in amber and nothing else would be invisible to a reader who
 * cannot see amber.
 */
function badge(node: MdastNode, key: string, label: string): ReactElement {
  const kind = calloutKind(attr(node, 'type'));
  return createElement(
    'span',
    { key, className: CLS.badge, 'data-mdv-badge': kind },
    createElement(
      'span',
      { key: 'icon', className: CLS.badgeIcon, 'aria-hidden': 'true' },
      CALLOUT_ICON[kind],
    ),
    label,
  );
}

/** The sparkline's viewBox: four to one, the aspect of `4em × 1em` of text. */
const SPARK_WIDTH = 48;
const SPARK_HEIGHT = 12;

/**
 * `:mdv-spark[12,15,13,19,24]` — a chart drawn inside a sentence (SPEC 9.2).
 *
 * The geometry is `@mdv/charts`' `sparkPoints`, which is what the `sparkline`
 * chart type and a table's sparkline column use, so the inline strip and the
 * block chart of the same numbers agree about what "flat" looks like. Drawn in
 * viewBox units and sized by the stylesheet in `em`, so it scales with the text
 * it sits in rather than with the viewport.
 *
 * `role="img"` with the series as its label: a picture with no axes cannot be
 * read out, and the numbers behind it can.
 */
function spark(node: MdastNode, key: string, label: string): ReactElement {
  const values = parseSeries(label);
  if (values.length === 0) return createElement('span', { key, className: CLS.spark }, label);

  // Half a unit of inset all round, so a stroke centred on the extreme point is
  // drawn inside the box rather than clipped in half by it.
  const points = sparkPoints(values, 0.5, 0.5, SPARK_WIDTH - 1, SPARK_HEIGHT - 1);
  const bars = oneOf(attr(node, 'type'), ['line', 'bar']) === 'bar';
  const marks: ReactNode[] = bars
    ? points.map((point, index) => {
        const width = (SPARK_WIDTH - 1) / Math.max(points.length * 1.6, 1);
        // The first and last points sit on the inset edges, so a bar centred on
        // one of them would hang half outside the `viewBox` and be clipped away.
        // Slide the ends back in; the middle bars are centred as drawn.
        const left = Math.min(Math.max(point.x - width / 2, 0.5), SPARK_WIDTH - 0.5 - width);
        return createElement('rect', {
          key: index,
          x: round(left),
          y: round(point.y),
          width: round(width),
          height: round(Math.max(SPARK_HEIGHT - 0.5 - point.y, 0.5)),
        });
      })
    : [
        createElement('polyline', {
          key: 'line',
          points: points.map((point) => `${round(point.x)},${round(point.y)}`).join(' '),
        }),
      ];

  return createElement(
    'svg',
    {
      key,
      className: CLS.spark,
      viewBox: `0 0 ${String(SPARK_WIDTH)} ${String(SPARK_HEIGHT)}`,
      role: 'img',
      'aria-label': `sparkline: ${values.join(', ')}`,
      focusable: 'false',
    },
    ...marks,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Attribute readers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bare attribute, or one set to something that is not a denial.
 *
 * `{open}`, `{open=true}` and `{default}` all mean yes; `{open=false}` means no.
 * A directive attribute with no value reaches `attr` as the boolean `true` and
 * leaves it as `'true'`, which is why "present" and "true" are one answer here.
 */
function truthy(value: string | undefined): boolean {
  return value !== undefined && value !== 'false' && value !== '0';
}

/** A column count, clamped to what the stylesheet has a rule for. */
function count(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), 6);
}

/** A pixel measurement, or `undefined` for "let the stylesheet decide". */
function pixels(value: string | undefined): number | undefined {
  const parsed = Number(value);
  if (value === undefined || !Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.round(parsed);
}

/** Two decimals, so the same series produces the same markup byte for byte. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}

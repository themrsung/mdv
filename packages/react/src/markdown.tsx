/**
 * The Markdown half of a document: mdast → React elements.
 *
 * A visual block is only ever a fraction of an MDV document; the rest is
 * CommonMark + GFM, and it has to render as ordinary, overridable JSX
 * (SPEC 22.1's `components={{ h2: Heading, a: Link }}`).
 *
 * Three rules hold everywhere in this file:
 *
 * - **Text is text.** Every string from the document is a React child, so React
 *   creates a text node. There is no `dangerouslySetInnerHTML` here and no
 *   markup path at all (SPEC 13.3).
 * - **URLs are filtered.** Links and images go through `@mdv/render-svg`'s
 *   `sanitiseUrl`, which is the same allowlist the SVG backend applies, so a
 *   `javascript:` href cannot survive in one output and not the other
 *   (SPEC 13.3, `MDV4010`). External links get `rel="noopener noreferrer"`.
 * - **Raw HTML is inert.** Disabled by default (SPEC 13.4); when the parser has
 *   been told to keep it, it is still rendered as *text*, because inserting it
 *   would require the allowlist sanitiser this package does not ship. Better a
 *   visible `<b>` than an invisible `<script>`.
 *
 * The node types are read structurally rather than through `@types/mdast`: this
 * package does not depend on the mdast typings, and the shapes it reads are
 * fixed by CommonMark.
 */

import { createElement, Fragment, type ReactElement, type ReactNode } from 'react';
import { sanitiseUrl } from '@mdv/render-svg';

/** A node as this renderer reads it: a tag plus whatever mdast put on it. */
export interface MdastNode {
  type: string;
  [key: string]: unknown;
}

/**
 * Overrides for the Markdown elements the document renders, keyed by tag name:
 * `{ h2: Heading, a: Link }`.
 *
 * The value is any React component type. Typed as `unknown` on the public
 * surface so a consumer is not forced to import React's component types.
 */
export type ComponentOverrides = Readonly<Record<string, unknown>>;

/** Everything the walk needs to carry. */
export interface MarkdownContext {
  components: ComponentOverrides;
  /** Rendered in place of an `mdvBlock` node. */
  renderBlock: (node: MdastNode, key: string) => ReactNode;
  /** Rendered in place of an `mdvError` node. */
  renderError: (node: MdastNode, key: string) => ReactNode;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural readers
// ─────────────────────────────────────────────────────────────────────────────

function str(node: MdastNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

function num(node: MdastNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

function bool(node: MdastNode, key: string): boolean | undefined {
  const value = node[key];
  return typeof value === 'boolean' ? value : undefined;
}

function kids(node: MdastNode): readonly MdastNode[] {
  const value = node['children'];
  if (!Array.isArray(value)) return [];
  return value.filter((child): child is MdastNode => typeof child === 'object' && child !== null);
}

// ─────────────────────────────────────────────────────────────────────────────
// Elements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create `tag`, honouring an override.
 *
 * An override receives the same props the built-in would, so a `Heading` that
 * wants the level reads `children` and knows its own tag from which key it was
 * registered under.
 */
function host(
  ctx: MarkdownContext,
  tag: string,
  props: Record<string, unknown>,
  children: ReactNode,
): ReactElement {
  const override = ctx.components[tag];
  const type = (override ?? tag) as string;
  return children === null || children === undefined
    ? createElement(type as never, props as never)
    : createElement(type as never, props as never, children);
}

/** `true` for a URL that leaves the document (SPEC 13.3). */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('#');
}

/** GFM table alignment → a class, never an inline style (SPEC 13.5). */
function alignClass(align: unknown): string | undefined {
  if (align === 'right') return 'mdv-align-right';
  if (align === 'center') return 'mdv-align-center';
  if (align === 'left') return 'mdv-align-left';
  return undefined;
}

/** Render a node's children as a fragment-safe array. */
function renderChildren(ctx: MarkdownContext, node: MdastNode, prefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  const children = kids(node);
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === undefined) continue;
    out.push(renderNode(ctx, child, `${prefix}-${String(i)}`));
  }
  return out;
}

/**
 * Render one mdast node.
 *
 * Unknown node types render their children rather than disappearing: a plugin's
 * container node must not swallow the paragraphs inside it (SPEC 15.2).
 */
export function renderNode(ctx: MarkdownContext, node: MdastNode, key: string): ReactNode {
  switch (node.type) {
    // ── MDV ──────────────────────────────────────────────────────────────────
    case 'mdvBlock':
      return ctx.renderBlock(node, key);
    case 'mdvError':
      return ctx.renderError(node, key);
    case 'mdvDirective':
      // An unknown directive renders its content as ordinary content and is an
      // info diagnostic, never an error (SPEC 15.2).
      return createElement(Fragment, { key }, ...renderChildren(ctx, node, key));

    // ── Leaves ───────────────────────────────────────────────────────────────
    case 'text':
      return str(node, 'value') ?? '';
    case 'inlineCode':
      return host(ctx, 'code', { key }, str(node, 'value') ?? '');
    case 'break':
      return host(ctx, 'br', { key }, null);
    case 'thematicBreak':
      return host(ctx, 'hr', { key }, null);
    case 'html':
      // Inert by construction: rendered as text, never inserted (SPEC 13.4).
      return str(node, 'value') ?? '';

    // ── Blocks ───────────────────────────────────────────────────────────────
    case 'root':
      return createElement(Fragment, { key }, ...renderChildren(ctx, node, key));
    case 'paragraph':
      return host(ctx, 'p', { key }, renderChildren(ctx, node, key));
    case 'heading': {
      const depth = num(node, 'depth') ?? 1;
      // Clamped, not renumbered: SPEC 12.7 forbids *skipping* levels, and
      // silently rewriting the author's outline would be worse than honouring it.
      const level = Math.min(6, Math.max(1, Math.round(depth)));
      return host(ctx, `h${String(level)}`, { key }, renderChildren(ctx, node, key));
    }
    case 'blockquote':
      return host(ctx, 'blockquote', { key }, renderChildren(ctx, node, key));
    case 'list': {
      const ordered = bool(node, 'ordered') === true;
      const start = num(node, 'start');
      const props: Record<string, unknown> = { key };
      if (ordered && start !== undefined && start !== 1) props['start'] = start;
      return host(ctx, ordered ? 'ol' : 'ul', props, renderChildren(ctx, node, key));
    }
    case 'listItem': {
      const checked = node['checked'];
      if (typeof checked === 'boolean') {
        // A GFM task item. The checkbox is `disabled`: a document is not a form,
        // and an editable one would imply state MDV does not own.
        return host(ctx, 'li', { key, className: 'mdv-task-item' }, [
          createElement('input', {
            key: `${key}-check`,
            type: 'checkbox',
            checked,
            disabled: true,
            readOnly: true,
          }),
          ' ',
          ...renderChildren(ctx, node, key),
        ]);
      }
      return host(ctx, 'li', { key }, renderChildren(ctx, node, key));
    }
    case 'code': {
      const lang = str(node, 'lang');
      return host(
        ctx,
        'pre',
        { key },
        createElement(
          'code',
          lang === undefined || lang === '' ? {} : { className: `language-${lang}` },
          str(node, 'value') ?? '',
        ),
      );
    }

    // ── Inline ───────────────────────────────────────────────────────────────
    case 'strong':
      return host(ctx, 'strong', { key }, renderChildren(ctx, node, key));
    case 'emphasis':
      return host(ctx, 'em', { key }, renderChildren(ctx, node, key));
    case 'delete':
      return host(ctx, 'del', { key }, renderChildren(ctx, node, key));
    case 'link': {
      const raw = str(node, 'url') ?? '';
      const href = sanitiseUrl(raw);
      if (href === undefined) {
        // A refused scheme is `MDV4010`; the label survives so the reader still
        // sees what the author wrote, minus the ability to act on it.
        return createElement(Fragment, { key }, ...renderChildren(ctx, node, key));
      }
      const props: Record<string, unknown> = { key, href };
      const title = str(node, 'title');
      if (title !== undefined) props['title'] = title;
      if (isExternal(href)) {
        props['rel'] = 'noopener noreferrer';
        props['target'] = '_blank';
      }
      return host(ctx, 'a', props, renderChildren(ctx, node, key));
    }
    case 'image': {
      const raw = str(node, 'url') ?? '';
      const src = sanitiseUrl(raw);
      const alt = str(node, 'alt') ?? '';
      if (src === undefined) return alt;
      const props: Record<string, unknown> = { key, src, alt };
      const title = str(node, 'title');
      if (title !== undefined) props['title'] = title;
      return host(ctx, 'img', props, null);
    }
    case 'linkReference':
    case 'imageReference':
      // An unresolved reference: the parser leaves it, and its label is the only
      // honest thing to show.
      return createElement(Fragment, { key }, ...renderChildren(ctx, node, key));
    case 'definition':
    case 'footnoteDefinition':
      // Not rendered in flow; they are targets, not content.
      return null;

    // ── GFM tables ───────────────────────────────────────────────────────────
    case 'table': {
      const align = Array.isArray(node['align']) ? (node['align'] as unknown[]) : [];
      const rows = kids(node);
      const head = rows[0];
      const body = rows.slice(1);
      return host(ctx, 'table', { key, className: 'mdv-markdown-table' }, [
        head === undefined
          ? null
          : createElement(
              'thead',
              { key: `${key}-head` },
              renderTableRow(ctx, head, align, true, `${key}-head-0`),
            ),
        body.length === 0
          ? null
          : createElement(
              'tbody',
              { key: `${key}-body` },
              body.map((row, i) =>
                renderTableRow(ctx, row, align, false, `${key}-body-${String(i)}`),
              ),
            ),
      ]);
    }
    case 'tableRow':
      return renderTableRow(ctx, node, [], false, key);
    case 'tableCell':
      return host(ctx, 'td', { key }, renderChildren(ctx, node, key));

    default:
      // Including `yaml`/`toml` front matter, which the parser has already
      // lifted onto `frontmatter` and must not also render as content.
      if (node.type === 'yaml' || node.type === 'toml') return null;
      return createElement(Fragment, { key }, ...renderChildren(ctx, node, key));
  }
}

function renderTableRow(
  ctx: MarkdownContext,
  row: MdastNode,
  align: readonly unknown[],
  header: boolean,
  key: string,
): ReactElement {
  const cells = kids(row);
  return createElement(
    'tr',
    { key },
    cells.map((cell, i) => {
      const className = alignClass(align[i]);
      const props: Record<string, unknown> = { key: `${key}-${String(i)}` };
      if (className !== undefined) props['className'] = className;
      if (header) props['scope'] = 'col';
      return host(
        ctx,
        header ? 'th' : 'td',
        props,
        renderChildren(ctx, cell, `${key}-${String(i)}`),
      );
    }),
  );
}

/** Render a whole document body. */
export function renderMarkdown(ctx: MarkdownContext, nodes: readonly MdastNode[]): ReactNode[] {
  const out: ReactNode[] = [];
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;
    out.push(renderNode(ctx, node, `n${String(i)}`));
  }
  return out;
}

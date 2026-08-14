/**
 * The structural readers the Markdown walk and the directive renderers share.
 *
 * This package reads mdast *structurally* — by key, with a type check at every
 * step — rather than through `@types/mdast`, and two modules now need the same
 * readers: `markdown.tsx`, which renders CommonMark and GFM, and
 * `directives.tsx`, which renders the MDV directives that appear in the middle
 * of it. Putting them here means neither module has to import the other. The
 * walk hands a directive the callback that renders its children, so recursion
 * travels down one direction and imports travel up the other, and there is no
 * cycle between two files that are conceptually one renderer.
 *
 * Every reader answers `undefined` for "not there, or not that type", which is
 * the same answer, deliberately: a `depth` that arrived as a string is a
 * malformed node, and a renderer that distinguished the two cases would have to
 * decide what to do about it in a walk that has no diagnostic sink (SPEC 15.2).
 */

import { createElement, type ReactElement, type ReactNode } from 'react';

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

/** The part of the render context {@link host} needs. */
export interface HostContext {
  components: ComponentOverrides;
}

// ─────────────────────────────────────────────────────────────────────────────
// Structural readers
// ─────────────────────────────────────────────────────────────────────────────

export function str(node: MdastNode, key: string): string | undefined {
  const value = node[key];
  return typeof value === 'string' ? value : undefined;
}

export function num(node: MdastNode, key: string): number | undefined {
  const value = node[key];
  return typeof value === 'number' ? value : undefined;
}

export function bool(node: MdastNode, key: string): boolean | undefined {
  const value = node[key];
  return typeof value === 'boolean' ? value : undefined;
}

export function kids(node: MdastNode): readonly MdastNode[] {
  const value = node['children'];
  if (!Array.isArray(value)) return [];
  return value.filter((child): child is MdastNode => typeof child === 'object' && child !== null);
}

/**
 * One attribute of a directive, as a string. Absent beats malformed.
 *
 * A valueless attribute — `{open}`, `{default}` — parses to the boolean `true`,
 * not to the empty string, so it has to be spelled back out here or every flag
 * in the language would read as absent.
 */
export function attr(node: MdastNode, key: string): string | undefined {
  const attrs = node['attrs'];
  if (typeof attrs !== 'object' || attrs === null) return undefined;
  const value = (attrs as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** An attribute restricted to a closed set; anything else is ignored (SPEC 15.2). */
export function oneOf(value: string | undefined, allowed: readonly string[]): string | undefined {
  return value !== undefined && allowed.includes(value) ? value : undefined;
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
export function host(
  ctx: HostContext,
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

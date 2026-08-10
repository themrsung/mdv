/**
 * `@mdv/render-svg` — scene graph → SVG, as DOM nodes, as React elements, or as
 * a string (SPEC 23.1, 23.3).
 *
 * The default backend: accessible (real text, real focus), scalable, printable,
 * diff-friendly.
 *
 * - One `<svg>` per block with `role="img"`/`"figure"`, `aria-labelledby`, a
 *   `viewBox`, and `preserveAspectRatio="xMidYMid meet"`.
 * - Text is real `<text>`, **never paths**, so it stays selectable, searchable
 *   and translatable.
 * - Interaction lives in an overlay `<g>` of transparent hit rects driven by
 *   `Scene.hitIndex`, so hit targets are independent of mark size.
 * - The string serialiser is deterministic: fixed attribute order, numbers
 *   rounded to 3 decimals with `-0` normalised to `0`, no whitespace between
 *   elements (SPEC 23.1, 24.3 rule 4).
 *
 * This package makes **no layout decisions** (SPEC 17.1): it translates, and
 * that is all. It does no hit-testing either — the hit rects are the scene's.
 *
 * All three output paths are built from one intermediate tree, so the DOM you
 * get and the string a golden file pins are the same drawing by construction.
 */

import type { Renderer, RenderHandle, Scene } from '@mdv/core';
import type { BuildOptions } from './build.js';
import { buildScene, resolveOptions } from './build.js';
import { createElementTree, patchElementTree } from './dom.js';
import type { CreateElement } from './react.js';
import { toHostElements } from './react.js';
import { serialiseVNode } from './string.js';
import { stylesheet } from './stylesheet.js';
import { attachInteraction } from './interaction.js';
import type { InteractionHandlers } from './interaction.js';

/** Options shared by every SVG output path. */
export interface SvgOptions {
  /**
   * Decimal places for coordinates. 3 is the canonical value and is what golden
   * files are generated at (SPEC 23.1). @defaultValue 3
   */
  precision?: number;
  /**
   * Emit the `mdv-*` class tokens from `SceneNode.cls`. Turn off for a
   * self-contained export with no stylesheet. @defaultValue true
   */
  classes?: boolean;
  /**
   * Emit the transparent hit-rect overlay. Off for static output (SPEC 7.5:
   * static targets ignore the hover layer). @defaultValue true
   */
  interaction?: boolean;
  /**
   * Prefix for generated element ids; must be unique per document on a page.
   * Defaults to `Scene.meta.blockId`, which is already deterministic and already
   * unique (SPEC 24.3 rule 7).
   */
  idPrefix?: string;
}

/** Options for {@link toSvgString}. */
export interface SvgStringOptions extends SvgOptions {
  /** Emit the XML declaration, for a standalone `.svg` file. */
  standalone?: boolean;
  /** Inline the stylesheet in a `<style>` element (SPEC 22.4). */
  inlineStyles?: boolean;
}

function toBuildOptions(scene: Scene, options: SvgOptions | undefined): BuildOptions {
  // `BuildOptions`' members are `readonly`, so a `Partial<BuildOptions>` cannot
  // be filled field by field. Strip the modifier for the local accumulator; the
  // value handed to `resolveOptions` is still a plain `Partial<BuildOptions>`.
  const partial: { -readonly [K in keyof BuildOptions]?: BuildOptions[K] } = {};
  if (options?.precision !== undefined) partial.precision = options.precision;
  if (options?.classes !== undefined) partial.classes = options.classes;
  if (options?.interaction !== undefined) partial.interaction = options.interaction;
  if (options?.idPrefix !== undefined) partial.idPrefix = options.idPrefix;
  return resolveOptions(partial, scene);
}

/**
 * Serialise a scene to an SVG string (SPEC 23.3).
 *
 * Deterministic: the same scene produces byte-identical output on every machine,
 * which is what makes the golden-file suite meaningful.
 *
 * `inlineStyles` puts the stylesheet in a `<style>` element inside the `<svg>`.
 * That is correct for a standalone `.svg` and for `mdv export --html --inline`,
 * and it is **wrong** under SPEC 13.5's CSP unless the embedder can nonce it —
 * hence off by default.
 */
export function toSvgString(scene: Scene, options?: SvgStringOptions): string {
  const tree = buildScene(scene, toBuildOptions(scene, options));
  let body = serialiseVNode(tree);

  if (options?.inlineStyles === true) {
    const style = `<style>${stylesheet()}</style>`;
    const close = body.indexOf('>') + 1;
    body = `${body.slice(0, close)}${style}${body.slice(close)}`;
  }
  return options?.standalone === true ? `<?xml version="1.0" encoding="UTF-8"?>${body}` : body;
}

/**
 * Build the SVG subtree for a scene as real DOM.
 *
 * @param scene - the scene to draw
 * @param doc - the owning document. Injected rather than read from a global so
 * this function works in jsdom, in a worker with a synthetic document, and in
 * VS Code's webview.
 */
export function toSvgElement(scene: Scene, doc: Document, options?: SvgOptions): SVGSVGElement {
  const tree = buildScene(scene, toBuildOptions(scene, options));
  return createElementTree(tree, doc) as SVGSVGElement;
}

/**
 * A minimal React-element shape, structurally compatible with `React.ReactNode`
 * without depending on React here — `@mdv/render-svg` is universal and must not
 * pull React into a Node or CLI bundle (SPEC 17.2).
 */
export interface SvgElementNode {
  type: string;
  key: string | null;
  props: Record<string, unknown>;
}

/**
 * Convert a scene to React elements (SPEC 22.3).
 *
 * The DOM is React-owned in the React binding, so charts are ordinary JSX and
 * reconcile normally. The returned tree is created with the host's
 * `createElement`, which `@mdv/react` supplies.
 *
 * @param createElement - the host's element factory, e.g. React's
 */
export function toReactElements(
  scene: Scene,
  createElement: CreateElement,
  options?: SvgOptions,
): unknown {
  return toHostElements(buildScene(scene, toBuildOptions(scene, options)), createElement);
}

/**
 * The imperative SVG backend (SPEC 21 `Renderer`).
 *
 * Total: every scene-node kind is supported, so `unsupported` is empty
 * (SPEC 17.3 invariant 3).
 *
 * `update` **patches the existing tree** rather than replacing it, so keyboard
 * focus and text selection survive the `ResizeObserver` storm of a window drag
 * (SPEC 22.3).
 */
export function createSvgRenderer(options?: SvgOptions): Renderer<Element> {
  return {
    target: 'svg',
    unsupported: [],
    render(scene: Scene, host: Element): RenderHandle {
      const doc = host.ownerDocument;
      if (doc === null) {
        throw new TypeError('@mdv/render-svg: host element is not attached to a Document');
      }
      let element = createElementTree(buildScene(scene, toBuildOptions(scene, options)), doc);
      host.appendChild(element);

      let detach: (() => void) | undefined =
        (options?.interaction ?? true) ? attachInteraction(host, scene) : undefined;

      return {
        update(next: Scene): void {
          detach?.();
          element = patchElementTree(element, buildScene(next, toBuildOptions(next, options)), doc);
          detach = (options?.interaction ?? true) ? attachInteraction(host, next) : undefined;
        },
        destroy(): void {
          detach?.();
          detach = undefined;
          element.remove();
        },
      };
    },
  };
}

export { attachInteraction, stylesheet };
export type { InteractionHandlers };
export type { CreateElement } from './react.js';

export { CLASS_NAMES } from './stylesheet.js';
export { errorCardString, errorCardVNode } from './errorcard.js';
export type { ErrorCardOptions } from './errorcard.js';

// ── The pieces, for a host building its own pipeline ─────────────────────────
export { buildScene, pathData, readoutLabel } from './build.js';
export type { BuildOptions } from './build.js';
export { serialiseVNode } from './string.js';
export { createElementTree, patchElementTree } from './dom.js';
export { reactPropName, toHostElements } from './react.js';
export { escapeXml, formatNumber, isSafeId, sanitiseClasses, sanitiseUrl } from './format.js';
export { allowedAttributes, isAllowedAttribute } from './allowlist.js';
export type { VAttr, VNode } from './vnode.js';

export type { Diagnostic, RenderHandle, Renderer, Scene } from '@mdv/core';

/**
 * `CanvasMetrics` — exact measurement against the font the browser actually
 * resolved (SPEC 21).
 *
 * **Core never touches the DOM** (SPEC 17.3 invariant 1), so this module does not
 * reach for `document`, does not create a canvas, and does not know what a
 * canvas is beyond the two methods it calls. The *host* — `@mdv/render-svg`, the
 * React binding, an embedder — creates the 2D context and passes it in:
 *
 * ```ts
 * import { createCanvasMetrics } from '@mdv/core';
 * const ctx = document.createElement('canvas').getContext('2d');
 * const metrics = createCanvasMetrics(ctx);
 * ```
 *
 * That inversion is what "guarded so it is never constructed outside a browser"
 * means in a package that may not name a browser: there is nothing to construct
 * unless a browser handed you a context, and {@link createCanvasMetrics} rejects
 * anything that is not one.
 *
 * Use it for interactive resizing, where matching the installed font matters more
 * than cross-machine reproducibility. Use {@link createTableMetrics} for anything
 * that must be byte-identical elsewhere (SPEC 24.3 rule 6).
 */

import type { Font } from '../types/scene.js';
import type { GlyphMetrics, TextMetrics } from '../types/layout.js';
import { DEFAULT_ASCENT, DEFAULT_DESCENT } from './width-table.js';

/**
 * The structural slice of `CanvasRenderingContext2D` this needs.
 *
 * Declared here rather than imported from `lib.dom` so the module carries no DOM
 * dependency at all, and so a test can hand it a stub.
 */
export interface CanvasLike {
  font: string;
  measureText(text: string): {
    width: number;
    actualBoundingBoxAscent?: number;
    actualBoundingBoxDescent?: number;
    fontBoundingBoxAscent?: number;
    fontBoundingBoxDescent?: number;
  };
}

/** Thrown when `createCanvasMetrics` is handed something that is not a 2D context. */
export class CanvasMetricsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanvasMetricsUnavailableError';
  }
}

/** `true` when `value` can serve as a measuring context. */
export function isCanvasLike(value: unknown): value is CanvasLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { measureText?: unknown };
  return typeof candidate.measureText === 'function';
}

/** Build the CSS `font` shorthand a canvas context expects. */
export function cssFontShorthand(font: Font): string {
  const parts: string[] = [];
  if (font.style === 'italic') parts.push('italic');
  if (font.weight !== undefined && font.weight !== 400) parts.push(String(font.weight));
  parts.push(`${font.size}px`);
  parts.push(font.family);
  return parts.join(' ');
}

/**
 * Build a metrics provider over a host-supplied 2D context.
 *
 * @param context - a `CanvasRenderingContext2D`, supplied by the host. Core will
 * not create one: it has no DOM.
 * @throws CanvasMetricsUnavailableError when `context` is absent or is not a
 * measuring context — host programmer error, which is the one thing core is
 * allowed to throw for (SPEC 21).
 */
export function createCanvasMetrics(context: unknown): TextMetrics {
  if (!isCanvasLike(context)) {
    throw new CanvasMetricsUnavailableError(
      'createCanvasMetrics requires a CanvasRenderingContext2D supplied by the host; ' +
        '@mdv/core cannot create one (SPEC 17.3 invariant 1). Use createTableMetrics() ' +
        'for deterministic, DOM-free measurement.',
    );
  }
  const canvas = context;
  let appliedFont = '';

  return {
    measure(text: string, font: Font): GlyphMetrics {
      const size = Number.isFinite(font.size) && font.size > 0 ? font.size : 13;
      const shorthand = cssFontShorthand({ ...font, size });
      if (shorthand !== appliedFont) {
        canvas.font = shorthand;
        appliedFont = shorthand;
      }
      let measured: ReturnType<CanvasLike['measureText']>;
      try {
        measured = canvas.measureText(text);
      } catch {
        // Total, per SPEC 21: a context that refuses a string still gets a width.
        return { width: 0, ascent: DEFAULT_ASCENT * size, descent: DEFAULT_DESCENT * size };
      }
      const spacing = (font.letterSpacing ?? 0) * Math.max(0, [...text].length - 1);
      const ascent =
        measured.fontBoundingBoxAscent ?? measured.actualBoundingBoxAscent ?? DEFAULT_ASCENT * size;
      const descent =
        measured.fontBoundingBoxDescent ??
        measured.actualBoundingBoxDescent ??
        DEFAULT_DESCENT * size;
      const width = Number.isFinite(measured.width) ? measured.width + spacing : 0;
      return { width, ascent, descent };
    },
  };
}

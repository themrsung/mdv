/**
 * Text nodes, measured once (SPEC 20).
 *
 * > Text nodes carry measured width. Measurement happens once, in layout,
 * > through the injected metrics provider, so SVG, Canvas and PDF agree on
 * > whether a label fits and PDF pagination never disagrees with the screen.
 *
 * Everything that emits text in this package goes through {@link makeText}, so
 * `width` is never absent and no backend has to guess.
 */

import type { GlyphMetrics, TextMetrics } from '../types/layout.js';
import type { Font, Paint, TextNode } from '../types/scene.js';
import type { Theme } from '../types/theme.js';

/** Build a resolved font from theme tokens. */
export function themeFont(
  theme: Theme,
  role: 'title' | 'subtitle' | 'label' | 'tick' | 'caption' | 'legend',
): Font {
  const base = theme.type.fontSize;
  switch (role) {
    case 'title':
      return { family: theme.type.fontFamily, size: base * theme.type.titleScale, weight: 600 };
    case 'subtitle':
      return { family: theme.type.fontFamily, size: base, weight: 400 };
    case 'caption':
      return { family: theme.type.fontFamily, size: base * theme.type.tickScale, weight: 400 };
    case 'tick':
      return { family: theme.type.fontFamily, size: base * theme.type.tickScale, weight: 400 };
    case 'legend':
      return { family: theme.type.fontFamily, size: base * theme.type.tickScale, weight: 400 };
    case 'label':
    default:
      return { family: theme.type.fontFamily, size: base, weight: 500 };
  }
}

/** A solid paint from a colour string. */
export function solid(color: string, opacity?: number): Paint {
  return opacity === undefined ? { kind: 'solid', color } : { kind: 'solid', color, opacity };
}

/** Options for {@link makeText}. */
export interface TextOptions {
  x: number;
  y: number;
  text: string;
  font: Font;
  fill: Paint;
  anchor?: TextNode['anchor'];
  baseline?: TextNode['baseline'];
  rotate?: number;
  /** Tabular figures: y-axis ticks and table values (SPEC 11.5). */
  tabular?: boolean;
  cls?: string;
  id?: string;
  opacity?: number;
}

/** Build a text node with its measured advance width attached. */
export function makeText(options: TextOptions, metrics: TextMetrics): TextNode {
  const measured = metrics.measure(options.text, options.font);
  const node: TextNode = {
    kind: 'text',
    x: options.x,
    y: options.y,
    text: options.text,
    font: options.font,
    fill: options.fill,
    anchor: options.anchor ?? 'start',
    baseline: options.baseline ?? 'alphabetic',
    width: measured.width,
  };
  if (options.rotate !== undefined && options.rotate !== 0) node.rotate = options.rotate;
  if (options.tabular === true) node.tabular = true;
  if (options.cls !== undefined) node.cls = options.cls;
  if (options.id !== undefined) node.id = options.id;
  if (options.opacity !== undefined) node.opacity = options.opacity;
  return node;
}

/** Measured width of a string in a font. */
export function measureWidth(text: string, font: Font, metrics: TextMetrics): number {
  return metrics.measure(text, font).width;
}

/** Full line box height for a font: ascent + descent, or the theme line height. */
export function lineHeight(font: Font, metrics: TextMetrics): number {
  if (font.lineHeight !== undefined) return font.size * font.lineHeight;
  const m: GlyphMetrics = metrics.measure('Hg', font);
  return m.ascent + m.descent;
}

/** The horizontal extent of a label rotated by `degrees`, in px. */
export function rotatedWidth(width: number, height: number, degrees: number): number {
  const radians = (Math.abs(degrees) * Math.PI) / 180;
  return Math.abs(width * Math.cos(radians)) + Math.abs(height * Math.sin(radians));
}

/** The vertical extent of a label rotated by `degrees`, in px. */
export function rotatedHeight(width: number, height: number, degrees: number): number {
  const radians = (Math.abs(degrees) * Math.PI) / 180;
  return Math.abs(width * Math.sin(radians)) + Math.abs(height * Math.cos(radians));
}

/**
 * Shorten a string to fit `maxWidth`, ending in an ellipsis.
 *
 * Used **only** for chrome an author controls and can shorten — a block title, a
 * legend label. Never for a value: SPEC 11.5 is explicit that a data label that
 * will not fit is omitted, not cropped, because cropping the first characters is
 * worse than no label. See {@link placeDirectLabels} for that path.
 *
 * @returns the original string when it already fits, or `''` when not even the
 * ellipsis does
 */
export function ellipsize(
  text: string,
  font: Font,
  metrics: TextMetrics,
  maxWidth: number,
): string {
  if (maxWidth <= 0) return '';
  if (measureWidth(text, font, metrics) <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisWidth = measureWidth(ellipsis, font, metrics);
  if (ellipsisWidth > maxWidth) return '';

  // Binary search on code-point count: linear trimming is O(n) measurements on a
  // long title, and titles are measured on every resize.
  const characters = [...text];
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    const candidate = characters.slice(0, mid).join('');
    if (measureWidth(candidate, font, metrics) + ellipsisWidth <= maxWidth) low = mid;
    else high = mid - 1;
  }
  if (low <= 0) return ellipsis;
  return characters.slice(0, low).join('').trimEnd() + ellipsis;
}

/**
 * Break a string into lines that each fit `maxWidth`.
 *
 * Breaks on spaces; a single word longer than the line is left long rather than
 * broken mid-word, and the caller decides whether to ellipsize it. Used for
 * captions and long titles.
 */
export function wrapText(
  text: string,
  font: Font,
  metrics: TextMetrics,
  maxWidth: number,
  maxLines = 3,
): string[] {
  if (text === '') return [];
  if (maxWidth <= 0) return [text];
  if (measureWidth(text, font, metrics) <= maxWidth) return [text];

  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (measureWidth(candidate, font, metrics) <= maxWidth || current === '') {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
    if (lines.length >= maxLines) break;
  }
  if (lines.length < maxLines && current !== '') lines.push(current);

  if (lines.length >= maxLines) {
    const consumed = lines.join(' ').length;
    if (consumed < text.length) {
      const last = lines[lines.length - 1] as string;
      const remainder = text.slice(consumed).trim();
      lines[lines.length - 1] = ellipsize(
        remainder === '' ? last : `${last} ${remainder}`,
        font,
        metrics,
        maxWidth,
      );
    }
  }
  return lines;
}

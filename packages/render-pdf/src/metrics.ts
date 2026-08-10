/**
 * `FontkitMetrics` (SPEC 21, SPEC 28.6): exact measurement from a real font file.
 *
 * This is the measuring half of custom-font support. It is complete and it is
 * used whenever the caller supplies fonts; the *drawing* half — embedding and
 * subsetting the same face into the PDF — is not implemented in this pass, so
 * {@link createFontkitMetrics} is only useful today to a caller who wants
 * measurement to match a face the screen uses. See `fonts.ts` for the seam.
 */

import fontkit from '@pdf-lib/fontkit';
import type { Font as FontkitFont } from '@pdf-lib/fontkit';
import type { Font, GlyphMetrics, TextMetrics } from '@mdv/core';
import type { FaceMetrics } from './fonts.js';
import { classifyFamily, createStandardFontMetrics, fontKeyId, fontKeyOf } from './fonts.js';

/** A font available to the exporter (SPEC 28.6). */
export interface EmbeddedFont {
  /** Family name as it appears in `Font.family`. */
  family: string;
  weight: number;
  style: 'normal' | 'italic';
  /** The font file. Subsetted on export; glyphs are emitted in codepoint order. */
  data: Uint8Array;
}

/** Thrown when a supplied font file cannot be read. Host error, not document error. */
export class FontLoadError extends Error {
  override readonly name = 'FontLoadError';
  constructor(
    readonly family: string,
    override readonly cause: unknown,
  ) {
    super(`Cannot read the font supplied for ${JSON.stringify(family)}`);
  }
}

/** Key an {@link EmbeddedFont} the same way a scene {@link Font} is keyed. */
function keyOfEmbedded(font: EmbeddedFont): string {
  return fontKeyId({
    family: classifyFamily(font.family),
    bold: font.weight >= 600,
    italic: font.style === 'italic',
  });
}

class FontkitFace implements FaceMetrics {
  readonly #font: FontkitFont;
  readonly #widths = new Map<number, number>();

  constructor(font: FontkitFont) {
    this.#font = font;
  }

  #advanceEm(codePoint: number): number {
    const cached = this.#widths.get(codePoint);
    if (cached !== undefined) return cached;
    const glyph = this.#font.glyphForCodePoint(codePoint);
    const em = glyph.advanceWidth / this.#font.unitsPerEm;
    this.#widths.set(codePoint, em);
    return em;
  }

  /**
   * Sum per-codepoint advances.
   *
   * `font.layout()` would apply kerning and substitution, but this pass does not
   * shape when it draws, so measuring with shaping on would put the ink and the
   * measurement in different places. When shaping lands, both sides move
   * together — that is the point of the interface.
   */
  widthOfTextAtSize(text: string, size: number): number {
    let em = 0;
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      em += this.#advanceEm(cp);
    }
    return em * size;
  }

  ascentAtSize(size: number): number {
    return (this.#font.ascent / this.#font.unitsPerEm) * size;
  }

  descentAtSize(size: number): number {
    return (Math.abs(this.#font.descent) / this.#font.unitsPerEm) * size;
  }

  missingCodePoints(text: string): readonly number[] {
    const missing = new Set<number>();
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d || cp === 0x20) continue;
      if (!this.#font.hasGlyphForCodePoint(cp)) missing.add(cp);
    }
    return [...missing].sort((a, b) => a - b);
  }
}

/**
 * Build the face table for a set of supplied fonts.
 *
 * Insertion order is the caller's order (SPEC 24.3 rule 5), so two runs over the
 * same list resolve the same face for an ambiguous request.
 */
export function loadFaces(fonts: readonly EmbeddedFont[]): ReadonlyMap<string, FaceMetrics> {
  const faces = new Map<string, FaceMetrics>();
  for (const font of fonts) {
    let parsed: FontkitFont;
    try {
      parsed = fontkit.create(font.data);
    } catch (error) {
      throw new FontLoadError(font.family, error);
    }
    const key = keyOfEmbedded(font);
    if (!faces.has(key)) faces.set(key, new FontkitFace(parsed));
  }
  return faces;
}

/**
 * The exact text-metrics provider (SPEC 21 `FontkitMetrics`): measurements come
 * from the supplied font files.
 *
 * A face the caller did not supply falls back to the standard-14 metrics for the
 * nearest generic family rather than throwing — a document that mixes one custom
 * face with the default stack still paginates.
 *
 * @throws FontLoadError when a supplied buffer is not a font. That is host
 * programmer error, not document content (SPEC 21).
 */
export function createFontkitMetrics(fonts: readonly EmbeddedFont[]): TextMetrics {
  const faces = loadFaces(fonts);
  const fallback = createStandardFontMetrics();
  return {
    measure(value: string, font: Font): GlyphMetrics {
      const face = faces.get(fontKeyId(fontKeyOf(font)));
      if (face === undefined) return fallback.measure(value, font);
      const letterSpacing = font.letterSpacing ?? 0;
      const extra = letterSpacing === 0 ? 0 : letterSpacing * [...value].length;
      return {
        width: face.widthOfTextAtSize(value, font.size) + extra,
        ascent: face.ascentAtSize(font.size),
        descent: face.descentAtSize(font.size),
      };
    },
  };
}

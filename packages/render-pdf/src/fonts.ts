/**
 * Fonts (SPEC 28.6).
 *
 * ## What this pass does, and what it does not
 *
 * Text is **real, selectable text** — never outlines. It is drawn with the PDF
 * standard 14 faces (Helvetica / Times / Courier), which every viewer has and
 * which need no font binary in the repository.
 *
 * SPEC 28.6 additionally requires embedded, subsetted faces with Latin, Greek
 * and Cyrillic coverage, `pdf.fonts` for CJK, the Unicode Bidirectional
 * Algorithm and HarfBuzz shaping at Level 3. **None of that is implemented
 * here**, and the exporter says so rather than pretending: a codepoint outside
 * WinAnsi is reported once as `MDV5100` with the offending codepoints and is
 * drawn as `?` by {@link toWinAnsi}, never silently dropped, and a run in a
 * script that needs shaping is reported as `MDV5101`.
 *
 * The seam for finishing the job is {@link FaceMetrics}. It is deliberately
 * expressed in terms of "measure" and "which codepoints are missing", so an
 * implementation over `@pdf-lib/fontkit` — which is already a dependency, and
 * which `createFontkitMetrics` already uses for measurement — drops in without
 * touching the painter, the paginator or the trace.
 */

import { StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import type { Font, GlyphMetrics, TextMetrics } from '@mdv/core';

/** The three generic families the standard 14 faces cover. */
export type GenericFamily = 'sans' | 'serif' | 'mono';

/** A resolved face: what a {@link Font} collapses to once the stack is walked. */
export interface FontKey {
  family: GenericFamily;
  bold: boolean;
  italic: boolean;
}

/** A stable, sortable key string, used for resource allocation maps. */
export function fontKeyId(key: FontKey): string {
  return `${key.family}${key.bold ? '-b' : ''}${key.italic ? '-i' : ''}`;
}

const MONO_HINTS = ['mono', 'courier', 'consolas', 'menlo', 'monaco', 'code'];
const SERIF_HINTS = ['serif', 'times', 'georgia', 'garamond', 'cambria', 'book'];

/**
 * Collapse a CSS font stack onto a generic family.
 *
 * The first name in the stack that maps to a generic wins, which is what a
 * browser does. `system-ui, -apple-system, "Segoe UI", sans-serif` — the default
 * theme stack — reaches `sans-serif` and lands on Helvetica.
 */
export function classifyFamily(family: string): GenericFamily {
  for (const rawName of family.split(',')) {
    const nameText = rawName
      .trim()
      .replace(/^["']|["']$/g, '')
      .toLowerCase();
    if (nameText === '') continue;
    if (MONO_HINTS.some((h) => nameText.includes(h))) return 'mono';
    // `sans-serif` contains `serif`, so it must be tested first.
    if (nameText.includes('sans')) return 'sans';
    if (SERIF_HINTS.some((h) => nameText.includes(h))) return 'serif';
  }
  return 'sans';
}

/** Resolve a scene {@link Font} to a face. Weight ≥ 600 is bold (SPEC 11.1). */
export function fontKeyOf(font: Font): FontKey {
  return {
    family: classifyFamily(font.family),
    bold: (font.weight ?? 400) >= 600,
    italic: font.style === 'italic',
  };
}

/** The standard-14 name for a face. */
export function standardFontName(key: FontKey): StandardFonts {
  if (key.family === 'mono') {
    if (key.bold && key.italic) return StandardFonts.CourierBoldOblique;
    if (key.bold) return StandardFonts.CourierBold;
    if (key.italic) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }
  if (key.family === 'serif') {
    if (key.bold && key.italic) return StandardFonts.TimesRomanBoldItalic;
    if (key.bold) return StandardFonts.TimesRomanBold;
    if (key.italic) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }
  if (key.bold && key.italic) return StandardFonts.HelveticaBoldOblique;
  if (key.bold) return StandardFonts.HelveticaBold;
  if (key.italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * The measuring half of a face, available **before** a `PDFDocument` exists.
 *
 * Pagination measures long before anything is written, so measurement cannot
 * depend on an embedded font object. Keeping the two halves apart is also what
 * lets `TableMetrics` (the deterministic default) and this exporter be swapped
 * for one another without the paginator noticing.
 */
export interface FaceMetrics {
  /** Advance width of `text` at `size`, in the same units as `size`. */
  widthOfTextAtSize(text: string, size: number): number;
  /** Baseline to the top of the tallest glyph, in the same units as `size`. */
  ascentAtSize(size: number): number;
  /** Baseline down to the lowest glyph, positive, in the same units as `size`. */
  descentAtSize(size: number): number;
  /** Codepoints in `text` this face cannot encode. Sorted, deduplicated. */
  missingCodePoints(text: string): readonly number[];
}

/** Cache key: the face plus the string. Bounded by {@link MEASURE_CACHE_LIMIT}. */
const MEASURE_CACHE_LIMIT = 4096;

/** WinAnsi covers Latin-1 plus a scatter of typographic characters. */
const WINANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

/** `true` when WinAnsiEncoding has a code for this codepoint. */
export function encodableInWinAnsi(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WINANSI_EXTRA.has(cp);
}

/** What an unencodable codepoint is drawn as. See {@link toWinAnsi}. */
export const WINANSI_FALLBACK = '?';

/** A tab is drawn as this many spaces. */
export const TAB_WIDTH = 4;

/**
 * Fold a string onto what WinAnsiEncoding can actually hold.
 *
 * **Both measurement and encoding go through this**, which is the point: a
 * substitution that changed the advance width would move every glyph after it
 * and silently break the line the paginator measured. A tab becomes four
 * spaces, and anything WinAnsi has no code for becomes `?` — visible, copyable,
 * and reported once as `MDV5100` with the exact codepoints, rather than an
 * invisible gap or a thrown exception from the encoder.
 */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x09) out += ' '.repeat(TAB_WIDTH);
    else if (cp === 0x0a || cp === 0x0d) out += ' ';
    else out += encodableInWinAnsi(cp) ? ch : WINANSI_FALLBACK;
  }
  return out;
}

/**
 * Scripts that need contextual shaping or a bidi pass. A run containing one of
 * these is reported as `MDV5101` rather than misrendered (SPEC 28.6).
 */
const COMPLEX_RANGES: readonly (readonly [number, number])[] = [
  [0x0590, 0x05ff], // Hebrew
  [0x0600, 0x06ff], // Arabic
  [0x0700, 0x074f], // Syriac
  [0x0900, 0x0dff], // Indic
  [0x0e00, 0x0e7f], // Thai
  [0x1780, 0x17ff], // Khmer
  [0xfb1d, 0xfdff], // Hebrew / Arabic presentation forms
  [0xfe70, 0xfeff],
];

/** `true` when the string contains a script this exporter cannot shape. */
export function needsShaping(value: string): boolean {
  for (const ch of value) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    for (const [lo, hi] of COMPLEX_RANGES) {
      if (cp >= lo && cp <= hi) return true;
    }
  }
  return false;
}

/**
 * `pdf-lib` re-declares the standard-14 names as its own `StandardFonts` enum
 * while `StandardFontEmbedder.for` still asks for `@pdf-lib/standard-fonts`'
 * `FontNames`. The two enums have identical members and identical values, so
 * one cast at one call site is the whole of the workaround.
 */
type FontNamesArg = Parameters<typeof StandardFontEmbedder.for>[0];

class StandardFaceMetrics implements FaceMetrics {
  readonly #embedder: StandardFontEmbedder;
  readonly #widths = new Map<number, number>();

  constructor(name: StandardFonts) {
    this.#embedder = StandardFontEmbedder.for(name as unknown as FontNamesArg);
  }

  /**
   * Sum per-codepoint advances rather than calling the embedder on the whole
   * string.
   *
   * `StandardFontEmbedder.widthOfTextAtSize` adds AFM kern pairs, but a `Tj`
   * with a simple Type 1 font applies no kerning — the measurement would then
   * be narrower than the ink and a label that "fits" would overhang. Measuring
   * codepoint by codepoint is exactly what gets drawn.
   *
   * The string is folded through {@link toWinAnsi} first, so the width is the
   * width of the glyphs that will actually be encoded — and so a tab or an
   * unmappable codepoint cannot make the encoder throw mid-measurement.
   */
  widthOfTextAtSize(text: string, size: number): number {
    let em = 0;
    for (const ch of toWinAnsi(text)) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      let w = this.#widths.get(cp);
      if (w === undefined) {
        w = this.#embedder.widthOfTextAtSize(ch, 1);
        if (this.#widths.size < MEASURE_CACHE_LIMIT) this.#widths.set(cp, w);
      }
      em += w;
    }
    return em * size;
  }

  ascentAtSize(size: number): number {
    const ascender = this.#embedder.font.Ascender;
    return ((typeof ascender === 'number' ? ascender : 718) / 1000) * size;
  }

  descentAtSize(size: number): number {
    const descender = this.#embedder.font.Descender;
    return (Math.abs(typeof descender === 'number' ? descender : 207) / 1000) * size;
  }

  missingCodePoints(text: string): readonly number[] {
    const missing = new Set<number>();
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === undefined) continue;
      // Whitespace is folded, not lost, so it is not a missing glyph.
      if (cp === 0x09 || cp === 0x0a || cp === 0x0d) continue;
      if (encodableInWinAnsi(cp)) continue;
      missing.add(cp);
    }
    return [...missing].sort((a, b) => a - b);
  }

  /** The embedder, for the writer half. */
  get embedder(): StandardFontEmbedder {
    return this.#embedder;
  }
}

const STANDARD_FACES = new Map<string, StandardFaceMetrics>();

/** The measuring half of a standard-14 face. Shared; the AFM tables are large. */
export function standardFace(key: FontKey): FaceMetrics {
  const id = fontKeyId(key);
  let face = STANDARD_FACES.get(id);
  if (face === undefined) {
    face = new StandardFaceMetrics(standardFontName(key));
    STANDARD_FACES.set(id, face);
  }
  return face;
}

/**
 * A {@link TextMetrics} over the standard 14 faces.
 *
 * **This is the metrics provider the exporter defaults to, and it is the one
 * that makes PDF pagination agree with what PDF actually draws.** It does *not*
 * agree with the browser, which draws `system-ui`; a document exported with
 * these metrics and rendered on screen with `CanvasMetrics` will break its lines
 * in slightly different places. That is the honest consequence of not embedding
 * the theme's own face, and it is why {@link createFontkitMetrics} exists.
 */
export function createStandardFontMetrics(): TextMetrics {
  return {
    measure(value: string, font: Font): GlyphMetrics {
      const face = standardFace(fontKeyOf(font));
      const size = font.size;
      const letterSpacing = font.letterSpacing ?? 0;
      const extra = letterSpacing === 0 ? 0 : letterSpacing * [...value].length;
      return {
        width: face.widthOfTextAtSize(value, size) + extra,
        ascent: face.ascentAtSize(size),
        descent: face.descentAtSize(size),
      };
    },
  };
}

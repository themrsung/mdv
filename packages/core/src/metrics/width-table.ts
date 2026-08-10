/**
 * The bundled advance-width table for the default font stack (SPEC 21,
 * SPEC 24.3 rule 6).
 *
 * Widths are **per em**, so a measurement is `width[ch] × fontSize`. The table
 * models the metrics of the grotesque that every member of
 * `system-ui, -apple-system, "Segoe UI", sans-serif` resolves to on its own
 * platform — San Francisco, Segoe UI, Roboto and Helvetica agree to within a
 * couple of percent across the Latin range, and a couple of percent is well
 * inside the slack the collision resolver already carries.
 *
 * The point is not perfection. The point is that the *same* number comes out on
 * every machine, so a golden file recorded on CI matches a developer's laptop and
 * PDF pagination matches the screen. Where exactness matters — an embedded font
 * in a PDF — `FontkitMetrics` reads the real font instead.
 */

/** Advance widths per em for U+0020…U+007E, indexed by `code − 32`. */
const ASCII_WIDTHS: readonly number[] = Object.freeze([
  0.26, // space
  0.26, // !
  0.35, // "
  0.556, // #
  0.556, // $
  0.867, // %
  0.667, // &
  0.191, // '
  0.333, // (
  0.333, // )
  0.389, // *
  0.584, // +
  0.278, // ,
  0.333, // -
  0.278, // .
  0.278, // /
  0.556, // 0
  0.556, // 1
  0.556, // 2
  0.556, // 3
  0.556, // 4
  0.556, // 5
  0.556, // 6
  0.556, // 7
  0.556, // 8
  0.556, // 9
  0.278, // :
  0.278, // ;
  0.584, // <
  0.584, // =
  0.584, // >
  0.556, // ?
  1.015, // @
  0.667, // A
  0.667, // B
  0.722, // C
  0.722, // D
  0.667, // E
  0.611, // F
  0.778, // G
  0.722, // H
  0.278, // I
  0.5, // J
  0.667, // K
  0.556, // L
  0.833, // M
  0.722, // N
  0.778, // O
  0.667, // P
  0.778, // Q
  0.722, // R
  0.667, // S
  0.611, // T
  0.722, // U
  0.667, // V
  0.944, // W
  0.667, // X
  0.667, // Y
  0.611, // Z
  0.278, // [
  0.278, // backslash
  0.278, // ]
  0.469, // ^
  0.556, // _
  0.333, // `
  0.556, // a
  0.556, // b
  0.5, // c
  0.556, // d
  0.556, // e
  0.278, // f
  0.556, // g
  0.556, // h
  0.222, // i
  0.222, // j
  0.5, // k
  0.222, // l
  0.833, // m
  0.556, // n
  0.556, // o
  0.556, // p
  0.556, // q
  0.333, // r
  0.5, // s
  0.278, // t
  0.556, // u
  0.5, // v
  0.722, // w
  0.5, // x
  0.5, // y
  0.5, // z
  0.334, // {
  0.26, // |
  0.334, // }
  0.584, // ~
]);

/** Named widths for characters a chart actually emits outside ASCII. */
const NAMED_WIDTHS: Readonly<Record<string, number>> = Object.freeze({
  ' ': 0.26, // no-break space
  ' ': 0.556, // figure space
  ' ': 0.2, // narrow no-break space (the fr group separator)
  ' ': 0.2, // thin space
  '–': 0.556, // en dash
  '—': 1.0, // em dash
  '‘': 0.222, // ‘
  '’': 0.222, // ’
  '“': 0.333, // “
  '”': 0.333, // ”
  '…': 1.0, // …
  '−': 0.584, // − (the minus the number formatter emits)
  '°': 0.4, // °
  '±': 0.584, // ±
  '×': 0.584, // ×
  '÷': 0.584, // ÷
  '€': 0.556, // €
  '£': 0.556, // £
  '¥': 0.556, // ¥
  '₩': 0.556, // ₩
  '₹': 0.556, // ₹
  '₽': 0.556, // ₽
  '₺': 0.556, // ₺
  '↑': 0.6, // ↑
  '↓': 0.6, // ↓
  '→': 0.7, // →
  '▲': 0.7, // ▲
  '▼': 0.7, // ▼
  '•': 0.35, // •
  '∞': 0.7, // ∞
});

/** Fallback width for a code point outside the table, by Unicode block. */
function fallbackWidth(codePoint: number): number {
  // Combining marks and zero-width formatting characters advance nothing.
  if (codePoint === 0x200b || codePoint === 0x200c || codePoint === 0x200d) return 0;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return 0;
  if (codePoint >= 0xfe00 && codePoint <= 0xfe0f) return 0;

  // Latin-1 / Latin Extended: accented letters advance like their base letter.
  if (codePoint < 0x0250) return 0.556;
  // Greek and Cyrillic sit in the same optical range as Latin.
  if (codePoint < 0x0400) return 0.6;
  if (codePoint < 0x0530) return 0.6;
  // Hebrew, Arabic, Indic: narrower on average, and shaped — an approximation.
  if (codePoint < 0x1000) return 0.55;
  // CJK ideographs, kana, Hangul and full-width forms are full-em squares.
  if (codePoint >= 0x1100 && codePoint <= 0x115f) return 1;
  if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 1;
  if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 1;
  if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 1;
  if (codePoint >= 0xfe30 && codePoint <= 0xfe6f) return 1;
  if (codePoint >= 0xff00 && codePoint <= 0xff60) return 1;
  if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 1;
  if (codePoint >= 0x20000 && codePoint <= 0x3fffd) return 1;
  // Emoji and other astral symbols render as a square glyph.
  if (codePoint >= 0x1f300 && codePoint <= 0x1faff) return 1.2;
  if (codePoint >= 0x2190 && codePoint <= 0x2bff) return 0.8;
  return 0.6;
}

/** Advance width, per em, of a single code point. */
export function codePointWidth(codePoint: number): number {
  if (codePoint >= 32 && codePoint <= 126) return ASCII_WIDTHS[codePoint - 32] as number;
  const named = NAMED_WIDTHS[String.fromCodePoint(codePoint)];
  if (named !== undefined) return named;
  if (codePoint === 9) return 4 * 0.26; // tab: four spaces
  if (codePoint < 32) return 0;
  return fallbackWidth(codePoint);
}

/**
 * Advance width of a string, per em.
 *
 * Iterates by code point, so an astral character counts once rather than twice.
 * No kerning and no shaping: the table is a sum of advances, which is what makes
 * it cheap enough to call for every tick label on every resize.
 */
export function stringWidthEm(text: string): number {
  let total = 0;
  for (const character of text) total += codePointWidth(character.codePointAt(0) ?? 32);
  return total;
}

/**
 * Vertical metrics of the default stack, per em.
 *
 * Ascent covers accented capitals, so a title's box never crops an `Å`.
 */
export const DEFAULT_ASCENT = 0.905;
/** Descent below the alphabetic baseline, per em, positive. */
export const DEFAULT_DESCENT = 0.212;

/**
 * Width multiplier by font weight.
 *
 * A bold grotesque is a few percent wider than its regular, and treating them as
 * identical is exactly how a bold legend title overruns its box.
 */
export function weightFactor(weight: number | undefined): number {
  if (weight === undefined) return 1;
  if (weight >= 700) return 1.05;
  if (weight >= 600) return 1.03;
  if (weight <= 300) return 0.98;
  return 1;
}

/** Width multiplier for italics; the oblique of a grotesque keeps its advances. */
export function styleFactor(style: 'normal' | 'italic' | undefined): number {
  return style === 'italic' ? 1.0 : 1.0;
}

/**
 * Grapheme-cluster boundaries.
 *
 * Backspace must delete one *user-perceived character*, not one UTF-16 code
 * unit. `"👩‍👩‍👧‍👦".length === 11`; deleting a code unit there produces mojibake, and
 * deleting a code point produces a different family. Combining marks, regional
 * indicator pairs, variation selectors, keycap sequences, and Hangul jamo all
 * have the same problem.
 *
 * `Intl.Segmenter` is used when the host provides it (Node ≥ 16, every current
 * browser); the locale is pinned to `en` so results do not vary with the user's
 * locale. The fallback implements the parts of UAX #29 that matter in practice:
 * CRLF, surrogate pairs, extend/spacing-mark/ZWJ continuation, emoji ZWJ
 * sequences, regional-indicator pairing, and Hangul syllable composition.
 */

/** Segments a string into grapheme clusters. */
export type GraphemeSegmenter = (text: string) => readonly string[];

type SegmenterCtor = new (
  locale: string,
  options: { granularity: 'grapheme' },
) => { segment(input: string): Iterable<{ segment: string }> };

function intlSegmenter(): GraphemeSegmenter | undefined {
  const ctor = (globalThis as { Intl?: { Segmenter?: SegmenterCtor } }).Intl?.Segmenter;
  if (typeof ctor !== 'function') return undefined;
  const instance = new ctor('en', { granularity: 'grapheme' });
  return (text) => {
    const out: string[] = [];
    for (const part of instance.segment(text)) out.push(part.segment);
    return out;
  };
}

const REGIONAL_INDICATOR_START = 0x1f1e6;
const REGIONAL_INDICATOR_END = 0x1f1ff;
const ZWJ = 0x200d;

function isExtend(code: number): boolean {
  return (
    (code >= 0x0300 && code <= 0x036f) || // combining diacritical marks
    (code >= 0x0483 && code <= 0x0489) ||
    (code >= 0x0591 && code <= 0x05bd) ||
    (code >= 0x0610 && code <= 0x061a) ||
    (code >= 0x064b && code <= 0x065f) ||
    (code >= 0x06d6 && code <= 0x06dc) ||
    (code >= 0x0900 && code <= 0x0903) || // Devanagari signs (incl. spacing marks)
    (code >= 0x093a && code <= 0x094f) ||
    (code >= 0x0951 && code <= 0x0957) ||
    (code >= 0x0981 && code <= 0x0983) || // Bengali signs
    (code >= 0x09bc && code <= 0x09cd) ||
    (code >= 0x0a81 && code <= 0x0a83) || // Gujarati signs
    (code >= 0x0abc && code <= 0x0acd) ||
    (code >= 0x0b01 && code <= 0x0b03) || // Oriya signs
    (code >= 0x0b3c && code <= 0x0b4d) ||
    (code >= 0x0c00 && code <= 0x0c04) || // Telugu signs
    (code >= 0x0c3e && code <= 0x0c4d) ||
    (code >= 0x0d00 && code <= 0x0d03) || // Malayalam signs
    (code >= 0x0d3b && code <= 0x0d4d) ||
    (code >= 0x0e31 && code <= 0x0e31) ||
    (code >= 0x0e34 && code <= 0x0e3a) ||
    (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) ||
    (code >= 0x20d0 && code <= 0x20f0) || // combining marks for symbols
    (code >= 0xfe00 && code <= 0xfe0f) || // variation selectors
    (code >= 0xfe20 && code <= 0xfe2f) ||
    code === 0x200c || // ZWNJ
    code === ZWJ
  );
}

/**
 * `Indic_Conjunct_Break=Linker`: a virama that fuses the consonants on either
 * side into a single conjunct glyph. Unicode 15.1's rule GB9c forbids breaking
 * across one, so `क्ष` is one grapheme rather than two.
 */
function isIndicLinker(code: number): boolean {
  return (
    code === 0x094d || // Devanagari
    code === 0x09cd || // Bengali
    code === 0x0acd || // Gujarati
    code === 0x0b4d || // Oriya
    code === 0x0c4d || // Telugu
    code === 0x0d4d // Malayalam
  );
}

/**
 * An approximation of `Indic_Conjunct_Break=Consonant`, covering the letter
 * ranges of the six scripts whose viramas are linkers. Only consulted directly
 * after a linker, so a false positive elsewhere is impossible.
 */
function isIndicConsonant(code: number): boolean {
  return (
    (code >= 0x0915 && code <= 0x0939) || // Devanagari
    (code >= 0x0958 && code <= 0x095f) ||
    (code >= 0x0978 && code <= 0x097f) ||
    (code >= 0x0995 && code <= 0x09b9) || // Bengali
    (code >= 0x09dc && code <= 0x09df) ||
    (code >= 0x0a95 && code <= 0x0ab9) || // Gujarati
    (code >= 0x0b15 && code <= 0x0b39) || // Oriya
    (code >= 0x0b5c && code <= 0x0b5d) ||
    (code >= 0x0c15 && code <= 0x0c39) || // Telugu
    (code >= 0x0c58 && code <= 0x0c5a) ||
    (code >= 0x0d15 && code <= 0x0d3a) // Malayalam
  );
}

function isEmojiModifier(code: number): boolean {
  return code >= 0x1f3fb && code <= 0x1f3ff; // skin tone modifiers
}

function isRegionalIndicator(code: number): boolean {
  return code >= REGIONAL_INDICATOR_START && code <= REGIONAL_INDICATOR_END;
}

/** Hangul syllable type, or `null` for anything else. */
function hangulType(code: number): 'L' | 'V' | 'T' | 'LV' | 'LVT' | null {
  if (code >= 0x1100 && code <= 0x115f) return 'L';
  if (code >= 0x1160 && code <= 0x11a7) return 'V';
  if (code >= 0x11a8 && code <= 0x11ff) return 'T';
  if (code >= 0xac00 && code <= 0xd7a3) return (code - 0xac00) % 28 === 0 ? 'LV' : 'LVT';
  return null;
}

function hangulJoins(previous: number, next: number): boolean {
  const a = hangulType(previous);
  const b = hangulType(next);
  if (a === null || b === null) return false;
  if (a === 'L') return b === 'L' || b === 'V' || b === 'LV' || b === 'LVT';
  if (a === 'V' || a === 'LV') return b === 'V' || b === 'T';
  if (a === 'T' || a === 'LVT') return b === 'T';
  return false;
}

/**
 * Portable fallback segmenter. Correct for the cases an editor actually meets;
 * it does not implement the full UAX #29 property tables.
 */
export const fallbackSegmenter: GraphemeSegmenter = (text) => {
  const out: string[] = [];
  let cluster = '';
  let previous = -1;
  let regionalRun = 0;
  /** A linker is pending until the consonant that closes the conjunct arrives. */
  let linkerPending = false;

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;

    if (cluster === '') {
      cluster = character;
      previous = code;
      regionalRun = isRegionalIndicator(code) ? 1 : 0;
      linkerPending = isIndicLinker(code);
      continue;
    }

    let joins = false;
    if (previous === 0x000d && code === 0x000a) {
      joins = true; // CRLF is one cluster
    } else if (previous === 0x000a || previous === 0x000d || code === 0x000a || code === 0x000d) {
      joins = false;
    } else if (isExtend(code) || isEmojiModifier(code)) {
      joins = true;
    } else if (previous === ZWJ) {
      joins = true; // emoji ZWJ sequence continues
    } else if (linkerPending && isIndicConsonant(code)) {
      joins = true; // GB9c: consonant + virama + consonant is one conjunct
    } else if (isRegionalIndicator(code) && isRegionalIndicator(previous) && regionalRun % 2 === 1) {
      joins = true;
    } else if (hangulJoins(previous, code)) {
      joins = true;
    }

    if (joins) {
      cluster += character;
      regionalRun = isRegionalIndicator(code) ? regionalRun + 1 : 0;
      // A linker stays pending across the extends that may follow it, and is
      // spent by the consonant it joins to.
      if (isIndicLinker(code)) linkerPending = true;
      else if (!isExtend(code)) linkerPending = false;
    } else {
      out.push(cluster);
      cluster = character;
      regionalRun = isRegionalIndicator(code) ? 1 : 0;
      linkerPending = isIndicLinker(code);
    }
    previous = code;
  }

  if (cluster !== '') out.push(cluster);
  return out;
};

/** The segmenter the engine uses by default. */
export const defaultSegmenter: GraphemeSegmenter = intlSegmenter() ?? fallbackSegmenter;

/**
 * Offset of the grapheme boundary immediately **before** `offset`.
 * Returns `offset` unchanged when it is already 0.
 */
export function previousBoundary(
  text: string,
  offset: number,
  segment: GraphemeSegmenter = defaultSegmenter,
): number {
  if (offset <= 0) return 0;
  const limit = Math.min(offset, text.length);
  let cursor = 0;
  let previous = 0;
  for (const cluster of segment(text.slice(0, limit))) {
    if (cursor >= limit) break;
    previous = cursor;
    cursor += cluster.length;
  }
  return cursor >= limit ? previous : cursor;
}

/**
 * Offset of the grapheme boundary immediately **after** `offset`.
 * Returns `offset` unchanged when it is already at the end.
 */
export function nextBoundary(
  text: string,
  offset: number,
  segment: GraphemeSegmenter = defaultSegmenter,
): number {
  if (offset >= text.length) return text.length;
  const from = Math.max(0, offset);
  const clusters = segment(text.slice(from));
  const first = clusters[0];
  return first ? from + first.length : text.length;
}

/** Number of user-perceived characters in `text`. */
export function graphemeLength(
  text: string,
  segment: GraphemeSegmenter = defaultSegmenter,
): number {
  return segment(text).length;
}

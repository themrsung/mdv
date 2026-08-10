/**
 * Inline runs and line breaking for the document flow (SPEC 28.3).
 *
 * Measurement goes through the injected {@link TextMetrics} and nothing else.
 * `TextMetrics.measure` is linear in `Font.size`, so the exporter passes sizes
 * in **points** and gets point widths back — the provider is a pure ratio table
 * and does not care which unit it is handed. That is what lets the paginator and
 * the chart layout, which measures in pixels, be the same provider and therefore
 * agree about whether a label fits.
 */

import type { Font, TextMetrics } from '@mdv/core';

/** A stretch of text in one style. */
export interface TextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  /** Strike-through (GFM `~~`). */
  strike?: boolean;
  /** An external URL; becomes a `/Link` annotation (SPEC 28.7). */
  href?: string;
  /** A named internal destination; becomes an internal `/Link` (SPEC 28.7). */
  dest?: string;
  /** Raise by 1/3 em and shrink: footnote references and `:mdv-ref` markers. */
  superscript?: boolean;
  /** Overrides the style's colour. */
  color?: string;
}

/** Resolved typography for a block of text. */
export interface TextStyle {
  /** Point size. */
  sizePt: number;
  /** Unitless multiplier of {@link sizePt}. */
  lineHeight: number;
  color: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  align?: 'left' | 'center' | 'right';
  /** Font stack handed to the metrics provider and to face classification. */
  family: string;
  monoFamily: string;
}

/** One run, placed on a line. */
export interface PlacedRun {
  run: TextRun;
  /** Offset from the line's left edge, in points. */
  xPt: number;
  widthPt: number;
  font: Font;
  color: string;
}

/** One laid-out line. */
export interface LineBox {
  runs: PlacedRun[];
  widthPt: number;
  /** Full line advance, `sizePt × lineHeight`. */
  heightPt: number;
  /** Baseline distance from the top of the line box. */
  baselinePt: number;
}

/** Build the {@link Font} a run is measured and drawn with. */
export function fontFor(style: TextStyle, run: TextRun): Font {
  const mono = run.mono === true || style.mono === true;
  const size = run.superscript === true ? style.sizePt * 0.7 : style.sizePt;
  const font: Font = {
    family: mono ? style.monoFamily : style.family,
    size,
  };
  if (run.bold === true || style.bold === true) font.weight = 700;
  if (run.italic === true || style.italic === true) font.style = 'italic';
  return font;
}

/**
 * Split a run's text into breakable pieces.
 *
 * Words plus their trailing whitespace, so a break point is always *after* the
 * space and a line never starts with one. CJK is broken between characters,
 * which is the correct behaviour for those scripts and is why the segmenter is
 * not a plain `split(' ')`.
 */
function segments(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let sawSpace = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const isSpace = ch === ' ' || ch === '\t';
    const isCjk =
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff);
    if (isSpace) {
      current += ch;
      sawSpace = true;
      continue;
    }
    if (sawSpace) {
      out.push(current);
      current = '';
      sawSpace = false;
    }
    if (isCjk) {
      if (current !== '') out.push(current);
      out.push(ch);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current !== '') out.push(current);
  return out;
}

interface Piece {
  text: string;
  run: TextRun;
  font: Font;
  widthPt: number;
  color: string;
  /** `true` when the piece is only whitespace and may be dropped at a break. */
  blank: boolean;
}

/**
 * Break runs into lines at `widthPt`.
 *
 * A single unbreakable segment wider than the column is placed on its own line
 * and allowed to overflow rather than being chopped mid-word: a truncated URL
 * that looks like a complete one is worse than a line that runs into the margin,
 * and the alternative — hyphenation — is locale-dependent and therefore banned
 * by SPEC 24.3 rule 3.
 */
export function layoutRuns(
  runs: readonly TextRun[],
  widthPt: number,
  style: TextStyle,
  metrics: TextMetrics,
): LineBox[] {
  const pieces: Piece[] = [];
  for (const run of runs) {
    const font = fontFor(style, run);
    const color = run.color ?? style.color;
    for (const seg of segments(run.text)) {
      const trimmed = seg.trimEnd();
      pieces.push({
        text: seg,
        run,
        font,
        color,
        widthPt: metrics.measure(trimmed === '' ? seg : trimmed, font).width,
        blank: trimmed === '',
      });
    }
  }

  const lines: LineBox[] = [];
  let currentPieces: Piece[] = [];
  let x = 0;

  const flush = (): void => {
    if (currentPieces.length === 0) return;
    // Trailing whitespace never counts toward the line's width.
    while (currentPieces.length > 0 && (currentPieces[currentPieces.length - 1] as Piece).blank) {
      currentPieces.pop();
    }
    if (currentPieces.length === 0) {
      x = 0;
      return;
    }
    lines.push(assemble(currentPieces, style));
    currentPieces = [];
    x = 0;
  };

  for (const piece of pieces) {
    if (currentPieces.length > 0 && x + piece.widthPt > widthPt + 0.01 && !piece.blank) {
      flush();
    }
    if (currentPieces.length === 0 && piece.blank) continue;
    currentPieces.push(piece);
    x += piece.widthPt;
  }
  flush();

  if (lines.length === 0) {
    lines.push({
      runs: [],
      widthPt: 0,
      heightPt: style.sizePt * style.lineHeight,
      baselinePt: style.sizePt * style.lineHeight * 0.78,
    });
  }
  return lines;
}

function assemble(pieces: readonly Piece[], style: TextStyle): LineBox {
  const placed: PlacedRun[] = [];
  let x = 0;
  let maxSize = style.sizePt;
  for (const piece of pieces) {
    const last = placed[placed.length - 1];
    if (last !== undefined && last.run === piece.run && last.font === piece.font) {
      last.run = { ...last.run, text: last.run.text + piece.text };
      last.widthPt += piece.widthPt;
    } else {
      placed.push({
        run: { ...piece.run, text: piece.text },
        xPt: x,
        widthPt: piece.widthPt,
        font: piece.font,
        color: piece.color,
      });
    }
    x += piece.widthPt;
    if (piece.font.size > maxSize) maxSize = piece.font.size;
  }
  const heightPt = maxSize * style.lineHeight;
  return { runs: placed, widthPt: x, heightPt, baselinePt: heightPt * 0.78 };
}

/** Measure a single-style string. */
export function measureText(value: string, style: TextStyle, metrics: TextMetrics): number {
  return metrics.measure(value, fontFor(style, { text: value })).width;
}

/**
 * Shorten `value` with an ellipsis so it fits `widthPt`.
 *
 * Used only for table cells and header/footer slots, where the alternative is
 * overlapping ink. Body text wraps instead — truncating a sentence loses data.
 */
export function ellipsize(
  value: string,
  widthPt: number,
  style: TextStyle,
  metrics: TextMetrics,
): string {
  if (measureText(value, style, metrics) <= widthPt) return value;
  const chars = [...value];
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const candidate = `${chars.slice(0, mid).join('')}…`;
    if (measureText(candidate, style, metrics) <= widthPt) lo = mid;
    else hi = mid - 1;
  }
  return lo <= 0 ? '…' : `${chars.slice(0, lo).join('')}…`;
}

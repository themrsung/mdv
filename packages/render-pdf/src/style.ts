/**
 * Document typography for the PDF flow (SPEC 28.3).
 *
 * The theme (SPEC 11.1) sizes *charts*, in CSS pixels. A printed page is not a
 * screen, so the exporter derives the prose scale from the same tokens rather
 * than inventing a second design system: the body size is the theme's label size
 * converted at 1 px = 0.75 pt, and every other size is a ratio of it. A theme
 * that bumps `type.fontSize` therefore moves the chart labels and the running
 * text together, which is the only way the two can keep looking like one
 * document.
 *
 * Everything here is a pure function of the theme, so two exports of the same
 * document produce the same measurements (SPEC 24.3).
 */

import type { Theme } from '@mdv/core';
import type { TextStyle } from './text.js';
import { pxToPt } from './units.js';

/**
 * Heading sizes as multiples of the body size, `h1` … `h6`.
 *
 * `h5`/`h6` are body-sized and lean on weight and colour, because a printed
 * heading smaller than the text it introduces reads as a mistake.
 */
export const HEADING_SCALE: readonly number[] = [2, 1.6, 1.3, 1.15, 1, 0.92];

/** Space above a heading, in ems of the body size, by level. */
const HEADING_SPACE_BEFORE: readonly number[] = [1.7, 1.35, 1.05, 0.9, 0.8, 0.8];

/** A monospace stack. The theme has one family; code still needs fixed pitch. */
const MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Resolved measurements for one document, in points unless stated. */
export interface DocStyle {
  /** Body size in points. */
  bodySizePt: number;
  lineHeight: number;
  family: string;
  monoFamily: string;

  body: TextStyle;
  /** `level` is 1–6; out-of-range levels clamp. */
  heading(level: number): TextStyle;
  code: TextStyle;
  caption: TextStyle;
  /** `mdv-tab` titles and `mdv-details` summaries. */
  subheading: TextStyle;
  tableHeader: TextStyle;
  tableCell: TextStyle;
  footnote: TextStyle;
  /** Running header/footer, and the link appendix. */
  running: TextStyle;
  tocEntry: TextStyle;
  tocTitle: TextStyle;

  /** Gap after a paragraph. */
  paragraphGapPt: number;
  /** Gap above a heading of `level`. */
  headingSpaceBefore(level: number): number;
  headingSpaceAfterPt: number;
  /** Gap between list items in the same list. */
  listGapPt: number;
  /** One level of list indentation. */
  indentStepPt: number;
  /** Text inset of a blockquote, per level of nesting. */
  quoteIndentPt: number;
  /** Width of the blockquote rule. */
  quoteBarPt: number;
  /** Padding inside a code block. */
  codePaddingPt: number;
  /** Vertical space around a thematic break. */
  ruleGapPt: number;
  /** Space above and below a visual block or a table. */
  blockGapPt: number;
  /** Vertical padding inside a table cell. */
  cellPadYPt: number;
  /** Horizontal padding inside a table cell. */
  cellPadXPt: number;
  /** Space between the note separator and the first footnote. */
  footnoteGapPt: number;
  /** Distance from the text column to the running header/footer baseline. */
  runningGapPt: number;

  colors: {
    text: string;
    secondary: string;
    muted: string;
    border: string;
    grid: string;
    surface: string;
    page: string;
    /** Links keep the accessible text colour and are underlined instead — SPEC
     * 11.1 has no link role, and colour alone is never the signal (SPEC 16.2). */
    link: string;
  };
}

function styleOf(base: TextStyle, sizePt: number, over: Partial<TextStyle> = {}): TextStyle {
  return { ...base, sizePt, ...over };
}

/** Derive the document scale from a theme. */
export function createDocStyle(theme: Theme): DocStyle {
  const bodySizePt = pxToPt(theme.type.fontSize);
  const lineHeight = theme.type.lineHeight;
  const family = theme.type.fontFamily;
  const em = (n: number): number => n * bodySizePt;

  const text = theme.tokens['text-primary'];
  const secondary = theme.tokens['text-secondary'];
  const muted = theme.tokens['text-muted'];

  const body: TextStyle = {
    sizePt: bodySizePt,
    lineHeight,
    color: text,
    family,
    monoFamily: MONO_STACK,
  };

  const headings = HEADING_SCALE.map((scale) =>
    styleOf(body, bodySizePt * scale, { bold: true, lineHeight: scale >= 1.3 ? 1.2 : 1.3 }),
  );

  return {
    bodySizePt,
    lineHeight,
    family,
    monoFamily: MONO_STACK,

    body,
    heading(level: number): TextStyle {
      const index = Math.min(Math.max(Math.trunc(level), 1), 6) - 1;
      // `headings` is built from HEADING_SCALE, so the index is in range; the
      // fallback exists only to satisfy noUncheckedIndexedAccess.
      return headings[index] ?? headings[5] ?? body;
    },
    code: styleOf(body, bodySizePt * 0.88, { mono: true, lineHeight: 1.35 }),
    caption: styleOf(body, bodySizePt * 0.9, { color: secondary }),
    subheading: styleOf(body, bodySizePt * 1.05, { bold: true }),
    tableHeader: styleOf(body, bodySizePt * 0.92, { bold: true }),
    tableCell: styleOf(body, bodySizePt * 0.92),
    footnote: styleOf(body, bodySizePt * 0.82, { color: secondary, lineHeight: 1.3 }),
    running: styleOf(body, bodySizePt * 0.82, { color: muted }),
    tocEntry: body,
    tocTitle: styleOf(body, bodySizePt * 1.6, { bold: true, lineHeight: 1.2 }),

    paragraphGapPt: em(0.62),
    headingSpaceBefore(level: number): number {
      const index = Math.min(Math.max(Math.trunc(level), 1), 6) - 1;
      return em(HEADING_SPACE_BEFORE[index] ?? 0.8);
    },
    headingSpaceAfterPt: em(0.34),
    listGapPt: em(0.22),
    indentStepPt: em(1.5),
    quoteIndentPt: em(1),
    quoteBarPt: 2,
    codePaddingPt: em(0.55),
    ruleGapPt: em(0.9),
    blockGapPt: em(0.85),
    cellPadYPt: em(0.32),
    cellPadXPt: em(0.5),
    footnoteGapPt: em(0.5),
    runningGapPt: em(1.1),

    colors: {
      text,
      secondary,
      muted,
      border: theme.tokens.border,
      grid: theme.tokens.grid,
      surface: theme.tokens.surface,
      page: theme.tokens.page,
      link: text,
    },
  };
}

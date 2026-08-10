/**
 * Units and page geometry (SPEC 28.2).
 *
 * The exporter works in **PDF points** for everything page-shaped (page box,
 * margins, header band) and in **CSS pixels** for everything scene-shaped, with
 * the single conversion `1 px = 0.75 pt` living here. Keeping the two spaces
 * explicit is what lets SPEC 28.5's "the layout re-runs at the print width" be
 * true: the column width in points is converted to pixels, layout runs at that
 * pixel width, and the resulting scene is drawn 1:1.
 */

/** `1 px = 0.75 pt` at 96 dpi (SPEC 28.2). */
export const PT_PER_PX = 0.75;
/** `1 pt = 4/3 px`. */
export const PX_PER_PT = 1 / PT_PER_PX;

/** CSS pixels → PDF points. */
export function pxToPt(px: number): number {
  return px * PT_PER_PX;
}

/** PDF points → CSS pixels. */
export function ptToPx(pt: number): number {
  return pt * PX_PER_PT;
}

/** Points per unit, for every unit SPEC 28.2 lists. */
const UNIT_PT: Readonly<Record<string, number>> = {
  pt: 1,
  px: PT_PER_PX,
  in: 72,
  mm: 72 / 25.4,
  cm: 720 / 25.4,
  pc: 12,
};

/** Thrown for a malformed page size, margin or length in `pdf:` options. */
export class PdfUnitError extends Error {
  override readonly name = 'PdfUnitError';
  constructor(
    readonly input: string,
    readonly what: string,
  ) {
    super(`Cannot read ${what} from ${JSON.stringify(input)} — expected e.g. "24mm", "1in", 18`);
  }
}

/**
 * Parse a length into points.
 *
 * A bare number is **device pixels**, matching SPEC 5.3.3's dimension rule, so
 * `margin: 24` and `margin: 24px` mean the same thing. `%` is not a length here:
 * a page has no percentage basis, and silently treating `10%` as `10pt` is the
 * kind of quiet wrongness this spec exists to prevent.
 *
 * @throws PdfUnitError for anything unparseable — a malformed page setup is host
 * configuration error, not document content, so it is an exception (SPEC 21).
 */
export function parseLengthPt(value: string | number, what = 'a length'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new PdfUnitError(String(value), what);
    return pxToPt(value);
  }
  const text = value.trim().toLowerCase();
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))\s*(pt|px|in|mm|cm|pc)?$/.exec(text);
  if (match === null) throw new PdfUnitError(value, what);
  const raw = match[1];
  const unit = match[2] ?? 'px';
  if (raw === undefined) throw new PdfUnitError(value, what);
  const n = Number.parseFloat(raw);
  const per = UNIT_PT[unit];
  if (!Number.isFinite(n) || per === undefined) throw new PdfUnitError(value, what);
  return n * per;
}

/** A page box in points, before orientation is applied. */
export interface PageBox {
  widthPt: number;
  heightPt: number;
}

/**
 * The named page sizes of SPEC 28.2, in points, portrait.
 *
 * ISO sizes are the exact millimetre definitions rounded to points the way every
 * other producer rounds them, so an MDV A4 page is bit-comparable with anyone
 * else's A4 page.
 */
const NAMED_SIZES: Readonly<Record<string, PageBox>> = {
  a0: { widthPt: 2384, heightPt: 3370 },
  a1: { widthPt: 1684, heightPt: 2384 },
  a2: { widthPt: 1191, heightPt: 1684 },
  a3: { widthPt: 842, heightPt: 1191 },
  a4: { widthPt: 595, heightPt: 842 },
  a5: { widthPt: 420, heightPt: 595 },
  a6: { widthPt: 298, heightPt: 420 },
  letter: { widthPt: 612, heightPt: 792 },
  legal: { widthPt: 612, heightPt: 1008 },
  tabloid: { widthPt: 792, heightPt: 1224 },
};

/** Every page-size name this exporter accepts, sorted, for error messages. */
export const PAGE_SIZE_NAMES: readonly string[] = Object.keys(NAMED_SIZES).sort();

/**
 * Resolve `pageSize` (SPEC 28.2): a name, or `[w, h]` with units.
 *
 * @throws PdfUnitError for an unknown name or a malformed pair.
 */
export function resolvePageSize(size: string | readonly [string, string] | undefined): PageBox {
  if (size === undefined) return { ...(NAMED_SIZES['a4'] as PageBox) };
  if (typeof size !== 'string') {
    const [w, h] = size;
    return { widthPt: parseLengthPt(w, 'page width'), heightPt: parseLengthPt(h, 'page height') };
  }
  const named = NAMED_SIZES[size.trim().toLowerCase()];
  if (named !== undefined) return { ...named };
  // A bare `"210mm 297mm"` is a common typo for the pair form; name it precisely.
  throw new PdfUnitError(size, `a page size (one of ${PAGE_SIZE_NAMES.join(', ')}, or [w, h])`);
}

/** Apply `orientation` to a portrait box. */
export function orient(box: PageBox, orientation: 'portrait' | 'landscape'): PageBox {
  const portrait = box.widthPt <= box.heightPt;
  const wantPortrait = orientation === 'portrait';
  if (portrait === wantPortrait) return { ...box };
  return { widthPt: box.heightPt, heightPt: box.widthPt };
}

/** Page margins in points. */
export interface Margins {
  topPt: number;
  rightPt: number;
  bottomPt: number;
  leftPt: number;
}

/** SPEC 28.2's default margin box. */
export const DEFAULT_MARGIN: Readonly<Record<keyof Margins, string>> = {
  topPt: '24mm',
  rightPt: '18mm',
  bottomPt: '22mm',
  leftPt: '18mm',
};

/** Resolve the `margin` option, filling each side from the SPEC 28.2 default. */
export function resolveMargins(
  margin:
    | string
    | number
    | {
        top?: string | number;
        right?: string | number;
        bottom?: string | number;
        left?: string | number;
      }
    | undefined,
): Margins {
  if (margin === undefined) {
    return {
      topPt: parseLengthPt(DEFAULT_MARGIN.topPt, 'margin.top'),
      rightPt: parseLengthPt(DEFAULT_MARGIN.rightPt, 'margin.right'),
      bottomPt: parseLengthPt(DEFAULT_MARGIN.bottomPt, 'margin.bottom'),
      leftPt: parseLengthPt(DEFAULT_MARGIN.leftPt, 'margin.left'),
    };
  }
  if (typeof margin === 'string' || typeof margin === 'number') {
    const all = parseLengthPt(margin, 'margin');
    return { topPt: all, rightPt: all, bottomPt: all, leftPt: all };
  }
  const fallback = resolveMargins(undefined);
  return {
    topPt: margin.top === undefined ? fallback.topPt : parseLengthPt(margin.top, 'margin.top'),
    rightPt:
      margin.right === undefined ? fallback.rightPt : parseLengthPt(margin.right, 'margin.right'),
    bottomPt:
      margin.bottom === undefined
        ? fallback.bottomPt
        : parseLengthPt(margin.bottom, 'margin.bottom'),
    leftPt: margin.left === undefined ? fallback.leftPt : parseLengthPt(margin.left, 'margin.left'),
  };
}

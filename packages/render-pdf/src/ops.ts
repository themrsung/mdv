/**
 * The content-stream operator model (SPEC 28.10).
 *
 * The exporter never writes operator *text*. It builds this structured list,
 * which is both what the fixtures compare (`expected.pdf.json`) and what is
 * handed to `pdf-lib` for serialisation. One representation for both means a
 * trace can never drift from the bytes it claims to describe — the failure mode
 * a "trace" written alongside the writer always eventually has.
 */

import { formatNumber, roundTo } from './number.js';

/** A content-stream operand. */
export type PdfArg =
  /** A number, already rounded to the stream's precision. */
  | { k: 'num'; v: number }
  /** A PDF name; serialised with its leading solidus. */
  | { k: 'name'; v: string }
  /**
   * Text to show. Carries the resource name of the font it must be encoded
   * with, because the encoding (WinAnsi bytes, or glyph ids for a subsetted
   * face) is a property of the font and is resolved at serialisation time.
   */
  | { k: 'text'; v: string; font: string }
  /** A pre-formatted token such as `[3 2]` for `d`. Used only by this module. */
  | { k: 'raw'; v: string };

/** One content-stream operation. */
export interface PdfOp {
  op: string;
  args: readonly PdfArg[];
}

/** A number operand, rounded once, here. */
export function num(v: number): PdfArg {
  return { k: 'num', v: roundTo(v) };
}

/** A name operand. */
export function name(v: string): PdfArg {
  return { k: 'name', v };
}

/** A text operand bound to a font resource. */
export function text(v: string, font: string): PdfArg {
  return { k: 'text', v, font };
}

/** A raw token operand, e.g. an inline array. */
export function raw(v: string): PdfArg {
  return { k: 'raw', v };
}

/** An inline number array, e.g. a dash pattern. */
export function numArray(values: readonly number[]): PdfArg {
  return raw(`[${values.map((v) => formatNumber(v)).join(' ')}]`);
}

/** Build an operation. */
export function op(name_: string, ...args: PdfArg[]): PdfOp {
  return { op: name_, args };
}

/**
 * The public, flattened form of an operand (`PdfOperation.args`).
 *
 * Names keep their solidus and text keeps its quotes so a trace reads like the
 * stream it describes and a diff points at the right token.
 */
export function argToTrace(arg: PdfArg): number | string {
  switch (arg.k) {
    case 'num':
      return arg.v;
    case 'name':
      return `/${arg.v}`;
    case 'text':
      return `(${arg.v})`;
    case 'raw':
      return arg.v;
  }
}

/** Serialise an operand the way a content stream wants it. */
export function argToToken(arg: PdfArg): string {
  switch (arg.k) {
    case 'num':
      return formatNumber(arg.v);
    case 'name':
      return `/${escapeName(arg.v)}`;
    case 'text':
      return `(${escapeLiteralString(arg.v)})`;
    case 'raw':
      return arg.v;
  }
}

/** Serialise a whole operation. */
export function opToText(operation: PdfOp): string {
  if (operation.args.length === 0) return operation.op;
  return `${operation.args.map(argToToken).join(' ')} ${operation.op}`;
}

/**
 * `#`-escape the characters a PDF name may not contain.
 *
 * Resource names are ours (`F0`, `GS2`) so this never fires in practice; it
 * exists so that a future custom-font resource named from a family string
 * cannot corrupt a stream.
 */
export function escapeName(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x20 || code >= 0x7f || '()<>[]{}/%#'.includes(ch)) {
      out += `#${code.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Escape a PDF literal string body. */
export function escapeLiteralString(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '(' || ch === ')' || ch === '\\') out += `\\${ch}`;
    else if (ch === '\r') out += '\\r';
    else if (ch === '\n') out += '\\n';
    else out += ch;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Common operator builders
// ─────────────────────────────────────────────────────────────────────────────

/** `q` — save the graphics state. */
export const saveState = (): PdfOp => op('q');
/** `Q` — restore the graphics state. */
export const restoreState = (): PdfOp => op('Q');

/** `cm` — concatenate a matrix onto the CTM. */
export function concatMatrix(m: readonly [number, number, number, number, number, number]): PdfOp {
  return op('cm', num(m[0]), num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]));
}

/** `rg` — non-stroking device RGB. */
export function fillColor(r: number, g: number, b: number): PdfOp {
  return op('rg', num(r), num(g), num(b));
}

/** `RG` — stroking device RGB. */
export function strokeColor(r: number, g: number, b: number): PdfOp {
  return op('RG', num(r), num(g), num(b));
}

/** `w` — line width. */
export const lineWidth = (v: number): PdfOp => op('w', num(v));
/** `J` — line cap. */
export const lineCap = (v: number): PdfOp => op('J', num(v));
/** `j` — line join. */
export const lineJoin = (v: number): PdfOp => op('j', num(v));
/** `M` — miter limit. */
export const miterLimit = (v: number): PdfOp => op('M', num(v));
/** `d` — dash pattern. */
export function dashPattern(pattern: readonly number[], phase: number): PdfOp {
  return op('d', numArray(pattern), num(phase));
}
/** `gs` — apply an ExtGState resource. */
export const extGState = (resource: string): PdfOp => op('gs', name(resource));

/** `m` / `l` / `c` / `h` — path construction. */
export const moveTo = (x: number, y: number): PdfOp => op('m', num(x), num(y));
/** Straight segment. */
export const lineTo = (x: number, y: number): PdfOp => op('l', num(x), num(y));
/** Cubic Bézier. */
export function curveTo(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  x: number,
  y: number,
): PdfOp {
  return op('c', num(x1), num(y1), num(x2), num(y2), num(x), num(y));
}
/** Close the subpath. */
export const closePath = (): PdfOp => op('h');
/** `re` — append a rectangle as a complete subpath. */
export function rectangle(x: number, y: number, w: number, h: number): PdfOp {
  return op('re', num(x), num(y), num(w), num(h));
}

/** Painting operators. */
export const fillNonZero = (): PdfOp => op('f');
/** Fill with the even-odd rule. */
export const fillEvenOdd = (): PdfOp => op('f*');
/** Stroke. */
export const strokePath = (): PdfOp => op('S');
/** Fill then stroke. */
export const fillAndStroke = (): PdfOp => op('B');
/** Fill (even-odd) then stroke. */
export const fillEvenOddAndStroke = (): PdfOp => op('B*');
/** End the path with no painting — the clip idiom's second half. */
export const endPath = (): PdfOp => op('n');
/** `W` — intersect the clip with the current path. */
export const clipNonZero = (): PdfOp => op('W');
/** `W*` — clip, even-odd. */
export const clipEvenOdd = (): PdfOp => op('W*');

/** Text object delimiters. */
export const beginText = (): PdfOp => op('BT');
/** End of a text object. */
export const endText = (): PdfOp => op('ET');
/** `Tf` — select a font resource and size. */
export function setFont(resource: string, size: number): PdfOp {
  return op('Tf', name(resource), num(size));
}
/** `Tm` — replace the text matrix. */
export function textMatrix(m: readonly [number, number, number, number, number, number]): PdfOp {
  return op('Tm', num(m[0]), num(m[1]), num(m[2]), num(m[3]), num(m[4]), num(m[5]));
}
/** `Tc` — character spacing. */
export const charSpacing = (v: number): PdfOp => op('Tc', num(v));
/** `Tj` — show a string in the given font resource. */
export function showText(value: string, font: string): PdfOp {
  return op('Tj', text(value, font));
}

/** `Do` — paint an XObject. */
export const drawXObject = (resource: string): PdfOp => op('Do', name(resource));
/** `sh` — paint a shading over the clip region. */
export const shade = (resource: string): PdfOp => op('sh', name(resource));
/** `cs` / `scn` — select the pattern colour space and a pattern. */
export const patternFill = (resource: string): PdfOp[] => [
  op('cs', name('Pattern')),
  op('scn', name(resource)),
];

/** `BDC` — begin a marked-content sequence with an MCID. */
export function beginMarkedContent(tag: string, mcid: number): PdfOp {
  return op('BDC', name(tag), raw(`<</MCID ${String(Math.trunc(mcid))}>>`));
}
/** `BMC` — begin an untagged marked-content sequence, for artifacts. */
export function beginArtifact(): PdfOp {
  return op('BDC', name('Artifact'), raw('<</Type/Pagination>>'));
}
/** `EMC` — end a marked-content sequence. */
export const endMarkedContent = (): PdfOp => op('EMC');

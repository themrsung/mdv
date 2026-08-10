/**
 * The visual block (SPEC 5) — the heart of the syntax.
 *
 * Fence recognition itself is delegated to CommonMark: micromark already knows
 * that a fence may be backticks or tildes, three or more, indented up to three
 * spaces, closed by a run of the same character at least as long, and implicitly
 * closed at the end of the document. Re-implementing that would be a second,
 * subtly different fenced-code parser. What happens here is everything *inside*
 * the fence, driven off the original source lines so that every offset is exact.
 *
 * The one rule to read twice is SPEC 5.1:
 *
 * > A block body with no separator line is parsed entirely as a header section.
 *
 * No sniffing, no guessing, no "this looks like CSV". A body without `---` is a
 * header, full stop; if it does not parse as one, the diagnostic is `MDV1203`
 * and it names the missing separator.
 */

import type { AttrMap, AttrValue, MdvBlock, Range } from '../types.js';
import type { DiagnosticBag } from './diagnostics.js';
import { containerStrip, type SourceIndex } from './source.js';
import { parseHeaderLines, type HeaderLine } from './header.js';
import { parseInfoString } from './inline-attrs.js';
import { levelOfBlockType } from './levels.js';

/** Appendix A: `separator = "---" *WSP LF`. Exactly three hyphens. */
const SEPARATOR = /^---[ \t]*$/;

/**
 * Build an {@link MdvBlock} from the source span of a fenced code block whose
 * info string starts with `mdv`.
 *
 * Never throws: every malformed shape becomes a diagnostic, and `raw` always
 * holds the original text so a reader can show an error card (SPEC 14.1, 15).
 */
export function buildVisualBlock(
  root: SourceIndex,
  bag: DiagnosticBag,
  startOffset: number,
  endOffset: number,
): MdvBlock {
  const mark = bag.mark();
  const startLine = root.lineIndexAt(startOffset);
  const lastLine = root.lineIndexAt(Math.max(startOffset, endOffset - 1));

  // A block may sit inside a list item or a block quote, so the fence line has
  // two prefixes: the container's (`> `, list indentation) and the fence's own
  // indentation. Both come off every content line (SPEC 3.3, 5.4).
  const containerPrefix = startOffset - root.lineStart(startLine);
  const openOffset = startOffset;
  const openText = root.text.slice(startOffset, root.lineEnd(startLine));

  let cursor = 0;
  while (cursor < openText.length && openText.charCodeAt(cursor) === 32) cursor += 1;
  const fenceIndent = cursor;
  const fenceChar = openText.charCodeAt(cursor) === 126 ? '~' : '`';
  let runEnd = cursor;
  while (runEnd < openText.length && openText[runEnd] === fenceChar) runEnd += 1;
  const fence = openText.slice(cursor, runEnd);

  /** Characters to remove from the front of a body line. */
  const stripOf = (line: number): number => {
    const strip = containerStrip(root, line, containerPrefix + 1);
    const text = root.lineText(line);
    let extra = 0;
    while (extra < fenceIndent && text.charCodeAt(strip + extra) === 32) extra += 1;
    return strip + extra;
  };

  const closed =
    lastLine > startLine &&
    isClosingFence(root.lineText(lastLine).slice(stripOf(lastLine)), fenceChar, fence.length);
  if (!closed) {
    bag.add('MDV1205', root.range(openOffset + fenceIndent, openOffset + runEnd), {
      detail: `This \`${fence}\` fence is never closed; the block runs to the end of the document.`,
    });
  }

  const contentEnd = closed ? lastLine - 1 : lastLine;
  const lines: HeaderLine[] = [];
  const terminators: boolean[] = [];
  for (let line = startLine + 1; line <= contentEnd; line += 1) {
    const strip = stripOf(line);
    lines.push({ text: root.lineText(line).slice(strip), offset: root.lineStart(line) + strip });
    terminators.push(root.lineHasTerminator(line));
  }

  let separator = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line !== undefined && SEPARATOR.test(line.text)) {
      separator = i;
      break;
    }
  }

  const headerLines = separator === -1 ? lines : lines.slice(0, separator);
  const dataLines = separator === -1 ? [] : lines.slice(separator + 1);
  const dataFrom = separator === -1 ? lines.length : separator + 1;

  // ── info string (SPEC 5.2) ────────────────────────────────────────────────
  const info = parseInfoString(openText, runEnd, openOffset, root, bag);

  // ── header section (SPEC 5.3) ─────────────────────────────────────────────
  const header = parseHeaderLines(headerLines, root, bag);

  for (const range of header.invalid) {
    if (separator === -1) {
      bag.add('MDV1203', range, {
        detail:
          'This line is not an attribute. If it is data, add a `---` separator line ' +
          'above it; a block body without a separator is entirely a header (SPEC 5.1).',
      });
    } else {
      bag.add('MDV1211', range, {
        message: 'Line is not valid MDV attribute notation',
        detail: 'Expected `key: value`, a `- ` sequence item, a comment, or a blank line.',
      });
    }
  }

  // ── the cascade, levels 5 then 6 (SPEC 5.5) ───────────────────────────────
  const attrs = mergeAttrs(info.attrs, header.attrs);
  const attrsPosition: Record<string, Range> = { ...info.positions, ...header.positions };

  const headerType = typeof attrs['type'] === 'string' ? attrs['type'].toLowerCase() : null;
  const blockType = headerType ?? info.type ?? '';
  if (blockType !== '') {
    attrs['type'] = blockType;
    if (headerType === null && info.typeRange !== null) attrsPosition['type'] = info.typeRange;
  } else {
    bag.add('MDV1201', root.range(openOffset + fenceIndent, openOffset + openText.length), {
      detail: 'Write the type in the info string (```mdv bar) or as `type: bar` in the header.',
    });
  }

  const rawHeader = joinLines(headerLines, terminators, 0);
  const rawData = joinLines(dataLines, terminators, dataFrom);

  // ── shape diagnostics ─────────────────────────────────────────────────────
  const hasData = rawData.trim().length > 0;
  if (!hasData && Object.keys(attrs).length === (blockType === '' ? 0 : 1)) {
    bag.add('MDV1202', root.range(startOffset, endOffset), {
      detail: 'The block has neither attributes nor data, so there is nothing to render.',
    });
  }
  if (hasData) {
    const outOfBand = outOfBandSource(attrs);
    if (outOfBand !== null) {
      const range = attrsPosition[outOfBand] ?? root.range(startOffset, endOffset);
      bag.add('MDV1204', range, {
        detail:
          `The header declares \`${outOfBand}:\`, so the data section below the ` +
          'separator can never be used. Remove one of the two.',
      });
    }
  }

  const id = attrs['id'];
  if (typeof id === 'string' && id.length > 0) bag.tagBlock(mark, id);

  const block: MdvBlock = {
    type: 'mdvBlock',
    blockType,
    attrs,
    attrsPosition,
    raw: { header: rawHeader, data: rawData, fence },
    level: levelOfBlockType(blockType),
    position: root.range(startOffset, endOffset),
  };

  // Where the data section is, for the hosts that need to address it rather
  // than just read it — folding it on its own in the LSP (SPEC 29.4), pointing
  // at the row a reader rejected. Only the parser knows where the separator
  // fell, and it is the only thing entitled to say so.
  if (separator !== -1) {
    const separatorEnd = root.lineEnd(startLine + 1 + separator);
    block.dataPosition = root.range(
      dataLines[0]?.offset ?? separatorEnd,
      Math.max(separatorEnd, root.lineEnd(contentEnd)),
    );
  }

  return block;
}

/** `true` when the info string of a fenced code block makes it a visual block. */
export function isMdvInfoString(lang: string | null | undefined): boolean {
  return lang === 'mdv';
}

/**
 * Deep-merge two attribute maps: mappings merge, sequences and scalars replace
 * (SPEC 5.5). Key order follows `base` first, then keys new to `override`, which
 * keeps iteration order a pure function of the source (SPEC 24.3 rule 5).
 */
export function mergeAttrs(base: AttrMap, override: AttrMap): AttrMap {
  const out: AttrMap = {};
  for (const [key, value] of Object.entries(base)) out[key] = value;
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainMap(existing) && isPlainMap(value) ? mergeAttrs(existing, value) : value;
  }
  return out;
}

function isPlainMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The attribute naming an out-of-band data source (SPEC 5.4), if any. */
function outOfBandSource(attrs: AttrMap): string | null {
  const data = attrs['data'];
  if (typeof data === 'string' && data.startsWith('@')) return 'data';
  const src = attrs['src'];
  if (typeof src === 'string' && src.length > 0) return 'src';
  return null;
}

function isClosingFence(text: string, fenceChar: string, openLength: number): boolean {
  let i = 0;
  while (i < text.length && text.charCodeAt(i) === 32) i += 1;
  if (i > 3) return false;
  let run = 0;
  while (i + run < text.length && text[i + run] === fenceChar) run += 1;
  if (run < openLength) return false;
  for (let j = i + run; j < text.length; j += 1) {
    const code = text.charCodeAt(j);
    if (code !== 32 && code !== 9) return false;
  }
  return true;
}

/**
 * Re-join de-indented lines, preserving whether the final line was terminated in
 * the source, so `raw` is byte-faithful even for a block cut off at EOF.
 */
function joinLines(
  lines: readonly HeaderLine[],
  terminators: readonly boolean[],
  from: number,
): string {
  let out = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    out += line.text;
    if (terminators[from + i] !== false) out += '\n';
  }
  return out;
}

/**
 * `read(text) → document`.
 *
 * A compact, line-oriented reader for the subset of CommonMark + GFM + MDV that
 * the editor models structurally, with a **raw-block escape hatch** for
 * everything else. It is not a CommonMark implementation and does not try to be
 * one: the MDV parser package owns conformance parsing. This reader owns
 * *editability* — turning a file into a tree the user can manipulate and write
 * back without losing a byte they did not touch.
 *
 * Recognised: front matter, ATX and setext headings, thematic breaks, fenced
 * and indented code, `mdv` fenced visual blocks (header/data split by the SPEC
 * 5.1 separator rule), block quotes, bullet/ordered/task lists with nesting,
 * GFM tables, standalone images, paragraphs with inline marks.
 *
 * Everything else — container directives, HTML blocks, link reference
 * definitions, footnote definitions — becomes a {@link RawBlock} whose text is
 * reproduced byte-for-byte.
 */

import { createIdFactory, type IdFactory } from '../ids.js';
import { normalizeRuns, rawRun, textRun, type RunOffset } from '../inline.js';
import type {
  Block,
  ColumnAlign,
  FrontMatter,
  HeadingLevel,
  InfoAttribute,
  ListItem,
  Mark,
  MdvDocument,
  Run,
  TableCell,
  TableRow,
} from '../model.js';
import { unescapeInline } from './escape.js';

/** Options for {@link read}. */
export interface ReadOptions {
  /**
   * Id allocator. Defaults to a fresh deterministic factory, so reading the
   * same text twice yields two structurally identical documents — ids included.
   */
  readonly ids?: IdFactory;
}

/** Parse `.mdv` text into a document. Never throws. */
export function read(text: string, options: ReadOptions = {}): MdvDocument {
  const ids = options.ids ?? createIdFactory('n');
  const normalized = normalizeSource(text);
  const { frontMatter, rest } = takeFrontMatter(normalized);
  const blocks = parseBlocks(splitLines(rest), ids);
  return { kind: 'document', id: ids(), frontMatter, blocks };
}

/** Parse a fragment (no front matter) into blocks — used by the clipboard. */
export function readBlocks(text: string, ids: IdFactory): readonly Block[] {
  return parseBlocks(splitLines(normalizeSource(text)), ids);
}

/**
 * SPEC 3.2: strip a leading BOM, normalise CRLF/CR to LF, replace U+0000 with
 * U+FFFD.
 */
export function normalizeSource(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.replace(/\r\n?/g, '\n');
  // eslint-disable-next-line no-control-regex -- NUL is the character replaced
  out = out.replace(/\u0000/g, '\uFFFD');
  return out;
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  // A trailing newline produces a trailing empty element; it is not a blank line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function takeFrontMatter(text: string): { frontMatter: FrontMatter | null; rest: string } {
  if (!text.startsWith('---\n') && text !== '---') return { frontMatter: null, rest: text };
  const lines = text.split('\n');
  if (lines[0] !== '---') return { frontMatter: null, rest: text };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '---' || line === '...') {
      return {
        frontMatter: {
          source: lines.slice(1, index).join('\n'),
          terminator: line === '...' ? '...' : '---',
        },
        rest: lines.slice(index + 1).join('\n'),
      };
    }
  }
  return { frontMatter: null, rest: text };
}

/* -------------------------------------------------------------------------- */
/* Block scanning                                                              */
/* -------------------------------------------------------------------------- */

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const THEMATIC = /^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const BULLET = /^( {0,3})([-+*])([ \t]+|$)/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;
const BLOCKQUOTE = /^ {0,3}>[ ]?/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DIRECTIVE_OPEN = /^(:{3,})([A-Za-z][A-Za-z0-9-]*)(.*)$/;
const HTML_OPEN = /^ {0,3}<(\/?[A-Za-z][A-Za-z0-9-]*|!--|\?|!\[CDATA\[|![A-Za-z])/;
const LINK_DEFINITION = /^ {0,3}\[[^\]]+\]:/;
const FOOTNOTE_DEFINITION = /^ {0,3}\[\^[^\]]+\]:/;
const IMAGE_ONLY =
  /^!\[((?:\\.|[^\]\\])*)\]\(\s*(<(?:\\.|[^>\\])*>|(?:\\.|[^\s()\\]|\([^()]*\))*)(?:\s+"((?:\\.|[^"\\])*)")?\s*\)(?:\{([^}]*)\})?$/;

interface Scanner {
  readonly lines: readonly string[];
  index: number;
}

function parseBlocks(lines: readonly string[], ids: IdFactory): readonly Block[] {
  const scanner: Scanner = { lines, index: 0 };
  const out: Block[] = [];
  while (scanner.index < scanner.lines.length) {
    const before = scanner.index;
    const block = parseBlock(scanner, ids, out);
    if (block) out.push(...block);
    if (scanner.index === before) scanner.index += 1; // never loop forever
  }
  return out;
}

function parseBlock(scanner: Scanner, ids: IdFactory, emitted: Block[]): readonly Block[] | null {
  const line = scanner.lines[scanner.index];
  if (line === undefined) return null;

  if (line.trim() === '') {
    scanner.index += 1;
    return null;
  }

  const fence = FENCE.exec(line);
  if (fence) return [parseFence(scanner, ids, fence)];

  const atx = ATX.exec(line);
  if (atx && atx[1] !== undefined) {
    scanner.index += 1;
    const level = atx[1].length as HeadingLevel;
    const content = (atx[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '');
    return [{ kind: 'heading', id: ids(), level, style: 'atx', runs: parseInline(content, ids) }];
  }

  if (THEMATIC.test(line)) {
    scanner.index += 1;
    return [{ kind: 'thematicBreak', id: ids(), marker: line.trim() }];
  }

  const directive = DIRECTIVE_OPEN.exec(line);
  if (directive) return [parseDirective(scanner, ids, directive[1] ?? ':::')];

  if (BLOCKQUOTE.test(line)) return [parseBlockquote(scanner, ids)];

  if (BULLET.test(line) || ORDERED.test(line)) {
    const list = parseList(scanner, ids);
    if (list) return [list];
  }

  if (/^ {4,}/.test(line)) return [parseIndentedCode(scanner, ids)];

  if (LINK_DEFINITION.test(line) || FOOTNOTE_DEFINITION.test(line) || HTML_OPEN.test(line)) {
    return [parseRawRegion(scanner, ids)];
  }

  const table = tryParseTable(scanner, ids);
  if (table) return [table];

  return parseParagraph(scanner, ids, emitted);
}

function parseFence(scanner: Scanner, ids: IdFactory, match: RegExpExecArray): Block {
  const indent = (match[1] ?? '').length;
  const marker = match[2] ?? '```';
  const info = match[3] ?? '';
  const character = marker[0] === '~' ? '~' : '`';
  const closer = new RegExp(`^ {0,3}${character === '~' ? '~' : '`'}{${marker.length},}[ \\t]*$`);

  scanner.index += 1;
  const body: string[] = [];
  let closed = false;
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (closer.test(line)) {
      scanner.index += 1;
      closed = true;
      break;
    }
    body.push(indent > 0 ? stripUpTo(line, indent) : line);
    scanner.index += 1;
  }
  void closed;

  const text = body.join('\n');
  const fenceStyle = {
    style: character === '~' ? ('tilde' as const) : ('backtick' as const),
    length: marker.length,
  };
  const visual = parseVisualInfo(info);
  if (visual) {
    const split = splitVisualBody(text);
    return {
      kind: 'visual',
      id: ids(),
      blockType: visual.blockType,
      infoAttributes: visual.attributes,
      header: split.header,
      data: split.data,
      fence: fenceStyle,
    };
  }
  return { kind: 'code', id: ids(), info, text, fence: fenceStyle };
}

/** Remove up to `count` leading spaces. */
function stripUpTo(line: string, count: number): string {
  let removed = 0;
  let index = 0;
  while (index < line.length && removed < count && line[index] === ' ') {
    index += 1;
    removed += 1;
  }
  return line.slice(index);
}

/**
 * SPEC 5.1 determinism rule: the header ends at the **first** line that is
 * exactly `---`. With no such line the entire body is header and `data` is
 * `null` — there is no content sniffing.
 */
export function splitVisualBody(body: string): { header: string; data: string | null } {
  const lines = body.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === '---') {
      return { header: lines.slice(0, index).join('\n'), data: lines.slice(index + 1).join('\n') };
    }
  }
  return { header: body, data: null };
}

/** Parse an info string, returning `null` when it is not an MDV visual block. */
export function parseVisualInfo(
  info: string,
): { blockType: string; attributes: readonly InfoAttribute[] } | null {
  const trimmed = info.trim();
  if (trimmed !== 'mdv' && !/^mdv[\s]/.test(trimmed)) return null;
  const rest = trimmed.slice(3).trim();
  if (rest === '') return { blockType: '', attributes: [] };

  const tokens = tokenizeInfo(rest);
  const first = tokens[0];
  let blockType = '';
  let start = 0;
  if (first && first.key === null && /^[A-Za-z][A-Za-z0-9-]*$/.test(first.value)) {
    blockType = first.value.toLowerCase();
    start = 1;
  }
  const attributes: InfoAttribute[] = [];
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.key === null) continue;
    attributes.push({ key: token.key, value: token.value, quote: token.quote });
  }
  return { blockType, attributes };
}

interface InfoToken {
  key: string | null;
  value: string;
  quote: 'none' | 'double' | 'single';
}

function tokenizeInfo(text: string): readonly InfoToken[] {
  const out: InfoToken[] = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
    if (index >= text.length) break;
    const keyMatch = /^([A-Za-z][A-Za-z0-9_-]*)=/.exec(text.slice(index));
    if (!keyMatch || keyMatch[1] === undefined) {
      let end = index;
      while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
      out.push({ key: null, value: text.slice(index, end), quote: 'none' });
      index = end;
      continue;
    }
    index += keyMatch[0].length;
    const opener = text[index];
    if (opener === '"' || opener === "'") {
      let value = '';
      index += 1;
      while (index < text.length && text[index] !== opener) {
        if (opener === '"' && text[index] === '\\' && text[index + 1] !== undefined) {
          value += text[index + 1];
          index += 2;
          continue;
        }
        value += text[index];
        index += 1;
      }
      index += 1;
      out.push({ key: keyMatch[1], value, quote: opener === '"' ? 'double' : 'single' });
      continue;
    }
    let end = index;
    while (end < text.length && !/\s/.test(text[end] ?? '')) end += 1;
    out.push({ key: keyMatch[1], value: text.slice(index, end), quote: 'none' });
    index = end;
  }
  return out;
}

/**
 * A `:::name` container directive. Captured verbatim through its matching close
 * so nothing inside is reinterpreted. When no close exists the opening line
 * alone becomes the raw block, which keeps the rest of the document editable —
 * the parser instead runs the container to the end of its parent, but swallowing
 * every following block into one uneditable lump is the wrong answer in an editor.
 */
function parseDirective(scanner: Scanner, ids: IdFactory, marker: string): Block {
  const start = scanner.index;
  const closer = new RegExp(`^:{${marker.length},}[ \\t]*$`);
  let depth = 1;
  let index = start + 1;
  let fenceMarker: string | null = null;

  while (index < scanner.lines.length) {
    const line = scanner.lines[index] ?? '';
    if (fenceMarker !== null) {
      if (
        new RegExp(
          `^ {0,3}${fenceMarker[0] === '~' ? '~' : '`'}{${fenceMarker.length},}[ \\t]*$`,
        ).test(line)
      ) {
        fenceMarker = null;
      }
      index += 1;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      fenceMarker = fence[2] ?? null;
      index += 1;
      continue;
    }
    if (closer.test(line)) {
      depth -= 1;
      if (depth === 0) {
        scanner.index = index + 1;
        return { kind: 'raw', id: ids(), text: scanner.lines.slice(start, index + 1).join('\n') };
      }
      index += 1;
      continue;
    }
    if (DIRECTIVE_OPEN.test(line)) depth += 1;
    index += 1;
  }

  scanner.index = start + 1;
  return { kind: 'raw', id: ids(), text: scanner.lines[start] ?? '' };
}

/** HTML blocks, link reference definitions, footnote definitions: verbatim to the next blank line. */
function parseRawRegion(scanner: Scanner, ids: IdFactory): Block {
  const start = scanner.index;
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (line.trim() === '') break;
    scanner.index += 1;
  }
  return { kind: 'raw', id: ids(), text: scanner.lines.slice(start, scanner.index).join('\n') };
}

function parseIndentedCode(scanner: Scanner, ids: IdFactory): Block {
  const body: string[] = [];
  let lastContent = scanner.index;
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (/^ {4,}/.test(line)) {
      body.push(line.slice(4));
      scanner.index += 1;
      lastContent = scanner.index;
      continue;
    }
    if (line.trim() === '') {
      body.push('');
      scanner.index += 1;
      continue;
    }
    break;
  }
  scanner.index = lastContent;
  while (body.length > 0 && body[body.length - 1] === '') body.pop();
  return { kind: 'code', id: ids(), info: '', text: body.join('\n'), fence: { style: 'indented' } };
}

function parseBlockquote(scanner: Scanner, ids: IdFactory): Block {
  const inner: string[] = [];
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (BLOCKQUOTE.test(line)) {
      inner.push(line.replace(BLOCKQUOTE, ''));
      scanner.index += 1;
      continue;
    }
    // Lazy continuation: a non-blank line that starts no new block belongs to
    // the quote's trailing paragraph.
    if (line.trim() !== '' && !startsNewBlock(line) && inner.length > 0) {
      inner.push(line);
      scanner.index += 1;
      continue;
    }
    break;
  }
  return { kind: 'blockquote', id: ids(), children: parseBlocks(inner, ids) };
}

function startsNewBlock(line: string): boolean {
  return (
    ATX.test(line) ||
    THEMATIC.test(line) ||
    FENCE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    BLOCKQUOTE.test(line) ||
    DIRECTIVE_OPEN.test(line) ||
    /^ {4,}\S/.test(line)
  );
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

interface ItemStart {
  readonly indent: number;
  readonly markerWidth: number;
  readonly ordered: boolean;
  readonly bullet: '-' | '*' | '+';
  readonly delimiter: '.' | ')';
  readonly number: number;
  readonly rest: string;
}

function matchItem(line: string): ItemStart | null {
  const bullet = BULLET.exec(line);
  if (bullet && bullet[1] !== undefined && bullet[2] !== undefined) {
    const indent = bullet[1].length;
    const spacing = (bullet[3] ?? '').length;
    return {
      indent,
      markerWidth: indent + 1 + Math.max(1, spacing),
      ordered: false,
      bullet: bullet[2] as '-' | '*' | '+',
      delimiter: '.',
      number: 1,
      rest: line.slice(bullet[0].length),
    };
  }
  const ordered = ORDERED.exec(line);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined && ordered[3] !== undefined) {
    const indent = ordered[1].length;
    const spacing = (ordered[4] ?? '').length;
    return {
      indent,
      markerWidth: indent + ordered[2].length + 1 + Math.max(1, spacing),
      ordered: true,
      bullet: '-',
      delimiter: ordered[3] as '.' | ')',
      number: Number(ordered[2]),
      rest: line.slice(ordered[0].length),
    };
  }
  return null;
}

const TASK = /^\[([ xX])\][ \t]+/;

function parseList(scanner: Scanner, ids: IdFactory): Block | null {
  const first = matchItem(scanner.lines[scanner.index] ?? '');
  if (!first) return null;

  /** Same list means same indent, same kind and the same marker glyph. */
  const continuesList = (candidate: ItemStart | null): boolean => {
    if (!candidate || candidate.indent !== first.indent) return false;
    if (candidate.ordered !== first.ordered) return false;
    if (!candidate.ordered && candidate.bullet !== first.bullet) return false;
    if (candidate.ordered && candidate.delimiter !== first.delimiter) return false;
    return true;
  };

  const items: ListItem[] = [];
  let tight = true;

  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    const start = matchItem(line);
    if (!continuesList(start) || !start) break;

    scanner.index += 1;
    const body: string[] = [start.rest];
    let trailingBlanks = 0;

    while (scanner.index < scanner.lines.length) {
      const next = scanner.lines[scanner.index] ?? '';
      if (next.trim() === '') {
        // Peek: a blank line ends the item unless indented content follows.
        let probe = scanner.index;
        while (probe < scanner.lines.length && (scanner.lines[probe] ?? '').trim() === '')
          probe += 1;
        const following = scanner.lines[probe];
        if (following === undefined) break;
        const nextItem = matchItem(following);
        const continues =
          leadingSpaces(following) >= start.markerWidth &&
          (nextItem === null || nextItem.indent >= start.markerWidth);
        // A blank line only makes the list loose if the list actually goes on.
        if (!continues && !continuesList(nextItem)) break;
        for (let i = scanner.index; i < probe; i += 1) body.push('');
        trailingBlanks = probe - scanner.index;
        scanner.index = probe;
        tight = false;
        if (!continues) break;
        continue;
      }
      if (leadingSpaces(next) >= start.markerWidth) {
        body.push(stripUpTo(next, start.markerWidth));
        scanner.index += 1;
        trailingBlanks = 0;
        continue;
      }
      if (matchItem(next) !== null) break;
      if (startsNewBlock(next)) break;
      body.push(next); // lazy continuation of the item's paragraph
      scanner.index += 1;
      trailingBlanks = 0;
    }

    while (trailingBlanks > 0 && body.length > 0 && body[body.length - 1] === '') {
      body.pop();
      trailingBlanks -= 1;
    }

    let checked: boolean | null = null;
    const head = body[0] ?? '';
    const task = TASK.exec(head);
    if (task && task[1] !== undefined) {
      checked = task[1] !== ' ';
      body[0] = head.slice(task[0].length);
    }

    items.push({ id: ids(), checked, blocks: parseBlocks(body, ids) });
  }

  if (items.length === 0) return null;

  if (first.ordered) {
    return {
      kind: 'list',
      id: ids(),
      ordered: true,
      start: first.number,
      delimiter: first.delimiter,
      tight,
      items,
    };
  }
  return { kind: 'list', id: ids(), ordered: false, bullet: first.bullet, tight, items };
}

function leadingSpaces(line: string): number {
  const match = /^ */.exec(line);
  return match ? match[0].length : 0;
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

const DELIMITER_CELL = /^:?-+:?$/;

/** Split a pipe-table row, honouring `\|` escapes and optional edge pipes. */
export function splitTableRow(line: string): readonly string[] {
  const trimmed = line.trim();
  const body =
    trimmed.startsWith('|') && trimmed.length > 1
      ? trimmed.slice(1, trimmed.endsWith('|') && !trimmed.endsWith('\\|') ? -1 : undefined)
      : trimmed;
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (character === '\\' && body[index + 1] === '|') {
      current += '\\|';
      index += 1;
      continue;
    }
    if (character === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function parseAlignment(cells: readonly string[]): readonly ColumnAlign[] | null {
  const out: ColumnAlign[] = [];
  for (const cell of cells) {
    const text = cell.trim();
    if (!DELIMITER_CELL.test(text)) return null;
    const left = text.startsWith(':');
    const right = text.endsWith(':');
    out.push(left && right ? 'center' : left ? 'left' : right ? 'right' : 'none');
  }
  return out;
}

function tryParseTable(scanner: Scanner, ids: IdFactory): Block | null {
  const headerLine = scanner.lines[scanner.index];
  const delimiterLine = scanner.lines[scanner.index + 1];
  if (headerLine === undefined || delimiterLine === undefined) return null;
  if (!headerLine.includes('|')) return null;
  if (!delimiterLine.includes('-')) return null;

  const headerCells = splitTableRow(headerLine);
  const align = parseAlignment(splitTableRow(delimiterLine));
  if (!align || align.length !== headerCells.length || align.length === 0) return null;

  scanner.index += 2;
  const rows: TableRow[] = [makeRow(headerCells, align.length, ids)];
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (line.trim() === '' || !line.includes('|')) break;
    if (startsNewBlock(line)) break;
    rows.push(makeRow(splitTableRow(line), align.length, ids));
    scanner.index += 1;
  }
  return { kind: 'table', id: ids(), align, rows };
}

/** Pad or truncate to `width` cells — the rectangularity invariant, at the door. */
function makeRow(cells: readonly string[], width: number, ids: IdFactory): TableRow {
  const out: TableCell[] = [];
  for (let index = 0; index < width; index += 1) {
    const text = cells[index] ?? '';
    out.push({ id: ids(), runs: parseInline(text, ids) });
  }
  return { id: ids(), cells: out };
}

/* -------------------------------------------------------------------------- */
/* Paragraphs                                                                  */
/* -------------------------------------------------------------------------- */

function parseParagraph(scanner: Scanner, ids: IdFactory, emitted: Block[]): readonly Block[] {
  const collected: string[] = [];
  while (scanner.index < scanner.lines.length) {
    const line = scanner.lines[scanner.index] ?? '';
    if (line.trim() === '') break;
    if (collected.length > 0) {
      // CommonMark: a setext underline wins over a thematic break when it
      // follows paragraph content, so this test comes first.
      const setext = SETEXT.exec(line);
      if (setext && setext[1] !== undefined) {
        scanner.index += 1;
        const level: HeadingLevel = setext[1].startsWith('=') ? 1 : 2;
        return [
          {
            kind: 'heading',
            id: ids(),
            level,
            style: 'setext',
            runs: parseInline(collected.join('\n'), ids),
          },
        ];
      }
      if (startsNewBlock(line) || THEMATIC.test(line)) break;
      if (isTableStart(scanner, scanner.index)) break;
    }
    collected.push(line.replace(/^ {0,3}/, ''));
    scanner.index += 1;
  }

  if (collected.length === 0) return [];
  const text = collected.join('\n');

  const imageOnly = IMAGE_ONLY.exec(text.trim());
  if (imageOnly) {
    void emitted;
    return [imageBlockFrom(imageOnly, ids)];
  }
  return [{ kind: 'paragraph', id: ids(), runs: parseInline(text, ids) }];
}

function isTableStart(scanner: Scanner, index: number): boolean {
  const header = scanner.lines[index];
  const delimiter = scanner.lines[index + 1];
  if (header === undefined || delimiter === undefined) return false;
  if (!header.includes('|') || !delimiter.includes('-')) return false;
  const align = parseAlignment(splitTableRow(delimiter));
  return align !== null && align.length === splitTableRow(header).length && align.length > 0;
}

function imageBlockFrom(match: RegExpExecArray, ids: IdFactory): Block {
  const destination = stripAngles(match[2] ?? '');
  const attributes = parseImageAttributes(match[5] ?? '');
  return {
    kind: 'image',
    id: ids(),
    src: destination,
    alt: unescapeInline(match[1] ?? ''),
    title: match[3] === undefined ? null : unescapeInline(match[3]),
    width: attributes.width,
    height: attributes.height,
  };
}

function stripAngles(destination: string): string {
  const trimmed = destination.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1).replace(/\\([<>\\])/g, '$1');
  }
  return trimmed;
}

function parseImageAttributes(text: string): { width: number | null; height: number | null } {
  let width: number | null = null;
  let height: number | null = null;
  for (const part of text.split(/\s+/)) {
    const match = /^(width|height)=(\d+)$/.exec(part);
    if (!match || match[1] === undefined || match[2] === undefined) continue;
    if (match[1] === 'width') width = Number(match[2]);
    else height = Number(match[2]);
  }
  return { width, height };
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                      */
/* -------------------------------------------------------------------------- */

interface Delimiter {
  readonly index: number;
  readonly character: '*' | '_' | '~';
  length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
  active: boolean;
}

interface Piece {
  text: string;
  marks: Mark[];
  raw: string | null;
  /**
   * True for a piece that is a delimiter run.
   *
   * Delimiter pieces are addressed by index from {@link Delimiter.index} and
   * are truncated in place once they are matched, so ordinary text must never
   * be merged into one — doing so would delete that text along with the
   * delimiter.
   */
  delimiter?: boolean;
}

const PUNCTUATION = /[!-/:-@[-`{-~\u00A1-\u00BF\u2010-\u2027]/;

function isWhitespaceChar(character: string | undefined): boolean {
  return character === undefined || /\s/.test(character);
}

/**
 * Parse inline content.
 *
 * A two-phase scanner: phase one splits the text into pieces, resolving
 * backslash escapes, code spans, links, images, autolinks, inline directives
 * and math (the last four become {@link RawRun}s); phase two matches emphasis
 * and strikethrough delimiter runs and applies marks to the pieces they span.
 */
export function parseInline(text: string, ids: IdFactory): readonly Run[] {
  const pieces: Piece[] = [];
  const delimiters: Delimiter[] = [];
  let index = 0;

  const pushText = (value: string, raw: string | null = null): void => {
    const last = pieces[pieces.length - 1];
    // Merge only into a piece that is plain, unmarked text. Merging into a code
    // span or a link would extend that mark over the following characters, and
    // merging into a delimiter run would destroy the text when the run is later
    // truncated to zero length.
    if (
      raw === null &&
      last &&
      last.raw === null &&
      last.marks.length === 0 &&
      last.delimiter !== true
    ) {
      last.text += value;
      return;
    }
    pieces.push({ text: value, marks: [], raw });
  };

  while (index < text.length) {
    const character = text[index] as string;

    if (character === '\\') {
      const next = text[index + 1];
      if (next === '\n') {
        pushText('\n', '\\\n'); // hard line break
        index += 2;
        continue;
      }
      if (next !== undefined && /[!-/:-@[-`{-~]/.test(next)) {
        pushText(next);
        index += 2;
        continue;
      }
      pushText('\\');
      index += 1;
      continue;
    }

    if (character === '`') {
      const parsed = parseCodeSpan(text, index);
      if (parsed) {
        pieces.push({ text: parsed.content, marks: [{ type: 'code' }], raw: null });
        index = parsed.end;
        continue;
      }
      pushText('`');
      index += 1;
      continue;
    }

    if (character === '<') {
      const autolink = /^<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*|[^\s@<>]+@[^\s@<>]+)>/.exec(
        text.slice(index),
      );
      if (autolink) {
        pushText(autolink[0].slice(1, -1), autolink[0]);
        index += autolink[0].length;
        continue;
      }
      const tag = /^<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/.exec(text.slice(index));
      if (tag) {
        pushText('', tag[0]);
        index += tag[0].length;
        continue;
      }
      pushText('<');
      index += 1;
      continue;
    }

    if (character === '$') {
      const math = /^\$\$[\s\S]+?\$\$|^\$[^$\n]+\$/.exec(text.slice(index));
      if (math) {
        pushText(math[0], math[0]);
        index += math[0].length;
        continue;
      }
      pushText('$');
      index += 1;
      continue;
    }

    if (character === ':') {
      const directive = /^:{1,2}[A-Za-z][A-Za-z0-9-]*(?:\[[^\]]*\])?(?:\{[^}]*\})?/.exec(
        text.slice(index),
      );
      if (directive && /[[{]/.test(directive[0])) {
        const label = /\[([^\]]*)\]/.exec(directive[0]);
        pushText(label?.[1] ?? '', directive[0]);
        index += directive[0].length;
        continue;
      }
      pushText(':');
      index += 1;
      continue;
    }

    if (character === '!' && text[index + 1] === '[') {
      const inlineImage = parseLinkLike(text, index + 1);
      if (inlineImage) {
        pushText(inlineImage.label, text.slice(index, inlineImage.end));
        index = inlineImage.end;
        continue;
      }
      pushText('!');
      index += 1;
      continue;
    }

    if (character === '[') {
      const link = parseLinkLike(text, index);
      if (link && link.destination !== null) {
        if (link.label.includes('![')) {
          pushText(link.label, text.slice(index, link.end));
        } else {
          const inner = parseInline(link.label, ids);
          const mark: Mark = { type: 'link', href: link.destination, title: link.title };
          for (const run of inner) {
            if (run.kind === 'raw') pieces.push({ text: run.text, marks: [], raw: run.source });
            else pieces.push({ text: run.text, marks: [...run.marks, mark], raw: null });
          }
        }
        index = link.end;
        continue;
      }
      if (link) {
        // A reference link (`[a][b]` / `[a]`) — kept verbatim: resolving it
        // would need the definitions, which live in raw blocks.
        pushText(link.label, text.slice(index, link.end));
        index = link.end;
        continue;
      }
      pushText('[');
      index += 1;
      continue;
    }

    if (character === '*' || character === '_' || character === '~') {
      let length = 1;
      while (text[index + length] === character) length += 1;
      const before = text[index - 1];
      const after = text[index + length];
      const beforeWhitespace = isWhitespaceChar(before);
      const afterWhitespace = isWhitespaceChar(after);
      const beforePunctuation = before !== undefined && PUNCTUATION.test(before);
      const afterPunctuation = after !== undefined && PUNCTUATION.test(after);
      const leftFlanking =
        !afterWhitespace && (!afterPunctuation || beforeWhitespace || beforePunctuation);
      const rightFlanking =
        !beforeWhitespace && (!beforePunctuation || afterWhitespace || afterPunctuation);
      const canOpen =
        character === '_' ? leftFlanking && (!rightFlanking || beforePunctuation) : leftFlanking;
      const canClose =
        character === '_' ? rightFlanking && (!leftFlanking || afterPunctuation) : rightFlanking;

      if (character === '~' && length !== 2) {
        pushText(character.repeat(length));
        index += length;
        continue;
      }
      pieces.push({ text: character.repeat(length), marks: [], raw: null, delimiter: true });
      delimiters.push({
        index: pieces.length - 1,
        character,
        length,
        canOpen,
        canClose,
        active: true,
      });
      index += length;
      continue;
    }

    pushText(character);
    index += 1;
  }

  resolveDelimiters(pieces, delimiters);
  return toRuns(pieces, ids);
}

function parseCodeSpan(text: string, start: number): { content: string; end: number } | null {
  let fence = 0;
  while (text[start + fence] === '`') fence += 1;
  const marker = '`'.repeat(fence);
  let search = start + fence;
  while (search < text.length) {
    const found = text.indexOf(marker, search);
    if (found < 0) return null;
    if (text[found + fence] === '`') {
      let skip = found;
      while (text[skip] === '`') skip += 1;
      search = skip;
      continue;
    }
    let content = text.slice(start + fence, found);
    if (
      content.length >= 2 &&
      content.startsWith(' ') &&
      content.endsWith(' ') &&
      content.trim() !== ''
    ) {
      content = content.slice(1, -1);
    }
    return { content: content.replace(/\n/g, ' '), end: found + fence };
  }
  return null;
}

interface LinkLike {
  readonly label: string;
  readonly destination: string | null;
  readonly title: string | null;
  readonly end: number;
}

function parseLinkLike(text: string, start: number): LinkLike | null {
  if (text[start] !== '[') return null;
  let depth = 0;
  let index = start;
  let labelEnd = -1;
  while (index < text.length) {
    const character = text[index];
    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === '[') depth += 1;
    else if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
    }
    index += 1;
  }
  if (labelEnd < 0) return null;
  const label = text.slice(start + 1, labelEnd);

  if (text[labelEnd + 1] === '(') {
    const inline = parseInlineDestination(text, labelEnd + 1);
    if (inline) {
      return { label, destination: inline.destination, title: inline.title, end: inline.end };
    }
  }
  if (text[labelEnd + 1] === '[') {
    const close = text.indexOf(']', labelEnd + 2);
    if (close >= 0) return { label, destination: null, title: null, end: close + 1 };
  }
  if (text[labelEnd + 1] === ':') return null; // link reference definition
  return { label, destination: null, title: null, end: labelEnd + 1 };
}

function parseInlineDestination(
  text: string,
  open: number,
): { destination: string; title: string | null; end: number } | null {
  let index = open + 1;
  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;

  let destination = '';
  if (text[index] === '<') {
    index += 1;
    while (index < text.length && text[index] !== '>') {
      if (text[index] === '\\' && text[index + 1] !== undefined) {
        destination += text[index + 1];
        index += 2;
        continue;
      }
      destination += text[index];
      index += 1;
    }
    index += 1;
  } else {
    let depth = 0;
    while (index < text.length) {
      const character = text[index] as string;
      if (character === '\\' && text[index + 1] !== undefined) {
        destination += text[index + 1];
        index += 2;
        continue;
      }
      if (/\s/.test(character)) break;
      if (character === '(') depth += 1;
      if (character === ')') {
        if (depth === 0) break;
        depth -= 1;
      }
      destination += character;
      index += 1;
    }
  }

  while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  let title: string | null = null;
  const quote = text[index];
  if (quote === '"' || quote === "'") {
    index += 1;
    let collected = '';
    while (index < text.length && text[index] !== quote) {
      if (text[index] === '\\' && text[index + 1] !== undefined) {
        collected += text[index + 1];
        index += 2;
        continue;
      }
      collected += text[index];
      index += 1;
    }
    index += 1;
    title = collected;
    while (index < text.length && /\s/.test(text[index] ?? '')) index += 1;
  }
  if (text[index] !== ')') return null;
  return { destination, title, end: index + 1 };
}

/**
 * Match emphasis/strikethrough delimiter runs, innermost first.
 *
 * A simplification of the CommonMark "process emphasis" procedure: sufficient
 * for real documents and, crucially, exact for the canonical output this
 * engine's own writer produces.
 */
function resolveDelimiters(pieces: Piece[], delimiters: Delimiter[]): void {
  for (let closerIndex = 0; closerIndex < delimiters.length; closerIndex += 1) {
    const closer = delimiters[closerIndex];
    if (!closer || !closer.active || !closer.canClose || closer.length === 0) continue;

    // A closer is matched repeatedly until it is used up, so `***x***` resolves
    // as strong-inside-emphasis rather than leaving a stray asterisk at each
    // end. Stepping past the opener after every match — the obvious loop —
    // silently drops the leftover delimiters.
    let openerIndex = closerIndex - 1;
    while (openerIndex >= 0 && closer.length > 0) {
      const opener = delimiters[openerIndex];
      if (
        !opener ||
        !opener.active ||
        !opener.canOpen ||
        opener.length === 0 ||
        opener.character !== closer.character
      ) {
        openerIndex -= 1;
        continue;
      }

      const strikethrough = closer.character === '~';
      const use = strikethrough ? 2 : Math.min(2, opener.length, closer.length);
      const mark: Mark = strikethrough
        ? { type: 'strikethrough' }
        : use === 2
          ? { type: 'strong' }
          : { type: 'emphasis' };

      // The span to mark is addressed in *piece* indices; `openerIndex` and
      // `closerIndex` are indices into `delimiters` and are a different space
      // entirely. Confusing the two silently marks nothing.
      for (let i = opener.index + 1; i < closer.index; i += 1) {
        const piece = pieces[i];
        if (piece) piece.marks = [mark, ...piece.marks];
      }
      const openerPiece = pieces[opener.index];
      const closerPiece = pieces[closer.index];
      opener.length -= use;
      closer.length -= use;
      if (openerPiece) openerPiece.text = openerPiece.text.slice(0, opener.length);
      if (closerPiece) closerPiece.text = closerPiece.text.slice(0, closer.length);
      for (let i = openerIndex + 1; i < closerIndex; i += 1) {
        const between = delimiters[i];
        if (between) between.active = false;
      }
      if (opener.length === 0) {
        opener.active = false;
        openerIndex -= 1;
      }
    }

    if (closer.length === 0) closer.active = false;
  }
}

function toRuns(pieces: readonly Piece[], ids: IdFactory): readonly Run[] {
  const runs: Run[] = [];
  for (const piece of pieces) {
    if (piece.raw !== null) {
      runs.push(rawRun(ids(), piece.raw, piece.text));
      continue;
    }
    if (piece.text === '') continue;
    runs.push(textRun(ids(), piece.text, piece.marks));
  }
  return normalizeRuns(runs);
}

/** Re-exported so callers can convert offsets without importing `inline.js`. */
export type { RunOffset };

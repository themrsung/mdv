/**
 * MDV attribute notation — the header section of a visual block (SPEC 5.3).
 *
 * This is a hand-written recursive-descent parser rather than a call into
 * `yaml`, for the reason SPEC 5.3 gives: the notation is specified as a subset
 * so that implementations in any language agree. Two consequences that a general
 * YAML parser would get "wrong" for MDV:
 *
 * - `yes`/`no`/`on`/`off` are strings, and only `true`/`false` are booleans;
 * - octal and sexagesimal literals are an *error* (`MDV1211`), not a number.
 *
 * The other reason is positions. Every value gets an exact source range keyed by
 * a dotted path (`axis.y.title`, `y[1]`), which is what lets the LSP underline
 * one attribute value rather than the whole block. A YAML CST could supply that
 * too, but only after mapping its own offsets back through the block's
 * de-indentation — which is most of the work anyway.
 *
 * The parser never throws. Anything it cannot read becomes a diagnostic, and
 * unreadable lines are handed back to the caller, which knows whether the block
 * had a separator and therefore whether the right code is `MDV1203` or
 * `MDV1211` (SPEC 5.1).
 */

import type { AttrMap, AttrRanges, AttrValue, Range } from '../types.js';
import type { DiagnosticBag } from './diagnostics.js';
import type { SourceIndex } from './source.js';
import { ATTR_KEY, readFlow, stripPlainComment, typePlainScalar } from './scalar.js';

/** One header line, already stripped of the block's own indentation. */
export interface HeaderLine {
  /** Line text without its terminator. */
  readonly text: string;
  /** Absolute offset in the root document of `text[0]`. */
  readonly offset: number;
}

/** What {@link parseHeaderLines} produces. */
export interface HeaderResult {
  readonly attrs: AttrMap;
  readonly positions: AttrRanges;
  /** Lines that are not valid attribute notation; the caller diagnoses them. */
  readonly invalid: readonly Range[];
}

interface LineInfo {
  /** Nothing but whitespace. */
  readonly blank: boolean;
  /** First non-whitespace character is `#`. */
  readonly comment: boolean;
  /** Index of the first non-whitespace character (its column, 0-based). */
  readonly indent: number;
}

/** Block-scalar header: `|`, `>`, with optional explicit indent and chomping. */
const BLOCK_SCALAR = /^([|>])([0-9+-]*)[ \t]*(?:#.*)?$/;

/** YAML 1.1 sexagesimal, e.g. `9:30` or `1:20:30`. */
const SEXAGESIMAL = /^-?[0-9]+(?::[0-5]?[0-9])+(?:\.[0-9]+)?$/;

/** Octal and hex literals that YAML 1.1 would silently turn into numbers. */
const NON_JSON_RADIX = /^-?(?:0[0-7]+|0[oO][0-7]+|0[xX][0-9a-fA-F]+|0[bB][01]+)$/;

/**
 * Parse a header section.
 *
 * @param lines - header lines with absolute offsets, de-indented (SPEC 5.4).
 * @param root - index over the *original* document, for absolute ranges.
 * @param bag - receives `MDV1210`/`MDV1211`/`MDV1212`.
 */
export function parseHeaderLines(
  lines: readonly HeaderLine[],
  root: SourceIndex,
  bag: DiagnosticBag,
): HeaderResult {
  return new HeaderParser(lines, root, bag).run();
}

class HeaderParser {
  private readonly lines: HeaderLine[];
  private readonly info: LineInfo[];
  private readonly root: SourceIndex;
  private readonly bag: DiagnosticBag;
  private readonly positions: Record<string, Range> = {};
  private readonly invalid: Range[] = [];
  private readonly attrs: AttrMap = {};
  /** Index of the next line to look at. */
  private at = 0;
  /** Index of the last line consumed by a value, for computing block ranges. */
  private lastConsumed = -1;

  constructor(lines: readonly HeaderLine[], root: SourceIndex, bag: DiagnosticBag) {
    this.lines = lines.slice();
    this.root = root;
    this.bag = bag;
    this.info = this.lines.map((line, i) => this.classify(line, i));
  }

  run(): HeaderResult {
    for (;;) {
      const li = this.skip();
      if (li === -1) break;
      const before = this.at;
      const map = this.parseMapping(0, '');
      for (const [key, value] of Object.entries(map)) this.attrs[key] = value;
      if (this.at === before) {
        // Defensive: parseMapping always consumes or breaks on a shallower line,
        // and at indent 0 there is nothing shallower. Never loop forever.
        this.invalid.push(this.lineRange(this.at));
        this.at += 1;
      }
    }
    return { attrs: this.attrs, positions: this.positions, invalid: this.invalid };
  }

  // ── line handling ─────────────────────────────────────────────────────────

  private classify(line: HeaderLine, index: number): LineInfo {
    const text = line.text;
    let i = 0;
    let tab = -1;
    while (i < text.length) {
      const code = text.charCodeAt(i);
      if (code === 32) {
        i += 1;
        continue;
      }
      if (code === 9) {
        if (tab === -1) tab = i;
        i += 1;
        continue;
      }
      break;
    }
    const blank = i >= text.length;
    if (tab !== -1 && !blank) {
      // SPEC 5.3.1: indentation MUST be spaces. Report, then carry on treating
      // the tab as one column so the rest of the header still parses.
      this.bag.add('MDV1210', this.root.range(line.offset + tab, line.offset + tab + 1), {
        detail: `Line ${index + 1} of the header indents with a tab. Use two spaces per level.`,
      });
    }
    return { blank, comment: !blank && text.charCodeAt(i) === 35, indent: i };
  }

  /** Advance to the next content line and return its index, or `-1` at the end. */
  private skip(): number {
    while (this.at < this.lines.length) {
      const info = this.info[this.at];
      if (info === undefined) break;
      if (info.blank || info.comment) {
        this.at += 1;
        continue;
      }
      return this.at;
    }
    this.at = this.lines.length;
    return -1;
  }

  private lineAt(index: number): HeaderLine {
    return this.lines[index] ?? { text: '', offset: 0 };
  }

  private infoAt(index: number): LineInfo {
    return this.info[index] ?? { blank: true, comment: false, indent: 0 };
  }

  private lineRange(index: number): Range {
    const line = this.lineAt(index);
    const info = this.infoAt(index);
    return this.root.range(line.offset + info.indent, line.offset + line.text.length);
  }

  private consume(index: number): void {
    this.lastConsumed = index;
    this.at = index + 1;
  }

  private record(path: string, start: number, end: number): void {
    if (path === '') return;
    this.positions[path] = this.root.range(start, end);
  }

  // ── mappings ──────────────────────────────────────────────────────────────

  private parseMapping(indent: number, path: string): AttrMap {
    const map: AttrMap = {};
    for (;;) {
      const li = this.skip();
      if (li === -1) break;
      const info = this.infoAt(li);
      if (info.indent < indent) break;

      const line = this.lineAt(li);
      const text = line.text;

      if (info.indent > indent) {
        this.bag.add('MDV1212', this.lineRange(li), {
          detail:
            `Expected an indent of ${indent} spaces here but found ${info.indent}. ` +
            'MDV headers indent exactly two spaces per level.',
        });
        this.consume(li);
        continue;
      }

      if (this.reportUnsupported(li, info.indent)) {
        this.consume(li);
        continue;
      }

      // A sequence item where a mapping entry was expected.
      if (isDashItem(text, info.indent)) {
        this.invalid.push(this.lineRange(li));
        this.consume(li);
        continue;
      }

      const keyMatch = ATTR_KEY.exec(text.slice(info.indent));
      if (keyMatch === null) {
        this.invalid.push(this.lineRange(li));
        this.consume(li);
        continue;
      }
      const key = keyMatch[0];
      let cursor = info.indent + key.length;
      while (cursor < text.length && isBlank(text.charCodeAt(cursor))) cursor += 1;
      // A block mapping needs `key:` followed by a space or the end of the line.
      // `height:200` is a plain scalar in YAML and must not be misread here.
      if (
        text.charCodeAt(cursor) !== 58 /* : */ ||
        (cursor + 1 < text.length && !isBlank(text.charCodeAt(cursor + 1)))
      ) {
        this.invalid.push(this.lineRange(li));
        this.consume(li);
        continue;
      }

      const childPath = path === '' ? key : `${path}.${key}`;
      map[key] = this.parseEntryValue(li, cursor + 1, info.indent, childPath);
    }
    return map;
  }

  /**
   * Parse the value of `key:` whose colon ends at `after` on line `li`, which is
   * indented `indent` spaces. Consumes the line and any block that follows it.
   */
  private parseEntryValue(li: number, after: number, indent: number, path: string): AttrValue {
    const line = this.lineAt(li);
    const text = line.text;
    let cursor = after;
    while (cursor < text.length && isBlank(text.charCodeAt(cursor))) cursor += 1;

    const rest = text.slice(cursor);
    const empty = rest.length === 0 || rest.charCodeAt(0) === 35; /* # */

    if (empty) {
      this.consume(li);
      return this.parseBlockValue(indent, path, line.offset + text.length);
    }

    const blockScalar = BLOCK_SCALAR.exec(rest);
    if (blockScalar !== null) {
      this.consume(li);
      return this.parseBlockScalar(li, cursor, indent, path, blockScalar);
    }

    this.consume(li);
    return this.parseInlineValue(line, cursor, path);
  }

  /** A value written on the same line as its key. */
  private parseInlineValue(line: HeaderLine, cursor: number, path: string): AttrValue {
    const text = line.text;
    const first = text.charCodeAt(cursor);

    if (first === 91 /* [ */ || first === 123 /* { */ || first === 34 || first === 39) {
      const read = readFlow(text, cursor, path, (p, s, e) => {
        this.record(p, line.offset + s, line.offset + e);
      });
      if (!read.ok) {
        this.bag.add('MDV1211', this.root.range(line.offset + cursor, line.offset + text.length), {
          message: 'Unterminated quoted scalar or flow collection',
          detail: 'A quoted value, `[...]` sequence or `{...}` mapping is not closed.',
        });
      }
      const tail = stripPlainComment(text, read.end);
      if (tail.text.length > 0) {
        this.bag.add('MDV1211', this.root.range(line.offset + read.end, line.offset + tail.end), {
          message: 'Unexpected content after a value',
          detail: `Nothing may follow \`${text.slice(cursor, read.end)}\` except a comment.`,
        });
      }
      return read.value;
    }

    const plain = stripPlainComment(text, cursor);
    this.record(path, line.offset + cursor, line.offset + plain.end);
    this.checkPlainLiteral(plain.text, line.offset + cursor, line.offset + plain.end);
    return typePlainScalar(plain.text);
  }

  /** A nested mapping or sequence on the lines after `key:`. */
  private parseBlockValue(indent: number, path: string, emptyAt: number): AttrValue {
    const li = this.skip();
    if (li === -1) {
      this.record(path, emptyAt, emptyAt);
      return null;
    }
    const info = this.infoAt(li);
    if (info.indent <= indent) {
      this.record(path, emptyAt, emptyAt);
      return null;
    }
    if (info.indent !== indent + 2) {
      this.bag.add('MDV1212', this.lineRange(li), {
        detail:
          `Expected an indent of ${indent + 2} spaces here but found ${info.indent}. ` +
          'MDV headers indent exactly two spaces per level.',
      });
    }

    const start = this.lineAt(li).offset + info.indent;
    const value = isDashItem(this.lineAt(li).text, info.indent)
      ? this.parseSequence(info.indent, path)
      : this.parseMapping(info.indent, path);
    this.record(path, start, this.endOfLastConsumed());
    return value;
  }

  private parseSequence(indent: number, path: string): AttrValue[] {
    const items: AttrValue[] = [];
    for (;;) {
      const li = this.skip();
      if (li === -1) break;
      const info = this.infoAt(li);
      if (info.indent < indent) break;
      const line = this.lineAt(li);
      if (info.indent > indent || !isDashItem(line.text, info.indent)) break;

      const itemPath = `${path}[${items.length}]`;
      const text = line.text;
      let cursor = info.indent + 1;
      while (cursor < text.length && isBlank(text.charCodeAt(cursor))) cursor += 1;

      const rest = text.slice(cursor);
      if (rest.length === 0 || rest.charCodeAt(0) === 35 /* # */) {
        // `-` alone: the item is the block underneath it.
        this.consume(li);
        items.push(this.parseBlockValue(indent, itemPath, line.offset + text.length));
        continue;
      }

      const mappingKey = mappingEntryAt(text, cursor);
      if (mappingKey !== null) {
        // `- key: value`. Rewriting the dash as a space keeps every column — and
        // therefore every offset — exactly where it was, so the item can be
        // parsed as an ordinary mapping starting at the key's own column.
        if (cursor !== indent + 2) {
          this.bag.add('MDV1212', this.lineRange(li), {
            detail:
              'A sequence item that starts a mapping must put its first key at the ' +
              `dash's column plus two (${indent + 2}), not ${cursor}.`,
          });
        }
        this.lines[li] = {
          text: ' '.repeat(cursor) + text.slice(cursor),
          offset: line.offset,
        };
        this.info[li] = { blank: false, comment: false, indent: cursor };
        const start = line.offset + cursor;
        items.push(this.parseMapping(cursor, itemPath));
        this.record(itemPath, start, this.endOfLastConsumed());
        continue;
      }

      this.consume(li);
      items.push(this.parseInlineValue(line, cursor, itemPath));
    }
    return items;
  }

  // ── block scalars ─────────────────────────────────────────────────────────

  private parseBlockScalar(
    li: number,
    cursor: number,
    indent: number,
    path: string,
    match: RegExpExecArray,
  ): string {
    const line = this.lineAt(li);
    const folded = match[1] === '>';
    const modifiers = match[2] ?? '';
    const chomp: 'clip' | 'strip' | 'keep' = modifiers.includes('-')
      ? 'strip'
      : modifiers.includes('+')
        ? 'keep'
        : 'clip';
    const digits = /[0-9]+/.exec(modifiers);
    const explicit = digits === null ? 0 : Number(digits[0]);

    // Collect every following line that is blank or indented past the key.
    const body: number[] = [];
    let scan = li + 1;
    let contentIndent = explicit > 0 ? indent + explicit : -1;
    while (scan < this.lines.length) {
      const info = this.infoAt(scan);
      if (!info.blank && info.indent <= indent) break;
      if (!info.blank && contentIndent === -1) contentIndent = info.indent;
      body.push(scan);
      scan += 1;
    }
    // Trailing blank lines are not part of the folded body; how many of their
    // newlines survive is decided by the chomping indicator.
    let trailingBlanks = 0;
    while (body.length > 0) {
      const last = body[body.length - 1];
      if (last === undefined) break;
      if (!this.infoAt(last).blank) break;
      body.pop();
      trailingBlanks += 1;
    }
    if (contentIndent === -1) contentIndent = indent + 2;

    const pieces: string[] = [];
    for (const index of body) {
      const info = this.infoAt(index);
      const text = this.lineAt(index).text;
      pieces.push(info.blank ? '' : text.slice(Math.min(contentIndent, info.indent)));
    }

    const value = chompLines(foldLines(pieces, folded), chomp, pieces.length > 0, trailingBlanks);
    const lastLine = body.length > 0 ? (body[body.length - 1] as number) : li;
    this.lastConsumed = lastLine;
    this.at = scan;
    this.record(
      path,
      line.offset + cursor,
      this.lineAt(lastLine).offset + this.lineAt(lastLine).text.length,
    );
    return value;
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  /** SPEC 5.3.2: constructs that MUST error rather than silently misparse. */
  private reportUnsupported(li: number, indent: number): boolean {
    const line = this.lineAt(li);
    const rest = line.text.slice(indent);
    const found = unsupportedConstruct(rest);
    if (found === null) return false;
    this.bag.add('MDV1211', this.lineRange(li), {
      message: `${found} is not supported in an MDV header`,
      detail:
        'MDV attribute notation is a subset of YAML 1.2 (SPEC 5.3.2): no anchors, ' +
        'aliases, tags, merge keys, complex keys or directives.',
    });
    return true;
  }

  /** SPEC 5.3.2: octal and sexagesimal literals are an error, not a number. */
  private checkPlainLiteral(text: string, start: number, end: number): void {
    if (text.length === 0) return;
    const radix = NON_JSON_RADIX.test(text);
    if (!radix && !SEXAGESIMAL.test(text)) return;
    this.bag.add('MDV1211', this.root.range(start, end), {
      message: radix
        ? 'Octal, hex and binary literals are not supported'
        : 'Sexagesimal literals are not supported',
      detail: `Quote the value if you mean the string "${text}".`,
    });
  }

  private endOfLastConsumed(): number {
    if (this.lastConsumed < 0) return 0;
    const line = this.lineAt(this.lastConsumed);
    return line.offset + line.text.length;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function isBlank(code: number): boolean {
  return code === 32 || code === 9;
}

/** `true` when the line begins a block-sequence item at `indent`. */
function isDashItem(text: string, indent: number): boolean {
  if (text.charCodeAt(indent) !== 45 /* - */) return false;
  const next = indent + 1;
  return next >= text.length || isBlank(text.charCodeAt(next));
}

/** The key of `key: …` starting at `cursor`, or `null` if it is not one. */
function mappingEntryAt(text: string, cursor: number): string | null {
  const match = ATTR_KEY.exec(text.slice(cursor));
  if (match === null) return null;
  let i = cursor + match[0].length;
  while (i < text.length && isBlank(text.charCodeAt(i))) i += 1;
  if (text.charCodeAt(i) !== 58 /* : */) return null;
  if (i + 1 < text.length && !isBlank(text.charCodeAt(i + 1))) return null;
  return match[0];
}

/** Name the unsupported YAML construct a header line starts with, if any. */
function unsupportedConstruct(rest: string): string | null {
  if (rest.startsWith('? ') || rest === '?') return 'A complex key (`? `)';
  if (rest.startsWith('%')) return 'A YAML directive (`%`)';
  if (rest.startsWith('<<:')) return 'A merge key (`<<`)';
  if (rest.startsWith('&')) return 'An anchor (`&`)';
  if (rest.startsWith('*')) return 'An alias (`*`)';
  if (rest.startsWith('!')) return 'A tag (`!`)';

  const key = mappingEntryAt(rest, 0);
  if (key === null) return null;
  let i = key.length;
  while (i < rest.length && isBlank(rest.charCodeAt(i))) i += 1;
  i += 1; // the colon
  while (i < rest.length && isBlank(rest.charCodeAt(i))) i += 1;
  if (i >= rest.length) return null;
  const value = rest.slice(i);
  if (value.startsWith('&')) return 'An anchor (`&`)';
  if (value.startsWith('*')) return 'An alias (`*`)';
  if (value.startsWith('!')) return 'A tag (`!`)';
  return null;
}

/** Join block-scalar lines, folding line breaks for `>` (YAML 1.2 §8.1.3). */
function foldLines(lines: readonly string[], folded: boolean): string {
  if (!folded) return lines.join('\n');
  let out = '';
  let previousEmpty = false;
  lines.forEach((line, index) => {
    if (index === 0) {
      out += line;
      previousEmpty = line.length === 0;
      return;
    }
    if (line.length === 0) {
      out += '\n';
      previousEmpty = true;
      return;
    }
    out += previousEmpty ? line : ` ${line}`;
    previousEmpty = false;
  });
  return out;
}

/**
 * Apply a chomping indicator to a block scalar's body: `-` strips the final
 * break, `+` keeps every trailing break, the default clips to exactly one.
 */
function chompLines(
  body: string,
  chomp: 'clip' | 'strip' | 'keep',
  hadContent: boolean,
  trailingBlanks: number,
): string {
  if (!hadContent) return chomp === 'keep' ? '\n'.repeat(trailingBlanks) : '';
  if (chomp === 'strip') return body;
  if (chomp === 'keep') return body + '\n'.repeat(trailingBlanks + 1);
  return `${body}\n`;
}

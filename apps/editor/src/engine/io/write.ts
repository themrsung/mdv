/**
 * `write(document) → .mdv text`.
 *
 * Output is CommonMark + GFM, plus visual blocks fenced per SPEC 5. Three
 * properties are guaranteed:
 *
 * 1. **Losslessness.** Everything the model can express survives a round trip
 *    through `read`. Raw blocks are emitted byte-for-byte.
 * 2. **Determinism.** No clock, no randomness, no locale. The same document
 *    always produces the same bytes.
 * 3. **The separator rule (SPEC 5.1).** A visual block emits a `---` line if and
 *    only if `data !== null`. A block with attributes and no data emits no
 *    separator; a block with data and no attributes emits a bare `---` first.
 *
 * One structural compromise is unavoidable in Markdown: two adjacent lists of
 * the same kind re-read as a single list. The writer flips the second list's
 * bullet character (or ordered delimiter) so the *structure* survives even
 * though the glyph changes.
 */

import type {
  Block,
  CodeBlock,
  ColumnAlign,
  ImageBlock,
  ListBlock,
  MdvDocument,
  Run,
  TableBlock,
  VisualBlock,
} from '../model.js';
import { escapeDestination, escapeInline, escapeQuoted } from './escape.js';

/** Options for {@link write}. */
export interface WriteOptions {
  /**
   * Pad table cells so the pipes line up. Purely cosmetic — the reader trims
   * cells either way. Default `true`, because a hand-editable format should
   * look hand-edited.
   */
  readonly prettyTables?: boolean;
}

/** Serialise a document to `.mdv` text. Always LF, always trailing newline. */
export function write(doc: MdvDocument, options: WriteOptions = {}): string {
  const parts: string[] = [];
  if (doc.frontMatter) {
    const source = doc.frontMatter.source;
    parts.push(`---\n${source === '' ? '' : `${source}\n`}${doc.frontMatter.terminator}`);
  }
  const body = writeBlocks(disambiguateLists(doc.blocks), options);
  if (body !== '') parts.push(body);
  if (parts.length === 0) return '';
  return `${parts.join('\n\n')}\n`;
}

/** Serialise a block list without front matter — used for clipboard fragments. */
export function writeBlocks(blocks: readonly Block[], options: WriteOptions = {}): string {
  const rendered: string[] = [];
  for (const block of blocks) {
    const text = writeBlock(block, options);
    if (text === '' && block.kind === 'paragraph') continue;
    rendered.push(text);
  }
  return rendered.join('\n\n');
}

/**
 * Flip the marker of a list that directly follows a list of the same kind, so
 * the two do not merge when read back.
 */
function disambiguateLists(blocks: readonly Block[]): readonly Block[] {
  let changed = false;
  const out = blocks.map((block, index) => {
    const previous = blocks[index - 1];
    if (!previous || previous.kind !== 'list' || block.kind !== 'list') return block;
    if (previous.ordered !== block.ordered) return block;
    if (!previous.ordered && !block.ordered && previous.bullet === block.bullet) {
      changed = true;
      const bullet = block.bullet === '-' ? '*' : block.bullet === '*' ? '+' : '-';
      return { ...block, bullet } satisfies ListBlock;
    }
    if (previous.ordered && block.ordered && previous.delimiter === block.delimiter) {
      changed = true;
      return { ...block, delimiter: block.delimiter === '.' ? ')' : '.' } satisfies ListBlock;
    }
    return block;
  });
  return changed ? out : blocks;
}

function writeBlock(block: Block, options: WriteOptions): string {
  switch (block.kind) {
    case 'paragraph':
      return writeInline(block.runs, { atLineStart: true, inTable: false });
    case 'heading':
      return writeHeading(block.level, block.style, block.runs);
    case 'thematicBreak':
      return block.marker;
    case 'code':
      return writeCode(block);
    case 'image':
      return writeImage(block);
    case 'raw':
      return block.text;
    case 'visual':
      return writeVisual(block);
    case 'table':
      return writeTable(block, options);
    case 'blockquote': {
      const inner = writeBlocks(disambiguateLists(block.children), options);
      return inner
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    }
    case 'list':
      return writeList(block, options);
    default: {
      const never: never = block;
      throw new Error(`unreachable block kind: ${JSON.stringify(never)}`);
    }
  }
}

function writeHeading(level: number, style: 'atx' | 'setext', runs: readonly Run[]): string {
  const text = writeInline(runs, { atLineStart: false, inTable: false });
  if (style === 'setext' && (level === 1 || level === 2) && !text.includes('\n')) {
    return `${text}\n${(level === 1 ? '=' : '-').repeat(Math.max(3, text.length))}`;
  }
  return text === '' ? '#'.repeat(level) : `${'#'.repeat(level)} ${text}`;
}

/** Longest run of `character` anywhere in `text`. */
function longestRun(text: string, character: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    if (value === character) {
      current += 1;
      if (current > longest) longest = current;
    } else current = 0;
  }
  return longest;
}

function writeCode(block: CodeBlock): string {
  if (block.fence.style === 'indented') {
    return block.text
      .split('\n')
      .map((line) => (line === '' ? '' : `    ${line}`))
      .join('\n');
  }
  const character = block.fence.style === 'tilde' ? '~' : '`';
  const length = Math.max(3, block.fence.length, longestRun(block.text, character) + 1);
  const fence = character.repeat(length);
  const open = `${fence}${block.info}`;
  return block.text === '' ? `${open}\n${fence}` : `${open}\n${block.text}\n${fence}`;
}

function writeImage(block: ImageBlock): string {
  const title = block.title === null ? '' : ` "${escapeQuoted(block.title)}"`;
  const attributes: string[] = [];
  if (block.width !== null) attributes.push(`width=${block.width}`);
  if (block.height !== null) attributes.push(`height=${block.height}`);
  const suffix = attributes.length > 0 ? `{${attributes.join(' ')}}` : '';
  const alt = escapeInline(block.alt, { atLineStart: false, inTable: false });
  return `![${alt}](${escapeDestination(block.src)}${title})${suffix}`;
}

/** Build the info string of a visual block (SPEC 5.2). */
export function visualInfoString(block: VisualBlock): string {
  const parts = ['mdv'];
  if (block.blockType !== '') parts.push(block.blockType);
  for (const attribute of block.infoAttributes) {
    const value =
      attribute.quote === 'double'
        ? `"${attribute.value.replace(/"/g, '\\"')}"`
        : attribute.quote === 'single'
          ? `'${attribute.value}'`
          : attribute.value;
    parts.push(`${attribute.key}=${value}`);
  }
  return parts.join(' ');
}

function writeVisual(block: VisualBlock): string {
  const info = visualInfoString(block);
  const lines: string[] = [];
  if (block.header !== '') lines.push(...block.header.split('\n'));
  if (block.data !== null) {
    lines.push('---');
    if (block.data !== '') lines.push(...block.data.split('\n'));
  }
  const body = lines.join('\n');

  // SPEC 5.1: a fence whose info string contains a backtick MUST use tildes.
  const style: 'backtick' | 'tilde' = info.includes('`') ? 'tilde' : block.fence.style;
  const character = style === 'tilde' ? '~' : '`';
  const length = Math.max(3, block.fence.length, longestRun(body, character) + 1);
  const fence = character.repeat(length);
  return body === '' ? `${fence}${info}\n${fence}` : `${fence}${info}\n${body}\n${fence}`;
}

function alignmentCell(align: ColumnAlign, width: number): string {
  const inner = Math.max(width, align === 'center' ? 3 : align === 'none' ? 1 : 2);
  switch (align) {
    case 'left':
      return `:${'-'.repeat(inner - 1)}`;
    case 'right':
      return `${'-'.repeat(inner - 1)}:`;
    case 'center':
      return `:${'-'.repeat(inner - 2)}:`;
    case 'none':
      return '-'.repeat(inner);
    default: {
      const never: never = align;
      throw new Error(`unreachable alignment: ${String(never)}`);
    }
  }
}

/** Display width in code points — deterministic and locale-free. */
function displayWidth(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function writeTable(block: TableBlock, options: WriteOptions): string {
  const pretty = options.prettyTables !== false;
  const columns = block.align.length;
  const grid = block.rows.map((row) =>
    Array.from({ length: columns }, (_unused, index) => {
      const cell = row.cells[index];
      if (!cell) return '';
      return writeInline(cell.runs, { atLineStart: false, inTable: true }).replace(/\n/g, ' ');
    }),
  );

  const widths = Array.from({ length: columns }, (_unused, index) => {
    if (!pretty) return 0;
    let width = 3;
    for (const row of grid) width = Math.max(width, displayWidth(row[index] ?? ''));
    return width;
  });

  const renderRow = (cells: readonly string[]): string => {
    const rendered = cells.map((cell, index) => {
      const width = widths[index] ?? 0;
      const padding = Math.max(0, width - displayWidth(cell));
      return pretty ? ` ${cell}${' '.repeat(padding)} ` : ` ${cell} `;
    });
    return `|${rendered.join('|')}|`;
  };

  const header = grid[0] ?? Array.from({ length: columns }, () => '');
  const delimiter = block.align.map((align, index) =>
    alignmentCell(align, pretty ? (widths[index] ?? 3) : 3),
  );
  const lines = [renderRow(header), `|${delimiter.map((cell) => ` ${cell} `).join('|')}|`];
  for (let index = 1; index < grid.length; index += 1) {
    lines.push(renderRow(grid[index] ?? []));
  }
  return lines.join('\n');
}

function writeList(block: ListBlock, options: WriteOptions): string {
  const rendered = block.items.map((item, index) => {
    const marker = block.ordered
      ? `${block.start + index}${block.delimiter} `
      : `${block.bullet} `;
    const task = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
    const indent = ' '.repeat(marker.length);

    const pieces: string[] = [];
    const blocks = disambiguateLists(item.blocks);
    for (let i = 0; i < blocks.length; i += 1) {
      const current = blocks[i];
      if (!current) continue;
      const previous = blocks[i - 1];
      const glue =
        i === 0 ? '' : block.tight && previous?.kind === 'paragraph' && current.kind === 'list' ? '\n' : '\n\n';
      pieces.push(glue + writeBlock(current, options));
    }
    const body = pieces.join('');
    const [first = '', ...rest] = body.split('\n');
    const head = `${marker}${task}${first}`;
    if (rest.length === 0) return head;
    return [head, ...rest.map((line) => (line === '' ? '' : `${indent}${line}`))].join('\n');
  });
  return rendered.join(block.tight ? '\n' : '\n\n');
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                      */
/* -------------------------------------------------------------------------- */

interface InlineContext {
  readonly atLineStart: boolean;
  readonly inTable: boolean;
}

const OPENERS: Readonly<Record<string, string>> = {
  strong: '**',
  emphasis: '*',
  strikethrough: '~~',
};

/**
 * Serialise a run list.
 *
 * Marks are emitted as nested spans in canonical order (link outermost, code
 * innermost). Adjacent runs sharing a mark keep it open, so `**ab**` is emitted
 * rather than `**a****b**`.
 */
export function writeInline(runs: readonly Run[], context: InlineContext): string {
  let out = '';
  let atLineStart = context.atLineStart;
  /** Open spans, outermost first. `key` identifies a mark for reuse across runs. */
  const open: { key: string; close: string }[] = [];

  const closeTo = (depth: number): void => {
    while (open.length > depth) {
      const entry = open.pop();
      if (entry === undefined) break;
      out += entry.close;
      atLineStart = false;
    }
  };

  for (const run of runs) {
    if (run.kind === 'raw') {
      closeTo(0);
      out += run.source;
      atLineStart = run.source.endsWith('\n');
      continue;
    }
    const keys = run.marks.map(markKey);
    let shared = 0;
    while (shared < open.length && shared < keys.length && open[shared]?.key === keys[shared]) {
      shared += 1;
    }
    closeTo(shared);
    for (let index = shared; index < keys.length; index += 1) {
      const mark = run.marks[index];
      const key = keys[index];
      if (!mark || key === undefined) continue;
      if (mark.type === 'link') {
        const suffix = mark.title === null ? '' : ` "${escapeQuoted(mark.title)}"`;
        out += '[';
        open.push({ key, close: `](${escapeDestination(mark.href)}${suffix})` });
      } else if (mark.type === 'code') {
        const fence = '`'.repeat(longestRun(run.text, '`') + 1);
        out += fence;
        open.push({ key, close: fence });
      } else {
        const delimiter = OPENERS[mark.type] ?? '';
        out += delimiter;
        open.push({ key, close: delimiter });
      }
      atLineStart = false;
    }
    if (run.marks.some((mark) => mark.type === 'code')) {
      // Code spans are emitted by their opener; the text is already inside.
      out += codeSpanBody(run.text);
    } else {
      out += escapeInline(run.text, { atLineStart, inTable: context.inTable });
      if (run.text !== '') atLineStart = run.text.endsWith('\n');
    }
  }
  closeTo(0);
  return out;
}

/** Stable key for a mark, including link target so two links do not merge. */
function markKey(mark: { type: string; href?: string; title?: string | null }): string {
  if (mark.type === 'link') return `link|${mark.href ?? ''}|${mark.title ?? ''}`;
  return mark.type;
}

function codeSpanBody(text: string): string {
  // A code span whose content starts or ends with a backtick, or is all spaces,
  // needs one space of padding on each side (CommonMark).
  if (text === '') return '';
  const needsPadding = text.startsWith('`') || text.endsWith('`') || /^ +$/.test(text);
  return needsPadding ? ` ${text} ` : text;
}

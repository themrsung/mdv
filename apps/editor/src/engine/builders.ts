/**
 * Node constructors.
 *
 * Every constructor takes an {@link IdFactory} so that construction stays
 * deterministic and so a caller can build a fragment in an isolated id
 * namespace before splicing it into a document.
 */

import type { IdFactory, NodeId } from './ids.js';
import { normalizeRuns, textRun } from './inline.js';
import type {
  Block,
  BlockquoteBlock,
  BulletListBlock,
  CodeBlock,
  CodeFence,
  ColumnAlign,
  FenceStyle,
  FrontMatter,
  HeadingBlock,
  HeadingLevel,
  ImageBlock,
  InfoAttribute,
  ListItem,
  MdvDocument,
  OrderedListBlock,
  ParagraphBlock,
  RawBlock,
  Run,
  TableBlock,
  TableCell,
  TableRow,
  ThematicBreakBlock,
  VisualBlock,
} from './model.js';

/** Build a paragraph. */
export function paragraph(ids: IdFactory, runs: readonly Run[] = []): ParagraphBlock {
  return { kind: 'paragraph', id: ids(), runs: normalizeRuns(runs) };
}

/** Build a paragraph holding a single unformatted run. */
export function textParagraph(ids: IdFactory, text: string): ParagraphBlock {
  return paragraph(ids, text.length > 0 ? [textRun(ids(), text)] : []);
}

/** Build a heading. */
export function heading(
  ids: IdFactory,
  level: HeadingLevel,
  runs: readonly Run[] = [],
  style: 'atx' | 'setext' = 'atx',
): HeadingBlock {
  return { kind: 'heading', id: ids(), level, style, runs: normalizeRuns(runs) };
}

/** Build a list item. */
export function listItem(
  ids: IdFactory,
  blocks: readonly Block[],
  checked: boolean | null = null,
): ListItem {
  return { id: ids(), checked, blocks };
}

/** Build a bullet list. */
export function bulletList(
  ids: IdFactory,
  items: readonly ListItem[],
  options: { bullet?: '-' | '*' | '+'; tight?: boolean } = {},
): BulletListBlock {
  return {
    kind: 'list',
    id: ids(),
    ordered: false,
    bullet: options.bullet ?? '-',
    tight: options.tight ?? true,
    items,
  };
}

/** Build an ordered list. */
export function orderedList(
  ids: IdFactory,
  items: readonly ListItem[],
  options: { start?: number; delimiter?: '.' | ')'; tight?: boolean } = {},
): OrderedListBlock {
  return {
    kind: 'list',
    id: ids(),
    ordered: true,
    start: options.start ?? 1,
    delimiter: options.delimiter ?? '.',
    tight: options.tight ?? true,
    items,
  };
}

/** Build a block quote. */
export function blockquote(ids: IdFactory, children: readonly Block[]): BlockquoteBlock {
  return { kind: 'blockquote', id: ids(), children };
}

/** Build a fenced code block. */
export function codeBlock(
  ids: IdFactory,
  text: string,
  info = '',
  fence: CodeFence = { style: 'backtick', length: 3 },
): CodeBlock {
  return { kind: 'code', id: ids(), info, text, fence };
}

/** Build a thematic break. */
export function thematicBreak(ids: IdFactory, marker = '---'): ThematicBreakBlock {
  return { kind: 'thematicBreak', id: ids(), marker };
}

/** Build an image block. */
export function image(
  ids: IdFactory,
  src: string,
  options: {
    alt?: string;
    title?: string | null;
    width?: number | null;
    height?: number | null;
  } = {},
): ImageBlock {
  return {
    kind: 'image',
    id: ids(),
    src,
    alt: options.alt ?? '',
    title: options.title ?? null,
    width: options.width ?? null,
    height: options.height ?? null,
  };
}

/** Build a table cell. */
export function tableCell(ids: IdFactory, runs: readonly Run[] = []): TableCell {
  return { id: ids(), runs: normalizeRuns(runs) };
}

/** Build a table cell holding one unformatted run. */
export function textCell(ids: IdFactory, text: string): TableCell {
  return tableCell(ids, text.length > 0 ? [textRun(ids(), text)] : []);
}

/** Build a table row. */
export function tableRow(ids: IdFactory, cells: readonly TableCell[]): TableRow {
  return { id: ids(), cells };
}

/**
 * Build a table.
 *
 * The caller is responsible for rectangularity; use `makeRectangular` from
 * `table.ts` when the input may be ragged.
 */
export function table(
  ids: IdFactory,
  align: readonly ColumnAlign[],
  rows: readonly TableRow[],
): TableBlock {
  return { kind: 'table', id: ids(), align, rows };
}

/** Build an empty `columns` × `bodyRows` table with a header row. */
export function emptyTable(ids: IdFactory, columns: number, bodyRows: number): TableBlock {
  const width = Math.max(1, Math.trunc(columns));
  const height = Math.max(0, Math.trunc(bodyRows));
  const makeRow = (): TableRow =>
    tableRow(
      ids,
      Array.from({ length: width }, () => tableCell(ids)),
    );
  const rows: TableRow[] = [makeRow()];
  for (let index = 0; index < height; index += 1) rows.push(makeRow());
  return table(
    ids,
    Array.from({ length: width }, (): ColumnAlign => 'none'),
    rows,
  );
}

/** Build a visual block. */
export function visualBlock(
  ids: IdFactory,
  blockType: string,
  options: {
    header?: string;
    data?: string | null;
    infoAttributes?: readonly InfoAttribute[];
    fence?: FenceStyle;
  } = {},
): VisualBlock {
  return {
    kind: 'visual',
    id: ids(),
    blockType: blockType.toLowerCase(),
    infoAttributes: options.infoAttributes ?? [],
    header: options.header ?? '',
    data: options.data ?? null,
    fence: options.fence ?? { style: 'backtick', length: 3 },
  };
}

/** Build a raw passthrough block. */
export function rawBlock(ids: IdFactory, text: string): RawBlock {
  return { kind: 'raw', id: ids(), text };
}

/** Build a document. */
export function document(
  ids: IdFactory,
  blocks: readonly Block[] = [],
  frontMatter: FrontMatter | null = null,
): MdvDocument {
  return { kind: 'document', id: ids(), frontMatter, blocks };
}

/**
 * Return a document guaranteed to have at least one editable block.
 *
 * `read('')` legitimately yields zero blocks — an empty file is empty — but an
 * editing surface always needs somewhere to put the caret. The trailing empty
 * paragraph is not serialised, so this does not change the file on disk.
 */
export function withMinimumContent(doc: MdvDocument, ids: IdFactory): MdvDocument {
  if (doc.blocks.length > 0) return doc;
  return { ...doc, blocks: [paragraph(ids)] };
}

/** Type-only re-export so callers need one import for construction. */
export type { NodeId };

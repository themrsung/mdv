/**
 * `text/html` → blocks.
 *
 * This is the ugly part of any editor, because clipboard HTML is not written
 * for you. Word emits `<p class=MsoListParagraph style='mso-list:l0 level1'>`
 * with the bullet glyph baked in as text. Google Docs wraps the entire payload
 * in `<b style="font-weight:normal">` — a bold tag that means "not bold" — and
 * puts every character inside a `<span>` carrying eleven CSS declarations.
 * Everyone emits `&nbsp;` where they meant a space, unclosed `<p>`, and tables
 * with `colspan`.
 *
 * The rules applied here, in order of how much grief they save:
 *
 * 1. **Computed style beats tag name.** `<b style="font-weight:normal">` is not
 *    bold and `<span style="font-weight:700">` is. Getting this backwards is
 *    why pasting from Google Docs bolds an entire document.
 * 2. **Word list paragraphs are reassembled into real lists** by reading their
 *    `mso-list` level and their marker glyph, and the literal marker text is
 *    discarded.
 * 3. **Whitespace is collapsed like a browser would**, `<pre>` excepted, and
 *    `&nbsp;` becomes an ordinary space.
 * 4. **Tables are made rectangular on the way in.** `colspan` and `rowspan` are
 *    expanded into real cells, because the model is merge-free by design.
 * 5. **Nothing is trusted.** `javascript:` and `data:text/html` URLs are dropped.
 */

import { textRun, rawRun, normalizeRuns, runsText } from '../inline.js';
import type { IdFactory } from '../ids.js';
import type {
  Block,
  ColumnAlign,
  ListItem,
  Mark,
  Run,
  TableCell,
  TableRow,
} from '../model.js';
import {
  blockquote,
  bulletList,
  codeBlock,
  heading,
  image,
  listItem,
  orderedList,
  paragraph,
  rawBlock,
  table as tableBlock,
  tableCell,
  tableRow,
  thematicBreak,
} from '../builders.js';
import type { HeadingLevel } from '../model.js';
import type { HtmlElement, HtmlNode } from './html.js';
import { classList, nodesText, parseHtml, parseStyle, textContent } from './html.js';

/** Elements that contribute nothing and whose contents are noise. */
const DROPPED = new Set(['style', 'script', 'head', 'meta', 'link', 'title', 'noscript', 'o:p', 'v:shapetype', 'v:shape', 'w:sdt', 'colgroup', 'col', 'caption']);

/** Elements that are pure containers: unwrap them and keep going. */
const TRANSPARENT = new Set([
  'html', 'body', 'div', 'section', 'article', 'main', 'header', 'footer',
  'nav', 'aside', 'figure', 'form', 'fieldset', 'center', 'address', 'dl',
  'details', 'summary', 'template', 'font-face', 'picture',
]);

/** Elements that only carry inline marks. */
const INLINE = new Set([
  'a', 'b', 'strong', 'i', 'em', 'u', 's', 'del', 'strike', 'ins', 'code',
  'tt', 'kbd', 'samp', 'var', 'dfn', 'cite', 'q', 'abbr', 'span', 'font',
  'mark', 'small', 'big', 'sub', 'sup', 'label', 'time', 'bdi', 'bdo', 'ruby',
  'rt', 'rp', 'wbr', 'nobr', 'acronym', 'data', 'output',
]);

/** Font families that mean "this is code". */
const MONOSPACE = /\b(monospace|courier|consolas|menlo|monaco|inconsolata|source code|roboto mono|ui-monospace|sf mono)\b/i;

/** Parse a `text/html` clipboard payload into blocks. */
export function blocksFromHtml(html: string, ids: IdFactory): readonly Block[] {
  const nodes = unwrapFragment(parseHtml(html));
  const sink = createSink();
  convertNodes(nodes, [], sink, ids);
  flush(sink, ids);
  return sink.blocks;
}

/**
 * Trim a payload down to the interesting part.
 *
 * Word and Chrome bracket the copied region with `<!--StartFragment-->`, which
 * the parser has already dropped as a comment, so what is left is to walk past
 * the `<html>`/`<body>` shell and Google Docs' `<b id="docs-internal-guid-…">`
 * wrapper. Descending through single-child containers also removes the
 * pointless `<div><div><div>` nesting that most web pages contribute.
 */
function unwrapFragment(nodes: readonly HtmlNode[]): readonly HtmlNode[] {
  let current = nodes;
  for (;;) {
    const meaningful = current.filter((node) => !isBlank(node));
    if (meaningful.length !== 1) return current;
    const only = meaningful[0];
    if (!only || only.kind !== 'element') return current;
    if (only.name === 'html' || only.name === 'body' || (only.name === 'b' && only.attrs['id']?.startsWith('docs-internal-guid'))) {
      current = only.children;
      continue;
    }
    return current;
  }
}

function isBlank(node: HtmlNode): boolean {
  return node.kind === 'text' && node.text.trim() === '';
}

/* -------------------------------------------------------------------------- */
/* The sink: blocks completed so far plus the inline run being built.          */
/* -------------------------------------------------------------------------- */

interface Sink {
  readonly blocks: Block[];
  runs: Run[];
  /** Set when a `<input type=checkbox>` was seen; consumed by list items. */
  checkbox: boolean | null;
}

function createSink(): Sink {
  return { blocks: [], runs: [], checkbox: null };
}

/** Finish the paragraph under construction, if it has any content. */
function flush(sink: Sink, ids: IdFactory): void {
  const runs = trimRuns(sink.runs);
  sink.runs = [];
  if (runs.length === 0) return;
  sink.blocks.push(paragraph(ids, normalizeRuns(runs)));
}

function trimRuns(runs: readonly Run[]): readonly Run[] {
  const out = [...runs];
  while (out.length > 0) {
    const first = out[0];
    if (first?.kind !== 'text') break;
    const text = first.text.replace(/^[ \t]+/, '');
    if (text === '') out.shift();
    else {
      out[0] = { ...first, text };
      break;
    }
  }
  while (out.length > 0) {
    const last = out[out.length - 1];
    if (last?.kind !== 'text') break;
    const text = last.text.replace(/[ \t]+$/, '');
    if (text === '') out.pop();
    else {
      out[out.length - 1] = { ...last, text };
      break;
    }
  }
  return out;
}

function lastChar(sink: Sink): string {
  for (let i = sink.runs.length - 1; i >= 0; i -= 1) {
    const run = sink.runs[i];
    const text = run === undefined ? '' : run.kind === 'text' ? run.text : run.text;
    if (text !== '') return text[text.length - 1] ?? '';
  }
  return '';
}

/**
 * Append character data, collapsing whitespace the way a browser would.
 *
 * A space that would follow another space, or open a paragraph, is dropped —
 * which is the single most effective thing you can do to clipboard HTML, given
 * how much of it is indentation between tags.
 */
function appendText(sink: Sink, text: string, marks: readonly Mark[], ids: IdFactory): void {
  let collapsed = text.replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[ \t\r\n\f\v]+/g, ' ');
  if (collapsed === '') return;
  const previous = lastChar(sink);
  if (previous === '' || previous === ' ') collapsed = collapsed.replace(/^ +/, '');
  if (collapsed === '') return;
  sink.runs.push(textRun(ids(), collapsed, marks));
}

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

function withoutType(marks: readonly Mark[], type: Mark['type']): readonly Mark[] {
  return marks.filter((mark) => mark.type !== type);
}

function addMark(marks: readonly Mark[], mark: Mark): readonly Mark[] {
  return marks.some((existing) => existing.type === mark.type) ? marks : [...marks, mark];
}

/**
 * The marks in force inside an element.
 *
 * Explicit CSS always wins over the tag name, in both directions: a `<b>` that
 * declares `font-weight: normal` is not bold, and a `<span>` that declares
 * `font-weight: 700` is. This one rule is what makes Google Docs paste cleanly.
 */
function marksFor(element: HtmlElement, inherited: readonly Mark[]): readonly Mark[] {
  let marks = inherited;
  const style = parseStyle(element.attrs['style']);
  const name = element.name;

  if (name === 'b' || name === 'strong') marks = addMark(marks, { type: 'strong' });
  if (name === 'i' || name === 'em' || name === 'cite' || name === 'dfn' || name === 'var') {
    marks = addMark(marks, { type: 'emphasis' });
  }
  if (name === 's' || name === 'del' || name === 'strike') marks = addMark(marks, { type: 'strikethrough' });
  if (name === 'code' || name === 'tt' || name === 'kbd' || name === 'samp') marks = addMark(marks, { type: 'code' });

  const weight = style['font-weight'];
  if (weight !== undefined) {
    marks = isBoldWeight(weight) ? addMark(marks, { type: 'strong' }) : withoutType(marks, 'strong');
  }

  const fontStyle = style['font-style'];
  if (fontStyle !== undefined) {
    marks = /italic|oblique/i.test(fontStyle)
      ? addMark(marks, { type: 'emphasis' })
      : withoutType(marks, 'emphasis');
  }

  const decoration = style['text-decoration'] ?? style['text-decoration-line'];
  if (decoration !== undefined && /line-through/i.test(decoration)) {
    marks = addMark(marks, { type: 'strikethrough' });
  }

  const family = style['font-family'];
  if (family !== undefined && MONOSPACE.test(family)) marks = addMark(marks, { type: 'code' });

  if (name === 'a') {
    const href = safeUrl(element.attrs['href']);
    if (href !== undefined) {
      const title = element.attrs['title'];
      marks = addMark(marks, { type: 'link', href, title: title !== undefined && title !== '' ? title : null });
    }
  }

  return marks;
}

function isBoldWeight(value: string): boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'bold' || trimmed === 'bolder') return true;
  if (trimmed === 'normal' || trimmed === 'lighter') return false;
  const numeric = Number.parseInt(trimmed, 10);
  return Number.isFinite(numeric) && numeric >= 600;
}

/**
 * Accept only URLs that cannot execute.
 *
 * Pasted HTML is untrusted input. `javascript:` is the obvious hazard;
 * `data:text/html` is the one people forget, since it navigates to attacker
 * markup in the document's own origin.
 */
export function safeUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const url = raw.trim();
  if (url === '') return undefined;
  // Strip control characters that hide a scheme from a naive prefix check.
  const probe = url.replace(/[\u0000-\u0020]/g, '').toLowerCase();
  if (probe.startsWith('javascript:') || probe.startsWith('vbscript:')) return undefined;
  if (probe.startsWith('data:') && !probe.startsWith('data:image/')) return undefined;
  return url;
}

/* -------------------------------------------------------------------------- */
/* The walk                                                                    */
/* -------------------------------------------------------------------------- */

function convertNodes(nodes: readonly HtmlNode[], marks: readonly Mark[], sink: Sink, ids: IdFactory): void {
  const grouped = groupWordLists(nodes);
  for (let index = 0; index < grouped.length; index += 1) {
    const node = grouped[index];
    if (node) convertNode(node, marks, sink, ids);
  }
}

function convertNode(node: HtmlNode, marks: readonly Mark[], sink: Sink, ids: IdFactory): void {
  if (node.kind === 'text') {
    appendText(sink, node.text, marks, ids);
    return;
  }

  const name = node.name;
  if (DROPPED.has(name) || isWordMarker(node)) return;

  if (name === 'br') {
    // A line break has no model equivalent inside a paragraph, so it ends one.
    // Splitting is lossless in the sense that matters: no character disappears.
    flush(sink, ids);
    return;
  }

  if (name === 'img') {
    const src = safeUrl(node.attrs['src']);
    if (src === undefined) return;
    const alt = node.attrs['alt'] ?? '';
    if (sink.runs.length === 0) {
      flush(sink, ids);
      sink.blocks.push(imageFrom(node, src, alt, ids));
    } else {
      sink.runs.push(rawRun(ids(), `![${alt}](${src})`, alt));
    }
    return;
  }

  if (name === 'input') {
    if ((node.attrs['type'] ?? '').toLowerCase() === 'checkbox') {
      sink.checkbox = 'checked' in node.attrs;
    }
    return;
  }

  if (name === 'hr') {
    flush(sink, ids);
    sink.blocks.push(thematicBreak(ids));
    return;
  }

  if (INLINE.has(name)) {
    convertNodes(node.children, marksFor(node, marks), sink, ids);
    return;
  }

  if (TRANSPARENT.has(name)) {
    convertNodes(node.children, marks, sink, ids);
    return;
  }

  if (name === 'p' || name === 'dt' || name === 'dd' || name === 'figcaption' || name === 'blockquote' ||
      name === 'pre' || name === 'ul' || name === 'ol' || name === 'menu' || name === 'table' ||
      /^h[1-6]$/.test(name) || name === 'li') {
    flush(sink, ids);
    for (const block of convertBlock(node, marks, ids)) sink.blocks.push(block);
    return;
  }

  // Unknown element: treat as transparent rather than dropping its text.
  convertNodes(node.children, marks, sink, ids);
}

function convertBlock(element: HtmlElement, marks: readonly Mark[], ids: IdFactory): readonly Block[] {
  const name = element.name;

  if (name === 'pre') return [preBlock(element, ids)];
  if (name === 'ul' || name === 'ol' || name === 'menu') {
    const list = convertList(element, marks, ids);
    return list ? [list] : [];
  }
  if (name === 'table') {
    const built = convertTable(element, marks, ids);
    return built ? [built] : [];
  }

  const inner = createSink();
  convertNodes(element.children, marks, inner, ids);

  const headingMatch = /^h([1-6])$/.exec(name);
  if (headingMatch) {
    const level = Number.parseInt(headingMatch[1] ?? '1', 10) as HeadingLevel;
    const runs = trimRuns(inner.runs);
    inner.runs = [];
    const out: Block[] = [];
    if (runs.length > 0) out.push(heading(ids, level, normalizeRuns(runs)));
    out.push(...inner.blocks);
    return out;
  }

  flush(inner, ids);

  if (name === 'blockquote') {
    if (inner.blocks.length === 0) return [];
    return [blockquote(ids, inner.blocks)];
  }

  return inner.blocks;
}

function imageFrom(element: HtmlElement, src: string, alt: string, ids: IdFactory): Block {
  const title = element.attrs['title'];
  const width = dimension(element, 'width');
  const height = dimension(element, 'height');
  return image(ids, src, {
    alt,
    title: title !== undefined && title !== '' ? title : null,
    ...(width === null ? {} : { width }),
    ...(height === null ? {} : { height }),
  });
}

function dimension(element: HtmlElement, key: 'width' | 'height'): number | null {
  const raw = element.attrs[key] ?? parseStyle(element.attrs['style'])[key];
  if (raw === undefined) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
}

/**
 * `<pre>` becomes a code block with its whitespace intact.
 *
 * The language comes from the `language-x`/`lang-x` class that every syntax
 * highlighter in existence puts on the inner `<code>`.
 *
 * `data-mdv-source` is our own escape hatch: it carries the exact `.mdv` source
 * of a visual or raw block, so copying out of the editor and pasting back in
 * survives even when the receiving app kept only the HTML flavour. It becomes a
 * raw block, which writes back byte-for-byte and re-reads as the real thing.
 */
function preBlock(element: HtmlElement, ids: IdFactory): Block {
  const source = element.attrs['data-mdv-source'];
  if (source !== undefined && source !== '') return rawBlock(ids, source.replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
  if (element.attrs['data-mdv-raw'] !== undefined) {
    return rawBlock(ids, textContent(element).replace(/\r\n?/g, '\n').replace(/\n+$/, ''));
  }

  const code = findChild(element, 'code');
  const info = code ? languageOf(code) : languageOf(element);
  let text = textContent(code ?? element).replace(/\r\n?/g, '\n');
  if (text.startsWith('\n')) text = text.slice(1);
  text = text.replace(/\n+$/, '');
  return codeBlock(ids, text, info);
}

function languageOf(element: HtmlElement): string {
  for (const token of classList(element)) {
    const match = /^(?:language|lang|highlight-source|brush:)[-\s]?([\w+#.-]+)$/.exec(token);
    if (match?.[1] !== undefined) return match[1];
  }
  const attribute = element.attrs['data-lang'] ?? element.attrs['data-language'];
  return attribute ?? '';
}

function findChild(element: HtmlElement, name: string): HtmlElement | undefined {
  for (const child of element.children) {
    if (child.kind === 'element' && child.name === name) return child;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Lists                                                                       */
/* -------------------------------------------------------------------------- */

function convertList(element: HtmlElement, marks: readonly Mark[], ids: IdFactory): Block | undefined {
  const items: ListItem[] = [];
  let tight = true;

  for (const child of element.children) {
    if (child.kind !== 'element') continue;
    if (child.name === 'ul' || child.name === 'ol') {
      // A list directly inside a list, with no `<li>`: attach it to the previous
      // item if there is one, otherwise treat it as a sibling list's contents.
      const nested = convertList(child, marks, ids);
      if (!nested) continue;
      const previous = items.pop();
      items.push(
        previous
          ? { ...previous, blocks: [...previous.blocks, nested] }
          : listItem(ids, [nested]),
      );
      continue;
    }
    if (child.name !== 'li') continue;

    const inner = createSink();
    convertNodes(child.children, marks, inner, ids);
    flush(inner, ids);

    const blocks = inner.blocks.length > 0 ? inner.blocks : [paragraph(ids)];
    if (blocks.filter((block) => block.kind === 'paragraph').length > 1) tight = false;

    const checked = inner.checkbox ?? taskState(child);
    items.push(listItem(ids, blocks, checked));
  }

  if (items.length === 0) return undefined;

  if (element.name === 'ol') {
    const start = Number.parseInt(element.attrs['start'] ?? '1', 10);
    return orderedList(ids, items, { start: Number.isFinite(start) && start >= 0 ? start : 1, tight });
  }
  return bulletList(ids, items, { tight });
}

function taskState(item: HtmlElement): boolean | null {
  return classList(item).includes('task-list-item') ? false : null;
}

/* -------------------------------------------------------------------------- */
/* Word lists                                                                  */
/* -------------------------------------------------------------------------- */

interface WordItem {
  readonly level: number;
  readonly ordered: boolean;
  readonly element: HtmlElement;
}

/** True when this element is Word's literal bullet/number glyph. */
function isWordMarker(node: HtmlNode): boolean {
  if (node.kind !== 'element') return false;
  const style = parseStyle(node.attrs['style']);
  const value = style['mso-list'];
  return value !== undefined && value.trim().toLowerCase().startsWith('ignore');
}

/**
 * Recognise a Word list paragraph.
 *
 * Word does not emit `<ul>`. It emits a flat run of paragraphs carrying
 * `style='mso-list:l0 level2 lfo1'`, with the bullet or number as literal text
 * inside a marker span. Reading the level back out is the only way to recover
 * the nesting the user actually saw.
 */
function wordItem(node: HtmlNode): WordItem | undefined {
  if (node.kind !== 'element' || node.name !== 'p') return undefined;
  const style = parseStyle(node.attrs['style']);
  const listStyle = style['mso-list'];
  const isListParagraph = classList(node).some((token) => /^MsoList/i.test(token));
  if (listStyle === undefined && !isListParagraph) return undefined;

  const levelMatch = /level(\d+)/i.exec(listStyle ?? '');
  const level = levelMatch ? Math.max(1, Number.parseInt(levelMatch[1] ?? '1', 10)) : 1;

  const marker = findWordMarker(node);
  const ordered = marker !== undefined && /^\s*(?:\d+|[a-zA-Z]|[ivxIVX]+)\s*[.)\]]/.test(marker);
  return { level, ordered, element: node };
}

function findWordMarker(node: HtmlNode): string | undefined {
  if (node.kind !== 'element') return undefined;
  if (isWordMarker(node)) return textContent(node);
  for (const child of node.children) {
    const found = findWordMarker(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Replace runs of Word list paragraphs with synthesised `<ul>`/`<ol>` trees.
 *
 * Operates on one sibling list at a time and leaves everything else untouched,
 * so a document that Word did not produce passes through unchanged.
 */
function groupWordLists(nodes: readonly HtmlNode[]): readonly HtmlNode[] {
  let hasWordList = false;
  for (const node of nodes) {
    if (wordItem(node)) {
      hasWordList = true;
      break;
    }
  }
  if (!hasWordList) return nodes;

  const out: HtmlNode[] = [];
  let run: WordItem[] = [];

  const emit = (): void => {
    if (run.length === 0) return;
    out.push(buildWordList(run, 0, run.length, 1));
    run = [];
  };

  for (const node of nodes) {
    const item = wordItem(node);
    if (item) {
      run.push(item);
      continue;
    }
    if (isBlank(node)) continue;
    emit();
    out.push(node);
  }
  emit();
  return out;
}

/** Build one list level from `items[from, to)`, recursing for deeper levels. */
function buildWordList(items: readonly WordItem[], from: number, to: number, level: number): HtmlElement {
  const children: HtmlNode[] = [];
  let ordered = false;
  let index = from;

  while (index < to) {
    const item = items[index];
    if (!item) break;
    if (item.level > level) {
      // Deeper items belong to the item we just emitted.
      let end = index;
      while (end < to && (items[end]?.level ?? 0) > level) end += 1;
      const nested = buildWordList(items, index, end, level + 1);
      const previous = children.pop();
      if (previous && previous.kind === 'element') {
        children.push({ ...previous, children: [...previous.children, nested] });
      } else {
        children.push({ kind: 'element', name: 'li', attrs: {}, children: [nested] });
      }
      index = end;
      continue;
    }
    ordered = ordered || item.ordered;
    children.push({ kind: 'element', name: 'li', attrs: {}, children: item.element.children });
    index += 1;
  }

  return { kind: 'element', name: ordered ? 'ol' : 'ul', attrs: {}, children };
}

/* -------------------------------------------------------------------------- */
/* Tables                                                                      */
/* -------------------------------------------------------------------------- */

interface RawCell {
  readonly element: HtmlElement;
  readonly colspan: number;
  readonly rowspan: number;
}

/**
 * Convert a `<table>`, expanding spans so the result is rectangular.
 *
 * The model has no merged cells on purpose — a merge-free grid is what makes
 * every column and row operation total. A `colspan=3` therefore becomes the
 * content followed by two empty cells, which is what a spreadsheet does when
 * you unmerge. Row 0 is the header: if the source marks one with `<thead>` or a
 * row of `<th>`, that row is moved to the top, otherwise the first row is used
 * as-is. No row is ever invented and no content is ever dropped.
 */
function convertTable(element: HtmlElement, marks: readonly Mark[], ids: IdFactory): Block | undefined {
  const rows: RawCell[][] = [];
  let headerIndex = -1;

  const visitRow = (rowElement: HtmlElement, inHead: boolean): void => {
    const cells: RawCell[] = [];
    for (const child of rowElement.children) {
      if (child.kind !== 'element') continue;
      if (child.name !== 'td' && child.name !== 'th') continue;
      cells.push({
        element: child,
        colspan: span(child.attrs['colspan']),
        rowspan: span(child.attrs['rowspan']),
      });
    }
    if (cells.length === 0) return;
    const allHeader = cells.every((cell) => cell.element.name === 'th');
    if (headerIndex < 0 && (inHead || allHeader)) headerIndex = rows.length;
    rows.push(cells);
  };

  const visit = (node: HtmlNode, inHead: boolean): void => {
    if (node.kind !== 'element') return;
    if (node.name === 'tr') {
      visitRow(node, inHead);
      return;
    }
    const head = inHead || node.name === 'thead';
    for (const child of node.children) visit(child, head);
  };

  for (const child of element.children) visit(child, false);
  if (rows.length === 0) return undefined;

  // Expand spans into a sparse grid keyed by "row,col".
  const grid = new Map<string, TableCell>();
  let width = 0;
  let height = 0;

  rows.forEach((cells, rowIndex) => {
    let column = 0;
    for (const cell of cells) {
      while (grid.has(`${rowIndex},${column}`)) column += 1;
      const runs = cellRuns(cell.element, marks, ids);
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        for (let dc = 0; dc < cell.colspan; dc += 1) {
          const key = `${rowIndex + dr},${column + dc}`;
          if (grid.has(key)) continue;
          grid.set(key, dr === 0 && dc === 0 ? tableCell(ids, runs) : tableCell(ids));
          width = Math.max(width, column + dc + 1);
          height = Math.max(height, rowIndex + dr + 1);
        }
      }
      column += cell.colspan;
    }
  });

  if (width === 0 || height === 0) return undefined;

  const order = [...Array(height).keys()];
  if (headerIndex > 0 && headerIndex < height) {
    order.splice(headerIndex, 1);
    order.unshift(headerIndex);
  }

  const built: TableRow[] = order.map((rowIndex) => {
    const cells: TableCell[] = [];
    for (let column = 0; column < width; column += 1) {
      cells.push(grid.get(`${rowIndex},${column}`) ?? tableCell(ids));
    }
    return tableRow(ids, cells);
  });

  const align = alignmentsOf(rows[Math.max(0, headerIndex)] ?? rows[0] ?? [], width);
  return tableBlock(ids, align, built);
}

function span(raw: string | undefined): number {
  const value = Number.parseInt(raw ?? '1', 10);
  if (!Number.isFinite(value) || value < 1) return 1;
  // A hostile or broken `colspan=1000` would otherwise allocate a huge grid.
  return Math.min(value, 64);
}

function alignmentsOf(cells: readonly RawCell[], width: number): readonly ColumnAlign[] {
  const out: ColumnAlign[] = [];
  let column = 0;
  for (const cell of cells) {
    const value = (cell.element.attrs['align'] ?? parseStyle(cell.element.attrs['style'])['text-align'] ?? '')
      .trim()
      .toLowerCase();
    const align: ColumnAlign = value === 'left' || value === 'center' || value === 'right' ? value : 'none';
    for (let i = 0; i < cell.colspan && column < width; i += 1) {
      out.push(align);
      column += 1;
    }
  }
  while (out.length < width) out.push('none');
  return out.slice(0, width);
}

/**
 * Flatten a cell's content to inline runs.
 *
 * A model cell holds runs, not blocks, so a cell containing two paragraphs is
 * joined with a space. Nested tables and lists inside cells lose their
 * structure here; keeping their text is the honest trade.
 */
function cellRuns(element: HtmlElement, marks: readonly Mark[], ids: IdFactory): readonly Run[] {
  const inner = createSink();
  convertNodes(element.children, marks, inner, ids);
  flush(inner, ids);

  const out: Run[] = [];
  for (const block of inner.blocks) {
    const runs = runsOfBlock(block);
    if (runs.length === 0) continue;
    if (out.length > 0) out.push(textRun(ids(), ' '));
    out.push(...runs);
  }
  return normalizeRuns(trimRuns(out));
}

function runsOfBlock(block: Block): readonly Run[] {
  switch (block.kind) {
    case 'paragraph':
    case 'heading':
      return block.runs;
    case 'code':
      return block.text === '' ? [] : [textRun(`${block.id}:flat`, block.text, [{ type: 'code' }])];
    case 'blockquote':
      return block.children.flatMap(runsOfBlock);
    case 'list':
      return block.items.flatMap((item) => item.blocks.flatMap(runsOfBlock));
    case 'image':
      return [rawRun(`${block.id}:flat`, `![${block.alt}](${block.src})`, block.alt)];
    case 'table':
      return block.rows.flatMap((row) => row.cells.flatMap((cell) => cell.runs));
    case 'raw':
      return block.text === '' ? [] : [textRun(`${block.id}:flat`, block.text)];
    case 'thematicBreak':
      return [];
    case 'visual':
      return block.header === '' ? [] : [textRun(`${block.id}:flat`, block.header)];
    default:
      return [];
  }
}

/** Plain text of an HTML payload, used when no better representation exists. */
export function textFromHtml(html: string): string {
  return nodesText(parseHtml(html)).replace(/\u00a0/g, ' ');
}

/** True when `runs` carry nothing a reader would notice. */
export function runsAreBlank(runs: readonly Run[]): boolean {
  return runsText(runs).trim() === '';
}

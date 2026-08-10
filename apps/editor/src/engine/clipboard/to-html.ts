/**
 * Blocks → `text/html`.
 *
 * This is the flavour that lands in Gmail, Slack, Word and every other app that
 * has never heard of `.mdv`. It is deliberately plain: semantic tags, no
 * classes, no inline CSS, no wrapper `<div>`. Receiving applications restyle
 * everything anyway, and the ones that do not are better served by markup they
 * can read.
 *
 * Two pieces of metadata do go out, on the outer element only:
 * `data-mdv-fragment` marks the payload as ours, and visual blocks carry their
 * source in a `data-mdv-source` attribute so a copy out of the editor and back
 * in survives even when the richer `.mdv` flavour has been stripped.
 */

import type { Block, Run, TableBlock } from '../model.js';
import { writeBlocks, visualInfoString } from '../io/write.js';
import { escapeHtml } from './html.js';

/** Options for {@link blocksToHtml}. */
export interface HtmlWriteOptions {
  /**
   * Wrap the output in `<div data-mdv-fragment="1">…</div>`.
   * Default true; turn it off when embedding the result in a larger document.
   */
  readonly wrap?: boolean;
}

/** Render blocks as standalone HTML. */
export function blocksToHtml(blocks: readonly Block[], options: HtmlWriteOptions = {}): string {
  const body = blocks.map((block) => blockToHtml(block)).filter((html) => html !== '').join('\n');
  if (options.wrap === false) return body;
  return `<div data-mdv-fragment="1">\n${body}\n</div>`;
}

function blockToHtml(block: Block): string {
  switch (block.kind) {
    case 'paragraph':
      return `<p>${inlineToHtml(block.runs)}</p>`;

    case 'heading':
      return `<h${block.level}>${inlineToHtml(block.runs)}</h${block.level}>`;

    case 'blockquote':
      return `<blockquote>\n${block.children.map(blockToHtml).join('\n')}\n</blockquote>`;

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul';
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : '';
      const items = block.items
        .map((item) => {
          const inner = item.blocks.map(blockToHtml).join('\n');
          if (item.checked === null) return `<li>${inner}</li>`;
          const checked = item.checked ? ' checked' : '';
          return `<li class="task-list-item"><input type="checkbox" disabled${checked}>${inner}</li>`;
        })
        .join('\n');
      return `<${tag}${start}>\n${items}\n</${tag}>`;
    }

    case 'code': {
      const language = block.info.split(/\s+/)[0] ?? '';
      const classAttr = language === '' ? '' : ` class="language-${escapeHtml(language)}"`;
      return `<pre><code${classAttr}>${escapeHtml(block.text)}</code></pre>`;
    }

    case 'thematicBreak':
      return '<hr>';

    case 'image': {
      const attrs = [
        `src="${escapeHtml(block.src)}"`,
        `alt="${escapeHtml(block.alt)}"`,
        block.title === null ? '' : `title="${escapeHtml(block.title)}"`,
        block.width === null ? '' : `width="${block.width}"`,
        block.height === null ? '' : `height="${block.height}"`,
      ].filter((attr) => attr !== '');
      return `<p><img ${attrs.join(' ')}></p>`;
    }

    case 'table':
      return tableToHtml(block);

    case 'visual': {
      // Other applications cannot render a visual block, so they get its source
      // in a code block; we get it back losslessly from `data-mdv-source`.
      const source = writeBlocks([block]);
      const info = visualInfoString(block);
      return (
        `<pre data-mdv-type="${escapeHtml(block.blockType)}" data-mdv-info="${escapeHtml(info)}" ` +
        `data-mdv-source="${escapeHtml(source)}"><code>${escapeHtml(source)}</code></pre>`
      );
    }

    case 'raw':
      return `<pre data-mdv-raw="1"><code>${escapeHtml(block.text)}</code></pre>`;

    default:
      return '';
  }
}

function tableToHtml(table: TableBlock): string {
  const [header, ...body] = table.rows;
  const cellHtml = (runs: readonly Run[], tag: 'td' | 'th', column: number): string => {
    const align = table.align[column] ?? 'none';
    const style = align === 'none' ? '' : ` style="text-align:${align}"`;
    return `<${tag}${style}>${inlineToHtml(runs)}</${tag}>`;
  };

  const head =
    header === undefined
      ? ''
      : `<thead>\n<tr>${header.cells.map((cell, index) => cellHtml(cell.runs, 'th', index)).join('')}</tr>\n</thead>\n`;
  const rows = body
    .map((row) => `<tr>${row.cells.map((cell, index) => cellHtml(cell.runs, 'td', index)).join('')}</tr>`)
    .join('\n');
  const bodyHtml = body.length === 0 ? '' : `<tbody>\n${rows}\n</tbody>\n`;
  return `<table>\n${head}${bodyHtml}</table>`;
}

/**
 * Render inline runs.
 *
 * Marks nest outside-in as link → strong → emphasis → strikethrough → code, so
 * that code is innermost and its content is never wrapped in formatting tags
 * that a receiving editor would try to apply inside a `<code>` element.
 */
export function inlineToHtml(runs: readonly Run[]): string {
  let out = '';
  for (const run of runs) {
    if (run.kind === 'raw') {
      out += rawRunToHtml(run.source, run.text);
      continue;
    }
    let html = escapeHtml(run.text);
    if (run.marks.some((mark) => mark.type === 'code')) html = `<code>${html}</code>`;
    if (run.marks.some((mark) => mark.type === 'strikethrough')) html = `<del>${html}</del>`;
    if (run.marks.some((mark) => mark.type === 'emphasis')) html = `<em>${html}</em>`;
    if (run.marks.some((mark) => mark.type === 'strong')) html = `<strong>${html}</strong>`;
    const link = run.marks.find((mark) => mark.type === 'link');
    if (link && link.type === 'link') {
      const title = link.title === null ? '' : ` title="${escapeHtml(link.title)}"`;
      html = `<a href="${escapeHtml(link.href)}"${title}>${html}</a>`;
    }
    out += html;
  }
  return out;
}

/**
 * A raw inline run is verbatim markdown the model chose not to interpret.
 *
 * Inline images are the common case and are worth rendering properly; anything
 * else goes out as its visible text, which is what the run's `text` already is.
 */
function rawRunToHtml(source: string, text: string): string {
  const match = /^!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)$/.exec(source);
  if (match) {
    const alt = match[1] ?? '';
    const src = match[2] ?? '';
    const title = match[3];
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}"${title === undefined ? '' : ` title="${escapeHtml(title)}"`}>`;
  }
  return escapeHtml(text);
}

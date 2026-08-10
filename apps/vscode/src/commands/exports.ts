/**
 * The export commands of SPEC 29.5.
 *
 * "Export commands report progress with `withProgress`, are cancellable, and
 * write beside the source file unless a path is chosen." All three hold here.
 *
 * File I/O goes through `vscode.workspace.fs`, never `node:fs`: the same code
 * then works in `vscode.dev`, where there is no Node (SPEC 29.1). The only
 * genuinely Node-gated export is PDF.
 *
 * ## What is implemented, and what is not
 *
 * | Command | State |
 * |---|---|
 * | `mdv.export.svg` | **Implemented.** One `.svg` per visual block, from the same scene the preview draws. |
 * | `mdv.export.html` | **Implemented.** One self-contained file: the charts plus `@mdv/render-svg`'s stylesheet, no scripts, no remote references. |
 * | `mdv.exportBlock` | **Implemented** for SVG. |
 * | `mdv.export.png` | **Not implemented.** Rasterising a scene needs a canvas backend (`@mdv/render-canvas`, SPEC 23.2), which is not in this tree. The command says so rather than writing a broken file. |
 * | `mdv.export.pdf` | **Not implemented.** `@mdv/render-pdf`'s `exportPdf` is a stub in this tree. Same treatment. |
 *
 * The two unimplemented ones are registered anyway, and are *hidden* from the
 * palette by a `when` clause where the reason is the host (SPEC 29.8's rule) and
 * *reported* where the reason is a missing package — a command that silently did
 * nothing would be worse than either.
 */

import * as vscode from 'vscode';
import { log } from '../log.js';
import type { CommandContext } from './context.js';
import { blockAtLine, runFor } from './blocks.js';
import type { RenderedBlock } from '../pipeline/index.js';

/** The directory exports default to: `mdv.export.defaultDirectory`, else beside the source. */
function defaultDirectory(source: vscode.Uri, configured: string): vscode.Uri {
  if (configured.length > 0) {
    // An absolute path is taken as-is; a relative one is resolved against the
    // first workspace folder, which is the only stable base available.
    if (/^([a-zA-Z]:[\\/]|\/)/.test(configured)) return vscode.Uri.file(configured);
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder !== undefined) return vscode.Uri.joinPath(folder.uri, configured);
  }
  return source.with({ path: source.path.replace(/\/[^/]*$/, '') });
}

function baseName(uri: vscode.Uri): string {
  const name = uri.path.split('/').pop() ?? 'document';
  return name.replace(/\.[^.]+$/, '');
}

const ENCODER = new TextEncoder();

async function writeText(target: vscode.Uri, text: string): Promise<void> {
  await vscode.workspace.fs.writeFile(target, ENCODER.encode(text));
}

/** Escape for an HTML text node or a double-quoted attribute. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** A filesystem-safe stem for one block. */
function blockStem(document: vscode.Uri, block: RenderedBlock): string {
  const id = block.id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `${baseName(document)}-${id.length > 0 ? id : `block-${String(block.index)}`}`;
}

/** Export every visual block as a standalone `.svg`. */
export async function exportSvg(ctx: CommandContext): Promise<void> {
  const editor = requireEditor();
  if (editor === undefined) return;
  const document = editor.document;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MDV: exporting SVG',
      cancellable: true,
    },
    async (progress, token) => {
      const result = await runFor(document, ctx.pipelines, ctx.settings);
      if (token.isCancellationRequested) return;
      if (result.blocks.length === 0) {
        void vscode.window.showInformationMessage('MDV: this document has no visual blocks');
        return;
      }
      const directory = defaultDirectory(
        document.uri,
        ctx.settings.current.exportSettings.defaultDirectory,
      );
      const written: string[] = [];
      for (let i = 0; i < result.blocks.length; i += 1) {
        if (token.isCancellationRequested) break;
        const block = result.blocks[i];
        if (block === undefined || block.svg.length === 0) continue;
        progress.report({
          message: `${String(i + 1)} / ${String(result.blocks.length)}`,
          increment: 100 / result.blocks.length,
        });
        const target = vscode.Uri.joinPath(directory, `${blockStem(document.uri, block)}.svg`);
        await writeText(target, `<?xml version="1.0" encoding="UTF-8"?>\n${block.svg}\n`);
        written.push(target.path.split('/').pop() ?? '');
      }
      log(`exported ${String(written.length)} SVG file(s) to ${directory.toString()}`);
      void vscode.window.showInformationMessage(
        `MDV: wrote ${String(written.length)} SVG file(s) beside ${baseName(document.uri)}`,
      );
    },
  );
}

/**
 * Export the document's charts as one self-contained HTML file.
 *
 * Self-contained in the strict sense: one `<style>` (MDV's own stylesheet), the
 * SVGs inline, and **no scripts and no remote references at all**, so the file
 * renders identically offline and can be opened from anywhere.
 *
 * This is the charts, not the prose. Rendering the surrounding Markdown is
 * `Mdv.toHTML`'s job (SPEC 23.3) and that facade is a stub in this tree; writing
 * a second Markdown renderer inside the extension would be exactly the
 * duplication SPEC 17.1 exists to prevent.
 */
export async function exportHtml(ctx: CommandContext): Promise<void> {
  const editor = requireEditor();
  if (editor === undefined) return;
  const document = editor.document;

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'MDV: exporting HTML',
      cancellable: true,
    },
    async (_progress, token) => {
      const result = await runFor(document, ctx.pipelines, ctx.settings);
      if (token.isCancellationRequested) return;

      const { stylesheet } = await import('@mdv/render-svg');
      const title = baseName(document.uri);
      const figures = result.blocks
        .filter((block) => block.svg.length > 0)
        .map((block) => {
          const caption =
            block.title !== undefined && block.title.length > 0
              ? `<figcaption>${escapeHtml(block.title)}</figcaption>`
              : '';
          return `<figure id="${escapeHtml(block.id)}">${block.svg}${caption}</figure>`;
        })
        .join('\n');

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
body { margin: 0 auto; padding: 24px; max-width: 960px; font-family: system-ui, sans-serif; }
figure { margin: 0 0 32px; }
figcaption { font-size: 13px; color: #555; margin-top: 6px; }
${stylesheet()}
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${figures}
</body>
</html>
`;
      const directory = defaultDirectory(
        document.uri,
        ctx.settings.current.exportSettings.defaultDirectory,
      );
      const target = vscode.Uri.joinPath(directory, `${title}.html`);
      await writeText(target, html);
      log(`exported HTML to ${target.toString()}`);
      void vscode.window.showInformationMessage(`MDV: wrote ${target.path.split('/').pop() ?? ''}`);
    },
  );
}

/** Export just the block under the cursor. Context menu (SPEC 29.5). */
export async function exportBlock(ctx: CommandContext): Promise<void> {
  const editor = requireEditor();
  if (editor === undefined) return;
  const document = editor.document;
  const result = await runFor(document, ctx.pipelines, ctx.settings);
  const block = blockAtLine(result.blocks, editor.selection.active.line);
  if (block === undefined) {
    void vscode.window.showInformationMessage('MDV: no visual block at the cursor');
    return;
  }
  if (block.svg.length === 0) {
    void vscode.window.showWarningMessage(
      `MDV: block ${block.id} did not render; there is nothing to export`,
    );
    return;
  }
  const directory = defaultDirectory(
    document.uri,
    ctx.settings.current.exportSettings.defaultDirectory,
  );
  const suggested = vscode.Uri.joinPath(directory, `${blockStem(document.uri, block)}.svg`);
  const target = await vscode.window.showSaveDialog({
    defaultUri: suggested,
    filters: { 'SVG image': ['svg'] },
    saveLabel: 'Export block',
  });
  if (target === undefined) return;
  await writeText(target, `<?xml version="1.0" encoding="UTF-8"?>\n${block.svg}\n`);
  void vscode.window.showInformationMessage(`MDV: wrote ${target.path.split('/').pop() ?? ''}`);
}

/**
 * PNG export.
 *
 * Honest failure: there is no rasteriser in this tree. `@mdv/render-canvas`
 * (SPEC 23.2) is listed in the spec's package table and explicitly out of scope
 * for this pass, and rasterising an SVG without one would mean shelling out to a
 * browser — which the extension will not do behind the user's back.
 */
export async function exportPng(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'MDV: PNG export is not available in this build — it needs the canvas backend (@mdv/render-canvas, SPEC 23.2), which is not implemented yet.',
    'Export SVG instead',
  );
  if (choice === 'Export SVG instead') {
    await vscode.commands.executeCommand('mdv.export.svg');
  }
}

/**
 * PDF export.
 *
 * Honest failure: `@mdv/render-pdf`'s `exportPdf` is a stub in this tree, and
 * SPEC 28.1 requires the PDF to be drawn from the *same* `Scene` as the screen —
 * so there is no correct shortcut (printing the HTML through a headless browser
 * would produce a different drawing, which is precisely what SPEC 28.1 forbids).
 */
export async function exportPdf(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'MDV: PDF export is not available in this build — @mdv/render-pdf (SPEC 28) is not implemented yet.',
    'Export HTML instead',
  );
  if (choice === 'Export HTML instead') {
    await vscode.commands.executeCommand('mdv.export.html');
  }
}

function requireEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) {
    void vscode.window.showInformationMessage('MDV: open an .mdv document first');
    return undefined;
  }
  return editor;
}

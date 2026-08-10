/**
 * Command registration (SPEC 29.5).
 *
 * Every handler is wrapped in {@link safeCommand}: a command that throws logs to
 * the output channel and tells the user, and never becomes an unhandled
 * rejection in the extension host (SPEC 29.8).
 */

import * as vscode from 'vscode';
import { safeCommand } from '../log.js';
import type { CommandContext } from './context.js';
import { exportBlock, exportHtml, exportPdf, exportPng, exportSvg } from './exports.js';
import {
  DATA_SCHEME,
  ResolvedDataProvider,
  insertChart,
  pasteData,
  showData,
  tableToChart,
} from './authoring.js';
import { allowExternalForWorkspace, togglePreviewTheme, validateTheme } from './theme.js';

/** SPEC 29.5's command ids, in one place so the manifest and the code agree. */
export const COMMANDS = {
  showPreview: 'mdv.showPreview',
  showPreviewToSide: 'mdv.showPreviewToSide',
  exportPdf: 'mdv.export.pdf',
  exportHtml: 'mdv.export.html',
  exportSvg: 'mdv.export.svg',
  exportPng: 'mdv.export.png',
  exportBlock: 'mdv.exportBlock',
  insertChart: 'mdv.insertChart',
  tableToChart: 'mdv.tableToChart',
  pasteData: 'mdv.pasteData',
  showData: 'mdv.showData',
  validateTheme: 'mdv.validateTheme',
  togglePreviewTheme: 'mdv.togglePreviewTheme',
  allowExternal: 'mdv.allowExternalForWorkspace',
} as const;

/** The column a "to the side" preview opens in. */
function sideColumn(): vscode.ViewColumn {
  const active = vscode.window.activeTextEditor?.viewColumn;
  return active === undefined || active === vscode.ViewColumn.Three
    ? vscode.ViewColumn.Beside
    : active + 1;
}

function previewTarget(): vscode.Uri | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor !== undefined) return editor.document.uri;
  void vscode.window.showInformationMessage('MDV: open an .mdv document to preview it');
  return undefined;
}

/** Register every command. Returns one disposable covering all of them. */
export function registerCommands(ctx: CommandContext): vscode.Disposable {
  const dataProvider = new ResolvedDataProvider();
  const items: vscode.Disposable[] = [
    dataProvider,
    vscode.workspace.registerTextDocumentContentProvider(DATA_SCHEME, dataProvider),

    vscode.commands.registerCommand(
      COMMANDS.showPreview,
      safeCommand('Open Preview', () => {
        const uri = previewTarget();
        if (uri === undefined) return;
        ctx.previews.show(uri, vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One);
      }),
    ),
    vscode.commands.registerCommand(
      COMMANDS.showPreviewToSide,
      safeCommand('Open Preview to the Side', () => {
        const uri = previewTarget();
        if (uri === undefined) return;
        ctx.previews.show(uri, sideColumn());
      }),
    ),

    vscode.commands.registerCommand(
      COMMANDS.exportSvg,
      safeCommand('Export to SVG', () => exportSvg(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.exportHtml,
      safeCommand('Export to HTML', () => exportHtml(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.exportPng,
      safeCommand('Export to PNG', () => exportPng()),
    ),
    vscode.commands.registerCommand(
      COMMANDS.exportPdf,
      safeCommand('Export to PDF', () => exportPdf(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.exportBlock,
      safeCommand('Export Block as Image', () => exportBlock(ctx)),
    ),

    vscode.commands.registerCommand(
      COMMANDS.insertChart,
      safeCommand('Insert Chart', () => insertChart(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.tableToChart,
      safeCommand('Convert Table to Chart', () => tableToChart(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.pasteData,
      safeCommand('Paste as Dataset', () => pasteData(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.showData,
      safeCommand('Show Resolved Data', () => showData(ctx, dataProvider)),
    ),

    vscode.commands.registerCommand(
      COMMANDS.validateTheme,
      safeCommand('Validate Theme', () => validateTheme()),
    ),
    vscode.commands.registerCommand(
      COMMANDS.togglePreviewTheme,
      safeCommand('Toggle Dark Preview', () => togglePreviewTheme(ctx)),
    ),
    vscode.commands.registerCommand(
      COMMANDS.allowExternal,
      safeCommand('Allow External Data', () => allowExternalForWorkspace()),
    ),
  ];

  return vscode.Disposable.from(...items);
}

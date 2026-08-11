/**
 * SPEC 29.5's command ids, in one place so the manifest and the code agree.
 *
 * Their own file, free of `vscode`, because the language server has to name
 * three of them in a code lens and it runs where the module does not exist
 * (`lsp/settings.ts`). Importing `commands/index.ts` for a string would pull
 * the whole extension host into that bundle.
 */

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

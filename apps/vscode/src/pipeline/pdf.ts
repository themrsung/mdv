/**
 * PDF export, behind the pipeline seam (SPEC 28).
 *
 * `@mdv/render-pdf` is the *direct* exporter: it flows the resolved document and
 * draws every figure from the same `Scene` the preview draws, so the export
 * cannot disagree with the screen (SPEC 28.1). There is no headless browser
 * here, and there is no second layout path.
 *
 * ## Why this does not reuse `DocumentPipeline`
 *
 * The preview pipeline is *incremental*: it memoises per block and lays out at
 * the webview's pixel width. A PDF is paginated at the page's text width, needs
 * every block whether or not it was on screen, and must be reproducible from the
 * document alone. So the export takes the same road the CLI takes —
 * `parse` → `resolve` → `exportPdf` — which is what makes
 * `Export to PDF` and `mdv export --pdf --build-time …` produce the *same bytes*
 * for the same document. Sharing the preview's caches would quietly break that.
 *
 * The two paths still share the parts that must not drift: the chart registry
 * (`registry.ts`), the network capability (`capabilities.ts`) and the security
 * settings that gate it.
 *
 * ## Determinism
 *
 * `buildTime` is the document's own (`date:` in front matter, else the epoch as
 * `resolve` defaults it) — never `Date.now()`, so exporting twice writes
 * identical files (SPEC 28.10, SPEC 24.3 rule 2).
 */

import { parse } from '@mdv/parser';
import type { Diagnostic } from '@mdv/parser';
import { createLayoutContext, resolve } from '@mdv/core';
import type { MdvConfig, MdvPlugin, ResolvedDocument } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';
import { getBuiltinTheme, listBuiltinThemes } from '@mdv/themes';
import { createStandardFontMetrics, exportPdf, pdfOptionsFromFrontMatter } from '@mdv/render-pdf';
import type { PdfExportOptions } from '@mdv/render-pdf';

import { capabilitiesFor } from './capabilities.js';
import type { PipelineInputs } from './types.js';

/** Reported as the plugin that carried the built-ins into core. */
const EXTENSION_VERSION = '0.0.0';

/**
 * What the host asks of an export, beyond the document itself.
 *
 * These are *defaults*, not an explicit request: they come from `mdv.export.*`
 * settings that always hold a value, so a document's own `pdf:` block outranks
 * them (see `renderPdf`).
 */
export interface PdfRequest {
  /** SPEC 28.2 page size, from `mdv.export.pdf.pageSize`. */
  readonly pageSize: string;
  /**
   * Attach the `.mdv` source to the PDF (SPEC 28.9), so the export stays
   * round-trippable back into an editable document.
   */
  readonly embedSource: boolean;
  /** File name recorded for that attachment. */
  readonly sourceName: string;
}

/** A finished export: the bytes, plus everything the exporter had to say. */
export interface PdfOutput {
  readonly bytes: Uint8Array;
  /** Resolution diagnostics and export diagnostics, in that order. */
  readonly diagnostics: readonly Diagnostic[];
  /** Blocks in the resolved document, for the completion message. */
  readonly blockCount: number;
}

/** The plugin that carries the built-in chart types and themes into core. */
function builtinsPlugin(): MdvPlugin {
  return {
    name: 'mdv-vscode builtins',
    version: EXTENSION_VERSION,
    chartTypes: builtinChartTypes,
    themes: listBuiltinThemes(),
  };
}

/**
 * Resolve `inputs.source` the way an export needs it.
 *
 * The security settings are the *same* ones the preview obeys: with
 * `mdv.security.allowExternal` off there is no `fetch` capability in the config,
 * and `@mdv/core` refuses every remote `src:` with `MDV4002` rather than
 * silently reaching the network because this happens to be an export.
 */
async function resolveForExport(inputs: PipelineInputs): Promise<ResolvedDocument> {
  const config: MdvConfig = {
    plugins: [builtinsPlugin()],
    capabilities: capabilitiesFor(inputs.allowExternal),
    level: inputs.level,
    security: {
      allowExternal: inputs.allowExternal,
      allowedOrigins: [...inputs.allowedOrigins],
    },
    ...(inputs.strict ? { strict: true } : {}),
  };
  return resolve(parse(inputs.source), config);
}

/**
 * Export a document to PDF bytes.
 *
 * Never throws for document content — a broken block becomes a diagnostic and
 * an error card, exactly as on screen. A malformed page size is host
 * configuration and does throw (SPEC 21), which the command reports.
 */
export async function renderPdf(inputs: PipelineInputs, request: PdfRequest): Promise<PdfOutput> {
  const resolved = await resolveForExport(inputs);

  // The registry the document was resolved under, so a chart type reaches the
  // exporter's own layout pass rather than falling back to the built-ins only.
  const first = resolved.blocks[0];
  const registry = first === undefined ? undefined : createLayoutContext(resolved, first).registry;

  const collected: Diagnostic[] = [];

  // SPEC 28.2 layering. `buildPdf` merges the document's `pdf:` block *under*
  // the options passed here, so every field named below beats the document.
  // But `mdv.export.pdf.*` are settings that always hold a value — they are the
  // host's default, not a typed request, and the CLI only passes `--page-size`
  // when it was actually typed. So they are supplied for the fields the
  // document left open, and no others. Otherwise a document declaring
  // `pageSize: Letter` would export as Letter from the CLI and A4 from the
  // editor (breaking the *same bytes* claim at the top of this file), and one
  // declaring `embedSource: false` would get its source attached regardless.
  const declared = pdfOptionsFromFrontMatter(resolved.frontmatter?.pdf);
  const options: PdfExportOptions = {
    ...(declared.pageSize === undefined ? { pageSize: request.pageSize } : {}),
    ...(request.embedSource && declared.embedSource === undefined ? { embedSource: true } : {}),
  };

  const bytes = await exportPdf(
    resolved,
    {
      fonts: [],
      metrics: createStandardFontMetrics(),
      // The document's own build time, never the clock (SPEC 28.10).
      buildTime: resolved.config.buildTime,
      onDiagnostic: (d) => collected.push(d),
      // SPEC 28.5: a PDF prints with the `print` theme. The CLI only steps
      // around this for an explicit `--theme`, which the extension has no
      // equivalent of, so the export always takes the default road.
      printTheme: getBuiltinTheme('print'),
      ...(registry === undefined ? {} : { registry }),
      // Only ever attached when `embedSource` is on (SPEC 28.9); handing it over
      // regardless is what the CLI does, and it changes no byte otherwise.
      source: inputs.source,
      sourceName: request.sourceName,
    },
    options,
  );

  return {
    bytes,
    diagnostics: [...resolved.diagnostics, ...collected],
    blockCount: resolved.blocks.length,
  };
}

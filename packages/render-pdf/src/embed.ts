/**
 * Draw one scene onto a host's own `pdf-lib` page (SPEC 28.5).
 *
 * This is the "one chart in someone else's report" entry point. The scene is
 * wrapped in a **Form XObject**, which is the only way to add content to a page
 * that already has some without risking a resource-name collision: the form
 * carries its own resource dictionary, so `F0` inside it is not the host's
 * `F0`.
 *
 * The call is synchronous, which is what the contract asks for and what makes it
 * usable inside an existing render loop. The one consequence is that raster
 * images cannot be embedded — `pdf-lib`'s image embedders are asynchronous — so
 * an `image` node becomes the framed placeholder with its alt text that
 * `paint.ts` draws for an unresolvable href. Vector content, which is all a
 * chart normally is, is unaffected.
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';
import type { Scene } from '@mdv/core';

import { drawScene, PRINT_POLICY } from './paint.js';
import { ResourcePool } from './resources.js';
import { fontKeyId, standardFontName } from './fonts.js';
import type { FontKey } from './fonts.js';
import { serializeOps } from './writer.js';
import { PT_PER_PX } from './units.js';
import type { PdfExportContext } from './document.js';
import { renderDiagnostic } from './diagnostics.js';

/** The subset of `PDFPage` this module needs, so the public type stays `unknown`. */
interface PageLike {
  doc: PDFDocument;
  node: PDFPage['node'];
  getSize(): { width: number; height: number };
}

function isPageLike(value: unknown): value is PageLike {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<PageLike>;
  return (
    candidate.doc instanceof PDFDocument &&
    typeof candidate.getSize === 'function' &&
    candidate.node !== undefined
  );
}

/**
 * Draw `scene` at `origin` on `page`.
 *
 * @param origin - top-left of the chart, y measured **downward** from the top of
 * the page so it matches scene coordinates; the flip happens here.
 * @throws TypeError when `page` is not a `pdf-lib` `PDFPage` — host programmer
 * error, which SPEC 21 says is an exception.
 */
export function drawSceneOnPage(
  page: unknown,
  scene: Scene,
  origin: { x: number; y: number },
  ctx: PdfExportContext,
): void {
  if (!isPageLike(page)) {
    throw new TypeError('drawSceneOnPage: `page` must be a pdf-lib PDFPage');
  }
  const pdf = page.doc;
  const context = pdf.context;
  const { width, height } = page.getSize();

  const pool = new ResourcePool();
  const result = drawScene(scene, {
    pool,
    placement: {
      xPt: origin.x,
      yPt: origin.y,
      scale: PT_PER_PX,
      pageHeightPt: height,
    },
    policy: PRINT_POLICY,
  });

  const faces = new Map<string, PDFFont>();
  const fontsByResource = new Map<string, PDFFont>();
  const resources = context.obj({ ProcSet: ['PDF', 'Text'] });

  if (pool.fonts.length > 0) {
    const dict = context.obj({});
    for (const { resource, key } of pool.fonts) {
      const id = fontKeyId(key as FontKey);
      let face = faces.get(id);
      if (face === undefined) {
        face = pdf.embedStandardFont(standardFontName(key));
        faces.set(id, face);
      }
      fontsByResource.set(resource, face);
      dict.set(PDFName.of(resource), face.ref);
    }
    resources.set(PDFName.of('Font'), dict);
  }
  if (pool.alphas.length > 0) {
    const dict = context.obj({});
    for (const { resource, spec } of pool.alphas) {
      dict.set(
        PDFName.of(resource),
        context.obj({ Type: 'ExtGState', ca: spec.fill, CA: spec.stroke }),
      );
    }
    resources.set(PDFName.of('ExtGState'), dict);
  }

  const content = serializeOps(result.ops, fontsByResource);
  const form = context.register(
    context.stream(content, {
      Type: 'XObject',
      Subtype: 'Form',
      FormType: 1,
      BBox: [0, 0, width, height],
      Resources: resources,
    }),
  );
  // `newXObject` picks a key the page is not already using; `asString()`
  // includes the leading solidus, so it is already an operand.
  const name = page.node.newXObject('MdvScene', form);
  page.node.addContentStream(context.register(context.stream(`q\n${name.asString()} Do\nQ`)));

  const report = ctx.onDiagnostic;
  if (report === undefined) return;
  if (result.missingCodePoints.length > 0) {
    report(
      renderDiagnostic('MDV5100', {
        detail: `${String(result.missingCodePoints.length)} codepoint(s) outside WinAnsi were drawn as '?'.`,
      }),
    );
  }
  if (result.shapingRequired) report(renderDiagnostic('MDV5101'));
}

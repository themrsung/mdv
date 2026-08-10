/**
 * `PdfBuild` → PDF bytes, via `pdf-lib`'s object model (SPEC 28.9, 28.10).
 *
 * `pdf-lib` is used as a *serialiser*, not as a drawing API: every operator was
 * decided in `render.ts`, and this module only turns objects into a file. That
 * boundary is what makes the operator trace and the file two views of the same
 * thing, and it is why a `pdf-lib` upgrade can change the bytes without changing
 * a single fixture.
 *
 * ## Determinism (SPEC 28.10)
 *
 * Four things are pinned here and nowhere else:
 *
 * - `PDFDocument.create({ updateMetadata: false })`, because the default writes
 *   `CreationDate: new Date()` into the info dictionary.
 * - Every date comes from `ctx.buildTime`.
 * - `/ID` is a checksum of the content streams plus `buildTime` — never random.
 * - `save({ useObjectStreams: false })`, so object numbering is the allocation
 *   order this file walks in and the cross-reference table is plain text.
 */

import {
  AFRelationship,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
} from 'pdf-lib';
import type { PDFDict, PDFFont, PDFPage, PDFRef } from 'pdf-lib';
import { SPEC_VERSION } from '@mdv/spec';

import { argToToken } from './ops.js';
import type { PdfArg, PdfOp } from './ops.js';
import { fontKeyId, standardFontName, toWinAnsi } from './fonts.js';
import type { FontKey } from './fonts.js';
import type { PatternSpec, ResourcePool, ShadingSpec } from './resources.js';
import type { StructElement } from './render.js';
import type { OutlineEntry } from './paginate.js';
import type { PdfBuild, PdfExportContext } from './document.js';
import { documentId } from './hash.js';
import { formatNumber } from './number.js';

/** What the exporter calls itself in `/Producer` and `/Creator` (SPEC 28.9). */
export const PRODUCER = `MDV ${SPEC_VERSION}`;

// ─────────────────────────────────────────────────────────────────────────────
// Content streams
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Percent-encode what a PDF literal string cannot carry safely.
 *
 * `pdf-lib` deliberately does not escape parentheses when writing a literal
 * string, so a URL containing one would end the string early and corrupt the
 * file. Percent-encoding is lossless for a URI, which is the only kind of
 * string that reaches this function.
 */
export function pdfUri(url: string): string {
  let out = '';
  for (const ch of url) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === '(' || ch === ')' || ch === '\\') {
      out += `%${cp.toString(16).toUpperCase().padStart(2, '0')}`;
    } else if (cp > 0x7e || cp < 0x20) {
      for (const byte of new TextEncoder().encode(ch)) {
        out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    } else {
      out += ch;
    }
  }
  return out;
}

function encodeTextArg(arg: Extract<PdfArg, { k: 'text' }>, fonts: ReadonlyMap<string, PDFFont>): string {
  const font = fonts.get(arg.font);
  // A text operator whose font was never allocated cannot happen: the resource
  // name came from the same pool. Emitting an empty string rather than throwing
  // keeps a hypothetical bug from destroying the whole export.
  if (font === undefined) return '<>';
  return font.encodeText(toWinAnsi(arg.v)).toString();
}

/** Serialise a page's operators. One operation per line, for legible diffs. */
export function serializeOps(ops: readonly PdfOp[], fonts: ReadonlyMap<string, PDFFont>): string {
  const lines: string[] = [];
  for (const operation of ops) {
    if (operation.args.length === 0) {
      lines.push(operation.op);
      continue;
    }
    const tokens = operation.args.map((arg) =>
      arg.k === 'text' ? encodeTextArg(arg, fonts) : argToToken(arg),
    );
    lines.push(`${tokens.join(' ')} ${operation.op}`);
  }
  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Shadings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A PDF colour function for a gradient's stops.
 *
 * Two stops are one exponential function; more are stitched. `Bounds` must be
 * strictly increasing or the file is invalid, so offsets are clamped and nudged
 * apart rather than trusted — a degenerate gradient in the document must not
 * produce a PDF no reader will open.
 */
function shadingFunction(context: PDFDocument['context'], spec: ShadingSpec): PDFRef {
  const stops = spec.stops;
  const colorOf = (index: number): number[] => {
    const stop = stops[index];
    return stop === undefined ? [0, 0, 0] : [stop.color.r, stop.color.g, stop.color.b];
  };
  if (stops.length <= 2) {
    return context.register(
      context.obj({
        FunctionType: 2,
        Domain: [0, 1],
        C0: colorOf(0),
        C1: colorOf(Math.max(0, stops.length - 1)),
        N: 1,
      }),
    );
  }

  const functions: PDFRef[] = [];
  for (let i = 0; i < stops.length - 1; i += 1) {
    functions.push(
      context.register(
        context.obj({ FunctionType: 2, Domain: [0, 1], C0: colorOf(i), C1: colorOf(i + 1), N: 1 }),
      ),
    );
  }
  const bounds: number[] = [];
  let previous = 0;
  for (let i = 1; i < stops.length - 1; i += 1) {
    const raw = stops[i]?.offset ?? previous;
    const clamped = Math.min(0.999999, Math.max(previous + 0.000001, raw));
    bounds.push(clamped);
    previous = clamped;
  }
  const encode: number[] = [];
  for (let i = 0; i < functions.length; i += 1) encode.push(0, 1);

  return context.register(
    context.obj({
      FunctionType: 3,
      Domain: [0, 1],
      Functions: functions,
      Bounds: bounds,
      Encode: encode,
    }),
  );
}

function shadingDict(context: PDFDocument['context'], spec: ShadingSpec): PDFRef {
  return context.register(
    context.obj({
      ShadingType: spec.kind === 'axial' ? 2 : 3,
      ColorSpace: 'DeviceRGB',
      Coords: [...spec.coords],
      Function: shadingFunction(context, spec),
      Extend: [true, true],
    }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The writer
// ─────────────────────────────────────────────────────────────────────────────

interface OutlineNode {
  entry: OutlineEntry;
  children: OutlineNode[];
}

/** Nest a flat heading list by level. */
function nestOutline(entries: readonly OutlineEntry[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];
  for (const entry of entries) {
    const node: OutlineNode = { entry, children: [] };
    while (stack.length > 0 && (stack[stack.length - 1] as OutlineNode).entry.level >= entry.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent === undefined) roots.push(node);
    else parent.children.push(node);
    stack.push(node);
  }
  return roots;
}

function countDescendants(nodes: readonly OutlineNode[]): number {
  let total = 0;
  for (const node of nodes) total += 1 + countDescendants(node.children);
  return total;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The XMP packet of SPEC 28.9: everything needed to reproduce the bytes. */
export function xmpPacket(build: PdfBuild, buildTime: Date): string {
  const { meta } = build;
  const iso = buildTime.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const keywords = meta.keywords.join(', ');
  return `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(meta.title)}</rdf:li></rdf:Alt></dc:title>
   <dc:creator><rdf:Seq><rdf:li>${xmlEscape(meta.author)}</rdf:li></rdf:Seq></dc:creator>
   <dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(meta.subject)}</rdf:li></rdf:Alt></dc:description>
   <dc:language><rdf:Bag><rdf:li>${xmlEscape(meta.lang)}</rdf:li></rdf:Bag></dc:language>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreatorTool>${xmlEscape(PRODUCER)}</xmp:CreatorTool>
   <xmp:CreateDate>${iso}</xmp:CreateDate>
   <xmp:ModifyDate>${iso}</xmp:ModifyDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${xmlEscape(PRODUCER)}</pdf:Producer>
   <pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:mdv="https://mdv.dev/ns/">
   <mdv:spec>${xmlEscape(SPEC_VERSION)}</mdv:spec>
   <mdv:profile>${xmlEscape(build.options.profile)}</mdv:profile>
   <mdv:theme>${xmlEscape(meta.theme)}</mdv:theme>
   <mdv:locale>${xmlEscape(meta.locale)}</mdv:locale>
   <mdv:fonts>standard-14</mdv:fonts>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

/**
 * Serialise a built document.
 *
 * @throws Error only for host programmer error — a page `pdf-lib` refused to
 * create, or an image whose bytes are not the format they claim (SPEC 21).
 */
export async function writePdf(build: PdfBuild, ctx: PdfExportContext): Promise<Uint8Array> {
  const { options, rendered, meta } = build;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const context = pdf.context;

  // ── fonts ──────────────────────────────────────────────────────────────────
  const faces = new Map<string, PDFFont>();
  const faceFor = (key: FontKey): PDFFont => {
    const id = fontKeyId(key);
    const existing = faces.get(id);
    if (existing !== undefined) return existing;
    const embedded = pdf.embedStandardFont(standardFontName(key));
    faces.set(id, embedded);
    return embedded;
  };

  // ── images ─────────────────────────────────────────────────────────────────
  // Embedding is asynchronous, so it happens before any page is assembled;
  // everything after this point is synchronous and therefore ordered.
  const images = new Map<string, PDFRef>();
  for (const page of rendered.pages) {
    for (const { spec } of page.pool.images) {
      if (images.has(spec.href)) continue;
      const embedded =
        spec.format === 'png' ? await pdf.embedPng(spec.bytes) : await pdf.embedJpg(spec.bytes);
      images.set(spec.href, embedded.ref);
    }
  }

  // ── pages, pass 1: create them so annotations can point across pages ───────
  const pdfPages: PDFPage[] = [];
  for (const page of rendered.pages) {
    pdfPages.push(pdf.addPage([page.widthPt, page.heightPt]));
  }
  const pageRefOf = (index: number): PDFRef | undefined => pdfPages[index]?.ref;

  // ── pages, pass 2: resources, content, annotations ─────────────────────────
  const contents: string[] = [];
  for (let i = 0; i < rendered.pages.length; i += 1) {
    const page = rendered.pages[i];
    const target = pdfPages[i];
    if (page === undefined || target === undefined) continue;

    const fontsByResource = new Map<string, PDFFont>();
    const resources = buildResources(pdf, page.pool, fontsByResource, faceFor, images);
    const stream = serializeOps(page.ops, fontsByResource);
    contents.push(stream);

    const streamRef = context.register(
      options.compress ? context.flateStream(stream) : context.stream(stream),
    );
    target.node.set(PDFName.of('Contents'), streamRef);
    target.node.set(PDFName.of('Resources'), resources);
    target.node.set(PDFName.of('StructParents'), context.obj(i));

    const annots: PDFRef[] = [];
    for (const link of page.links) {
      const rect = link.rect.map((n) => Number(formatNumber(n)));
      const action =
        link.url !== undefined
          ? { A: { Type: 'Action', S: 'URI', URI: PDFString.of(pdfUri(link.url)) } }
          : {};
      let dest: unknown;
      if (link.dest !== undefined) {
        const ref = pageRefOf(link.dest.pageIndex);
        if (ref !== undefined) dest = [ref, 'XYZ', null, Number(formatNumber(link.dest.yPt)), null];
      }
      if (link.url === undefined && dest === undefined) continue;
      annots.push(
        context.register(
          context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: rect,
            Border: [0, 0, 0],
            // Bit 3 (Print): an annotation that does not print is invisible on
            // the only medium this file is for.
            F: 4,
            ...action,
            ...(dest === undefined ? {} : { Dest: dest as never }),
          }),
        ),
      );
    }
    target.node.set(PDFName.of('Annots'), context.obj(annots));
  }

  // ── structure tree (SPEC 28.8) ─────────────────────────────────────────────
  writeStructureTree(pdf, build, pageRefOf);

  // ── bookmarks (SPEC 28.7) ──────────────────────────────────────────────────
  if (options.bookmarks) writeOutline(pdf, build, pageRefOf);

  // ── catalog ────────────────────────────────────────────────────────────────
  pdf.catalog.set(PDFName.of('Lang'), PDFString.of(meta.lang));
  pdf.catalog.set(
    PDFName.of('ViewerPreferences'),
    context.obj({ DisplayDocTitle: true }),
  );

  // ── info dictionary (SPEC 28.9) ────────────────────────────────────────────
  pdf.setTitle(meta.title === '' ? 'Untitled' : meta.title);
  if (meta.author !== '') pdf.setAuthor(meta.author);
  if (meta.subject !== '') pdf.setSubject(meta.subject);
  if (meta.keywords.length > 0) pdf.setKeywords([...meta.keywords]);
  pdf.setProducer(PRODUCER);
  pdf.setCreator(PRODUCER);
  pdf.setCreationDate(ctx.buildTime);
  pdf.setModificationDate(ctx.buildTime);

  // ── XMP (SPEC 28.9) ────────────────────────────────────────────────────────
  const xmp = xmpPacket(build, ctx.buildTime);
  pdf.catalog.set(
    PDFName.of('Metadata'),
    context.register(context.stream(xmp, { Type: 'Metadata', Subtype: 'XML' })),
  );

  // ── the source itself (SPEC 28.9) ──────────────────────────────────────────
  if (options.embedSource && ctx.source !== undefined) {
    // `PDFDocument.attach` treats a string as a **base64 data URI**, so the
    // source must be handed over as bytes or it is silently mangled.
    const bytes =
      typeof ctx.source === 'string' ? new TextEncoder().encode(ctx.source) : ctx.source;
    await pdf.attach(bytes, ctx.sourceName ?? 'source.mdv', {
      mimeType: 'text/vnd.mdv',
      description: 'MDV source of this document',
      creationDate: ctx.buildTime,
      modificationDate: ctx.buildTime,
      afRelationship: AFRelationship.Source,
    });
  }

  // ── /ID (SPEC 28.10) ───────────────────────────────────────────────────────
  const id = documentId([
    PRODUCER,
    ctx.buildTime.toISOString(),
    meta.title,
    meta.author,
    options.profile,
    ...contents,
  ]);
  const idString = PDFHexString.of(id);
  context.trailerInfo.ID = context.obj([idString, idString]);

  return pdf.save({
    useObjectStreams: false,
    addDefaultPage: false,
    updateFieldAppearances: false,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Resources
// ─────────────────────────────────────────────────────────────────────────────

function buildResources(
  pdf: PDFDocument,
  pool: ResourcePool,
  fontsByResource: Map<string, PDFFont>,
  faceFor: (key: FontKey) => PDFFont,
  images: ReadonlyMap<string, PDFRef>,
): PDFDict {
  const context = pdf.context;
  const resources = context.obj({
    ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI'],
  });

  if (pool.fonts.length > 0) {
    const dict = context.obj({});
    for (const { resource, key } of pool.fonts) {
      const face = faceFor(key);
      fontsByResource.set(resource, face);
      dict.set(PDFName.of(resource), face.ref);
    }
    resources.set(PDFName.of('Font'), dict);
  }

  const extGState = context.obj({});
  if (pool.alphas.length > 0) {
    for (const { resource, spec } of pool.alphas) {
      extGState.set(
        PDFName.of(resource),
        context.obj({ Type: 'ExtGState', ca: spec.fill, CA: spec.stroke }),
      );
    }
    resources.set(PDFName.of('ExtGState'), extGState);
  }

  if (pool.shadings.length > 0) {
    const dict = context.obj({});
    for (const { resource, spec } of pool.shadings) {
      dict.set(PDFName.of(resource), shadingDict(context, spec));
    }
    resources.set(PDFName.of('Shading'), dict);
  }

  if (pool.patterns.length > 0) {
    const dict = context.obj({});
    for (const { resource, spec } of pool.patterns) {
      dict.set(PDFName.of(resource), tilingPattern(pdf, spec, extGState));
    }
    resources.set(PDFName.of('Pattern'), dict);
  }

  if (pool.images.length > 0) {
    const dict = context.obj({});
    for (const { resource, spec } of pool.images) {
      const ref = images.get(spec.href);
      if (ref !== undefined) dict.set(PDFName.of(resource), ref);
    }
    resources.set(PDFName.of('XObject'), dict);
  }

  return resources;
}

/** A tiling pattern: the texture channel of SPEC 12.6, on paper. */
function tilingPattern(pdf: PDFDocument, spec: PatternSpec, pageExtGState: PDFDict): PDFRef {
  const context = pdf.context;
  const own = context.obj({});
  for (const name of spec.usesGraphicsStates) {
    const entry = pageExtGState.get(PDFName.of(name));
    if (entry !== undefined) own.set(PDFName.of(name), entry);
  }
  const stream = context.stream(spec.content, {
    Type: 'Pattern',
    PatternType: 1,
    PaintType: 1,
    TilingType: 1,
    BBox: [0, 0, spec.width, spec.height],
    XStep: spec.width,
    YStep: spec.height,
    Matrix: [...spec.matrix],
    Resources: { ExtGState: own },
  });
  return context.register(stream);
}

// ─────────────────────────────────────────────────────────────────────────────
// Structure tree
// ─────────────────────────────────────────────────────────────────────────────

/** The page an element belongs to: the page of its first marked content. */
function pageOfElement(node: StructElement): number | undefined {
  for (const kid of node.kids) {
    if (kid.kind === 'mcid') return kid.pageIndex;
    const nested = pageOfElement(kid);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function writeStructureTree(
  pdf: PDFDocument,
  build: PdfBuild,
  pageRefOf: (index: number) => PDFRef | undefined,
): void {
  const context = pdf.context;
  const rootRef = context.nextRef();

  // Pre-order reference allocation: object numbers then follow reading order,
  // which is both deterministic and pleasant to read in a decompressed file.
  const refs = new Map<StructElement, PDFRef>();
  const assign = (node: StructElement): void => {
    refs.set(node, context.nextRef());
    for (const kid of node.kids) if (kid.kind !== 'mcid') assign(kid);
  };
  assign(build.rendered.structure);

  const emit = (node: StructElement, parent: PDFRef): void => {
    const self = refs.get(node);
    if (self === undefined) return;
    const pageIndex = pageOfElement(node);
    const ownPage = pageIndex === undefined ? undefined : pageRefOf(pageIndex);

    const kids: unknown[] = [];
    for (const kid of node.kids) {
      if (kid.kind === 'mcid') {
        const kidPage = pageRefOf(kid.pageIndex);
        // An MCID is only unambiguous relative to the element's own `/Pg`; a
        // paragraph that broke across a page boundary needs the long form.
        if (kidPage !== undefined && kidPage === ownPage) kids.push(kid.mcid);
        else if (kidPage !== undefined) {
          kids.push(context.obj({ Type: 'MCR', Pg: kidPage, MCID: kid.mcid }));
        }
      } else {
        const kidRef = refs.get(kid);
        if (kidRef !== undefined) kids.push(kidRef);
        emit(kid, self);
      }
    }

    context.assign(
      self,
      context.obj({
        Type: 'StructElem',
        S: node.type,
        P: parent,
        ...(ownPage === undefined ? {} : { Pg: ownPage }),
        ...(node.alt === undefined ? {} : { Alt: PDFHexString.fromText(node.alt) }),
        ...(node.actualText === undefined
          ? {}
          : { ActualText: PDFHexString.fromText(node.actualText) }),
        K: kids as never,
      }),
    );
  };
  emit(build.rendered.structure, rootRef);

  // ── the parent tree: page → its elements, indexed by MCID ──────────────────
  const nums: unknown[] = [];
  for (let i = 0; i < build.rendered.pages.length; i += 1) {
    const page = build.rendered.pages[i];
    if (page === undefined) continue;
    const owners = page.mcidOwners.map((owner) => refs.get(owner)).filter((r): r is PDFRef => r !== undefined);
    nums.push(i, context.register(context.obj(owners as never)));
  }
  const parentTree = context.register(context.obj({ Nums: nums as never }));

  const documentRef = refs.get(build.rendered.structure);
  context.assign(
    rootRef,
    context.obj({
      Type: 'StructTreeRoot',
      ...(documentRef === undefined ? {} : { K: [documentRef] }),
      ParentTree: parentTree,
      ParentTreeNextKey: build.rendered.pages.length,
      // `Note` and `TOCI` are standard; the map exists so a viewer that does not
      // know a type still has somewhere to look.
      RoleMap: { Note: 'Note', TOCI: 'TOCI', Caption: 'Caption' },
    }),
  );

  pdf.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  pdf.catalog.set(PDFName.of('MarkInfo'), context.obj({ Marked: true }));
}

// ─────────────────────────────────────────────────────────────────────────────
// Outline
// ─────────────────────────────────────────────────────────────────────────────

function writeOutline(
  pdf: PDFDocument,
  build: PdfBuild,
  pageRefOf: (index: number) => PDFRef | undefined,
): void {
  const context = pdf.context;
  const roots = nestOutline(build.pagination.outline);
  if (roots.length === 0) return;

  const outlinesRef = context.nextRef();

  const emit = (nodes: readonly OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef } => {
    const nodeRefs = nodes.map(() => context.nextRef());
    for (let i = 0; i < nodes.length; i += 1) {
      const node = nodes[i];
      const self = nodeRefs[i];
      if (node === undefined || self === undefined) continue;

      const page = build.rendered.pages[node.entry.pageIndex];
      const pageRef = pageRefOf(node.entry.pageIndex);
      const top = page === undefined ? 0 : page.heightPt - node.entry.yPt;

      const children =
        node.children.length === 0 ? undefined : emit(node.children, self);
      const descendants = countDescendants(node.children);

      context.assign(
        self,
        context.obj({
          Title: PDFHexString.fromText(node.entry.title),
          Parent: parent,
          ...(i > 0 ? { Prev: nodeRefs[i - 1] as PDFRef } : {}),
          ...(i < nodes.length - 1 ? { Next: nodeRefs[i + 1] as PDFRef } : {}),
          ...(children === undefined ? {} : { First: children.first, Last: children.last }),
          // Positive: the branch opens with the document. A reader who exported
          // bookmarks wants to see them.
          ...(descendants === 0 ? {} : { Count: descendants }),
          ...(pageRef === undefined
            ? {}
            : { Dest: [pageRef, 'XYZ', null, Number(formatNumber(top)), null] as never }),
        }),
      );
    }
    return {
      first: nodeRefs[0] as PDFRef,
      last: nodeRefs[nodeRefs.length - 1] as PDFRef,
    };
  };

  const { first, last } = emit(roots, outlinesRef);
  context.assign(
    outlinesRef,
    context.obj({
      Type: 'Outlines',
      First: first,
      Last: last,
      Count: countDescendants(roots),
    }),
  );
  pdf.catalog.set(PDFName.of('Outlines'), outlinesRef);
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'));
}

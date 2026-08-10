/**
 * `@mdv/parser` — text → MDV AST.
 *
 * CommonMark 0.31.2 + GFM + visual blocks + directives + front matter, with
 * position accuracy through the header and data sub-parses (SPEC 14.4).
 *
 * **The parser never throws on document content** (SPEC 21, "Error contract").
 * Malformed input produces diagnostics and `mdvError` nodes; a thrown exception
 * from this package is always a bug or a host programmer error.
 */

import { DiagnosticBag } from './internal/diagnostics.js';
import { parseFrontMatter } from './internal/frontmatter.js';
import { runFromMarkdown } from './internal/mdast.js';
import { SourceIndex, normaliseSource, remapTree, subSourceFromLine } from './internal/source.js';
import { transformFlow, type TransformContext } from './internal/transform.js';
import { serializeDocument } from './serialize.js';
import type { FormatOptions, ParseOptions } from './options.js';
import type { MdvContent, MdvDocument } from './types.js';

export * from './types.js';
export type { FormatOptions, ParseOptions } from './options.js';
export { canonicalAst, canonicalValue, type CanonicalOptions } from './canonical.js';

/**
 * Parse MDV source into an {@link MdvDocument} (SPEC 21).
 *
 * Stage 1 of the pipeline (SPEC 18). Position-accurate: every node carries a
 * `position` with absolute offsets into `source`, and every diagnostic's range
 * refers to the original document even when it originates in a sub-parse of a
 * block header or of a data cell (SPEC 14.4).
 *
 * Three {@link ParseOptions} fields are accepted and are not acted on by this
 * stage, rather than being partially honoured:
 *
 * - `from` — nothing in stage 1 resolves a relative reference or fetches, and
 *   `Diagnostic.uri` is set by the host that knows the document's real identity.
 * - `level` — every construct is parsed at its own level and stamped with it
 *   (`MdvBlock.level`, `MdvDirective.level`). Degradation and the level info
 *   diagnostic are SPEC 15.2 decisions, which belong to the renderer that knows
 *   what it can draw; suppressing constructs here would lose source the reader
 *   is obliged to show.
 * - `math` — `$…$` / `$$…$$` are not tokenised as math, so they stay literal
 *   text. See the summary; this is an honest gap, not a silent one.
 *
 * @param source - the document text, already decoded to UTF-16 (SPEC 3.2)
 * @param options - see {@link ParseOptions}
 * @returns a document that always exists. `doc.diagnostics` carries every
 * problem found; unparseable constructs become `mdvError` nodes with their
 * source preserved. This function does not throw for bad content.
 */
export function parse(source: string, options: ParseOptions = {}): MdvDocument {
  const text = normaliseSource(source);
  const root = new SourceIndex(text);
  const bag = new DiagnosticBag();
  const whole = root.range(0, text.length);

  const maxBytes = options.maxBytes;
  if (maxBytes !== undefined && byteLength(text) > maxBytes) {
    // SPEC 21: over the limit the parser does not attempt partial work.
    bag.add('MDV4000', whole, {
      detail: `The document is ${byteLength(text)} bytes; the configured limit is ${maxBytes}.`,
    });
    return { type: 'root', children: [], diagnostics: bag.drain(), datasets: {}, position: whole };
  }

  const front = parseFrontMatter(root, bag, options.frontmatter ?? true);
  const context: TransformContext = {
    root,
    bag,
    allowHtml: options.allowHtml ?? false,
    directives: options.directives ?? true,
  };

  const bodyStart = root.lineStart(front.bodyLine);
  let children: MdvContent[];
  try {
    const sub = subSourceFromLine(root, front.bodyLine);
    const tree = runFromMarkdown(sub.text);
    remapTree(tree, sub);
    children = transformFlow(tree.children, context);
  } catch (error) {
    // The invariant is that parse never throws for document content. micromark
    // has no failure mode for a string input, so reaching this is a bug — but a
    // bug must still produce a readable document rather than an exception.
    // Appendix C has no code for an internal parser failure; MDV5000 is the
    // closest ("failed to render") and is reported as a spec gap.
    const range = root.range(bodyStart, text.length);
    const diagnostic = bag.add('MDV5000', range, {
      message: 'The document could not be parsed',
      detail: error instanceof Error ? error.message : String(error),
    });
    children = [
      { type: 'mdvError', diagnostic, raw: text.slice(bodyStart), position: range },
    ];
  }

  const document: MdvDocument = {
    type: 'root',
    children,
    diagnostics: bag.drain(),
    // SPEC 19: `datasets` is populated at resolve, by `@mdv/core`.
    datasets: {},
    position: whole,
  };
  if (front.frontmatter !== null) document.frontmatter = front.frontmatter;
  return document;
}

const ENCODER = new TextEncoder();

function byteLength(text: string): number {
  return ENCODER.encode(text).length;
}

/**
 * Serialise an {@link MdvDocument} back to canonical MDV source (SPEC 19, 27).
 *
 * MUST round-trip: `parse → toMarkdown → parse` produces an identical AST. That
 * property is what makes `mdv fmt` and the LSP formatter safe to run
 * unattended, and it is enforced by a property test over the fixture corpus.
 *
 * @param doc - a document from {@link parse}, or a resolved document's AST
 * @param options - see {@link FormatOptions}; the defaults are the canonical form
 * @returns MDV source with a trailing newline
 */
export function toMarkdown(doc: MdvDocument, options?: FormatOptions): string {
  return serializeDocument(doc, options);
}

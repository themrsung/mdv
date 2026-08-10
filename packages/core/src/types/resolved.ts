/**
 * The output of stage 2 (Resolve) — SPEC 18.
 *
 * Resolve is the **only async stage**: it builds the dataset DAG, fetches `src:`
 * through the injected capabilities, applies the attribute cascade, and resolves
 * themes. Everything downstream is pure and synchronous.
 */

import type { ConformanceLevel } from '@mdv/spec';
import type { Diagnostic, FrontMatter, MdvBlock, MdvDocument, Range } from '@mdv/parser';
import type { BlockAttrs } from './attrs.js';
import type { DataRegistry, Table, TableRef } from './data.js';
import type { Encoding } from './encode.js';
import type { Theme } from './theme.js';
import type { ResolvedConfig } from './config.js';

/**
 * One visual block, resolved: attributes cascaded, data prepared, encoding
 * normalised to long form.
 *
 * A `ResolvedBlock` is the unit of layout and of caching. Everything layout needs
 * about the document is on it, so a block can be laid out in isolation — that is
 * what makes incremental re-render (SPEC 18) and virtualisation (SPEC 22.3)
 * possible.
 */
export interface ResolvedBlock {
  /**
   * The author's `id`, or the deterministic fallback `mdv-{index}`. Stable across
   * re-renders; used for the anchor, the element id prefix (SPEC 24.3 rule 7),
   * and any seeded algorithm.
   */
  id: string;
  /** 0-based position among the document's visual blocks. Drives the id scheme. */
  index: number;
  /** Lowercased block type, e.g. `'bar'`. */
  blockType: string;
  /** The level this block requires (SPEC 16.1). */
  level: ConformanceLevel;
  /** Attributes after the six-level cascade of SPEC 5.5. */
  attrs: BlockAttrs;
  /** Channel bindings, normalised: `y: revenue` has become `{field: 'revenue'}`. */
  encoding: Encoding;
  /**
   * The prepared table (stage 4). Always present and always well-formed — an
   * unresolvable dataset yields an empty table plus a diagnostic, never `null`,
   * so every consumer has one code path.
   */
  table: Table;
  /** How {@link table} was obtained, for cache keying and for `mdv data`. */
  tableRef: TableRef;
  /** The AST node this came from, for round-tripping and for the LSP. */
  node: MdvBlock;
  /** Source range of the whole block, fences included. */
  range: Range;
  /** The theme in force for this block, after any per-block `theme:` override. */
  theme: Theme;
  /** Diagnostics attributable to this block, in source order. */
  diagnostics: readonly Diagnostic[];
  /**
   * `true` when the block cannot render and must show the error card with the raw
   * data instead (SPEC 14.1 principle 2). The rest of the document still renders.
   */
  failed: boolean;
}

/**
 * A document after resolve (SPEC 21).
 *
 * Immutable from the caller's point of view: `MdvInstance.update` produces a new
 * `ResolvedDocument` rather than mutating this one, which is what lets two
 * documents render concurrently without interference (SPEC 17.3 invariant 4).
 */
export interface ResolvedDocument {
  /** The AST, with `datasets` populated and block `data` refs attached. */
  ast: MdvDocument;
  /** Parsed front matter, or `undefined` when the document had none. */
  frontmatter?: FrontMatter;
  /** Every visual block, in document order. */
  blocks: readonly ResolvedBlock[];
  /** The dataset DAG for this document only. */
  datasets: DataRegistry;
  /** Every diagnostic from stages 1–4, in document order. */
  diagnostics: readonly Diagnostic[];
  /** The document-level theme; blocks may override it. */
  theme: Theme;
  /** The fully defaulted configuration this document was resolved under. */
  config: ResolvedConfig;
}

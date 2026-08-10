/**
 * Accessibility (SPEC 12) — computed in layout, carried on the {@link Scene}.
 *
 * Normative, not decorative: "a visual that fails these is non-conforming, not
 * merely imperfect". Putting the name, the description, the table view and the
 * focus order on the scene rather than in the DOM renderer is what lets the PDF
 * exporter emit the same text as tagged content and a Canvas backend keep the
 * same screen-reader experience as SVG.
 */

export type { TablePresentation, A11yTableOptions } from './table.js';
export {
  buildA11yTable,
  alignmentFor,
  defaultTableCaption,
  DEFAULT_TABLE_ROW_CAP,
} from './table.js';

export type { MarkSample, DescriptionOptions } from './describe.js';
export { sampleMark, generateDescription } from './describe.js';

export type { A11yTreeOptions } from './tree.js';
export { buildA11yTree, needsDescriptionDiagnostic } from './tree.js';

/**
 * Serialisation: `.mdv` text in, document out, and back again.
 *
 * The contract these two functions keep is the engine's most important
 * invariant: `read(write(doc))` equals `doc` for every document the model can
 * express, and `write(read(text))` equals `text` for every text the reader
 * fully understands. Anything it does not understand becomes a raw block, which
 * writes back byte for byte — so the second identity holds for *all* input, not
 * just the input we planned for.
 */

export type { ReadOptions } from './read.js';
export {
  read,
  readBlocks,
  normalizeSource,
  splitVisualBody,
  parseVisualInfo,
  splitTableRow,
  parseInline,
} from './read.js';

export type { WriteOptions } from './write.js';
export { write, writeBlocks, writeInline, visualInfoString } from './write.js';

export type { AttrDiagnostic, AttrMap, AttrParseResult, AttrValue } from './attrs.js';
export {
  formatScalar,
  parseAttributes,
  parseScalar,
  quoteIfNeeded,
  setHeaderAttribute,
  stripComment,
} from './attrs.js';

export type { EscapeContext } from './escape.js';
export { escapeDestination, escapeInline, escapeQuoted, unescapeInline } from './escape.js';

/**
 * Clipboard support: paste normalisation in, three flavours out.
 *
 * @see {@link paste} for the entry point on the way in and {@link copySelection}
 * on the way out.
 */

export type { HtmlElement, HtmlNode, HtmlText } from './html.js';
export {
  classList,
  decodeEntities,
  escapeHtml,
  nodesText,
  parseHtml,
  parseStyle,
  textContent,
} from './html.js';

export { blocksFromHtml, runsAreBlank, safeUrl, textFromHtml } from './from-html.js';

export type { HtmlWriteOptions } from './to-html.js';
export { blocksToHtml, inlineToHtml } from './to-html.js';

export type { ClipboardPayload, DataTransferItemLike, DataTransferLike } from './payload.js';
export {
  HTML_CLIPBOARD_TYPE,
  imagesFrom,
  isImageOnly,
  MDV_CLIPBOARD_TYPE,
  readClipboardPayload,
  TEXT_CLIPBOARD_TYPE,
} from './payload.js';

export type { PasteOptions } from './paste.js';
export {
  blocksFromPayload,
  blocksFromText,
  gridFromBlocks,
  gridFromText,
  paste,
  pasteAsMarkdown,
  pasteWithoutFormatting,
} from './paste.js';

export type { CopyResult } from './copy.js';
export { clipboardEntries, copyDocument, copySelection, fragmentOf } from './copy.js';

export type { PreparedImage } from './images.js';
export { commandFor, prepareImage, prepareImages } from './images.js';

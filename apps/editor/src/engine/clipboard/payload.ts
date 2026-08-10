/**
 * Reading a `DataTransfer` without depending on one.
 *
 * `paste` and `drop` events hand you a `DataTransfer`, whose API is awkward
 * (`types` is a live `DOMStringList` in some browsers, `items` is only iterable
 * in others, `files` is empty for a copied image in yet others). All of that is
 * flattened here into a plain {@link ClipboardPayload}, described by structural
 * types so tests can supply a literal instead of a DOM object.
 */

import type { ImageSource } from '../image/env.js';

/**
 * The custom flavour the editor writes alongside HTML and plain text.
 *
 * A round trip through this type is exact: it is the document's own `.mdv`
 * source, so copying a table out of one document and into another loses
 * nothing, not even a visual block's attribute quoting.
 */
export const MDV_CLIPBOARD_TYPE = 'text/x-mdv';

/** Standard flavours, named so call sites do not repeat string literals. */
export const HTML_CLIPBOARD_TYPE = 'text/html';
/** @see MDV_CLIPBOARD_TYPE */
export const TEXT_CLIPBOARD_TYPE = 'text/plain';

/** Structural stand-in for `DataTransferItem`. */
export interface DataTransferItemLike {
  readonly kind: string;
  readonly type: string;
  getAsFile?(): ImageSource | null;
}

/** Structural stand-in for `DataTransfer`. */
export interface DataTransferLike {
  readonly types?: ArrayLike<string> | Iterable<string> | undefined;
  getData?(type: string): string;
  readonly files?: ArrayLike<ImageSource> | undefined;
  readonly items?: ArrayLike<DataTransferItemLike> | Iterable<DataTransferItemLike> | undefined;
}

/** What arrived on the clipboard, in the flavours the engine understands. */
export interface ClipboardPayload {
  /** Our own `.mdv` source, when the copy came from this editor. */
  readonly mdv?: string;
  /** `text/html`, from anywhere. */
  readonly html?: string;
  /** `text/plain`, the universal fallback. */
  readonly text?: string;
  /** Image blobs, from a screenshot paste or a file drop. */
  readonly images: readonly ImageSource[];
}

/**
 * Flatten a `DataTransfer` into a payload.
 *
 * Image extraction looks at both `files` and `items`, because a pasted
 * screenshot appears in `items` with no `files` entry on some platforms and the
 * other way round on others. Duplicates are avoided by preferring `files` and
 * only falling back to `items` when it produced nothing.
 */
export function readClipboardPayload(transfer: DataTransferLike): ClipboardPayload {
  const types = new Set(toArray(transfer.types));
  const read = (type: string): string | undefined => {
    if (!transfer.getData) return undefined;
    if (types.size > 0 && !types.has(type)) return undefined;
    const value = transfer.getData(type);
    return value === '' ? undefined : value;
  };

  const mdv = read(MDV_CLIPBOARD_TYPE);
  const html = read(HTML_CLIPBOARD_TYPE);
  const text = read(TEXT_CLIPBOARD_TYPE);

  return {
    ...(mdv === undefined ? {} : { mdv }),
    ...(html === undefined ? {} : { html }),
    ...(text === undefined ? {} : { text }),
    images: imagesFrom(transfer),
  };
}

/** Every image blob a transfer carries, in order. */
export function imagesFrom(transfer: DataTransferLike): readonly ImageSource[] {
  const fromFiles = toArray(transfer.files).filter((file) => file.type.startsWith('image/'));
  if (fromFiles.length > 0) return fromFiles;

  const out: ImageSource[] = [];
  for (const item of toArray(transfer.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const file = item.getAsFile?.();
    if (file) out.push(file);
  }
  return out;
}

/**
 * True when the payload is *only* an image.
 *
 * Copying an image out of a browser also puts an `<img>` tag on the clipboard,
 * so the presence of HTML is not evidence that the user wanted text. When the
 * HTML is nothing but that image, the blob is the better source: it carries the
 * actual bytes rather than a URL that may not resolve.
 */
export function isImageOnly(payload: ClipboardPayload): boolean {
  if (payload.images.length === 0) return false;
  if (payload.mdv !== undefined) return false;
  if ((payload.text ?? '').trim() !== '') return false;
  const html = payload.html;
  if (html === undefined) return true;
  return html.replace(/<[^>]*>/g, '').trim() === '';
}

function toArray<T>(value: ArrayLike<T> | Iterable<T> | undefined | null): readonly T[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value as readonly T[];
  if (typeof (value as Iterable<T>)[Symbol.iterator] === 'function') return [...(value as Iterable<T>)];
  const arrayLike = value as ArrayLike<T>;
  const out: T[] = [];
  for (let index = 0; index < arrayLike.length; index += 1) {
    const item = arrayLike[index];
    if (item !== undefined) out.push(item);
  }
  return out;
}

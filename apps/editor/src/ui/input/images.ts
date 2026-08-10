/**
 * The image pipeline, as the UI sees it.
 *
 * The engine already turns a blob into a `data:` URI and an insertion command
 * (`clipboard.prepareImage`). What it deliberately does not do is tell anyone
 * how long that took or how much the document just grew by, and inline base64
 * is a *large* thing to do to a document silently: a 3 MB screenshot pasted
 * without comment becomes a 4 MB `.mdv` file that the user discovers a week
 * later when their editor gets slow.
 *
 * So this module keeps the two facts the interface needs — what is still
 * decoding, and what it cost — and phrases the engine's `IngestWarning`s as
 * something a person would say.
 *
 * Everything is parameterised on an injected `ImageEnvironment`, which is the
 * same seam the engine uses, so the whole path is exercised in the unit tests
 * with a fake decoder and no browser.
 */

import type { Block, Command, MdvDocument } from '../../engine/index.js';
import type {
  ImageEnvironment,
  ImageSource,
  IngestedImage,
  IngestOptions,
} from '../../engine/image/index.js';
import { allBlocks, clipboard, images as engineImages } from '../../engine/index.js';

/** An image being decoded, as shown in the block list. */
export interface PendingImage {
  readonly id: string;
  /** File name when there is one, else a generic label. */
  readonly name: string;
  /** Source byte count, for the placeholder's size hint. */
  readonly sourceBytes: number;
  /** Block the image will be inserted after, or `null` for "at the selection". */
  readonly afterBlockId: string | null;
}

/** Something worth telling the user about an image that has landed. */
export interface ImageNotice {
  readonly id: string;
  readonly tone: 'info' | 'warning' | 'error';
  readonly message: string;
}

/** Callbacks the surface supplies to drive its own state. */
export interface IngestHooks {
  /** A new blob has entered the pipeline. */
  onPending(pending: PendingImage): void;
  /** Decoding finished; run `command` to put the image in the document. */
  onReady(id: string, command: Command, image: IngestedImage): void;
  /** Decoding failed; the placeholder should be replaced by this notice. */
  onFailed(id: string, notice: ImageNotice): void;
  /** Called once per blob, after `onReady` or `onFailed`. */
  onSettled(id: string): void;
}

/** Where a batch of images should land. */
export interface IngestPlacement {
  readonly afterBlockId: string | null;
}

/**
 * Ingest a batch of blobs, reporting progress as it goes.
 *
 * Sequential on purpose. Decoding four 12-megapixel photos in parallel pins
 * every core and makes the first one — the one the user is looking at — arrive
 * *later* than it would have on its own. In order also means the insertion
 * order matches the drop order, which is the only order a person expects.
 */
export async function ingestBatch(
  sources: readonly ImageSource[],
  env: ImageEnvironment,
  hooks: IngestHooks,
  placement: IngestPlacement = { afterBlockId: null },
  options: IngestOptions = {},
): Promise<void> {
  for (let index = 0; index < sources.length; index += 1) {
    const source = sources[index];
    if (source === undefined) continue;
    const id = `img-${String(index)}-${String(source.size)}-${source.name ?? 'clipboard'}`;

    hooks.onPending({
      id,
      name: source.name ?? 'Pasted image',
      sourceBytes: source.size,
      afterBlockId: placement.afterBlockId,
    });

    try {
      const prepared = await clipboard.prepareImage(source, env, options);
      hooks.onReady(id, prepared.command, prepared.image);
    } catch (error) {
      hooks.onFailed(id, {
        id,
        tone: 'error',
        message: `${source.name ?? 'Image'} could not be decoded: ${messageOf(error)}`,
      });
    } finally {
      hooks.onSettled(id);
    }
  }
}

/**
 * Turn an ingest result into the notices a person should see.
 *
 * The `large` warning is always surfaced: it is the whole reason the engine
 * emits one, and burying it defeats the purpose. `downscaled` is surfaced
 * because a silently resized image is a surprise the next time the author zooms
 * in. `format-fallback` is informational.
 */
export function noticesFor(image: IngestedImage): readonly ImageNotice[] {
  const out: ImageNotice[] = [];
  for (const warning of image.warnings) {
    switch (warning.code) {
      case 'large':
        out.push({
          id: `${image.src.slice(0, 32)}:large`,
          tone: 'warning',
          message: `${image.alt === '' ? 'This image' : image.alt} is ${formatBytes(
            image.byteLength,
          )} and is stored inline as base64, which adds about ${formatBytes(
            base64Overhead(image.byteLength),
          )} to the .mdv file.`,
        });
        break;
      case 'downscaled':
        out.push({
          id: `${image.src.slice(0, 32)}:downscaled`,
          tone: 'info',
          message: `Scaled down from ${String(image.sourceWidth)}×${String(
            image.sourceHeight,
          )} to ${String(image.width)}×${String(image.height)} to keep the document small.`,
        });
        break;
      case 'format-fallback':
        out.push({
          id: `${image.src.slice(0, 32)}:format`,
          tone: 'info',
          message: warning.message,
        });
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Document weight                                                             */
/* -------------------------------------------------------------------------- */

/** What the embedded images in a document cost. */
export interface EmbeddedWeight {
  readonly count: number;
  /** Characters the `data:` URIs occupy in the serialised `.mdv`. */
  readonly characters: number;
  /** Decoded byte count those URIs represent. */
  readonly bytes: number;
}

/**
 * Total weight of every embedded image in the document.
 *
 * Counted from the `data:` URIs rather than from `write(doc).length` so it stays
 * O(images) and can be recomputed on every keystroke without anybody noticing.
 */
export function embeddedWeight(doc: MdvDocument): EmbeddedWeight {
  let count = 0;
  let characters = 0;
  let bytes = 0;
  for (const location of allBlocks(doc)) {
    const src = imageSrcOf(location.block);
    if (src === null || !engineImages.isEmbedded(src)) continue;
    count += 1;
    characters += src.length;
    bytes += base64Bytes(src);
  }
  return { count, characters, bytes };
}

function imageSrcOf(block: Block): string | null {
  return block.kind === 'image' ? block.src : null;
}

/** Decoded byte count behind a `data:…;base64,…` URI. */
export function base64Bytes(src: string): number {
  const comma = src.indexOf(',');
  if (comma === -1) return 0;
  const payload = src.slice(comma + 1);
  let padding = 0;
  if (payload.endsWith('==')) padding = 2;
  else if (payload.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

/** Extra characters base64 adds on top of `bytes`. */
export function base64Overhead(bytes: number): number {
  return Math.ceil(bytes / 3) * 4 - bytes;
}

/** Human-readable byte count. Binary units, one decimal above a kibibyte. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${round1(kib)} KB`;
  const mib = kib / 1024;
  if (mib < 1024) return `${round1(mib)} MB`;
  return `${round1(mib / 1024)} GB`;
}

function round1(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

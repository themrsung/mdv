/**
 * Images arriving from the clipboard or a drag-and-drop.
 *
 * Pasting a screenshot and dropping a PNG are the same operation as far as the
 * document is concerned: ingest the bytes, then insert an image block. The only
 * difference is where the drop lands, which the caller decides by setting the
 * selection first.
 *
 * Ingestion is asynchronous — decoding and re-encoding cannot be otherwise — so
 * this module exposes an async function that *produces* a command rather than a
 * command that does async work. Commands stay synchronous and pure, and the
 * caller keeps control of what happens if the user typed while the image was
 * being processed.
 */

import type { Command } from '../state.js';
import type {
  IngestedImage,
  IngestOptions,
  ImageEnvironment,
  ImageSource,
} from '../image/index.js';
import { ingestImage } from '../image/index.js';
import { insertImage } from '../commands/insert.js';
import type { ClipboardPayload } from './payload.js';

/** An ingested image plus the command that will insert it. */
export interface PreparedImage {
  readonly image: IngestedImage;
  readonly command: Command;
}

/** Ingest one blob and build the command that inserts it. */
export async function prepareImage(
  source: ImageSource,
  env: ImageEnvironment,
  options: IngestOptions = {},
): Promise<PreparedImage> {
  const image = await ingestImage(source, env, options);
  return { image, command: commandFor(image) };
}

/**
 * Ingest every image in a payload, in order.
 *
 * Failures are reported rather than thrown: dropping five files of which one is
 * a corrupt JPEG should insert four images and one complaint, not nothing.
 */
export async function prepareImages(
  payload: ClipboardPayload,
  env: ImageEnvironment,
  options: IngestOptions = {},
): Promise<{ readonly prepared: readonly PreparedImage[]; readonly failures: readonly Error[] }> {
  const prepared: PreparedImage[] = [];
  const failures: Error[] = [];
  for (const source of payload.images) {
    try {
      prepared.push(await prepareImage(source, env, options));
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return { prepared, failures };
}

/** The insertion command for an already-ingested image. */
export function commandFor(image: IngestedImage): Command {
  return insertImage(image.src, {
    alt: image.alt,
    ...(image.width > 0 ? { width: image.width } : {}),
    ...(image.height > 0 ? { height: image.height } : {}),
  });
}

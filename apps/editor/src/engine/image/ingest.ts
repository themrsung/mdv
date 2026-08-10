/**
 * Turning a dropped file into an image block.
 *
 * The editor stores images as base64 data URIs inside the document, which is
 * what makes a `.mdv` file a single self-contained artefact. The cost is that
 * a careless 12-megapixel phone photo would add eight megabytes of base64 to
 * a text file, so ingestion is where the engine earns its keep:
 *
 * - decode the blob and read its intrinsic size;
 * - if either dimension exceeds `maxDimension`, scale down proportionally;
 * - re-encode to a sensible format, preferring the smaller of the candidates;
 * - hand back a data URI plus the *intrinsic* width and height, so the UI can
 *   reserve layout space before the image paints;
 * - warn — never fail — when the result is still bigger than `warnBytes`.
 *
 * Nothing here touches a global. Everything comes through {@link ImageEnvironment},
 * so the entire pipeline is exercised in Node by the unit tests.
 */

import { EngineError } from '../errors.js';
import type { DecodedImage, EncodedImage, ImageEnvironment, ImageSource } from './env.js';

/** Knobs, all optional, all with defensible defaults. */
export interface IngestOptions {
  /**
   * Longest allowed edge in pixels. Larger images are scaled down
   * proportionally. Defaults to 2048, which covers a retina full-width image.
   */
  readonly maxDimension?: number;
  /**
   * Preferred output type. Defaults to `image/webp` when the environment
   * supports it, otherwise `image/jpeg` for photos and `image/png` otherwise.
   */
  readonly mimeType?: string;
  /** Lossy quality in `[0, 1]`. Defaults to 0.82. */
  readonly quality?: number;
  /**
   * Encoded size, in bytes, past which the result carries a warning.
   * Defaults to 512 KiB.
   *
   * Doubles as the budget below which a correctly-sized file is embedded
   * untouched. Setting it to 0 silences the warning without disabling that.
   */
  readonly warnBytes?: number;
  /**
   * Embed the original bytes instead of re-encoding, where that is the better
   * outcome. Default true.
   *
   * It applies in three situations: the file already fits and is already small,
   * so re-encoding could only churn bytes; re-encoding was tried and produced a
   * *larger* file; or the format cannot survive a canvas round trip at all
   * (SVG, animated GIF), where it is not optional.
   */
  readonly passthrough?: boolean;
  /** Alt text for the resulting block. Defaults to the file name, else `''`. */
  readonly alt?: string;
}

/** Why a result is worth mentioning to the user. */
export type IngestWarningCode =
  /** The encoded image is larger than `warnBytes`. */
  | 'large'
  /** The image was scaled down to fit `maxDimension`. */
  | 'downscaled'
  /** The requested output type was unavailable and a fallback was used. */
  | 'format-fallback';

/** A non-fatal remark about an ingested image. */
export interface IngestWarning {
  readonly code: IngestWarningCode;
  readonly message: string;
}

/** Everything ingestion learned about the image. */
export interface IngestedImage {
  /** `data:<mime>;base64,<payload>` — ready to drop into an image block. */
  readonly src: string;
  /** Alt text, from options or the file name. */
  readonly alt: string;
  /** Intrinsic width *after* any downscaling. */
  readonly width: number;
  /** Intrinsic height after any downscaling. */
  readonly height: number;
  /** The size the image was decoded at, before downscaling. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /** Output MIME type, which may differ from the requested one. */
  readonly mimeType: string;
  /** Encoded byte count, before base64 expansion. */
  readonly byteLength: number;
  /** True when the original bytes were kept verbatim. */
  readonly passthrough: boolean;
  readonly warnings: readonly IngestWarning[];
}

const DEFAULTS = {
  maxDimension: 2048,
  quality: 0.82,
  warnBytes: 512 * 1024,
  passthrough: true,
} as const;

/** Types we are willing to keep byte-for-byte rather than re-encode. */
const PASSTHROUGH_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']);

/** Types that must never be rasterised: doing so would be strictly destructive. */
const VECTOR_TYPES = new Set(['image/svg+xml']);

/** Types whose animation would be destroyed by a canvas round-trip. */
const ANIMATED_TYPES = new Set(['image/gif', 'image/apng']);

/**
 * Ingest one blob.
 *
 * @throws {EngineError} `IMAGE_DECODE_FAILED` when the blob is not an image the
 * environment can decode, or `ENV_UNAVAILABLE` when the host lacks the needed
 * APIs. Both are recoverable: the caller should show the message and carry on.
 */
export async function ingestImage(
  source: ImageSource,
  env: ImageEnvironment,
  options: IngestOptions = {},
): Promise<IngestedImage> {
  const maxDimension = Math.max(1, Math.trunc(options.maxDimension ?? DEFAULTS.maxDimension));
  const quality = clamp01(options.quality ?? DEFAULTS.quality);
  const warnBytes = Math.max(0, Math.trunc(options.warnBytes ?? DEFAULTS.warnBytes));
  const allowPassthrough = options.passthrough ?? DEFAULTS.passthrough;
  // How large a correctly-sized file may be before it is worth re-encoding.
  // `warnBytes: 0` means "stop warning me", not "stop optimising", so the
  // default budget still applies in that case.
  const passthroughBudget = warnBytes > 0 ? warnBytes : DEFAULTS.warnBytes;
  const alt = options.alt ?? baseName(source.name) ?? '';
  const warnings: IngestWarning[] = [];

  if (!source.type.startsWith('image/')) {
    throw new EngineError('IMAGE_DECODE_FAILED', 'the file is not an image', { type: source.type });
  }

  // Vector images have no meaningful pixel size and rasterising them throws
  // away the thing that makes them useful. Embed them exactly as they are.
  if (VECTOR_TYPES.has(source.type)) {
    const bytes = new Uint8Array(await source.arrayBuffer());
    const base64 = env.toBase64(bytes);
    pushLarge(warnings, bytes.byteLength, warnBytes);
    return {
      src: dataUri(source.type, base64),
      alt,
      width: 0,
      height: 0,
      sourceWidth: 0,
      sourceHeight: 0,
      mimeType: source.type,
      byteLength: bytes.byteLength,
      passthrough: true,
      warnings,
    };
  }

  const decoded = await env.decode(source);
  const sourceWidth = Math.max(1, Math.round(decoded.width));
  const sourceHeight = Math.max(1, Math.round(decoded.height));
  const target = fit(sourceWidth, sourceHeight, maxDimension);
  const scaled = target.width !== sourceWidth || target.height !== sourceHeight;

  try {
    // An animated image survives only untouched, so it is passthrough or nothing
    // — even when it is oversized, a still first frame is the worse outcome.
    const mustPassthrough = ANIMATED_TYPES.has(source.type);
    // A file that needs no scaling *and* is already small is embedded as it
    // came. Re-encoding it could only churn bytes for no gain. Being oversized
    // in bytes is a different matter: a 1000×800 screenshot can still be eight
    // megabytes of PNG, and that one is worth re-encoding even though its
    // dimensions are fine.
    const alreadySmall =
      allowPassthrough &&
      !scaled &&
      PASSTHROUGH_TYPES.has(source.type) &&
      source.size > 0 &&
      source.size <= passthroughBudget;

    if (mustPassthrough || alreadySmall) {
      const bytes = new Uint8Array(await source.arrayBuffer());
      const base64 = env.toBase64(bytes);
      if (scaled) {
        warnings.push({
          code: 'downscaled',
          message: `the image is ${sourceWidth}×${sourceHeight}, larger than the ${maxDimension}px limit, but its format cannot be resized without losing animation`,
        });
      }
      pushLarge(warnings, bytes.byteLength, warnBytes);
      return {
        src: dataUri(source.type, base64),
        alt,
        width: sourceWidth,
        height: sourceHeight,
        sourceWidth,
        sourceHeight,
        mimeType: source.type,
        byteLength: bytes.byteLength,
        passthrough: true,
        warnings,
      };
    }

    const requested = options.mimeType ?? preferredType(source.type, env);
    let encoded = await encodeAs(env, decoded, target, requested, quality);
    if (encoded.mimeType !== requested) {
      warnings.push({
        code: 'format-fallback',
        message: `${requested} is not supported here; encoded as ${encoded.mimeType} instead`,
      });
    }

    // Re-encoding is supposed to save space. When it did not — a flat PNG turned
    // into a larger JPEG, say — keep the original, as long as it still fits.
    if (allowPassthrough && !scaled && PASSTHROUGH_TYPES.has(source.type) && source.size > 0 && source.size < encoded.byteLength) {
      const bytes = new Uint8Array(await source.arrayBuffer());
      encoded = { mimeType: source.type, base64: env.toBase64(bytes), byteLength: bytes.byteLength };
      pushLarge(warnings, encoded.byteLength, warnBytes);
      return {
        src: dataUri(encoded.mimeType, encoded.base64),
        alt,
        width: target.width,
        height: target.height,
        sourceWidth,
        sourceHeight,
        mimeType: encoded.mimeType,
        byteLength: encoded.byteLength,
        passthrough: true,
        warnings,
      };
    }

    if (scaled) {
      warnings.push({
        code: 'downscaled',
        message: `scaled from ${sourceWidth}×${sourceHeight} to ${target.width}×${target.height} to fit the ${maxDimension}px limit`,
      });
    }
    pushLarge(warnings, encoded.byteLength, warnBytes);

    return {
      src: dataUri(encoded.mimeType, encoded.base64),
      alt,
      width: target.width,
      height: target.height,
      sourceWidth,
      sourceHeight,
      mimeType: encoded.mimeType,
      byteLength: encoded.byteLength,
      passthrough: false,
      warnings,
    };
  } finally {
    decoded.close?.();
  }
}

/**
 * The size an image should be drawn at to fit inside a square of `max`.
 *
 * Exported because the UI wants the same arithmetic when it shows a preview.
 * Never upscales, never returns a zero dimension, and rounds so the aspect
 * ratio drifts by less than half a pixel.
 */
export function fit(
  width: number,
  height: number,
  max: number,
): { readonly width: number; readonly height: number } {
  const longest = Math.max(width, height);
  if (longest <= max) return { width, height };
  const ratio = max / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/** Assemble a data URI. */
export function dataUri(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

/**
 * Pull the pieces back out of a data URI, or `undefined` when it is not one.
 *
 * Used to tell an embedded image from a linked one, which is the difference
 * between "this document is self-contained" and "this document has a
 * dependency" — worth surfacing in the UI.
 */
export function parseDataUri(
  src: string,
): { readonly mimeType: string; readonly base64: string; readonly byteLength: number } | undefined {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/.exec(src);
  if (!match) return undefined;
  const mimeType = match[1] ?? '';
  const base64 = match[2] ?? '';
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return { mimeType, base64, byteLength: Math.max(0, Math.floor((base64.length * 3) / 4) - padding) };
}

/** True when `src` embeds its bytes rather than pointing at them. */
export function isEmbedded(src: string): boolean {
  return src.startsWith('data:');
}

async function encodeAs(
  env: ImageEnvironment,
  image: DecodedImage,
  target: { readonly width: number; readonly height: number },
  mimeType: string,
  quality: number,
): Promise<EncodedImage> {
  const type = env.supports(mimeType) ? mimeType : 'image/png';
  const encoded = await env.encode(image, target.width, target.height, type, quality);
  if (encoded.base64 === '') {
    throw new EngineError('IMAGE_DECODE_FAILED', 'the image encoded to zero bytes', { mimeType: type });
  }
  return encoded;
}

/**
 * Which format to aim for.
 *
 * WebP when available: it beats both JPEG and PNG on essentially every input
 * and every target browser has supported it for years. Otherwise keep the
 * source's own family, because a photo should not become a PNG and a screenshot
 * should not become a JPEG.
 */
function preferredType(sourceType: string, env: ImageEnvironment): string {
  if (env.supports('image/webp')) return 'image/webp';
  if (sourceType === 'image/jpeg') return 'image/jpeg';
  return 'image/png';
}

function pushLarge(warnings: IngestWarning[], byteLength: number, warnBytes: number): void {
  if (warnBytes <= 0 || byteLength <= warnBytes) return;
  warnings.push({
    code: 'large',
    message: `the embedded image is ${formatBytes(byteLength)}, above the ${formatBytes(warnBytes)} threshold; consider linking to it instead`,
  });
}

/**
 * Byte counts for humans.
 *
 * Deliberately not `Intl.NumberFormat`: warning text ends up in snapshots and
 * in the document, and locale-dependent output would make those non-deterministic
 * (SPEC 17.3).
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${round1(bytes / 1024)} KiB`;
  return `${round1(bytes / (1024 * 1024))} MiB`;
}

function round1(value: number): string {
  const scaled = Math.round(value * 10);
  const whole = Math.trunc(scaled / 10);
  const fraction = Math.abs(scaled % 10);
  return fraction === 0 ? String(whole) : `${whole}.${fraction}`;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return DEFAULTS.quality;
  return Math.min(1, Math.max(0, value));
}

function baseName(name: string | undefined): string | undefined {
  if (name === undefined || name === '') return undefined;
  const last = name.split(/[\\/]/).pop() ?? name;
  const dot = last.lastIndexOf('.');
  const stem = dot > 0 ? last.slice(0, dot) : last;
  return stem === '' ? undefined : stem;
}

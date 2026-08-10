/**
 * The one place the engine admits that browsers exist.
 *
 * Image ingestion needs to decode bytes, draw them at a smaller size and
 * re-encode them; in a browser that is `createImageBitmap`, a canvas and
 * `toBlob`, none of which exist in Node. Rather than reach for them directly —
 * which would make the whole engine untestable outside a DOM — everything goes
 * through {@link ImageEnvironment}, a four-method interface that ingestion
 * receives as an argument.
 *
 * Production wires it to {@link browserImageEnvironment}. Tests wire it to a
 * dozen lines of fake that returns fixed dimensions and a fixed byte string,
 * and then assert on what ingestion did with them.
 */

import { EngineError } from '../errors.js';

/** Decoded pixel source, opaque to the engine: only its size is read. */
export interface DecodedImage {
  readonly width: number;
  readonly height: number;
  /** Whatever the environment's resize step accepts. */
  readonly source: unknown;
  /** Release native resources. Optional; called once, after resizing. */
  close?(): void;
}

/** Bytes plus their MIME type, as produced by encoding. */
export interface EncodedImage {
  readonly mimeType: string;
  /** Base64 payload without the `data:` prefix. */
  readonly base64: string;
  /** Decoded byte length, i.e. the size before base64 expansion. */
  readonly byteLength: number;
}

/** An image the engine is asked to ingest. Structurally a `Blob` or `File`. */
export interface ImageSource {
  readonly type: string;
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  /** Present on `File`; used as a fallback for alt text. */
  readonly name?: string;
}

/** The capabilities image ingestion needs from its host. */
export interface ImageEnvironment {
  /** Decode a blob to something with intrinsic dimensions. */
  decode(source: ImageSource): Promise<DecodedImage>;
  /**
   * Draw a decoded image at exactly `width` × `height` and encode the result.
   *
   * `quality` is in `[0, 1]` and is ignored by lossless formats.
   */
  encode(
    image: DecodedImage,
    width: number,
    height: number,
    mimeType: string,
    quality: number,
  ): Promise<EncodedImage>;
  /** Base64-encode raw bytes, for the pass-through path that skips re-encoding. */
  toBase64(bytes: Uint8Array): string;
  /** True when the environment can actually produce this output type. */
  supports(mimeType: string): boolean;
}

/**
 * A browser-backed environment.
 *
 * Built lazily and defensively: constructing it never touches a global, so
 * importing the engine in Node is safe. Calling into it without the globals
 * throws {@link EngineError} with code `ENV_UNAVAILABLE`, which is a far more
 * useful failure than `createImageBitmap is not defined`.
 */
export function browserImageEnvironment(): ImageEnvironment {
  return {
    async decode(source) {
      const create = globalOf<(blob: unknown) => Promise<ImageBitmapLike>>('createImageBitmap');
      if (!create) {
        throw new EngineError(
          'ENV_UNAVAILABLE',
          'createImageBitmap is not available in this environment',
        );
      }
      let bitmap: ImageBitmapLike;
      try {
        bitmap = await create(source);
      } catch (cause) {
        throw new EngineError('IMAGE_DECODE_FAILED', 'the image could not be decoded', {
          type: source.type,
          cause: String(cause),
        });
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        source: bitmap,
        close: () => bitmap.close?.(),
      };
    },

    async encode(image, width, height, mimeType, quality) {
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new EngineError('ENV_UNAVAILABLE', 'a 2d canvas context is not available');
      }
      context.drawImage(image.source as CanvasImageSourceLike, 0, 0, width, height);
      const blob = await canvasToBlob(canvas, mimeType, quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return {
        mimeType: blob.type || mimeType,
        base64: bytesToBase64(bytes),
        byteLength: bytes.byteLength,
      };
    },

    toBase64: (bytes) => bytesToBase64(bytes),

    supports(mimeType) {
      if (mimeType === 'image/png') return true;
      try {
        const canvas = createCanvas(1, 1);
        return canvas.toDataURL(mimeType).startsWith(`data:${mimeType}`);
      } catch {
        return false;
      }
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Structural shapes for the DOM bits we touch. Declaring them here keeps the  */
/* engine buildable without `lib.dom` and documents exactly how much DOM we    */
/* actually require, which is very little.                                     */
/* -------------------------------------------------------------------------- */

interface ImageBitmapLike {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

interface CanvasImageSourceLike {
  readonly width: number;
  readonly height: number;
}

interface BlobLike {
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

interface Context2DLike {
  drawImage(
    image: CanvasImageSourceLike,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void;
}

interface CanvasLike {
  width: number;
  height: number;
  getContext(id: '2d'): Context2DLike | null;
  toDataURL(type?: string, quality?: number): string;
  toBlob?(callback: (blob: BlobLike | null) => void, type?: string, quality?: number): void;
  convertToBlob?(options?: { type?: string; quality?: number }): Promise<BlobLike>;
}

function globalOf<T>(name: string): T | undefined {
  const scope = globalThis as unknown as Record<string, unknown>;
  const value = scope[name];
  return typeof value === 'function' || typeof value === 'object' ? (value as T) : undefined;
}

function createCanvas(width: number, height: number): CanvasLike {
  const OffscreenCanvasCtor = globalOf<new (w: number, h: number) => CanvasLike>('OffscreenCanvas');
  if (OffscreenCanvasCtor) return new OffscreenCanvasCtor(width, height);

  const document = globalOf<{ createElement(tag: string): CanvasLike }>('document');
  if (!document) {
    throw new EngineError('ENV_UNAVAILABLE', 'neither OffscreenCanvas nor document is available');
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function canvasToBlob(
  canvas: CanvasLike,
  mimeType: string,
  quality: number,
): Promise<BlobLike> {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type: mimeType, quality });
  const toBlob = canvas.toBlob;
  if (toBlob) {
    return new Promise<BlobLike>((resolve, reject) => {
      toBlob.call(
        canvas,
        (blob) => {
          if (blob) resolve(blob);
          else reject(new EngineError('IMAGE_DECODE_FAILED', 'the canvas produced no image data'));
        },
        mimeType,
        quality,
      );
    });
  }
  throw new EngineError('ENV_UNAVAILABLE', 'the canvas cannot be converted to a blob');
}

/**
 * Base64 without `Buffer` or `btoa`.
 *
 * Hand-rolled because the engine has no dependencies and must run identically
 * in Node and the browser; `btoa` also needs a binary string, which means
 * building a megabyte-long string only to throw it away.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const full = bytes.length - (bytes.length % 3);
  for (let i = 0; i < full; i += 3) {
    const word = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      (ALPHABET[(word >> 18) & 63] ?? '') +
      (ALPHABET[(word >> 12) & 63] ?? '') +
      (ALPHABET[(word >> 6) & 63] ?? '') +
      (ALPHABET[word & 63] ?? '');
  }
  const remainder = bytes.length - full;
  if (remainder === 1) {
    const word = (bytes[full] ?? 0) << 16;
    out += (ALPHABET[(word >> 18) & 63] ?? '') + (ALPHABET[(word >> 12) & 63] ?? '') + '==';
  } else if (remainder === 2) {
    const word = ((bytes[full] ?? 0) << 16) | ((bytes[full + 1] ?? 0) << 8);
    out +=
      (ALPHABET[(word >> 18) & 63] ?? '') +
      (ALPHABET[(word >> 12) & 63] ?? '') +
      (ALPHABET[(word >> 6) & 63] ?? '') +
      '=';
  }
  return out;
}

/** Inverse of {@link bytesToBase64}. Ignores whitespace; stops at padding. */
export function base64ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let index = 0;
  let word = 0;
  let bits = 0;
  for (const char of clean) {
    const value = ALPHABET.indexOf(char);
    if (value < 0) continue;
    word = (word << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index] = (word >> bits) & 0xff;
      index += 1;
    }
  }
  return out.subarray(0, index);
}

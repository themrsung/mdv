/**
 * Image ingestion.
 *
 * Images live inside the document as base64 data URIs, which is what makes a
 * `.mdv` file a single self-contained artefact — and also what makes a careless
 * 12-megapixel photo turn a text file into eight megabytes. Ingestion is the
 * gate: decode, downscale, re-encode, and warn.
 *
 * The whole pipeline runs against an injected {@link ImageEnvironment}, so
 * these tests need neither a DOM nor a real codec. The fake below is honest
 * about the one thing that matters — the relationship between pixel count and
 * byte count — so the "did re-encoding actually help?" decisions are exercised
 * for real rather than stubbed out.
 */

import { describe, expect, it } from 'vitest';

import { EngineError } from '../errors.js';
import {
  base64ToBytes,
  browserImageEnvironment,
  bytesToBase64,
  dataUri,
  fit,
  ingestImage,
  isEmbedded,
  parseDataUri,
} from '../image/index.js';
import type { DecodedImage, EncodedImage, ImageEnvironment, ImageSource } from '../image/index.js';

/** A blob-shaped source with deterministic bytes. */
function sourceOf(
  type: string,
  width: number,
  height: number,
  name?: string,
  size?: number,
): ImageSource {
  const bytes = new Uint8Array(size ?? width * height);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256;
  const base: ImageSource = {
    type,
    size: bytes.length,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer),
  };
  // `exactOptionalPropertyTypes` forbids assigning `undefined` to `name?`.
  return name === undefined ? base : { ...base, name };
}

/** Options a fake environment is built with. */
interface FakeOptions {
  /** MIME types the environment claims to encode. Defaults to PNG and WebP. */
  readonly supported?: readonly string[];
  /** Bytes produced per pixel when encoding. */
  readonly bytesPerPixel?: number;
  /** Throw on decode, to exercise the failure path. */
  readonly failDecode?: boolean;
}

interface Fake extends ImageEnvironment {
  /** Every `encode` call, in order, for asserting what the pipeline asked for. */
  readonly calls: { width: number; height: number; mimeType: string; quality: number }[];
  /** True once the decoded image was released. */
  closed(): boolean;
}

function fakeEnvironment(
  dimensions: { width: number; height: number },
  options: FakeOptions = {},
): Fake {
  const supported = new Set(options.supported ?? ['image/png', 'image/webp']);
  const bytesPerPixel = options.bytesPerPixel ?? 1;
  const calls: { width: number; height: number; mimeType: string; quality: number }[] = [];
  let closed = false;

  return {
    calls,
    closed: () => closed,
    decode(): Promise<DecodedImage> {
      if (options.failDecode === true) {
        return Promise.reject(new EngineError('IMAGE_DECODE_FAILED', 'unreadable'));
      }
      return Promise.resolve({
        width: dimensions.width,
        height: dimensions.height,
        source: 'pixels',
        close() {
          closed = true;
        },
      });
    },
    encode(_image, width, height, mimeType, quality): Promise<EncodedImage> {
      calls.push({ width, height, mimeType, quality });
      const byteLength = Math.max(1, Math.round(width * height * bytesPerPixel));
      const bytes = new Uint8Array(byteLength);
      for (let i = 0; i < byteLength; i += 1) bytes[i] = (i * 7) % 256;
      return Promise.resolve({ mimeType, base64: bytesToBase64(bytes), byteLength });
    },
    toBase64: (bytes) => bytesToBase64(bytes),
    supports: (mimeType) => supported.has(mimeType),
  };
}

describe('fit', () => {
  it('never upscales', () => {
    expect(fit(100, 50, 2048)).toEqual({ width: 100, height: 50 });
  });

  it('scales the longest side to the limit and keeps the ratio', () => {
    expect(fit(4000, 2000, 1000)).toEqual({ width: 1000, height: 500 });
    expect(fit(2000, 4000, 1000)).toEqual({ width: 500, height: 1000 });
  });

  it('never returns a zero dimension for an extreme ratio', () => {
    const result = fit(10000, 3, 100);
    expect(result.width).toBe(100);
    expect(result.height).toBe(1);
  });

  it('is exactly at the boundary, not one either side', () => {
    expect(fit(2048, 1024, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(fit(2049, 1024, 2048)).toEqual({ width: 2048, height: 1024 });
  });
});

describe('data URIs', () => {
  it('round-trip through parseDataUri', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const uri = dataUri('image/png', bytesToBase64(bytes));
    const parsed = parseDataUri(uri);
    expect(parsed?.mimeType).toBe('image/png');
    expect(parsed && base64ToBytes(parsed.base64)).toEqual(bytes);
  });

  it('report a byte length that matches the payload', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length);
      const parsed = parseDataUri(dataUri('image/png', bytesToBase64(bytes)));
      expect(parsed?.byteLength).toBe(length);
    }
  });

  it('reject anything that is not one', () => {
    expect(parseDataUri('https://example.com/a.png')).toBeUndefined();
    expect(parseDataUri('data:image/png,notbase64')).toBeUndefined();
    expect(isEmbedded('https://example.com/a.png')).toBe(false);
    expect(isEmbedded('data:image/png;base64,AAAA')).toBe(true);
  });
});

describe('base64', () => {
  it('round-trips every byte value', () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('handles all three padding cases', () => {
    for (const length of [0, 1, 2, 3, 4, 5]) {
      const bytes = new Uint8Array(length).fill(0xab);
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it('produces the encoding everyone else produces', () => {
    // "Man" — the canonical RFC 4648 example.
    expect(bytesToBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
    expect(bytesToBase64(new Uint8Array([77, 97]))).toBe('TWE=');
    expect(bytesToBase64(new Uint8Array([77]))).toBe('TQ==');
  });
});

describe('ingesting a small image', () => {
  it('keeps its intrinsic size and reports it', async () => {
    const env = fakeEnvironment({ width: 800, height: 600 });
    const result = await ingestImage(sourceOf('image/png', 40, 30, 'holiday.png'), env, {
      passthrough: false,
    });

    expect(result.sourceWidth).toBe(800);
    expect(result.sourceHeight).toBe(600);
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
    expect(result.warnings).toEqual([]);
    expect(isEmbedded(result.src)).toBe(true);
  });

  it('takes its alt text from the file name, without the extension', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    const result = await ingestImage(sourceOf('image/png', 4, 4, 'photos/My Holiday.png'), env, {
      passthrough: false,
    });
    expect(result.alt).toBe('My Holiday');
  });

  it('prefers explicit alt text over the file name', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    const result = await ingestImage(sourceOf('image/png', 4, 4, 'dsc_0001.png'), env, {
      alt: 'A view of the lake',
      passthrough: false,
    });
    expect(result.alt).toBe('A view of the lake');
  });

  it('is content with no name at all', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    const result = await ingestImage(sourceOf('image/png', 4, 4), env, { passthrough: false });
    expect(result.alt).toBe('');
  });
});

describe('downscaling', () => {
  it('shrinks an oversized image and says so', async () => {
    const env = fakeEnvironment({ width: 4000, height: 3000 });
    const result = await ingestImage(sourceOf('image/jpeg', 100, 100), env, { maxDimension: 1000 });

    expect(result.width).toBe(1000);
    expect(result.height).toBe(750);
    expect(result.sourceWidth).toBe(4000);
    expect(env.calls).toHaveLength(1);
    expect(env.calls[0]?.width).toBe(1000);
    expect(env.calls[0]?.height).toBe(750);
    expect(result.warnings.map((warning) => warning.code)).toContain('downscaled');
  });

  it('leaves an image at the limit untouched', async () => {
    const env = fakeEnvironment({ width: 2048, height: 100 });
    const result = await ingestImage(sourceOf('image/png', 10, 10), env, { passthrough: false });
    expect(result.width).toBe(2048);
    expect(result.warnings).toEqual([]);
  });

  it('honours a custom maxDimension and refuses a nonsensical one', async () => {
    const env = fakeEnvironment({ width: 900, height: 900 });
    const tiny = await ingestImage(sourceOf('image/png', 10, 10), env, { maxDimension: 64 });
    expect(tiny.width).toBe(64);

    const zero = await ingestImage(sourceOf('image/png', 10, 10), env, { maxDimension: 0 });
    expect(zero.width).toBe(1);
    expect(zero.height).toBe(1);
  });

  it('releases the decoded image afterwards', async () => {
    const env = fakeEnvironment({ width: 4000, height: 3000 });
    await ingestImage(sourceOf('image/jpeg', 100, 100), env, { maxDimension: 1000 });
    expect(env.closed()).toBe(true);
  });
});

describe('format selection', () => {
  it('prefers WebP when the environment can produce it', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    const result = await ingestImage(sourceOf('image/jpeg', 10, 10), env, { passthrough: false });
    expect(result.mimeType).toBe('image/webp');
    expect(result.src.startsWith('data:image/webp;base64,')).toBe(true);
  });

  it('keeps JPEG a JPEG when WebP is unavailable', async () => {
    const env = fakeEnvironment(
      { width: 100, height: 100 },
      { supported: ['image/png', 'image/jpeg'] },
    );
    const result = await ingestImage(sourceOf('image/jpeg', 10, 10), env, { passthrough: false });
    expect(result.mimeType).toBe('image/jpeg');
  });

  it('falls back to PNG and warns when the requested type is unsupported', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 }, { supported: ['image/png'] });
    const result = await ingestImage(sourceOf('image/png', 10, 10), env, {
      mimeType: 'image/avif',
      passthrough: false,
    });

    expect(result.mimeType).toBe('image/png');
    expect(result.warnings.map((warning) => warning.code)).toContain('format-fallback');
    expect(
      result.warnings.find((warning) => warning.code === 'format-fallback')?.message,
    ).toContain('image/avif');
  });

  it('respects an explicitly requested type that is supported', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    const result = await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      mimeType: 'image/png',
      passthrough: false,
    });
    expect(result.mimeType).toBe('image/png');
    expect(result.warnings).toEqual([]);
  });

  it('passes the quality through, clamped to [0, 1]', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    await ingestImage(sourceOf('image/jpeg', 10, 10), env, { quality: 0.4, passthrough: false });
    await ingestImage(sourceOf('image/jpeg', 10, 10), env, { quality: 9, passthrough: false });
    await ingestImage(sourceOf('image/jpeg', 10, 10), env, { quality: -3, passthrough: false });
    await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      quality: Number.NaN,
      passthrough: false,
    });

    expect(env.calls.map((call) => call.quality)).toEqual([0.4, 1, 0, 0.82]);
  });
});

describe('pass-through', () => {
  it('embeds an already-small PNG without re-encoding it', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    const result = await ingestImage(sourceOf('image/png', 10, 10), env);

    expect(result.passthrough).toBe(true);
    expect(env.calls).toHaveLength(0);
    expect(result.mimeType).toBe('image/png');
  });

  it('never rasterises an animated GIF, even an oversized one', async () => {
    const env = fakeEnvironment({ width: 5000, height: 5000 });
    const result = await ingestImage(sourceOf('image/gif', 30, 30), env, {
      maxDimension: 500,
      passthrough: false,
    });

    expect(result.passthrough).toBe(true);
    expect(env.calls).toHaveLength(0);
    expect(result.mimeType).toBe('image/gif');
    // The user still deserves to know it was left large.
    const downscaled = result.warnings.find((warning) => warning.code === 'downscaled');
    expect(downscaled?.message).toContain('animation');
  });

  it('embeds SVG verbatim rather than rasterising it', async () => {
    const env = fakeEnvironment({ width: 0, height: 0 });
    const result = await ingestImage(sourceOf('image/svg+xml', 20, 20, 'logo.svg'), env);

    expect(result.passthrough).toBe(true);
    expect(result.mimeType).toBe('image/svg+xml');
    expect(env.calls).toHaveLength(0);
    // A vector has no pixel size to report, and inventing one would be a lie.
    expect(result.width).toBe(0);
    expect(result.height).toBe(0);
    expect(result.alt).toBe('logo');
  });

  it('embeds a correctly-sized file below the budget without asking the codec', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    const source = sourceOf('image/png', 1, 1, 'small.png', 4_000);
    const result = await ingestImage(source, env, { passthrough: true, warnBytes: 10_000 });

    expect(result.passthrough).toBe(true);
    expect(env.calls).toHaveLength(0);
    expect(result.byteLength).toBe(4_000);
  });

  it('re-encodes a correctly-sized file that is nonetheless enormous', async () => {
    // The 1000×800 screenshot that weighs eight megabytes: its dimensions are
    // fine, so the old rule left it alone and the document paid for it.
    const env = fakeEnvironment({ width: 1000, height: 800 }, { bytesPerPixel: 0.05 });
    const source = sourceOf('image/png', 1, 1, 'screenshot.png', 8_000_000);
    const result = await ingestImage(source, env, { passthrough: true });

    expect(result.passthrough).toBe(false);
    expect(env.calls).toHaveLength(1);
    expect(result.byteLength).toBeLessThan(8_000_000);
  });

  it('reverts to the original when re-encoding made the file bigger', async () => {
    // Above the budget, so it is re-encoded — but the fake codec charges four
    // bytes a pixel and produces something worse than what came in.
    const env = fakeEnvironment({ width: 100, height: 100 }, { bytesPerPixel: 4 });
    const source = sourceOf('image/png', 1, 1, 'flat.png', 20_000);
    const result = await ingestImage(source, env, {
      passthrough: true,
      warnBytes: 1_000,
      mimeType: 'image/png',
    });

    expect(env.calls).toHaveLength(1);
    expect(result.passthrough).toBe(true);
    expect(result.byteLength).toBe(20_000);
  });

  it('is skipped entirely when the caller disables it', async () => {
    const env = fakeEnvironment({ width: 100, height: 100 });
    const result = await ingestImage(sourceOf('image/png', 10, 10), env, { passthrough: false });
    expect(result.passthrough).toBe(false);
    expect(env.calls).toHaveLength(1);
  });
});

describe('size warnings', () => {
  it('warn above the threshold with a readable size', async () => {
    const env = fakeEnvironment({ width: 2000, height: 2000 });
    const result = await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      maxDimension: 4000,
      warnBytes: 1024,
      passthrough: false,
    });

    const large = result.warnings.find((warning) => warning.code === 'large');
    expect(large).toBeDefined();
    expect(large?.message).toContain('MiB');
  });

  it('stay quiet below it', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    const result = await ingestImage(sourceOf('image/png', 4, 4), env, {
      warnBytes: 1024,
      passthrough: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it('can be switched off with a zero threshold', async () => {
    const env = fakeEnvironment({ width: 2000, height: 2000 });
    const result = await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      maxDimension: 4000,
      warnBytes: 0,
      passthrough: false,
    });
    expect(result.warnings.some((warning) => warning.code === 'large')).toBe(false);
  });

  it('are worded the same on every machine', async () => {
    // Locale-dependent number formatting would make warning text — which the UI
    // may store or snapshot — non-deterministic. SPEC 17.3.
    const env = fakeEnvironment({ width: 1000, height: 1000 });
    const first = await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      warnBytes: 1000,
      passthrough: false,
    });
    const second = await ingestImage(sourceOf('image/jpeg', 10, 10), env, {
      warnBytes: 1000,
      passthrough: false,
    });

    expect(first.warnings).toEqual(second.warnings);
    expect(first.warnings[0]?.message).toMatch(
      /^the embedded image is [\d.]+ (B|KiB|MiB), above the/u,
    );
  });
});

describe('failures', () => {
  it('rejects a file that is not an image at all', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    await expect(ingestImage(sourceOf('application/pdf', 10, 10), env)).rejects.toThrow(
      EngineError,
    );
    await expect(ingestImage(sourceOf('application/pdf', 10, 10), env)).rejects.toMatchObject({
      code: 'IMAGE_DECODE_FAILED',
    });
  });

  it('surfaces a decode failure as a recoverable engine error', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 }, { failDecode: true });
    await expect(
      ingestImage(sourceOf('image/png', 10, 10), env, { passthrough: false }),
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
  });

  it('treats an empty encode result as a failure rather than writing an empty image', async () => {
    const env = fakeEnvironment({ width: 10, height: 10 });
    const broken: ImageEnvironment = {
      ...env,
      encode: () => Promise.resolve({ mimeType: 'image/png', base64: '', byteLength: 0 }),
    };

    await expect(
      ingestImage(sourceOf('image/png', 10, 10), broken, { passthrough: false }),
    ).rejects.toMatchObject({ code: 'IMAGE_DECODE_FAILED' });
  });
});

describe('the browser environment', () => {
  it('can be constructed in Node without touching a global', () => {
    // Merely importing the engine on a server must not explode. The failure
    // arrives later, with a useful code, only if it is actually used.
    expect(() => browserImageEnvironment()).not.toThrow();
  });

  it('reports honestly that it supports nothing here', () => {
    const env = browserImageEnvironment();
    expect(env.supports('image/webp')).toBe(false);
  });

  it('fails with ENV_UNAVAILABLE rather than a ReferenceError', async () => {
    const env = browserImageEnvironment();
    await expect(env.decode(sourceOf('image/png', 4, 4))).rejects.toMatchObject({
      code: 'ENV_UNAVAILABLE',
    });
  });

  it('still encodes base64 without any DOM', () => {
    const env = browserImageEnvironment();
    expect(env.toBase64(new Uint8Array([77, 97, 110]))).toBe('TWFu');
  });
});

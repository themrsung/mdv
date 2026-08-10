/**
 * The UI's half of image ingestion: progress, notices and document weight.
 *
 * The decoder is injected, so all of it runs in Node against a fake that
 * returns fixed dimensions. What is being specified here is not "can we decode
 * a PNG" — that is the browser's job — but the things the interface promises:
 * every blob reports a pending state, one corrupt file does not lose the rest
 * of the batch, and the author is told what inline base64 costs.
 */

import { describe, expect, it } from 'vitest';
import { createEditor } from '../../engine/index.js';
import type {
  DecodedImage,
  EncodedImage,
  ImageEnvironment,
  ImageSource,
  IngestedImage,
  IngestWarning,
} from '../../engine/image/index.js';
import type { ImageNotice, PendingImage } from '../input/images.js';
import {
  base64Bytes,
  base64Overhead,
  embeddedWeight,
  formatBytes,
  ingestBatch,
  noticesFor,
} from '../input/images.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

interface EnvOptions {
  readonly width?: number;
  readonly height?: number;
  readonly failDecode?: string;
}

function fakeEnv(options: EnvOptions = {}): ImageEnvironment {
  const width = options.width ?? 800;
  const height = options.height ?? 600;
  return {
    decode(): Promise<DecodedImage> {
      if (options.failDecode !== undefined) return Promise.reject(new Error(options.failDecode));
      return Promise.resolve({ width, height, source: null });
    },
    encode(_image, w, h, mimeType): Promise<EncodedImage> {
      const byteLength = Math.max(1, Math.round((w * h) / 100));
      return Promise.resolve({ mimeType, base64: 'A'.repeat(byteLength * 2), byteLength });
    },
    toBase64(bytes: Uint8Array): string {
      return 'B'.repeat(Math.ceil(bytes.length / 3) * 4);
    },
    supports(): boolean {
      return true;
    },
  };
}

function source(name: string | null, size = 1024, type = 'image/png'): ImageSource {
  const base = {
    type,
    size,
    arrayBuffer: (): Promise<ArrayBuffer> => Promise.resolve(new ArrayBuffer(size)),
  };
  return name === null ? base : { ...base, name };
}

/** Collects everything `ingestBatch` reports, in the order it reports it. */
function recorder(): {
  readonly log: string[];
  readonly pending: PendingImage[];
  readonly failures: ImageNotice[];
  readonly hooks: Parameters<typeof ingestBatch>[2];
} {
  const log: string[] = [];
  const pending: PendingImage[] = [];
  const failures: ImageNotice[] = [];
  return {
    log,
    pending,
    failures,
    hooks: {
      onPending(item): void {
        pending.push(item);
        log.push(`pending:${item.name}`);
      },
      onReady(id): void {
        log.push(`ready:${id}`);
      },
      onFailed(id, notice): void {
        failures.push(notice);
        log.push(`failed:${id}`);
      },
      onSettled(id): void {
        log.push(`settled:${id}`);
      },
    },
  };
}

const ingested = (
  warnings: readonly IngestWarning[],
  over: Partial<IngestedImage> = {},
): IngestedImage => ({
  src: 'data:image/png;base64,AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIII',
  alt: 'A photo',
  width: 1024,
  height: 768,
  sourceWidth: 4096,
  sourceHeight: 3072,
  mimeType: 'image/png',
  byteLength: 900_000,
  passthrough: false,
  warnings,
  ...over,
});

/* -------------------------------------------------------------------------- */

describe('ingesting a batch', () => {
  it('announces each blob before decoding it, and settles it afterwards', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png')], fakeEnv(), rec.hooks);
    expect(rec.log[0]).toBe('pending:a.png');
    expect(rec.log[1]?.startsWith('ready:')).toBe(true);
    expect(rec.log[2]?.startsWith('settled:')).toBe(true);
  });

  it('keeps the drop order', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png'), source('b.png'), source('c.png')], fakeEnv(), rec.hooks);
    expect(rec.pending.map((item) => item.name)).toEqual(['a.png', 'b.png', 'c.png']);
  });

  it('is sequential, so the first image is not held up by the last', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png'), source('b.png')], fakeEnv(), rec.hooks);
    // Not pending, pending, ready, ready: each blob finishes before the next starts.
    expect(rec.log.filter((line) => line.startsWith('pending:'))).toEqual([
      'pending:a.png',
      'pending:b.png',
    ]);
    expect(rec.log.indexOf('pending:b.png')).toBeGreaterThan(
      rec.log.findIndex((line) => line.startsWith('ready:')),
    );
  });

  it('labels a clipboard blob that has no file name', async () => {
    const rec = recorder();
    await ingestBatch([source(null)], fakeEnv(), rec.hooks);
    expect(rec.pending[0]?.name).toBe('Pasted image');
  });

  it('carries the source size for the placeholder', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png', 4096)], fakeEnv(), rec.hooks);
    expect(rec.pending[0]?.sourceBytes).toBe(4096);
  });

  it('tells every placeholder where it will land', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png'), source('b.png')], fakeEnv(), rec.hooks, {
      afterBlockId: 'b3',
    });
    expect(rec.pending.map((item) => item.afterBlockId)).toEqual(['b3', 'b3']);
  });

  it('defaults to inserting at the selection', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png')], fakeEnv(), rec.hooks);
    expect(rec.pending[0]?.afterBlockId).toBeNull();
  });

  it('gives each blob a distinct id, even for identical files', async () => {
    const rec = recorder();
    await ingestBatch([source('a.png'), source('a.png')], fakeEnv(), rec.hooks);
    expect(new Set(rec.pending.map((item) => item.id)).size).toBe(2);
  });

  it('reports a failure as a notice rather than throwing', async () => {
    const rec = recorder();
    await expect(
      ingestBatch([source('bad.png')], fakeEnv({ failDecode: 'not an image' }), rec.hooks),
    ).resolves.toBeUndefined();
    expect(rec.failures).toHaveLength(1);
    expect(rec.failures[0]?.tone).toBe('error');
    expect(rec.failures[0]?.message).toContain('bad.png');
    expect(rec.failures[0]?.message).toContain('not an image');
  });

  it('settles a failed blob too, so its placeholder never sticks', async () => {
    const rec = recorder();
    await ingestBatch([source('bad.png')], fakeEnv({ failDecode: 'boom' }), rec.hooks);
    expect(rec.log.filter((line) => line.startsWith('settled:'))).toHaveLength(1);
  });

  it('does nothing at all for an empty batch', async () => {
    const rec = recorder();
    await ingestBatch([], fakeEnv(), rec.hooks);
    expect(rec.log).toEqual([]);
  });
});

describe('notices', () => {
  it('says nothing when there is nothing to say', () => {
    expect(noticesFor(ingested([]))).toEqual([]);
  });

  it('explains what an inline image costs the file', () => {
    const notices = noticesFor(ingested([{ code: 'large', message: 'large' }]));
    expect(notices[0]?.tone).toBe('warning');
    expect(notices[0]?.message).toContain('A photo');
    expect(notices[0]?.message).toContain('.mdv');
    // The base64 overhead is named, not just the raw size.
    expect(notices[0]?.message).toContain('adds about');
  });

  it('falls back to a neutral subject when there is no alt text', () => {
    const notices = noticesFor(ingested([{ code: 'large', message: 'large' }], { alt: '' }));
    expect(notices[0]?.message.startsWith('This image')).toBe(true);
  });

  it('reports a downscale with both sizes', () => {
    const notices = noticesFor(ingested([{ code: 'downscaled', message: 'resized' }]));
    expect(notices[0]?.tone).toBe('info');
    expect(notices[0]?.message).toContain('4096×3072');
    expect(notices[0]?.message).toContain('1024×768');
  });

  it('passes a format fallback through in the engine words', () => {
    const notices = noticesFor(
      ingested([{ code: 'format-fallback', message: 'WebP is unavailable; used PNG.' }]),
    );
    expect(notices[0]?.message).toBe('WebP is unavailable; used PNG.');
  });

  it('keeps every warning, with stable distinct ids', () => {
    const notices = noticesFor(
      ingested([
        { code: 'large', message: 'l' },
        { code: 'downscaled', message: 'd' },
        { code: 'format-fallback', message: 'f' },
      ]),
    );
    expect(notices).toHaveLength(3);
    expect(new Set(notices.map((notice) => notice.id)).size).toBe(3);
  });
});

describe('document weight', () => {
  const png = (payload: string): string => `data:image/png;base64,${payload}`;

  it('is zero for a document with no images', () => {
    const doc = createEditor({ text: '# Hi\n\nSome text.\n' }).getDocument();
    expect(embeddedWeight(doc)).toEqual({ count: 0, characters: 0, bytes: 0 });
  });

  it('ignores images that merely link out', () => {
    const doc = createEditor({ text: '![a](https://example.com/a.png)\n' }).getDocument();
    expect(embeddedWeight(doc).count).toBe(0);
  });

  it('counts every embedded image', () => {
    const src = png('A'.repeat(400));
    const doc = createEditor({ text: `![a](${src})\n\n![b](${src})\n` }).getDocument();
    const weight = embeddedWeight(doc);
    expect(weight.count).toBe(2);
    expect(weight.characters).toBe(src.length * 2);
    expect(weight.bytes).toBe(base64Bytes(src) * 2);
  });
});

describe('base64 arithmetic', () => {
  it('decodes the payload length, allowing for padding', () => {
    expect(base64Bytes('data:image/png;base64,QQ==')).toBe(1);
    expect(base64Bytes('data:image/png;base64,QUJD')).toBe(3);
    expect(base64Bytes('data:image/png;base64,QUJDRA==')).toBe(4);
  });

  it('is zero for something that is not a data URI', () => {
    expect(base64Bytes('https://example.com/a.png')).toBe(0);
  });

  it('never goes negative on a malformed payload', () => {
    expect(base64Bytes('data:image/png;base64,==')).toBe(0);
  });

  it('knows base64 costs a third', () => {
    expect(base64Overhead(3)).toBe(1);
    expect(base64Overhead(300)).toBe(100);
    expect(base64Overhead(0)).toBe(0);
  });
});

describe('formatting bytes', () => {
  it('uses binary units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024)).toBe('1 MB');
    expect(formatBytes(3.25 * 1024 * 1024)).toBe('3.3 MB');
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1 GB');
  });

  it('refuses to invent a number it does not have', () => {
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

/**
 * `mdv export` end to end (SPEC 28.11).
 *
 * These are the tests that prove the whole pipeline is wired: source text on
 * disk → parse → resolve → layout → PDF/SVG bytes on disk. They are slower than
 * a unit test on purpose; if they pass, `mdv export doc.mdv -o doc.pdf` works.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EXIT_CODES, resolveTarget, run } from '../src/index.js';
import {
  PROSE_DOCUMENT,
  SIMPLE_DOCUMENT,
  TWO_BLOCK_DOCUMENT,
  longDocument,
  workspace,
} from './harness.js';
import type { Workspace } from './harness.js';

const latin1 = new TextDecoder('latin1');

let ws: Workspace;

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await ws.cleanup();
});

describe('target selection', () => {
  it('takes --to first, then the -o extension, then pdf', () => {
    expect(resolveTarget({})).toBe('pdf');
    expect(resolveTarget({ out: 'x.svg' })).toBe('svg');
    expect(resolveTarget({ out: 'x.svg', to: 'json' })).toBe('json');
    expect(resolveTarget({ out: 'x.unknown' })).toBe('pdf');
    expect(resolveTarget({ out: '-', to: 'csv' })).toBe('csv');
  });

  it('refuses an unknown target', () => {
    expect(() => resolveTarget({ to: 'docx' })).toThrowError(/Unknown export target/);
  });
});

describe('pdf', () => {
  it('writes a PDF 1.7 file', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    const code = await run(['export', 'doc.mdv', '-o', 'doc.pdf'], ws.io);
    expect(ws.io.err).toBe('');
    expect(code).toBe(EXIT_CODES.ok);

    const bytes = await ws.bytes('doc.pdf');
    expect(latin1.decode(bytes.slice(0, 8))).toBe('%PDF-1.7');
    expect(latin1.decode(bytes.slice(-8))).toContain('%%EOF');
    expect(bytes.byteLength).toBeGreaterThan(1000);
  });

  it('is byte-identical across two runs of the same input (SPEC 28.10)', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await run(['export', 'doc.mdv', '-o', 'a.pdf'], ws.io);
    await run(['export', 'doc.mdv', '-o', 'b.pdf'], ws.io);
    const a = await ws.bytes('a.pdf');
    const b = await ws.bytes('b.pdf');
    expect(Buffer.from(b).equals(Buffer.from(a))).toBe(true);
  });

  it('pins the creation date to --build-time, not to the clock', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await run(['export', 'doc.mdv', '-o', 'a.pdf', '--build-time', '2026-01-31T00:00:00Z'], ws.io);
    await run(['export', 'doc.mdv', '-o', 'b.pdf', '--build-time', '2026-01-31T00:00:00Z'], ws.io);
    await run(['export', 'doc.mdv', '-o', 'c.pdf', '--build-time', '2020-06-01T12:00:00Z'], ws.io);

    const a = latin1.decode(await ws.bytes('a.pdf'));
    const b = latin1.decode(await ws.bytes('b.pdf'));
    const c = latin1.decode(await ws.bytes('c.pdf'));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toContain('D:20260131000000Z');
    expect(c).toContain('D:20200601120000Z');
  });

  it('defaults the output path to the input stem', async () => {
    await ws.write('report.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'report.mdv'], ws.io)).toBe(EXIT_CODES.ok);
    expect((await ws.bytes('report.pdf')).byteLength).toBeGreaterThan(0);
  });

  it('paginates a long document over several pages (SPEC 28.3)', async () => {
    await ws.write('long.mdv', longDocument(24));
    expect(await run(['export', 'long.mdv', '-o', 'long.pdf', '--no-compress'], ws.io)).toBe(
      EXIT_CODES.ok,
    );
    const text = latin1.decode(await ws.bytes('long.pdf'));
    const count = /\/Count (\d+)/.exec(text)?.[1];
    expect(Number(count)).toBeGreaterThan(1);
  });

  it('embeds the source when asked, byte-for-byte (SPEC 28.9)', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(
      await run(['export', 'doc.mdv', '-o', 'doc.pdf', '--embed-source', '--no-compress'], ws.io),
    ).toBe(EXIT_CODES.ok);

    const text = latin1.decode(await ws.bytes('doc.pdf'));
    expect(text).toContain('/EmbeddedFiles');
    expect(text).toContain('doc.mdv');
    expect(text).toContain('text/vnd.mdv');
    // The attachment stream is the document itself: uncompressed, it is findable.
    expect(text).toContain('title: Quarterly review');
  });

  it('omits the attachment without --embed-source', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await run(['export', 'doc.mdv', '-o', 'doc.pdf', '--no-compress'], ws.io);
    expect(latin1.decode(await ws.bytes('doc.pdf'))).not.toContain('/EmbeddedFiles');
  });

  it('refuses stdout for a PDF', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '-o', '-'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('PDF cannot be written to stdout');
  });

  it('rejects an unknown profile', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '-o', 'x.pdf', '--profile', 'pdf-2'], ws.io)).toBe(
      EXIT_CODES.usage,
    );
    expect(ws.io.err).toContain('Unknown PDF profile');
  });

  it('exports a document with no charts at all', async () => {
    await ws.write('prose.mdv', PROSE_DOCUMENT);
    expect(await run(['export', 'prose.mdv', '-o', 'prose.pdf'], ws.io)).toBe(EXIT_CODES.ok);
    expect((await ws.bytes('prose.pdf')).byteLength).toBeGreaterThan(500);
  });
});

describe('svg', () => {
  it('writes one file for one block', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--to', 'svg', '-o', 'chart.svg'], ws.io)).toBe(
      EXIT_CODES.ok,
    );
    const svg = await ws.read('chart.svg');
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('</svg>');
  });

  it('suffixes the block id when there are several', async () => {
    await ws.write('two.mdv', TWO_BLOCK_DOCUMENT);
    expect(await run(['export', 'two.mdv', '--to', 'svg', '-o', 'out.svg'], ws.io)).toBe(
      EXIT_CODES.ok,
    );
    expect((await ws.read('out-first.svg')).startsWith('<svg')).toBe(true);
    expect((await ws.read('out-second.svg')).startsWith('<svg')).toBe(true);
  });

  it('selects one block with --block', async () => {
    await ws.write('two.mdv', TWO_BLOCK_DOCUMENT);
    expect(
      await run(['export', 'two.mdv', '--to', 'svg', '--block', 'second', '-o', 'x.svg'], ws.io),
    ).toBe(EXIT_CODES.ok);
    expect((await ws.read('x.svg')).startsWith('<svg')).toBe(true);
  });

  it('names the available blocks when --block misses', async () => {
    await ws.write('two.mdv', TWO_BLOCK_DOCUMENT);
    expect(
      await run(['export', 'two.mdv', '--to', 'svg', '--block', 'third', '-o', 'x.svg'], ws.io),
    ).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('available: first, second');
  });

  it('writes to stdout for -o -', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--to', 'svg', '-o', '-'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out.startsWith('<svg')).toBe(true);
  });

  it('is byte-identical across two runs', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await run(['export', 'doc.mdv', '--to', 'svg', '-o', 'a.svg'], ws.io);
    await run(['export', 'doc.mdv', '--to', 'svg', '-o', 'b.svg'], ws.io);
    expect(await ws.read('b.svg')).toBe(await ws.read('a.svg'));
  });

  it('refuses a document with no visual blocks', async () => {
    await ws.write('prose.mdv', PROSE_DOCUMENT);
    expect(await run(['export', 'prose.mdv', '--to', 'svg', '-o', 'x.svg'], ws.io)).toBe(
      EXIT_CODES.usage,
    );
    expect(ws.io.err).toContain('no visual blocks');
  });
});

describe('json and csv', () => {
  it('emits the resolved blocks with their scenes', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--to', 'json', '-o', '-'], ws.io)).toBe(EXIT_CODES.ok);
    const payload = JSON.parse(ws.io.out) as {
      blocks: { id: string; type: string; scene: { width: number; a11y: { name: string } } }[];
    };
    expect(payload.blocks).toHaveLength(1);
    const block = payload.blocks[0];
    expect(block?.type).toBe('bar');
    expect(block?.scene.width).toBeGreaterThan(0);
    expect(block?.scene.a11y.name.length).toBeGreaterThan(0);
  });

  it('emits a block table as RFC 4180 csv', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--to', 'csv', '-o', '-'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toBe('region,revenue\nNorth,120\nSouth,90\nEast,75\nWest,110\n');
  });
});

describe('targets this build does not have', () => {
  it.each(['html', 'png', 'md'])('refuses --to %s with a reason', async (target) => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--to', target, '-o', `x.${target}`], ws.io)).toBe(
      EXIT_CODES.usage,
    );
    expect(ws.io.err).toContain(`\`--to ${target}\` is not implemented`);
    expect(ws.io.err).toContain('Why:');
  });
});

/**
 * The theme-file store (SPEC 11.6): URI resolution, the synchronous read seam,
 * the shared cache, and which Appendix C code each failure earns.
 */

import { describe, expect, it } from 'vitest';

import { ThemeFiles, resolveThemeUri } from '../src/pipeline/themefile.js';
import type { ThemeFileRead, ThemeFileReader } from '../src/pipeline/themefile.js';

const DOC = 'file:///w/docs/report.md';

/** One token, so nothing a palette check says can reach the assertions. */
const TOKENS_YAML = "tokens:\n  surface: '#010203'\n";
const TOKENS_JSON = '{ "tokens": { "surface": "#010203" } }';

/** Counts reads, so "read once, shared by every document" is testable. */
class FakeReader implements ThemeFileReader {
  readonly reads: string[] = [];
  constructor(private readonly files: Record<string, string>) {}
  read(uri: string): ThemeFileRead {
    this.reads.push(uri);
    const text = this.files[uri];
    return text === undefined ? { status: 'error', message: 'ENOENT' } : { status: 'ok', text };
  }
}

describe('resolveThemeUri', () => {
  it('resolves the shapes an author actually writes', () => {
    expect(resolveThemeUri('./brand.yaml', DOC)).toBe('file:///w/docs/brand.yaml');
    expect(resolveThemeUri('../shared/brand.json', DOC)).toBe('file:///w/shared/brand.json');
    expect(resolveThemeUri('brand.yml', DOC)).toBe('file:///w/docs/brand.yml');
    expect(resolveThemeUri('file:///abs/brand.json', DOC)).toBe('file:///abs/brand.json');
  });

  it('does not read a Windows path as a URI scheme', () => {
    // `new URL` would take `c:` for the scheme and keep the backslashes.
    expect(resolveThemeUri('C:\\themes\\brand.json', DOC)).toBe('file:///C:/themes/brand.json');
  });

  it('keeps a remote URI remote, for the caller to refuse', () => {
    expect(resolveThemeUri('https://example.com/t.json', DOC)).toBe('https://example.com/t.json');
  });

  it('answers undefined rather than throwing on a value that is no path at all', () => {
    expect(resolveThemeUri('./x.json', 'not a uri')).toBeUndefined();
  });
});

describe('ThemeFiles.load', () => {
  it('reads both formats and picks the reader from the extension', () => {
    const reader = new FakeReader({
      'file:///w/docs/brand.yaml': TOKENS_YAML,
      'file:///w/docs/brand.json': TOKENS_JSON,
      'file:///w/docs/brand.jsonc': `// a comment JSON.parse would refuse\n${TOKENS_JSON}`,
    });
    const files = new ThemeFiles(reader);

    for (const name of ['./brand.yaml', './brand.json', './brand.jsonc']) {
      const loaded = files.load(name, DOC, 'light', false);
      expect(loaded.problems, name).toEqual([]);
      expect(loaded.theme?.tokens.surface, name).toBe('#010203');
    }
  });

  it('refuses in `.json` the comment it accepts in `.jsonc`', () => {
    const text = `// the brand surface\n${TOKENS_JSON}`;
    const files = new ThemeFiles(
      new FakeReader({ 'file:///w/docs/a.json': text, 'file:///w/docs/a.jsonc': text }),
    );
    const strict = files.load('./a.json', DOC, 'light', false);
    expect(strict.problems[0]?.code).toBe('MDV1502');
    expect(strict.problems[0]?.detail).toContain('.jsonc');
    expect(files.load('./a.jsonc', DOC, 'light', false).problems).toEqual([]);
  });

  it('reads a file once however many documents name it', () => {
    const reader = new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML });
    const files = new ThemeFiles(reader);
    for (let i = 0; i < 10; i += 1) files.load('./brand.yaml', DOC, 'light', false);
    expect(reader.reads).toEqual(['file:///w/docs/brand.yaml']);
  });

  it('resolves the same file separately per colour scheme', () => {
    const reader = new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML });
    const files = new ThemeFiles(reader);
    const light = files.load('./brand.yaml', DOC, 'light', false);
    const dark = files.load('./brand.yaml', DOC, 'dark', false);
    expect(light.theme?.scheme).toBe('light');
    expect(dark.theme?.scheme).toBe('dark');
    expect(reader.reads).toHaveLength(2);
  });

  it('is pending, not failed, until the text lands', () => {
    let landed = false;
    const files = new ThemeFiles({
      read: (): ThemeFileRead =>
        landed ? { status: 'ok', text: TOKENS_YAML } : { status: 'pending' },
    });

    const first = files.load('./brand.yaml', DOC, 'light', false);
    expect(first).toMatchObject({ theme: undefined, problems: [], pending: true });

    landed = true;
    const second = files.load('./brand.yaml', DOC, 'light', false);
    expect(second.pending).toBe(false);
    expect(second.theme?.tokens.surface).toBe('#010203');
  });

  it('reports a bad palette as MDV3080 and still renders the theme', () => {
    // Two slots a normal-vision reader cannot tell apart: a hard failure.
    const files = new ThemeFiles(
      new FakeReader({
        'file:///w/docs/brand.yaml': "categorical:\n  - '#1f77b4'\n  - '#1f77b5'\n",
      }),
    );
    const loaded = files.load('./brand.yaml', DOC, 'light', false);
    expect(loaded.problems.map((problem) => problem.code)).toContain('MDV3080');
    // SPEC 11.6 asks for warnings, not a refusal — the author's palette paints.
    expect(loaded.theme?.categorical[0]).toBe('#1f77b4');
  });

  it('reports an unusable theme as MDV1502 with the reason attached', () => {
    const files = new ThemeFiles(
      new FakeReader({ 'file:///w/docs/brand.yaml': 'categorical: 7\n' }),
    );
    const loaded = files.load('./brand.yaml', DOC, 'light', false);
    expect(loaded.theme).toBeUndefined();
    expect(loaded.problems.map((problem) => problem.code)).toEqual(['MDV1502']);
    expect(loaded.problems[0]?.detail).toContain('categorical');
  });

  it('names the recognised extensions when the value is neither name nor file', () => {
    const files = new ThemeFiles(new FakeReader({}));
    const loaded = files.load('corporate', DOC, 'light', false);
    expect(loaded.problems[0]?.detail).toContain('.yaml');
    expect(loaded.problems[0]?.code).toBe('MDV1502');
  });

  it('refuses external data by default and reads it when allowed', () => {
    const reader = new FakeReader({ 'https://example.com/t.json': TOKENS_JSON });
    const files = new ThemeFiles(reader);

    const blocked = files.load('https://example.com/t.json', DOC, 'light', false);
    expect(blocked.problems.map((problem) => problem.code)).toEqual(['MDV4002']);
    expect(reader.reads).toEqual([]);

    const allowed = files.load('https://example.com/t.json', DOC, 'light', true);
    expect(allowed.problems).toEqual([]);
  });

  it('cannot load anything without a reader, and says which themes do resolve', () => {
    const files = new ThemeFiles();
    const loaded = files.load('./brand.yaml', DOC, 'light', false);
    expect(loaded.theme).toBeUndefined();
    expect(loaded.problems[0]?.code).toBe('MDV1502');
    expect(loaded.problems[0]?.detail).toContain('high-contrast');
  });
});

describe('ThemeFiles invalidation', () => {
  it('bumps the revision so a memo keyed on it misses', () => {
    const files = new ThemeFiles(new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML }));
    const before = files.revision;
    files.invalidate();
    expect(files.revision).toBeGreaterThan(before);
  });

  it('re-reads only the file that changed', () => {
    const reader = new FakeReader({
      'file:///w/docs/a.yaml': TOKENS_YAML,
      'file:///w/docs/b.yaml': TOKENS_YAML,
    });
    const files = new ThemeFiles(reader);
    files.load('./a.yaml', DOC, 'light', false);
    files.load('./b.yaml', DOC, 'light', false);

    files.invalidate('file:///w/docs/a.yaml');
    files.load('./a.yaml', DOC, 'light', false);
    files.load('./b.yaml', DOC, 'light', false);

    expect(reader.reads).toEqual([
      'file:///w/docs/a.yaml',
      'file:///w/docs/b.yaml',
      'file:///w/docs/a.yaml',
    ]);
  });

  it('drops every scheme of the file it was told about', () => {
    const reader = new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML });
    const files = new ThemeFiles(reader);
    files.load('./brand.yaml', DOC, 'light', false);
    files.load('./brand.yaml', DOC, 'dark', false);

    files.invalidate('file:///w/docs/brand.yaml');
    files.load('./brand.yaml', DOC, 'light', false);
    files.load('./brand.yaml', DOC, 'dark', false);
    expect(reader.reads).toHaveLength(4);
  });

  it('forgets everything read through a reader that was swapped out', () => {
    const first = new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML });
    const files = new ThemeFiles(first);
    expect(files.load('./brand.yaml', DOC, 'light', false).theme).toBeDefined();

    // Trust revoked: the same block must stop resolving, not serve the cache.
    files.setReader(undefined);
    expect(files.load('./brand.yaml', DOC, 'light', false).theme).toBeUndefined();
  });

  it('gives a changed file a different key so the block re-renders', () => {
    const reader = new FakeReader({ 'file:///w/docs/brand.yaml': TOKENS_YAML });
    const files = new ThemeFiles(reader);
    const before = files.load('./brand.yaml', DOC, 'light', false).key;
    files.invalidate('file:///w/docs/brand.yaml');
    expect(files.load('./brand.yaml', DOC, 'light', false).key).not.toBe(before);
  });
});

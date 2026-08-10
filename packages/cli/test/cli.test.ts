/**
 * Dispatch, help, and the exit-code contract of SPEC 27.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { COMMAND_NAMES, EXIT_CODES, commandHelp, globalHelp, run } from '../src/index.js';
import { SIMPLE_DOCUMENT, workspace } from './harness.js';
import type { Workspace } from './harness.js';

let ws: Workspace;

beforeEach(async () => {
  ws = await workspace();
});

afterEach(async () => {
  await ws.cleanup();
});

describe('dispatch', () => {
  it('prints usage and exits 2 with no arguments', async () => {
    expect(await run([], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('Usage: mdv <command>');
    expect(ws.io.out).toBe('');
  });

  it('prints help to stdout and exits 0 for --help', async () => {
    expect(await run(['--help'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toContain('Commands:');
    for (const name of COMMAND_NAMES) expect(ws.io.out).toContain(name);
  });

  it("prints a command's help for `help <command>` and for `<command> --help`", async () => {
    const a = await workspace();
    const b = await workspace();
    expect(await run(['help', 'export'], a.io)).toBe(EXIT_CODES.ok);
    expect(await run(['export', '--help'], b.io)).toBe(EXIT_CODES.ok);
    expect(a.io.out).toBe(b.io.out);
    expect(a.io.out).toContain('mdv export <file.mdv>');
    await a.cleanup();
    await b.cleanup();
  });

  it('has help for every command', () => {
    for (const name of COMMAND_NAMES) {
      const text = commandHelp(name);
      expect(text.length).toBeGreaterThan(40);
      expect(text.endsWith('\n')).toBe(true);
      expect(globalHelp('0.0.0')).toContain(name);
    }
  });

  it('reports the version', async () => {
    expect(await run(['--version'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toMatch(/^mdv \d+\.\d+\.\d+ \(spec .+, core .+\)\n$/);
  });

  it('suggests a command for a misspelling', async () => {
    expect(await run(['exprot', 'x.mdv'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('Unknown command `exprot`');
    expect(ws.io.err).toContain('mdv export');
  });

  it('rejects a leading flag as a missing command', async () => {
    expect(await run(['--strict'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('Expected a command');
  });

  it('rejects an unknown flag and lists the accepted ones', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['lint', 'doc.mdv', '--wat'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('Accepted flags:');
    expect(ws.io.err).toContain('--max-severity');
  });

  it('rejects --level 4 rather than silently defaulting', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['lint', 'doc.mdv', '--level', '4'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('--level must be 1, 2 or 3');
  });

  it('rejects an unparseable --build-time', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['export', 'doc.mdv', '--build-time', 'yesterday'], ws.io)).toBe(
      EXIT_CODES.usage,
    );
    expect(ws.io.err).toContain('--build-time is not a date');
  });

  it('exits 3 for a missing input file, naming it', async () => {
    expect(await run(['render', 'nope.mdv'], ws.io)).toBe(EXIT_CODES.io);
    expect(ws.io.err).toContain('nope.mdv');
    expect(ws.io.err).toContain('no such file');
  });

  it('never writes ANSI escapes when stdout is not a tty', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await run(['render', 'doc.mdv'], ws.io);
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(ws.io.all)).toBe(false);
  });
});

describe('theme files (SPEC 11.6)', () => {
  const BRAND = {
    extends: 'default',
    categorical: ['#2563eb', '#f97316', '#059669', '#7c3aed'],
  };

  it('validates a YAML theme file, not only JSON', async () => {
    await ws.write(
      'brand.yaml',
      `extends: default\ncategorical:\n${BRAND.categorical.map((c) => `  - "${c}"`).join('\n')}\n`,
    );
    expect(await run(['validate-theme', 'brand.yaml'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toContain('4 slots');
    expect(ws.io.out).toContain('PASS');
  });

  it('reads the same theme from .json, .jsonc, .yaml and .yml', async () => {
    const text = JSON.stringify(BRAND);
    const outputs: string[] = [];
    for (const name of ['brand.json', 'brand.jsonc', 'brand.yaml', 'brand.yml']) {
      const each = await workspace();
      await each.write(name, text); // JSON is valid YAML, so one text does for all four.
      expect(await run(['validate-theme', name], each.io), name).toBe(EXIT_CODES.ok);
      outputs.push(each.io.out.replace(name, '<theme>'));
      await each.cleanup();
    }
    expect(new Set(outputs).size).toBe(1);
  });

  it('reports every problem in a theme file at once, and exits 2', async () => {
    await ws.write('bad.json', '{"extends":3,"scheme":"sepia","categorical":{}}');
    expect(await run(['validate-theme', 'bad.json'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('Cannot read theme');
    expect(ws.io.err).toContain('theme.extends');
    expect(ws.io.err).toContain('theme.scheme');
    expect(ws.io.err).toContain('theme.categorical');
  });

  const COMMENTED = '{\n  // brand blue\n  "categorical": ["#2563eb"],\n}';

  it('tells an author who commented a .json file where the comment may go', async () => {
    await ws.write('bad.json', COMMENTED);
    expect(await run(['validate-theme', 'bad.json'], ws.io)).toBe(EXIT_CODES.usage);
    expect(ws.io.err).toContain('JSON has no comments');
    expect(ws.io.err).toContain('.jsonc');
    expect(ws.io.err).toContain('.yaml');
  });

  it('reads that same file when it is named .jsonc', async () => {
    // The advice above has to be true, or it sends the author in a circle.
    await ws.write('good.jsonc', COMMENTED);
    expect(await run(['validate-theme', 'good.jsonc'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toContain('1 slot');
  });

  it('renders with --theme pointing at a file, and warns about a bad palette', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    await ws.write('flat.yaml', 'categorical:\n  - "#2a78d6"\n  - "#2c7ad8"\n');
    // `-o -` for the SVG backend: the point is that the file's palette reaches
    // the drawing, not only the validator.
    expect(await run(['render', 'doc.mdv', '--theme', 'flat.yaml', '-o', '-'], ws.io)).toBe(
      EXIT_CODES.ok,
    );
    expect(ws.io.err).toContain('MDV3080');
    expect(ws.io.out).toContain('<svg');
    expect(ws.io.out).toContain('#2a78d6');
  });

  it('treats a bare word as a theme name, not as a file', async () => {
    await ws.write('doc.mdv', SIMPLE_DOCUMENT);
    expect(await run(['render', 'doc.mdv', '--theme', 'dark'], ws.io)).toBe(EXIT_CODES.ok);
    expect(await run(['validate-theme', 'high-contrast'], ws.io)).toBe(EXIT_CODES.ok);
    expect(ws.io.out).toContain('built-in theme `high-contrast`');
  });
});

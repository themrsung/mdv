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

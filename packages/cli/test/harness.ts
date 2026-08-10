/**
 * Test harness: a captured {@link CliIo} over a real temporary directory.
 *
 * The CLI's whole point is to touch the filesystem, so the tests do too — but
 * inside `mkdtemp`, never in the repository, and every test cleans up after
 * itself. Nothing here spawns a process: `run(argv, io)` is called in-process,
 * which is exactly why `run` returns a code instead of calling `process.exit`.
 */

import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { CliIo } from '../src/io.js';

/** A captured invocation. */
export interface Capture extends CliIo {
  /** Everything written to stdout. */
  out: string;
  /** Everything written to stderr. */
  err: string;
  /** Both, in write order, for assertions that do not care which stream. */
  all: string;
}

/** A temporary workspace plus a captured io bound to it. */
export interface Workspace {
  dir: string;
  io: Capture;
  /** Write a file inside the workspace; returns its absolute path. */
  write(name: string, contents: string): Promise<string>;
  /** Read a text file from inside the workspace. */
  read(name: string): Promise<string>;
  /** Read a binary file from inside the workspace. */
  bytes(name: string): Promise<Uint8Array>;
  /** Remove the workspace. */
  cleanup(): Promise<void>;
}

/** A captured io rooted at `cwd`. */
export function captureIo(cwd: string, options?: { isTty?: boolean }): Capture {
  const capture: Capture = {
    out: '',
    err: '',
    all: '',
    stdout: {
      write(chunk: string): void {
        capture.out += chunk;
        capture.all += chunk;
      },
    },
    stderr: {
      write(chunk: string): void {
        capture.err += chunk;
        capture.all += chunk;
      },
    },
    cwd,
    env: {},
    isTty: options?.isTty ?? false,
  };
  return capture;
}

/** Create a temporary workspace. */
export async function workspace(): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'mdv-cli-'));
  const io = captureIo(dir);
  return {
    dir,
    io,
    async write(name: string, contents: string): Promise<string> {
      const path = join(dir, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, contents, 'utf8');
      return path;
    },
    async read(name: string): Promise<string> {
      return readFile(join(dir, name), 'utf8');
    },
    async bytes(name: string): Promise<Uint8Array> {
      return new Uint8Array(await readFile(join(dir, name)));
    },
    async cleanup(): Promise<void> {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** A document with prose, a heading and one bar chart. */
export const SIMPLE_DOCUMENT = `---
title: Quarterly review
author: Test Author
lang: en
---

# Quarterly review

Revenue grew in every region except the one that shrank.

\`\`\`mdv bar
title: Revenue by region
x: region
y: revenue
---
region,revenue
North,120
South,90
East,75
West,110
\`\`\`

## Notes

The numbers above are made up.
`;

/** A document with two charts, for the multi-block paths. */
export const TWO_BLOCK_DOCUMENT = `---
title: Two charts
---

# Two charts

\`\`\`mdv bar
id: first
x: region
y: revenue
---
region,revenue
North,120
South,90
\`\`\`

\`\`\`mdv line
id: second
x: month
y: value
---
month,value
1,10
2,20
3,15
\`\`\`
`;

/** A document with no visual blocks at all. */
export const PROSE_DOCUMENT = `---
title: Prose only
---

# Prose only

Nothing to draw here.
`;

/** A long document, to force the paginator over several PDF pages. */
export function longDocument(paragraphs: number): string {
  const body: string[] = ['---', 'title: Long', '---', '', '# Long', ''];
  for (let i = 0; i < paragraphs; ++i) {
    body.push(`## Section ${i + 1}`);
    body.push('');
    body.push(
      `Paragraph ${i + 1}. ${'The quick brown fox jumps over the lazy dog. '.repeat(6)}`.trim(),
    );
    body.push('');
  }
  return `${body.join('\n')}\n`;
}

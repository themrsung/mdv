#!/usr/bin/env node
/**
 * The `mdv` binary. Thin: it wires the real process to {@link run} and maps the
 * returned code onto `process.exit` (SPEC 27).
 *
 * This is the **only** file in the package permitted to call `process.exit`, and
 * the only one that reads `process` at all — everything else takes a `CliIo`.
 */
import process from 'node:process';
import { run } from './index.js';

// Ctrl-C stops `mdv watch` cleanly rather than killing it mid-write.
const controller = new AbortController();
const interrupt = (): void => {
  controller.abort();
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

const code = await run(process.argv.slice(2), {
  stdout: { write: (chunk: string): void => void process.stdout.write(chunk) },
  stderr: { write: (chunk: string): void => void process.stderr.write(chunk) },
  cwd: process.cwd(),
  env: process.env,
  isTty: process.stdout.isTTY === true,
  signal: controller.signal,
});

process.exit(code);

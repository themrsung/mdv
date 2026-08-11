#!/usr/bin/env node
/**
 * The `mdv-conformance` binary. Thin: it wires the real process to
 * {@link main} and maps the returned code onto `process.exit`.
 *
 * This is the only file in the package permitted to read `process` or to end
 * it — everything else takes an io object and returns a number.
 */
import process from 'node:process';

import { main } from './cli.js';

const code = await main(process.argv.slice(2), {
  stdout: { write: (chunk: string): void => void process.stdout.write(chunk) },
  stderr: { write: (chunk: string): void => void process.stderr.write(chunk) },
  cwd: process.cwd(),
});

process.exit(code);

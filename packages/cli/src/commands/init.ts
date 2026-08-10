/**
 * `mdv init` (SPEC 27) — scaffold a document with front matter.
 *
 * The scaffold is a **working** document, not a comment-only stub: it parses
 * with zero diagnostics and renders a bar chart, so `mdv init x.mdv && mdv render
 * x.mdv` is a complete smoke test of an installation.
 */

import type { GlobalFlags } from '../args.js';
import { EXIT_CODES, usageError } from '../exit.js';
import { displayPath, exists, writeTextFile } from '../io.js';
import type { CliIo } from '../io.js';
import { createTerm } from '../term.js';

/** Flags `mdv init` accepts on top of the global ones. */
export interface InitFlags extends GlobalFlags {
  force?: boolean;
}

/** Default scaffold name when no path is given. */
export const DEFAULT_INIT_PATH = 'document.mdv';

/**
 * The scaffold.
 *
 * `date:` is deliberately absent: writing today's date would make `mdv init`
 * non-deterministic, and an author who wants one can add it.
 */
export const SCAFFOLD = `---
title: Untitled
author: ""
lang: en
theme: default
---

# Untitled

A sentence about what this document shows.

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

The chart above reads from the CSV in its own data section. Replace it with
\`src: data.csv\` and run with \`--allow-file\` to load a file instead.
`;

/** `mdv init` — scaffold a document with front matter. */
export async function initCommand(
  io: CliIo,
  files: readonly string[],
  flags: InitFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const target = files[0] ?? DEFAULT_INIT_PATH;
  if (files.length > 1) {
    throw usageError(`init: expected one path, got ${files.length}`);
  }

  if ((await exists(io, target)) && flags.force !== true) {
    throw usageError(
      `${displayPath(io, target)} already exists`,
      'Pass --force to overwrite it.',
    );
  }

  await writeTextFile(io, target, SCAFFOLD);
  term.status(`Created ${displayPath(io, target)}`);
  term.status(`Next: mdv render ${displayPath(io, target)}`);
  return EXIT_CODES.ok;
}

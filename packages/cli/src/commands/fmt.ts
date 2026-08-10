/**
 * `mdv fmt` (SPEC 27).
 *
 * ```text
 * mdv fmt docs/            # rewrite in place
 * mdv fmt docs/ --check    # exit 1 if anything would change
 * ```
 *
 * Canonical formatting is `@mdv/parser`'s `toMarkdown`, which is required to
 * round-trip and to be idempotent. This command adds the file handling and the
 * **safety check**: a formatting pass that changes the resolved AST is a bug, so
 * the result is re-parsed and compared before anything is written.
 */

import { parse, toMarkdown } from '@mdv/core';
import type { MdvDocument } from '@mdv/parser';

import type { GlobalFlags } from '../args.js';
import { EXIT_CODES, usageError } from '../exit.js';
import { displayPath, expandInputs, readTextFile, writeTextFile } from '../io.js';
import type { CliIo } from '../io.js';
import { createTerm } from '../term.js';

/** Flags `mdv fmt` accepts on top of the global ones. */
export interface FmtFlags extends GlobalFlags {
  check?: boolean;
}

/**
 * The canonical AST comparison key.
 *
 * `canonicalAst` (SPEC 19) is the parser's own answer to "are these the same
 * document?", but it is not part of the package's public surface, so this uses a
 * structural key over the node types and their content: enough to catch a
 * formatter that dropped a block or reordered a list, which is the failure this
 * guard exists for.
 */
function shape(doc: MdvDocument): string {
  const parts: string[] = [];
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    const type = record['type'];
    if (typeof type === 'string') parts.push(`<${type}`);
    const value = record['value'];
    if (typeof value === 'string') parts.push(`=${value}`);
    // A visual block has no children: its content is the verbatim header and
    // data sections, and those are exactly what a formatter could damage.
    const blockType = record['blockType'];
    if (typeof blockType === 'string') parts.push(`:${blockType}`);
    const raw = record['raw'];
    if (raw !== null && typeof raw === 'object') {
      const sections = raw as Record<string, unknown>;
      for (const key of ['header', 'data'] as const) {
        const section = sections[key];
        if (typeof section === 'string') parts.push(`|${section}`);
      }
    }
    const children = record['children'];
    if (Array.isArray(children)) for (const child of children) walk(child);
    parts.push('>');
  };
  walk(doc);
  return parts.join('\u0001');
}

/** `mdv fmt` — canonical formatting; `--check` writes nothing. */
export async function fmtCommand(
  io: CliIo,
  globs: readonly string[],
  flags: FmtFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const patterns = globs.length > 0 ? globs : ['.'];
  const files = await expandInputs(io, patterns);
  if (files.length === 0) {
    throw usageError(
      `No documents matched ${patterns.join(' ')}`,
      'A bare directory expands to the .mdv and .md files beneath it.',
    );
  }

  let changed = 0;
  for (const file of files) {
    const source = await readTextFile(io, file);
    const doc = parse(source);
    const formatted = toMarkdown(doc);

    if (formatted === source) continue;

    if (shape(parse(formatted)) !== shape(doc)) {
      // SPEC 27: `mdv fmt` MUST NOT change the resolved AST. Refusing to write is
      // the only safe response — a formatter that eats a block must not do it in
      // place.
      throw usageError(
        `Refusing to format ${displayPath(io, file)}: the formatted document does not parse back to the same AST`,
        'This is a bug in @mdv/parser toMarkdown. Please report it with the file attached.',
      );
    }

    changed += 1;
    if (flags.check === true) {
      term.line(`${displayPath(io, file)} would be reformatted`);
    } else {
      await writeTextFile(io, file, formatted);
      term.status(`Formatted ${displayPath(io, file)}`);
    }
  }

  const scanned = `${files.length} file${files.length === 1 ? '' : 's'}`;
  if (flags.check === true) {
    term.status(
      changed === 0
        ? `${scanned}, all formatted`
        : `${scanned}, ${changed} would be reformatted`,
    );
    return changed === 0 ? EXIT_CODES.ok : EXIT_CODES.diagnostics;
  }
  term.status(changed === 0 ? `${scanned}, nothing to do` : `${scanned}, ${changed} reformatted`);
  return EXIT_CODES.ok;
}

/**
 * Block selection and the one place a scene is laid out for a file target.
 *
 * There is deliberately **one** layout path here, shared by `render -o x.svg`,
 * `export --to svg` and `export --to json`: the same `Scene` the screen draws is
 * the one that reaches a backend (SPEC 28.1). The PDF exporter re-lays out at the
 * printed column width, which is the same code with a different `Size`, not a
 * second engine.
 */

import { createLayoutContext, layoutBlock } from '@mdv/core';
import type { ResolvedBlock, ResolvedDocument, Scene } from '@mdv/core';
import { naturalSize } from '@mdv/render-pdf';

import { usageError } from './exit.js';

/** Width a file export lays out at when `--width` is absent, in CSS pixels. */
export const DEFAULT_WIDTH = 800;

/**
 * Lay one block out.
 *
 * `naturalSize` reads `width`/`height`/`aspect` off the block exactly as the
 * printed page does (SPEC 5.4), so `mdv export --to svg` and the same block in a
 * PDF agree about proportion.
 */
export function sceneFor(
  doc: ResolvedDocument,
  block: ResolvedBlock,
  width: number = DEFAULT_WIDTH,
): Scene {
  const ctx = createLayoutContext(doc, block);
  const size = naturalSize(block.attrs, width, block.theme);
  return layoutBlock(block, size, ctx);
}

/**
 * Find a block by `id`, or by 0-based index when the selector is a number.
 *
 * @throws CliError (exit 2) naming the ids that do exist. "Block not found" with
 * no list is the least useful error a CLI can print.
 */
export function selectBlock(doc: ResolvedDocument, selector: string): ResolvedBlock {
  const byId = doc.blocks.find((block) => block.id === selector);
  if (byId !== undefined) return byId;

  if (/^\d+$/.test(selector)) {
    const index = Number.parseInt(selector, 10);
    const byIndex = doc.blocks[index];
    if (byIndex !== undefined) return byIndex;
  }

  const available =
    doc.blocks.length === 0
      ? 'the document has no visual blocks'
      : `available: ${doc.blocks.map((b) => b.id).join(', ')}`;
  throw usageError(`No block \`${selector}\` in the document`, available);
}

/** Every block, or just the selected one. */
export function selectBlocks(
  doc: ResolvedDocument,
  selector: string | undefined,
): readonly ResolvedBlock[] {
  return selector === undefined ? doc.blocks : [selectBlock(doc, selector)];
}

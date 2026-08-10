/**
 * Diagnostic helpers (SPEC 14).
 *
 * **Neither side throws for document content** (registry.ts): a chart type
 * reports through `EncodeInput.diagnostic` / `LayoutContext.diagnostic`, and a
 * thrown error becomes `MDV5000` and costs the reader the whole block.
 *
 * Severities come from `@mdv/spec`'s error table via `createDiagnostic`, never
 * from a literal here, so a change to Appendix C propagates without a code change.
 */

import type { Diagnostic, DiagnosticSource, ResolvedBlock } from '@mdv/core';
import { createDiagnostic } from '@mdv/core';

/** Build a block-scoped diagnostic anchored at the block's source range. */
export function blockDiagnostic(
  code: string,
  block: ResolvedBlock,
  source: DiagnosticSource,
  message?: string,
  detail?: string,
): Diagnostic {
  return createDiagnostic(code, {
    range: block.range,
    source,
    blockId: block.id,
    ...(message === undefined ? {} : { message }),
    ...(detail === undefined ? {} : { detail }),
  });
}

/** `MDV3000` — a channel the type declares required carries no usable field. */
export function missingChannel(block: ResolvedBlock, channel: string, purpose: string): Diagnostic {
  return blockDiagnostic(
    'MDV3000',
    block,
    'encode',
    `\`${channel}\` is required by \`${block.blockType}\` and is not bound`,
    `Bind \`${channel}\` to a column: ${purpose}`,
  );
}

/** `MDV3001` — the bound field's type is not one this channel accepts. */
export function incompatibleField(
  block: ResolvedBlock,
  channel: string,
  field: string,
  actual: string,
  accepted: readonly string[],
): Diagnostic {
  return blockDiagnostic(
    'MDV3001',
    block,
    'encode',
    `\`${channel}\` is bound to \`${field}\`, which is ${actual}`,
    `\`${channel}\` on a \`${block.blockType}\` block accepts ${accepted.join(', ')}. Declare the type under \`fields:\` if it was inferred wrongly.`,
  );
}

/** `MDV1502` — an unrecognised enum spelling; the default was used (SPEC 15.2). */
export function unknownEnum(
  block: ResolvedBlock,
  attribute: string,
  given: string,
  allowed: readonly string[],
  fallback: string,
): Diagnostic {
  return blockDiagnostic(
    'MDV1502',
    block,
    'encode',
    `\`${attribute}: ${given}\` is not a recognised value; using \`${fallback}\``,
    `Allowed values: ${allowed.join(', ')}.`,
  );
}

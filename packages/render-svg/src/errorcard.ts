/**
 * The error card (SPEC 14.1 principle 2).
 *
 * > Failures are visible, not silent — an error card with the code, the message
 * > and the raw data, **never an empty frame**.
 *
 * So this renders three things, in that order, and it renders them even when the
 * diagnostic list is empty and even when the raw source is enormous. It is the
 * last thing standing between a broken block and a blank rectangle, which is why
 * it takes no options that could turn any of its three parts off.
 *
 * It is built from the same {@link VNode} machinery as everything else, so the
 * escaping and the attribute allowlist apply here too: the raw source of a block
 * that failed to parse is the *most* likely place for hostile input to appear.
 */

import type { Diagnostic } from '@mdv/core';
import { formatNumber } from './format.js';
import { serialiseVNode } from './string.js';
import type { VNode } from './vnode.js';
import { el } from './vnode.js';

/** Layout constants. Fixed, so the card is byte-stable like everything else. */
const PAD = 12;
const LINE = 18;
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SANS = 'system-ui, -apple-system, "Segoe UI", sans-serif';
const MAX_RAW_LINES = 12;
const MAX_RAW_COLUMNS = 96;

/** Options for {@link errorCardVNode}. */
export interface ErrorCardOptions {
  /** Card width in px. @defaultValue 640 */
  width?: number;
  /** Precision for the geometry. @defaultValue 3 */
  precision?: number;
  /** Ink and surface, so the card matches the theme in force. */
  colors?: { text?: string; muted?: string; border?: string; surface?: string; critical?: string };
  /** Id namespace, as elsewhere. @defaultValue 'mdv-error' */
  idPrefix?: string;
}

/**
 * Clip the raw source to something that fits on a card without hiding the
 * problem: the first {@link MAX_RAW_LINES} lines, each truncated to
 * {@link MAX_RAW_COLUMNS} columns, with an explicit marker when anything was
 * dropped. Truncation is *stated*, never silent.
 */
function rawLines(raw: string): string[] {
  const all = raw.replace(/\r\n?/g, '\n').split('\n');
  const kept = all.slice(0, MAX_RAW_LINES).map((line) => {
    const tabbed = line.replace(/\t/g, '  ');
    return tabbed.length > MAX_RAW_COLUMNS ? `${tabbed.slice(0, MAX_RAW_COLUMNS - 1)}…` : tabbed;
  });
  if (all.length > MAX_RAW_LINES) kept.push(`… ${all.length - MAX_RAW_LINES} more lines`);
  return kept;
}

/** Build the error card as a virtual tree. */
export function errorCardVNode(
  diagnostics: readonly Diagnostic[],
  raw: string,
  options: ErrorCardOptions = {},
): VNode {
  const width = options.width ?? 640;
  const precision = options.precision ?? 3;
  const text = options.colors?.text ?? '#0b0b0b';
  const muted = options.colors?.muted ?? '#898781';
  const border = options.colors?.border ?? 'rgba(11,11,11,0.10)';
  const surface = options.colors?.surface ?? '#fcfcfb';
  const critical = options.colors?.critical ?? '#d03b3b';
  const prefix = options.idPrefix ?? 'mdv-error';
  const n = (v: number): string => formatNumber(v, precision);

  const lines = rawLines(raw);
  const shown = diagnostics.length === 0 ? 1 : diagnostics.length;
  const height = PAD * 3 + LINE * (1 + shown + lines.length) + LINE;

  const body: VNode[] = [];
  let y = PAD + LINE;

  body.push(
    el(
      'text',
      [
        ['x', n(PAD)],
        ['y', n(y)],
        ['font-family', SANS],
        ['font-size', n(13)],
        ['font-weight', '600'],
        ['fill', critical],
      ],
      [],
      'This block could not be rendered',
    ),
  );
  y += LINE + 4;

  if (diagnostics.length === 0) {
    body.push(
      el(
        'text',
        [
          ['x', n(PAD)],
          ['y', n(y)],
          ['font-family', SANS],
          ['font-size', n(12)],
          ['fill', text],
        ],
        [],
        'No diagnostic was recorded for this failure',
      ),
    );
    y += LINE;
  } else {
    for (const d of diagnostics) {
      body.push(
        el(
          'text',
          [
            ['x', n(PAD)],
            ['y', n(y)],
            ['font-family', SANS],
            ['font-size', n(12)],
            ['fill', text],
          ],
          [],
          // The code first: it is the thing an author can look up, and the thing
          // a bug report should carry.
          `${d.code} · ${d.message}`,
        ),
      );
      y += LINE;
    }
  }

  y += 4;
  body.push(
    el('line', [
      ['x1', n(PAD)],
      ['y1', n(y - LINE + 6)],
      ['x2', n(width - PAD)],
      ['y2', n(y - LINE + 6)],
      ['stroke', border],
      ['stroke-width', '1'],
    ]),
  );

  for (const line of lines) {
    body.push(
      el(
        'text',
        [
          ['x', n(PAD)],
          ['y', n(y)],
          ['font-family', MONO],
          ['font-size', n(11.5)],
          ['fill', muted],
          ['xml:space', 'preserve'],
        ],
        [],
        line,
      ),
    );
    y += LINE;
  }

  const title = `Block error: ${diagnostics[0]?.code ?? 'unknown'}`;
  return el(
    'svg',
    [
      ['xmlns', 'http://www.w3.org/2000/svg'],
      ['class', 'mdv-root mdv-error-card'],
      ['width', n(width)],
      ['height', n(height)],
      ['viewBox', `0 0 ${n(width)} ${n(height)}`],
      ['preserveAspectRatio', 'xMidYMid meet'],
      ['role', 'img'],
      ['aria-labelledby', `${prefix}-title`],
    ],
    [
      el('title', [['id', `${prefix}-title`]], [], title),
      el('rect', [
        ['x', '0.5'],
        ['y', '0.5'],
        ['width', n(width - 1)],
        ['height', n(height - 1)],
        ['rx', '4'],
        ['fill', surface],
        ['stroke', border],
        ['stroke-width', '1'],
      ]),
      ...body,
    ],
  );
}

/** Render the error card for a block that could not render (SPEC 14.1). */
export function errorCardString(
  diagnostics: readonly Diagnostic[],
  raw: string,
  options: ErrorCardOptions = {},
): string {
  return serialiseVNode(errorCardVNode(diagnostics, raw, options));
}

/**
 * The error card (SPEC 14.1 principle 2).
 *
 * > **Failures are visible, not silent.** A block that cannot render shows an
 * > error card carrying the code, the message, and the raw data — never an empty
 * > frame.
 *
 * The card is a normal {@link Scene}: it has an accessible name, a description
 * and the full table view, so a block that failed to *draw* has still delivered
 * its data to every reader. That is the difference between a failure and a loss.
 */

import type { Diagnostic } from '@mdv/parser';
import type { LayoutContext, Rect, Size } from '../types/layout.js';
import type { A11yTable, Scene, SceneNode } from '../types/scene.js';
import { CLS } from './ids.js';
import { ellipsize, lineHeight, makeText, solid, themeFont, wrapText } from './text.js';
import { roundScene } from './precision.js';

/** Padding inside the card. */
const CARD_PADDING = 12;
/** Diagnostics listed before the card says "and N more". */
const MAX_LISTED = 4;

/** Options for {@link buildErrorScene}. */
export interface ErrorSceneOptions {
  size: Size;
  blockId: string;
  blockType: string;
  diagnostics: readonly Diagnostic[];
  /** The data, so a failed block still shows its numbers. */
  table: A11yTable;
  ctx: LayoutContext;
  /** Used as the accessible name when the block had a title. */
  title?: string | undefined;
}

/**
 * Build the scene for a block that cannot render.
 *
 * Total: it never inspects anything that could itself fail, so an error in the
 * error path cannot cascade. The worst case is a card with a generic message.
 */
export function buildErrorScene(options: ErrorSceneOptions): Scene {
  const { ctx, size } = options;
  const theme = ctx.theme;
  const width = Math.max(0, size.width);
  const height = Math.max(0, size.height);

  const errors = options.diagnostics.filter((d) => d.severity === 'error');
  const listed = (errors.length > 0 ? errors : options.diagnostics).slice(0, MAX_LISTED);
  const remaining =
    (errors.length > 0 ? errors.length : options.diagnostics.length) - listed.length;

  const headingFont = themeFont(theme, 'subtitle');
  const bodyFont = themeFont(theme, 'caption');
  const codeFont = { ...bodyFont, weight: 600 };

  const children: SceneNode[] = [];
  const card: Rect = {
    x: 0.5,
    y: 0.5,
    width: Math.max(0, width - 1),
    height: Math.max(0, height - 1),
  };

  children.push({
    kind: 'rect',
    x: card.x,
    y: card.y,
    w: card.width,
    h: card.height,
    r: theme.metrics.radius,
    fill: solid(theme.tokens.surface),
    stroke: { paint: solid(theme.status.critical), width: theme.metrics.hairline },
    cls: CLS.error,
  });

  const textWidth = Math.max(0, card.width - CARD_PADDING * 2);
  let y = card.y + CARD_PADDING;

  const headingHeight = lineHeight(headingFont, ctx.metrics);
  children.push(
    makeText(
      {
        x: card.x + CARD_PADDING,
        y,
        text: ellipsize(
          `${capitalise(options.blockType)} block could not be rendered`,
          headingFont,
          ctx.metrics,
          textWidth,
        ),
        font: headingFont,
        fill: solid(theme.tokens['text-primary']),
        anchor: 'start',
        baseline: 'top',
        cls: CLS.errorMessage,
        id: ctx.ids.next('error'),
      },
      ctx.metrics,
    ),
  );
  y += headingHeight + 6;

  const bodyHeight = lineHeight(bodyFont, ctx.metrics);
  for (const diagnostic of listed) {
    if (y + bodyHeight > card.y + card.height - CARD_PADDING) break;
    const codeText = `${diagnostic.code} `;
    const codeWidth = ctx.metrics.measure(codeText, codeFont).width;
    children.push(
      makeText(
        {
          x: card.x + CARD_PADDING,
          y,
          text: codeText,
          font: codeFont,
          fill: solid(theme.status.critical),
          anchor: 'start',
          baseline: 'top',
          cls: CLS.errorCode,
        },
        ctx.metrics,
      ),
    );
    const lines = wrapText(
      diagnostic.message,
      bodyFont,
      ctx.metrics,
      Math.max(0, textWidth - codeWidth),
      2,
    );
    lines.forEach((line, index) => {
      children.push(
        makeText(
          {
            x: card.x + CARD_PADDING + (index === 0 ? codeWidth : 0),
            y: y + index * bodyHeight,
            text: line,
            font: bodyFont,
            fill: solid(theme.tokens['text-secondary']),
            anchor: 'start',
            baseline: 'top',
            cls: CLS.errorMessage,
          },
          ctx.metrics,
        ),
      );
    });
    y += Math.max(1, lines.length) * bodyHeight + 2;
  }

  if (remaining > 0 && y + bodyHeight <= card.y + card.height - CARD_PADDING) {
    children.push(
      makeText(
        {
          x: card.x + CARD_PADDING,
          y,
          text: `and ${remaining} more`,
          font: bodyFont,
          fill: solid(theme.tokens['text-muted']),
          anchor: 'start',
          baseline: 'top',
          cls: CLS.errorMessage,
        },
        ctx.metrics,
      ),
    );
    y += bodyHeight + 2;
  }

  if (options.table.rows.length > 0 && y + bodyHeight <= card.y + card.height - CARD_PADDING) {
    children.push(
      makeText(
        {
          x: card.x + CARD_PADDING,
          y: card.y + card.height - CARD_PADDING,
          text: `The data is below: ${options.table.rows.length} row${
            options.table.rows.length === 1 ? '' : 's'
          }.`,
          font: bodyFont,
          fill: solid(theme.tokens['text-muted']),
          anchor: 'start',
          baseline: 'bottom',
          cls: CLS.errorMessage,
        },
        ctx.metrics,
      ),
    );
  }

  const summary =
    listed.length === 0
      ? `${capitalise(options.blockType)} block could not be rendered.`
      : `${capitalise(options.blockType)} block could not be rendered. ${listed
          .map((d) => `${d.code}: ${d.message}`)
          .join('. ')}.`;

  const scene: Scene = {
    width,
    height,
    background: solid(theme.tokens.page),
    defs: [],
    root: {
      kind: 'group',
      cls: `${CLS.root} ${CLS.error}`,
      id: ctx.ids.next('root'),
      role: 'img',
      label: summary,
      children,
    },
    a11y: {
      role: 'img',
      name: options.title !== undefined && options.title !== '' ? options.title : summary,
      desc: summary,
      descGenerated: true,
      table: options.table,
      focusOrder: [],
    },
    hitIndex: [],
    meta: {
      blockId: options.blockId,
      type: options.blockType,
      theme: theme.name,
      version: '',
    },
  };
  return roundScene(scene);
}

function capitalise(text: string): string {
  return text === '' ? 'This' : text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The React binding's stylesheet (SPEC 22.4).
 *
 * > One stylesheet … using custom properties for every token and **no global
 * > selectors** — all rules are scoped under `.mdv-root`. Class names are stable
 * > and namespaced and are part of the public API, versioned with the package.
 *
 * `@mdv/render-svg` ships the chart half: the surface, the hit layer, the
 * tooltip, the crosshair, the focus ring and the live region. This file adds
 * only what exists in the React binding and nowhere else — the document flow,
 * the block wrapper, the virtualisation placeholder, the table view of SPEC 12.3,
 * the HTML error card of SPEC 14 and the page-break marker of SPEC 28.4. Every
 * rule is scoped under `.mdv-root`, and there is not one element selector that
 * is not.
 *
 * Nothing here is emitted as an inline `style` attribute anywhere in the
 * package. `style-src 'self' 'nonce-…'` blocks inline style *attributes* as well
 * as inline `<style>` elements (SPEC 13.5), so alignment, sizing and colour all
 * travel as classes or as custom properties set through `setProperty`.
 */

import { stylesheet as chartStylesheet, CLASS_NAMES as CHART_CLASSES } from '@mdv/render-svg';

/**
 * Class names this package emits. Stable and part of the public API.
 *
 * Frozen so an embedder cannot mutate the table and change what a *different*
 * document renders (SPEC 17.3 invariant 4).
 */
export const REACT_CLASS_NAMES = Object.freeze({
  document: 'mdv-document',
  block: 'mdv-block',
  /** The interaction host: the box the tooltip and the focus ring live in. */
  surface: 'mdv-chart-surface',
  placeholder: 'mdv-placeholder',
  tableView: 'mdv-table-view',
  tableSummary: 'mdv-table-summary',
  dataTable: 'mdv-data-table',
  visuallyHidden: 'mdv-visually-hidden',
  /** The `:::mdv-page` marker: addressable, but invisible on screen (SPEC 28.4). */
  pageBreak: 'mdv-page-break',
  errorCard: 'mdv-error-card',
  errorHead: 'mdv-error-head',
  errorCode: 'mdv-error-code',
  errorMessage: 'mdv-error-message',
  errorDetail: 'mdv-error-detail',
  errorSource: 'mdv-error-source',
  alignLeft: 'mdv-align-left',
  alignRight: 'mdv-align-right',
  alignCenter: 'mdv-align-center',
});

/** Every class name the two packages emit together. */
export const CLASS_NAMES = Object.freeze({ ...CHART_CLASSES, ...REACT_CLASS_NAMES });

const SHEET = `\
.mdv-root .mdv-document,.mdv-root.mdv-document{display:flow-root}
.mdv-root .mdv-block{display:block;margin:1em 0;max-width:100%}
.mdv-root .mdv-page-break{display:block}
.mdv-root .mdv-chart-surface{display:block;position:relative;max-width:100%}
.mdv-root .mdv-placeholder{display:block;width:100%;\
border:var(--mdv-hairline) dashed var(--mdv-border);border-radius:var(--mdv-radius);\
box-sizing:border-box}
.mdv-root .mdv-table-view{margin-top:6px;font-size:calc(var(--mdv-font-size) * 0.92)}
.mdv-root .mdv-table-summary{cursor:default;color:var(--mdv-text-secondary);\
padding:2px 4px;border-radius:var(--mdv-radius);min-height:24px;display:list-item}
.mdv-root .mdv-table-summary:focus-visible{outline:var(--mdv-ring) solid var(--mdv-text-primary);\
outline-offset:var(--mdv-ring)}
.mdv-root .mdv-data-table{border-collapse:collapse;margin-top:6px;max-width:100%}
.mdv-root .mdv-data-table caption{text-align:left;color:var(--mdv-text-secondary);\
padding-bottom:4px}
.mdv-root .mdv-data-table th,.mdv-root .mdv-data-table td{\
border-bottom:var(--mdv-hairline) solid var(--mdv-border);padding:2px 8px;\
font-variant-numeric:tabular-nums;white-space:nowrap}
.mdv-root .mdv-data-table thead th{color:var(--mdv-text-secondary);font-weight:600}
.mdv-root .mdv-align-left{text-align:left}
.mdv-root .mdv-align-right{text-align:right}
.mdv-root .mdv-align-center{text-align:center}
.mdv-root .mdv-visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;\
overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0}
.mdv-root .mdv-error-card{display:block;box-sizing:border-box;\
border:var(--mdv-hairline) solid var(--mdv-border);border-left:3px solid var(--mdv-error-ink,#d03b3b);\
border-radius:var(--mdv-radius);padding:12px;background:var(--mdv-surface);color:var(--mdv-text-primary)}
.mdv-root .mdv-error-head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.mdv-root .mdv-error-code{font-family:var(--mdv-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);\
font-weight:600;color:var(--mdv-error-ink,#d03b3b)}
.mdv-root .mdv-error-message{font-weight:600}
.mdv-root .mdv-error-detail{margin:4px 0 0;color:var(--mdv-text-secondary)}
.mdv-root .mdv-error-source{margin:8px 0 0;padding:8px;overflow:auto;max-height:16em;\
background:var(--mdv-page);border-radius:var(--mdv-radius);\
font-family:var(--mdv-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);\
font-size:calc(var(--mdv-font-size) * 0.92);white-space:pre;color:var(--mdv-text-secondary)}
@media (forced-colors:active){.mdv-root .mdv-error-card{border-color:CanvasText}\
.mdv-root .mdv-error-code{color:CanvasText}}
@media print{\
.mdv-root .mdv-page-break[data-mdv-break=before]{page-break-before:always;break-before:page}\
.mdv-root .mdv-page-break[data-mdv-break=after]{page-break-after:always;break-after:page}\
.mdv-root .mdv-page-break[data-mdv-break=avoid]{page-break-inside:avoid;break-inside:avoid}}
`.replace(/\n/g, '');

/**
 * The rules this package adds, without the chart stylesheet.
 *
 * Useful when an embedder already ships `@mdv/render-svg`'s sheet — for instance
 * a page that renders static SVG strings server-side and hydrates only some of
 * them.
 */
export function reactStylesheet(): string {
  return SHEET;
}

/**
 * The complete stylesheet: `@mdv/render-svg`'s chart rules plus this package's.
 *
 * Emit it as an external file, or let {@link MdvProvider} render it into the
 * tree with a nonce.
 */
export function stylesheet(): string {
  return `${chartStylesheet()}${SHEET}`;
}

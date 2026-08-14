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
 * the HTML error card of SPEC 14, the page-break marker of SPEC 28.4 and the
 * directives of SPEC 9.1 and 9.2, which have no SVG half at all. Every rule is
 * scoped under `.mdv-root`, and there is not one element selector that is not.
 *
 * Directive status colour comes from three hooks — `--mdv-good-ink`,
 * `--mdv-warn-ink` and `--mdv-error-ink` — each falling back to its
 * `STATUS_PALETTE` value (SPEC 11.3.1), so a callout, a badge and a delta agree
 * with the arrow a chart draws for the same news. Hue is never the only signal:
 * every one of them ships an icon or a word beside it (SPEC 16.2).
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

  // ── Directives (SPEC 9.1, 9.2) ─────────────────────────────────────────────
  // Named after the construct that emits them, so a rule in an embedder's
  // override sheet can be traced back to the `:::mdv-…` an author wrote.
  figure: 'mdv-figure',
  figureCaption: 'mdv-figure-caption',
  callout: 'mdv-callout',
  calloutHead: 'mdv-callout-head',
  calloutIcon: 'mdv-callout-icon',
  tabs: 'mdv-tabs',
  tabList: 'mdv-tab-list',
  tab: 'mdv-tab',
  tabPanel: 'mdv-tab-panel',
  tabTitle: 'mdv-tab-title',
  details: 'mdv-details',
  detailsSummary: 'mdv-details-summary',
  grid: 'mdv-grid',
  columns: 'mdv-columns',
  ref: 'mdv-ref',
  value: 'mdv-value',
  metric: 'mdv-metric',
  delta: 'mdv-delta',
  deltaArrow: 'mdv-delta-arrow',
  badge: 'mdv-badge',
  badgeIcon: 'mdv-badge-icon',
  spark: 'mdv-spark',
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
.mdv-root .mdv-figure{display:block;margin:1em 0;max-width:100%}
.mdv-root .mdv-figure-caption{margin:6px 0 0;color:var(--mdv-text-secondary);\
font-size:calc(var(--mdv-font-size) * 0.92)}
.mdv-root .mdv-callout{--mdv-callout-ink:var(--mdv-text-muted);display:block;box-sizing:border-box;\
margin:1em 0;padding:8px 12px;background:var(--mdv-surface);\
border:var(--mdv-hairline) solid var(--mdv-border);border-left:3px solid var(--mdv-callout-ink);\
border-radius:var(--mdv-radius)}
.mdv-root .mdv-callout[data-mdv-callout=tip]{--mdv-callout-ink:var(--mdv-good-ink,#0ca30c)}
.mdv-root .mdv-callout[data-mdv-callout=warning]{--mdv-callout-ink:var(--mdv-warn-ink,#fab219)}
.mdv-root .mdv-callout[data-mdv-callout=danger]{--mdv-callout-ink:var(--mdv-error-ink,#d03b3b)}
.mdv-root .mdv-callout>:last-child{margin-bottom:0}
.mdv-root .mdv-callout-head{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap;\
margin:0 0 4px;font-weight:600}
.mdv-root .mdv-callout-icon{flex:none;font-weight:700;color:var(--mdv-callout-ink)}
.mdv-root .mdv-tabs{display:block;margin:1em 0}
.mdv-root .mdv-tab-list{display:flex;flex-wrap:wrap;gap:2px;\
border-bottom:var(--mdv-hairline) solid var(--mdv-border)}
.mdv-root .mdv-tab{appearance:none;-webkit-appearance:none;margin:0 0 -1px;padding:4px 10px;\
font:inherit;color:var(--mdv-text-secondary);background:none;border:0;\
border-bottom:2px solid transparent;cursor:pointer}
.mdv-root .mdv-tab[aria-selected=true]{font-weight:600;color:var(--mdv-text-primary);\
border-bottom-color:var(--mdv-text-primary)}
.mdv-root .mdv-tab:focus-visible{outline:var(--mdv-ring) solid var(--mdv-text-primary);\
outline-offset:calc(-1 * var(--mdv-ring))}
.mdv-root .mdv-tab-panel{padding-top:8px}
.mdv-root .mdv-tab-panel:focus-visible{outline:var(--mdv-ring) solid var(--mdv-text-primary);\
outline-offset:var(--mdv-ring)}
.mdv-root .mdv-tab-title{margin:0 0 4px;font-weight:600}
.mdv-root .mdv-details{display:block;box-sizing:border-box;margin:1em 0;padding:8px 12px;\
background:var(--mdv-surface);border:var(--mdv-hairline) solid var(--mdv-border);\
border-radius:var(--mdv-radius)}
.mdv-root .mdv-details>:last-child{margin-bottom:0}
.mdv-root .mdv-details-summary{cursor:default;min-height:24px;font-weight:600;\
border-radius:var(--mdv-radius)}
.mdv-root .mdv-details-summary:focus-visible{outline:var(--mdv-ring) solid var(--mdv-text-primary);\
outline-offset:var(--mdv-ring)}
.mdv-root .mdv-details[open] .mdv-details-summary{margin-bottom:6px}
.mdv-root .mdv-grid{display:grid;margin:1em 0;gap:var(--mdv-directive-gap,12px);\
grid-template-columns:repeat(2,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-cols="1"]{grid-template-columns:minmax(0,1fr)}
.mdv-root .mdv-grid[data-mdv-cols="2"]{grid-template-columns:repeat(2,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-cols="3"]{grid-template-columns:repeat(3,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-cols="4"]{grid-template-columns:repeat(4,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-cols="5"]{grid-template-columns:repeat(5,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-cols="6"]{grid-template-columns:repeat(6,minmax(0,1fr))}
.mdv-root .mdv-grid[data-mdv-align=start]{align-items:start}
.mdv-root .mdv-grid[data-mdv-align=center]{align-items:center}
.mdv-root .mdv-grid[data-mdv-align=end]{align-items:end}
.mdv-root .mdv-grid[data-mdv-align=stretch]{align-items:stretch}
.mdv-root .mdv-grid>*{min-width:0}
.mdv-root .mdv-columns{display:block;margin:1em 0;column-gap:var(--mdv-directive-gap,24px);\
column-count:2}
.mdv-root .mdv-columns[data-mdv-count="1"]{column-count:1}
.mdv-root .mdv-columns[data-mdv-count="2"]{column-count:2}
.mdv-root .mdv-columns[data-mdv-count="3"]{column-count:3}
.mdv-root .mdv-columns[data-mdv-count="4"]{column-count:4}
.mdv-root .mdv-columns[data-mdv-count="5"]{column-count:5}
.mdv-root .mdv-columns[data-mdv-count="6"]{column-count:6}
.mdv-root .mdv-columns>*{break-inside:avoid}
@media (max-width:640px){\
.mdv-root .mdv-grid[data-mdv-cols]{grid-template-columns:minmax(0,1fr)}\
.mdv-root .mdv-columns[data-mdv-count]{column-count:1}}
.mdv-root .mdv-ref{text-decoration:underline;text-underline-offset:2px}
.mdv-root .mdv-value,.mdv-root .mdv-metric{font-variant-numeric:tabular-nums}
.mdv-root .mdv-ref[data-mdv-unresolved],.mdv-root .mdv-value[data-mdv-unresolved]{\
font-family:var(--mdv-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);\
color:var(--mdv-error-ink,#d03b3b);text-decoration:none}
.mdv-root .mdv-delta{white-space:nowrap;font-variant-numeric:tabular-nums;\
color:var(--mdv-text-secondary)}
.mdv-root .mdv-delta[data-mdv-tone=good]{color:var(--mdv-good-ink,#0ca30c)}
.mdv-root .mdv-delta[data-mdv-tone=critical]{color:var(--mdv-error-ink,#d03b3b)}
.mdv-root .mdv-delta[data-mdv-tone=neutral]{color:var(--mdv-text-secondary)}
.mdv-root .mdv-delta-arrow{margin-right:2px;font-size:0.85em}
.mdv-root .mdv-badge{--mdv-badge-ink:var(--mdv-text-muted);display:inline-flex;gap:4px;\
align-items:baseline;vertical-align:baseline;padding:0 6px;white-space:nowrap;\
font-size:calc(var(--mdv-font-size) * 0.85);line-height:1.6;\
border:var(--mdv-hairline) solid var(--mdv-badge-ink);border-radius:999px}
.mdv-root .mdv-badge[data-mdv-badge=tip]{--mdv-badge-ink:var(--mdv-good-ink,#0ca30c)}
.mdv-root .mdv-badge[data-mdv-badge=warning]{--mdv-badge-ink:var(--mdv-warn-ink,#fab219)}
.mdv-root .mdv-badge[data-mdv-badge=danger]{--mdv-badge-ink:var(--mdv-error-ink,#d03b3b)}
.mdv-root .mdv-badge-icon{flex:none;font-weight:700;color:var(--mdv-badge-ink)}
.mdv-root .mdv-spark{display:inline-block;width:4em;height:1em;vertical-align:-0.15em;\
overflow:visible;fill:none;stroke:currentColor;stroke-width:1;stroke-linecap:round;\
stroke-linejoin:round}
.mdv-root .mdv-spark rect{fill:currentColor;stroke:none}
@media (forced-colors:active){.mdv-root .mdv-error-card{border-color:CanvasText}\
.mdv-root .mdv-error-code{color:CanvasText}\
.mdv-root .mdv-callout,.mdv-root .mdv-details,.mdv-root .mdv-badge{border-color:CanvasText}\
.mdv-root .mdv-callout-icon,.mdv-root .mdv-badge-icon,.mdv-root .mdv-delta,\
.mdv-root .mdv-ref[data-mdv-unresolved],.mdv-root .mdv-value[data-mdv-unresolved]{color:CanvasText}\
.mdv-root .mdv-tab[aria-selected=true]{border-bottom-color:CanvasText}}
@media print{\
.mdv-root .mdv-figure,.mdv-root .mdv-callout,.mdv-root .mdv-details{break-inside:avoid}\
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

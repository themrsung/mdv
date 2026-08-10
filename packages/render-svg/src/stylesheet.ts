/**
 * The scoped stylesheet (SPEC 22.4).
 *
 * > One stylesheet of ~2 KB using custom properties for every token and **no
 * > global selectors** — all rules are scoped under `.mdv-root`. Class names are
 * > stable and namespaced and are part of the public API, versioned with the
 * > package.
 *
 * Three requirements shape it:
 *
 * - **CSP-safe (SPEC 13.5).** It functions under
 *   `default-src 'none'; style-src 'self' 'nonce-…'` with no `unsafe-inline`:
 *   there are no `url()` references, no `@import`, and no `expression()`. The
 *   caller emits it as an external sheet or with a nonce.
 * - **Dark under *both* triggers (SPEC 11.7).** `@media (prefers-color-scheme:
 *   dark)` *and* `[data-theme='dark']`, so a viewer's explicit toggle wins in
 *   both directions rather than only when it agrees with the OS.
 * - **`forced-colors` and `prefers-reduced-motion` are honoured** (SPEC 11.7,
 *   12.5): system colours plus the texture channel in the first, no transitions
 *   at all in the second.
 *
 * Note what the sheet does *not* do: it never sets a colour on a mark. Marks
 * carry resolved absolutes from the scene (SPEC 20, "No CSS"), and a stylesheet
 * that could recolour them would be a second, competing theme system.
 */

/**
 * The stable class names, exported because SPEC 22.4 makes them public API and a
 * consumer overriding them needs something to import rather than a string to
 * copy.
 */
export const CLASS_NAMES = Object.freeze({
  root: 'mdv-root',
  chart: 'mdv-chart',
  surface: 'mdv-surface',
  interaction: 'mdv-interaction',
  hit: 'mdv-hit',
  crosshair: 'mdv-crosshair',
  focusRing: 'mdv-focus-ring',
  tooltip: 'mdv-tooltip',
  readoutRow: 'mdv-readout-row',
  readoutSwatch: 'mdv-readout-swatch',
  readoutValue: 'mdv-readout-value',
  readoutLabel: 'mdv-readout-label',
  live: 'mdv-live',
  errorCard: 'mdv-error-card',
});

const SHEET = `.mdv-root{--mdv-surface:#fcfcfb;--mdv-page:#f9f9f7;--mdv-text-primary:#0b0b0b;\
--mdv-text-secondary:#52514e;--mdv-text-muted:#898781;--mdv-grid:#e1e0d9;--mdv-axis:#c3c2b7;\
--mdv-border:rgba(11,11,11,0.10);--mdv-success-text:#006300;--mdv-radius:4px;--mdv-hairline:1px;\
--mdv-gap:2px;--mdv-ring:2px;--mdv-font:system-ui,-apple-system,"Segoe UI",sans-serif;\
--mdv-font-size:13px;--mdv-line-height:1.4;\
display:block;position:relative;font-family:var(--mdv-font);font-size:var(--mdv-font-size);\
line-height:var(--mdv-line-height);color:var(--mdv-text-primary)}
.mdv-root .mdv-chart,.mdv-root.mdv-chart{display:block;max-width:100%;overflow:visible;\
-webkit-tap-highlight-color:transparent}
.mdv-root .mdv-chart:focus{outline:none}
.mdv-root .mdv-chart:focus-visible{outline:var(--mdv-ring) solid var(--mdv-text-primary);\
outline-offset:var(--mdv-ring)}
.mdv-root .mdv-hit{cursor:default}
.mdv-root .mdv-crosshair{stroke:var(--mdv-axis);stroke-width:var(--mdv-hairline)}
.mdv-root .mdv-focus-ring{stroke:var(--mdv-text-primary);stroke-width:var(--mdv-ring);\
paint-order:stroke;rx:2}
.mdv-root .mdv-tooltip{position:absolute;z-index:2;pointer-events:none;\
transform:translate(-50%,calc(-100% - 10px));background:var(--mdv-surface);\
color:var(--mdv-text-primary);border:var(--mdv-hairline) solid var(--mdv-border);\
border-radius:var(--mdv-radius);padding:6px 8px;font-size:calc(var(--mdv-font-size) * 0.92);\
white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.12)}
.mdv-root .mdv-tooltip[hidden]{display:none}
.mdv-root .mdv-readout-row{display:flex;align-items:baseline;gap:6px}
.mdv-root .mdv-readout-row-emphasis{font-weight:600}
.mdv-root .mdv-readout-swatch{flex:none;width:10px;height:2px;border-radius:1px;\
align-self:center}
.mdv-root .mdv-readout-value{font-variant-numeric:tabular-nums}
.mdv-root .mdv-readout-label{color:var(--mdv-text-secondary)}
.mdv-root .mdv-live{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;\
clip-path:inset(50%);white-space:nowrap;border:0}
.mdv-root .mdv-error-card{border:var(--mdv-hairline) solid var(--mdv-border);\
border-radius:var(--mdv-radius);padding:12px;background:var(--mdv-surface)}
@media (prefers-color-scheme:dark){.mdv-root:not([data-theme=light]){--mdv-surface:#1a1a19;\
--mdv-page:#0d0d0d;--mdv-text-primary:#ffffff;--mdv-text-secondary:#c3c2b7;\
--mdv-text-muted:#898781;--mdv-grid:#2c2c2a;--mdv-axis:#383835;\
--mdv-border:rgba(255,255,255,0.10);--mdv-success-text:#0ca30c}}
.mdv-root[data-theme=dark]{--mdv-surface:#1a1a19;--mdv-page:#0d0d0d;--mdv-text-primary:#ffffff;\
--mdv-text-secondary:#c3c2b7;--mdv-text-muted:#898781;--mdv-grid:#2c2c2a;--mdv-axis:#383835;\
--mdv-border:rgba(255,255,255,0.10);--mdv-success-text:#0ca30c}
@media (forced-colors:active){.mdv-root{--mdv-surface:Canvas;--mdv-page:Canvas;\
--mdv-text-primary:CanvasText;--mdv-text-secondary:CanvasText;--mdv-text-muted:GrayText;\
--mdv-grid:GrayText;--mdv-axis:CanvasText;--mdv-border:CanvasText;\
--mdv-success-text:CanvasText;forced-color-adjust:none;color:CanvasText}
.mdv-root .mdv-tooltip{background:Canvas;border-color:CanvasText;color:CanvasText}
.mdv-root .mdv-focus-ring{stroke:Highlight}}
@media (prefers-reduced-motion:reduce){.mdv-root *,.mdv-root *::before,.mdv-root *::after{\
animation-duration:0.01ms !important;animation-iteration-count:1 !important;\
transition-duration:0.01ms !important;scroll-behavior:auto !important}}`;

/**
 * The scoped stylesheet.
 *
 * Returned as a string rather than injected: SPEC 13.5's CSP requires it be
 * served as an external sheet or carried on a nonced `<style>`, and only the
 * embedder knows which.
 */
export function stylesheet(): string {
  return SHEET;
}

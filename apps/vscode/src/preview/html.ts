/**
 * The preview webview's shell HTML, and its Content Security Policy.
 *
 * SPEC 29.3 fixes the policy exactly:
 *
 * ```
 * default-src 'none';
 * img-src ${webview.cspSource} data:;
 * style-src ${webview.cspSource} 'nonce-…';
 * script-src 'nonce-…'
 * ```
 *
 * Consequences that shape the rest of the preview, and are the reason this file
 * exists rather than a template string inline somewhere:
 *
 * - `default-src 'none'` means **no network of any kind from the webview**: no
 *   remote fonts, no remote images, no `fetch`, no websocket. Every byte the
 *   preview shows was produced in the extension host.
 * - `script-src 'nonce-…'` with no `'unsafe-inline'` and no `'unsafe-eval'`
 *   means no inline handlers (`onclick=`) and no `eval`. The webview script
 *   attaches listeners with `addEventListener`, which is also what
 *   `@mdv/render-svg` already does (SPEC 13.5).
 * - The nonce is **per panel load**, generated from `crypto.getRandomValues`.
 *   This is the one place randomness is correct: a nonce that was deterministic
 *   would be no nonce at all. It is not library code and nothing about the
 *   rendered document depends on it (SPEC 24.3 constrains the *output*, not the
 *   transport).
 * - `localResourceRoots` is set by the caller to the extension bundle and the
 *   document's own folder, and nothing else.
 */

import type * as vscode from 'vscode';
import { stylesheet } from '@mdv/render-svg';

/** 128 bits of nonce, hex-encoded. Fresh for every `getHtml` call. */
function makeNonce(): string {
  const bytes = new Uint8Array(16);
  // Available in both the desktop (Node ≥ 20) and browser extension hosts.
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/**
 * The preview chrome.
 *
 * Kept minimal and in `vscode-*` variables so it tracks the editor theme without
 * a second stylesheet to maintain (SPEC 29.3: "`vscode-*` CSS variables map onto
 * MDV tokens").
 */
const CHROME_CSS = `
:root { color-scheme: light dark; }
html, body { margin: 0; padding: 0; height: 100%; }
body {
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-foreground);
  background: var(--vscode-editor-background);
}
#mdv-scroll { height: 100%; overflow-y: auto; overflow-x: hidden; padding: 12px 16px 48px; box-sizing: border-box; }
#mdv-blocks { display: flex; flex-direction: column; gap: 20px; max-width: 1200px; }
.mdv-block {
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 4px;
  scroll-margin-top: 12px;
  transition: border-color 120ms ease-out, background-color 120ms ease-out;
}
.mdv-block:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: 2px; }
.mdv-block.mdv-flash {
  border-color: var(--vscode-focusBorder);
  background: var(--vscode-editor-selectionHighlightBackground);
}
.mdv-block svg { display: block; max-width: 100%; height: auto; }
.mdv-host-error {
  border: 1px solid var(--vscode-inputValidation-errorBorder, #be1100);
  background: var(--vscode-inputValidation-errorBackground, rgba(190,17,0,0.1));
  border-radius: 4px; padding: 10px 12px; font-size: 12px;
}
.mdv-host-error code { font-family: var(--vscode-editor-font-family); }
#mdv-banner {
  display: none; align-items: center; gap: 12px; flex-wrap: wrap;
  margin: 0 0 16px; padding: 10px 12px; border-radius: 4px;
  border: 1px solid var(--vscode-notificationCenter-border, var(--vscode-panel-border));
  background: var(--vscode-notifications-background, var(--vscode-editorWidget-background));
  color: var(--vscode-notifications-foreground, var(--vscode-foreground));
  font-size: 12px;
}
#mdv-banner.mdv-visible { display: flex; }
#mdv-banner button {
  font: inherit; cursor: pointer; border: 1px solid transparent; border-radius: 2px;
  padding: 3px 10px;
  color: var(--vscode-button-foreground); background: var(--vscode-button-background);
}
#mdv-banner button.mdv-secondary {
  color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
}
#mdv-banner button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
#mdv-empty { color: var(--vscode-descriptionForeground); font-size: 13px; }
#mdv-status {
  position: fixed; right: 12px; bottom: 8px;
  font-size: 11px; color: var(--vscode-descriptionForeground);
  background: var(--vscode-editor-background); padding: 2px 6px; border-radius: 3px;
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) { .mdv-block { transition: none; } }
`.trim();

/** Build the shell. `scriptUri` must already be a webview URI. */
export function getPreviewHtml(webview: vscode.Webview, scriptUri: vscode.Uri): string {
  const nonce = makeNonce();
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    // Fonts are the editor's own; no remote font may be reached.
    `font-src ${webview.cspSource}`,
  ].join('; ');

  // `stylesheet()` is `@mdv/render-svg`'s own CSS for the chart classes and the
  // hover readout. It is served here, nonced, rather than inlined into each SVG
  // — which is exactly why `toSvgString` is called without `inlineStyles`.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>MDV Preview</title>
<style nonce="${nonce}">${CHROME_CSS}</style>
<style nonce="${nonce}">${stylesheet()}</style>
</head>
<body>
<div id="mdv-scroll" tabindex="-1">
  <div id="mdv-banner" role="status" hidden></div>
  <div id="mdv-empty">Loading preview…</div>
  <div id="mdv-blocks"></div>
</div>
<div id="mdv-status" aria-live="polite"></div>
<script nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`;
}

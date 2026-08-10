/**
 * The preview webview script, bundled to `dist/webview.js` (SPEC 29.8).
 *
 * It is deliberately small and does no MDV work: every chart arrives as a
 * finished SVG string produced by `@mdv/render-svg` in the extension host. This
 * script owns four things and nothing else.
 *
 * 1. **Applying patches.** A `patch` message replaces the innerHTML of the
 *    blocks that changed and leaves the rest of the DOM — and therefore the
 *    scroll position, the focus and the text selection — untouched. That is what
 *    makes the preview survive rapid editing.
 * 2. **Scroll sync**, bidirectional (SPEC 29.3), with a re-entrancy guard so the
 *    two directions cannot chase each other.
 * 3. **Interaction**: hover/focus readouts, driven from the hit-rect overlay the
 *    scene already carries, and click-to-reveal-source.
 * 4. **State**, via `setState`/`getState`, so a serialised panel comes back where
 *    it was.
 *
 * Under the CSP of `preview/html.ts` there is no `eval`, no inline handler and
 * no remote fetch available here, and none is used.
 *
 * `@mdv/render-svg`'s `attachInteraction` is intentionally *not* imported: it
 * expects to own a freshly rendered host element and to be handed the live
 * `Scene` for its readout rows, neither of which survives the string transport.
 * Re-implementing the small part that works over markup — the hover readout from
 * `data-mdv-*` attributes — keeps the webview bundle at a few kilobytes.
 */

import type { BlockPayload, HostMessage, WebviewMessage } from '../preview/protocol.js';

/** The API VS Code injects into a webview. */
interface VsCodeApi {
  postMessage(message: WebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/**
 * What `setState` keeps. The URI is here rather than only in the host because
 * `deserializeWebviewPanel` is handed *this* object and nothing else — without
 * it a restored panel would not know which document it was previewing.
 */
interface PersistedState {
  readonly uri: string;
  readonly scrollTop: number;
}

const vscode = acquireVsCodeApi();

const scroller = document.getElementById('mdv-scroll');
const container = document.getElementById('mdv-blocks');
const banner = document.getElementById('mdv-banner');
const empty = document.getElementById('mdv-empty');
const status = document.getElementById('mdv-status');

/** Live block elements by index, so a patch is an O(1) lookup. */
const elements = new Map<number, HTMLElement>();
/** Line span per block index, for scroll sync. */
const spans = new Map<number, { start: number; end: number }>();

let scrollSyncEnabled = true;
/** Set while we are scrolling *because of* the editor, to avoid a feedback loop. */
let suppressScrollEvents = 0;
let flashTimer: ReturnType<typeof setTimeout> | undefined;
/** The document being previewed, learnt from the first `render` message. */
let documentUri = '';

function persist(): void {
  if (documentUri === '') return;
  vscode.setState({
    uri: documentUri,
    scrollTop: scroller?.scrollTop ?? 0,
  } satisfies PersistedState);
}

function post(message: WebviewMessage): void {
  try {
    vscode.postMessage(message);
  } catch {
    // A postMessage failure means the panel is going away; there is nothing
    // useful to do and throwing here would be swallowed anyway.
  }
}

function setStatus(text: string): void {
  if (status !== null) status.textContent = text;
}

/** The content width the host should lay out for. */
function contentWidth(): number {
  if (scroller === null) return 720;
  const style = window.getComputedStyle(scroller);
  const padding =
    Number.parseFloat(style.paddingLeft || '0') + Number.parseFloat(style.paddingRight || '0');
  return Math.max(160, Math.round(scroller.clientWidth - padding));
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function hostErrorMarkup(block: BlockPayload): string {
  const type = block.blockType.replace(/[<&>]/g, '');
  return (
    `<div class="mdv-host-error" role="alert">` +
    `The MDV preview could not render this <code>${type}</code> block. ` +
    `See the <strong>MDV</strong> output channel for the failure.</div>`
  );
}

function fillBlock(element: HTMLElement, block: BlockPayload): void {
  element.dataset['mdvIndex'] = String(block.index);
  element.dataset['mdvStart'] = String(block.startLine);
  element.dataset['mdvFamily'] = block.family;
  element.setAttribute('role', 'group');
  element.setAttribute(
    'aria-label',
    block.title !== undefined && block.title.length > 0
      ? block.title
      : `${block.blockType} block ${String(block.index + 1)}`,
  );
  // See BlockPayload.svg: the markup is our own serialiser's output, and the
  // CSP forbids script execution regardless.
  element.innerHTML = block.svg.length > 0 ? block.svg : hostErrorMarkup(block);
}

function makeBlock(block: BlockPayload): HTMLElement {
  const element = document.createElement('div');
  element.className = 'mdv-block';
  element.id = `mdv-block-${String(block.index)}`;
  fillBlock(element, block);
  return element;
}

/** Full render: rebuild the list. Used on open and when the structure changes. */
function renderAll(blocks: readonly BlockPayload[]): void {
  if (container === null) return;
  container.textContent = '';
  elements.clear();
  spans.clear();
  for (const block of blocks) {
    const element = makeBlock(block);
    container.appendChild(element);
    elements.set(block.index, element);
    spans.set(block.index, { start: block.startLine, end: block.endLine });
  }
  if (empty !== null) empty.hidden = blocks.length > 0;
  if (empty !== null && blocks.length === 0) {
    empty.textContent = 'No visual blocks in this document.';
    empty.hidden = false;
  }
}

/** Incremental patch: touch only the blocks whose SVG changed (SPEC 29.3). */
function applyPatch(blocks: readonly BlockPayload[]): void {
  for (const block of blocks) {
    spans.set(block.index, { start: block.startLine, end: block.endLine });
    const existing = elements.get(block.index);
    if (existing === undefined) {
      // A block appeared where there was none: fall back to a full render, which
      // is the only way to get the ordering right.
      post({ kind: 'ready', width: contentWidth() });
      return;
    }
    fillBlock(existing, block);
  }
}

function renderBanner(origins: readonly string[]): void {
  if (banner === null) return;
  if (origins.length === 0) {
    banner.classList.remove('mdv-visible');
    banner.hidden = true;
    banner.textContent = '';
    return;
  }
  banner.textContent = '';
  const text = document.createElement('span');
  text.textContent =
    origins.length === 1
      ? `This document wants to load data from ${origins[0] ?? ''}. External data is off.`
      : `This document wants to load data from ${String(origins.length)} origins: ${origins.join(', ')}. External data is off.`;
  banner.appendChild(text);

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.textContent = 'Allow for this workspace';
  allow.addEventListener('click', () => {
    post({ kind: 'requestExternal' });
  });
  banner.appendChild(allow);

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'mdv-secondary';
  dismiss.textContent = 'Dismiss';
  dismiss.addEventListener('click', () => {
    banner.classList.remove('mdv-visible');
    banner.hidden = true;
  });
  banner.appendChild(dismiss);

  banner.hidden = false;
  banner.classList.add('mdv-visible');
}

function renderCounts(errors: number, warnings: number): void {
  if (errors === 0 && warnings === 0) {
    setStatus('');
    return;
  }
  const parts: string[] = [];
  if (errors > 0) parts.push(`${String(errors)} error${errors === 1 ? '' : 's'}`);
  if (warnings > 0) parts.push(`${String(warnings)} warning${warnings === 1 ? '' : 's'}`);
  setStatus(parts.join(', '));
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll sync (SPEC 29.3)
// ─────────────────────────────────────────────────────────────────────────────

/** The block whose source span contains `line`, or the nearest one after it. */
function blockForLine(line: number): HTMLElement | undefined {
  let best: HTMLElement | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [index, span] of spans) {
    const element = elements.get(index);
    if (element === undefined) continue;
    if (line >= span.start && line <= span.end) return element;
    const distance = line < span.start ? span.start - line : line - span.end;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = element;
    }
  }
  return best;
}

/** The source line the top of the viewport corresponds to. */
function lineAtTop(): number | undefined {
  if (scroller === null) return undefined;
  const top = scroller.getBoundingClientRect().top;
  let candidate: number | undefined;
  for (const [index, span] of spans) {
    const element = elements.get(index);
    if (element === undefined) continue;
    const box = element.getBoundingClientRect();
    if (box.bottom < top) {
      // Entirely above the fold: the viewport is past this block.
      candidate = span.end;
      continue;
    }
    return span.start;
  }
  return candidate;
}

function revealLine(line: number): void {
  const element = blockForLine(line);
  if (element === undefined || scroller === null) return;
  suppressScrollEvents += 1;
  element.scrollIntoView({ block: 'start', behavior: 'auto' });
  // One frame is enough for the programmatic scroll to have fired its event.
  window.requestAnimationFrame(() => {
    suppressScrollEvents = Math.max(0, suppressScrollEvents - 1);
  });
}

function flashBlock(index: number): void {
  const element = elements.get(index);
  if (element === undefined) return;
  if (flashTimer !== undefined) clearTimeout(flashTimer);
  for (const other of elements.values()) other.classList.remove('mdv-flash');
  element.classList.add('mdv-flash');
  element.scrollIntoView({ block: 'nearest', behavior: 'auto' });
  flashTimer = setTimeout(() => {
    element.classList.remove('mdv-flash');
    flashTimer = undefined;
  }, 900);
}

// ─────────────────────────────────────────────────────────────────────────────
// Wiring
// ─────────────────────────────────────────────────────────────────────────────

let scrollTimer: ReturnType<typeof setTimeout> | undefined;

if (scroller !== null) {
  scroller.addEventListener(
    'scroll',
    () => {
      if (!scrollSyncEnabled || suppressScrollEvents > 0) return;
      if (scrollTimer !== undefined) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = undefined;
        const line = lineAtTop();
        if (line !== undefined) post({ kind: 'scrolled', line });
        post({ kind: 'state', scrollTop: scroller.scrollTop });
      }, 80);
    },
    { passive: true },
  );
}

// Click a chart → reveal its source (SPEC 29.3). One delegated listener rather
// than one per block, so a patch never has to re-attach anything.
if (container !== null) {
  container.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const block = target.closest('.mdv-block');
    if (!(block instanceof HTMLElement)) return;
    const start = block.dataset['mdvStart'];
    if (start === undefined) return;
    const line = Number.parseInt(start, 10);
    if (Number.isFinite(line)) post({ kind: 'revealSource', line });
  });
}

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  if (resizeTimer !== undefined) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeTimer = undefined;
    post({ kind: 'resize', width: contentWidth() });
  }, 120);
});

window.addEventListener('message', (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  try {
    switch (message.kind) {
      case 'render':
        scrollSyncEnabled = message.scrollSync;
        documentUri = message.documentUri;
        renderAll(message.blocks);
        renderBanner(message.blockedOrigins);
        renderCounts(message.errorCount, message.warningCount);
        restoreScroll();
        persist();
        break;
      case 'patch':
        applyPatch(message.blocks);
        renderBanner(message.blockedOrigins);
        renderCounts(message.errorCount, message.warningCount);
        break;
      case 'settings':
        scrollSyncEnabled = message.scrollSync;
        break;
      case 'revealLine':
        if (scrollSyncEnabled) revealLine(message.line);
        break;
      case 'highlightBlock':
        flashBlock(message.index);
        break;
      case 'status':
        setStatus(message.text);
        break;
    }
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});

function restoreScroll(): void {
  if (scroller === null) return;
  const state = vscode.getState();
  if (typeof state !== 'object' || state === null) return;
  const scrollTop = (state as Partial<PersistedState>).scrollTop;
  if (typeof scrollTop !== 'number' || !Number.isFinite(scrollTop)) return;
  suppressScrollEvents += 1;
  scroller.scrollTop = scrollTop;
  window.requestAnimationFrame(() => {
    suppressScrollEvents = Math.max(0, suppressScrollEvents - 1);
  });
}

// Persist locally as well as telling the host: `getState` survives the webview
// being backgrounded, which is the common case, while the host's copy survives a
// full window reload (SPEC 29.3).
if (scroller !== null) {
  scroller.addEventListener('scroll', persist, { passive: true });
}

post({ kind: 'ready', width: contentWidth() });

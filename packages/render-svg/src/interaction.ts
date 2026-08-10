/**
 * The DOM interaction layer (SPEC 7.5, 12.4).
 *
 * **This module contains no hit-testing.** Every target it responds to is a
 * transparent rect emitted from `Scene.hitIndex`, which layout computed and
 * already grew to the 24 × 24 minimum. The browser does the hit-testing, over the
 * scene's own geometry, which is what makes DOM and Canvas behave identically
 * (SPEC 20). Nothing here measures a mark, sorts by distance, or builds a
 * Voronoi diagram — if it did, the two backends would drift.
 *
 * The normative equivalence it exists to guarantee:
 *
 * > Keyboard focus MUST produce the same readout as hover.
 *
 * There is one `show(region)` function. Hover calls it, arrow keys call it, and
 * neither has its own formatting path, so the two cannot diverge.
 *
 * Everything is inserted with `textContent` / `createTextNode` (SPEC 13.3):
 * series and field names originate in untrusted data, and this file has no
 * `innerHTML` in it.
 */

import type { HitRegion, ReadoutRow, Scene } from '@mdv/core';

/** Callbacks the interaction layer invokes. All are optional. */
export interface InteractionHandlers {
  /** Pointer or keyboard focus moved onto a hit region. */
  onActivate?(regionId: string): void;
  /** Focus or pointer left the chart entirely. */
  onDeactivate?(): void;
  /** The user selected a mark (click, Enter, Space). */
  onSelect?(regionId: string): void;
  /** `T` toggled the table view (SPEC 12.4). */
  onToggleTable?(): void;
}

/**
 * Chart families that get a **vertical crosshair** (SPEC 7.5).
 *
 * The reader aims at a date, never at a 2 px stroke — so for these the readout
 * lists every series at that x and a rule marks the position. Bar, heatmap, pie,
 * treemap, funnel and waterfall use the mark itself as the target and get no
 * crosshair; scatter and bubble are nearest-point, which the hit rects already
 * express.
 */
const CROSSHAIR_FAMILIES = new Set(['line', 'area', 'ohlc', 'ohlcv', 'candlestick', 'spark']);

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Where the chart's own `<svg>` lives relative to the host we were handed. */
function findSvg(host: Element): SVGSVGElement | undefined {
  if (host.namespaceURI === SVG_NS && host.tagName.toLowerCase() === 'svg') {
    return host as SVGSVGElement;
  }
  const found = host.querySelector('svg');
  return found === null ? undefined : (found as SVGSVGElement);
}

/**
 * The scene→client transform implied by `preserveAspectRatio="xMidYMid meet"`.
 *
 * Computed from the element's box rather than read from `getScreenCTM`, because
 * jsdom does not implement `getScreenCTM` and a tooltip that only positions
 * itself correctly in a real browser is a tooltip nobody can test. `meet` scales
 * uniformly by the smaller ratio and centres the remainder, which is all this is.
 */
function viewportTransform(
  svg: Element,
  scene: Scene,
): { scale: number; offsetX: number; offsetY: number; left: number; top: number } {
  const rect = svg.getBoundingClientRect();
  const sx = scene.width > 0 ? rect.width / scene.width : 1;
  const sy = scene.height > 0 ? rect.height / scene.height : 1;
  const scale = Math.min(sx, sy) || 1;
  return {
    scale,
    offsetX: (rect.width - scene.width * scale) / 2,
    offsetY: (rect.height - scene.height * scale) / 2,
    left: rect.left,
    top: rect.top,
  };
}

/** Build one readout row: a swatch stroke, the value, then the series name. */
function readoutRowElement(doc: Document, row: ReadoutRow): HTMLElement {
  const li = doc.createElement('div');
  li.className = row.emphasis === true ? 'mdv-readout-row mdv-readout-row-emphasis' : 'mdv-readout-row';

  if (row.swatch !== undefined) {
    const swatch = doc.createElement('span');
    // A short line stroke, not a filled box (SPEC 7.5). The shape is the
    // stylesheet's; only the colour is data, and it goes through a style
    // property rather than a style *string*, so there is no CSS injection path.
    swatch.className = 'mdv-readout-swatch';
    swatch.style.setProperty('background-color', row.swatch);
    li.appendChild(swatch);
  }

  // The value is the prominent element; the series name is secondary (SPEC 7.5).
  const value = doc.createElement('span');
  value.className = 'mdv-readout-value';
  value.textContent = row.value;
  li.appendChild(value);

  if (row.label.length > 0) {
    const label = doc.createElement('span');
    label.className = 'mdv-readout-label';
    label.textContent = row.label;
    li.appendChild(label);
  }
  return li;
}

/**
 * Attach the DOM interaction layer to a rendered chart (SPEC 7.5, 12.4).
 *
 * Installs the hover readout, the vertical crosshair where the chart family calls
 * for one, the single tab stop, arrow-key traversal over `Scene.a11y.focusOrder`,
 * and the polite live region.
 *
 * @returns a disposer that removes every listener and every element added
 */
export function attachInteraction(
  host: Element,
  scene: Scene,
  handlers: InteractionHandlers = {},
): () => void {
  const svg = findSvg(host);
  const doc = host.ownerDocument;
  if (svg === undefined || doc === null) return () => undefined;

  // ── Index the scene, once ─────────────────────────────────────────────────
  const byId = new Map<string, HitRegion>();
  for (const region of scene.hitIndex) byId.set(region.id, region);

  // Keyboard traversal follows `a11y.focusOrder` — layout's ordering, not ours
  // (SPEC 12.4). Regions absent from the scene are skipped rather than trusted.
  const order = scene.a11y.focusOrder.filter((id) => byId.has(id));
  if (order.length === 0 && scene.hitIndex.length === 0) return () => undefined;

  const rects = new Map<string, Element>();
  for (const rect of Array.from(svg.querySelectorAll('[data-mdv-region]'))) {
    const id = rect.getAttribute('data-mdv-region');
    if (id !== null) rects.set(id, rect);
  }

  // ── Chrome: tooltip, live region, crosshair, focus ring ───────────────────
  const container = host as HTMLElement;
  const priorPosition = container.style.getPropertyValue('position');
  if (doc.defaultView !== null) {
    const computed = doc.defaultView.getComputedStyle(container).position;
    if (computed === 'static' || computed === '') container.style.setProperty('position', 'relative');
  }

  const tooltip = doc.createElement('div');
  tooltip.className = 'mdv-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  host.appendChild(tooltip);

  const live = doc.createElement('div');
  live.className = 'mdv-live';
  live.setAttribute('aria-live', 'polite');
  live.setAttribute('aria-atomic', 'true');
  host.appendChild(live);

  const crosshair = doc.createElementNS(SVG_NS, 'line');
  crosshair.setAttribute('class', 'mdv-crosshair');
  crosshair.setAttribute('y1', '0');
  crosshair.setAttribute('y2', String(scene.height));
  crosshair.setAttribute('pointer-events', 'none');
  const wantsCrosshair = CROSSHAIR_FAMILIES.has(scene.meta.type);

  const focusRing = doc.createElementNS(SVG_NS, 'rect');
  focusRing.setAttribute('class', 'mdv-focus-ring');
  focusRing.setAttribute('fill', 'none');
  focusRing.setAttribute('pointer-events', 'none');

  let active: HitRegion | undefined;
  let showingFocusRing = false;

  // ── The single readout path: hover and focus both land here ───────────────
  function show(region: HitRegion, viaKeyboard: boolean): void {
    active = region;

    while (tooltip.firstChild !== null) tooltip.removeChild(tooltip.firstChild);
    for (const row of region.readout) tooltip.appendChild(readoutRowElement(doc as Document, row));
    tooltip.hidden = false;

    const t = viewportTransform(svg as Element, scene);
    tooltip.style.setProperty('left', `${t.offsetX + region.anchor.x * t.scale}px`);
    tooltip.style.setProperty('top', `${t.offsetY + region.anchor.y * t.scale}px`);

    if (wantsCrosshair) {
      crosshair.setAttribute('x1', String(region.anchor.x));
      crosshair.setAttribute('x2', String(region.anchor.x));
      if (crosshair.parentNode === null) svg?.appendChild(crosshair);
    }

    if (viaKeyboard) {
      placeFocusRing(region);
      // Focus and hover produce the same readout; the live region announces it.
      live.textContent = tooltip.textContent ?? '';
      svg?.setAttribute('aria-activedescendant', rects.get(region.id)?.id ?? '');
    }

    handlers.onActivate?.(region.id);
  }

  /**
   * Draw the ring around the *mark*, not around the (larger) hit rectangle,
   * using `HitRegion.markNodeId` (SPEC 20). `getBBox` is unavailable in jsdom, so
   * the hit rect is the fallback — a visible ring in the wrong place beats no
   * ring at all.
   *
   * The id is read back off the hit rect rather than taken from the region.
   * `Scene` ids are namespaced with the block id on the way out (SPEC 13.3), so
   * `region.markNodeId` is `bar-0` while the element in the document is
   * `mdv-0-bar-0`: looking the raw id up would never match, and the ring would
   * quietly sit on the hit rect forever. The emitted `data-mdv-mark` carries the
   * resolved id, and the interaction layer is not the place that knows the
   * prefix.
   */
  function placeFocusRing(region: HitRegion): void {
    let box = { x: region.x, y: region.y, w: region.w, h: region.h };
    const markId = rects.get(region.id)?.getAttribute('data-mdv-mark') ?? undefined;
    if (markId !== undefined) {
      // An attribute selector, not `#id`: a `.` or `:` is legal in an id and
      // would be read as a class or a pseudo in the `#` form.
      const escaped = CSS_escape(markId);
      const mark = escaped.length === 0 ? null : (svg?.querySelector(`[id="${escaped}"]`) ?? null);
      const target = mark ?? svg?.ownerDocument.getElementById(markId) ?? null;
      const bbox = safeBBox(target);
      if (bbox !== undefined) box = bbox;
    }
    focusRing.setAttribute('x', String(box.x));
    focusRing.setAttribute('y', String(box.y));
    focusRing.setAttribute('width', String(box.w));
    focusRing.setAttribute('height', String(box.h));
    if (!showingFocusRing) {
      svg?.appendChild(focusRing);
      showingFocusRing = true;
    }
  }

  function hide(): void {
    active = undefined;
    tooltip.hidden = true;
    while (tooltip.firstChild !== null) tooltip.removeChild(tooltip.firstChild);
    crosshair.remove();
    focusRing.remove();
    showingFocusRing = false;
    live.textContent = '';
    svg?.removeAttribute('aria-activedescendant');
    handlers.onDeactivate?.();
  }

  // ── Pointer ───────────────────────────────────────────────────────────────
  function regionFromEvent(event: Event): HitRegion | undefined {
    const target = event.target;
    if (target === null || !(target instanceof Element)) return undefined;
    const holder = target.closest('[data-mdv-region]');
    const id = holder?.getAttribute('data-mdv-region');
    return id === null || id === undefined ? undefined : byId.get(id);
  }

  const onPointerOver = (event: Event): void => {
    const region = regionFromEvent(event);
    if (region !== undefined) show(region, false);
  };
  const onPointerLeave = (): void => {
    if (doc.activeElement !== svg) hide();
  };
  const onClick = (event: Event): void => {
    const region = regionFromEvent(event);
    if (region !== undefined) handlers.onSelect?.(region.id);
  };

  // ── Keyboard (SPEC 12.4) ──────────────────────────────────────────────────
  function indexOfActive(): number {
    if (active === undefined) return -1;
    return order.indexOf(active.id);
  }

  function moveTo(index: number): void {
    if (order.length === 0) return;
    const clamped = index < 0 ? 0 : index >= order.length ? order.length - 1 : index;
    const id = order[clamped];
    const region = id === undefined ? undefined : byId.get(id);
    if (region !== undefined) show(region, true);
  }

  /** Page Up/Down move between series — the `group` boundaries of SPEC 12.4. */
  function moveByGroup(direction: 1 | -1): void {
    const from = indexOfActive();
    const current = from < 0 ? undefined : byId.get(order[from] ?? '')?.group;
    for (let i = from + direction; i >= 0 && i < order.length; i += direction) {
      const candidate = byId.get(order[i] ?? '');
      if (candidate !== undefined && candidate.group !== current) {
        show(candidate, true);
        return;
      }
    }
    moveTo(direction > 0 ? order.length - 1 : 0);
  }

  const onKeyDown = (event: Event): void => {
    const e = event as KeyboardEvent;
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const at = indexOfActive();
    switch (e.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        moveTo(at + 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        moveTo(at < 0 ? 0 : at - 1);
        break;
      case 'Home':
        moveTo(0);
        break;
      case 'End':
        moveTo(order.length - 1);
        break;
      case 'PageDown':
        moveByGroup(1);
        break;
      case 'PageUp':
        moveByGroup(-1);
        break;
      case 'Escape':
        // Exits to the container, which keeps the tab stop (SPEC 12.4).
        hide();
        break;
      case 'Enter':
      case ' ':
        if (active !== undefined) handlers.onSelect?.(active.id);
        break;
      case 't':
      case 'T':
        handlers.onToggleTable?.();
        break;
      default:
        return;
    }
    e.preventDefault();
  };

  const onBlur = (): void => hide();

  svg.addEventListener('pointerover', onPointerOver);
  svg.addEventListener('mouseover', onPointerOver);
  svg.addEventListener('click', onClick);
  svg.addEventListener('keydown', onKeyDown);
  svg.addEventListener('blur', onBlur);
  host.addEventListener('pointerleave', onPointerLeave);
  host.addEventListener('mouseleave', onPointerLeave);

  return () => {
    svg.removeEventListener('pointerover', onPointerOver);
    svg.removeEventListener('mouseover', onPointerOver);
    svg.removeEventListener('click', onClick);
    svg.removeEventListener('keydown', onKeyDown);
    svg.removeEventListener('blur', onBlur);
    host.removeEventListener('pointerleave', onPointerLeave);
    host.removeEventListener('mouseleave', onPointerLeave);
    tooltip.remove();
    live.remove();
    crosshair.remove();
    focusRing.remove();
    svg.removeAttribute('aria-activedescendant');
    if (priorPosition.length === 0) container.style.removeProperty('position');
    else container.style.setProperty('position', priorPosition);
  };
}

/** `getBBox` throws in a detached tree and does not exist in jsdom. */
function safeBBox(element: Element | null): { x: number; y: number; w: number; h: number } | undefined {
  if (element === null) return undefined;
  const fn = (element as { getBBox?: () => { x: number; y: number; width: number; height: number } })
    .getBBox;
  if (typeof fn !== 'function') return undefined;
  try {
    const b = fn.call(element);
    if (!Number.isFinite(b.width) || b.width <= 0) return undefined;
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  } catch {
    return undefined;
  }
}

/**
 * Quote a value for a CSS attribute selector.
 *
 * `CSS.escape` is not in jsdom and not in Node, and the ids reaching here are
 * already restricted to `[A-Za-z][A-Za-z0-9_.:-]*` by `format.ts`. This rejects
 * anything else outright rather than attempting an escape, because a
 * half-escaped selector is a selector-injection bug.
 */
function CSS_escape(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_.:-]*$/.test(value) ? value : '';
}

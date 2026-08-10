/**
 * `useElementSize` — the resize half of SPEC 22.3.
 *
 * > **Resize:** a `ResizeObserver` per block, debounced to one animation frame,
 * > re-running stages 6–7 only. Width changes below 1 px are ignored.
 *
 * Three things make that true rather than aspirational:
 *
 * 1. **No measurement during render.** The first render — on the server and on
 *    the client — returns the *same* fallback size, so hydration cannot mismatch.
 *    The real size arrives in an effect (SPEC 22.3, "no work in render").
 * 2. **One frame of coalescing.** A window drag fires the observer on every
 *    frame and sometimes several times within one; the callback records and
 *    schedules, and at most one state update happens per animation frame.
 * 3. **A 1 px deadband.** Sub-pixel jitter from a flex container is what turns a
 *    resize handler into an infinite layout loop. A change under 1 px is not a
 *    change.
 *
 * Stages 1–5 are untouched by all of this: the size only ever reaches the scene
 * memo's key (`internal/pipeline.ts`), so a resize cannot reach the parser.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';

/** A measured content box, in CSS pixels. */
export interface ElementSize {
  width: number;
  height: number;
}

/** Options for {@link useElementSize}. */
export interface ElementSizeOptions {
  /** Size reported before the element has been measured. @defaultValue `{width: 0, height: 0}` */
  fallback?: ElementSize;
  /** Ignore changes smaller than this, in px. @defaultValue 1 */
  epsilon?: number;
}

const ZERO: ElementSize = Object.freeze({ width: 0, height: 0 });

/** Content-box size from an observer entry, with the pre-`contentBoxSize` fallback. */
function readEntry(entry: ResizeObserverEntry): ElementSize {
  const box = entry.contentBoxSize;
  if (box !== undefined && box.length > 0) {
    const first = box[0];
    if (first !== undefined) return { width: first.inlineSize, height: first.blockSize };
  }
  const rect = entry.contentRect;
  return { width: rect.width, height: rect.height };
}

/**
 * Observe an element's content-box size.
 *
 * @param ref - the element to measure. A `null` current is not an error; the
 * hook simply reports the fallback until the ref is attached.
 * @returns a stable object: identity changes only when the size does, so it can
 * be a dependency without re-triggering every render.
 */
export function useElementSize(
  ref: RefObject<Element | null>,
  options: ElementSizeOptions = {},
): ElementSize {
  const fallback = options.fallback ?? ZERO;
  const epsilon = options.epsilon ?? 1;

  const [size, setSize] = useState<ElementSize>(fallback);

  // The latest reading, and the frame we have already scheduled. Refs rather
  // than state: neither should cause a render on its own.
  const pending = useRef<ElementSize | undefined>(undefined);
  const frame = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (element === null || typeof ResizeObserver === 'undefined') return undefined;

    const flush = (): void => {
      frame.current = undefined;
      const next = pending.current;
      pending.current = undefined;
      if (next === undefined) return;
      setSize((previous) =>
        Math.abs(next.width - previous.width) < epsilon &&
        Math.abs(next.height - previous.height) < epsilon
          ? previous
          : next,
      );
    };

    const schedule = (): void => {
      if (frame.current !== undefined) return;
      frame.current =
        typeof requestAnimationFrame === 'function'
          ? requestAnimationFrame(flush)
          : (setTimeout(flush, 0) as unknown as number);
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry === undefined) return;
      pending.current = readEntry(entry);
      schedule();
    });
    observer.observe(element);

    // The observer fires once on observe in every implementation that ships,
    // but a detached-then-attached element in a test double may not, so take an
    // immediate reading too. Both paths go through the same deadband.
    const rect = element.getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      pending.current = { width: rect.width, height: rect.height };
      schedule();
    }

    return () => {
      observer.disconnect();
      if (frame.current !== undefined) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame.current);
        else clearTimeout(frame.current);
        frame.current = undefined;
      }
      pending.current = undefined;
    };
    // `ref` is a ref object and stable; `epsilon` is a number.
  }, [ref, epsilon]);

  return size;
}

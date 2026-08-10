/**
 * One resolved block, on screen: size, virtualisation, layout, error boundary.
 *
 * This is where the four SPEC 22.3 behaviours meet, and the order matters:
 *
 * 1. **Measure** — `useElementSize` on the container, never in render.
 * 2. **Virtualise** — `useVisible`; off screen and lazy ⇒ a correctly-sized
 *    placeholder and no layout at all.
 * 3. **Lay out** — `useMdvSceneResult`, memoised on the block's content hash, so
 *    (1) can fire sixty times a second without reaching the parser.
 * 4. **Contain** — an error boundary per block, so a plugin crash costs one
 *    block and not the document (SPEC 14.1 principle 1).
 */

import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { Diagnostic, ResolvedBlock } from '@mdv/core';
import { MdvChart } from './chart.js';
import { MdvErrorBoundary, MdvErrorCard } from './errorcard.js';
import { useMdvRuntime } from './context.js';
import { useElementSize } from './hooks/useElementSize.js';
import { useVisible } from './hooks/useVisible.js';
import { useMdvSceneResult } from './hooks/useMdvScene.js';
import { isPending } from './internal/compose.js';
import { resolveBlockSize } from './internal/size.js';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/** A box with nothing in it: the signal to `useMdvSceneResult` to skip layout. */
const NO_BOX = Object.freeze({ width: 0, height: 0 });

/**
 * `true` when an event came from inside the table view.
 *
 * Selection is about the *chart*. Opening the disclosure or clicking a cell is
 * reading the data, not picking the block, and firing `onSelect` for it would
 * scroll the reader away from the row they were looking at.
 */
function insideTableView(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  if (typeof closest !== 'function') return false;
  return closest.call(target, `.${CLS.tableView}`) != null;
}

/** Props for {@link MdvBlockView}. */
export interface MdvBlockViewProps {
  block: ResolvedBlock;
  /** Overrides `attrs.height`. */
  height?: number | undefined;
  /** The reader selected the block: a click anywhere in it, or <kbd>Enter</kbd>. */
  onSelectBlock?: ((blockId: string) => void) | undefined;
  /** The reader selected one mark. Carries the hit-region id (SPEC 22.1). */
  onSelectRegion?: ((regionId: string) => void) | undefined;
  /** Layout diagnostics for this block, reported once per distinct list. */
  onDiagnostics?: ((blockId: string, diagnostics: readonly Diagnostic[]) => void) | undefined;
  /** `'eager'` renders even off screen — printing (SPEC 22.3). */
  renderPolicy?: 'lazy' | 'eager' | undefined;
  /** Attach the hover/keyboard layer after mount. @defaultValue true */
  interactive?: boolean | undefined;
  /** Namespace for generated element ids; needed when a page holds two documents. */
  idPrefix?: string | undefined;
  className?: string | undefined;
}

/**
 * The below-the-fold placeholder.
 *
 * Correctly sized (SPEC 22.3) so the scrollbar does not jump when the real chart
 * mounts, and `aria-hidden` because it carries no information — an empty box
 * announcing "loading" on every scroll is worse than silence.
 *
 * The height is applied through the CSSOM in an effect rather than as a `style`
 * prop. React turns a `style` prop into a `style` *attribute* when it renders on
 * the server, and SPEC 13.5's `style-src 'self' 'nonce-…'` forbids exactly that;
 * `setProperty` is not subject to CSP.
 */
function Placeholder({
  height,
  blockId,
  label,
}: {
  height: number;
  blockId: string;
  /** Set for a block waiting on data (SPEC 6.4): the box announces itself. */
  label?: string | undefined;
}): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    element.style.setProperty('height', `${String(Math.max(0, Math.round(height)))}px`);
  }, [height]);

  return (
    <div
      ref={ref}
      className={CLS.placeholder}
      data-mdv-placeholder={blockId}
      data-mdv-height={String(Math.max(0, Math.round(height)))}
      // A virtualisation placeholder carries nothing and is hidden; a *data*
      // placeholder is the block, in its loading state, and must be announced.
      {...(label === undefined
        ? { 'aria-hidden': true as const }
        : { role: 'img', 'aria-label': label, 'aria-busy': true as const })}
    />
  );
}

/** Render one block: placeholder, chart, or error card. */
export function MdvBlockView(props: MdvBlockViewProps): ReactElement {
  const { block } = props;
  const runtime = useMdvRuntime();
  const containerRef = useRef<HTMLDivElement | null>(null);

  const policy = props.renderPolicy ?? runtime.renderPolicy;
  const measured = useElementSize(containerRef);
  const visible = useVisible(containerRef, { enabled: policy === 'lazy' });

  const box = resolveBlockSize({
    attrs: block.attrs,
    containerWidth: measured.width > 0 ? measured.width : undefined,
    fallbackWidth: runtime.fallbackWidth,
    heightOverride: props.height,
  });

  // Waiting on `src:` (SPEC 6.4). There is nothing to lay out — the table is
  // empty — so the block shows the placeholder for a non-ready dataset rather
  // than an empty chart.
  const pending = isPending(block);

  // Off screen and lazy: no layout, by construction — the hook short-circuits on
  // a zero box before it reaches `layoutBlock`.
  const laidOut = useMdvSceneResult(block, visible && !pending ? box : NO_BOX);

  // Diagnostics bubble from an effect, never from render: `onDiagnostics` is a
  // host callback and may well call `setState`.
  const reported = useRef<readonly Diagnostic[] | undefined>(undefined);
  const onDiagnostics = props.onDiagnostics;
  useEffect(() => {
    if (onDiagnostics === undefined) return;
    if (reported.current === laidOut.diagnostics) return;
    reported.current = laidOut.diagnostics;
    if (laidOut.diagnostics.length > 0) onDiagnostics(block.id, laidOut.diagnostics);
  }, [onDiagnostics, laidOut.diagnostics, block.id]);

  const onSelectBlock = props.onSelectBlock;
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (insideTableView(event.target)) return;
      onSelectBlock?.(block.id);
    },
    [onSelectBlock, block.id],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      // `Enter` on the block's container (SPEC 22.1). The chart's own keyboard
      // layer has already handled mark traversal and called `preventDefault`;
      // `preventDefault` does not stop propagation, so the event still arrives
      // here and selecting the block is the right document-level response.
      if (event.key !== 'Enter') return;
      if (insideTableView(event.target)) return;
      onSelectBlock?.(block.id);
    },
    [onSelectBlock, block.id],
  );

  const onError = useCallback(
    (diagnostic: Diagnostic) => onDiagnostics?.(block.id, [diagnostic]),
    [onDiagnostics, block.id],
  );

  let body: ReactNode;
  if (laidOut.error !== undefined) {
    // Layout could not run at all — host programmer error, not document
    // content. The card says so rather than pretending the block is empty.
    body = (
      <MdvErrorCard
        diagnostics={[
          {
            code: 'MDV5000',
            severity: 'error',
            message: `Layout failed: ${laidOut.error.message.split('\n')[0] ?? laidOut.error.name}`,
            range: block.range,
            source: 'render',
            blockId: block.id,
          },
        ]}
        raw={block.node.raw.header}
      />
    );
  } else if (pending) {
    const title = typeof block.attrs.title === 'string' ? block.attrs.title : block.blockType;
    body = <Placeholder height={box.height} blockId={block.id} label={`${title} — loading data`} />;
  } else if (laidOut.scene === undefined) {
    body = <Placeholder height={box.height} blockId={block.id} />;
  } else {
    body = (
      <MdvChart
        scene={laidOut.scene}
        interactive={props.interactive ?? true}
        {...(props.idPrefix !== undefined ? { idPrefix: `${props.idPrefix}-${block.id}` } : {})}
        {...(props.onSelectRegion !== undefined ? { onSelect: props.onSelectRegion } : {})}
      />
    );
  }

  return (
    <div
      ref={containerRef}
      className={props.className === undefined ? CLS.block : `${CLS.block} ${props.className}`}
      data-mdv-block-id={block.id}
      data-mdv-block-type={block.blockType}
      {...(onSelectBlock !== undefined ? { onClick, onKeyDown } : {})}
    >
      <MdvErrorBoundary
        blockId={block.id}
        raw={block.node.raw.header}
        {...(laidOut.scene !== undefined ? { table: laidOut.scene.a11y.table } : {})}
        {...(onDiagnostics !== undefined ? { onError } : {})}
      >
        {body}
      </MdvErrorBoundary>
    </div>
  );
}

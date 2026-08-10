/**
 * {@link MdvDocument} — a whole MDV document (SPEC 22.1).
 *
 * ```tsx
 * <MdvDocument
 *   source={markdown}
 *   onDiagnostics={setDiagnostics}
 *   onSelect={(blockId) => reveal(blockId)}
 *   components={{ h2: Heading, a: Link }}
 *   loading={<Skeleton />}
 * />
 * ```
 *
 * The document is the Markdown tree with the visual blocks substituted in place.
 * Everything that makes a block hard — measurement, virtualisation, layout,
 * failure containment — is `MdvBlockView`'s; this component's job is to resolve
 * once, walk the AST, and keep the two in step.
 *
 * **Server rendering works** (SPEC 22.3): with no `src:` in the document the
 * whole path is synchronous and pure — `parse`, `composeSync`, `layoutBlock` and
 * `toReactElements` — with the deterministic `TableMetrics` doing the measuring,
 * so `renderToString` produces the markup hydration will match.
 */

import { useCallback, useEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react';
import type { Diagnostic, MdvConfig, ResolvedBlock } from '@mdv/core';
import type { MdvBlock as MdvBlockNode } from '@mdv/parser';
import { useMdvRuntime } from './context.js';
import { useMdv, type MdvStatus, type UseMdvResult } from './hooks/useMdv.js';
import { MdvBlockView } from './blockview.js';
import { MdvErrorCard } from './errorcard.js';
import { renderMarkdown, type ComponentOverrides, type MdastNode } from './markdown.js';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/** Props for {@link MdvDocument}. */
export interface MdvDocumentProps {
  /** MDV source. Re-resolved on change, from the earliest dirty stage. */
  source: string;
  /** Overrides the provider's config for this document. */
  config?: MdvConfig;
  /** Called after every resolve with the full diagnostic list, in document order. */
  onDiagnostics?: (diagnostics: readonly Diagnostic[]) => void;
  /** Called when the reader selects a block (click, or Enter on its container). */
  onSelect?: (blockId: string) => void;
  /** Override the rendered Markdown elements. */
  components?: ComponentOverrides;
  /** Shown while the first resolve is in flight. */
  loading?: ReactNode;
  /** Applied to the `.mdv-root` container. */
  className?: string;
  /** The document's URI; a relative `src:` resolves against it (SPEC 6.4). */
  baseUri?: string;
  /** `'eager'` disables below-the-fold virtualisation, for printing (SPEC 22.3). */
  renderPolicy?: 'lazy' | 'eager';
  /** Attach the hover/keyboard layer after mount. @defaultValue true */
  interactive?: boolean;
  /**
   * Namespace for every generated element id in this document.
   *
   * Ids are `mdv-{blockIndex}-{counter}` (SPEC 24.3 rule 7), which is unique
   * within a document and *not* across two documents on one page. Give each one
   * its own prefix when a page holds more than one.
   */
  idPrefix?: string;
  /** Reported alongside the document; defaults to the front-matter `lang`. */
  lang?: string;
}

const NO_COMPONENTS: ComponentOverrides = Object.freeze({});
const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

/**
 * Merge layout diagnostics into the resolve diagnostics.
 *
 * Layout runs per block and per size, so its diagnostics arrive after the
 * resolve list and out of order; they are merged by source position, which is
 * the order SPEC 21 promises for `diagnostics`.
 */
function mergeDiagnostics(
  base: readonly Diagnostic[],
  perBlock: ReadonlyMap<string, readonly Diagnostic[]>,
): readonly Diagnostic[] {
  if (perBlock.size === 0) return base;
  const extra: Diagnostic[] = [];
  for (const list of perBlock.values()) extra.push(...list);
  if (extra.length === 0) return base;
  return [...base, ...extra].sort((a, b) => {
    const byOffset = a.range.start.offset - b.range.start.offset;
    if (byOffset !== 0) return byOffset;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
}

/**
 * Render a whole MDV document.
 *
 * Each block is its own error boundary, so a plugin crash cannot take out the
 * document (SPEC 14.1 principle 1).
 */
export function MdvDocument(props: MdvDocumentProps): ReactElement {
  const runtime = useMdvRuntime();
  const resolved: UseMdvResult = useMdv(props.source, props.config, {
    baseUri: props.baseUri,
  });
  const { doc, status } = resolved;

  // AST node → resolved block. Identity, not index: `visualBlocks` skips
  // `dataset` blocks, so the two orderings are not the same list.
  const byNode = useMemo(() => {
    const map = new Map<MdvBlockNode, ResolvedBlock>();
    for (const block of doc?.blocks ?? []) map.set(block.node, block);
    return map;
  }, [doc]);

  // Layout diagnostics, accumulated per block. A ref plus a version counter
  // rather than state per block: a scroll that mounts twenty blocks must not
  // cause twenty document re-renders.
  const layoutDiagnostics = useRef(new Map<string, readonly Diagnostic[]>());
  const onDiagnosticsProp = props.onDiagnostics;

  // A new document means a new set of block ids; keeping the old layout
  // diagnostics would report failures for blocks that no longer exist.
  //
  // Cleared during render, not in an effect: a child's effects run *before* its
  // parent's, so an effect here would wipe the diagnostics the newly mounted
  // blocks had just reported. Resetting a ref when a derived input changes is
  // idempotent, which is what `StrictMode`'s double render requires.
  const lastDoc = useRef(doc);
  if (lastDoc.current !== doc) {
    lastDoc.current = doc;
    layoutDiagnostics.current = new Map();
  }

  const publish = useCallback(() => {
    if (onDiagnosticsProp === undefined) return;
    onDiagnosticsProp(
      mergeDiagnostics(doc?.diagnostics ?? NO_DIAGNOSTICS, layoutDiagnostics.current),
    );
  }, [onDiagnosticsProp, doc]);

  const onBlockDiagnostics = useCallback(
    (blockId: string, diagnostics: readonly Diagnostic[]) => {
      const previous = layoutDiagnostics.current.get(blockId);
      if (previous === diagnostics) return;
      layoutDiagnostics.current.set(blockId, diagnostics);
      publish();
    },
    [publish],
  );

  useEffect(() => {
    if (onDiagnosticsProp === undefined || doc === undefined) return;
    onDiagnosticsProp(mergeDiagnostics(doc.diagnostics, layoutDiagnostics.current));
  }, [onDiagnosticsProp, doc]);

  const components = props.components ?? NO_COMPONENTS;
  const onSelect = props.onSelect;
  const renderPolicy = props.renderPolicy ?? runtime.renderPolicy;
  const interactive = props.interactive ?? true;
  const idPrefix = props.idPrefix;

  const renderBlock = useCallback(
    (node: MdastNode, key: string): ReactNode => {
      const block = byNode.get(node as unknown as MdvBlockNode);
      // A `dataset` block declares data and draws nothing (SPEC 6.3); it is
      // absent from `doc.blocks` on purpose, and rendering nothing is correct.
      if (block === undefined) return null;
      return (
        <MdvBlockView
          key={key}
          block={block}
          onSelectBlock={onSelect}
          onDiagnostics={onBlockDiagnostics}
          renderPolicy={renderPolicy}
          interactive={interactive}
          idPrefix={idPrefix}
        />
      );
    },
    [byNode, onSelect, onBlockDiagnostics, renderPolicy, interactive, idPrefix],
  );

  const renderError = useCallback((node: MdastNode, key: string): ReactNode => {
    // An `mdvError` node is a block the parser could not recover at all. It
    // still carries its diagnostic and its source, which is exactly the error
    // card's input (SPEC 14.1 principle 2).
    const diagnostic = node['diagnostic'];
    const raw = typeof node['raw'] === 'string' ? node['raw'] : undefined;
    return (
      <MdvErrorCard
        key={key}
        diagnostics={diagnostic === undefined ? [] : [diagnostic as Diagnostic]}
        {...(raw !== undefined ? { raw } : {})}
      />
    );
  }, []);

  const body = useMemo<ReactNode[]>(() => {
    if (doc === undefined) return [];
    return renderMarkdown(
      { components, renderBlock, renderError },
      doc.ast.children as unknown as readonly MdastNode[],
    );
  }, [doc, components, renderBlock, renderError]);

  const lang = props.lang ?? doc?.frontmatter?.lang;
  const className =
    props.className === undefined
      ? `mdv-root ${CLS.document}`
      : `mdv-root ${CLS.document} ${props.className}`;

  return (
    <div
      className={className}
      data-theme={runtime.colorScheme}
      data-mdv-status={status satisfies MdvStatus}
      {...(lang !== undefined ? { lang } : {})}
    >
      {doc === undefined ? (props.loading ?? null) : body}
    </div>
  );
}

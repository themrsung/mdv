/**
 * {@link MdvBlock} — one chart, without a surrounding document (SPEC 22.1).
 *
 * ```tsx
 * <MdvBlock
 *   type="line"
 *   attrs={{ x: 'date', y: 'value', title: 'Signups' }}
 *   data={rows}
 *   height={280}
 * />
 * ```
 *
 * The props are the block's *header*, in object form: the same attribute
 * cascade, the same channel split, the same `ResolvedBlock`, the same
 * `layoutBlock`. There is no second rendering path — a `<MdvBlock/>` and the
 * equivalent fenced block in a document produce byte-identical scenes, which is
 * the only way the two can be trusted to agree.
 *
 * It works with no provider: `useMdvRuntime` builds a private runtime with its
 * own memos, because a lone chart in someone else's app should need no ceremony
 * and must still not share mutable state with anything (SPEC 17.3 invariant 4).
 */

import { useMemo, type ReactElement } from 'react';
import type { AttrMap } from '@mdv/parser';
import type { Diagnostic, ResolvedBlock, Value } from '@mdv/core';
import { useMdvRuntime } from './context.js';
import { MdvBlockView } from './blockview.js';
import { BUILTIN_DEFAULTS, cascade, splitAttrs } from './internal/cascade.js';
import { SYNTHETIC_RANGE, syntheticNode, tableFromRows, type Row } from './internal/rows.js';

/** Props for {@link MdvBlock}. */
export interface MdvBlockProps {
  /** Block type, e.g. `'line'`. */
  type: string;
  /** Block attributes, exactly as they would appear in a header section. */
  attrs?: Readonly<Record<string, unknown>>;
  /**
   * Inline data as an array of row objects. Field order comes from the first
   * row's key order, which is why insertion order matters (SPEC 24.3 rule 5).
   */
  data?: readonly Readonly<Record<string, Value>>[];
  /** Fixed height in px. Width fills the container. */
  height?: number;
  className?: string;
  /** The reader selected a mark. Carries the hit-region id. */
  onSelect?: (regionId: string) => void;
  /** Every diagnostic this block produced, data and layout alike. */
  onDiagnostics?: (diagnostics: readonly Diagnostic[]) => void;
  /** Attach the hover/keyboard layer after mount. @defaultValue true */
  interactive?: boolean;
  /** The conformance level this block claims (SPEC 16.1). @defaultValue 1 */
  level?: 1 | 2 | 3;
}

const NO_ROWS: readonly Row[] = Object.freeze([]);
const NO_ATTRS: Readonly<Record<string, unknown>> = Object.freeze({});

/**
 * A readable header for the error card.
 *
 * A `<MdvBlock/>` has no source text, so if it fails there is nothing to show
 * the reader — unless we write down what it was asked to draw. This reconstructs
 * the header the props are equivalent to.
 */
function headerText(type: string, attrs: Readonly<Record<string, unknown>>): string {
  const lines = [`\`\`\`mdv ${type}`];
  for (const key of Object.keys(attrs)) {
    const value = attrs[key];
    lines.push(`${key}: ${typeof value === 'string' ? value : (JSON.stringify(value) ?? '')}`);
  }
  return lines.join('\n');
}

/** A single chart, without a surrounding document. */
export function MdvBlock(props: MdvBlockProps): ReactElement {
  const runtime = useMdvRuntime();
  const attrsProp = props.attrs ?? NO_ATTRS;
  const rows = (props.data ?? NO_ROWS) as readonly Row[];
  const level = props.level ?? 1;

  const block = useMemo<ResolvedBlock>(() => {
    const merged = cascade(
      BUILTIN_DEFAULTS,
      runtime.config.defaults as AttrMap,
      attrsProp as AttrMap,
    );
    const { attrs, encoding } = splitAttrs(merged);
    const prepared = tableFromRows(rows, attrs, runtime.config);
    const id = typeof attrs.id === 'string' && attrs.id !== '' ? attrs.id : 'mdv-0';

    return {
      id,
      index: 0,
      blockType: props.type,
      level,
      attrs,
      encoding,
      table: prepared.table,
      tableRef: { datasetId: '#block-0', key: `inline:${id}` },
      node: syntheticNode(props.type, headerText(props.type, attrsProp), level),
      range: SYNTHETIC_RANGE,
      theme: runtime.theme,
      diagnostics: prepared.diagnostics,
      failed: prepared.diagnostics.some((d) => d.severity === 'error'),
    };
  }, [props.type, attrsProp, rows, level, runtime.config, runtime.theme]);

  const onDiagnostics = props.onDiagnostics;
  const report = useMemo(
    () =>
      onDiagnostics === undefined
        ? undefined
        : (_blockId: string, diagnostics: readonly Diagnostic[]): void => {
            // Data diagnostics come from `useMemo` above and layout's arrive
            // here; the host wants one list, in source order — which for a
            // block with no source means "data first, then layout".
            onDiagnostics([...block.diagnostics, ...diagnostics]);
          },
    [onDiagnostics, block.diagnostics],
  );

  return (
    <div className="mdv-root" data-theme={runtime.colorScheme}>
      <MdvBlockView
        block={block}
        height={props.height}
        onSelectRegion={props.onSelect}
        onDiagnostics={report}
        interactive={props.interactive ?? true}
        // A standalone block is always its own viewport: virtualising it would
        // mean it never renders when the host mounts it inside a hidden tab.
        renderPolicy="eager"
        className={props.className}
      />
    </div>
  );
}

/**
 * The error card, and the per-block error boundary (SPEC 14).
 *
 * > 1. **A document always renders.** No single bad block may prevent the rest
 * >    of the document from rendering.
 * > 2. **Failures are visible, not silent.** A block that cannot render shows an
 * >    error card carrying the code, the message, and the raw data — never an
 * >    empty frame.
 *
 * There are two error cards in the system and they are for different failures:
 *
 * | Failure | Card |
 * |---|---|
 * | The block cannot be *drawn* — bad channel, missing field, dataset never loaded | `layoutBlock` returns a **scene** containing the SVG card, with the full table view attached. Nothing here is involved. |
 * | Something **threw** — a plugin component, a `components` override, a broken metrics provider | this file, as HTML |
 *
 * Keeping them separate matters: the scene card is part of the IR and therefore
 * appears identically in the PDF and in `mdv export --html`, while this one only
 * ever exists because React was mid-render when the floor gave way.
 *
 * Everything is inserted as text. There is no `dangerouslySetInnerHTML` in this
 * file, and the raw source shown is the *document's*, which is precisely the
 * most likely place for hostile input (SPEC 13.3).
 */

import { Component, type ErrorInfo, type ReactElement, type ReactNode } from 'react';
import type { A11yTable, Diagnostic } from '@mdv/core';
import { MdvTableView } from './tableview.js';
import { REACT_CLASS_NAMES as CLS } from './stylesheet.js';

/** How much of the raw source to show. Truncation is stated, never silent. */
const MAX_RAW_LINES = 12;

function clipRaw(raw: string): string {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length <= MAX_RAW_LINES) return lines.join('\n');
  return [
    ...lines.slice(0, MAX_RAW_LINES),
    `… ${String(lines.length - MAX_RAW_LINES)} more lines`,
  ].join('\n');
}

/** Props for {@link MdvErrorCard}. */
export interface MdvErrorCardProps {
  /** The diagnostics behind the failure, in source order. */
  diagnostics: readonly Diagnostic[];
  /** The block's raw source, so the reader can see what failed. */
  raw?: string;
  /** The block's data, so a failed block has still delivered its numbers. */
  table?: A11yTable;
  /** Accessible label for the card's region. @defaultValue 'Block failed to render' */
  label?: string;
  className?: string;
}

/**
 * An error card as HTML.
 *
 * `role="group"` with a label rather than `role="alert"`: a document with three
 * broken blocks would otherwise interrupt a screen-reader user three times
 * before they had read a word. The card is findable, not shouted.
 */
export function MdvErrorCard(props: MdvErrorCardProps): ReactElement {
  const { diagnostics } = props;
  const label = props.label ?? 'Block failed to render';
  const className =
    props.className === undefined ? CLS.errorCard : `${CLS.errorCard} ${props.className}`;

  return (
    <div className={className} role="group" aria-label={label}>
      {diagnostics.length === 0 ? (
        <div className={CLS.errorHead}>
          <span className={CLS.errorMessage}>{label}</span>
        </div>
      ) : (
        diagnostics.map((diagnostic, index) => (
          <div key={`${diagnostic.code}-${String(index)}`}>
            <div className={CLS.errorHead}>
              <span className={CLS.errorCode}>{diagnostic.code}</span>
              <span className={CLS.errorMessage}>{diagnostic.message}</span>
            </div>
            {diagnostic.detail === undefined ? null : (
              <p className={CLS.errorDetail}>{diagnostic.detail}</p>
            )}
          </div>
        ))
      )}
      {props.raw === undefined || props.raw.length === 0 ? null : (
        <pre className={CLS.errorSource}>
          <code>{clipRaw(props.raw)}</code>
        </pre>
      )}
      {props.table === undefined ? null : (
        // The data survives the failure: that is the difference between a
        // failure and a loss (SPEC 14.1 principle 2).
        <MdvTableView table={{ ...props.table, presentation: 'details' }} />
      )}
    </div>
  );
}

/** A diagnostic manufactured from a thrown exception (Appendix C `MDV5000`). */
export function diagnosticFromError(error: Error, blockId?: string): Diagnostic {
  const at = { offset: 0, line: 1, column: 1 };
  return {
    code: 'MDV5000',
    severity: 'error',
    message: `Rendering threw: ${error.message.split('\n')[0] ?? error.name}`,
    detail:
      'An exception escaped the render of this block. The rest of the document is unaffected ' +
      '(SPEC 14.1 principle 1). This is a bug in the chart type, the component override, or the host.',
    range: { start: at, end: at },
    source: 'render',
    ...(blockId !== undefined ? { blockId } : {}),
  };
}

/** Props for {@link MdvErrorBoundary}. */
export interface MdvErrorBoundaryProps {
  children: ReactNode;
  /** Identifies the failing block on the diagnostic. */
  blockId?: string;
  /** Raw source, shown on the card. */
  raw?: string;
  /** The block's data, shown on the card. */
  table?: A11yTable;
  /** Reported once, when the boundary catches. */
  onError?: (diagnostic: Diagnostic, error: Error) => void;
  /** Replaces the default card. */
  fallback?: (diagnostic: Diagnostic, error: Error) => ReactNode;
}

interface BoundaryState {
  error: Error | undefined;
}

/**
 * One error boundary per block (SPEC 22.3), so a plugin crash cannot take out
 * the document.
 *
 * **The one class component in this package.** SPEC 22.3 asks for function
 * components only *and* for a per-block error boundary; React provides no
 * function-component form of `getDerivedStateFromError`, and of the two
 * requirements the one that keeps a document rendering (SPEC 14.1 principle 1)
 * is the one that must win. Everything else in the package is a function.
 *
 * It is deliberately thin: state is one field, and the only lifecycle methods
 * are the two React requires.
 */
export class MdvErrorBoundary extends Component<MdvErrorBoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: undefined };

  static getDerivedStateFromError(error: unknown): BoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    void info;
    const real = error instanceof Error ? error : new Error(String(error));
    this.props.onError?.(diagnosticFromError(real, this.props.blockId), real);
  }

  override componentDidUpdate(previous: MdvErrorBoundaryProps): void {
    // New children mean a new attempt: an edit that fixes the block must clear
    // the card without remounting the whole document.
    if (this.state.error !== undefined && previous.children !== this.props.children) {
      this.setState({ error: undefined });
    }
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === undefined) return this.props.children;

    const diagnostic = diagnosticFromError(error, this.props.blockId);
    if (this.props.fallback !== undefined) return this.props.fallback(diagnostic, error);

    return (
      <MdvErrorCard
        diagnostics={[diagnostic]}
        {...(this.props.raw !== undefined ? { raw: this.props.raw } : {})}
        {...(this.props.table !== undefined ? { table: this.props.table } : {})}
      />
    );
  }
}

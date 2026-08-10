/**
 * Live preview of a visual block.
 *
 * The preview renders the **real** pipeline: the block's own `.mdv` source goes
 * to `@mdv/react`, which parses, resolves, lays out and paints it. Nothing here
 * reimplements a chart, and nothing here draws a stand-in that looks like one.
 * A picture the editor invented would be worse than no picture, because the
 * author would trust it.
 *
 * `@mdv/react` is loaded with a dynamic `import()`, which does two things at
 * once: the chart stack — core, charts, render-svg, themes — lands in its own
 * chunk instead of the editor's, and a binding that is not ready yet cannot
 * stop the editor from loading. When it throws, the boundary below says so in
 * plain words and the source editor beside it keeps working.
 *
 * At the time of writing `@mdv/react` is a stub whose components throw
 * `not implemented`, so that is the branch users will see. The moment the
 * package is real, this file needs no change.
 */

import { Component, lazy, Suspense, useCallback, useState } from 'react';
import type { ErrorInfo, ReactElement, ReactNode } from 'react';

/** Props the lazily-loaded renderer takes. */
interface PreviewProps {
  readonly source: string;
  readonly scheme: 'light' | 'dark';
}

/*
 * Once the binding has failed there is no point re-rendering it on every
 * keystroke: it will throw again, and each throw costs a React error log. The
 * flag is module-scope so every block in the document shares one verdict, and
 * "Try again" clears it.
 */
let bindingUnavailable: string | null = null;

const LazyPreview = lazy(async () => {
  const module = await import('@mdv/react');
  const { MdvProvider, MdvDocument } = module;
  return {
    default: function Preview({ source, scheme }: PreviewProps): ReactElement {
      return (
        <MdvProvider theme={scheme}>
          <MdvDocument source={source} />
        </MdvProvider>
      );
    },
  };
});

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onError: (message: string) => void;
  readonly resetKey: string;
}

interface BoundaryState {
  readonly failed: boolean;
}

class PreviewBoundary extends Component<BoundaryProps, BoundaryState> {
  public override state: BoundaryState = { failed: false };

  public static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  public override componentDidUpdate(previous: BoundaryProps): void {
    if (previous.resetKey !== this.props.resetKey && this.state.failed) {
      this.setState({ failed: false });
    }
  }

  public override componentDidCatch(error: unknown, info: ErrorInfo): void {
    void info;
    this.props.onError(error instanceof Error ? error.message : String(error));
  }

  public override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ChartPreviewProps {
  /** The block's `.mdv` source, fence and all. */
  readonly source: string;
  readonly scheme: 'light' | 'dark';
  readonly blockType: string;
}

/** The preview pane of the visual-block editor. */
export function ChartPreview({ source, scheme, blockType }: ChartPreviewProps): ReactElement {
  const [failure, setFailure] = useState<string | null>(bindingUnavailable);

  const onError = useCallback((message: string) => {
    bindingUnavailable = message;
    setFailure(message);
  }, []);

  const retry = useCallback(() => {
    bindingUnavailable = null;
    setFailure(null);
  }, []);

  if (failure !== null) {
    return (
      <div className="mdv-preview mdv-preview--unavailable" role="status">
        <p className="mdv-preview__title">No preview for this {blockType === '' ? 'block' : blockType} block</p>
        <p className="mdv-preview__body">
          The chart renderer (<code>@mdv/react</code>) could not draw it:{' '}
          <span className="mdv-preview__reason">{failure}</span>
        </p>
        <p className="mdv-preview__body">
          The block is still valid <code>.mdv</code> and is saved exactly as written — edit it with
          the form and the source box below. This editor will not fake a chart it cannot render.
        </p>
        <button type="button" className="mdv-btn" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }

  return (
    <div className="mdv-preview">
      <PreviewBoundary onError={onError} resetKey={source}>
        <Suspense fallback={<div className="mdv-preview__loading">Loading the chart renderer…</div>}>
          <LazyPreview source={source} scheme={scheme} />
        </Suspense>
      </PreviewBoundary>
    </div>
  );
}

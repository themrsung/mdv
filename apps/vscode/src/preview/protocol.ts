/**
 * The host ↔ webview message protocol (SPEC 29.3).
 *
 * "Updates arrive as incremental patches over `postMessage`": the host does not
 * re-send the document, it sends the blocks whose SVG actually changed. A
 * hundred-block document being edited in one chart posts one
 * {@link BlockPatch}, not a hundred.
 *
 * The protocol is deliberately data-only — strings, numbers and arrays. Nothing
 * crossing this boundary is executable, which is what lets the webview run under
 * `script-src 'nonce-…'` with no `eval` and no inline handlers (SPEC 13.5).
 */

/** One block as the webview needs it. */
export interface BlockPayload {
  readonly id: string;
  readonly index: number;
  readonly blockType: string;
  readonly title: string | undefined;
  /** 0-based line of the opening fence, for scroll sync. */
  readonly startLine: number;
  readonly endLine: number;
  /**
   * Serialised SVG produced by `@mdv/render-svg` in the extension host.
   *
   * Inserted with `innerHTML` on an element the webview owns. That is safe here
   * and only here: the string comes from our own deterministic serialiser, which
   * escapes every text node, emits no `<script>` and no event attributes, and is
   * unit-tested against hostile input in `packages/render-svg`. The CSP is the
   * second line of defence — even a serialiser bug that emitted a `<script>`
   * could not run it.
   */
  readonly svg: string;
  readonly failed: boolean;
  readonly family: string;
}

/** Messages the extension host sends to the webview. */
export type HostMessage =
  | {
      readonly kind: 'render';
      /** The full block list, in document order. Sent on open and on structure change. */
      readonly blocks: readonly BlockPayload[];
      /**
       * The document this preview is of, persisted by the webview through
       * `setState` so a deserialised panel knows what to re-render (SPEC 29.3).
       */
      readonly documentUri: string;
      readonly documentTitle: string;
      readonly errorCount: number;
      readonly warningCount: number;
      readonly blockedOrigins: readonly string[];
      readonly scrollSync: boolean;
    }
  | {
      readonly kind: 'patch';
      /** Only the blocks whose SVG changed. */
      readonly blocks: readonly BlockPayload[];
      readonly errorCount: number;
      readonly warningCount: number;
      readonly blockedOrigins: readonly string[];
    }
  | {
      readonly kind: 'settings';
      readonly scrollSync: boolean;
    }
  | {
      /** The editor scrolled; reveal the corresponding block. */
      readonly kind: 'revealLine';
      readonly line: number;
    }
  | {
      /** The cursor entered a block; highlight it briefly. */
      readonly kind: 'highlightBlock';
      readonly index: number;
    }
  | {
      readonly kind: 'status';
      readonly text: string;
    };

/** Messages the webview sends back to the extension host. */
export type WebviewMessage =
  | {
      /** Sent once the script has run; the host replies with the first render. */
      readonly kind: 'ready';
      readonly width: number;
    }
  | {
      /** The content width changed; the host re-runs layout only. */
      readonly kind: 'resize';
      readonly width: number;
    }
  | {
      /** The preview scrolled; reveal `line` in the editor. */
      readonly kind: 'scrolled';
      readonly line: number;
    }
  | {
      /** A chart was clicked; reveal its source (SPEC 29.3). */
      readonly kind: 'revealSource';
      readonly line: number;
    }
  | {
      /** The user pressed "Allow for this workspace" on the consent banner. */
      readonly kind: 'requestExternal';
    }
  | {
      /** Persisted across panel serialisation (SPEC 29.3). */
      readonly kind: 'state';
      readonly scrollTop: number;
    }
  | {
      readonly kind: 'error';
      readonly message: string;
    };

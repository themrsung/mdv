/**
 * `useMdv` — parse and resolve, memoised (SPEC 22.2).
 *
 * ```ts
 * const { doc, diagnostics, status } = useMdv(source, config);
 * ```
 *
 * Two paths, chosen by the document itself:
 *
 * - **No `src:` anywhere** ⇒ the synchronous path, computed during render out of
 *   the memo. There is nothing to wait for, so there is no flash of `loading`
 *   and no effect — which is also what makes server rendering work: the very
 *   same call produces the very same document with no DOM and no promise.
 * - **Something has a `src:`** ⇒ the asynchronous path, in an effect, with the
 *   in-flight resolve abandoned when the inputs change. Abandoned, not
 *   cancelled: `AbortSignal` belongs to the injected `fetch` capability, and a
 *   stale result is dropped on arrival rather than raced into state.
 *
 * `StrictMode`-clean: the effect is idempotent (a second run finds the memo warm
 * and resolves to the identical object) and the "is this result still wanted?"
 * flag is cleared by the cleanup.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Diagnostic, MdvConfig, ResolvedDocument } from '@mdv/core';
import type { ParseOptions } from '@mdv/parser';
import { useMdvRuntime } from '../context.js';
import { hashString } from '../internal/hash.js';
import { needsFetch } from '../internal/compose.js';
import { parseCached, resolveCached, resolveCachedSync } from '../internal/pipeline.js';

/** Lifecycle of {@link useMdv}. */
export type MdvStatus = 'idle' | 'parsing' | 'resolving' | 'ready' | 'error';

/** Result of {@link useMdv}. */
export interface UseMdvResult {
  /** `undefined` until the first resolve completes. */
  doc: ResolvedDocument | undefined;
  diagnostics: readonly Diagnostic[];
  status: MdvStatus;
}

/** Parse options derived from the configuration (SPEC 13.4, 16.1). */
function parseOptionsFrom(
  config: MdvConfig | undefined,
  baseUri: string | undefined,
): ParseOptions {
  const options: ParseOptions = {};
  if (config?.level !== undefined) options.level = config.level;
  if (config?.security?.allowHtml !== undefined) options.allowHtml = config.security.allowHtml;
  if (config?.security?.maxDocumentBytes !== undefined) {
    options.maxBytes = config.security.maxDocumentBytes;
  }
  if (baseUri !== undefined) options.from = baseUri;
  return options;
}

/** Options for {@link useMdv} beyond the configuration. */
export interface UseMdvOptions {
  /** The document's URI; a relative `src:` resolves against it (SPEC 6.4). */
  baseUri?: string | undefined;
}

/**
 * Parse and resolve `source`, re-running only the stages whose inputs changed.
 *
 * @param source - MDV source text
 * @param config - overrides the provider's configuration for this document
 */
export function useMdv(
  source: string,
  config?: MdvConfig,
  options: UseMdvOptions = {},
): UseMdvResult {
  const runtime = useMdvRuntime();
  const effectiveConfig = config ?? runtime.config;
  const baseUri = options.baseUri;

  const parseOptions = useMemo(
    () => parseOptionsFrom(effectiveConfig, baseUri),
    [effectiveConfig, baseUri],
  );

  // Stage 1. Cheap after the first call for a given source, and never re-run by
  // a resize: the size is not part of this key and never reaches this stage.
  const parsed = useMemo(
    () => parseCached(runtime.caches, source, parseOptions),
    [runtime.caches, source, parseOptions],
  );
  const sourceKey = useMemo(() => hashString(source), [source]);

  const asynchronous = useMemo(() => needsFetch(parsed), [parsed]);

  const composeOptions = useMemo(
    () => ({ config: effectiveConfig, prefersDark: runtime.prefersDark, baseUri }),
    [effectiveConfig, runtime.prefersDark, baseUri],
  );

  /**
   * The synchronous resolve, computed **always** — including for a document that
   * needs a fetch.
   *
   * That is what makes server rendering and hydration agree. The server cannot
   * await anything, and the client's first render is the hydration render, so
   * both have to produce the same thing: the document with everything local
   * already drawn and the external blocks as pending placeholders (SPEC 6.4,
   * 22.3). The fetched document then replaces it.
   *
   * Pure, memoised and total, so computing it in render costs nothing on a
   * re-render and has no side effects.
   */
  const immediate = useMemo(() => {
    try {
      return resolveCachedSync(
        runtime.caches,
        parsed,
        { ...composeOptions, externalPending: asynchronous },
        sourceKey,
      );
    } catch (cause) {
      // Only host programmer error reaches here (`MdvConfigError`). Document
      // problems are diagnostics by construction (SPEC 14.1 principle 4), so
      // rethrowing is right: the nearest error boundary shows the card.
      throw cause instanceof Error ? cause : new Error(String(cause));
    }
  }, [asynchronous, runtime.caches, parsed, composeOptions, sourceKey]);

  const [async_, setAsync] = useState<{ key: string; doc: ResolvedDocument } | undefined>(
    undefined,
  );
  const [failure, setFailure] = useState<{ key: string; error: Error } | undefined>(undefined);

  const asyncKey = useMemo(
    () => hashString(`${sourceKey}:${String(runtime.prefersDark)}:${baseUri ?? ''}`),
    [sourceKey, runtime.prefersDark, baseUri],
  );

  const caches = runtime.caches;
  const wanted = useRef(asyncKey);
  wanted.current = asyncKey;

  useEffect(() => {
    if (!asynchronous) return undefined;
    let live = true;
    void resolveCached(caches, parsed, composeOptions, sourceKey).then(
      (doc) => {
        if (live && wanted.current === asyncKey) setAsync({ key: asyncKey, doc });
      },
      (cause: unknown) => {
        if (!live || wanted.current !== asyncKey) return;
        setFailure({
          key: asyncKey,
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    );
    return () => {
      live = false;
    };
  }, [asynchronous, caches, parsed, composeOptions, sourceKey, asyncKey]);

  if (!asynchronous) {
    return { doc: immediate, diagnostics: immediate.diagnostics, status: 'ready' };
  }

  if (failure !== undefined && failure.key === asyncKey) {
    // The fetch failed outright — a capability the embedder promised and did not
    // provide. The synchronous document still renders, so the reader keeps
    // everything that did not depend on the network (SPEC 14.1 principle 1).
    return { doc: immediate, diagnostics: immediate.diagnostics, status: 'error' };
  }
  if (async_ !== undefined && async_.key === asyncKey) {
    return { doc: async_.doc, diagnostics: async_.doc.diagnostics, status: 'ready' };
  }
  // In flight: the pending blocks show their placeholders and everything else is
  // already drawn. Replacing a rendered document with a spinner on every
  // keystroke is worse than a partial frame, and `status` says which it is.
  return { doc: immediate, diagnostics: immediate.diagnostics, status: 'resolving' };
}

/**
 * The host capabilities the pipeline may be handed (SPEC 25.2, invariant 1).
 *
 * There is exactly one network implementation in the extension and it lives
 * here, because the preview and the PDF exporter must refuse the same requests.
 * Two copies of this function is how a document ends up unable to load a `src:`
 * on screen and quietly able to load it during an export.
 */

import type { Capabilities } from '@mdv/core';

/**
 * A network capability for the extension host.
 *
 * Only ever constructed when `mdv.security.allowExternal` is on **and** the
 * workspace is trusted; `@mdv/core` refuses a `src:` outright when the
 * capability is absent, which is the default (SPEC 25.2, `MDV4002`).
 *
 * `fetch` is used rather than `node:https` so the same code runs in the web
 * extension host, where there is no Node (SPEC 29.1).
 */
export function fetchCapability(): Capabilities['fetch'] | undefined {
  const globalFetch = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof globalFetch !== 'function') return undefined;
  return async (url, init) => {
    const controller = new AbortController();
    const timeout =
      init.timeoutMs !== undefined && init.timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, init.timeoutMs)
        : undefined;
    try {
      const response = await globalFetch(url, {
        method: 'GET',
        ...(init.headers !== undefined ? { headers: { ...init.headers } } : {}),
        redirect: 'follow',
        signal: controller.signal,
      });
      const buffer = await response.arrayBuffer();
      const contentType = response.headers.get('content-type');
      return {
        status: response.status,
        url: response.url === '' ? url : response.url,
        body: new Uint8Array(buffer),
        ...(contentType !== null ? { contentType } : {}),
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

/** The capability set for a run, from the resolved security settings. */
export function capabilitiesFor(allowExternal: boolean): Capabilities {
  const capabilities: Capabilities = {};
  if (allowExternal) {
    const fetcher = fetchCapability();
    if (fetcher !== undefined) capabilities.fetch = fetcher;
  }
  return capabilities;
}

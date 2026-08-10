/**
 * External data sources (SPEC 6.4) under the security model of SPEC 13.2/13.6.
 *
 * Core never touches the network itself (SPEC 17.3 invariant 1): every byte
 * arrives through {@link Capabilities.fetch} or {@link Capabilities.readFile}.
 * What lives here is the policy — enablement, allowlist, SSRF refusal, traversal
 * refusal, size and time caps, caching and integrity — expressed as diagnostics
 * so a blocked or failed source degrades to a placeholder with a stated reason
 * instead of an empty chart or a thrown error.
 */

import type { Capabilities } from '../types/config.js';
import type { DiagCollector } from './diag.js';
import { checkIntegrity } from './integrity.js';
import type { EffectiveLimits } from './limits.js';

/** The slice of `security` this module needs (SPEC 13.2). */
export interface FetchSecurity {
  allowExternal: boolean;
  allowedOrigins: readonly string[];
  allowFileUrls: boolean;
  fetchTimeoutMs: number;
}

/** A `src:` request as written on a block or dataset. */
export interface ExternalRequest {
  src: string;
  /** `integrity: "sha384-…"` (SPEC 6.4). */
  integrity?: string | undefined;
}

/** Everything {@link loadExternal} needs besides the request. */
export interface ExternalOptions {
  /**
   * The document's base URI. A relative `src:` resolves against it and MUST NOT
   * escape its directory. Absent ⇒ relative paths are passed to `readFile`
   * verbatim after a traversal check.
   */
  baseUri?: string | undefined;
  security: FetchSecurity;
  capabilities: Capabilities;
  limits: EffectiveLimits;
}

/** A successfully loaded source. */
export interface ExternalPayload {
  /** The decoded text, BOM already removed by the caller's reader. */
  text: string;
  /** The final URL or path, after redirects. */
  url: string;
  /** Selects the format unless `format:` overrides it (SPEC 6.4). */
  contentType?: string | undefined;
}

/** How a `src:` string was classified. */
type Target =
  | { kind: 'url'; url: string; origin: string; host: string; scheme: string }
  | { kind: 'file'; path: string; url: string; explicit: boolean };

/**
 * Load a `src:`.
 *
 * @returns the payload, or `undefined` when the source was refused or failed —
 * in which case at least one diagnostic has been emitted and the caller renders
 * a placeholder (SPEC 6.4).
 */
export async function loadExternal(
  request: ExternalRequest,
  options: ExternalOptions,
  diag: DiagCollector,
): Promise<ExternalPayload | undefined> {
  const { security } = options;

  if (!security.allowExternal) {
    diag.emit('MDV4002', {
      detail: `\`src: ${clip(request.src)}\` was not loaded. Set \`security.allowExternal\` and list the origin in \`security.allowedOrigins\`.`,
    });
    return undefined;
  }

  const target = classify(request.src, options.baseUri, diag);
  if (target === undefined) return undefined;

  if (target.kind === 'file') {
    return loadFile(target, request, options, diag);
  }

  if (!isAllowedOrigin(target.origin, security.allowedOrigins)) {
    diag.emit('MDV4003', {
      detail: `\`${target.origin}\` is not in \`security.allowedOrigins\`.`,
    });
    return undefined;
  }
  const blocked = blockedReason(target.host);
  if (blocked !== undefined) {
    diag.emit('MDV4022', { detail: `\`${target.host}\` is ${blocked}.` });
    return undefined;
  }

  const fetchCapability = options.capabilities.fetch;
  if (fetchCapability === undefined) {
    diag.emit('MDV4002', {
      message: 'External data is enabled but no `fetch` capability was provided',
      detail: 'Pass `capabilities.fetch` to load an absolute URL.',
    });
    return undefined;
  }

  const cached = await readCache(target.url, options, diag);
  if (cached !== undefined) {
    const verified = verify(cached, request, target.url, diag);
    return verified === undefined ? undefined : { text: verified, url: target.url };
  }

  let response;
  try {
    response = await fetchCapability(target.url, {
      method: 'GET',
      headers: {
        Accept:
          'text/csv, text/tab-separated-values, application/json, text/plain;q=0.8, */*;q=0.1',
      },
      timeoutMs: security.fetchTimeoutMs,
      maxRedirects: options.limits.maxRedirects,
    });
  } catch (error) {
    diag.emit('MDV4023', {
      detail: `${clip(target.url)}: ${error instanceof Error ? error.message : 'request failed'}.`,
    });
    return undefined;
  }

  if (response.status < 200 || response.status >= 300) {
    diag.emit('MDV4023', { detail: `${clip(target.url)} responded ${response.status}.` });
    return undefined;
  }

  // A redirect may have landed somewhere the allowlist never permitted; SPEC
  // 13.2 requires the check to be repeated on the final URL.
  const finalTarget = classify(response.url, options.baseUri, diag);
  if (finalTarget === undefined) return undefined;
  if (finalTarget.kind === 'url') {
    if (!isAllowedOrigin(finalTarget.origin, security.allowedOrigins)) {
      diag.emit('MDV4003', {
        detail: `The request was redirected to \`${finalTarget.origin}\`, which is not in \`security.allowedOrigins\`.`,
      });
      return undefined;
    }
    const afterRedirect = blockedReason(finalTarget.host);
    if (afterRedirect !== undefined) {
      diag.emit('MDV4022', {
        detail: `The request was redirected to \`${finalTarget.host}\`, which is ${afterRedirect}.`,
      });
      return undefined;
    }
  }

  if (response.body.length > options.limits.maxFetchBytes) {
    diag.emit('MDV4023', {
      message: 'Response exceeds the fetch size limit',
      detail: `${response.body.length} bytes from ${clip(target.url)}; the limit is ${options.limits.maxFetchBytes} (SPEC 13.6).`,
    });
    return undefined;
  }

  const text = verify(response.body, request, target.url, diag);
  if (text === undefined) return undefined;

  await writeCache(target.url, response.body, options);

  return {
    text,
    url: response.url,
    ...(response.contentType !== undefined ? { contentType: response.contentType } : {}),
  };
}

async function loadFile(
  target: Extract<Target, { kind: 'file' }>,
  request: ExternalRequest,
  options: ExternalOptions,
  diag: DiagCollector,
): Promise<ExternalPayload | undefined> {
  if (target.explicit && !options.security.allowFileUrls) {
    diag.emit('MDV4003', {
      message: 'Refused a `file:` URL',
      detail: '`file:` sources require `security.allowFileUrls`, which is for local CLI use only.',
    });
    return undefined;
  }

  const readFile = options.capabilities.readFile;
  if (readFile === undefined) {
    diag.emit('MDV4002', {
      message: 'External data is enabled but no `readFile` capability was provided',
      detail: 'Pass `capabilities.readFile` to load a relative path.',
    });
    return undefined;
  }

  let bytes: Uint8Array;
  try {
    bytes = await readFile(target.path);
  } catch (error) {
    diag.emit('MDV4023', {
      detail: `${clip(target.path)}: ${error instanceof Error ? error.message : 'read failed'}.`,
    });
    return undefined;
  }

  if (bytes.length > options.limits.maxFetchBytes) {
    diag.emit('MDV4023', {
      message: 'File exceeds the size limit',
      detail: `${bytes.length} bytes from ${clip(target.path)}; the limit is ${options.limits.maxFetchBytes} (SPEC 13.6).`,
    });
    return undefined;
  }

  const text = verify(bytes, request, target.path, diag);
  if (text === undefined) return undefined;
  return { text, url: target.url };
}

/** Run `integrity:` and decode. `undefined` means the data was discarded. */
function verify(
  bytes: Uint8Array,
  request: ExternalRequest,
  where: string,
  diag: DiagCollector,
): string | undefined {
  const attribute = request.integrity;
  if (attribute !== undefined && attribute.trim() !== '') {
    const result = checkIntegrity(attribute, bytes);
    if (!result.ok) {
      diag.emit('MDV4021', {
        detail:
          result.problem === 'unsupported-algorithm'
            ? `Only \`sha384\` is supported; \`${clip(attribute)}\` names none. The data from ${clip(where)} was discarded.`
            : result.problem === 'malformed'
              ? `\`${clip(attribute)}\` is not an \`algorithm-base64\` value. The data from ${clip(where)} was discarded.`
              : `Expected \`${clip(attribute)}\`, computed \`${result.actual}\`. The data from ${clip(where)} was discarded.`,
      });
      return undefined;
    }
  }
  return decodeUtf8(bytes);
}

// ─────────────────────────────────────────────────────────────────────────────
// Classification
// ─────────────────────────────────────────────────────────────────────────────

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/u;

function classify(
  src: string,
  baseUri: string | undefined,
  diag: DiagCollector,
): Target | undefined {
  const trimmed = src.trim();
  if (trimmed === '') {
    diag.emit('MDV4020', { message: '`src:` is empty' });
    return undefined;
  }

  if (SCHEME.test(trimmed)) {
    return classifyAbsolute(trimmed, diag);
  }

  // Relative. Traversal is refused before anything else looks at the path.
  if (escapesRoot(trimmed)) {
    diag.emit('MDV4020', {
      detail: `\`${clip(trimmed)}\` resolves above the document root.`,
    });
    return undefined;
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(trimmed)) {
    diag.emit('MDV4020', {
      detail: `\`${clip(trimmed)}\` is an absolute path; \`src:\` takes a relative path or an absolute URL.`,
    });
    return undefined;
  }

  if (baseUri === undefined) {
    return { kind: 'file', path: trimmed, url: trimmed, explicit: false };
  }

  let resolved: URL;
  try {
    resolved = new URL(trimmed, baseUri);
  } catch {
    diag.emit('MDV4020', { detail: `\`${clip(trimmed)}\` is not a valid relative reference.` });
    return undefined;
  }
  const root = rootOf(baseUri);
  if (root !== undefined && !resolved.href.startsWith(root)) {
    diag.emit('MDV4020', {
      detail: `\`${clip(trimmed)}\` resolves to \`${clip(resolved.href)}\`, outside \`${clip(root)}\`.`,
    });
    return undefined;
  }
  if (resolved.protocol === 'file:') {
    return {
      kind: 'file',
      path: decodeURIComponent(resolved.pathname),
      url: resolved.href,
      explicit: false,
    };
  }
  return classifyAbsolute(resolved.href, diag);
}

function classifyAbsolute(href: string, diag: DiagCollector): Target | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    diag.emit('MDV4020', { detail: `\`${clip(href)}\` is not a valid URL.` });
    return undefined;
  }
  const scheme = url.protocol.slice(0, -1).toLowerCase();
  if (scheme === 'file') {
    // `file:` is opt-in for local CLI use only; {@link loadFile} enforces it.
    return {
      kind: 'file',
      path: decodeURIComponent(url.pathname),
      url: url.href,
      explicit: true,
    };
  }
  if (scheme !== 'http' && scheme !== 'https') {
    diag.emit('MDV4003', {
      message: `Refused \`${scheme}:\` in \`src:\``,
      detail: 'Only `http:` and `https:` may be fetched, and `file:` only for local CLI use.',
    });
    return undefined;
  }
  return {
    kind: 'url',
    url: url.href,
    origin: url.origin,
    host: url.hostname.toLowerCase(),
    scheme,
  };
}

/** `true` when the relative reference climbs above its own starting point. */
function escapesRoot(reference: string): boolean {
  let depth = 0;
  for (const segment of reference.split(/[\\/]/u)) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      depth -= 1;
      if (depth < 0) return true;
      continue;
    }
    depth += 1;
  }
  return false;
}

/** The directory of the base URI — the confinement root for relative sources. */
function rootOf(baseUri: string): string | undefined {
  try {
    const url = new URL(baseUri);
    const path = url.pathname;
    const cut = path.lastIndexOf('/');
    url.pathname = cut === -1 ? '/' : path.slice(0, cut + 1);
    url.search = '';
    url.hash = '';
    return url.href;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

/** SPEC 13.2: an allowlist is required; `*` is an explicit, deliberate opt-in. */
export function isAllowedOrigin(origin: string, allowed: readonly string[]): boolean {
  if (allowed.length === 0) return false;
  const lower = origin.toLowerCase();
  for (const entry of allowed) {
    const candidate = entry.trim();
    if (candidate === '*') return true;
    if (candidate.toLowerCase() === lower) return true;
    // `https://example.com` in the list also covers its default port form.
    try {
      if (new URL(candidate).origin.toLowerCase() === lower) return true;
    } catch {
      /* not a URL; the literal comparison above was the only chance */
    }
  }
  return false;
}

/**
 * Why a hostname must be refused (SPEC 13.2 SSRF defence), or `undefined` when
 * it is acceptable. Name resolution happens in the host's `fetch` capability;
 * what core can do — and MUST do — is refuse the literal forms outright.
 */
export function blockedReason(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === '') return 'an empty host';
  if (host === 'localhost' || host.endsWith('.localhost')) return 'a loopback name';

  const v4 = parseIpv4(host);
  if (v4 !== undefined) return blockedIpv4(v4);

  if (host.includes(':')) return blockedIpv6(host);
  return undefined;
}

function parseIpv4(host: string): readonly number[] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const out: number[] = [];
  for (const part of parts) {
    if (part === '' || part.length > 3 || !/^[0-9]+$/u.test(part)) return undefined;
    const value = Number.parseInt(part, 10);
    if (value > 255) return undefined;
    out.push(value);
  }
  return out;
}

function blockedIpv4(octets: readonly number[]): string | undefined {
  const a = octets[0] as number;
  const b = octets[1] as number;
  if (a === 0) return 'an unspecified address';
  if (a === 127) return 'a loopback address';
  if (a === 10) return 'a private address';
  if (a === 172 && b >= 16 && b <= 31) return 'a private address';
  if (a === 192 && b === 168) return 'a private address';
  if (a === 169 && b === 254) {
    return octets[2] === 169 && octets[3] === 254
      ? 'the cloud metadata address'
      : 'a link-local address';
  }
  if (a === 100 && b >= 64 && b <= 127) return 'a carrier-grade NAT address';
  if (a >= 224) return 'a multicast or reserved address';
  return undefined;
}

function blockedIpv6(host: string): string | undefined {
  const compact = host.replace(/%.*$/u, '');
  if (compact === '::1') return 'a loopback address';
  if (compact === '::') return 'an unspecified address';
  const mapped = /^::ffff:(.+)$/u.exec(compact);
  if (mapped) {
    const inner = mapped[1] as string;
    const v4 = parseIpv4(inner);
    if (v4 !== undefined) return blockedIpv4(v4);
  }
  const head = compact.split(':')[0] ?? '';
  if (head.length === 0) return undefined;
  const group = Number.parseInt(head.padStart(4, '0'), 16);
  if (Number.isNaN(group)) return undefined;
  if ((group & 0xffc0) === 0xfe80) return 'a link-local address';
  if ((group & 0xfe00) === 0xfc00) return 'a unique-local address';
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

async function readCache(
  url: string,
  options: ExternalOptions,
  diag: DiagCollector,
): Promise<Uint8Array | undefined> {
  const cache = options.capabilities.cache;
  if (cache === undefined) return undefined;
  try {
    return await cache.get(url);
  } catch (error) {
    options.capabilities.logger?.warn('mdv: cache read failed', error);
    void diag;
    return undefined;
  }
}

async function writeCache(url: string, bytes: Uint8Array, options: ExternalOptions): Promise<void> {
  const cache = options.capabilities.cache;
  if (cache === undefined) return;
  try {
    await cache.set(url, bytes, options.limits.cacheTtlSeconds);
  } catch (error) {
    options.capabilities.logger?.warn('mdv: cache write failed', error);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Decoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * UTF-8 decode. Invalid sequences become U+FFFD rather than throwing: a
 * mis-encoded byte in row 900 must not cost the document its chart.
 */
export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function clip(text: string): string {
  return text.length <= 80 ? text : `${text.slice(0, 77)}…`;
}

/**
 * Deterministic serialisation primitives and output sanitisation
 * (SPEC 13.3, 23.1, 24.3).
 *
 * Everything that turns a number, a string or a URL into markup goes through
 * this module. That is the point: byte-stability and escaping are both
 * properties you only get by having exactly one code path, and both are silently
 * lost the moment a second one appears.
 */

/**
 * Round a number to `precision` decimals using **round-half-even** and render it
 * with trailing zeros stripped and `-0` normalised to `0` (SPEC 24.3 rule 4).
 *
 * Half-even rather than half-up because half-up is biased: a scene full of
 * `.5`s drifts upward, and two backends that disagree about the bias produce
 * different golden files for the same geometry.
 *
 * @throws TypeError for a non-finite input. A `NaN` coordinate is never document
 * content — it is an arithmetic bug upstream in layout, and emitting `"0"` for it
 * would produce a plausible-looking chart that is quietly wrong. SPEC 14.1's
 * "errors are data" applies to *document* errors; this is an engine invariant.
 */
export function formatNumber(value: number, precision: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `Non-finite coordinate ${String(value)} in scene; layout must not emit NaN or Infinity`,
    );
  }
  const p = precision < 0 ? 0 : precision > 12 ? 12 : Math.trunc(precision);
  const scale = 10 ** p;
  const scaled = value * scale;

  // Round half to even.
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let rounded: number;
  if (diff > 0.5) rounded = floor + 1;
  else if (diff < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;

  if (rounded === 0) return '0'; // normalises -0
  const out = (rounded / scale).toFixed(p);
  // toFixed can still hand back "-0.000" for a tiny negative.
  const trimmed = p === 0 ? out : out.replace(/\.?0+$/, '');
  return trimmed === '-0' || trimmed === '' ? '0' : trimmed;
}

/**
 * Escape text for an XML text node or an attribute value (SPEC 13.3).
 *
 * All five predefined entities, unconditionally: `& < > " '`. Escaping quotes in
 * text content and angle brackets in attributes is redundant for a
 * *correctly-quoted* serialiser, which is exactly why it is done — the escape
 * must not depend on the caller having picked the right context.
 *
 * Also strips the C0 control characters XML 1.0 forbids outright, since they
 * cannot be represented even as character references and would make the document
 * unparseable.
 */
export function escapeXml(value: string): string {
  let out = '';
  for (const ch of value) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&apos;';
        break;
      default: {
        const code = ch.codePointAt(0) ?? 0;
        // Legal XML 1.0 chars: #x9 | #xA | #xD | [#x20-#xD7FF] | …
        if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) break;
        out += ch;
      }
    }
  }
  return out;
}

/**
 * Generated ids are namespaced and derived from a per-render counter, never from
 * document content (SPEC 13.3, 24.3 rule 7). This guards the boundary: anything
 * that is not a safe NCName-ish token is rejected rather than escaped.
 *
 * Rejecting rather than escaping is deliberate. An id is a *reference target*;
 * a mangled-but-accepted id silently breaks `aria-labelledby` wiring, which is
 * worse than not emitting the attribute at all.
 */
const SAFE_ID = /^[A-Za-z][A-Za-z0-9_.:-]*$/;

/** `true` when `id` is safe to emit. */
export function isSafeId(id: string): boolean {
  return SAFE_ID.test(id);
}

/** A single CSS class token: letters, digits, `-` and `_`, starting with a letter. */
const SAFE_CLASS = /^[A-Za-z][A-Za-z0-9_-]*$/;

/**
 * Filter a space-separated class list down to safe tokens, preserving order and
 * dropping duplicates.
 *
 * SPEC 22.4 makes the `mdv-*` class names part of the public API, so they are
 * passed through; anything that could not be one of them is dropped rather than
 * escaped, on the same reasoning as ids.
 */
export function sanitiseClasses(cls: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of cls.split(/\s+/)) {
    if (token.length === 0 || !SAFE_CLASS.test(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out.join(' ');
}

/**
 * URL schemes an `href` may use (SPEC 13.3, 13.5).
 *
 * `javascript:`, `data:` (other than images), `vbscript:` and everything else are
 * stripped — `MDV4010`. `data:image/*` survives because SPEC 13.5's CSP is
 * `img-src 'self' data:`: an inline fallback asset is the intended use, and an
 * SVG referenced *as an image* is script-inert in every browser.
 */
const ALLOWED_SCHEME = /^(?:https?:|mailto:)/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|svg\+xml);/i;

/**
 * Return `href` when it is safe to emit, `undefined` when it must be stripped.
 *
 * Relative and same-document (`#…`) references are allowed; anything with a
 * scheme must be on the allowlist. The scheme test runs on a copy with
 * whitespace and control characters removed, because `java\nscript:` is the
 * oldest trick in the book and browsers still tolerate it.
 */
export function sanitiseUrl(href: string): string | undefined {
  // Strip whitespace and control characters only — never anything else.
  // Browsers drop tab/LF/CR before resolving a URL, so the scheme test has to
  // see the same string the browser will, or `java&#10;script:` walks through.
  // The control characters ARE the attack: `java\x00script:` and `java\nscript:` are
  // dropped by the browser before the scheme is resolved, so a sanitiser that cannot
  // name them cannot see them. Hence the rule is off for this line and no other.
  // eslint-disable-next-line no-control-regex
  const stripped = href.replace(/[\s\u0000-\u001f\u007f]+/g, '');
  if (stripped.length === 0) return undefined;
  if (stripped.startsWith('#')) return href.trim();
  if (DATA_IMAGE.test(stripped)) return href.trim();
  if (ALLOWED_SCHEME.test(stripped)) return href.trim();
  // No scheme at all ⇒ a relative reference, which cannot escalate.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(stripped)) return href.trim();
  return undefined;
}

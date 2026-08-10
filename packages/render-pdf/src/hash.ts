/**
 * A deterministic document identifier (SPEC 28.10).
 *
 * The PDF `/ID` must be *stable*, not secret: two exports of the same content
 * with the same `buildTime` have to produce the same bytes, and two different
 * documents should not collide in practice. That is a checksum's job, not a
 * cryptographic hash's, so this is a dependency-free FNV-1a — no `node:crypto`
 * (which would make the package Node-only) and no `Math.random`.
 *
 * Two independent 64-bit lanes with different offset bases are concatenated to
 * give the 16 bytes `/ID` wants.
 */

const OFFSET_A = 0xcbf29ce484222325n;
const OFFSET_B = 0x84222325cbf29ce4n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

function fnv1a(bytes: Uint8Array, offset: bigint): bigint {
  let hash = offset;
  for (const byte of bytes) {
    hash = ((hash ^ BigInt(byte)) * PRIME) & MASK;
  }
  return hash;
}

function hex64(value: bigint): string {
  return value.toString(16).padStart(16, '0').toUpperCase();
}

/** 32 uppercase hex characters — the 16 bytes of a PDF `/ID` entry. */
export function documentId(parts: readonly (string | Uint8Array)[]): string {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const part of parts) {
    // A length prefix keeps `['ab', 'c']` from hashing the same as `['a', 'bc']`.
    const bytes = typeof part === 'string' ? encoder.encode(part) : part;
    const prefix = encoder.encode(`${String(bytes.length)}:`);
    chunks.push(prefix, bytes);
    total += prefix.length + bytes.length;
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.length;
  }
  return `${hex64(fnv1a(joined, OFFSET_A))}${hex64(fnv1a(joined, OFFSET_B))}`;
}

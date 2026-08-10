/**
 * Content hashing for the stage-boundary memos (SPEC 24.2).
 *
 * > **Memoise by content hash** at every stage boundary; a 64-bit FNV-1a over
 * > the canonical stage input.
 *
 * Two properties matter and neither is negotiable:
 *
 * - **Determinism.** The same input hashes the same on every machine and in
 *   every process, so a cache key is a value and not a pointer (SPEC 24.3).
 * - **Order fidelity.** Object keys are hashed in *insertion* order, not sorted.
 *   Field order in MDV comes from the first row's key order and is load-bearing
 *   (SPEC 24.3 rule 5), so two attribute maps that differ only in key order are
 *   genuinely different inputs and must hash differently.
 *
 * The arithmetic is exact 64-bit FNV-1a done in two 32-bit halves rather than in
 * `BigInt`: a 1 MB document is hashed on every keystroke in the editor, and
 * `BigInt` multiplication in that loop is a visible cost.
 */

/** The FNV-1a 64 offset basis, split into two 32-bit halves. */
const OFFSET_HIGH = 0xcbf29ce4;
const OFFSET_LOW = 0x84222325;

/** The FNV-1a 64 prime `0x100000001b3`, likewise split. */
const PRIME_HIGH = 0x00000100;
const PRIME_LOW = 0x000001b3;

/** An in-progress 64-bit hash. Mutable by design: it is written per byte. */
interface Hash64 {
  high: number;
  low: number;
}

/** `h = (h ^ byte) * FNV_PRIME`, mod 2^64, in exact double arithmetic. */
function mixByte(h: Hash64, byte: number): void {
  h.low = (h.low ^ byte) >>> 0;

  // (high·2³² + low) · (PRIME_HIGH·2³² + PRIME_LOW) mod 2⁶⁴.
  // The high·high term is ≥ 2⁶⁴ and drops out entirely.
  const lowProduct = h.low * PRIME_LOW; // < 2⁴¹, exact in a double
  const carry = Math.floor(lowProduct / 0x100000000);
  const high = h.high * PRIME_LOW + h.low * PRIME_HIGH + carry; // < 2⁴²

  h.low = lowProduct >>> 0;
  h.high = high >>> 0;
}

/**
 * Feed a string in, two bytes per UTF-16 code unit, high byte first.
 *
 * Code units rather than UTF-8: the hash is an internal cache key, never a
 * published digest, and the mapping is injective over strings either way. Doing
 * it this way avoids an encoder allocation per call.
 */
function mixString(h: Hash64, value: string): void {
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    mixByte(h, (unit >>> 8) & 0xff);
    mixByte(h, unit & 0xff);
  }
}

/** Render a hash as 16 lowercase hex digits. */
function finish(h: Hash64): string {
  return h.high.toString(16).padStart(8, '0') + h.low.toString(16).padStart(8, '0');
}

/**
 * A separator byte, so `["ab","c"]` and `["a","bc"]` cannot collide.
 *
 * `0x1f` (unit separator) is not a legal character in an MDV attribute key and
 * would have to be escaped in any string that reached here as data.
 */
const SEP = 0x1f;

/**
 * Walk a value, feeding a **type-tagged** canonical form into the hash.
 *
 * Type tags matter: without them the number `1` and the string `"1"` hash the
 * same, and a block whose `height` changed from `"300"` to `300` would silently
 * reuse a stale scene.
 *
 * Cycles are not handled — nothing hashed here is cyclic (attribute maps, sizes,
 * theme names, tables), and a silent cycle guard would hide a real bug.
 */
function mixValue(h: Hash64, value: unknown): void {
  if (value === null) {
    mixByte(h, 0x00);
    return;
  }
  switch (typeof value) {
    case 'undefined':
      mixByte(h, 0x01);
      return;
    case 'boolean':
      mixByte(h, 0x02);
      mixByte(h, value ? 1 : 0);
      return;
    case 'number':
      mixByte(h, 0x03);
      // `Object.is` distinguishes -0 from 0; `String` does not, and a -0 that
      // silently equals 0 is exactly the class of bug SPEC 24.3 rule 4 exists
      // to prevent.
      mixString(h, Object.is(value, -0) ? '-0' : String(value));
      return;
    case 'bigint':
      mixByte(h, 0x04);
      mixString(h, value.toString());
      return;
    case 'string':
      mixByte(h, 0x05);
      mixString(h, value);
      return;
    case 'function':
      // A function cannot be hashed by value. Hashing its source would be both
      // slow and wrong (closures), so callers must not put one in a cache key;
      // this tag makes every function look identical, which is the safe answer
      // for the one place it happens (an `onDiagnostic` sink in a config).
      mixByte(h, 0x06);
      return;
    default:
      break;
  }

  if (value instanceof Date) {
    mixByte(h, 0x07);
    mixString(h, String(value.getTime()));
    return;
  }

  if (Array.isArray(value)) {
    mixByte(h, 0x08);
    for (const item of value) {
      mixValue(h, item);
      mixByte(h, SEP);
    }
    mixByte(h, 0x09);
    return;
  }

  mixByte(h, 0x0a);
  // Own enumerable keys in insertion order (SPEC 24.3 rule 5).
  for (const key of Object.keys(value as Record<string, unknown>)) {
    mixString(h, key);
    mixByte(h, SEP);
    mixValue(h, (value as Record<string, unknown>)[key]);
    mixByte(h, SEP);
  }
  mixByte(h, 0x0b);
}

/**
 * Hash one or more values into a 16-hex-digit key.
 *
 * @example
 * ```ts
 * const key = contentHash('layout', block.id, attrs, { width, height });
 * ```
 */
export function contentHash(...parts: readonly unknown[]): string {
  const h: Hash64 = { high: OFFSET_HIGH, low: OFFSET_LOW };
  for (const part of parts) {
    mixValue(h, part);
    mixByte(h, SEP);
  }
  return finish(h);
}

/** Hash a single string. Same algorithm, without the value walk. */
export function hashString(value: string): string {
  const h: Hash64 = { high: OFFSET_HIGH, low: OFFSET_LOW };
  mixString(h, value);
  return finish(h);
}

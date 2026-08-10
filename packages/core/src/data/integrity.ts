/**
 * Subresource integrity for `src:` (SPEC 6.4): `integrity: "sha384-…"`.
 *
 * SHA-384 is implemented here in plain TypeScript rather than delegating to
 * WebCrypto or `node:crypto`, because `@mdv/core` may not import host modules
 * (SPEC 17.3) and `crypto.subtle` is both asynchronous and absent in some
 * sandboxes. The implementation is the FIPS 180-4 SHA-512 compression function
 * with the SHA-384 initial vector, truncated to 384 bits, expressed as pairs of
 * 32-bit words so it does not depend on `BigInt` performance.
 */

/** Round constants: the first 64 bits of the fractional parts of the cube
 * roots of the first eighty primes, as interleaved `hi, lo` 32-bit words. */
const K_HEX: readonly string[] = [
  '428a2f98d728ae22',
  '7137449123ef65cd',
  'b5c0fbcfec4d3b2f',
  'e9b5dba58189dbbc',
  '3956c25bf348b538',
  '59f111f1b605d019',
  '923f82a4af194f9b',
  'ab1c5ed5da6d8118',
  'd807aa98a3030242',
  '12835b0145706fbe',
  '243185be4ee4b28c',
  '550c7dc3d5ffb4e2',
  '72be5d74f27b896f',
  '80deb1fe3b1696b1',
  '9bdc06a725c71235',
  'c19bf174cf692694',
  'e49b69c19ef14ad2',
  'efbe4786384f25e3',
  '0fc19dc68b8cd5b5',
  '240ca1cc77ac9c65',
  '2de92c6f592b0275',
  '4a7484aa6ea6e483',
  '5cb0a9dcbd41fbd4',
  '76f988da831153b5',
  '983e5152ee66dfab',
  'a831c66d2db43210',
  'b00327c898fb213f',
  'bf597fc7beef0ee4',
  'c6e00bf33da88fc2',
  'd5a79147930aa725',
  '06ca6351e003826f',
  '142929670a0e6e70',
  '27b70a8546d22ffc',
  '2e1b21385c26c926',
  '4d2c6dfc5ac42aed',
  '53380d139d95b3df',
  '650a73548baf63de',
  '766a0abb3c77b2a8',
  '81c2c92e47edaee6',
  '92722c851482353b',
  'a2bfe8a14cf10364',
  'a81a664bbc423001',
  'c24b8b70d0f89791',
  'c76c51a30654be30',
  'd192e819d6ef5218',
  'd69906245565a910',
  'f40e35855771202a',
  '106aa07032bbd1b8',
  '19a4c116b8d2d0c8',
  '1e376c085141ab53',
  '2748774cdf8eeb99',
  '34b0bcb5e19b48a8',
  '391c0cb3c5c95a63',
  '4ed8aa4ae3418acb',
  '5b9cca4f7763e373',
  '682e6ff3d6b2b8a3',
  '748f82ee5defb2fc',
  '78a5636f43172f60',
  '84c87814a1f0ab72',
  '8cc702081a6439ec',
  '90befffa23631e28',
  'a4506cebde82bde9',
  'bef9a3f7b2c67915',
  'c67178f2e372532b',
  'ca273eceea26619c',
  'd186b8c721c0c207',
  'eada7dd6cde0eb1e',
  'f57d4f7fee6ed178',
  '06f067aa72176fba',
  '0a637dc5a2c898a6',
  '113f9804bef90dae',
  '1b710b35131c471b',
  '28db77f523047d84',
  '32caab7b40c72493',
  '3c9ebe0a15c9bebc',
  '431d67c49c100d4c',
  '4cc5d4becb3e42b6',
  '597f299cfc657e2a',
  '5fcb6fab3ad6faec',
  '6c44198c4a475817',
];

/** SHA-384 initial vector: the square roots of the ninth to sixteenth primes. */
const IV_HEX: readonly string[] = [
  'cbbb9d5dc1059ed8',
  '629a292a367cd507',
  '9159015a3070dd17',
  '152fecd8f70e5939',
  '67332667ffc00b31',
  '8eb44a8768581511',
  'db0c2e0d64f98fa7',
  '47b5481dbefa4fa4',
];

function words(hex: readonly string[]): Int32Array {
  const out = new Int32Array(hex.length * 2);
  for (let i = 0; i < hex.length; i += 1) {
    const value = hex[i] as string;
    out[i * 2] = Number.parseInt(value.slice(0, 8), 16) | 0;
    out[i * 2 + 1] = Number.parseInt(value.slice(8, 16), 16) | 0;
  }
  return out;
}

const K = words(K_HEX);
const IV = words(IV_HEX);

/**
 * SHA-384 of `input`.
 *
 * @returns 48 bytes, big-endian, exactly as FIPS 180-4 defines them.
 */
export function sha384(input: Uint8Array): Uint8Array {
  const h = Int32Array.from(IV);
  const w = new Int32Array(160);

  // Padding: 0x80, zeroes, then a 128-bit big-endian bit length. The high 64
  // bits are always zero here because a JS byte array cannot reach 2^61 bytes.
  const bitLength = input.length * 8;
  const padded = new Uint8Array(((input.length + 17 + 127) >> 7) << 7);
  padded.set(input);
  padded[input.length] = 0x80;
  const tail = padded.length;
  // Bit length occupies the last 16 bytes; only the low 8 can be non-zero.
  writeUint32(padded, tail - 8, Math.floor(bitLength / 0x100000000));
  writeUint32(padded, tail - 4, bitLength >>> 0);

  for (let offset = 0; offset < padded.length; offset += 128) {
    compress(h, w, padded, offset);
  }

  const out = new Uint8Array(48);
  for (let i = 0; i < 12; i += 1) writeUint32(out, i * 4, (h[i] as number) >>> 0);
  return out;
}

function writeUint32(target: Uint8Array, at: number, value: number): void {
  target[at] = (value >>> 24) & 0xff;
  target[at + 1] = (value >>> 16) & 0xff;
  target[at + 2] = (value >>> 8) & 0xff;
  target[at + 3] = value & 0xff;
}

function compress(h: Int32Array, w: Int32Array, block: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i += 1) {
    const p = at + i * 8;
    w[i * 2] =
      ((block[p] as number) << 24) |
      ((block[p + 1] as number) << 16) |
      ((block[p + 2] as number) << 8) |
      (block[p + 3] as number) |
      0;
    w[i * 2 + 1] =
      ((block[p + 4] as number) << 24) |
      ((block[p + 5] as number) << 16) |
      ((block[p + 6] as number) << 8) |
      (block[p + 7] as number) |
      0;
  }

  for (let i = 16; i < 80; i += 1) {
    const x2h = w[(i - 15) * 2] as number;
    const x2l = w[(i - 15) * 2 + 1] as number;
    // σ0 = ROTR^1 ^ ROTR^8 ^ SHR^7
    const s0h = ((x2h >>> 1) | (x2l << 31)) ^ ((x2h >>> 8) | (x2l << 24)) ^ (x2h >>> 7);
    const s0l =
      ((x2l >>> 1) | (x2h << 31)) ^ ((x2l >>> 8) | (x2h << 24)) ^ ((x2l >>> 7) | (x2h << 25));

    const x1h = w[(i - 2) * 2] as number;
    const x1l = w[(i - 2) * 2 + 1] as number;
    // σ1 = ROTR^19 ^ ROTR^61 ^ SHR^6
    const s1h = ((x1h >>> 19) | (x1l << 13)) ^ ((x1l >>> 29) | (x1h << 3)) ^ (x1h >>> 6);
    const s1l =
      ((x1l >>> 19) | (x1h << 13)) ^ ((x1h >>> 29) | (x1l << 3)) ^ ((x1l >>> 6) | (x1h << 26));

    const w7h = w[(i - 7) * 2] as number;
    const w7l = w[(i - 7) * 2 + 1] as number;
    const w16h = w[(i - 16) * 2] as number;
    const w16l = w[(i - 16) * 2 + 1] as number;

    let lo = (s0l >>> 0) + (w7l >>> 0);
    let hi = (s0h >>> 0) + (w7h >>> 0) + (lo > 0xffffffff ? 1 : 0);
    lo = (lo >>> 0) + (s1l >>> 0);
    hi = (hi >>> 0) + (s1h >>> 0) + (lo > 0xffffffff ? 1 : 0);
    lo = (lo >>> 0) + (w16l >>> 0);
    hi = (hi >>> 0) + (w16h >>> 0) + (lo > 0xffffffff ? 1 : 0);

    w[i * 2] = hi | 0;
    w[i * 2 + 1] = lo | 0;
  }

  let ah = h[0] as number;
  let al = h[1] as number;
  let bh = h[2] as number;
  let bl = h[3] as number;
  let ch = h[4] as number;
  let cl = h[5] as number;
  let dh = h[6] as number;
  let dl = h[7] as number;
  let eh = h[8] as number;
  let el = h[9] as number;
  let fh = h[10] as number;
  let fl = h[11] as number;
  let gh = h[12] as number;
  let gl = h[13] as number;
  let hh = h[14] as number;
  let hl = h[15] as number;

  for (let i = 0; i < 80; i += 1) {
    // Σ1 = ROTR^14 ^ ROTR^18 ^ ROTR^41
    const S1h = ((eh >>> 14) | (el << 18)) ^ ((eh >>> 18) | (el << 14)) ^ ((el >>> 9) | (eh << 23));
    const S1l = ((el >>> 14) | (eh << 18)) ^ ((el >>> 18) | (eh << 14)) ^ ((eh >>> 9) | (el << 23));
    const chh = (eh & fh) ^ (~eh & gh);
    const chl = (el & fl) ^ (~el & gl);

    let t1l = (hl >>> 0) + (S1l >>> 0);
    let t1h = (hh >>> 0) + (S1h >>> 0) + (t1l > 0xffffffff ? 1 : 0);
    t1l = (t1l >>> 0) + (chl >>> 0);
    t1h = (t1h >>> 0) + (chh >>> 0) + (t1l > 0xffffffff ? 1 : 0);
    t1l = (t1l >>> 0) + ((K[i * 2 + 1] as number) >>> 0);
    t1h = (t1h >>> 0) + ((K[i * 2] as number) >>> 0) + (t1l > 0xffffffff ? 1 : 0);
    t1l = (t1l >>> 0) + ((w[i * 2 + 1] as number) >>> 0);
    t1h = (t1h >>> 0) + ((w[i * 2] as number) >>> 0) + (t1l > 0xffffffff ? 1 : 0);
    t1h = t1h >>> 0;
    t1l = t1l >>> 0;

    // Σ0 = ROTR^28 ^ ROTR^34 ^ ROTR^39
    const S0h = ((ah >>> 28) | (al << 4)) ^ ((al >>> 2) | (ah << 30)) ^ ((al >>> 7) | (ah << 25));
    const S0l = ((al >>> 28) | (ah << 4)) ^ ((ah >>> 2) | (al << 30)) ^ ((ah >>> 7) | (al << 25));
    const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
    const majl = (al & bl) ^ (al & cl) ^ (bl & cl);

    let t2l = (S0l >>> 0) + (majl >>> 0);
    let t2h = (S0h >>> 0) + (majh >>> 0) + (t2l > 0xffffffff ? 1 : 0);
    t2h = t2h >>> 0;
    t2l = t2l >>> 0;

    hh = gh;
    hl = gl;
    gh = fh;
    gl = fl;
    fh = eh;
    fl = el;

    let lo = (dl >>> 0) + t1l;
    let hi = ((dh >>> 0) + t1h + (lo > 0xffffffff ? 1 : 0)) >>> 0;
    eh = hi | 0;
    el = lo | 0;

    dh = ch;
    dl = cl;
    ch = bh;
    cl = bl;
    bh = ah;
    bl = al;

    lo = t1l + t2l;
    hi = (t1h + t2h + (lo > 0xffffffff ? 1 : 0)) >>> 0;
    ah = hi | 0;
    al = lo | 0;
  }

  addInto(h, 0, ah, al);
  addInto(h, 2, bh, bl);
  addInto(h, 4, ch, cl);
  addInto(h, 6, dh, dl);
  addInto(h, 8, eh, el);
  addInto(h, 10, fh, fl);
  addInto(h, 12, gh, gl);
  addInto(h, 14, hh, hl);
}

function addInto(h: Int32Array, at: number, hi: number, lo: number): void {
  const l = ((h[at + 1] as number) >>> 0) + (lo >>> 0);
  const x = ((h[at] as number) >>> 0) + (hi >>> 0) + (l > 0xffffffff ? 1 : 0);
  h[at] = x | 0;
  h[at + 1] = l | 0;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64, hand-rolled: `btoa` is a browser global and core is portable. */
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] as number;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2] as string;
    out += B64[((a & 0x03) << 4) | ((b ?? 0) >> 4)] as string;
    out += b === undefined ? '=' : (B64[(((b & 0x0f) << 2) | ((c ?? 0) >> 6)) as number] as string);
    out += c === undefined ? '=' : (B64[c & 0x3f] as string);
  }
  return out;
}

/** The outcome of an `integrity:` check. */
export interface IntegrityResult {
  ok: boolean;
  /** The digest that was computed, in SRI form, for the diagnostic detail. */
  actual: string;
  /** Set when the attribute itself could not be understood. */
  problem?: 'malformed' | 'unsupported-algorithm';
}

/**
 * Verify an SRI attribute against a payload.
 *
 * A space-separated list matches if **any** entry matches, as the SRI
 * specification requires. Only `sha384` is supported, which is the algorithm
 * SPEC 6.4 names; anything else is reported rather than silently accepted.
 */
export function checkIntegrity(attribute: string, bytes: Uint8Array): IntegrityResult {
  const digest = sha384(bytes);
  const actual = `sha384-${toBase64(digest)}`;
  const entries = attribute
    .trim()
    .split(/\s+/u)
    .filter((t) => t !== '');
  if (entries.length === 0) return { ok: false, actual, problem: 'malformed' };

  let sawSupported = false;
  for (const entry of entries) {
    const dash = entry.indexOf('-');
    if (dash <= 0) return { ok: false, actual, problem: 'malformed' };
    const algorithm = entry.slice(0, dash);
    if (algorithm !== 'sha384') continue;
    sawSupported = true;
    // Options after `?` are metadata and are not part of the digest.
    const question = entry.indexOf('?', dash);
    const encoded = question === -1 ? entry.slice(dash + 1) : entry.slice(dash + 1, question);
    if (encoded === toBase64(digest)) return { ok: true, actual };
  }
  return sawSupported
    ? { ok: false, actual }
    : { ok: false, actual, problem: 'unsupported-algorithm' };
}

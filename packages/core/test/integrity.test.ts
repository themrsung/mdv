import { describe, expect, it } from 'vitest';
import { checkIntegrity, sha384, toBase64 } from '../src/data/integrity.js';

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sha384', () => {
  it('matches the FIPS 180-4 empty-string vector', () => {
    expect(hex(sha384(new Uint8Array(0)))).toBe(
      '38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b',
    );
  });

  it('matches the "abc" vector', () => {
    expect(hex(sha384(utf8('abc')))).toBe(
      'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
    );
  });

  it('matches the two-block vector', () => {
    expect(
      hex(
        sha384(
          utf8(
            'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
          ),
        ),
      ),
    ).toBe(
      '09330c33f71147e83d192fc782cd1b4753111b173b3b05d22fa08086e3b0f712fcc7c71a557e2db966c3e9fa91746039',
    );
  });

  it('spans several blocks deterministically', () => {
    const long = utf8('x'.repeat(1000));
    expect(hex(sha384(long))).toBe(hex(sha384(long)));
    expect(hex(sha384(long))).toHaveLength(96);
  });
});

describe('checkIntegrity', () => {
  const payload = utf8('a,b\n1,2\n');
  const good = `sha384-${toBase64(sha384(payload))}`;

  it('accepts a matching digest', () => {
    expect(checkIntegrity(good, payload).ok).toBe(true);
  });

  it('rejects a mismatch and reports what it computed', () => {
    const result = checkIntegrity('sha384-AAAA', payload);
    expect(result.ok).toBe(false);
    expect(result.actual).toBe(good);
    expect(result.problem).toBeUndefined();
  });

  it('accepts a list when any entry matches', () => {
    expect(checkIntegrity(`sha384-AAAA ${good}`, payload).ok).toBe(true);
  });

  it('ignores SRI options after `?`', () => {
    expect(checkIntegrity(`${good}?foo=bar`, payload).ok).toBe(true);
  });

  it('reports an unsupported algorithm rather than passing it', () => {
    const result = checkIntegrity('sha256-AAAA', payload);
    expect(result.ok).toBe(false);
    expect(result.problem).toBe('unsupported-algorithm');
  });

  it('reports a malformed attribute', () => {
    expect(checkIntegrity('nonsense', payload).problem).toBe('malformed');
    expect(checkIntegrity('   ', payload).problem).toBe('malformed');
  });
});

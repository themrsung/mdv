/**
 * The MDVX locator (SPEC 6.7, 6.8).
 *
 * `‸` marks the cursor in these cases and is stripped before the call, so each
 * expression reads the way it looks in an editor mid-keystroke. Half-written
 * input is the point of the module, so most of these do not parse.
 */

import { isMdvBlock, parse, type MdvBlock } from '@mdv/parser';
import { STEP_SIGNATURES } from '@mdv/spec';
import { describe, expect, it } from 'vitest';
import { callAt, expressionAt, type CallSite } from '../src/expr/locate.js';

/** Locate the call at `‸`, which is removed before scanning. */
function at(marked: string): CallSite | undefined {
  const cursor = marked.indexOf('‸');
  return callAt(marked.replace('‸', ''), cursor);
}

describe('callAt (SPEC 6.8)', () => {
  it('names the call the cursor has just opened', () => {
    expect(at('sum(‸')).toEqual({ name: 'sum', offset: 0, argument: 0 });
  });

  it('counts the commas passed inside the call', () => {
    expect(at('substr(name, 1, ‸')).toMatchObject({ name: 'substr', argument: 2 });
    expect(at('substr(name,‸ 1, 2)')).toMatchObject({ name: 'substr', argument: 1 });
  });

  it('answers with the innermost call', () => {
    expect(at('round(sum(a, b‸), 2)')).toMatchObject({ name: 'sum', argument: 1 });
    expect(at('round(sum(a, b), ‸2)')).toMatchObject({ name: 'round', argument: 1 });
  });

  it('reports where the callee is written', () => {
    expect(at('1 + round(x‸)')).toEqual({ name: 'round', offset: 4, argument: 0 });
  });

  it('is silent outside a call', () => {
    expect(at('revenue > ‸1')).toBeUndefined();
    expect(at('sum(a) + ‸1')).toBeUndefined();
    expect(at('sum(a)‸')).toBeUndefined();
    expect(at('‸sum(a)')).toBeUndefined();
  });

  it('does not mistake a group for a call', () => {
    expect(at('(a + b‸)')).toBeUndefined();
    // The cursor is in the group, but the group is inside a call.
    expect(at('max((a + b‸), c)')).toMatchObject({ name: 'max', argument: 0 });
  });

  it('gives a list literal its own commas', () => {
    expect(at('min([1, 2‸])')).toMatchObject({ name: 'min', argument: 0 });
    expect(at('min([1, 2], 3‸)')).toMatchObject({ name: 'min', argument: 1 });
  });

  it('reads a bracketed field name as one argument', () => {
    expect(at('sum([Net revenue]‸)')).toMatchObject({ name: 'sum', argument: 0 });
  });

  it('does not read a word operator as a callee', () => {
    expect(at('name in (a‸)')).toBeUndefined();
    expect(at('contains(name, x‸)')).toMatchObject({ name: 'contains', argument: 1 });
  });

  it('survives the half-typed string that triggers it', () => {
    expect(at("contains(name, 'op‸")).toMatchObject({ name: 'contains', argument: 1 });
    expect(at('coalesce(a, "x", ‸')).toMatchObject({ name: 'coalesce', argument: 2 });
  });

  it('survives a character it cannot scan', () => {
    expect(at('sum(a @ ‸')).toMatchObject({ name: 'sum', argument: 0 });
  });

  it('looks up no whitelist of its own', () => {
    // `MDV2220` is the evaluator's answer to this, and it is not this module's
    // business: a tool wants to know what the author typed.
    expect(at('bogus(a, ‸')).toMatchObject({ name: 'bogus', argument: 1 });
  });

  it('clamps an offset outside the source', () => {
    expect(callAt('sum(a, b', 500)).toMatchObject({ name: 'sum', argument: 1 });
    expect(callAt('sum(a, b', -3)).toBeUndefined();
    expect(callAt('', 0)).toBeUndefined();
  });

  it('reads a call inside a ternary arm', () => {
    expect(at('x > 1 ? sum(a‸) : 0')).toMatchObject({ name: 'sum', argument: 0 });
  });
});

const SOURCE = [
  '```mdv line',
  'x: quarter',
  'transform:',
  '  - filter: revenue > 0',
  '  - derive:',
  '      margin: profit / revenue',
  '  - sort: revenue',
  '---',
  'quarter | revenue | profit',
  'Q1 | 2 | 1',
  '```',
].join('\n');

/** The one block of {@link SOURCE}, as the parser read it. */
function block(): MdvBlock {
  const found = parse(SOURCE).children.find(isMdvBlock);
  if (found === undefined) throw new Error('the fixture parses to one block');
  return found;
}

describe('expressionAt (SPEC 6.7)', () => {
  it('reads the source of a filter and of a derived field', () => {
    const attrs = block().attrs;
    expect(expressionAt(attrs, 'transform[0].filter')).toBe('revenue > 0');
    expect(expressionAt(attrs, 'transform[1].derive.margin')).toBe('profit / revenue');
  });

  it('holds nothing for a path that is not an expression', () => {
    const attrs = block().attrs;
    expect(expressionAt(attrs, 'transform[2].sort')).toBeUndefined();
    expect(expressionAt(attrs, 'transform[1].derive')).toBeUndefined();
    expect(expressionAt(attrs, 'transform')).toBeUndefined();
    expect(expressionAt(attrs, 'x')).toBeUndefined();
  });

  it('holds nothing for a step that is not there', () => {
    const attrs = block().attrs;
    expect(expressionAt(attrs, 'transform[9].filter')).toBeUndefined();
    expect(expressionAt(attrs, 'transform[0].derive.margin')).toBeUndefined();
    expect(expressionAt({}, 'transform[0].filter')).toBeUndefined();
  });

  it('agrees with the paths the parser records', () => {
    const node = block();
    const expressions = Object.keys(node.attrsPosition).filter(
      (path) => expressionAt(node.attrs, path) !== undefined,
    );
    expect(expressions).toEqual(['transform[0].filter', 'transform[1].derive.margin']);
  });

  it('claims no other step takes an expression', () => {
    // `filter` and `derive` are the only steps `transform/basic.ts` compiles.
    // A step that grows an expression parameter fails here first.
    for (const step of STEP_SIGNATURES) {
      if (step.name === 'filter' || step.name === 'derive') continue;
      const attrs = { transform: [{ [step.name]: 'sum(a, b)' }] };
      expect(expressionAt(attrs, `transform[0].${step.name}`)).toBeUndefined();
    }
  });
});

/**
 * Where the MDVX in a block is, and where an offset inside it falls
 * (SPEC 6.7, 6.8).
 *
 * A tool that answers questions about a half-written call — signature help, an
 * argument hint, a CLI `--explain` — needs two facts that nothing else in the
 * pipeline hands out: which attribute values are expressions at all, and which
 * call an offset stands in. Both live here so that no tool has to re-implement
 * the grammar to point at an argument, and so that none of them can disagree
 * with the evaluator about where one call ends and the next begins.
 *
 * The offset half runs on a *prefix* of the source, which is the shape a
 * half-written expression has: everything up to the cursor is what the author
 * has committed to, and the unclosed call it ends inside is the question.
 */

import type { AttrMap, AttrValue } from '@mdv/parser';

import { lex } from './lex.js';
import type { Token } from './lex.js';

/** A `transform` entry whose whole value is an expression. */
const FILTER_PATH = /^transform\[(\d+)\]\.filter$/u;

/**
 * A `derive` entry. The key is the rest of the path, greedily: `derive` maps
 * field names to expressions and is one level deep, so a field whose name
 * contains a dot is still one key and not a nesting.
 */
const DERIVE_PATH = /^transform\[(\d+)\]\.derive\.(.+)$/u;

/**
 * The MDVX source an attribute path holds, if it holds any.
 *
 * `filter` and the values of `derive` are the whole of it: they are the two
 * places `@mdv/core` compiles an expression (`transform/basic.ts`), and every
 * other step parameter is a field name, a number or a literal. A step that
 * grows an expression parameter has to be added here, which is what
 * `test/locate.test.ts` checks the current list against.
 *
 * @param attrs the block's own attributes, as the parser read them.
 * @param path a dotted path as `attrsPosition` spells it, e.g.
 * `transform[0].filter`.
 */
export function expressionAt(attrs: AttrMap, path: string): string | undefined {
  const filter = FILTER_PATH.exec(path);
  if (filter !== null) return stringAt(stepAt(attrs, filter[1]), 'filter');

  const derive = DERIVE_PATH.exec(path);
  if (derive === null) return undefined;
  const map = stepAt(attrs, derive[1])?.['derive'];
  return isMap(map) ? stringAt(map, derive[2]) : undefined;
}

/** The `transform` entry at an index, when the pipeline is a list of mappings. */
function stepAt(attrs: AttrMap, index: string | undefined): AttrMap | undefined {
  const pipeline = attrs['transform'];
  if (index === undefined || !Array.isArray(pipeline)) return undefined;
  const step: AttrValue | undefined = pipeline[Number(index)];
  return isMap(step) ? step : undefined;
}

function stringAt(map: AttrMap | undefined, key: string | undefined): string | undefined {
  if (map === undefined || key === undefined) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : undefined;
}

function isMap(value: AttrValue | undefined): value is AttrMap {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A call an offset stands inside, innermost first. */
export interface CallSite {
  /** The name written before the `(`. Not necessarily a whitelisted function. */
  readonly name: string;
  /** Offset of the first character of the name. */
  readonly offset: number;
  /** Which argument the offset is in, counting from zero. */
  readonly argument: number;
}

/** An unclosed `(` or `[`, and how many commas have been passed inside it. */
interface Frame {
  /** The callee, or `undefined` for a grouping paren or a list literal. */
  readonly name?: string;
  readonly offset: number;
  argument: number;
}

/**
 * The innermost call `at` is inside, and which of its arguments.
 *
 * Scanning the prefix and keeping a stack of unclosed brackets is enough: a
 * call the cursor is inside is by definition one that has not been closed
 * before it, and the argument is the commas seen since the bracket that opened
 * it. Nesting therefore costs nothing — `round(sum(a, b‸` answers `sum`, and
 * the commas of a list literal belong to the list, not to the call holding it.
 *
 * @param source the expression as written, quotes already stripped by YAML.
 * @param at an offset into `source`; out-of-range values are clamped.
 * @returns `undefined` when the offset is not inside a call — inside a bare
 * expression, inside a plain group, or after every call has been closed.
 */
export function callAt(source: string, at: number): CallSite | undefined {
  const cursor = Math.max(0, Math.min(at, source.length));
  const frames: Frame[] = [];
  /** Whether the next token would be read as an operand rather than an operator. */
  let operand = true;
  /** The identifier immediately behind, which a `(` would make a callee. */
  let head: Token | undefined;

  for (const token of scan(source.slice(0, cursor))) {
    if (token.kind === 'end') break;

    if (token.kind !== 'punct') {
      const word = token.kind === 'identifier';
      // A word where an operand cannot go is one of the word operators (`in`,
      // `contains`), so an operand follows it and it can never be a callee.
      head = word && operand ? token : undefined;
      operand = word && !operand;
      continue;
    }

    switch (token.text) {
      case '(':
      case '[': {
        // `[` here is a list literal; a bracketed field name is one `field`
        // token and never reaches this branch.
        const callee = token.text === '(' ? head : undefined;
        frames.push(
          callee === undefined
            ? { offset: token.start, argument: 0 }
            : { name: callee.text, offset: callee.start, argument: 0 },
        );
        break;
      }
      case ')':
      case ']':
        frames.pop();
        break;
      case ',': {
        const inner = frames.at(-1);
        if (inner !== undefined) inner.argument += 1;
        break;
      }
      default:
        break;
    }
    head = undefined;
    // A closed bracket is an operand; every other punctuator wants one next.
    operand = token.text !== ')' && token.text !== ']';
  }

  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame?.name === undefined) continue;
    return { name: frame.name, offset: frame.offset, argument: frame.argument };
  }
  return undefined;
}

/**
 * Tokens of a prefix, which is usually not a well-formed expression.
 *
 * `lex` reports the offset of the first character it could not read, and
 * everything before that offset scanned cleanly, so re-scanning the shorter
 * prefix cannot fail again. The case that matters is the half-typed string
 * literal in `contains(name, "op‸`: dropping it leaves the call and its commas
 * intact, which is exactly the part the answer is made of.
 */
function scan(source: string): readonly Token[] {
  const first = lex(source);
  if (first.tokens !== undefined) return first.tokens;
  return lex(source.slice(0, first.error?.offset ?? 0)).tokens ?? [];
}

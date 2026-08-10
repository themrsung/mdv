/**
 * The MDVX parser (SPEC 6.8.1).
 *
 * A recursive-descent parser over the ABNF as written: precedence climbs from
 * `ternary` down to `primary`, `**` is right-associative, everything else is
 * left-associative. Failures are values, never exceptions — the caller turns a
 * {@link ParseError} into `MDV2200`.
 */

import type { BinaryOp, ExprNode, UnaryOp } from './ast.js';
import { lex, type Token } from './lex.js';

export interface ParseError {
  message: string;
  /** Offset into the expression source. */
  offset: number;
}

export interface ParseResult {
  node?: ExprNode;
  error?: ParseError;
}

/** Sentinel thrown internally and caught at the boundary, so the API stays total. */
class Bail extends Error {
  constructor(readonly detail: ParseError) {
    super(detail.message);
  }
}

const EQUALITY_OPS: readonly BinaryOp[] = ['==', '!='];
const COMPARISON_OPS: readonly BinaryOp[] = ['<', '<=', '>', '>='];
const ADDITIVE_OPS: readonly BinaryOp[] = ['+', '-'];
const MULTIPLICATIVE_OPS: readonly BinaryOp[] = ['*', '/', '%'];

/** Parse an MDVX expression. Never throws. */
export function parseExpression(source: string): ParseResult {
  const lexed = lex(source);
  if (lexed.error !== undefined || lexed.tokens === undefined) {
    const error = lexed.error ?? { message: 'Could not scan the expression', offset: 0 };
    return { error };
  }
  const parser = new Parser(lexed.tokens);
  try {
    const node = parser.expr();
    const rest = parser.peek();
    if (rest.kind !== 'end') {
      throw new Bail({
        message: `Unexpected ${describe(rest)} after the end of the expression`,
        offset: rest.start,
      });
    }
    return { node };
  } catch (error) {
    if (error instanceof Bail) return { error: error.detail };
    /* c8 ignore next 2 -- defensive: nothing else in this file throws. */
    throw error;
  }
}

class Parser {
  private index = 0;

  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token {
    return this.tokens[this.index] ?? lastOf(this.tokens);
  }

  private advance(): Token {
    const token = this.peek();
    if (token.kind !== 'end') this.index += 1;
    return token;
  }

  private matchPunct(text: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.text === text) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private matchKeyword(word: string): boolean {
    const token = this.peek();
    if (token.kind === 'identifier' && token.text === word) {
      this.index += 1;
      return true;
    }
    return false;
  }

  private expectPunct(text: string): void {
    if (!this.matchPunct(text)) {
      const token = this.peek();
      throw new Bail({
        message: `Expected ${JSON.stringify(text)} but found ${describe(token)}`,
        offset: token.start,
      });
    }
  }

  /** `expr = ternary` */
  expr(): ExprNode {
    return this.ternary();
  }

  /** `ternary = or [ "?" expr ":" expr ]` */
  private ternary(): ExprNode {
    const test = this.or();
    if (!this.matchPunct('?')) return test;
    const consequent = this.expr();
    this.expectPunct(':');
    const alternate = this.expr();
    return { kind: 'conditional', test, consequent, alternate };
  }

  /** `or = and *( "||" and )` */
  private or(): ExprNode {
    let left = this.and();
    while (this.matchPunct('||')) {
      left = { kind: 'binary', op: '||', left, right: this.and() };
    }
    return left;
  }

  /** `and = equality *( "&&" equality )` */
  private and(): ExprNode {
    let left = this.equality();
    while (this.matchPunct('&&')) {
      left = { kind: 'binary', op: '&&', left, right: this.equality() };
    }
    return left;
  }

  /** `equality = comparison *( ( "==" / "!=" ) comparison )` */
  private equality(): ExprNode {
    let left = this.comparison();
    for (;;) {
      const op = this.matchAny(EQUALITY_OPS);
      if (op === undefined) return left;
      left = { kind: 'binary', op, left, right: this.comparison() };
    }
  }

  /** `comparison = additive *( ( "<" / "<=" / ">" / ">=" / "in" / "contains" ) additive )` */
  private comparison(): ExprNode {
    let left = this.additive();
    for (;;) {
      const op = this.matchAny(COMPARISON_OPS) ?? this.matchWordOp();
      if (op === undefined) return left;
      left = { kind: 'binary', op, left, right: this.additive() };
    }
  }

  /** `additive = multiplicative *( ( "+" / "-" ) multiplicative )` */
  private additive(): ExprNode {
    let left = this.multiplicative();
    for (;;) {
      const op = this.matchAny(ADDITIVE_OPS);
      if (op === undefined) return left;
      left = { kind: 'binary', op, left, right: this.multiplicative() };
    }
  }

  /** `multiplicative = unary *( ( "*" / "/" / "%" ) unary )` */
  private multiplicative(): ExprNode {
    let left = this.unary();
    for (;;) {
      const op = this.matchAny(MULTIPLICATIVE_OPS);
      if (op === undefined) return left;
      left = { kind: 'binary', op, left, right: this.unary() };
    }
  }

  /** `unary = [ "!" / "-" ] power` */
  private unary(): ExprNode {
    const token = this.peek();
    if (token.kind === 'punct' && (token.text === '!' || token.text === '-')) {
      this.index += 1;
      const op: UnaryOp = token.text;
      return { kind: 'unary', op, operand: this.unary() };
    }
    return this.power();
  }

  /** `power = primary [ "**" unary ]` — right-associative through `unary`. */
  private power(): ExprNode {
    const base = this.primary();
    if (this.matchPunct('**')) {
      return { kind: 'binary', op: '**', left: base, right: this.unary() };
    }
    return base;
  }

  /**
   * `primary = number / string / boolean / "null" / field-ref / func-call
   *          / "(" expr ")" / list`
   */
  private primary(): ExprNode {
    const token = this.advance();

    if (token.kind === 'number') {
      return { kind: 'literal', value: token.value as number };
    }
    if (token.kind === 'string') {
      return { kind: 'literal', value: token.value as string };
    }
    if (token.kind === 'field') {
      return { kind: 'field', name: token.text };
    }
    if (token.kind === 'identifier') {
      if (token.text === 'true') return { kind: 'literal', value: true };
      if (token.text === 'false') return { kind: 'literal', value: false };
      if (token.text === 'null') return { kind: 'literal', value: null };
      if (this.matchPunct('(')) {
        const args = this.argumentList(')');
        return { kind: 'call', name: token.text, args, offset: token.start };
      }
      return { kind: 'field', name: token.text };
    }
    if (token.kind === 'punct') {
      if (token.text === '(') {
        const inner = this.expr();
        this.expectPunct(')');
        return inner;
      }
      if (token.text === '[') {
        const items = this.argumentList(']');
        return { kind: 'list', items };
      }
    }

    throw new Bail({ message: `Unexpected ${describe(token)}`, offset: token.start });
  }

  /** A comma-separated expression list, the opening bracket already consumed. */
  private argumentList(close: string): ExprNode[] {
    const items: ExprNode[] = [];
    if (this.matchPunct(close)) return items;
    for (;;) {
      items.push(this.expr());
      if (this.matchPunct(',')) {
        // A trailing separator before the closer is accepted: `[a, b, ]`.
        if (this.matchPunct(close)) return items;
        continue;
      }
      this.expectPunct(close);
      return items;
    }
  }

  private matchAny(ops: readonly BinaryOp[]): BinaryOp | undefined {
    const token = this.peek();
    if (token.kind !== 'punct') return undefined;
    for (const op of ops) {
      if (token.text === op) {
        this.index += 1;
        return op;
      }
    }
    return undefined;
  }

  /** `in` and `contains` are spelled as words but are comparison operators. */
  private matchWordOp(): BinaryOp | undefined {
    if (this.matchKeyword('in')) return 'in';
    if (this.matchKeyword('contains')) return 'contains';
    return undefined;
  }
}

function describe(token: Token): string {
  switch (token.kind) {
    case 'end':
      return 'the end of the expression';
    case 'string':
      return `string ${JSON.stringify(token.value)}`;
    case 'number':
      return `number ${token.text}`;
    case 'field':
      return `field [${token.text}]`;
    default:
      return JSON.stringify(token.text);
  }
}

function lastOf(tokens: readonly Token[]): Token {
  const token = tokens[tokens.length - 1];
  /* c8 ignore next -- `lex` always appends an `end` token. */
  return token ?? { kind: 'end', text: '', start: 0, end: 0 };
}

/**
 * The MDVX abstract syntax tree (SPEC 6.8.1).
 *
 * Deliberately tiny: five node kinds, a fixed operator set, and no statement
 * form. There is nothing here that can name a host object, so a compiled tree
 * cannot reach anything the evaluator does not hand it (SPEC 13.1).
 */

/** Binary operators, in the grammar's spelling. */
export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '!='
  | '<'
  | '<='
  | '>'
  | '>='
  | 'in'
  | 'contains'
  | '+'
  | '-'
  | '*'
  | '/'
  | '%'
  | '**';

/** Prefix operators. */
export type UnaryOp = '!' | '-';

export interface LiteralNode {
  kind: 'literal';
  value: number | string | boolean | null;
}

export interface FieldNode {
  kind: 'field';
  name: string;
}

export interface UnaryNode {
  kind: 'unary';
  op: UnaryOp;
  operand: ExprNode;
}

export interface BinaryNode {
  kind: 'binary';
  op: BinaryOp;
  left: ExprNode;
  right: ExprNode;
}

export interface ConditionalNode {
  kind: 'conditional';
  test: ExprNode;
  consequent: ExprNode;
  alternate: ExprNode;
}

export interface CallNode {
  kind: 'call';
  name: string;
  args: ExprNode[];
  /** Offset of the name, so an unknown function points at itself. */
  offset: number;
}

export interface ListNode {
  kind: 'list';
  items: ExprNode[];
}

export type ExprNode =
  LiteralNode | FieldNode | UnaryNode | BinaryNode | ConditionalNode | CallNode | ListNode;

/** Depth of a tree, counting the root as 1. Used against the SPEC 13.6 limit. */
export function depthOf(node: ExprNode): number {
  switch (node.kind) {
    case 'literal':
    case 'field':
      return 1;
    case 'unary':
      return 1 + depthOf(node.operand);
    case 'binary':
      return 1 + Math.max(depthOf(node.left), depthOf(node.right));
    case 'conditional':
      return 1 + Math.max(depthOf(node.test), depthOf(node.consequent), depthOf(node.alternate));
    case 'call':
      return 1 + maxDepth(node.args);
    case 'list':
      return 1 + maxDepth(node.items);
  }
}

/** Number of function calls in a tree. Used against the SPEC 13.6 limit. */
export function callsIn(node: ExprNode): number {
  switch (node.kind) {
    case 'literal':
    case 'field':
      return 0;
    case 'unary':
      return callsIn(node.operand);
    case 'binary':
      return callsIn(node.left) + callsIn(node.right);
    case 'conditional':
      return callsIn(node.test) + callsIn(node.consequent) + callsIn(node.alternate);
    case 'call':
      return 1 + sumCalls(node.args);
    case 'list':
      return sumCalls(node.items);
  }
}

/** Every field name a tree reads, in first-appearance order and de-duplicated. */
export function fieldsIn(node: ExprNode, into: string[] = []): string[] {
  switch (node.kind) {
    case 'field':
      if (!into.includes(node.name)) into.push(node.name);
      return into;
    case 'literal':
      return into;
    case 'unary':
      return fieldsIn(node.operand, into);
    case 'binary':
      fieldsIn(node.left, into);
      return fieldsIn(node.right, into);
    case 'conditional':
      fieldsIn(node.test, into);
      fieldsIn(node.consequent, into);
      return fieldsIn(node.alternate, into);
    case 'call':
      for (const arg of node.args) fieldsIn(arg, into);
      return into;
    case 'list':
      for (const item of node.items) fieldsIn(item, into);
      return into;
  }
}

function maxDepth(nodes: readonly ExprNode[]): number {
  let max = 0;
  for (const node of nodes) {
    const d = depthOf(node);
    if (d > max) max = d;
  }
  return max;
}

function sumCalls(nodes: readonly ExprNode[]): number {
  let total = 0;
  for (const node of nodes) total += callsIn(node);
  return total;
}

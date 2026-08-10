/**
 * The published signature table against the code that enforces it.
 *
 * `@mdv/spec`'s `signatures.json` exists so that a tool can *describe* a call —
 * signature help, completion, a CLI `--explain` — without re-deriving MDV
 * semantics it has no business owning (SPEC 29.4). That only works while the
 * description matches the behaviour, and nothing in the type system holds them
 * together: the table is JSON and the whitelist is a `Record` of closures.
 *
 * This suite is the join. Every claim here is checked against the thing that
 * would actually be wrong if the table drifted — arity against
 * {@link FunctionDef}, step shapes against the `MDV2501` text a real pipeline
 * emits — so a function added to `@mdv/core` without being published, or a
 * shape reworded on one side only, fails the build rather than a user's editor.
 */

import {
  FUNCTION_SIGNATURES,
  SIGNATURE_TABLE,
  SPEC_VERSION,
  STEP_SIGNATURES,
  arityOf,
  renderSignature,
  renderStepSignature,
} from '@mdv/spec';
import { describe, expect, it } from 'vitest';
import { createCollector } from '../src/data/diag.js';
import { effectiveLimits } from '../src/data/limits.js';
import { FUNCTIONS } from '../src/expr/index.js';
import { applyStep, type TransformContext } from '../src/transform/index.js';
import type { Table, TransformStep } from '../src/types/data.js';

describe('the published table', () => {
  it('is generated from the revision the package advertises', () => {
    expect(SIGNATURE_TABLE.specVersion).toBe(SPEC_VERSION);
  });
});

describe('functions (SPEC 6.8.2)', () => {
  it('publishes exactly the whitelist, in the same order', () => {
    const published = FUNCTION_SIGNATURES.map((signature) => signature.name);
    expect(published).toEqual(Object.keys(FUNCTIONS));
  });

  it.each(FUNCTION_SIGNATURES)('$name accepts the argument counts core enforces', (signature) => {
    const def = FUNCTIONS[signature.name];
    expect(def, `${signature.name} is published but not implemented`).toBeDefined();
    expect(arityOf(signature.name)).toEqual({ min: def?.min, max: def?.max });
  });

  it.each(FUNCTION_SIGNATURES)('$name agrees about being aggregate-only', (signature) => {
    const aggregateOnly = FUNCTIONS[signature.name]?.aggregateOnly === true;
    expect(signature.aggregateOnly === true).toBe(aggregateOnly);
  });

  it('marks the stats group, and only the stats group, aggregate-only', () => {
    const stats = FUNCTION_SIGNATURES.filter((signature) => signature.group === 'stats');
    const aggregate = FUNCTION_SIGNATURES.filter((signature) => signature.aggregateOnly === true);
    expect(aggregate).toEqual(stats);
  });

  it.each(FUNCTION_SIGNATURES)('$name names each parameter once', (signature) => {
    const names = signature.params.map((param) => param.name);
    expect(new Set(names).size, `duplicate parameter name in ${signature.name}`).toBe(names.length);
  });

  /**
   * A signature-help client highlights the active parameter by its span in the
   * label, so the label has to be decomposable back into the parameter list it
   * was built from — `dateAdd(date, amount, unit)` is exactly why that is
   * checked by splitting the argument list rather than by searching the whole
   * label for `date`.
   */
  it.each(FUNCTION_SIGNATURES)('$name renders a label its spans can be read off', (signature) => {
    const label = renderSignature(signature);
    expect(label.startsWith(`${signature.name}(`)).toBe(true);
    expect(label.endsWith(')')).toBe(true);
    const inner = label.slice(signature.name.length + 1, -1);
    const rendered = inner === '' ? [] : inner.split(', ');
    expect(rendered.length).toBe(signature.params.length);
    signature.params.forEach((param, at) => {
      expect(rendered[at]?.startsWith(param.name)).toBe(true);
    });
  });

  it.each(FUNCTION_SIGNATURES)('$name puts its optional parameters last', (signature) => {
    const optional = signature.params.map((param) => param.optional === true);
    expect(optional).toEqual([...optional].sort((a, b) => Number(a) - Number(b)));
  });

  it.each(FUNCTION_SIGNATURES)('$name puts a variadic parameter last, alone', (signature) => {
    const rest = signature.params.filter((param) => param.rest === true);
    expect(rest.length).toBeLessThanOrEqual(1);
    if (rest.length === 1) expect(signature.params.at(-1)).toBe(rest[0]);
  });

  it('renders the labels a tool will show', () => {
    const label = (name: string): string => {
      const signature = FUNCTION_SIGNATURES.find((entry) => entry.name === name);
      return signature === undefined ? '(unpublished)' : renderSignature(signature);
    };
    expect(label('now')).toBe('now()');
    expect(label('pow')).toBe('pow(base, exponent)');
    expect(label('substr')).toBe('substr(text, start, length?)');
    expect(label('min')).toBe('min(value…)');
    expect(label('if')).toBe('if(condition, then, else)');
  });
});

describe('steps (SPEC 6.7)', () => {
  const BUILD_TIME = new Date('2026-08-10T12:00:00Z');
  const INPUT: Table = { fields: [{ name: 'value', type: 'number' }], rows: [[1]] };

  function context(): TransformContext {
    return {
      diag: createCollector('data'),
      zone: 'UTC',
      buildTime: BUILD_TIME,
      format: { locale: 'en-US', timezone: 'UTC', buildTime: BUILD_TIME },
      limits: effectiveLimits(),
    };
  }

  /**
   * Run a published step with a parameter no step accepts.
   *
   * `null` is malformed for all twelve, so the reply separates the two failures
   * that matter here: `MDV2500` means the name is published but `dispatch` has
   * no case for it, and the `MDV2501` text carries the shape string the table
   * is supposed to be quoting.
   */
  function reject(name: string): { codes: string[]; messages: string[]; out: Table } {
    const ctx = context();
    const out = applyStep(INPUT, { [name]: null } as unknown as TransformStep, ctx);
    return {
      out,
      codes: ctx.diag.diagnostics.map((diagnostic) => diagnostic.code),
      messages: ctx.diag.diagnostics.map((diagnostic) => diagnostic.message),
    };
  }

  it.each(STEP_SIGNATURES)('$name is a step the pipeline can dispatch', (signature) => {
    expect(reject(signature.name).codes).toEqual(['MDV2501']);
  });

  it.each(STEP_SIGNATURES)('$name publishes the shape its diagnostic quotes', (signature) => {
    const expected = `\`${signature.name}\` needs ${signature.shape}`;
    expect(reject(signature.name).messages).toEqual([expected]);
  });

  it.each(STEP_SIGNATURES)('$name leaves the table alone when malformed', (signature) => {
    expect(reject(signature.name).out).toEqual(INPUT);
  });

  it.each(STEP_SIGNATURES)('$name names each key once', (signature) => {
    const names = signature.keys.map((key) => key.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('renders the labels a tool will show', () => {
    const label = (name: string): string => {
      const signature = STEP_SIGNATURES.find((entry) => entry.name === name);
      return signature === undefined ? '(unpublished)' : renderStepSignature(signature);
    };
    expect(label('window')).toBe('window: {op, field, size, output, partition?}');
    expect(label('join')).toBe('join: {with, on, how?}');
    expect(label('sort')).toBe('sort: a field name or a list of them');
    expect(label('filter')).toBe('filter: an expression string');
  });

  it('has no name the pipeline would call unknown', () => {
    expect(reject('nonesuch').codes).toEqual(['MDV2500']);
  });
});

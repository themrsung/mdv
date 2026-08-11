/**
 * What a case proves (SPEC 16.1, SPEC 16.3).
 *
 * The whole conformance claim rests on this derivation: a level is
 * substantiated when every requirement under it names a case, so an id added
 * here that the case does not really exercise is an over-claim that no other
 * test can catch. The documents are parsed and resolved for real rather than
 * hand-built — the point of deriving coverage is that it tracks what the
 * pipeline actually did, and a stubbed document would only test the stub.
 */

import { parse, resolve } from '@mdv/core';
import type { ResolvedDocument } from '@mdv/core';
import { describe, expect, it } from 'vitest';

import { coverageOf } from '../src/coverage.js';
import { conformanceConfig } from '../src/run.js';
import type { CaseMeta, CheckName, CheckResult } from '../src/types.js';

/** Resolve a source the way a case does, so coverage sees a real document. */
async function documentOf(source: string): Promise<ResolvedDocument> {
  return await resolve(parse(source), conformanceConfig(1));
}

/** What a test wants to be different about the case being derived from. */
interface CoverageSpec {
  /** Checks that passed; every other check is absent rather than failing. */
  readonly checks?: readonly CheckName[];
  /** Checks that ran to a skip — present in the result, but proving nothing. */
  readonly skipped?: readonly CheckName[];
  /** The rendered output, when the test is about what was drawn. */
  readonly svg?: string;
  readonly meta?: Partial<CaseMeta>;
}

/** The ids `source` covers. */
async function covers(source: string, spec: CoverageSpec = {}): Promise<readonly string[]> {
  const checks: CheckResult[] = [
    ...(spec.checks ?? []).map((check): CheckResult => ({ check, status: 'pass' })),
    ...(spec.skipped ?? []).map((check): CheckResult => ({
      check,
      status: 'skip',
      reason: 'nothing pinned',
    })),
  ];
  return coverageOf({
    meta: { level: 1, tags: [], covers: [], pin: [], ...spec.meta },
    document: await documentOf(source),
    svg: spec.svg,
    checks,
  });
}

const BAR = `\`\`\`mdv bar
x: region
y: revenue
---
region,revenue
North,120
\`\`\`
`;

describe('coverageOf', () => {
  it('derives the block type from the resolved document, not from `meta`', async () => {
    expect(await covers(BAR)).toContain('type.bar');
  });

  it('sorts and deduplicates, so two bars read as one claim', async () => {
    const ids = await covers(`${BAR}\n${BAR}`);

    expect(ids.filter((id) => id === 'type.bar')).toHaveLength(1);
    expect([...ids]).toStrictEqual([...ids].sort());
  });

  it('drops ids that are not SPEC 16.1 requirements', async () => {
    expect(await covers(BAR, { meta: { covers: ['type.sunburst'] } })).not.toContain(
      'type.sunburst',
    );
  });

  it('adds what `meta.covers` declares, for what leaves no trace in a document', async () => {
    expect(await covers(BAR, { meta: { covers: ['a11y.keyboard'] } })).toContain('a11y.keyboard');
  });

  describe('error cards (SPEC 14.1)', () => {
    /**
     * The case that motivated deriving this from the output: `y:` names a
     * column that is not in the data, which resolves cleanly — the failure
     * only happens in layout, when the chart type binds its channels. Neither
     * the document's blocks nor its AST record it.
     */
    const LATE_FAILURE = `\`\`\`mdv bar
x: region
y: revenu
---
region,revenue
North,120
\`\`\`
`;

    it('is not claimed by a document that resolved without a failure', async () => {
      expect(await covers(LATE_FAILURE, { checks: ['render'] })).not.toContain(
        'render.error-cards',
      );
    });

    it('is claimed when the output actually drew a card', async () => {
      const svg = '<g class="mdv-error-card"><text>could not be rendered</text></g>';

      expect(await covers(LATE_FAILURE, { checks: ['render'], svg })).toContain(
        'render.error-cards',
      );
    });

    /**
     * Every SVG embeds the stylesheet, and the stylesheet names the class in
     * its rules. Matching the bare string would claim the requirement for
     * every case in the corpus.
     */
    it('is not claimed by the stylesheet rule that every SVG carries', async () => {
      const svg = '<style>.mdv-root .mdv-error-card{display:block}</style><g class="mdv-bar" />';

      expect(await covers(BAR, { checks: ['render'], svg })).not.toContain('render.error-cards');
    });

    it('is not claimed by a class that merely starts the same way', async () => {
      const svg = '<g class="mdv-error-card-shadow" />';

      expect(await covers(BAR, { checks: ['render'], svg })).not.toContain('render.error-cards');
    });
  });

  /**
   * The requirement is that the marks are painted from the token set, and one
   * render cannot show that: the light theme is the default surface, so a
   * build with the light palette written into it passes `render` and reads no
   * token at all. Only the second render, of the same document under the other
   * theme, is evidence.
   */
  describe('theme tokens (SPEC 11.1)', () => {
    it('is not claimed by the light render alone', async () => {
      expect(await covers(BAR, { checks: ['render'] })).not.toContain('theme.tokens');
    });

    it('is claimed when the case also held to a dark render', async () => {
      expect(await covers(BAR, { checks: ['render', 'dark'] })).toContain('theme.tokens');
    });

    it('is not claimed by a dark check that skipped for want of a golden', async () => {
      expect(await covers(BAR, { checks: ['render'], skipped: ['dark'] })).not.toContain(
        'theme.tokens',
      );
    });
  });

  describe('accessible names (SPEC 12.1)', () => {
    it('wants both a role and a name', async () => {
      expect(await covers(BAR, { svg: '<svg role="img" aria-label="Revenue" />' })).toContain(
        'a11y.names',
      );
      expect(await covers(BAR, { svg: '<svg role="img" />' })).not.toContain('a11y.names');
      expect(await covers(BAR, { svg: '<svg aria-label="Revenue" />' })).not.toContain(
        'a11y.names',
      );
    });
  });

  it('collects nothing from the output when the case rendered no SVG', async () => {
    expect(await covers(BAR, { checks: ['render'] })).not.toContain('a11y.names');
  });
});

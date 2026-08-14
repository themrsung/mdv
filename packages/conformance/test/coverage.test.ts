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

  describe('unimplemented types (SPEC 15.2)', () => {
    /**
     * A stub renders the data as a table and says so. The case passes — that
     * is what graceful degradation *means* — so coverage is collected from it,
     * and the one id it must not collect is the type that was never drawn.
     *
     * `gantt` is the specimen because it is Level 3 and this reader is not
     * going to draw it soon. Any type here has a shelf life: the day a type is
     * implemented, `type.<name>` *should* start being credited, and this test
     * would start failing for the happiest of reasons. When that day comes for
     * `gantt`, move the specimen rather than teaching {@link coverageOf} to
     * keep lying about it.
     */
    const GANTT = `\`\`\`mdv gantt
x: revenue
---
region,revenue
North,120
\`\`\`
`;

    it('does not claim a type that came out as a table', async () => {
      expect(await covers(GANTT, { checks: ['render'] })).not.toContain('type.gantt');
    });

    it('still credits what the document really did show', async () => {
      expect(await covers(GANTT, { checks: ['render'] })).toContain('data.csv');
    });

    it('claims the spelling the author wrote, since `ohlc` and `candlestick` are two ids', async () => {
      const CANDLESTICK = `\`\`\`mdv candlestick
x: date
---
date,open,high,low,close
2026-01-02,1,2,0,1
2026-01-03,1,3,1,2
\`\`\`
`;
      const ids = await covers(CANDLESTICK, { checks: ['render'] });

      // `candlestick` is an alias of `ohlc` and both now draw, so the block is
      // evidence for the requirement it is written as and for no other. Were
      // the pair still stubbed, neither id would appear: the stub list is
      // flattened over aliases precisely so an alias cannot smuggle in a claim.
      expect(ids).toContain('type.candlestick');
      expect(ids).not.toContain('type.ohlc');
    });

    it('claims a type the build really implements, so the rule is about stubs alone', async () => {
      expect(await covers(BAR, { checks: ['render'] })).toContain('type.bar');
    });
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

  /**
   * Two requirements, not one: SPEC 9.1 is the container syntax and SPEC 9.2
   * the inline sparkline. They are spelled with the same `:` sigil and land on
   * the same AST node type, which is exactly why the derivation has to read
   * `kind` — deriving both from "a directive was seen" would let one case
   * substantiate a feature the document never used.
   */
  describe('directives (SPEC 9.1, SPEC 9.2)', () => {
    const CONTAINER = ':::mdv-grid{cols=2}\n\nLeft.\n\n:::\n';
    const SPARK = 'Revenue :mdv-spark[1,2,3]{type=line} held.\n';

    it('claims the block syntax for a container directive', async () => {
      expect(await covers(CONTAINER)).toContain('syntax.directives');
    });

    it('does not claim the block syntax for an inline one', async () => {
      expect(await covers(SPARK)).not.toContain('syntax.directives');
    });

    it('claims the sparkline for the inline `mdv-spark` the parser really emits', async () => {
      expect(await covers(SPARK)).toContain('syntax.inline-sparkline');
    });

    /**
     * The parser spells every directive with the `mdv-` prefix, so a rule
     * written against a bare `sparkline` matches nothing and the requirement
     * can never be substantiated. Pinning the spelling here is what stops that
     * from being reintroduced.
     */
    it('is not claimed by another inline directive', async () => {
      expect(await covers('A :mdv-metric[42]{label=Answer} today.\n')).not.toContain(
        'syntax.inline-sparkline',
      );
    });
  });

  /**
   * SPEC 11.6 is the *override*, not a theme being in force: every document
   * resolves under some theme, so anything weaker than "this document restyled
   * itself and core honoured it" would credit the whole corpus.
   */
  describe('custom themes (SPEC 11.6)', () => {
    const custom = (theme: string): string =>
      `---\nmdv: "1.0"\ntheme:\n${theme}---\n\n# Restyled\n`;

    it('claims an override that resolved', async () => {
      const ids = await covers(custom('  extends: default\n  name: corpus\n  grid: "#dfe3e8"\n'));

      expect(ids).toContain('theme.custom');
    });

    it('is not claimed by a document that named a built-in', async () => {
      expect(await covers('---\nmdv: "1.0"\ntheme: dark\n---\n\n# Plain\n')).not.toContain(
        'theme.custom',
      );
    });

    it('is not claimed by a document with no front matter at all', async () => {
      expect(await covers(BAR)).not.toContain('theme.custom');
    });

    /**
     * `MDV1502` is how core reports an override it could not honour, and it
     * leaves the base theme standing. The document is then evidence of the
     * degradation path (SPEC 15.2), not of custom theming.
     */
    it('is not claimed when the override was reported instead of applied', async () => {
      const ids = await covers(custom('  extends: no-such-theme\n  name: corpus\n'));

      expect(ids).not.toContain('theme.custom');
    });
  });

  it('collects nothing from the output when the case rendered no SVG', async () => {
    expect(await covers(BAR, { checks: ['render'] })).not.toContain('a11y.names');
  });
});

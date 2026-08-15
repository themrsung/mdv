/**
 * The PDF/UA harness (SPEC 28.8, F.2 M6).
 *
 * veraPDF is not installed on every machine that runs this suite and must never
 * be required by it, so nothing here shells out to a validator. What is asserted
 * is the half that is this repository's own work and the half a missing tool
 * would otherwise hide:
 *
 * - the export really produces a PDF per case, under the profile;
 * - every figure reaches the file with an `/Alt`, which is the accessibility
 *   claim the profile exists to enforce and the one thing veraPDF could not
 *   tell us anything useful about if it were absent;
 * - a document that cannot be built is *reported*, not thrown, so one bad file
 *   does not cost the other forty-nine;
 * - the validator's output is *accounted for* — a parse that silently matched
 *   nothing is the failure mode that would turn this whole milestone into a
 *   green light over unvalidated files, so {@link parseVeraPdfText} throws
 *   rather than returning a short list;
 * - a run with no validator reports its files as unvalidated, never as passing.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadCorpus } from '../src/corpus.js';
import {
  PDFUA_FLAVOUR,
  VeraPdfError,
  exportCase,
  exportCorpus,
  parseVeraPdfText,
  pdfNameOf,
  renderPdfUaReport,
  tallyPdfUa,
} from '../src/pdfua.js';
import type { PdfUaReport } from '../src/pdfua.js';
import { BAR_CASE, tempCorpus } from './harness.js';

/** A chart the author described neither with `title:` nor with `desc:`. */
const UNDESCRIBED_CASE = `---
mdv: "1.0"
title: Undescribed
---

# Undescribed

\`\`\`mdv bar
x: region
y: revenue
---
region,revenue
North,120
South,90
\`\`\`
`;

/** A page size no unit parser can read — an export that fails on its way out. */
const MALFORMED_CASE = `---
mdv: "1.0"
title: Malformed
pdf:
  pageSize: Q7
---

# Malformed

Prose enough to need a page.
`;

/**
 * Every `/Alt` in an uncompressed PDF, decoded.
 *
 * The writer emits accessible text as a UTF-16BE hex string, which is why this
 * reads bytes rather than looking for a literal: an assertion that searched for
 * `(Bar chart…)` would pass only for the ASCII subset and quietly stop testing
 * anything the moment a description contained a non-Latin character.
 */
function altTexts(pdf: string): string[] {
  return [...pdf.matchAll(/\/Alt\s*<([0-9A-Fa-f]+)>/g)].map(([, hex = '']) =>
    // Big-endian on disk, little-endian in Node: swap, then drop the BOM.
    Buffer.from(hex, 'hex')
      .swap16()
      .toString('utf16le')
      .replace(/^\uFEFF/, ''),
  );
}

const dirs: string[] = [];

async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mdv-pdfua-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('pdfNameOf', () => {
  it('flattens a case id into one file name', () => {
    expect(pdfNameOf('render/bar/stacked-percent')).toBe('render__bar__stacked-percent.pdf');
  });
});

describe('exportCase', () => {
  it('writes a PDF for a described figure', async () => {
    const corpus = await tempCorpus();
    await corpus.addCase('render/bar/basic', { source: BAR_CASE });
    const loaded = await loadCorpus(corpus.root);
    const out = await workdir();

    const [result] = await exportCorpus(loaded, out);

    expect(result?.refused).toBeUndefined();
    expect(result?.file).toBe(join(out, 'render__bar__basic.pdf'));
    const bytes = await readFile(result?.file ?? '');
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(result?.bytes).toBe(bytes.length);
    await corpus.cleanup();
  });

  it('gives an undescribed chart the generated description as its /Alt', async () => {
    // PDF/UA refuses a `/Figure` with no `/Alt` (MDV5110, SPEC 28.8) — and no
    // corpus document can provoke it. Every visual block is named by
    // `buildA11yTree`: the author's `desc:`, else its `title:`, else a
    // description generated from the data, else `"<type> chart"` (SPEC 12.2).
    // So the interesting assertion is not that this case is refused but that it
    // is *not*: the accessibility guarantee is upstream of the profile, and the
    // profile has nothing left to catch. MDV5110 itself is covered where it can
    // be reached, over hand-built struct trees, in render-pdf's own tests.
    const corpus = await tempCorpus();
    await corpus.addCase('render/bar/undescribed', { source: UNDESCRIBED_CASE });
    const loaded = await loadCorpus(corpus.root);

    const result = await exportCase(loaded.cases[0]!, await workdir(), { compress: false });

    expect(result.refused).toBeUndefined();
    expect(result.diagnostics).not.toContain('MDV5110');
    const [alt] = altTexts((await readFile(result.file ?? '')).toString('latin1'));
    expect(alt).toMatch(/^Bar chart\./);
    expect(alt).toMatch(/120 in North/);
    await corpus.cleanup();
  });

  it('reports a failed export as a refusal instead of throwing', async () => {
    // The harness exports fifty files in a row: one document that cannot be
    // built must cost that document and no other. A throw here would abandon
    // the rest of the corpus and report nothing about any of it.
    const corpus = await tempCorpus();
    await corpus.addCase('render/prose/malformed', { source: MALFORMED_CASE });
    const loaded = await loadCorpus(corpus.root);

    const result = await exportCase(loaded.cases[0]!, await workdir());

    expect(result.file).toBeUndefined();
    expect(result.refused).toMatch(/Q7/);
    await corpus.cleanup();
  });
});

describe('parseVeraPdfText', () => {
  const files = [resolve('/tmp/a.pdf'), resolve('/tmp/b.pdf')];

  it('reads one verdict per file', () => {
    const output = [
      `PASS ${files[0]}`,
      `FAIL ${files[1]}`,
      '  FAILED 7.1-1 - a rule that failed',
    ].join('\n');

    expect(parseVeraPdfText(output, files)).toEqual([
      { file: files[0], compliant: true, rules: [] },
      { file: files[1], compliant: false, rules: [] },
    ]);
  });

  it('keeps the clauses a file broke', () => {
    // The shape veraPDF really prints under `--format text --verbose`: the
    // flavour trails the file name on the verdict line, and each broken rule
    // gets an indented line of its own. Parsed by hand once, pinned here, so
    // that a change in that layout fails a test rather than turning fifty
    // failures into fifty blanks.
    const output = [
      `FAIL ${files[0]} ua1`,
      '  FAIL 5-1',
      '  FAIL 7.21.4.1-1',
      `PASS ${files[1]} ua1`,
    ].join('\n');

    expect(parseVeraPdfText(output, files)).toEqual([
      { file: files[0], compliant: false, rules: ['5-1', '7.21.4.1-1'] },
      { file: files[1], compliant: true, rules: [] },
    ]);
  });

  it('reports a file under the name it was asked about', async () => {
    // veraPDF prints the file it opened, not the argument it was given: on a
    // Mac a temporary directory is reached through a symlink (`/tmp` is
    // `/private/tmp`), so the two names differ for every file in a real run. A
    // verdict filed under the resolved name would be invisible to the caller
    // that exported it, and fifty files would read as unvalidated.
    const dir = await workdir();
    await mkdir(join(dir, 'real'), { recursive: true });
    await writeFile(join(dir, 'real', 'a.pdf'), '%PDF-1.7\n');
    await symlink(join(dir, 'real'), join(dir, 'link'));
    const asked = join(dir, 'link', 'a.pdf');

    const output = `PASS ${join(dir, 'real', 'a.pdf')}\n`;

    expect(parseVeraPdfText(output, [asked])).toEqual([
      { file: asked, compliant: true, rules: [] },
    ]);
  });

  it('accepts a trailing verdict', () => {
    const output = `${files[0]} PASS\n${files[1]} FAIL\n`;
    expect(parseVeraPdfText(output, files).map((v) => v.compliant)).toEqual([true, false]);
  });

  it('throws rather than reporting a file the validator never mentioned', () => {
    expect(() => parseVeraPdfText(`PASS ${files[0]}\n`, files)).toThrow(VeraPdfError);
  });

  it('throws when a file is reported twice', () => {
    const output = `PASS ${files[0]}\nFAIL ${files[0]}\nPASS ${files[1]}\n`;
    expect(() => parseVeraPdfText(output, files)).toThrow(/twice/);
  });

  it('ignores verdict-shaped lines about other files', () => {
    const output = `PASS /tmp/somebody-elses.pdf\nPASS ${files[0]}\nPASS ${files[1]}\n`;
    expect(parseVeraPdfText(output, files)).toHaveLength(2);
  });
});

describe('tallyPdfUa', () => {
  const exports_ = [
    { id: 'a', file: '/tmp/a.pdf', bytes: 10, diagnostics: [] },
    { id: 'b', file: '/tmp/b.pdf', bytes: 10, diagnostics: [] },
    { id: 'c', refused: 'MDV5110', diagnostics: ['MDV5110'] },
  ];

  it('counts a file the validator never saw apart from one it rejected', () => {
    const report: PdfUaReport = { exports: exports_, generated: '1970-01-01T00:00:00.000Z' };
    expect(tallyPdfUa(report)).toEqual({ passed: 0, failed: 0, refused: 1, unvalidated: 2 });
  });

  it('counts verdicts when there are verdicts', () => {
    const report: PdfUaReport = {
      exports: exports_,
      generated: '1970-01-01T00:00:00.000Z',
      run: {
        validator: 'verapdf',
        version: 'veraPDF 1.30.2',
        flavour: PDFUA_FLAVOUR,
        output: '',
        verdicts: [
          { file: resolve('/tmp/a.pdf'), compliant: true, rules: [] },
          { file: resolve('/tmp/b.pdf'), compliant: false, rules: ['5-1', '7.21.4.1-1'] },
        ],
      },
    };
    expect(tallyPdfUa(report)).toEqual({ passed: 1, failed: 1, refused: 1, unvalidated: 0 });

    const text = renderPdfUaReport(report);
    expect(text).toContain('**1 passed, 1 failed, 1 refused**');
    expect(text).toMatch(/\| `b` \| FAIL \|/);
    expect(text).toContain('veraPDF 1.30.2');
    // A failure has to say what broke. "FAIL" on its own is a report nobody can
    // act on, and the clause is the only part of it that leads anywhere.
    expect(text).toMatch(/\| `b` \| FAIL \| `5-1`, `7\.21\.4\.1-1` \|/);
    expect(text).toContain('| `5-1` | 1 |');
  });
});

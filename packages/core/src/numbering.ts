/**
 * Anchors and counters — the arithmetic behind `:mdv-ref[]` (SPEC 9.2, 28.2).
 *
 * Three renderers number the same document: the PDF exporter walks a flow and
 * writes `Figure 3.1` into a caption, the React renderer walks the same AST and
 * writes it into a `<figcaption>`, and the SVG/HTML path resolves the same
 * reference to the same string. A reference that reads "Figure 3.1" on screen
 * and "Figure 4" in the export is worse than no reference at all, so the rules
 * live here once rather than in each renderer:
 *
 * 1. **The slug** an anchor gets from its text.
 * 2. **Disambiguation** when two headings share a slug.
 * 3. **The label** a counter prints, with or without a section prefix.
 * 4. **Which heading level restarts the counters** (`numbering.restartAt`).
 *
 * What is *not* here is the walk itself. A flow and a React tree visit their
 * nodes differently — one emits items, the other elements — and pretending
 * otherwise would buy a shared traversal at the cost of a shared shape neither
 * wants. The parts that must agree are the four above, and they are total
 * functions of their arguments, so agreement is checkable rather than hoped for.
 */

/**
 * GitHub-style slug, minus the Unicode-aware lowercasing.
 *
 * `toLowerCase()` without an argument uses the *default* case mapping, not the
 * host locale, so it is deterministic (SPEC 24.3 rule 3); `toLocaleLowerCase`
 * would not be — in `tr`, `I` lowercases to `ı`, and the same document would
 * then produce two different anchors on two machines.
 *
 * Empty in, `'section'` out: an anchor has to be *something*, and a heading of
 * nothing but punctuation is still a link target.
 */
export function slugify(text: string): string {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
  return base === '' ? 'section' : base;
}

/**
 * Make `name` unique within `seen`, appending `-1`, `-2`, … as GitHub does.
 *
 * `seen` is the caller's — one map per document — and is mutated: the count it
 * holds is "how many times this slug has been taken", so the first "Overview"
 * keeps the bare slug and the second becomes `overview-1`. Deliberately *not*
 * `overview-2`: matching GitHub means a link copied out of a rendered README
 * still resolves.
 */
export function uniqueSlug(name: string, seen: Map<string, number>): string {
  const used = seen.get(name);
  if (used === undefined) {
    seen.set(name, 0);
    return name;
  }
  const next = used + 1;
  seen.set(name, next);
  return `${name}-${next}`;
}

/**
 * `Figure 3` or `Figure 2.3` — the text a counter prints (SPEC 28.7).
 *
 * The section prefix appears only when there *is* a section: `restartAt` set to
 * `h2` on a document that opens with a figure before its first heading would
 * otherwise print `Figure 0.1`, which names a section the reader cannot find.
 * Pass `section` as `0` to suppress the prefix, which is also what a renderer
 * with no `restartAt` configured passes for every figure in the document.
 *
 * @param word - `'Figure'`, `'Table'`, or whatever the author's `label` said
 * @param n - the counter, already incremented
 * @param section - the enclosing section number, or `0` for no prefix
 */
export function counterLabel(word: string, n: number, section = 0): string {
  return section > 0 ? `${word} ${section}.${n}` : `${word} ${n}`;
}

/**
 * The heading depth that restarts figure and table counters, or `0` for none.
 *
 * `numbering.restartAt` is spelled `'h1'`…`'h6'` (SPEC 28.2). Anything else —
 * unset, `'H2'`, `'section'`, `'h7'` — means "do not restart", because a
 * misspelling that silently restarted at `h1` would renumber every figure in
 * the document, and a misspelling that threw would lose the export over a
 * cosmetic setting.
 */
export function restartLevel(setting: string | undefined): number {
  const match = /^h([1-6])$/.exec(setting ?? '');
  return match === null ? 0 : Number.parseInt(match[1] ?? '1', 10);
}

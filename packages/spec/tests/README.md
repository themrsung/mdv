# The MDV conformance suite

SPEC 16.2. This corpus is **normative** and is versioned with the spec. A claim
of conformance at level *N* means: every case tagged ≤ *N* passes, SVG output
matches byte-for-byte after canonicalisation (SPEC 24.3), and no case produces an
unhandled exception.

## A case is a directory

```
tests/<category>/<type-or-topic>/<case-name>/
  input.mdv           source (required)
  expected.ast.json   canonical AST (SPEC 19), after resolution
  expected.svg        canonical SVG at 800×400, default theme, light
  expected.dark.svg   same, dark theme
  expected.pdf.json   PDF operator trace (not bytes — SPEC 28.10)
  diagnostics.json    expected diagnostics, ordered
  meta.json           { "level": 2, "tags": ["bar", "stack"] }
```

Only `input.mdv` and `meta.json` are required. A case asserts on whichever
`expected.*` files it ships; a missing one means "this case does not pin that
output". A `syntax/` case usually ships `expected.ast.json` and
`diagnostics.json` and no SVG at all.

### `meta.json`

```jsonc
{
  "level": 2,              // conformance level required to pass this case
  "tags": ["bar", "stack"],// free-form selectors
  "note": "optional prose",// why this case exists
  "pin": ["ast", "svg"]    // goldens this case promises to ship
}
```

### `pin`

A case that ships no goldens asserts nothing, and a corpus of them passes every
run. `pin` is the case's promise, written before the output exists: each name in
it — `ast`, `diagnostics`, `svg`, `dark`, `pdf` — is a golden the case will be
held to.

A pinned golden that is missing **fails that check**, with `run pnpm test:update`
as the reason. It is deliberately not a corpus error: the corpus still has to
load for the command that mints the file to run.

Pinning is the one thing `--update` will not do for you. It mints the goldens a
case asks for and refreshes the ones already beside it, so deciding that an
output is worth asserting stays a human edit to `meta.json`.

### `diagnostics.json`

An ordered array of the `Diagnostic` objects (SPEC 14.2) the document must
produce, compared on `code`, `severity`, `source`, and `range`. Order is the
document order of the ranges; ties break by `code`. The `message` and `detail`
strings are **not** compared — they are localisable.

### Canonical AST

SPEC 19: object keys sorted, `position` reduced to `[startOffset, endOffset]`,
floats formatted to 6 significant digits. This is what makes an
`expected.ast.json` diff readable.

## Categories

| Directory   | Covers |
|-------------|--------|
| `syntax/`   | Parsing, degradation, malformed input, round-tripping |
| `data/`     | Formats, type inference, nulls, datasets, transforms, MDVX |
| `encode/`   | Channels, scales, domains, series identity, palette slots |
| `render/`   | Per type, per theme, and the edge cases: empty data, one row, 10 000 rows, extreme aspect ratios, RTL text, CJK labels |
| `a11y/`     | Accessible names, generated descriptions, table views, focus order |
| `security/` | Injection attempts, SSRF, path traversal, resource limits |
| `pdf/`      | Pagination, fonts, tagging, operator traces |
| `perf/`     | Budget cases (SPEC 24.1); asserts timing, not pixels |

## Golden-file policy

SPEC 16.3. Goldens are regenerated **only** by an explicit `pnpm test:update`,
and a regeneration commit **MUST NOT** also contain source changes. That rule is
the only thing that lets a reviewer tell an intentional rendering change from an
accidental one.

`pnpm conformance:update` runs the golden half alone; `--dry-run` lists what it
would write without touching the disk. Three rules keep it from being a way to
make failures disappear:

- it mints only what a case asked for in `pin`, and writes nothing else;
- a case that throws writes nothing, so a crash never quietly erases the golden
  that would have caught it;
- it reports what changed, per file, so the diff is reviewable before it is
  committed.

Neither `--out` nor `--json` may be combined with `--update`: a run that has just
rewritten the corpus cannot also report on it.

## Status

The directory skeleton is in place; the corpus itself is filled in per milestone
(SPEC Appendix F.2 — `syntax/` at M1, `data/` at M2, `render/` L1 at M3, and so
on). `render/bar/stacked-percent/` is present as the worked example from
SPEC 16.2 and carries only `meta.json` until M3 produces its goldens.

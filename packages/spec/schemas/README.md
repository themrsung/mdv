# MDV JSON Schemas

SPEC Appendix D. These schemas are the **single source of truth** for attribute
validation, LSP completion, and the attribute documentation in the spec's
Appendix B. Hand-written validation that disagrees with a schema is a bug in the
validation, not in the schema.

```
schemas/
  common/
    block.json      attributes common to every visual block (SPEC 8.1)
    channel.json    a channel binding (SPEC 7.1); `y: revenue` == `y: {field: revenue}`
    scale.json      scale specification (SPEC 7.2)
    axis.json       axis specification (SPEC 7.3)
    format.json     a number/date format specifier (SPEC 6.9)
    dimension.json  a dimension (SPEC 5.3.3)
  block/
    bar.json        the reference per-type schema, verbatim from Appendix D
    …               one file per block type
```

## Conventions, all load-bearing

- `$id` is `https://mdv.dev/schema/1.0/<path>`; `$ref`s between schemas are
  **relative paths**, so the directory can be served or bundled unchanged.
- Every per-type schema `allOf`-references `../common/block.json` and then adds
  its own channels under `properties`.
- Every schema ends with `"patternProperties": { "^x-": true }` and
  `"unevaluatedProperties": false`. That pair is what makes an unknown attribute
  an `MDV1501` (info, ignored) while keeping extension attributes legal
  (SPEC 15.1).
- Mutual exclusions are expressed in schema, not in code. `bar.json`'s
  `"not": { "required": ["series"], "properties": { "y": {"type": "array"} } }`
  is where `MDV3010` comes from.
- Defaults in `"default"` are **normative** (SPEC 11 preamble: rendering defaults
  are normative). Do not diverge from them in code.

## Status

`block/bar.json` is complete and is the template. The remaining per-type schemas
(SPEC 8.2–8.14) are written by the chart-catalogue work, one file per type, and
must be added here — not inlined into `@mdv/core`.

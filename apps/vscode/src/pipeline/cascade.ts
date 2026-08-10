/**
 * The attribute cascade (SPEC 5.5) and encoding normalisation (SPEC 7.1) —
 * **now a re-export**.
 *
 * This file used to carry the whole implementation, from a time when the
 * preview had to compose the finished parts itself. The core milestone moved
 * that code to `packages/core/src/cascade.ts`, so the implementation lives
 * there and this module is the alias that keeps `pipeline.ts` and
 * `test/cascade.test.ts` importing by path.
 *
 * What matters is that there is exactly **one** cascade in the repo. Two would
 * eventually disagree, and a preview that cascades differently from the library
 * is a bug that only shows up as "the chart looks different in VS Code".
 *
 * ## Why the package root, not a subpath
 *
 * These names were once reachable only as `@mdv/core/cascade.js`, through the
 * `@mdv/core/*` entry in `tsconfig.base.json`'s `paths`. That compiled in-tree
 * and would have broken for a consumer of the published package, whose
 * `exports` map has no such entry. `packages/core/src/index.ts` now
 * `export *`s the cascade, so the import below is the ordinary one and the
 * extension depends on nothing a published `@mdv/core` would not offer.
 */

export {
  CHANNEL_NAMES,
  cascadeAttrs,
  encodingFromAttrs,
  isChannelName,
  mergeAttrs,
} from '@mdv/core';
export type { CascadeInput } from '@mdv/core';

/**
 * The attribute cascade (SPEC 5.5) and encoding normalisation (SPEC 7.1) —
 * **now a re-export**.
 *
 * This file used to carry the whole implementation, because `@mdv/core`'s
 * `resolve()` was a stub and the preview had to compose the finished parts
 * itself rather than throw. The core milestone has since moved that code to
 * `packages/core/src/cascade.ts`, so the implementation lives there and this
 * module is the alias that keeps `pipeline.ts` and `test/cascade.test.ts`
 * importing by path.
 *
 * What matters is that there is exactly **one** cascade in the repo. Two would
 * eventually disagree, and a preview that cascades differently from the library
 * is a bug that only shows up as "the chart looks different in VS Code".
 *
 * ## Why the subpath, not the package root
 *
 * `packages/core/src/index.ts` does not re-export `./cascade.js` yet, so
 * importing these names from `'@mdv/core'` does not compile. The subpath does,
 * through the `@mdv/core/*` entry in `tsconfig.base.json`'s `paths` — the same
 * mechanism `pipeline.ts` already uses for `@mdv/core/resolve.js`. Both should
 * become root imports once core widens its index and its `exports` map; see the
 * "Known gaps" table in this package's README.
 *
 * `resolve()` and `resolveSync()` themselves still throw `not implemented` in
 * this tree, which is why `pipeline.ts` continues to drive the stages by hand
 * instead of making one call.
 */

export {
  CHANNEL_NAMES,
  cascadeAttrs,
  encodingFromAttrs,
  isChannelName,
  mergeAttrs,
} from '@mdv/core/cascade.js';
export type { CascadeInput } from '@mdv/core/cascade.js';

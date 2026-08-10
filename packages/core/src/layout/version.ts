/**
 * The version stamped into `Scene.meta.version` (SPEC 20).
 *
 * Declared here rather than imported from `src/index.ts` so that the layout
 * engine has no import edge back to the package root — the root imports layout,
 * and a cycle through a module that also defines a class would be resolved
 * differently by every bundler.
 *
 * Keep in step with `CORE_VERSION` in `src/index.ts`; the determinism contract
 * (SPEC 24.3: "same source + same config + **same version**") is stated in terms
 * of this string, so a scene that claims the wrong one is a cache-poisoning bug.
 */
export const CORE_LAYOUT_VERSION = '0.0.0';

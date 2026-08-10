/**
 * The chart-type registry, built once per extension activation.
 *
 * SPEC 17.3 invariant 4 forbids global mutable state, and the registry is
 * mutable until it is frozen — so it is created once, seeded with the built-ins,
 * frozen, and thereafter read-only and safe to share between the preview and the
 * diagnostics engine. Two documents rendering concurrently cannot interfere
 * through it.
 */

import type { ChartType, ChartTypeRegistry } from '@mdv/core';
import { createChartRegistry } from '@mdv/core';
import { builtinChartTypes } from '@mdv/charts';

let shared: ChartTypeRegistry | undefined;

/** The frozen registry of built-in chart types. */
export function chartRegistry(): ChartTypeRegistry {
  if (shared === undefined) {
    const registry = createChartRegistry(builtinChartTypes);
    registry.freeze();
    shared = registry;
  }
  return shared;
}

/** Every registered type name, sorted — for the `Insert Chart…` quick pick. */
export function registeredTypes(): readonly ChartType[] {
  return chartRegistry().list();
}

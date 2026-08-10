/**
 * Deterministic resource allocation (SPEC 28.10).
 *
 * Every `/F0`, `/GS3`, `/Sh1`, `/P0`, `/Im2` in the document is handed out by
 * one pool, in first-use order over a fixed traversal. That is the whole trick
 * behind "object numbering (allocation in a fixed traversal order)": names are
 * positional, so two runs that draw the same things in the same order name them
 * identically, and a trace diff points at geometry rather than at renaming.
 *
 * `Map` iteration is insertion order, which is exactly the guarantee SPEC 24.3
 * rule 5 asks for.
 */

import type { Rgba } from './color.js';
import type { FontKey } from './fonts.js';
import { fontKeyId } from './fonts.js';
import { formatNumber, roundTo } from './number.js';
import type { Matrix } from './geometry.js';

/** One stop of a resolved shading. */
export interface ShadingStop {
  offset: number;
  color: Rgba;
}

/** A shading, in the user space that will be current when `sh` runs. */
export interface ShadingSpec {
  kind: 'axial' | 'radial';
  /** `[x0 y0 x1 y1]` for axial, `[cx0 cy0 r0 cx1 cy1 r1]` for radial. */
  coords: readonly number[];
  stops: readonly ShadingStop[];
}

/** A tiling pattern: the texture channel of SPEC 12.6. */
export interface PatternSpec {
  /** Tile box in pattern space. */
  width: number;
  height: number;
  /** Pattern space → default page space. */
  matrix: Matrix;
  /** The tile's content stream, already built. */
  content: string;
  /** Resource names the tile's own content stream refers to. */
  usesGraphicsStates: readonly string[];
}

/** An embedded raster, keyed by its data URL. */
export interface ImageSpec {
  href: string;
  /** `png` or `jpg`; anything else was rejected before it reached the pool. */
  format: 'png' | 'jpg';
  bytes: Uint8Array;
}

/** Transparency: `ca` is the non-stroking alpha, `CA` the stroking one. */
export interface AlphaSpec {
  fill: number;
  stroke: number;
}

/** The document-wide resource pool. */
export class ResourcePool {
  readonly #fonts = new Map<string, { resource: string; key: FontKey }>();
  readonly #alphas = new Map<string, { resource: string; spec: AlphaSpec }>();
  readonly #shadings = new Map<string, { resource: string; spec: ShadingSpec }>();
  readonly #patterns = new Map<string, { resource: string; spec: PatternSpec }>();
  readonly #images = new Map<string, { resource: string; spec: ImageSpec }>();

  /** Resource name for a face, allocating on first use. */
  font(key: FontKey): string {
    const id = fontKeyId(key);
    const existing = this.#fonts.get(id);
    if (existing !== undefined) return existing.resource;
    const resource = `F${String(this.#fonts.size)}`;
    this.#fonts.set(id, { resource, key });
    return resource;
  }

  /**
   * Resource name for a transparency state, or `undefined` when both alphas are
   * fully opaque — the common case, and one that should not cost a `gs`.
   */
  alpha(fill: number, stroke: number): string | undefined {
    const f = roundTo(fill, 3);
    const s = roundTo(stroke, 3);
    if (f >= 1 && s >= 1) return undefined;
    const id = `${formatNumber(f)}/${formatNumber(s)}`;
    const existing = this.#alphas.get(id);
    if (existing !== undefined) return existing.resource;
    const resource = `GS${String(this.#alphas.size)}`;
    this.#alphas.set(id, { resource, spec: { fill: f, stroke: s } });
    return resource;
  }

  /** Resource name for a shading. */
  shading(spec: ShadingSpec): string {
    const id = [
      spec.kind,
      spec.coords.map((c) => formatNumber(c)).join(','),
      spec.stops
        .map(
          (s) =>
            `${formatNumber(s.offset)}:${formatNumber(s.color.r)},${formatNumber(s.color.g)},${formatNumber(s.color.b)},${formatNumber(s.color.a)}`,
        )
        .join(';'),
    ].join('|');
    const existing = this.#shadings.get(id);
    if (existing !== undefined) return existing.resource;
    const resource = `Sh${String(this.#shadings.size)}`;
    this.#shadings.set(id, { resource, spec });
    return resource;
  }

  /** Resource name for a tiling pattern. */
  pattern(id: string, spec: PatternSpec): string {
    const existing = this.#patterns.get(id);
    if (existing !== undefined) return existing.resource;
    const resource = `P${String(this.#patterns.size)}`;
    this.#patterns.set(id, { resource, spec });
    return resource;
  }

  /** Resource name for an embedded raster. */
  image(spec: ImageSpec): string {
    const existing = this.#images.get(spec.href);
    if (existing !== undefined) return existing.resource;
    const resource = `Im${String(this.#images.size)}`;
    this.#images.set(spec.href, { resource, spec });
    return resource;
  }

  /** Faces, in allocation order. */
  get fonts(): readonly { resource: string; key: FontKey }[] {
    return [...this.#fonts.values()];
  }
  /** Transparency states, in allocation order. */
  get alphas(): readonly { resource: string; spec: AlphaSpec }[] {
    return [...this.#alphas.values()];
  }
  /** Shadings, in allocation order. */
  get shadings(): readonly { resource: string; spec: ShadingSpec }[] {
    return [...this.#shadings.values()];
  }
  /** Tiling patterns, in allocation order. */
  get patterns(): readonly { resource: string; spec: PatternSpec }[] {
    return [...this.#patterns.values()];
  }
  /** Rasters, in allocation order. */
  get images(): readonly { resource: string; spec: ImageSpec }[] {
    return [...this.#images.values()];
  }

  /** Every resource name in the pool, sorted — the trace's `resources` field. */
  names(): readonly string[] {
    const all = [
      ...this.fonts.map((f) => f.resource),
      ...this.alphas.map((a) => a.resource),
      ...this.shadings.map((s) => s.resource),
      ...this.patterns.map((p) => p.resource),
      ...this.images.map((i) => i.resource),
    ];
    return all.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  }
}

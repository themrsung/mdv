/**
 * Coordinate precision — **the one place** numbers leaving layout are rounded
 * (SPEC 24.3 rule 4).
 *
 * > Numbers are serialised through one formatter: round-half-even to 3 decimals,
 * > strip trailing zeros, normalise `-0`.
 *
 * Rounding here rather than in each backend's serialiser is what makes the SVG
 * string, the Canvas call sequence and the PDF operator stream describe the same
 * geometry. A backend that rounds independently is a source of divergence, and
 * a scene that carries `12.000000000000002` invites one.
 *
 * Half-even rather than half-up because half-up is biased: a ladder of
 * `.0005` values would drift upward, and a golden file would record the drift.
 */

import type { Def, HitRegion, PathCommand, Scene, SceneNode, Transform } from '../types/scene.js';

/** Decimal places every emitted coordinate is rounded to. */
export const SCENE_DECIMALS = 3;

const SCALE = 10 ** SCENE_DECIMALS;

/**
 * Round one coordinate: half-even to {@link SCENE_DECIMALS}, `-0` normalised
 * to `0`.
 *
 * Non-finite input becomes `0`. A `NaN` coordinate is a bug upstream, but every
 * backend would draw nothing, silently, for the whole node — a zero is at least
 * visible and keeps the scene structurally valid (SPEC 17.3 invariant 3).
 */
export function roundCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const scaled = value * SCALE;
  const floor = Math.floor(scaled);
  const remainder = scaled - floor;
  let rounded: number;
  if (remainder > 0.5) rounded = floor + 1;
  else if (remainder < 0.5) rounded = floor;
  else rounded = floor % 2 === 0 ? floor : floor + 1;
  const result = rounded / SCALE;
  return result === 0 ? 0 : result;
}

/** Round every number of a rectangle-like record. */
export function roundRect<T extends { x: number; y: number; width: number; height: number }>(
  rect: T,
): T {
  return {
    ...rect,
    x: roundCoord(rect.x),
    y: roundCoord(rect.y),
    width: roundCoord(rect.width),
    height: roundCoord(rect.height),
  };
}

/** Round a transform in place-free fashion. */
function roundTransform(transform: Transform): Transform {
  switch (transform.kind) {
    case 'translate':
      return { kind: 'translate', x: roundCoord(transform.x), y: roundCoord(transform.y) };
    case 'scale':
      return { kind: 'scale', x: roundCoord(transform.x), y: roundCoord(transform.y) };
    case 'rotate': {
      const out: Transform = { kind: 'rotate', angle: roundCoord(transform.angle) };
      if (transform.cx !== undefined) out.cx = roundCoord(transform.cx);
      if (transform.cy !== undefined) out.cy = roundCoord(transform.cy);
      return out;
    }
    case 'matrix':
    default:
      return {
        kind: 'matrix',
        a: roundCoord(transform.a),
        b: roundCoord(transform.b),
        c: roundCoord(transform.c),
        d: roundCoord(transform.d),
        e: roundCoord(transform.e),
        f: roundCoord(transform.f),
      };
  }
}

/** Round one structured path command. */
export function roundCommand(command: PathCommand): PathCommand {
  switch (command.c) {
    case 'M':
      return { c: 'M', x: roundCoord(command.x), y: roundCoord(command.y) };
    case 'L':
      return { c: 'L', x: roundCoord(command.x), y: roundCoord(command.y) };
    case 'C':
      return {
        c: 'C',
        x1: roundCoord(command.x1),
        y1: roundCoord(command.y1),
        x2: roundCoord(command.x2),
        y2: roundCoord(command.y2),
        x: roundCoord(command.x),
        y: roundCoord(command.y),
      };
    case 'Q':
      return {
        c: 'Q',
        x1: roundCoord(command.x1),
        y1: roundCoord(command.y1),
        x: roundCoord(command.x),
        y: roundCoord(command.y),
      };
    case 'A':
      return {
        c: 'A',
        rx: roundCoord(command.rx),
        ry: roundCoord(command.ry),
        rotate: roundCoord(command.rotate),
        largeArc: command.largeArc,
        sweep: command.sweep,
        x: roundCoord(command.x),
        y: roundCoord(command.y),
      };
    case 'Z':
    default:
      return { c: 'Z' };
  }
}

/**
 * Round every coordinate in a node tree.
 *
 * Applied to the whole scene at the end of layout, which means it also covers
 * nodes a **chart type** produced. Core cannot ask every plugin to round
 * correctly, so it does not ask: it rounds once, at the boundary.
 */
export function roundNode(node: SceneNode): SceneNode {
  switch (node.kind) {
    case 'group': {
      const out: SceneNode = { ...node, children: node.children.map(roundNode) };
      if (node.transform !== undefined) out.transform = roundTransform(node.transform);
      return out;
    }
    case 'rect':
      return {
        ...node,
        x: roundCoord(node.x),
        y: roundCoord(node.y),
        w: roundCoord(node.w),
        h: roundCoord(node.h),
        ...(node.r === undefined
          ? {}
          : {
              r: Array.isArray(node.r)
                ? ([
                    roundCoord(node.r[0]),
                    roundCoord(node.r[1]),
                    roundCoord(node.r[2]),
                    roundCoord(node.r[3]),
                  ] as [number, number, number, number])
                : roundCoord(node.r),
            }),
      };
    case 'line':
      return {
        ...node,
        x1: roundCoord(node.x1),
        y1: roundCoord(node.y1),
        x2: roundCoord(node.x2),
        y2: roundCoord(node.y2),
      };
    case 'path':
      return { ...node, d: node.d.map(roundCommand) };
    case 'circle':
      return { ...node, cx: roundCoord(node.cx), cy: roundCoord(node.cy), r: roundCoord(node.r) };
    case 'text': {
      const out: SceneNode = { ...node, x: roundCoord(node.x), y: roundCoord(node.y) };
      if (node.width !== undefined) out.width = roundCoord(node.width);
      if (node.rotate !== undefined) out.rotate = roundCoord(node.rotate);
      return out;
    }
    case 'image':
      return {
        ...node,
        x: roundCoord(node.x),
        y: roundCoord(node.y),
        w: roundCoord(node.w),
        h: roundCoord(node.h),
      };
    case 'use':
    default: {
      const out: SceneNode = { ...node };
      if (node.x !== undefined) out.x = roundCoord(node.x);
      if (node.y !== undefined) out.y = roundCoord(node.y);
      if (node.transform !== undefined) out.transform = roundTransform(node.transform);
      return out;
    }
  }
}

/** Round a def's geometry. Stops and colours are untouched. */
export function roundDef(def: Def): Def {
  switch (def.kind) {
    case 'linear-gradient':
      return {
        ...def,
        x1: roundCoord(def.x1),
        y1: roundCoord(def.y1),
        x2: roundCoord(def.x2),
        y2: roundCoord(def.y2),
        stops: def.stops.map((stop) => ({ ...stop, offset: roundCoord(stop.offset) })),
      };
    case 'radial-gradient':
      return {
        ...def,
        cx: roundCoord(def.cx),
        cy: roundCoord(def.cy),
        r: roundCoord(def.r),
        stops: def.stops.map((stop) => ({ ...stop, offset: roundCoord(stop.offset) })),
      };
    case 'pattern':
      return {
        ...def,
        width: roundCoord(def.width),
        height: roundCoord(def.height),
        angle: roundCoord(def.angle),
        content: def.content.map(roundNode),
      };
    case 'clip':
      return { ...def, path: def.path.map(roundCommand) };
    case 'symbol':
    default:
      return { ...def, node: roundNode(def.node) };
  }
}

/** Round a hit region, including its anchor. */
export function roundHitRegion(region: HitRegion): HitRegion {
  return {
    ...region,
    x: roundCoord(region.x),
    y: roundCoord(region.y),
    w: roundCoord(region.w),
    h: roundCoord(region.h),
    anchor: { x: roundCoord(region.anchor.x), y: roundCoord(region.anchor.y) },
  };
}

/**
 * Round an entire scene.
 *
 * The last thing `layoutBlock` does. Two runs over the same input now differ in
 * no digit, which is the whole of SPEC 24.3 for geometry.
 */
export function roundScene(scene: Scene): Scene {
  const root = roundNode(scene.root);
  return {
    ...scene,
    width: roundCoord(scene.width),
    height: roundCoord(scene.height),
    defs: scene.defs.map(roundDef),
    root: root.kind === 'group' ? root : scene.root,
    hitIndex: scene.hitIndex.map(roundHitRegion),
  };
}

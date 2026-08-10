/**
 * Hand-built scenes for the SVG backend's tests.
 *
 * Everything here is written by hand rather than produced by layout: this
 * package is tested in isolation (CONTRACTS §4), and a fixture that came out of
 * `@mdv/core` would test core's arithmetic instead of this backend's
 * serialisation. Hand-built also means the expected bytes can be reasoned about
 * directly, which is the whole point of a golden file.
 *
 * The scenes are deliberately ugly — negative coordinates, half-pixel values,
 * per-corner radii, hostile text — because that is where a serialiser breaks.
 */

import type {
  A11yTree,
  CircleNode,
  Def,
  Font,
  GroupNode,
  HitRegion,
  ImageNode,
  LineNode,
  PathNode,
  RectNode,
  Scene,
  SceneNode,
  TextNode,
  UseNode,
} from '@mdv/core';

/** The one family in the default theme (SPEC 11.1). */
export const FONT: Font = { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12 };

/** A minimal but complete a11y tree; `table` is required by the contract. */
export function a11y(overrides: Partial<A11yTree> = {}): A11yTree {
  return {
    role: 'img',
    name: 'Revenue by quarter',
    desc: 'A bar chart of revenue for four quarters.',
    descGenerated: true,
    table: {
      caption: 'Revenue by quarter',
      columns: [
        { name: 'Quarter', type: 'string', align: 'left' },
        // Quantities are right-aligned so the digits line up (SPEC 12.3).
        { name: 'Revenue', type: 'number', align: 'right' },
      ],
      rows: [
        ['Q1', '1,200'],
        ['Q2', '1,850'],
      ],
      presentation: 'details',
    },
    focusOrder: ['r0', 'r1'],
    ...overrides,
  };
}

/** A hit region with the fields the overlay reads. */
export function hit(id: string, overrides: Partial<HitRegion> = {}): HitRegion {
  return {
    id,
    x: 10,
    y: 20,
    w: 24,
    h: 24,
    anchor: { x: 22, y: 20 },
    datumIndex: 0,
    readout: [{ label: 'Revenue', value: '1,200' }],
    ...overrides,
  };
}

/** Wrap nodes in the root group a `Scene` requires. */
export function root(children: SceneNode[], overrides: Partial<GroupNode> = {}): GroupNode {
  return { kind: 'group', children, ...overrides };
}

/** Assemble a scene around a root group. */
export function scene(overrides: Partial<Scene> = {}): Scene {
  return {
    width: 320,
    height: 180,
    defs: [],
    root: root([]),
    a11y: a11y(),
    hitIndex: [],
    meta: { blockId: 'mdv-0', type: 'bar', theme: 'default', version: '1.0-draft.1' },
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// One node of every kind (SPEC 20)
// ─────────────────────────────────────────────────────────────────────────────

export const RECT: RectNode = {
  kind: 'rect',
  id: 'bar-0',
  cls: 'mdv-mark mdv-bar',
  x: 12,
  y: 40.5,
  w: 24,
  h: 100.25,
  // Rounded at the data end, square at the baseline (SPEC 11.4).
  r: [4, 4, 0, 0],
  fill: { kind: 'solid', color: '#2a78d6' },
};

export const PLAIN_RECT: RectNode = {
  kind: 'rect',
  x: 0,
  y: 0,
  w: 10,
  h: 10,
  fill: { kind: 'solid', color: '#2a78d6', opacity: 0.5 },
};

export const LINE: LineNode = {
  kind: 'line',
  cls: 'mdv-grid',
  x1: 0,
  y1: 0.5,
  x2: 320,
  y2: 0.5,
  // Gridlines are a 1 px solid hairline, never dashed (SPEC 11.4).
  stroke: { paint: { kind: 'solid', color: '#e1e0d9' }, width: 1 },
};

export const PATH: PathNode = {
  kind: 'path',
  cls: 'mdv-line',
  d: [
    { c: 'M', x: 0, y: 100 },
    { c: 'L', x: 40, y: 60 },
    { c: 'C', x1: 60, y1: 40, x2: 80, y2: 40, x: 100, y: 60 },
    { c: 'Q', x1: 120, y1: 80, x: 140, y: 70 },
    { c: 'A', rx: 10, ry: 10, rotate: 0, largeArc: true, sweep: false, x: 160, y: 70 },
    { c: 'Z' },
  ],
  stroke: { paint: { kind: 'solid', color: '#2a78d6' }, width: 2, cap: 'round', join: 'round' },
};

export const CIRCLE: CircleNode = {
  kind: 'circle',
  cx: 160,
  cy: 90,
  r: 4,
  fill: { kind: 'solid', color: '#eb6834' },
  // The 2 px surface ring (SPEC 11.4).
  stroke: { paint: { kind: 'solid', color: '#fcfcfb' }, width: 2 },
};

export const TEXT: TextNode = {
  kind: 'text',
  x: 8,
  y: 16,
  text: 'Q1',
  font: FONT,
  fill: { kind: 'solid', color: '#0b0b0b' },
  anchor: 'middle',
  baseline: 'middle',
  width: 14.5,
  tabular: true,
};

export const ROTATED_TEXT: TextNode = {
  kind: 'text',
  x: 40,
  y: 170,
  text: 'Long category label',
  font: { ...FONT, weight: 600, style: 'italic', letterSpacing: 0.2 },
  fill: { kind: 'solid', color: '#898781' },
  anchor: 'end',
  baseline: 'alphabetic',
  rotate: -45,
};

export const IMAGE: ImageNode = {
  kind: 'image',
  x: 4,
  y: 4,
  w: 32,
  h: 32,
  href: 'https://example.com/logo.png',
  alt: 'Logo',
};

export const USE: UseNode = {
  kind: 'use',
  ref: 'dot',
  x: 100,
  y: 50,
  fill: { kind: 'solid', color: '#1baf7a' },
};

/** Every def kind, including a 45° texture tile (SPEC 12.6). */
export const DEFS: Def[] = [
  {
    kind: 'linear-gradient',
    id: 'grad-l',
    x1: 0,
    y1: 0,
    x2: 1,
    y2: 0,
    stops: [
      { offset: 0, color: '#cde2fb' },
      { offset: 1, color: '#0d366b', opacity: 0.9 },
    ],
  },
  {
    kind: 'radial-gradient',
    id: 'grad-r',
    cx: 0.5,
    cy: 0.5,
    r: 0.5,
    units: 'userSpace',
    stops: [{ offset: 0.25, color: '#ffffff' }],
  },
  {
    kind: 'pattern',
    id: 'tex-45',
    width: 6,
    height: 6,
    angle: 45,
    content: [
      {
        kind: 'line',
        x1: 0,
        y1: 0,
        x2: 0,
        y2: 6,
        stroke: { paint: { kind: 'solid', color: '#2a78d6' }, width: 1.5 },
      },
    ],
  },
  {
    kind: 'clip',
    id: 'plot',
    path: [
      { c: 'M', x: 0, y: 0 },
      { c: 'L', x: 320, y: 0 },
      { c: 'L', x: 320, y: 180 },
      { c: 'L', x: 0, y: 180 },
      { c: 'Z' },
    ],
  },
  { kind: 'symbol', id: 'dot', node: { kind: 'circle', cx: 0, cy: 0, r: 4 } },
];

/** A scene exercising every node kind, every def kind and the hit overlay. */
export function kitchenSink(): Scene {
  return scene({
    background: { kind: 'solid', color: '#fcfcfb' },
    defs: DEFS,
    root: root(
      [
        LINE,
        RECT,
        PLAIN_RECT,
        PATH,
        CIRCLE,
        TEXT,
        ROTATED_TEXT,
        IMAGE,
        USE,
        {
          kind: 'group',
          id: 'plot',
          cls: 'mdv-plot',
          transform: { kind: 'translate', x: 40, y: 8 },
          clip: 'plot',
          opacity: 0.9,
          role: 'graphics-object',
          label: 'Plot area',
          children: [
            {
              kind: 'rect',
              x: 0,
              y: 0,
              w: 4,
              h: 4,
              fill: { kind: 'gradient', def: 'grad-l' },
            },
            {
              kind: 'rect',
              x: 8,
              y: 0,
              w: 4,
              h: 4,
              fill: { kind: 'pattern', def: 'tex-45', background: '#2a78d6' },
            },
          ],
        },
      ],
      { id: 'root', cls: 'mdv-scene' },
    ),
    hitIndex: [
      hit('r0', { seriesId: 'Revenue', group: 'Revenue', markNodeId: 'bar-0' }),
      hit('r1', {
        x: 40,
        seriesId: 'Cost',
        group: 'Cost',
        datumIndex: 1,
        readout: [
          { label: 'Cost', value: '900', swatch: '#eb6834', emphasis: true },
          { label: '', value: 'Q2' },
        ],
      }),
    ],
  });
}

/**
 * Built-in themes, custom-theme resolution (SPEC 11.6), colour-scheme selection
 * (SPEC 11.7), ramps (SPEC 11.3) and the texture channel (SPEC 12.6).
 */

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEME_NAMES,
  CATEGORICAL_ANGLES,
  MARK_SPEC,
  SCHEME_SURFACE,
  SEQUENTIAL_BLUE,
  STATUS_PALETTE,
  categoricalTexture,
  categoricalTextures,
  contrastRatio,
  divergingTexture,
  generateDiverging,
  generateSequential,
  generateSequentialSteps,
  getBuiltinTheme,
  labelOnFill,
  listBuiltinThemes,
  ordinalBounds,
  paletteDiagnosticMessages,
  parseColor,
  resolveColorScheme,
  resolveTheme,
  revalidate,
  sequentialTexture,
  texturePaint,
  themeByName,
  themeFileFormat,
  themeFromText,
  themeFromValue,
  toOklch,
  toneOnTone,
} from '../src/index.js';
import type { PaletteValidation, ThemeOverride } from '../src/index.js';

describe('SPEC 11.1 — theme tokens', () => {
  it('ships the light table verbatim', () => {
    const t = getBuiltinTheme('default');
    expect(t.tokens).toEqual({
      surface: '#fcfcfb',
      page: '#f9f9f7',
      'text-primary': '#0b0b0b',
      'text-secondary': '#52514e',
      'text-muted': '#898781',
      grid: '#e1e0d9',
      axis: '#c3c2b7',
      border: 'rgba(11,11,11,0.10)',
      'success-text': '#006300',
    });
  });

  it('ships the dark table verbatim, and it is not an inversion of light', () => {
    const dark = getBuiltinTheme('dark');
    expect(dark.tokens.surface).toBe('#1a1a19');
    expect(dark.tokens.page).toBe('#0d0d0d');
    expect(dark.tokens.grid).toBe('#2c2c2a');
    // `text-muted` is the same value in both modes — an inversion could not
    // produce that, and it is the cheapest proof the palette was selected.
    expect(dark.tokens['text-muted']).toBe(getBuiltinTheme('default').tokens['text-muted']);
  });

  it('uses one family for everything, with no display or serif face', () => {
    for (const t of listBuiltinThemes()) {
      expect(t.type.fontFamily).toBe('system-ui, -apple-system, "Segoe UI", sans-serif');
    }
  });

  it('ships radius 4, hairline 1, gap 2, ring 2', () => {
    expect(getBuiltinTheme('default').metrics).toEqual({ radius: 4, hairline: 1, gap: 2, ring: 2 });
  });

  it('meets 4.5:1 for primary text and 3:1 for secondary in both modes', () => {
    for (const name of ['default', 'dark'] as const) {
      const t = getBuiltinTheme(name);
      expect(contrastRatio(t.tokens['text-primary'], t.tokens.surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(t.tokens['text-secondary'], t.tokens.surface)).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('SPEC 11.4 — mark specifications', () => {
  it('are fixed across every chart type and every theme', () => {
    for (const t of listBuiltinThemes()) expect(t.marks).toBe(MARK_SPEC);
  });

  it('cap bars at 24 px, round the data end at 4 px, and keep the baseline square', () => {
    expect(MARK_SPEC.bar).toEqual({ maxThickness: 24, cornerRadius: 4, squareAtBaseline: true });
  });

  it('never dash a gridline', () => {
    expect(MARK_SPEC.grid.dashed).toBe(false);
  });

  it('specify both spacers at 2 px — white does the separating', () => {
    expect(MARK_SPEC.spacer).toEqual({ surfaceGap: 2, surfaceRing: 2 });
  });

  it('keep the area fill a wash, not a block', () => {
    expect(MARK_SPEC.area.fillOpacity).toBeCloseTo(0.1, 6);
  });
});

describe('the built-in registry', () => {
  it('lists exactly the four names of SPEC 11.6, sorted', () => {
    expect(BUILTIN_THEME_NAMES).toEqual(['dark', 'default', 'high-contrast', 'print']);
    expect(listBuiltinThemes().map((t) => t.name)).toEqual([...BUILTIN_THEME_NAMES]);
  });

  it('returns a shared frozen instance, so identity checks are usable', () => {
    expect(getBuiltinTheme('default')).toBe(getBuiltinTheme('default'));
    expect(Object.isFrozen(getBuiltinTheme('default'))).toBe(true);
  });

  it('rejects an unknown name with the list of legal ones', () => {
    expect(() => themeByName('solarized', 'light')).toThrow(/dark, default, high-contrast, print/);
  });
});

describe('SPEC 11.3 — sequential ramps', () => {
  it('derives the ordinal floor of the default ramp as step 250 on light', () => {
    const { ordinalFloor } = ordinalBounds(SEQUENTIAL_BLUE, SCHEME_SURFACE.light);
    expect(ordinalFloor).toBe(3);
    expect(SEQUENTIAL_BLUE[ordinalFloor]).toBe('#86b6ef');
  });

  it('derives the ordinal ceiling of the default ramp as step 600 on dark', () => {
    const { ordinalCeiling } = ordinalBounds(SEQUENTIAL_BLUE, SCHEME_SURFACE.dark);
    expect(ordinalCeiling).toBe(10);
    expect(SEQUENTIAL_BLUE[ordinalCeiling]).toBe('#184f95');
  });

  it('generates a monotone one-hue ramp, light → dark', () => {
    const steps = generateSequentialSteps('#2a78d6', 13);
    expect(steps).toHaveLength(13);
    // Contrast against white rising monotonically ⇔ lightness falling monotonically.
    const ratios = steps.map((s) => contrastRatio(s, '#ffffff'));
    for (let i = 1; i < ratios.length; i += 1) {
      expect(ratios[i] ?? 0).toBeGreaterThan(ratios[i - 1] ?? 0);
    }
  });

  it('holds the hue fixed across the ramp — never a rainbow', () => {
    const steps = generateSequentialSteps('#2a78d6', 9);
    const hues = steps.map((s) => toOklch(s).h);
    const anchor = toOklch('#2a78d6').h;
    for (const h of hues) {
      // Gamut mapping only ever reduces chroma, so hue must not move. A couple
      // of degrees of slack absorbs 8-bit quantisation at the pale end.
      expect(Math.abs(h - anchor)).toBeLessThan(3);
    }
  });

  it('is deterministic', () => {
    expect(generateSequentialSteps('#eb6834', 7)).toEqual(generateSequentialSteps('#eb6834', 7));
  });

  it('assembles a palette with usable ordinal bounds', () => {
    const p = generateSequential('#eb6834', 13, SCHEME_SURFACE.light);
    expect(p.steps).toHaveLength(13);
    expect(p.ordinalFloor).toBeLessThanOrEqual(p.ordinalCeiling);
    expect(
      contrastRatio(p.steps[p.ordinalFloor] ?? '', SCHEME_SURFACE.light),
    ).toBeGreaterThanOrEqual(2);
  });
});

describe('SPEC 11.3 — diverging ramps', () => {
  it('has a neutral gray midpoint, never a hue', () => {
    for (const t of listBuiltinThemes()) {
      const mid = parseColor(t.diverging.mid);
      const spread = Math.max(mid.r, mid.g, mid.b) - Math.min(mid.r, mid.g, mid.b);
      expect(spread).toBeLessThan(0.05);
    }
  });

  it('gives both arms equal step counts', () => {
    for (const t of listBuiltinThemes()) {
      expect(t.diverging.lowSteps).toHaveLength(t.diverging.highSteps.length);
    }
  });

  it('reads left to right: lowSteps starts at the low extreme, highSteps ends at the high', () => {
    const d = getBuiltinTheme('default').diverging;
    expect(d.lowSteps[0]).toBe(d.low);
    expect(d.highSteps[d.highSteps.length - 1]).toBe(d.high);
  });

  it('never sweeps a third hue through the midpoint', () => {
    // The failure this guards against: interpolating hue *from* a faintly-tinted
    // gray turns blue↔red into blue→cyan→green→gray→olive→red.
    const d = generateDiverging('#2a78d6', '#e34948', '#f0efec', 6);
    for (const s of d.lowSteps) {
      const c = parseColor(s);
      expect(c.b).toBeGreaterThanOrEqual(c.r);
    }
    for (const s of d.highSteps) {
      const c = parseColor(s);
      expect(c.r).toBeGreaterThanOrEqual(c.b);
    }
  });

  it('approaches the midpoint monotonically in chroma', () => {
    const d = generateDiverging('#2a78d6', '#e34948', '#f0efec', 6);
    const chroma = (hex: string): number => {
      const c = parseColor(hex);
      return Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b);
    };
    const towardsMid = d.highSteps.map(chroma);
    for (let i = 1; i < towardsMid.length; i += 1) {
      expect(towardsMid[i] ?? 0).toBeGreaterThan((towardsMid[i - 1] ?? 0) - 1e-9);
    }
  });
});

describe('SPEC 11.6 — custom themes', () => {
  it('resolves the example from the spec', () => {
    const override: ThemeOverride = {
      extends: 'default',
      tokens: { surface: '#ffffff', 'text-primary': '#111827' },
      categorical: ['#2563eb', '#f97316', '#059669'],
      sequential: { hue: '#2563eb', steps: 13 },
      diverging: { low: '#2563eb', high: '#dc2626', mid: '#f3f4f6' },
      font: { family: 'Inter, system-ui, sans-serif', size: 13 },
    };
    const t = resolveTheme(override, 'light');
    expect(t.tokens.surface).toBe('#ffffff');
    expect(t.tokens['text-primary']).toBe('#111827');
    expect(t.tokens.page).toBe('#f9f9f7'); // inherited
    expect(t.categorical).toEqual(['#2563eb', '#f97316', '#059669']);
    expect(t.sequential.steps).toHaveLength(13);
    expect(t.diverging.mid).toBe('#f3f4f6');
    expect(t.type.fontFamily).toBe('Inter, system-ui, sans-serif');
    expect(t.marks).toBe(MARK_SPEC);
    expect(t.status).toBe(STATUS_PALETTE);
  });

  it('always re-validates the palette, against the *resulting* surface', () => {
    // Overriding only the surface must re-check a palette the author did not touch.
    const t = resolveTheme({ extends: 'default', tokens: { surface: '#1a1a19' } }, 'light');
    expect(t.validation).toBeDefined();
    expect(t.validation).toEqual(revalidate(t));
    // Light slots on a dark surface: the relief set is different from default's.
    expect(t.validation?.reliefRequiredSlots).not.toEqual(
      getBuiltinTheme('default').validation?.reliefRequiredSlots,
    );
  });

  it('reports an unreadable custom palette rather than accepting it', () => {
    const t = resolveTheme({ categorical: ['#2a78d6', '#2c7ad8'] }, 'light');
    expect(t.validation?.passed).toBe(false);
    expect(t.validation?.findings.some((f) => f.level === 'fail')).toBe(true);
  });

  it('defaults `extends` to the scheme in force', () => {
    expect(resolveTheme({}, 'dark').categorical).toEqual(getBuiltinTheme('dark').categorical);
    expect(resolveTheme({}, 'light').categorical).toEqual(getBuiltinTheme('default').categorical);
  });

  it('inherits the base scheme when extending explicitly', () => {
    expect(resolveTheme({ extends: 'dark' }, 'light').scheme).toBe('dark');
  });

  it('rejects an unknown base, an unparseable colour and an empty palette', () => {
    expect(() => resolveTheme({ extends: 'nope' }, 'light')).toThrow(/Unknown theme/);
    expect(() => resolveTheme({ tokens: { surface: 'chartrouse' } }, 'light')).toThrow(
      /tokens\.surface/,
    );
    expect(() => resolveTheme({ categorical: [] }, 'light')).toThrow(/at least one slot/);
    expect(() => resolveTheme({ sequential: { hue: '#2a78d6', steps: 1 } }, 'light')).toThrow(
      /at least 2/,
    );
  });

  it('is deterministic', () => {
    const o: ThemeOverride = { categorical: ['#2563eb', '#f97316', '#059669'] };
    expect(resolveTheme(o, 'light')).toEqual(resolveTheme(o, 'light'));
  });
});

describe('SPEC 11.6 — reading a theme file', () => {
  /** Every rejection message, joined, so a test can assert on one string. */
  const why = (value: unknown): string => themeFromValue(value, 'light').errors.join('\n');

  it('accepts the spec’s example as untyped data and resolves it', () => {
    const result = themeFromValue(
      {
        extends: 'default',
        tokens: { surface: '#ffffff', 'text-primary': '#111827' },
        categorical: ['#2563eb', '#f97316', '#059669'],
        sequential: { hue: '#2563eb', steps: 13 },
        diverging: { low: '#2563eb', high: '#dc2626', mid: '#f3f4f6' },
        font: { family: 'Inter, system-ui, sans-serif', size: 13 },
      },
      'light',
    );
    expect(result.errors).toEqual([]);
    expect(result.theme).toEqual(
      resolveTheme(
        {
          extends: 'default',
          tokens: { surface: '#ffffff', 'text-primary': '#111827' },
          categorical: ['#2563eb', '#f97316', '#059669'],
          sequential: { hue: '#2563eb', steps: 13 },
          diverging: { low: '#2563eb', high: '#dc2626', mid: '#f3f4f6' },
          font: { family: 'Inter, system-ui, sans-serif', size: 13 },
        },
        'light',
      ),
    );
  });

  it('resolves against the scheme in force when the file does not say', () => {
    expect(themeFromValue({ font: { size: 13 } }, 'dark').theme?.scheme).toBe('dark');
    expect(themeFromValue({ font: { size: 13 } }, 'light').theme?.scheme).toBe('light');
    // …and the file wins when it does say.
    expect(themeFromValue({ extends: 'dark' }, 'light').theme?.scheme).toBe('dark');
  });

  it('reports a failing palette as warnings and still returns the theme', () => {
    // SPEC 11.6 asks for MDV3080 warnings, not for a refusal: swapping in a
    // different palette would silently redraw the author's chart.
    const result = themeFromValue({ categorical: ['#2a78d6', '#2c7ad8'] }, 'light');
    expect(result.errors).toEqual([]);
    expect(result.theme).toBeDefined();
    expect(result.validation?.passed).toBe(false);
    expect(result.warnings.length).toBeGreaterThan(0);
    // Every warning is one of the validator's own messages, unedited.
    const all = paletteDiagnosticMessages(result.validation as PaletteValidation);
    for (const warning of result.warnings) expect(all).toContain(warning);
  });

  it('warns about failures only — not about the base palette’s relief rule', () => {
    // `default`'s own palette carries three `warn`-level relief findings. A file
    // whose only line is a new surface must not be blamed for them.
    const result = themeFromValue({ tokens: { surface: '#ffffff' } }, 'light');
    expect(result.validation?.passed).toBe(true);
    expect(result.validation?.findings.length).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
    // The obligation is still reachable, per slot, for the host to apply.
    expect(result.validation?.reliefRequiredSlots.length).toBeGreaterThan(0);
  });

  it('rejects a file that is not a mapping', () => {
    expect(why(null)).toMatch(/must be a mapping.*not null/);
    expect(why([1, 2])).toMatch(/not a list/);
    expect(why('./other.yaml')).toMatch(/not the string "\.\/other\.yaml"/);
    expect(why(7)).toMatch(/not the number 7/);
  });

  it('rejects a file that sets nothing — it is the wrong file, not an empty theme', () => {
    expect(why({})).toMatch(/at least one of/);
    // A comment-only YAML file parses to null, which is the same mistake.
    expect(why(null)).not.toBe('');
  });

  it('names the key and the type it wanted for every malformed field', () => {
    expect(why({ extends: 3 })).toMatch(/theme\.extends must be a string/);
    expect(why({ scheme: 'sepia' })).toMatch(/theme\.scheme must be "light" or "dark"/);
    expect(why({ tokens: [] })).toMatch(/theme\.tokens must be a mapping/);
    expect(why({ tokens: { surface: 3 } })).toMatch(/theme\.tokens\.surface must be a colour/);
    expect(why({ tokens: { srface: '#fff' } })).toMatch(
      /theme\.tokens\.srface is not a colour role/,
    );
    expect(why({ categorical: {} })).toMatch(/theme\.categorical must be a list/);
    expect(why({ categorical: ['#fff', 3] })).toMatch(/theme\.categorical\[1\]/);
    expect(why({ sequential: {} })).toMatch(/theme\.sequential\.hue is required/);
    expect(why({ sequential: { hue: '#2563eb', steps: '13' } })).toMatch(
      /theme\.sequential\.steps must be a number/,
    );
    expect(why({ diverging: { low: '#2563eb' } })).toMatch(/both `low` and `high`/);
    expect(why({ font: { size: 0 } })).toMatch(/theme\.font\.size must be a positive number/);
    expect(why({ metrics: { gap: -1 } })).toMatch(/theme\.metrics\.gap must be a non-negative/);
  });

  it('reports every problem in the file, not just the first', () => {
    const result = themeFromValue({ extends: 3, scheme: 'sepia', categorical: {} }, 'light');
    expect(result.errors).toHaveLength(3);
    expect(result.theme).toBeUndefined();
  });

  it('passes `resolveTheme`’s own refusals through unedited', () => {
    // Shape-valid, meaning-invalid: the message must still name the key.
    expect(why({ extends: 'nope' })).toMatch(/Unknown theme/);
    expect(why({ tokens: { surface: 'chartrouse' } })).toMatch(/tokens\.surface/);
    expect(why({ categorical: [] })).toMatch(/at least one slot/);
    expect(why({ sequential: { hue: '#2a78d6', steps: 1 } })).toMatch(/at least 2/);
  });

  it('never throws, whatever it is handed', () => {
    const hostile: unknown[] = [
      undefined,
      Number.NaN,
      () => 1,
      Object.create(null),
      { tokens: Object.create(null) },
      { categorical: new Array<string>(3) },
      { metrics: { gap: Number.POSITIVE_INFINITY } },
      { font: { size: Number.NaN } },
      { __proto__: { categorical: ['#fff'] } },
      JSON.parse('{"tokens":{"__proto__":"#fff"}}'),
    ];
    for (const value of hostile) {
      expect(() => themeFromValue(value, 'light')).not.toThrow();
      const result = themeFromValue(value, 'light');
      // The contract: errors is non-empty exactly when there is no theme.
      expect(result.errors.length === 0).toBe(result.theme !== undefined);
    }
  });

  it('is deterministic', () => {
    const value = { categorical: ['#2563eb', '#f97316', '#059669'] };
    expect(themeFromValue(value, 'light')).toEqual(themeFromValue(value, 'light'));
  });
});

describe('SPEC 11.6 — a theme file’s text', () => {
  it('tells a path from a built-in name by its extension', () => {
    expect(themeFileFormat('corporate.json')).toBe('json');
    expect(themeFileFormat('./themes/Corporate.JSONC')).toBe('jsonc');
    expect(themeFileFormat('corporate.yaml')).toBe('yaml');
    expect(themeFileFormat('/abs/corporate.yml')).toBe('yaml');
    // A built-in name is not a path, and neither is something that only looks
    // like one — the caller falls back to a name lookup and says so if it fails.
    for (const name of ['dark', 'high-contrast', 'default', 'theme.txt', 'v1.0']) {
      expect(themeFileFormat(name), name).toBeUndefined();
    }
  });

  it('reads the same theme from JSON and from YAML', () => {
    const json = themeFromText(
      '{"extends":"dark","categorical":["#2563eb","#f97316","#059669"]}',
      'light',
      'json',
    );
    const yaml = themeFromText(
      'extends: dark\ncategorical:\n  - "#2563eb"\n  - "#f97316"\n  - "#059669"\n',
      'light',
      'yaml',
    );
    expect(json.errors).toEqual([]);
    expect(json.theme).toEqual(yaml.theme);
  });

  it('takes `#rrggbb` as a colour in YAML, not as a comment', () => {
    // Unquoted `#2563eb` *is* a comment in YAML, and an author who writes it
    // that way gets an empty value rather than a colour. The message has to be
    // about the key, not about the parser.
    const quoted = themeFromText('tokens:\n  surface: "#101010"\n', 'light', 'yaml');
    expect(quoted.theme?.tokens.surface).toBe('#101010');
    const bare = themeFromText('tokens:\n  surface: #101010\n', 'light', 'yaml');
    expect(bare.theme).toBeUndefined();
    expect(bare.errors.join('\n')).toMatch(/tokens\.surface must be a colour string/);
  });

  it('locates a YAML syntax error by line and column', () => {
    const result = themeFromText('extends: default\ntokens:\n  surface: "#fff\n', 'light', 'yaml');
    expect(result.theme).toBeUndefined();
    // Line 4, not line 3: an unterminated quote is reported where it ran out,
    // which is the end of the file. Still a place to put a cursor.
    expect(result.errors[0]).toMatch(/^YAML syntax error at line 4, column 1: /);
    expect(result.errors[0]).toMatch(/quote/i);
  });

  it('refuses a comment in JSON, and says where to put one instead', () => {
    const jsonc = '{\n  // brand blue\n  "categorical": ["#2563eb"]\n}';
    const result = themeFromText(jsonc, 'light', 'json');
    expect(result.theme).toBeUndefined();
    expect(result.errors[0]).toMatch(/^JSON syntax error: /);
    expect(result.errors[0]).toMatch(/JSON has no comments/);
    // Why JSON is read by `JSON.parse` and not by the YAML superset: YAML takes
    // the same text without complaint, folds `// brand blue` into the key next
    // to it, and loses the palette. The author is told they set nothing — and
    // is left staring at a file that plainly sets something.
    expect(themeFromText(jsonc, 'light', 'yaml').errors.join('\n')).toMatch(
      /must set at least one of/,
    );
  });

  it('does not mistake a URL in a string for a comment', () => {
    const result = themeFromText('{"font":{"family":"see https://x.test/f"},}', 'light', 'json');
    expect(result.errors[0]).toMatch(/^JSON syntax error: /);
    expect(result.errors[0]).not.toMatch(/JSON has no comments/);
  });

  it('rejects an empty file in either format', () => {
    expect(themeFromText('', 'light', 'json').errors).toHaveLength(1);
    // YAML reads an empty document as null, which is not a mapping.
    expect(themeFromText('\n# nothing here\n', 'light', 'yaml').errors.join('\n')).toMatch(
      /must be a mapping/,
    );
  });

  it('never throws, whatever the bytes are', () => {
    const hostile = [
      '  ',
      '['.repeat(500),
      'a: &x [*x]\n',
      '{"categorical":',
      '﻿{"extends":"dark"}',
      '- '.repeat(5000),
    ];
    for (const text of hostile) {
      for (const format of ['json', 'yaml'] as const) {
        const label = `${format}:${text.slice(0, 12)}`;
        expect(() => themeFromText(text, 'light', format), label).not.toThrow();
        const result = themeFromText(text, 'light', format);
        expect(result.errors.length === 0, label).toBe(result.theme !== undefined);
      }
    }
  });
});

describe('SPEC 11.7 — colour-scheme selection', () => {
  it('follows block, then document, then embedder, then the host', () => {
    expect(
      resolveColorScheme({ block: 'light', document: 'dark', embedder: 'dark', prefersDark: true }),
    ).toBe('light');
    expect(resolveColorScheme({ document: 'dark', embedder: 'light', prefersDark: false })).toBe(
      'dark',
    );
    expect(resolveColorScheme({ embedder: 'dark', prefersDark: false })).toBe('dark');
    expect(resolveColorScheme({ prefersDark: true })).toBe('dark');
  });

  it('lets `auto` fall through to the next level', () => {
    expect(resolveColorScheme({ block: 'auto', document: 'dark' })).toBe('dark');
    expect(
      resolveColorScheme({ block: 'auto', document: 'auto', embedder: 'auto', prefersDark: true }),
    ).toBe('dark');
  });

  it('defaults to light when nothing has an opinion', () => {
    expect(resolveColorScheme({})).toBe('light');
  });
});

describe('SPEC 12.6 — texture, the backup channel', () => {
  it('uses only 45° and its 135° mirror for the categorical channel', () => {
    for (let i = 0; i < 8; i += 1) {
      const def = categoricalTexture(i, '#2a78d6', 'light');
      expect(CATEGORICAL_ANGLES).toContain(def.angle);
    }
  });

  it('never emits a horizontal or vertical texture, on any channel', () => {
    const defs = [
      ...categoricalTextures(['#2a78d6', '#eb6834'], 'light'),
      ...Array.from({ length: 9 }, (_, i) => sequentialTexture(i, 9, '#2a78d6', 'light')),
      ...Array.from({ length: 6 }, (_, i) => divergingTexture(1, i, 6, '#e34948', 'light')),
      ...Array.from({ length: 6 }, (_, i) => divergingTexture(-1, i, 6, '#2a78d6', 'light')),
    ];
    for (const d of defs) {
      const a = ((d.angle % 180) + 180) % 180;
      expect(a).toBeGreaterThan(5);
      expect(Math.abs(a - 90)).toBeGreaterThan(5);
    }
  });

  it('keeps loudness equal across categorical slots', () => {
    const widths = categoricalTextures(['#2a78d6', '#eb6834', '#1baf7a', '#eda100'], 'light').map(
      (d) => {
        const first = d.content[0];
        return first !== undefined && first.kind === 'rect' ? first.w : -1;
      },
    );
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBeGreaterThan(0);
  });

  it('inks tone-on-tone from the fill, darker on light and lighter on dark', () => {
    expect(contrastRatio(toneOnTone('#2a78d6', 'light'), '#ffffff')).toBeGreaterThan(
      contrastRatio('#2a78d6', '#ffffff'),
    );
    expect(contrastRatio(toneOnTone('#3987e5', 'dark'), '#000000')).toBeGreaterThan(
      contrastRatio('#3987e5', '#000000'),
    );
  });

  it('orders the sequential texture monotonically in rotation and in coverage', () => {
    const defs = Array.from({ length: 7 }, (_, i) => sequentialTexture(i, 7, '#2a78d6', 'light'));
    for (let i = 1; i < defs.length; i += 1) {
      expect(defs[i]?.angle ?? 0).toBeGreaterThan(defs[i - 1]?.angle ?? 0);
      const a = defs[i]?.content[0];
      const b = defs[i - 1]?.content[0];
      const wa = a !== undefined && a.kind === 'rect' ? a.w : 0;
      const wb = b !== undefined && b.kind === 'rect' ? b.w : 0;
      expect(wa).toBeGreaterThan(wb);
    }
  });

  it('carries the diverging sign in the arm angle and the magnitude in the rotation', () => {
    const high = Array.from({ length: 5 }, (_, i) => divergingTexture(1, i, 5, '#e34948', 'light'));
    const low = Array.from({ length: 5 }, (_, i) => divergingTexture(-1, i, 5, '#2a78d6', 'light'));
    for (const d of high) expect(d.angle).toBeLessThan(90);
    for (const d of low) expect(d.angle).toBeGreaterThan(90);
    for (let i = 1; i < high.length; i += 1) {
      expect(high[i]?.angle ?? 0).toBeGreaterThan(high[i - 1]?.angle ?? 0);
      expect(low[i]?.angle ?? 0).toBeGreaterThan(low[i - 1]?.angle ?? 0);
    }
  });

  it('leaves the diverging midpoint untextured — zero reads as nothing', () => {
    expect(divergingTexture(0, 0, 5, '#f0efec', 'light').content).toEqual([]);
  });

  it('wraps into a PatternPaint carrying the series colour underneath', () => {
    const def = categoricalTexture(0, '#2a78d6', 'light');
    expect(texturePaint(def, '#2a78d6')).toEqual({
      kind: 'pattern',
      def: def.id,
      background: '#2a78d6',
    });
  });

  it('gives every def a namespaced, deterministic, collision-free id', () => {
    const ids = categoricalTextures(['#2a78d6', '#eb6834', '#1baf7a'], 'light').map((d) => d.id);
    expect(ids).toEqual(['mdv-tex-cat-0', 'mdv-tex-cat-1', 'mdv-tex-cat-2']);
    expect(categoricalTexture(0, '#2a78d6', 'light', { idPrefix: 'blk3' }).id).toBe('blk3-cat-0');
  });
});

describe('SPEC 11.5 — a label inside a colored fill picks by luminance', () => {
  it('chooses ink on a pale fill and paper on a dark one', () => {
    expect(labelOnFill('#eda100', '#0b0b0b', '#ffffff')).toBe('#0b0b0b');
    expect(labelOnFill('#4a3aa7', '#0b0b0b', '#ffffff')).toBe('#ffffff');
  });
});

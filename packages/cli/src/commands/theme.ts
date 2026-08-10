/**
 * `mdv validate-theme` (SPEC 27, SPEC 16.4).
 *
 * ```text
 * mdv validate-theme brand.json
 * mdv validate-theme brand.yaml --scheme dark
 * ```
 *
 * Runs the **executable** palette validator over a theme's categorical palette:
 * the lightness band, the chroma floor, adjacent-pair separation under simulated
 * colour-vision deficiency, and contrast against the theme's own surface, plus
 * the all-pairs check over the first three slots that SPEC 11.2 rule 3 asks for.
 * A `fail` finding is `MDV3080` and exits 1; a contrast warning is the relief
 * rule of SPEC 11.2 and is reported, not fatal.
 *
 * A named built-in validates too (`mdv validate-theme default`), which is the
 * check SPEC 16.4 requires an implementation to run over its own themes.
 */

import { auditTheme, getBuiltinTheme, isBuiltinThemeName } from '@mdv/themes';
import type { ColorScheme, PaletteFinding, Theme } from '@mdv/core';

import type { GlobalFlags } from '../args.js';
import { EXIT_CODES, usageError } from '../exit.js';
import { displayPath, exists } from '../io.js';
import type { CliIo } from '../io.js';
import { readThemeFile } from '../pipeline.js';
import { createTerm } from '../term.js';

/** Flags `mdv validate-theme` accepts on top of the global ones. */
export interface ValidateThemeFlags extends GlobalFlags {
  scheme?: string;
}

/** `mdv validate-theme` — run the palette validator (SPEC 16.4). */
export async function validateThemeCommand(
  io: CliIo,
  files: readonly string[],
  flags: ValidateThemeFlags = {},
): Promise<number> {
  const term = createTerm(io, flags);
  const target = files[0];
  if (target === undefined) {
    throw usageError('validate-theme: no theme given', 'Usage: mdv validate-theme <file|name>');
  }

  const schemeFlag = flags.scheme;
  if (schemeFlag !== undefined && schemeFlag !== 'light' && schemeFlag !== 'dark') {
    throw usageError(`--scheme must be light or dark, got \`${schemeFlag}\``);
  }
  const scheme: ColorScheme = schemeFlag === 'dark' ? 'dark' : 'light';

  let theme: Theme;
  let label: string;
  if (await exists(io, target)) {
    // The findings below are the same MDV3080 the reader warns about, printed
    // in full — so the reader's own summary is left out of this one command.
    theme = (await readThemeFile(io, target, scheme)).theme;
    label = displayPath(io, target);
  } else if (isBuiltinThemeName(target)) {
    theme = getBuiltinTheme(target);
    label = `built-in theme \`${target}\``;
  } else {
    throw usageError(
      `No theme \`${target}\``,
      'Give a path to a theme file (.json, .jsonc, .yaml, .yml), or a built-in name: ' +
        'default, dark, print, high-contrast.',
    );
  }

  const audit = auditTheme(theme);
  const { gate } = audit;

  term.line(
    `${term.bold(label)} — ${theme.categorical.length} slot${theme.categorical.length === 1 ? '' : 's'}, ${theme.scheme} scheme, surface ${theme.tokens.surface}`,
  );

  const print = (finding: PaletteFinding): void => {
    const tag = finding.level === 'fail' ? term.red('fail') : term.yellow('warn');
    const slots = finding.slots.map((slot) => `#${slot}`).join(' vs ');
    term.line(
      `  ${tag} ${term.dim(finding.check)} ${slots}: ${finding.message} ` +
        `${term.dim(`(measured ${finding.measured.toFixed(2)}, threshold ${finding.threshold.toFixed(2)})`)}`,
    );
  };

  for (const finding of gate.findings) print(finding);
  for (const finding of audit.scatter) print(finding);

  if (gate.reliefRequiredSlots.length > 0) {
    term.line(
      `  ${term.yellow('relief')} slots ${gate.reliefRequiredSlots.map((s) => `#${s}`).join(', ')} ` +
        'need visible direct labels or the table view (SPEC 11.2 rule 4)',
    );
  }

  if (audit.passed) {
    term.line(term.green('PASS'));
    return EXIT_CODES.ok;
  }
  term.line(term.red('FAIL — MDV3080'));
  return EXIT_CODES.diagnostics;
}

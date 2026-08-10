/**
 * `mdv.validateTheme` and `mdv.togglePreviewTheme` (SPEC 29.5), plus the
 * workspace consent action behind the preview's external-data banner
 * (SPEC 29.3).
 */

import * as vscode from 'vscode';
import { auditTheme, getBuiltinTheme, BUILTIN_THEME_NAMES } from '@mdv/themes';
import type { BuiltinThemeName } from '@mdv/themes';
import { createLogChannel } from '../channel.js';
import { log } from '../log.js';
import type { CommandContext } from './context.js';
import type { PreviewThemeSetting } from '../settings.js';

/**
 * Run the executable palette validator (SPEC 11.2, 16.4) and write the findings
 * to the output channel.
 *
 * The validator is the *normative* one from `@mdv/themes` — the same code the
 * conformance suite runs — not a re-implementation. Every finding names its
 * rule, so the output is actionable rather than a pass/fail bit.
 */
export async function validateTheme(): Promise<void> {
  const names = [...BUILTIN_THEME_NAMES];
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'All built-in themes', name: undefined },
      ...names.map((n) => ({ label: n, name: n })),
    ],
    { title: 'Validate palette', placeHolder: 'Theme' },
  );
  if (picked === undefined) return;

  const channel = createLogChannel();
  channel.show(true);
  const chosen: BuiltinThemeName[] = picked.name === undefined ? names : [picked.name];

  for (const name of chosen) {
    const theme = getBuiltinTheme(name);
    // Validated against *this* theme's own surface, which is SPEC 11.2 rule 5:
    // a substituted palette is re-checked, never reasoned about.
    const audit = auditTheme(theme);
    const findings = [...audit.gate.findings, ...audit.scatter];
    log(
      `theme "${name}" (${theme.scheme}): ${audit.passed ? 'PASS' : 'FAIL'} — ` +
        `${String(findings.length)} finding(s), ` +
        `${String(audit.gate.reliefRequiredSlots.length)} slot(s) need secondary encoding`,
    );
    for (const finding of findings) {
      log(
        `  [${finding.level}] ${finding.check} slots[${finding.slots.join(',')}] ` +
          `measured ${String(finding.measured)} vs ${String(finding.threshold)}: ${finding.message}`,
      );
    }
  }
}

/** SPEC 29.5: flip `mdv.preview.theme` between light and dark. */
export async function togglePreviewTheme(ctx: CommandContext): Promise<void> {
  const current = ctx.settings.current.preview.theme;
  // `auto` is resolved against the editor first, so one press from `auto`
  // produces the *opposite* of what is on screen rather than a no-op.
  const editorIsDark =
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ||
    vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.HighContrast;
  const next: PreviewThemeSetting =
    current === 'dark' ? 'light' : current === 'light' ? 'dark' : editorIsDark ? 'light' : 'dark';

  await vscode.workspace
    .getConfiguration('mdv')
    .update('preview.theme', next, vscode.ConfigurationTarget.Global);
  void vscode.window.setStatusBarMessage(`MDV preview theme: ${next}`, 2000);
}

/**
 * "Allow for this workspace" from the preview banner (SPEC 29.3).
 *
 * Never automatic: this command only ever runs from a click, and it still asks
 * for a modal confirmation naming what is being granted. It refuses outright in
 * an untrusted workspace — SPEC 29.6's rule is that a repository must not be
 * able to turn on network access for its own documents, and "the user clicked a
 * button a repository's preview drew" is close enough to that to warrant the
 * trust prompt first.
 */
export async function allowExternalForWorkspace(): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    const choice = await vscode.window.showWarningMessage(
      'MDV: external data can only be enabled in a trusted workspace.',
      { modal: true },
      'Manage Workspace Trust',
    );
    if (choice === 'Manage Workspace Trust') {
      await vscode.commands.executeCommand('workbench.trust.manage');
    }
    return;
  }

  const confirm = await vscode.window.showWarningMessage(
    'Allow MDV documents in this workspace to load data over the network?',
    {
      modal: true,
      detail:
        'Documents will be able to fetch the URLs in their `src:` attributes when you preview them. ' +
        'You can restrict this to specific origins with `mdv.security.allowedOrigins`.',
    },
    'Allow',
  );
  if (confirm !== 'Allow') return;

  await vscode.workspace
    .getConfiguration('mdv')
    .update('security.allowExternal', true, vscode.ConfigurationTarget.Workspace);
  log('mdv.security.allowExternal enabled for this workspace by explicit user action');
}

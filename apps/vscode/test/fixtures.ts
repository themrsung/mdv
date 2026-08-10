/**
 * Shared fixtures for the extension's unit tests.
 *
 * Only the host-free half of the extension is unit-tested here: the pipeline,
 * the cascade, the theme mapping, the markdown-it integration and the manifest.
 * Everything that imports `vscode` needs an extension host, which this
 * environment does not have — see `README.md`, "Testing".
 */

import type { MdvSettings } from '../src/settings.js';
import type { PipelineInputs } from '../src/pipeline/index.js';

/** A two-chart document with a shared dataset, front matter and prose. */
export const TWO_CHARTS = `---
mdv: "1.0"
title: Quarterly review
defaults:
  height: 240
---

# Quarterly review

Revenue held up.

\`\`\`mdv dataset
id: sales
format: csv
---
quarter,revenue,profit
Q1,1240,310
Q2,1516,402
Q3,1402,366
Q4,1893,551
\`\`\`

\`\`\`mdv bar
id: revenue-bar
title: Revenue by quarter
data: "@sales"
x: quarter
y: revenue
---
\`\`\`

Profit followed.

\`\`\`mdv line
id: profit-line
title: Profit by quarter
data: "@sales"
x: quarter
y: profit
---
\`\`\`
`;

/** A single inline-data chart; the smallest document that draws something. */
export const ONE_CHART = `---
mdv: "1.0"
---
\`\`\`mdv bar
title: Revenue by quarter
x: quarter
y: revenue
---
quarter | revenue
Q1      | 1240
Q2      | 1516
\`\`\`
`;

/** Default pipeline inputs; spread and override the one field under test. */
export const INPUTS: PipelineInputs = {
  source: ONE_CHART,
  uri: 'file:///workspace/doc.mdv',
  width: 720,
  theme: 'default',
  level: 2,
  strict: false,
  allowExternal: false,
  allowedOrigins: [],
};

/** The settings snapshot `readSettings()` would return with nothing configured. */
export const DEFAULT_SETTINGS: MdvSettings = {
  preview: { theme: 'auto', scrollSync: true, debounceMs: 150, openOnStartup: false },
  validate: { enable: true, level: 2, strict: false },
  format: { enable: true, attributeOrder: 'canonical' },
  security: { allowExternal: false, allowedOrigins: [], trusted: true },
  exportSettings: { pdfPageSize: 'A4', defaultDirectory: '' },
  completion: { columnNames: true },
  codeLens: { enable: true },
  trace: 'off',
};

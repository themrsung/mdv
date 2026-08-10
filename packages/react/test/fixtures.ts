/**
 * Shared fixtures.
 *
 * Real MDV source, parsed and resolved by the real pipeline: these tests are
 * about the React binding, and stubbing the pipeline out would test the stubs.
 * Nothing here reaches for a DOM — the whole suite runs in Vitest's `node`
 * environment on purpose, because "server rendering works with no DOM access"
 * is only proved by a run in which there is no DOM to access.
 */

/** A well-formed document: a heading, prose, and one bar block. */
export const GOOD = `---
title: Quarterly
lang: en
---

# Revenue

Some **prose** with a [link](https://example.com/) and a bad [one](javascript:alert(1)).

\`\`\`mdv bar
title: Revenue by quarter
x: quarter
y: revenue
---
quarter,revenue
Q1,1240
Q2,1500
Q3,1700
Q4,1893
\`\`\`

Trailing paragraph.
`;

/** Two blocks, so a test can change one and watch the other stay put. */
export const TWO_BLOCKS = `# Two

\`\`\`mdv bar
title: First
x: quarter
y: revenue
---
quarter,revenue
Q1,1240
Q2,1500
\`\`\`

\`\`\`mdv bar
title: Second
x: quarter
y: revenue
---
quarter,revenue
Q1,10
Q2,20
\`\`\`
`;

/** The same document with the first block's title edited. */
export const TWO_BLOCKS_EDITED = TWO_BLOCKS.replace('title: First', 'title: Renamed');

/**
 * A document whose first block cannot render, followed by a healthy one.
 *
 * `x: nope` names a column that is not in the data — `MDV3000`. The point of the
 * fixture is the *second* block: SPEC 14.1 principle 1 says the rest of the
 * document renders regardless.
 */
export const MALFORMED = `# Broken

\`\`\`mdv bar
title: Broken
x: nope
y: revenue
---
quarter,revenue
Q1,1240
\`\`\`

\`\`\`mdv bar
title: Healthy
x: quarter
y: revenue
---
quarter,revenue
Q1,1240
Q2,1500
\`\`\`
`;

/** A block whose type does not exist at all. */
export const UNKNOWN_TYPE = `\`\`\`mdv nonsuch
title: Unknown
---
a,b
1,2
\`\`\`
`;

/** A block that needs the network, which the synchronous path cannot give it. */
export const EXTERNAL = `\`\`\`mdv line
title: External
src: https://example.com/data.csv
x: date
y: value
\`\`\`
`;

/** Split serialised markup into one line per tag, for order assertions. */
export function tags(html: string): string[] {
  return html.replace(/></g, '>\n<').split('\n');
}

/** Indices of the lines matching a pattern, in document order. */
export function indexOfTag(html: string, pattern: RegExp): number {
  return tags(html).findIndex((line) => pattern.test(line));
}

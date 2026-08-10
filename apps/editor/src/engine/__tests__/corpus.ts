/**
 * The round-trip corpus.
 *
 * These documents are the engine's serialisation specification. Every one must
 * satisfy `read(write(read(t)))` deep-equals `read(t)` — reading is
 * deterministic, so the ids match too — and every raw block must survive
 * byte-for-byte.
 */

/** SPEC Appendix E, verbatim. The reference implementation's target document. */
export const APPENDIX_E = `---
mdv: "1.0"
title: FY2026 Business Review
author: Analytics
date: 2026-08-10
theme: default
pdf:
  pageSize: A4
  footer: {center: "{page} / {pages}"}
  profile: pdf-ua-1
  embedSource: true
defaults:
  height: 300
---

# FY2026 Business Review

Revenue reached :mdv-value[@quarterly.revenue.sum]{format="$,.0f"} for the year,
up :mdv-delta[0.184]{good=up} against FY2025.

\`\`\`mdv dataset id=quarterly
fields:
  quarter: {type: category}
---
quarter | revenue | profit | region
Q1      |    1240 |    310 | APAC
Q2      |    1516 |    402 | APAC
Q3      |    1402 |    366 | APAC
Q4      |    1893 |    551 | APAC
\`\`\`

:::mdv-grid{cols=3 gap=16}

\`\`\`mdv metric
label: Annual revenue
value: 6051000
format: "$~s"
delta: 0.184
deltaOf: vs. FY2025
goodDirection: up
\`\`\`

\`\`\`mdv metric
label: Gross margin
value: 0.271
format: ".1%"
delta: 0.012
goodDirection: up
\`\`\`

\`\`\`mdv metric
label: Customers
value: 4821
delta: -0.03
goodDirection: up
\`\`\`

:::

## Revenue and profit

\`\`\`mdv bar
id: fig-revenue
title: Revenue and profit by quarter
desc: >
  Grouped bars. Revenue rises from 1,240 in Q1 to 1,893 in Q4;
  profit rises from 310 to 551. The largest step is Q3 to Q4.
data: "@quarterly"
x: quarter
y: [revenue, profit]
label: true
axis:
  y: {title: USD (thousands), format: ",.0f"}
\`\`\`

See :mdv-ref[fig-revenue] for the quarterly detail.

## Price action

\`\`\`mdv ohlcv
title: ACME — daily, with volume
x: date
volume: volume
style: candle
gaps: collapse
volumeHeight: 0.22
overlay:
  - {type: sma, period: 3}
panels:
  - {type: rsi, period: 14, height: 0.15, bands: [30, 70]}
---
date       |  open |  high |   low | close |  volume
2026-08-03 | 41.20 | 42.05 | 40.90 | 41.85 | 1204000
2026-08-04 | 41.90 | 42.40 | 41.10 | 41.30 |  980000
2026-08-05 | 41.35 | 41.60 | 39.80 | 40.05 | 1810000
2026-08-06 | 40.10 | 41.75 | 40.00 | 41.60 | 1442000
2026-08-07 | 41.55 | 43.20 | 41.40 | 43.05 | 2110000
\`\`\`

## Support load

\`\`\`mdv heatmap
title: Tickets by weekday and hour
x: hour
y: weekday
value: tickets
scheme: blue
sort: {y: [Mon, Tue, Wed, Thu, Fri]}
format: matrix
---
      |  9 | 10 | 11 | 12
Mon   | 12 | 31 | 28 |  9
Tue   |  8 | 44 | 39 | 12
Wed   | 15 | 38 | 41 | 14
Thu   | 11 | 29 | 33 | 10
Fri   |  6 | 18 | 21 |  7
\`\`\`

:::mdv-callout{type=note title="Method"}
Ticket counts exclude automated alerts. See the appendix dataset for the raw
extract.
:::

:::mdv-page{break=before}

## Appendix — data

\`\`\`mdv table
data: "@quarterly"
columns:
  quarter: {label: Quarter}
  revenue: {label: Revenue, format: "$,.0f", align: right, heat: sequential}
  profit:  {label: Profit,  format: "$,.0f", align: right}
total: {revenue: sum, profit: sum}
\`\`\`
`;

/** Inline marks, escapes, links, code spans. */
export const INLINE = `Plain text with **strong**, *emphasis*, ~~struck~~ and \`code\`.

A [link](https://example.com "Title") and a [bare link](https://example.com).

Nested **strong with *emphasis* inside** and \`\`code with \` backtick\`\`.

Escapes: \\*not emphasis\\*, a literal \\[bracket\\], snake_case_word, 5 \\* 3.

Math $x^2 + y^2$ and an autolink <https://example.org>.
`;

/** Lists, nesting, task items, block quotes. */
export const STRUCTURE = `# Heading one

Setext two
----------

- first
- second
  - nested a
  - nested b
- third

1. one
2. two
   1. two point one
3. three

- [ ] todo
- [x] done

> A quote.
>
> - with a list
> - inside it

***

    indented code
    second line

\`\`\`ts
const x: number = 1;
\`\`\`
`;

/** GFM tables with every alignment. */
export const TABLES = `| Region | Revenue | Growth | Note |
| :----- | ------: | :----: | ---- |
| APAC   |   42100 | 0.182  | a\\|b |
| EMEA   |   31800 | -0.041 |      |

| single |
| ------ |
| value  |
`;

/** Visual blocks exercising the SPEC 5.1 separator determinism rule. */
export const VISUAL = `\`\`\`mdv pie
---
region | revenue
APAC   | 4210
EMEA   | 3180
\`\`\`

\`\`\`mdv sparkline data="1,4,2,8"
\`\`\`

\`\`\`mdv bar height=200 title='Q1 results'
x: quarter
y: revenue
\`\`\`

\`\`\`mdv
type: line
---
a | b
1 | 2
\`\`\`
`;

/** Images as data URIs, with and without intrinsic dimensions. */
export const IMAGES = `![a red dot](data:image/png;base64,iVBORw0KGgo=){width=8 height=8}

![no size](data:image/gif;base64,R0lGODlhAQABAAAAACw=)

![titled](https://example.com/x.png "The title")
`;

/** Constructs the reader deliberately keeps verbatim. */
export const RAW = `<div class="callout">
  <p>Raw HTML block.</p>
</div>

[ref]: https://example.com "Reference definition"

[^note]: A footnote definition.

:::mdv-callout{type=warning}
Body of the callout.
:::
`;

/** Everything, keyed by name for table-driven tests. */
export const CORPUS: Readonly<Record<string, string>> = {
  APPENDIX_E,
  INLINE,
  STRUCTURE,
  TABLES,
  VISUAL,
  IMAGES,
  RAW,
  EMPTY: '',
  ONLY_FRONT_MATTER: '---\ntitle: x\n---\n',
  BOM_AND_CRLF: '﻿# Title\r\n\r\nBody text.\r\n',
};

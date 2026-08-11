# MDV conformance report

- Spec version: `1.0-draft.1`
- Level asked for: 3 (Extended)
- Level substantiated: none
- Corpus root: `/Users/themrsung/mdv/packages/spec/tests`
- Result: **pass**

## Totals

| | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Cases | 1 | 1 | 0 | 0 |
| Checks | 5 | 5 | 0 | 0 |

## Cases

| Case | Level | Status | parse | round-trip | resolve | ast | diagnostics | render | dark | pdf |
| --- | ---: | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `render/bar/stacked-percent` | 2 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |

## Coverage

| Requirement | Level | SPEC | Cases |
| --- | ---: | --- | --- |
| `syntax.frontmatter` Front matter | 1 | 3.4 | `render/bar/stacked-percent` |
| `syntax.base` Base syntax | 1 | 4 | `render/bar/stacked-percent` |
| `syntax.blocks` Visual blocks | 1 | 5 | `render/bar/stacked-percent` |
| `attrs.cascade` The attribute cascade | 1 | 5.5 | `render/bar/stacked-percent` |
| `data.inference` Type inference | 1 | 6.1.1 | `render/bar/stacked-percent` |
| `data.table` `table` data | 1 | 6.2.1 | `render/bar/stacked-percent` |
| `data.csv` `csv` data | 1 | 6.2.2 | **none** |
| `data.tsv` `tsv` data | 1 | 6.2.2 | **none** |
| `data.datasets` Datasets and references | 1 | 6.3 | **none** |
| `type.bar` `bar` | 1 | 8.2 | `render/bar/stacked-percent` |
| `type.line` `line` | 1 | 8.3 | **none** |
| `type.area` `area` | 1 | 8.4 | **none** |
| `type.pie` `pie` | 1 | 8.5 | **none** |
| `type.donut` `donut` | 1 | 8.5 | **none** |
| `type.scatter` `scatter` | 1 | 8.6 | **none** |
| `type.metric` `metric` | 1 | 8.13 | **none** |
| `type.table` `table` | 1 | 10.1 | **none** |
| `theme.tokens` Theme tokens | 1 | 11.1 | `render/bar/stacked-percent` |
| `render.marks` Mark specifications | 1 | 11.4 | `render/bar/stacked-percent` |
| `a11y.names` Accessible names | 1 | 12.1 | `render/bar/stacked-percent` |
| `a11y.table-view` The table view | 1 | 12.3 | **none** |
| `render.error-cards` Error cards | 1 | 14.1 | **none** |
| `data.json` `json` data | 2 | 6.2.3 | **none** |
| `data.ndjson` `ndjson` data | 2 | 6.2.3 | **none** |
| `data.columns` `columns` data | 2 | 6.2.4 | **none** |
| `data.matrix` `matrix` data | 2 | 6.2.5 | **none** |
| `data.transforms` Transforms | 2 | 6.7 | **none** |
| `data.mdvx` MDVX expressions | 2 | 6.8 | **none** |
| `layout.faceting` Faceting | 2 | 7.6 | **none** |
| `type.histogram` `histogram` | 2 | 8.7 | **none** |
| `type.box` `box` | 2 | 8.8 | **none** |
| `type.heatmap` `heatmap` | 2 | 8.9 | **none** |
| `type.ohlc` `ohlc` | 2 | 8.10 | **none** |
| `type.ohlcv` `ohlcv` | 2 | 8.11 | **none** |
| `type.candlestick` `candlestick` | 2 | 8.11 | **none** |
| `type.radar` `radar` | 2 | 8.12 | **none** |
| `type.gauge` `gauge` | 2 | 8.12 | **none** |
| `type.funnel` `funnel` | 2 | 8.12 | **none** |
| `type.waterfall` `waterfall` | 2 | 8.12 | **none** |
| `type.treemap` `treemap` | 2 | 8.12 | **none** |
| `type.sankey` `sankey` | 2 | 8.12 | **none** |
| `type.sparkline` `sparkline` | 2 | 8.12 | **none** |
| `syntax.directives` Block directives | 2 | 9.1 | **none** |
| `syntax.inline-sparkline` Inline sparklines | 2 | 9.2 | **none** |
| `theme.custom` Custom themes | 2 | 11.6 | **none** |
| `a11y.keyboard` Full keyboard interaction | 2 | 12.4 | **none** |
| `export.pdf` PDF export | 2 | 28 | `render/bar/stacked-percent` |
| `type.map` `map` | 3 | 8.12 | **none** |
| `type.network` `network` | 3 | 8.12 | **none** |
| `type.gantt` `gantt` | 3 | 8.12 | **none** |
| `syntax.math` Math | 3 | 16.1 | **none** |
| `syntax.include` Cross-document `include` | 3 | 5.2 | **none** |
| `data.external` External data | 3 | 6.4 | **none** |
| `data.live` Live data sources | 3 | 16.1 | **none** |
| `plugin.api` Plugins | 3 | 26 | **none** |

44 requirements up to level 3 are not substantiated by a passing case:

- `data.csv` — `csv` data
- `data.tsv` — `tsv` data
- `data.datasets` — Datasets and references
- `type.line` — `line`
- `type.area` — `area`
- `type.pie` — `pie`
- `type.donut` — `donut`
- `type.scatter` — `scatter`
- `type.metric` — `metric`
- `type.table` — `table`
- `a11y.table-view` — The table view
- `render.error-cards` — Error cards
- `data.json` — `json` data
- `data.ndjson` — `ndjson` data
- `data.columns` — `columns` data
- `data.matrix` — `matrix` data
- `data.transforms` — Transforms
- `data.mdvx` — MDVX expressions
- `layout.faceting` — Faceting
- `type.histogram` — `histogram`
- `type.box` — `box`
- `type.heatmap` — `heatmap`
- `type.ohlc` — `ohlc`
- `type.ohlcv` — `ohlcv`
- `type.candlestick` — `candlestick`
- `type.radar` — `radar`
- `type.gauge` — `gauge`
- `type.funnel` — `funnel`
- `type.waterfall` — `waterfall`
- `type.treemap` — `treemap`
- `type.sankey` — `sankey`
- `type.sparkline` — `sparkline`
- `syntax.directives` — Block directives
- `syntax.inline-sparkline` — Inline sparklines
- `theme.custom` — Custom themes
- `a11y.keyboard` — Full keyboard interaction
- `type.map` — `map`
- `type.network` — `network`
- `type.gantt` — `gantt`
- `syntax.math` — Math
- `syntax.include` — Cross-document `include`
- `data.external` — External data
- `data.live` — Live data sources
- `plugin.api` — Plugins

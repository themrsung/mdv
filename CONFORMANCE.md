# MDV conformance report

- Spec version: `1.0-draft.1`
- Level asked for: 3 (Extended)
- Level substantiated: 1 (Core)
- Corpus root: `/Users/themrsung/mdv/packages/spec/tests`
- Result: **pass**

## Totals

| | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Cases | 17 | 17 | 0 | 0 |
| Checks | 104 | 104 | 0 | 0 |

## Cases

| Case | Level | Status | parse | round-trip | resolve | ast | diagnostics | render | dark | pdf |
| --- | ---: | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `a11y/table-view/details` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/columns/sequences` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/csv/quoted-fields` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/datasets/shared-reference` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/json/nested-records` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/matrix/grid` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/ndjson/stream` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/tsv/simple` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/area/stacked` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/bar/stacked-percent` | 2 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `render/donut/center` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/error-cards/unknown-field` | 1 | pass | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `render/line/multi-series` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `render/metric/kpi-row` | 1 | pass | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `render/pie/simple` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/scatter/two-measures` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/table/enhanced` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |

## Coverage

| Requirement | Level | SPEC | Cases |
| --- | ---: | --- | --- |
| `syntax.frontmatter` Front matter | 1 | 3.4 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `syntax.base` Base syntax | 1 | 4 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `syntax.blocks` Visual blocks | 1 | 5 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `attrs.cascade` The attribute cascade | 1 | 5.5 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `data.inference` Type inference | 1 | 6.1.1 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `data.table` `table` data | 1 | 6.2.1 | `data/datasets/shared-reference`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/line/multi-series`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `data.csv` `csv` data | 1 | 6.2.2 | `a11y/table-view/details`, `data/csv/quoted-fields`, `render/error-cards/unknown-field` |
| `data.tsv` `tsv` data | 1 | 6.2.2 | `data/tsv/simple` |
| `data.datasets` Datasets and references | 1 | 6.3 | `data/datasets/shared-reference` |
| `type.bar` `bar` | 1 | 8.2 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/tsv/simple`, `render/bar/stacked-percent`, `render/error-cards/unknown-field` |
| `type.line` `line` | 1 | 8.3 | `a11y/table-view/details`, `data/datasets/shared-reference`, `data/ndjson/stream`, `render/line/multi-series` |
| `type.area` `area` | 1 | 8.4 | `render/area/stacked` |
| `type.pie` `pie` | 1 | 8.5 | `render/pie/simple` |
| `type.donut` `donut` | 1 | 8.5 | `render/donut/center` |
| `type.scatter` `scatter` | 1 | 8.6 | `render/scatter/two-measures` |
| `type.metric` `metric` | 1 | 8.13 | `render/metric/kpi-row` |
| `type.table` `table` | 1 | 10.1 | `render/table/enhanced` |
| `theme.tokens` Theme tokens | 1 | 11.1 | `render/line/multi-series` |
| `render.marks` Mark specifications | 1 | 11.4 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `a11y.names` Accessible names | 1 | 12.1 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `a11y.table-view` The table view | 1 | 12.3 | `a11y/table-view/details` |
| `render.error-cards` Error cards | 1 | 14.1 | `render/error-cards/unknown-field` |
| `data.json` `json` data | 2 | 6.2.3 | `data/json/nested-records` |
| `data.ndjson` `ndjson` data | 2 | 6.2.3 | `data/ndjson/stream` |
| `data.columns` `columns` data | 2 | 6.2.4 | `data/columns/sequences` |
| `data.matrix` `matrix` data | 2 | 6.2.5 | `data/matrix/grid` |
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
| `export.pdf` PDF export | 2 | 28 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/ndjson/stream`, `data/tsv/simple`, `render/area/stacked`, `render/bar/stacked-percent`, `render/donut/center`, `render/error-cards/unknown-field`, `render/line/multi-series`, `render/metric/kpi-row`, `render/pie/simple`, `render/scatter/two-measures`, `render/table/enhanced` |
| `type.map` `map` | 3 | 8.12 | **none** |
| `type.network` `network` | 3 | 8.12 | **none** |
| `type.gantt` `gantt` | 3 | 8.12 | **none** |
| `syntax.math` Math | 3 | 16.1 | **none** |
| `syntax.include` Cross-document `include` | 3 | 5.2 | **none** |
| `data.external` External data | 3 | 6.4 | **none** |
| `data.live` Live data sources | 3 | 16.1 | **none** |
| `plugin.api` Plugins | 3 | 26 | **none** |

28 requirements up to level 3 are not substantiated by a passing case:

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

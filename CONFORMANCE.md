# MDV conformance report

- Spec version: `1.0-draft.1`
- Level asked for: 3 (Extended)
- Level substantiated: 2 (Standard)
- Corpus root: `/Users/themrsung/mdv/packages/spec/tests`
- Result: **pass**

## Totals

| | Total | Passed | Failed | Skipped |
| --- | ---: | ---: | ---: | ---: |
| Cases | 46 | 46 | 0 | 0 |
| Checks | 269 | 268 | 0 | 1 |

## Cases

| Case | Level | Status | parse | round-trip | resolve | ast | diagnostics | render | dark | pdf |
| --- | ---: | --- | :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| `a11y/keyboard/focus-order` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `a11y/table-view/details` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/columns/sequences` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/csv/quoted-fields` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/datasets/shared-reference` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/json/nested-records` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/matrix/grid` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/mdvx/diagnostics` | 2 | pass | ✓ | ✓ | ✓ |  | ✓ | ✓ |  | ✓ |
| `data/mdvx/expressions` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/ndjson/stream` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/transforms/pipeline` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `data/tsv/simple` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `perf/first-chart-50-blocks` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/incremental-attr` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/interaction-frame` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/line-1000-rows` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/parse-100kb` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/parse-1mb` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/pdf-50-pages` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/resize-20-blocks` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `perf/scatter-10000-points` | 1 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `render/area/stacked` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/bar/stacked-percent` | 2 | pass | ✓ | ✓ | ✓ |  |  | ✓ |  | ✓ |
| `render/box/by-region` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/candlestick/hollow-up` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/donut/center` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/error-cards/unknown-field` | 1 | pass | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `render/facet/small-multiples` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/funnel/signup` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/gauge/slo` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/histogram/response-times` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/line/multi-series` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ | ✓ | ✓ |
| `render/metric/kpi-row` | 1 | pass | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `render/ohlc/daily-bars` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/ohlcv/with-volume` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/pie/simple` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/radar/capability` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/sankey/traffic` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/scatter/two-measures` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/sparkline/errors` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/table/enhanced` | 1 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/theme/custom` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/treemap/storage` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `render/waterfall/arr-bridge` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `syntax/directives/containers` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | ✓ |  | ✓ |
| `syntax/directives/inline` | 2 | pass | ✓ | ✓ | ✓ | ✓ |  | – |  | ✓ |

## Coverage

| Requirement | Level | SPEC | Cases |
| --- | ---: | --- | --- |
| `syntax.frontmatter` Front matter | 1 | 3.4 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers`, `syntax/directives/inline` |
| `syntax.base` Base syntax | 1 | 4 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers`, `syntax/directives/inline` |
| `syntax.blocks` Visual blocks | 1 | 5 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers` |
| `attrs.cascade` The attribute cascade | 1 | 5.5 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers` |
| `data.inference` Type inference | 1 | 6.1.1 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers` |
| `data.table` `table` data | 1 | 6.2.1 | `data/datasets/shared-reference`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/treemap/storage`, `render/waterfall/arr-bridge` |
| `data.csv` `csv` data | 1 | 6.2.2 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/csv/quoted-fields`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/transforms/pipeline`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/theme/custom`, `syntax/directives/containers` |
| `data.tsv` `tsv` data | 1 | 6.2.2 | `data/tsv/simple` |
| `data.datasets` Datasets and references | 1 | 6.3 | `data/datasets/shared-reference`, `data/mdvx/expressions`, `data/transforms/pipeline` |
| `type.bar` `bar` | 1 | 8.2 | `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/mdvx/diagnostics`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/incremental-attr`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/resize-20-blocks`, `render/bar/stacked-percent`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `syntax/directives/containers` |
| `type.line` `line` | 1 | 8.3 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/datasets/shared-reference`, `data/ndjson/stream`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/pdf-50-pages`, `render/facet/small-multiples`, `render/line/multi-series`, `render/theme/custom`, `syntax/directives/containers` |
| `type.area` `area` | 1 | 8.4 | `perf/first-chart-50-blocks`, `render/area/stacked` |
| `type.pie` `pie` | 1 | 8.5 | `render/pie/simple` |
| `type.donut` `donut` | 1 | 8.5 | `render/donut/center` |
| `type.scatter` `scatter` | 1 | 8.6 | `perf/scatter-10000-points`, `render/scatter/two-measures` |
| `type.metric` `metric` | 1 | 8.13 | `render/metric/kpi-row` |
| `type.table` `table` | 1 | 10.1 | `data/mdvx/expressions`, `render/table/enhanced` |
| `theme.tokens` Theme tokens | 1 | 11.1 | `render/line/multi-series` |
| `render.marks` Mark specifications | 1 | 11.4 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers` |
| `a11y.names` Accessible names | 1 | 12.1 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers` |
| `a11y.table-view` The table view | 1 | 12.3 | `a11y/keyboard/focus-order`, `a11y/table-view/details` |
| `render.error-cards` Error cards | 1 | 14.1 | `data/matrix/grid`, `data/mdvx/diagnostics`, `render/error-cards/unknown-field` |
| `data.json` `json` data | 2 | 6.2.3 | `data/json/nested-records` |
| `data.ndjson` `ndjson` data | 2 | 6.2.3 | `data/ndjson/stream` |
| `data.columns` `columns` data | 2 | 6.2.4 | `data/columns/sequences` |
| `data.matrix` `matrix` data | 2 | 6.2.5 | `data/matrix/grid` |
| `data.transforms` Transforms | 2 | 6.7 | `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/transforms/pipeline` |
| `data.mdvx` MDVX expressions | 2 | 6.8 | `data/mdvx/expressions`, `data/transforms/pipeline` |
| `layout.faceting` Faceting | 2 | 7.6 | `render/facet/small-multiples` |
| `type.histogram` `histogram` | 2 | 8.7 | `render/histogram/response-times` |
| `type.box` `box` | 2 | 8.8 | `render/box/by-region` |
| `type.heatmap` `heatmap` | 2 | 8.9 | `data/matrix/grid` |
| `type.ohlc` `ohlc` | 2 | 8.10 | `render/ohlc/daily-bars` |
| `type.ohlcv` `ohlcv` | 2 | 8.11 | `render/ohlcv/with-volume` |
| `type.candlestick` `candlestick` | 2 | 8.11 | `render/candlestick/hollow-up` |
| `type.radar` `radar` | 2 | 8.12 | `render/radar/capability` |
| `type.gauge` `gauge` | 2 | 8.12 | `render/gauge/slo` |
| `type.funnel` `funnel` | 2 | 8.12 | `render/funnel/signup` |
| `type.waterfall` `waterfall` | 2 | 8.12 | `render/waterfall/arr-bridge` |
| `type.treemap` `treemap` | 2 | 8.12 | `render/treemap/storage` |
| `type.sankey` `sankey` | 2 | 8.12 | `render/sankey/traffic` |
| `type.sparkline` `sparkline` | 2 | 8.12 | `render/sparkline/errors` |
| `syntax.directives` Block directives | 2 | 9.1 | `syntax/directives/containers` |
| `syntax.inline-sparkline` Inline sparklines | 2 | 9.2 | `syntax/directives/inline` |
| `theme.custom` Custom themes | 2 | 11.6 | `render/theme/custom` |
| `a11y.keyboard` Full keyboard interaction | 2 | 12.4 | `a11y/keyboard/focus-order` |
| `export.pdf` PDF export | 2 | 28 | `a11y/keyboard/focus-order`, `a11y/table-view/details`, `data/columns/sequences`, `data/csv/quoted-fields`, `data/datasets/shared-reference`, `data/json/nested-records`, `data/matrix/grid`, `data/mdvx/diagnostics`, `data/mdvx/expressions`, `data/ndjson/stream`, `data/transforms/pipeline`, `data/tsv/simple`, `perf/first-chart-50-blocks`, `perf/incremental-attr`, `perf/interaction-frame`, `perf/line-1000-rows`, `perf/parse-100kb`, `perf/parse-1mb`, `perf/pdf-50-pages`, `perf/resize-20-blocks`, `perf/scatter-10000-points`, `render/area/stacked`, `render/bar/stacked-percent`, `render/box/by-region`, `render/candlestick/hollow-up`, `render/donut/center`, `render/error-cards/unknown-field`, `render/facet/small-multiples`, `render/funnel/signup`, `render/gauge/slo`, `render/histogram/response-times`, `render/line/multi-series`, `render/metric/kpi-row`, `render/ohlc/daily-bars`, `render/ohlcv/with-volume`, `render/pie/simple`, `render/radar/capability`, `render/sankey/traffic`, `render/scatter/two-measures`, `render/sparkline/errors`, `render/table/enhanced`, `render/theme/custom`, `render/treemap/storage`, `render/waterfall/arr-bridge`, `syntax/directives/containers`, `syntax/directives/inline` |
| `type.map` `map` | 3 | 8.12 | **none** |
| `type.network` `network` | 3 | 8.12 | **none** |
| `type.gantt` `gantt` | 3 | 8.12 | **none** |
| `syntax.math` Math | 3 | 16.1 | **none** |
| `syntax.include` Cross-document `include` | 3 | 5.2 | **none** |
| `data.external` External data | 3 | 6.4 | **none** |
| `data.live` Live data sources | 3 | 16.1 | **none** |
| `plugin.api` Plugins | 3 | 26 | **none** |

8 requirements up to level 3 are not substantiated by a passing case:

- `type.map` — `map`
- `type.network` — `network`
- `type.gantt` — `gantt`
- `syntax.math` — Math
- `syntax.include` — Cross-document `include`
- `data.external` — External data
- `data.live` — Live data sources
- `plugin.api` — Plugins

# Sample files

`scripts/make-samples.mjs samples` writes the made-up files in this folder: `color-scheme.svg`, `no-viewbox.svg`,
`viewbox-offset.svg`, `one-pixel.svg`, `badge.svgz` and the hostile files (`hostile-script.svg`,
`hostile-entities.svg`, `hostile-huge-size.svg`, `hostile-bomb.svgz`). `scripts/rewrite-loop.mjs` rewrites an SVG
every second for the watch test.

`real/` holds unchanged copies of public files:

| File | Source | Licence |
|---|---|---|
| `w3c-*.svg` | W3C SVG 1.1 Second Edition test suite, https://www.w3.org/Graphics/SVG/Test/20110816/ | W3C Test Suite Licence (3-clause BSD) |
| `flag-of-brazil.svg` | Wikimedia Commons, File:Flag_of_Brazil.svg | Public domain |
| `material-sprite-*-symbol.svg` | google/material-design-icons 3.0.1, `sprites/svg-sprite/` | Apache License 2.0 |

The release check also opens two large public-domain maps from Wikimedia Commons that are not in the repo:
`Physical_Map_of_the_World_(2021).svg` (18.0 MB) and `CIA_World_Factbook_2021_political_world_map.svg` (52.5 MB).

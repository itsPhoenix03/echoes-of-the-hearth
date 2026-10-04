# Refined surface tile batch

Fourteen hand-authored SVG replacements for the game's surface tiles. The base names and 64×40 canvas/diamond geometry match the current tiles; game code was read only. `rock.svg` (raised/underground, 64×64) and `cavefloor.svg` (underground) are outside this batch.

Files to compare are in `before/`; replacements are in `tiles/`. Open `preview.html` or `preview.png` for a side-by-side review; `repeat-preview.html` and `repeat-preview.png` show repeated terrain patches.

Optional, currently unwired `*_variant_1.svg` and `*_variant_2.svg` files are provided for grass, sand, snow, mud, water and lava to reduce obvious repetition. They retain the same canvas and material palette while mirroring or rotating surface marks within the diamond.

Optional `*_flow_1.svg` and `*_flow_2.svg` frames are provided for water, freezing water, hot water and lava. They make small surface-mark shifts for later slow animation; no tile animation code was changed.

The design uses crisp, larger material shapes: grass clumps, sand ridges, snowdrifts, ice facets, wet mud, stone slabs, volcanic crust and water bands. Details are clipped to the diamond top. Repeated terrain should still be reviewed at game scale before any future integration.

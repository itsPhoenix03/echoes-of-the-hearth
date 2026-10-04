# Refined tree sprite batch

Seven hand-drawn SVG base replacements: `tree.svg`, `pine_tree.svg`, `snow_pine.svg`, `autumn_tree.svg`, `desert_palm.svg`, `mangrove_tree.svg`, and `blightedtree.svg`. Their filenames, canvas dimensions, and transparent backgrounds match the game originals. The game project was read only.

Open `preview.html` or `preview.png` for side-by-side review. The originals are copied to `before/` for comparison; replacement files are under `sprites/`.

Each tree also has two optional `*_sway_1.svg` and `*_sway_2.svg` frames. They pivot the crown slightly around the trunk while the roots and ground shadow stay planted. The game does not load these frames yet. Cycle frame 1 → base → frame 2 → base at a slow, species-varying cadence after integration.

The new art uses the sharper pilot approach: irregular silhouettes, lit upper-left forms, darker undersides, textured trunks or roots, and a small number of high-contrast leaf or needle marks that remain readable at native size.

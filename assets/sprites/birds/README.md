# Flying bird frame sets

Each species has three static SVG frames because Phaser rasterizes SVG files during preload. Load the three files as textures and cycle `1 -> 2 -> 3 -> 2`.

- `gull_fly_*`: temperate ocean and neutral minor islands.
- `snow_tern_fly_*`: Frozen Spire and freezing-water routes.
- `ember_kite_fly_*`: Core, volcanic islands, and hot-water routes.
- `marsh_heron_fly_*`: Marsh coast and reedbank minor islands.
- `woods_thrush_fly_*`: Whispering Woods canopy and forested minor islands.
- `dune_falcon_fly_*`: Sinking Dunes thermals and arid minor islands.

Birds are ambient server-seeded flight groups by default. Do not add them to ground wildlife collision or meat-drop logic unless hunting is intentionally implemented.

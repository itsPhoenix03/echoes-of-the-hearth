# Pickup pop effects

Art-only asset pack. No game code was changed.

- `sprites/<resource>.svg`: transparent 24 x 24 inventory/drop icon.
- `frames/<resource>_pop_01.svg` through `_pop_05.svg`: transparent 32 x 40, self-contained pop-out frames. All frames share the same canvas and ground contact point.
- `preview.html`: looping animated preview of every resource.

Resource filenames use existing inventory keys: `wood`, `stone`, `meat`, `fiber`, `crystal`, `starmetal`, `iron`, `essence`, and `diamond`.

Suggested timing: 45, 65, 75, 70, 95 ms for frames 01-05, then hold the final frame briefly or tween it toward the player/inventory. For a richer tree or rock break, spawn two or three pickups with slight horizontal offsets and staggered starts. The final collection/fly-to-inventory behavior requires game-code integration later; these files alone do not change gameplay.

Keep SVG originals as source art. If browser transfer size becomes important, rasterize a packed atlas at the game's display scale rather than requesting 45 individual frame files.

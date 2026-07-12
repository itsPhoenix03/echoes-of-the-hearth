# Raw crafting resources

Raw inputs for crafting the modular building pieces. These are inventory/resource icons, not placeable structures.

Suggested chains:
- `raw_clay` + `raw_sand` + `raw_lime` -> `clay_bricks` / mortar-style stone structures.
- `raw_sand` + `raw_ash` + heat -> `glass_pane`.
- `raw_iron_ore` + `raw_coal` -> `ingot_iron` -> `iron_beam`.
- `raw_crystal_shard` -> `crystal_lattice`.
- `raw_starmetal_nugget` -> `ingot_starmetal` -> `starmetal_plate`.
- `raw_fiber_bundle` -> `rope_coil` / `cloth_roll` / `reed_thatch`.
- `raw_hide`, `raw_resin`, `raw_bone`, dyes, oil, and beeswax support furniture, banners, lights, traps, and decorative variants.

If these become gameplay resources, add each key to `shared/defs.js` (`emptyInv`, `NAMES`, `RESOURCES` as needed), add UI icons in `src/ui.ts`, and validate all crafting costs on the server.
# Asset Pack Manifest

## How to Use

1. **Copy needed SVGs** into the game repo's `assets/` directory (Vite publicDir).
2. **Preload in `src/main.ts`** using `this.load.svg(key, path, {width, height})` — one canonical key per asset per the tables below.
3. **Reference in game code** via the texture key listed in the "Suggested Key" column.
4. **For gameplay integration** (data, collision, tests, UI icons), follow guidelines in ASSET_PLACEMENT_GUIDE.md.

---

## sprites/ — Standalone Props & Characters

| Suggested Key | Path | Role |
|---|---|---|
| ashmark_hunter | `sprites/ashmark_hunter.svg` | NPC for script/dialogue work |
| autumn_tree | `sprites/autumn_tree.svg` | Biome vegetation (general) |
| blight_armor | `sprites/blight_armor.svg` | Armor equipment visual or icon |
| blight_spore | `sprites/blight_spore.svg` | Hazard node |
| bone_totem | `sprites/bone_totem.svg` | Decorative/landmark structure |
| cactus_bloom | `sprites/cactus_bloom.svg` | Desert vegetation |
| elder_yvenne | `sprites/elder_yvenne.svg` | NPC for script/dialogue work |
| fur_cloak | `sprites/fur_cloak.svg` | Equipment visual or icon |
| glow_mushroom | `sprites/glow_mushroom.svg` | Flora node or hazard |
| heat_cloak | `sprites/heat_cloak.svg` | Equipment visual or icon |
| ice_crystal_cluster | `sprites/ice_crystal_cluster.svg` | Environmental hazard/node |
| keeper_hat | `sprites/keeper_hat.svg` | Equipment visual or icon |
| lava_vent | `sprites/lava_vent.svg` | Environmental hazard |
| mangrove_tree | `sprites/mangrove_tree.svg` | Biome vegetation (marsh) |
| moth | `sprites/moth.svg` | Ambient wildlife |
| owl | `sprites/owl.svg` | Ambient wildlife |
| pine_tree | `sprites/pine_tree.svg` | Biome vegetation (woods/spire) |
| desert_palm | `sprites/desert_palm.svg` | Biome vegetation (dunes/oases) |
| raven | `sprites/raven.svg` | Ambient wildlife |
| reed_bundle | `sprites/reed_bundle.svg` | Craft material visual |
| sand_ruin_pillar | `sprites/sand_ruin_pillar.svg` | Landmark/ruin piece |
| seal | `sprites/seal.svg` | Ambient wildlife |
| snow_pine | `sprites/snow_pine.svg` | Biome vegetation (frozen) |
| stag | `sprites/stag.svg` | Ambient wildlife |
| stone_gate | `sprites/stone_gate.svg` | Buildable/POI structure |
| watchtower | `sprites/watchtower.svg` | Buildable/POI structure |
| windmill | `sprites/windmill.svg` | Buildable/POI structure |
| woods_child | `sprites/woods_child.svg` | NPC for script/dialogue work |
| wolf | `sprites/wolf.svg` | Ambient wildlife |

---

## sprites/birds/ — Three-Frame Flight Animation Sets

Load all three frames per species and cycle: `1 → 2 → 3 → 2`.

| Suggested Key | Path | Role |
|---|---|---|
| ember_kite_fly_1 | `sprites/birds/ember_kite_fly_1.svg` | Ambient flight (frame 1) — Core, volcanic islands, hot-water routes |
| ember_kite_fly_2 | `sprites/birds/ember_kite_fly_2.svg` | Ambient flight (frame 2) |
| ember_kite_fly_3 | `sprites/birds/ember_kite_fly_3.svg` | Ambient flight (frame 3) |
| gull_fly_1 | `sprites/birds/gull_fly_1.svg` | Ambient flight (frame 1) — temperate ocean, neutral islands |
| gull_fly_2 | `sprites/birds/gull_fly_2.svg` | Ambient flight (frame 2) |
| gull_fly_3 | `sprites/birds/gull_fly_3.svg` | Ambient flight (frame 3) |
| marsh_heron_fly_1 | `sprites/birds/marsh_heron_fly_1.svg` | Ambient flight (frame 1) — marsh coast, reedbank islands |
| marsh_heron_fly_2 | `sprites/birds/marsh_heron_fly_2.svg` | Ambient flight (frame 2) |
| marsh_heron_fly_3 | `sprites/birds/marsh_heron_fly_3.svg` | Ambient flight (frame 3) |
| snow_tern_fly_1 | `sprites/birds/snow_tern_fly_1.svg` | Ambient flight (frame 1) — Frozen Spire, freezing-water routes |
| snow_tern_fly_2 | `sprites/birds/snow_tern_fly_2.svg` | Ambient flight (frame 2) |
| snow_tern_fly_3 | `sprites/birds/snow_tern_fly_3.svg` | Ambient flight (frame 3) |
| woods_thrush_fly_1 | `sprites/birds/woods_thrush_fly_1.svg` | Ambient flight (frame 1) — Whispering Woods canopy |
| woods_thrush_fly_2 | `sprites/birds/woods_thrush_fly_2.svg` | Ambient flight (frame 2) |
| woods_thrush_fly_3 | `sprites/birds/woods_thrush_fly_3.svg` | Ambient flight (frame 3) |
| dune_falcon_fly_1 | `sprites/birds/dune_falcon_fly_1.svg` | Ambient flight (frame 1) — Sinking Dunes thermals |
| dune_falcon_fly_2 | `sprites/birds/dune_falcon_fly_2.svg` | Ambient flight (frame 2) |
| dune_falcon_fly_3 | `sprites/birds/dune_falcon_fly_3.svg` | Ambient flight (frame 3) |

---

## sprites/building_materials/ — Raw Materials & Construction Modules

### Raw Materials (for UI icons or craft inventory)

| Suggested Key | Path | Role |
|---|---|---|
| clay_bricks | `sprites/building_materials/clay_bricks.svg` | Finished material icon |
| cloth_roll | `sprites/building_materials/cloth_roll.svg` | Finished material icon |
| crystal_lattice | `sprites/building_materials/crystal_lattice.svg` | Finished material icon |
| glass_pane | `sprites/building_materials/glass_pane.svg` | Finished material icon |
| iron_beam | `sprites/building_materials/iron_beam.svg` | Finished material icon |
| reed_thatch | `sprites/building_materials/reed_thatch.svg` | Finished material icon |
| rope_coil | `sprites/building_materials/rope_coil.svg` | Finished material icon |
| starmetal_plate | `sprites/building_materials/starmetal_plate.svg` | Finished material icon |
| stone_blocks | `sprites/building_materials/stone_blocks.svg` | Finished material icon |
| wood_planks | `sprites/building_materials/wood_planks.svg` | Finished material icon |

### Construction Modules (placeable in player structures)

| Suggested Key | Path | Role |
|---|---|---|
| mod_arch | `sprites/building_materials/mod_arch.svg` | Connective arch trim |
| mod_banner_blank | `sprites/building_materials/mod_banner_blank.svg` | Decorative blank banner |
| mod_bridge_segment | `sprites/building_materials/mod_bridge_segment.svg` | Walkway component |
| mod_door | `sprites/building_materials/mod_door.svg` | Entry/exit module |
| mod_floor_stone | `sprites/building_materials/mod_floor_stone.svg` | Floor variant |
| mod_floor_thatch | `sprites/building_materials/mod_floor_thatch.svg` | Floor variant |
| mod_floor_wood | `sprites/building_materials/mod_floor_wood.svg` | Floor variant |
| mod_lantern_hook | `sprites/building_materials/mod_lantern_hook.svg` | Light fixture attachment |
| mod_pillar_stone | `sprites/building_materials/mod_pillar_stone.svg` | Support column variant |
| mod_pillar_wood | `sprites/building_materials/mod_pillar_wood.svg` | Support column variant |
| mod_railing | `sprites/building_materials/mod_railing.svg` | Safety/perimeter trim |
| mod_roof_metal | `sprites/building_materials/mod_roof_metal.svg` | Roof variant |
| mod_roof_shingle | `sprites/building_materials/mod_roof_shingle.svg` | Roof variant |
| mod_roof_thatch | `sprites/building_materials/mod_roof_thatch.svg` | Roof variant |
| mod_stairs | `sprites/building_materials/mod_stairs.svg` | Vertical connection |
| mod_wall_crystal | `sprites/building_materials/mod_wall_crystal.svg` | Wall variant |
| mod_wall_stone | `sprites/building_materials/mod_wall_stone.svg` | Wall variant |
| mod_wall_wood | `sprites/building_materials/mod_wall_wood.svg` | Wall variant |
| mod_window | `sprites/building_materials/mod_window.svg` | Opening/light module |

### Raw Resource Icons (inventory/craft tracking)

| Suggested Key | Path | Role |
|---|---|---|
| raw_ash | `sprites/building_materials/raw/raw_ash.svg` | Resource icon — byproduct |
| raw_beeswax | `sprites/building_materials/raw/raw_beeswax.svg` | Resource icon — craft ingredient |
| raw_bone | `sprites/building_materials/raw/raw_bone.svg` | Resource icon — gathered material |
| raw_clay | `sprites/building_materials/raw/raw_clay.svg` | Resource icon — gathered material |
| raw_coal | `sprites/building_materials/raw/raw_coal.svg` | Resource icon — fuel |
| raw_copper_ore | `sprites/building_materials/raw/raw_copper_ore.svg` | Resource icon — ore |
| raw_crystal_shard | `sprites/building_materials/raw/raw_crystal_shard.svg` | Resource icon — ore |
| raw_dye_blue | `sprites/building_materials/raw/raw_dye_blue.svg` | Resource icon — colorant |
| raw_dye_green | `sprites/building_materials/raw/raw_dye_green.svg` | Resource icon — colorant |
| raw_dye_red | `sprites/building_materials/raw/raw_dye_red.svg` | Resource icon — colorant |
| raw_fiber_bundle | `sprites/building_materials/raw/raw_fiber_bundle.svg` | Resource icon — textile base |
| raw_hide | `sprites/building_materials/raw/raw_hide.svg` | Resource icon — animal product |
| raw_iron_ore | `sprites/building_materials/raw/raw_iron_ore.svg` | Resource icon — ore |
| raw_lime | `sprites/building_materials/raw/raw_lime.svg` | Resource icon — craft ingredient |
| raw_obsidian_shard | `sprites/building_materials/raw/raw_obsidian_shard.svg` | Resource icon — ore |
| raw_oil_pot | `sprites/building_materials/raw/raw_oil_pot.svg` | Resource icon — fuel/craft |
| raw_resin | `sprites/building_materials/raw/raw_resin.svg` | Resource icon — craft ingredient |
| raw_sand | `sprites/building_materials/raw/raw_sand.svg` | Resource icon — gathered material |
| raw_starmetal_nugget | `sprites/building_materials/raw/raw_starmetal_nugget.svg` | Resource icon — rare ore |
| raw_tin_ore | `sprites/building_materials/raw/raw_tin_ore.svg` | Resource icon — ore |
| ingot_bronze | `sprites/building_materials/raw/ingot_bronze.svg` | Resource icon — smelted alloy |
| ingot_copper | `sprites/building_materials/raw/ingot_copper.svg` | Resource icon — smelted metal |
| ingot_iron | `sprites/building_materials/raw/ingot_iron.svg` | Resource icon — smelted metal |
| ingot_starmetal | `sprites/building_materials/raw/ingot_starmetal.svg` | Resource icon — smelted alloy |

---

## sprites/core_temple/ — Core Activation POI

Fixed endgame Core Void temple pieces. Deterministic footprint; **not craftable by players**.

| Suggested Key | Path | Role |
|---|---|---|
| core_activation_dais | `sprites/core_temple/core_activation_dais.svg` | **Activation socket** — only valid World Engine tile |
| core_temple_arch_ruin | `sprites/core_temple/core_temple_arch_ruin.svg` | Optional perimeter arch element |
| core_temple_pillar_broken | `sprites/core_temple/core_temple_pillar_broken.svg` | Repeatable perimeter debris |
| core_temple_ruins | `sprites/core_temple/core_temple_ruins.svg` | Combined establishing silhouette |

---

## sprites/mountains/ — Biome Landmark Silhouettes

Large deterministic blockers and landmarks. Use sparsely in mountain chains; collision/footprint data lives in server world definitions, not the SVG.

| Suggested Key | Path | Role |
|---|---|---|
| mountain_core_obsidian | `sprites/mountains/mountain_core_obsidian.svg` | Sparse landmark — Core/volcanic obsidian ridges |
| mountain_dunes | `sprites/mountains/mountain_dunes.svg` | Sparse landmark — dunes mesas and dry ranges |
| mountain_marsh | `sprites/mountains/mountain_marsh.svg` | Sparse landmark — low mossy crags around Marsh high ground |
| mountain_spire | `sprites/mountains/mountain_spire.svg` | Sparse landmark — Frozen Spire peaks |
| mountain_woods | `sprites/mountains/mountain_woods.svg` | Sparse landmark — Woods ridges |

---

## tiles/ — Ground Variants & Water States

Optional terrain overlay/replacement tiles. All tiles have consistent isometric footprint: `width="64" height="40" viewBox="0 0 64 40"`.

| Suggested Key | Path | Role |
|---|---|---|
| ash | `tiles/ash.svg` | Scorched ground overlay — use in burned/volcanic zones |
| flower_grass | `tiles/flower_grass.svg` | Ground variant — grassland with small flowers |
| cracked_sand | `tiles/cracked_sand.svg` | Ground variant — parched dunes interior (base sand palette) |
| packed_ice | `tiles/packed_ice.svg` | Ground variant — Frozen Spire glazed ice (base snow palette) |
| moss_stone | `tiles/moss.svg` | Ground variant — stone with moss overgrowth |
| water_freezing | `tiles/water_freezing.svg` | Water variant — **near Frozen Spire**, driven by shared water-temperature data |
| water_hot | `tiles/water_hot.svg` | Water variant — **near Core**, driven by shared water-temperature data |

---

## Integration Checklist

- [ ] Copy SVGs to `game-repo/assets/`
- [ ] Add `this.load.svg(key, path, {width, height})` calls in `src/main.ts` for each asset
- [ ] For gameplay assets (buildings, hazards, resources), add data defs in `shared/defs.js`
- [ ] For UI icons, integrate into `src/ui.ts`
- [ ] For server-visible behavior (collision, collision footprints, interactions), add to `shared/server` world data
- [ ] Add tests for any new gameplay mechanics
- [ ] Reference original AGENT_GUIDE.html for additional integration hints

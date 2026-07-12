# Echoes of the Hearth Asset Placement Guide

This guide explains how to use the extra asset pack without breaking the game world's biome logic, visual language, or progression. The assets are optional additions for `echoes-of-the-hearth`; they are not wired into gameplay until you add data definitions, preload entries, recipes, world placement rules, and server validation.

## Source And Runtime Locations

`../assets` is a sibling staging pack, not the game's Vite public directory. The current Vite configuration serves only `<repo>/assets` as `/`.

Before referencing a new SVG from code, copy only the selected files into the same relative path under the repository:

```text
../assets/sprites/pine_tree.svg
  -> <repo>/assets/sprites/pine_tree.svg
  -> runtime URL /sprites/pine_tree.svg

../assets/sprites/building_materials/raw/raw_clay.svg
  -> <repo>/assets/sprites/building_materials/raw/raw_clay.svg
  -> runtime URL /sprites/building_materials/raw/raw_clay.svg
```

Do not point Phaser or DOM markup at `../assets`; that path is not deployed by Vite. Do not bulk-copy over existing files with the same name without comparing them first.

Each integrated asset needs one canonical key, one runtime path, and one role. Record these in a small registry or adjacent constants so preload, rendering, recipes, and tests do not invent different names.

## Choose One Asset Role First

| Role | Canonical state owner | Required integration |
|---|---|---|
| Visual-only deterministic decoration | `shared/world.js` returns a decoration collection; client renders it | Shared seeded placement, client preload/render; no inventory or server mutation |
| Harvestable node | `world.nodes` plus authoritative mutation state | `NODE`, `NODE_KEYS`, `NODE_DEF`, inventory key, client sprite map, server gather flow, persistence/test |
| Wildlife or monster | Server simulation maps | Server spawn/AI/drop table, network type, client preload/type map, tests |
| Inventory or crafting icon | Player profile/inventory on server | `emptyInv`, `NAMES`, `RESOURCES` when appropriate, `RECIPES`, UI rendering, persistence/test |
| Player-built module | Authoritative structure/module state | Recipe, placement validation, slot/collision rules, protocol, persistence, client render, tests |
| Static POI or NPC | Shared placement plus server-owned interaction state | Deterministic location, interaction protocol, client render, persistence when mutable |
| Ground visual variant | Tile semantics or a separate visual-variant layer | Shared deterministic selection and client rendering; update `T` only if gameplay semantics change |

Do not put decorative props in `world.nodes` merely to make them appear. Every entry in `world.nodes` is treated as gatherable by the generic server flow and requires a valid `NODE_DEF`.

## Core Rules

- Match assets to biome first, then gameplay purpose. Do not place a visually correct asset if it contradicts the biome.
- Natural world assets belong in `shared/world.js` placement rules. Player-built/crafted assets belong in `shared/defs.js` recipes and server-validated `build` flows.
- Inventory and crafting icons belong in `src/ui.ts`. World sprites must be preloaded and mapped in `src/main.ts`.
- Any server-visible resource, recipe, structure, node, or crafting cost must be validated by `server/index.js`, not only the client.
- If an asset changes world generation, stale saves can place structures/nodes on invalid terrain. Bump seed or delete `server/save.json` during testing.
- World generation must use seeded noise or an `alea(seed + purpose)` stream. Never use `Math.random()` in deterministic placement.
- Preserve the current index invariant: `NODE_KEYS[NODE.X]` and `NODE_DEF[NODE.X]` must describe the same node. Append new numeric node kinds; do not reorder existing values in a save-compatible world.
- Keep gameplay terrain and visual variants separate. `T`, `TILE_KEYS`, server biome checks, environmental damage, mining, wildlife, and client rendering currently share numeric tile semantics.
- Keep placement clear of monoliths, Core, spawn, notes, and structure footprints. Reuse or expand `nearPOI()` instead of relying on low random density.

## Biome Asset Groups

### Whispering Woods / Grass Island

Use for: early game gathering, wood/fiber progression, deer-like animals, Hearthfolk NPCs, low-tier structures.

Good assets:
- `sprites/pine_tree.svg`
- `sprites/autumn_tree.svg`
- `sprites/stag.svg`
- `sprites/owl.svg`
- `sprites/woods_child.svg`
- `sprites/watchtower.svg`
- `sprites/windmill.svg`
- `sprites/mountains/mountain_woods.svg`
- `sprites/birds/gull_fly_1.svg` through `gull_fly_3.svg` near coasts
- `tiles/flower_grass.svg`
- `sprites/building_materials/raw/raw_resin.svg`
- `sprites/building_materials/raw/raw_fiber_bundle.svg`
- `sprites/building_materials/raw/raw_hide.svg`
- `sprites/building_materials/raw/raw_beeswax.svg`

Avoid here:
- `snow_pine`, `seal`, `ice_crystal_cluster` unless near a snow event or special frozen POI.
- `cactus_bloom`, `sand_ruin_pillar` unless placed as imported ruins or rare traveler camp decor.
- `lava_vent`, `obsidian_shard` unless used in late-game Core/underground content.

Suggested implementation:
- Add tree variants as decorative or harvestable nodes in `shared/world.js` on grass tiles only.
- Add stag/owl as wildlife variants in server animal spawn logic for Woods.
- Use resin, fiber, hide, and beeswax as optional resource drops from trees, bushes, animals, or hives.

### Sunken Dunes / Desert Island

Use for: heat survival, clay/sand/glass progression, ruins, cactus vegetation, desert traders/hunters.

Good assets:
- `sprites/cactus_bloom.svg`
- `sprites/sand_ruin_pillar.svg`
- `sprites/ashmark_hunter.svg`
- `sprites/mountains/mountain_dunes.svg`
- `tiles/ash.svg` only for scorched patches, not default sand.
- `sprites/building_materials/raw/raw_sand.svg`
- `sprites/building_materials/raw/raw_clay.svg`
- `sprites/building_materials/raw/raw_lime.svg`
- `sprites/building_materials/raw/raw_dye_red.svg`
- `sprites/building_materials/clay_bricks.svg`
- `sprites/building_materials/glass_pane.svg`
- `sprites/building_materials/mod_roof_shingle.svg`

Avoid here:
- `snow_pine`, `seal`, `ice_crystal_cluster`, `fur_cloak` as placed world objects.
- `mangrove_tree`, `reed_bundle` except at rare oasis/wetland edges.
- `pine_tree` as normal vegetation.

Suggested implementation:
- Place cactus on sand tiles away from coastlines.
- Place sand ruin pillars near monolith clues or desert POIs.
- Use sand + ash/lime + heat for glass crafting.
- Use clay + lime for clay bricks or stronger desert-style walls.

### Frozen Spire / Snow Island

Use for: cold survival, crystal progression, ice hazards, seals/foxes/hare-style animals, snow vegetation.

Good assets:
- `sprites/snow_pine.svg`
- `sprites/seal.svg`
- `sprites/ice_crystal_cluster.svg`
- `sprites/fur_cloak.svg`
- `sprites/mountains/mountain_spire.svg`
- `sprites/birds/snow_tern_fly_1.svg` through `snow_tern_fly_3.svg`
- `tiles/water_freezing.svg` for surrounding water visual variants
- `sprites/building_materials/raw/raw_crystal_shard.svg`
- `sprites/building_materials/crystal_lattice.svg`
- `sprites/building_materials/mod_wall_crystal.svg`
- `tiles/moss_stone.svg` only for exposed ancient stone, not common snow ground.

Avoid here:
- `cactus_bloom`, `sand_ruin_pillar`, `heat_cloak` as placed world objects.
- `mangrove_tree` and `reed_bundle` except in an intentionally thawed magical POI.
- `lava_vent` unless the area is explicitly volcanic or deep underground.

Suggested implementation:
- Use `ice_crystal_cluster` as a crystal node variant or decorative monolith-adjacent prop.
- Keep seal spawns near coast/iceberg water, not deep inland.
- Use crystal shards for advanced building modules or a light-emitting wall tier.

### Sable Marsh / Mud Island

Use for: wetland resources, reeds, mangroves, elder/shaman NPCs, dyes, bone/totem decor, swamp ruins.

Good assets:
- `sprites/mangrove_tree.svg`
- `sprites/reed_bundle.svg`
- `sprites/elder_yvenne.svg`
- `sprites/bone_totem.svg`
- `sprites/glow_mushroom.svg`
- `sprites/raven.svg`
- `sprites/moth.svg`
- `sprites/mountains/mountain_marsh.svg`
- `sprites/birds/marsh_heron_fly_1.svg` through `marsh_heron_fly_3.svg`
- `tiles/moss_stone.svg`
- `sprites/building_materials/raw/raw_dye_green.svg`
- `sprites/building_materials/raw/raw_bone.svg`
- `sprites/building_materials/raw/raw_oil_pot.svg`
- `sprites/building_materials/reed_thatch.svg`
- `sprites/building_materials/mod_floor_thatch.svg`
- `sprites/building_materials/mod_roof_thatch.svg`

Avoid here:
- `snow_pine`, `seal`, `ice_crystal_cluster`.
- `cactus_bloom` unless at a dry, raised patch.
- Heavy metal/stone architecture everywhere; use it as ruins, not default marsh housing.

Suggested implementation:
- Place reeds at mud/water edges.
- Place mangroves on mud tiles near shallow water.
- Use glow mushrooms underground or in dark marsh pockets.
- Use reeds/fiber for thatch floors and roofs.

### Core Void / Endgame Island

Use for: cosmic corruption, endgame metals, obsidian, ash, lava, blight, final engine/defense content.

Good assets:
- `sprites/lava_vent.svg`
- `sprites/blight_spore.svg`
- `sprites/blight_armor.svg`
- `sprites/stone_gate.svg`
- `sprites/core_temple/core_temple_ruins.svg`
- `sprites/core_temple/core_activation_dais.svg`
- `sprites/core_temple/core_temple_arch_ruin.svg`
- `sprites/core_temple/core_temple_pillar_broken.svg`
- `sprites/mountains/mountain_core_obsidian.svg`
- `sprites/birds/ember_kite_fly_1.svg` through `ember_kite_fly_3.svg`
- `tiles/water_hot.svg` for water near lava/thermal sources
- `tiles/ash.svg`
- `sprites/building_materials/raw/raw_obsidian_shard.svg`
- `sprites/building_materials/raw/raw_ash.svg`
- `sprites/building_materials/raw/raw_starmetal_nugget.svg`
- `sprites/building_materials/ingot_starmetal.svg`
- `sprites/building_materials/starmetal_plate.svg`
- `sprites/building_materials/mod_roof_metal.svg`
- `sprites/building_materials/mod_wall_crystal.svg`

Avoid here:
- Friendly village assets unless deliberately showing refugees or protected camps.
- Common early-game vegetation as normal flora. If used, make it blighted/corrupted.
- Desert or snow wildlife unless part of a scripted convergence event.

Suggested implementation:
- Use lava vents as hazards, not common decoration.
- Use ash tiles for scorched terrain overlays near vents or engine structures.
- Use starmetal/obsidian as rare endgame crafting inputs.
- Reserve the activation dais at exact `CORE`; the World Engine must snap to this socket rather than any nearby tile.

## Thermal Water, Mountains, Temple, And Birds

### Thermal Water Tiles

`water_freezing.svg` and `water_hot.svg` are visual variants of `T.WATER`. Do not append them to `TILE_KEYS` as new terrain values.

Use a shared `waterTemp` array returned by `genWorld(seed)`:

- Temperate water renders the existing `water` texture.
- Freezing water renders `water_freezing` and is valid near Frozen Spire, ice floes, and snow minor islands.
- Hot water renders `water_hot` and is valid near Core lava vents, obsidian ridges, and volcanic minor islands.
- Server swimmer damage uses `waterTemp`; the SVG color is only feedback.
- Do not create hot water beside Woods/Spire or freezing water beside Dunes/Core unless a named anomaly explicitly overrides normal placement.

### Core Temple Asset Set

Folder: `sprites/core_temple`

These are fixed POI assets, not craftable structures:

- `core_temple_ruins.svg`: combined temple silhouette/establishing structure.
- `core_activation_dais.svg`: exact socket for final activation/World Engine placement.
- `core_temple_arch_ruin.svg`: perimeter entrance/arch pieces.
- `core_temple_pillar_broken.svg`: repeatable broken perimeter pillars.

Placement contract:

- Flatten and clear a deterministic radius around `CORE` before nodes/mountains are placed.
- Put the dais at `ACTIVATION_I = CORE[1] * SIZE + CORE[0]`.
- Keep two or more approach gaps and defense-building room outside the temple footprint.
- Temple collision belongs in shared/server POI footprint data.
- Do not save deterministic ruin pieces as player structures; save only mutable activation/damage state.
- Do not allow normal module placement on the dais or inside reserved ruin slots.

### Mountain Asset Set

Folder: `sprites/mountains`

Mountains are large landmarks with authoritative footprints:

| Asset | Allowed region | Placement notes |
|---|---|---|
| `mountain_woods.svg` | Woods | Interior elevation-3 ridges; keep spawn and forest paths open. |
| `mountain_dunes.svg` | Dunes | Mesa chains away from beaches and monolith route. |
| `mountain_spire.svg` | Spire | Most common mountain; preserve at least one climbable inland corridor. |
| `mountain_marsh.svg` | Marsh | Sparse low crags on raised mud, never in water/reed channels. |
| `mountain_core_obsidian.svg` | Core/volcanic minor islands | Keep temple entrances clear; may define hot-water source regions. |

Do not put mountains in `world.nodes`. Return a separate deterministic mountain collection containing anchor, kind, and footprint. If blocked, every footprint tile must be checked by the server and client; one large sprite with one blocked anchor allows players to walk through its sides.

### Flying Bird Frame Sets

Folder: `sprites/birds`

Each species has three static frames. Load and animate them in order `1,2,3,2` because Phaser rasterizes SVGs at preload time.

| Species | Correct placement | Avoid |
|---|---|---|
| Gull | Temperate coasts, open ocean, neutral islets | Deep Core/Spire thermal zones |
| Snow tern | Freezing water, Spire, ice floes | Dunes and hot water |
| Ember kite | Core, volcanic islets, hot-water routes | Woods starter coast |
| Marsh heron | Marsh coast, reedbanks, shallow channels | Frozen or volcanic routes |

Birds should be ambient, non-colliding, and camera-streamed by default. Do not add them to `ANIMAL_TYPES` or grant meat drops unless hunting is intentionally designed and server-authoritative.

## Universal Player-Building Assets

These can be used in any biome if the player crafts and places them. Visual mismatch is acceptable when player-authored, but crafting costs should still make sense.

### Raw Inputs

Folder: `sprites/building_materials/raw`

Use as inventory/resource icons:
- `raw_clay.svg`: clay deposits, marsh/desert banks.
- `raw_sand.svg`: desert/coast sand gathering.
- `raw_iron_ore.svg`: mines and underground veins.
- `raw_copper_ore.svg`: optional early metal tier.
- `raw_tin_ore.svg`: optional bronze chain.
- `raw_coal.svg`: fuel for smelting/glass.
- `raw_crystal_shard.svg`: Frozen Spire and rare Marsh crystals.
- `raw_starmetal_nugget.svg`: rare Woods/Dunes/Marsh endgame node.
- `raw_obsidian_shard.svg`: Core/deep lava zones.
- `raw_lime.svg`: stone/desert deposits, mortar/glass chain.
- `raw_ash.svg`: fire/lava/charcoal byproduct.
- `raw_resin.svg`: trees, used in sealants/torches.
- `raw_hide.svg`: animal drops, used for cloaks/furniture.
- `raw_fiber_bundle.svg`: bushes/reeds, used for rope/cloth/thatch.
- `raw_bone.svg`: animal/monster drops, totems/tools/decor.
- `raw_oil_pot.svg`: marsh/core resource, lamps/fire traps.
- `raw_beeswax.svg`: woods resource, candles/waterproofing.
- `raw_dye_red.svg`, `raw_dye_blue.svg`, `raw_dye_green.svg`: banners/clothing/decor variants.
- `ingot_iron.svg`, `ingot_copper.svg`, `ingot_bronze.svg`, `ingot_starmetal.svg`: smelted intermediates.

### Canonical Resource-Key Decision

Several new SVG filenames describe resources that already exist in gameplay. Prefer reusing the current inventory key unless the design intentionally adds a separate processing stage:

| Asset file | Recommended current key | Add a new key only when |
|---|---|---|
| `raw_fiber_bundle.svg` | `fiber` | distinct raw and processed fiber have different recipes |
| `raw_crystal_shard.svg` | `crystal` | shards must be refined before existing crystal recipes |
| `raw_starmetal_nugget.svg` | `starmetal` | smelting nuggets into ingots becomes a real progression gate |
| `raw_iron_ore.svg` | `iron` | ore and usable iron become separate inventory states |
| `raw_sand.svg` | new `sand` | always new; no current equivalent |
| `raw_clay.svg` | new `clay` | always new; no current equivalent |

Avoid creating `raw_iron_ore` alongside existing `iron` only because the icon filename contains `raw_`. That duplicates inventory concepts without gameplay value. Asset filenames do not have to equal inventory keys; the UI asset map can map `iron` to the ore SVG.

When a genuinely new key is added, update `emptyInv()` so `canAfford()` never compares a recipe cost against `undefined`, include it in profile migration/defaulting, and add it to the dev kit if agents need to test recipes quickly.

### Processed Building Materials

Folder: `sprites/building_materials`

Use as crafted inventory items or recipe outputs:
- `wood_planks.svg`: wood -> floors, walls, doors, stairs.
- `stone_blocks.svg`: stone + lime -> stone walls, arches, pillars.
- `clay_bricks.svg`: clay + sand/lime -> brick walls/roofs.
- `reed_thatch.svg`: reeds/fiber -> thatch roof/floor.
- `iron_beam.svg`: iron ingots -> metal roofs, reinforced walls, towers.
- `crystal_lattice.svg`: crystal shards -> crystal walls/lights.
- `starmetal_plate.svg`: starmetal ingots -> endgame modules.
- `rope_coil.svg`: fiber/reeds -> bridges, railings, banners.
- `cloth_roll.svg`: fiber/hide/dyes -> banners, beds, curtains, clothing.
- `glass_pane.svg`: sand + ash/lime + coal/heat -> windows/greenhouse pieces.

### Placeable Modules

Folder: `sprites/building_materials`

Use as structure sprites or module variants:
- `mod_floor_wood.svg`: common player floor.
- `mod_floor_stone.svg`: durable floor, ruins, Core builds.
- `mod_floor_thatch.svg`: marsh/early shelter floor.
- `mod_wall_wood.svg`: early wall.
- `mod_wall_stone.svg`: durable wall.
- `mod_wall_crystal.svg`: late-game/light wall.
- `mod_roof_thatch.svg`: woods/marsh/desert huts.
- `mod_roof_shingle.svg`: woods/desert permanent buildings.
- `mod_roof_metal.svg`: late-game/reinforced builds.
- `mod_window.svg`: needs glass pane + wood/stone.
- `mod_door.svg`: needs planks + rope/iron.
- `mod_stairs.svg`: multi-level or decorative player builds.
- `mod_pillar_wood.svg`, `mod_pillar_stone.svg`: supports, porches, ruins.
- `mod_railing.svg`: bridges, balconies, docks.
- `mod_arch.svg`: stone gates/ruins.
- `mod_bridge_segment.svg`: water crossing, docks, ravines.
- `mod_banner_blank.svg`: player identity/settlement marker, tintable with dyes.
- `mod_lantern_hook.svg`: light fixture, needs oil/beeswax/iron.

## Recommended Crafting Chains

Simple chains:
- `wood` -> `wood_planks` -> wood floors, wood walls, doors, stairs.
- `stone` + `raw_lime` -> `stone_blocks` -> stone walls, pillars, arches.
- `raw_clay` + `raw_sand` + `raw_lime` -> `clay_bricks` -> brick/shingle structures.
- `raw_fiber_bundle` -> `rope_coil` -> bridge segments, railings, banners.
- `raw_fiber_bundle` + dyes -> `cloth_roll` -> banners, bed variants, curtains.
- `reed_bundle` or `raw_fiber_bundle` -> `reed_thatch` -> thatch floors/roofs.

Advanced chains:
- `raw_iron_ore` + `raw_coal` -> `ingot_iron` -> `iron_beam` -> reinforced modules.
- `raw_sand` + `raw_ash` + `raw_lime` + heat -> `glass_pane` -> windows.
- `raw_crystal_shard` + `stone_blocks` -> `crystal_lattice` -> crystal walls/lights.
- `raw_starmetal_nugget` + forge -> `ingot_starmetal` -> `starmetal_plate` -> endgame modules.
- `raw_obsidian_shard` + starmetal/crystal -> Core-tier defensive modules.

## Code Integration Map

### Natural Nodes and Wildlife

Use when the asset should appear as part of world generation or simulation.

Files to touch:
- `shared/defs.js`: add node/resource names, yields, HP, required tools, inventory keys.
- `shared/world.js`: place nodes only on valid biome tiles.
- `src/main.ts`: preload sprite and add render mapping.
- `server/index.js`: only if special behavior is needed. Generic gathering can use existing node flow.
- `test.mjs`: add protocol coverage for any new server-visible behavior.

Current node contract:

- `world.nodes` stores `tileIndex -> numeric NODE kind`.
- `NODE_KEYS[kind]` supplies the client render key.
- `NODE_DEF[kind]` supplies server HP, tool requirement, yield, and respawn.
- `NODE_SPR` in `src/main.ts` maps that render key to a texture and explicit rasterization size.
- `removed` and `nodeHp` are server mutations keyed by tile index.

For a harvestable tree variant, choose one implementation deliberately:

1. New gameplay node kind: append a new `NODE` value, `NODE_KEYS` entry, and `NODE_DEF` entry. Use this when yield, HP, tool, or respawn differs.
2. Visual variant of an existing tree: keep `NODE.TREE` semantics and return a deterministic `nodeVariants` map keyed by tile index. Use this when only appearance differs.

Do not replace `NODE_KEYS` ordering to select random art; that changes every numeric node interpretation. Do not infer a random variant independently in the client with `Math.random()`, because reconnects and different clients will disagree.

Correct examples:
- `snow_pine` placement condition checks `tile === T.SNOW`.
- `cactus_bloom` placement condition checks `tile === T.SAND`.
- `mangrove_tree` placement condition checks `tile === T.MUD` and adjacency to water.
- `ice_crystal_cluster` placement condition checks Snow/Spire or underground crystal vein.

Incorrect examples:
- Placing `snow_pine` by random land tile without checking biome.
- Adding `raw_iron_ore` only to UI without server inventory support.
- Letting client mutate resources directly after a click.

Wildlife does not use `world.nodes`. Add a type to the server's `ANIMAL_TYPES`/spawn logic, broadcast that type in `cre.a`, preload the SVG, and map the type to a client texture. Derive biome fallback locations from `ISLES`; the current server contains hardcoded coordinate rectangles that must move with a map expansion.

### Decorative Props And Tile Variants

Use a separate deterministic collection for non-interactive props, for example `decor: Map<tileIndex, decorKind>`. Both client and server may generate it, but only the client needs sprites unless a prop blocks movement or can change. Apply biome, adjacency, density, POI-clearance, and minor-island supply rules while generating the collection.

The three extra tile SVGs are visual variants, not automatically new gameplay biomes:

- `flower_grass.svg` should normally render as a deterministic variant of `T.GRASS`.
- `moss_stone.svg` should normally be a floor/decal or POI visual over an existing biome.
- `ash.svg` should normally be an overlay/variant for scorched `T.BLIGHT` or explicit hazard tiles.

If a variant does not change movement, weather, mining, spawning, or damage, keep the underlying `world.tiles[i]` value unchanged and store/render the visual key separately. If it does change gameplay, add a new `T` value and audit every `T.*` comparison in `shared/world.js`, `server/index.js`, and `src/main.ts`, plus `TILE_KEYS` index alignment.

Thermal water is the important exception to “visual-only variant”: keep the underlying tile as `T.WATER`, but return a separate semantic `waterTemp` array used by both server and client. The rendering key follows temperature; swimmer damage follows the shared array.

For mountains and Core temple pieces, use a deterministic POI/landmark collection with footprints. The client renders the anchor sprite while server/client collision checks use all footprint tiles. Clear footprints before node placement so harvestables never spawn underneath large landmarks.

Ambient birds may be generated from deterministic region/flock definitions and rendered camera-locally. They need no server state while non-interactive. Their flight root, frame phase, and path can be seeded; exact frame synchronization between clients is not gameplay-critical.

### Crafting Resources and Materials

Use when the asset is an inventory icon or crafted intermediate.

Files to touch:
- `shared/defs.js`: `emptyInv`, `NAMES`, `RESOURCES` if shown as a resource, `RECIPES` if craftable.
- `src/ui.ts`: display mapping for each inventory/crafting item.
- `server/index.js`: recipe validation already uses defs, but add station/tool checks if needed.
- `test.mjs`: verify crafting costs and rejection when missing materials.

Current `src/ui.ts` returns emoji strings from `icon(k)`. To display these SVGs in the DOM UI, change the helper/render contract to return safe HTML markup or a structured icon path and update every call site consistently. Keep signature-based UI rebuilding; do not create Phaser textures for inventory-only icons and do not rebuild the DOM every frame.

Do not add raw material icons only to the asset folder and expect gameplay to know about them. The server must know each inventory key.

### Player-Built Structures

Use when the asset is placeable by players.

Files to touch:
- `shared/defs.js`: add recipe, placeable flag, structure HP if structure-like.
- `src/main.ts`: preload and add structure sprite size/mapping.
- `server/index.js`: validate build location, inventory cost, stacking/collision/persistence.
- `test.mjs`: build placement, invalid placement, persistence if saved.

Recommended stored shape:
- Existing structures use `[i, kind, hp, dir, lvl]`.
- Do not force modular construction into the existing one-entry-per-tile `structures: Map<i, structure>` model. It cannot represent a floor, two wall edges, a roof, and a lantern on the same tile.
- Keep legacy structures as-is during migration, and add a dedicated module collection keyed by stable module ID or `tile:slot`.
- If changing save format, handle old saves or delete `server/save.json` during development.

Recommended module model:

```ts
type ModuleSlot = 'floor' | 'wallNE' | 'wallNW' | 'roof' | 'fixture' | 'decor';

type BuiltModule = {
  id: string;
  i: number;
  slot: ModuleSlot;
  kind: string;
  hp: number;
  dir: 0 | 1;
  owner: string;
  variant?: string;
  tint?: number;
};
```

Server placement rules:

- Validate integer/in-bounds tile index, distance, owned item, known kind, valid slot, and allowed orientation before consuming inventory.
- Reject an occupied `tile:slot`; permit other compatible slots on the same tile.
- Floors are non-blocking. Wall edges block crossing that edge, not the entire tile. Roofs are visual/shelter state. Fixtures require a compatible floor/wall/roof anchor.
- Bridge segments may be placed over water only under explicit support/adjacency rules. The current `blocked()` and `build` handler reject water, so bridge placement and movement require dedicated server and client logic.
- Validate support when removing/damaging modules. Decide whether unsupported pieces are rejected, cascade-destroyed with refunds, or allowed as decoration; apply one rule server-side.
- Persist module IDs and slots, and include them in join initialization. Do not overload legacy `lvl` to mean roof/floor layering.

Client rendering rules:

- Use explicit preload sizes based on each SVG `viewBox`; Phaser's `load.svg` calls in this project rasterize to supplied dimensions.
- Floors use tile-aligned origins and depth below characters. Walls/pillars use ground-contact origins and normal y-depth sorting. Roofs render above their supporting walls but must fade/hide when they obscure the local player.
- Current `dir` is only `0/1` and wall art uses horizontal flipping. If four orientations become necessary, create orientation-specific isometric art or a tested transform; arbitrary 90-degree rotation of an isometric SVG will usually look wrong.
- Placement preview and server validation must share the same rule names. Green preview is advisory; only the server consumes the item and confirms placement.

Suggested protocol seam:

```json
{ "t": "buildmod", "seq": 17, "i": 1234, "kind": "mod_wall_stone", "slot": "wallNE", "dir": 0 }
{ "t": "module", "seq": 17, "module": { "id": "m42", "i": 1234, "kind": "mod_wall_stone", "slot": "wallNE", "dir": 0, "hp": 40 } }
```

Return a rejection message containing `seq` when validation fails so the client can clear or retain its preview without guessing. Derive cost and HP from shared definitions; never accept them from the client.

## Placement Safety Checklist

Before adding any asset to world generation:

1. Does it belong to one biome or multiple biomes?
2. Does it require adjacency to water, coast, lava, cave, monolith, or structure?
3. Is it decorative, harvestable, hostile, friendly, or player-built?
4. Does the server own its gameplay behavior?
5. Is it added to `NAMES`, inventory shape, UI icon map, recipes, and tests if it is a resource?
6. Is the sprite preloaded before use?
7. Does it need a collision rule or can players walk through it?
8. Does adding it to worldgen require a seed bump or save deletion?
9. If it is a large mountain/ruin, is its complete footprint authoritative and are required routes still open?
10. If it is a water visual, does shared semantic data drive both rendering and server damage?
11. If it is animated SVG art, has it been supplied as static frames compatible with Phaser rasterization?

## Quick Biome Matrix

| Asset | Woods | Dunes | Spire | Marsh | Core | Notes |
|---|---:|---:|---:|---:|---:|---|
| `pine_tree` | Yes | No | Rare | No | No | Woods evergreen variant. |
| `autumn_tree` | Yes | No | No | Rare | No | Good for Woods edge or old groves. |
| `snow_pine` | No | No | Yes | No | No | Snow biome only. |
| `mangrove_tree` | No | Oasis only | No | Yes | No | Needs mud/water edge. |
| `cactus_bloom` | No | Yes | No | Dry patch only | No | Sand/desert only. |
| `stag` | Yes | No | No | Rare | No | Woods wildlife. |
| `wolf` | Yes | Rare | Yes | No | No | Forest/snow predator. |
| `owl` | Yes | No | Rare | Yes | No | Night/forest/marsh. |
| `raven` | Rare | Ruins | Rare | Yes | Yes | Works near ruins/blight. |
| `seal` | No | No | Coast only | No | No | Snow coastline/ice. |
| `moth` | Yes | No | No | Yes | Blight variant | Night/glow areas. |
| `sand_ruin_pillar` | No | Yes | No | Ruins only | Rare | Desert ruins. |
| `bone_totem` | No | Rare | No | Yes | Blight | Marsh tribe or hostile decor. |
| `glow_mushroom` | Cave | No | Cave | Yes | Cave | Underground/dark areas. |
| `lava_vent` | No | No | Deep only | No | Yes | Hazard, not decoration spam. |
| `ice_crystal_cluster` | No | No | Yes | Rare | No | Crystal node/decor. |
| `blight_spore` | Infected | Infected | Infected | Infected | Yes | Use with infection/blight. |
| `ashmark_hunter` | Visitor | Yes | No | Story | No | NPC, not random wildlife. |
| `elder_yvenne` | No | No | No | Yes | No | Marsh NPC. |
| `woods_child` | Yes | No | No | No | No | Hearthfolk camp NPC. |
| `fur_cloak` | Craft icon | No | Yes | No | No | Gear icon, not world prop. |
| `heat_cloak` | Craft icon | Yes | No | No | No | Desert survival gear. |
| `blight_armor` | No | No | No | Rare | Yes | Endgame/corrupted gear. |
| `mountain_woods` | Yes | No | No | No | No | Interior Woods ridges only. |
| `mountain_dunes` | No | Yes | No | No | No | Desert mesa chains. |
| `mountain_spire` | No | No | Yes | No | No | Primary Spire peak silhouette. |
| `mountain_marsh` | No | No | No | Yes | No | Raised mud crags only. |
| `mountain_core_obsidian` | No | Volcanic POI | No | No | Yes | Can define hot-water source. |
| `core_temple_*` | No | No | No | No | Yes | Fixed activation POI, not player-built. |
| `gull_fly_*` | Coast | Coast | No | Rare | No | Temperate ocean indicator. |
| `snow_tern_fly_*` | No | No | Yes | No | No | Freezing-water indicator. |
| `ember_kite_fly_*` | No | Volcanic only | No | No | Yes | Hot-water/Core indicator. |
| `marsh_heron_fly_*` | No | No | No | Yes | No | Reedbank and Marsh coast. |
| `water_freezing` | No | No | Surrounding water | No | No | Visual for `waterTemp=FREEZING`. |
| `water_hot` | No | Volcanic only | No | No | Surrounding water | Visual for `waterTemp=HOT`. |

## Recommended Implementation Order

1. Select a small vertical slice: one decorative variant, one harvestable node or raw material, one processed recipe, and one placeable module. Do not integrate the entire pack in one schema change.
2. Copy selected SVGs into `<repo>/assets` and add a canonical asset/key registry with explicit preload dimensions.
3. Add shared definitions and inventory defaults before adding recipes that reference the keys.
4. Add deterministic placement for natural content and verify biome/POI predicates with a fixed seed.
5. Add server validation, mutation state, persistence, and join synchronization.
6. Add client preload/render/UI support only after the shared/server keys are fixed.
7. Add protocol tests for accept/reject/cost/persistence behavior, then perform two-client visual checks.
8. Expand the vertical slice to the next biome/material group only after save compatibility and migration behavior are defined.

## Verification Matrix

Automated checks should cover:

- Same seed produces identical node/decor/variant counts and tile indices on repeated generation.
- Every generated asset satisfies its biome and adjacency predicate.
- No generated prop overlaps spawn, monolith clearance, Core clearance, notes, or another exclusive object.
- Unknown inventory, recipe, node, module kind, slot, direction, and out-of-range tile payloads are rejected without consuming resources.
- Crafting deducts exactly the declared cost and cannot run without its station/materials.
- Module placement supports compatible slots on one tile and rejects duplicate/incompatible slots.
- Save/load and a fresh join reproduce removed nodes, structures/modules, variants, and inventories.

Manual checks should cover:

- No missing-texture boxes or 404s in the browser network panel.
- Ground-contact sprites use correct origin/depth and do not float or sink on elevated tiles.
- Biome sweeps show no accidental snow/desert/marsh crossover.
- Two clients see the same harvested node, wildlife type, placed module, orientation, tint, and destruction result.
- Inventory icons remain legible at actual HUD size, not only at source SVG size.
- Floors, walls, roofs, doors, windows, bridges, and fixtures compose without z-order flicker or whole-tile collision errors.

Definition of done for an integrated asset: its file is deployed under `<repo>/assets`, its canonical key and role are documented in code, deterministic/server ownership is correct, invalid placements/actions are rejected, save/join state is preserved, `npm run build` passes, and `node test.mjs` passes against a fresh server when server/shared behavior changed.

## Final Rule

Biome-specific assets should enter the world through biome-specific placement rules. Crafted/player-built assets can appear anywhere only after the player paid the recipe cost and the server accepted the placement. This distinction prevents mismatches like desert snow pines while still allowing players to build strange custom settlements if they earned the materials.

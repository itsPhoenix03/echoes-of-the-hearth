# Echoes of the Hearth - extra asset pack

Sibling asset pack generated for optional integration into the game. Files are hand-written SVGs using the existing flat shaded style: compact dimensions, simple silhouettes, and a soft ground shadow ellipse for sprites.

**For a complete asset catalog with texture keys and integration guidance, see [MANIFEST.md](./MANIFEST.md).**

Feature guides: [PLAYER_BUILDING_CUSTOMIZATION_GUIDE.md](./PLAYER_BUILDING_CUSTOMIZATION_GUIDE.md) (decor, storage, farming), [COMBAT_FEEL_AND_ENEMY_AI_GUIDE.md](./COMBAT_FEEL_AND_ENEMY_AI_GUIDE.md) (knockback, hit sounds, enemy AI, new enemies), [ELEVATION_AND_WORLD_EDGE_GUIDE.md](./ELEVATION_AND_WORLD_EDGE_GUIDE.md) (visible terrain height, ocean at map edges), [ARCHITECTURE_ADVISORY.md](./ARCHITECTURE_ADVISORY.md) (read first before code changes).

Suggested categories:
- `sprites/*tree*.svg`: biome vegetation variants.
- `sprites/stag.svg`, `wolf.svg`, `owl.svg`, `raven.svg`, `seal.svg`, `moth.svg`: extra wildlife.
- `sprites/ashmark_hunter.svg`, `elder_yvenne.svg`, `woods_child.svg`: NPC variants for SCRIPT/dialogue work.
- `sprites/*cloak.svg`, `blight_armor.svg`, `keeper_hat.svg`: clothing/gear icons or held equipment visuals.
- `sprites/watchtower.svg`, `windmill.svg`, `stone_gate.svg`: buildable/POI structures.
- `sprites/lava_vent.svg`, `ice_crystal_cluster.svg`, `blight_spore.svg`: hazards and nodes.
- `tiles/*.svg`: optional terrain variants.
- `sprites/core_temple/*.svg`: fixed Core activation temple, dais, arch, and broken pillar POI pieces.
- `sprites/mountains/*.svg`: biome-specific large mountain landmarks with authoritative footprints.
- `sprites/birds/*_fly_[1-3].svg`: three-frame ambient flight sets for gulls, snow terns, ember kites, and marsh herons.
- `tiles/water_freezing.svg`, `tiles/water_hot.svg`: visual variants driven by shared water-temperature data.

Integration reminder from AGENT_GUIDE.html: add preload/map entries in `src/main.ts`, data definitions in `shared/defs.js` where gameplay is involved, UI icons in `src/ui.ts`, and tests for any server-visible behavior.

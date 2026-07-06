# Echoes of the Hearth — Development Plan

Web-based 2D isometric co-op sandbox RPG with a living, reactive ecosystem simulation.

## Tech Stack
- **Engine:** Phaser 3 (Canvas/WebGL) + TypeScript + Vite
- **Multiplayer:** Node.js + WebSocket (`ws`), authoritative server, client prediction
- **World gen:** Simplex noise (seeded), chunk-based isometric grid (2:1 diamond tiles, 64×32)
- **State/Sim:** Fixed-timestep tick (10 TPS server) driving cellular automata layers
- **Assets:** Placeholder SVGs (in `/assets`) → Kenney.nl isometric packs → AI-generated tilesets later

## Architecture
```
/src
  /engine      game loop, isometric camera, input, chunk renderer
  /world       noise gen, tile grid, biomes, elevation, rivers
  /sim         ecosystem metric, fire CA, water flow, blight spread, weather
  /entities    player, creatures, structures (ECS-lite: components + systems)
  /ai          scent/noise tracking, pathfinding (A* on tile cost map)
  /net         WebSocket client, snapshot interpolation
  /ui          HUD, inventory, crafting, minimap
/server        authoritative sim, rooms, persistence (JSON/SQLite)
/assets        tiles, sprites, sfx
```

## Core Simulation Systems
1. **Ecosystem Metric** — per-sector health score; tree count, soil moisture, wildlife. Over-harvest → mud tiles (50% slow), crop failure, corrupted spawns.
2. **Fire CA** — per-tile fuel/flammability; spreads with wind vector each tick.
3. **Water Flow** — elevation-based flood fill; diggable trenches redirect rivers.
4. **Blight Spread** — infection automata; evolves counters to player defenses (Era 3).
5. **Scent/Noise AI** — players leave decaying trail values on tiles; predators A* toward strongest gradient.

## Milestones
| # | Milestone | Deliverable | Est. |
|---|-----------|-------------|------|
| 0 | Bootstrap | Vite + Phaser + TS project, render iso grid from noise seed | 1–2 d |
| 1 | Core Loop | Player movement, camera, tile picking, chunk streaming | 2–3 d |
| 2 | World Sim v1 | Ecosystem metric, tree harvest, mud/regrowth, day/night | 3–4 d |
| 3 | Survival | Inventory, crafting (Aether Forge), building, Blight Storm structure erosion | 4–5 d |
| 4 | Combat & AI | Creatures, scent tracking, corrupted spawns | 3–4 d |
| 5 | Co-op | WS server, 2–4 player sync, role perks (Geomancer/Alchemist) | 4–6 d |
| 6 | Era 1 Complete | Monolith 1 activation, Whispering Woods content, save/load | 3–4 d |
| 7 | Era 2 | Dunes: temperature, sandstorm map-shifting, water piping | 5–6 d |
| 8 | Era 3 | Spire: thermal grids, avalanches, adaptive Blight | 5–6 d |
| 9 | Era 4 + Endgame | Core Void, Convergence events, World Engine tower-defense finale | 6–8 d |

## Progression / Difficulty (design targets)
- **Era 1 (Easy, 3–4 days):** shelter → Aether Forge → Monolith 1. Night Blight Storms erode wood.
- **Era 2 (Medium, 5–6 days):** heat gear, underground water networks, excavation.
- **Era 3 (Hard, 7–8 days):** Starlight Ore, enemies adapt to defense patterns.
- **Era 4 (Extreme, 7+ days):** rapid decay, resource balancing, endless waves, 30-min final ritual.
- Gates: Monolith cores are hard-locked behind multi-role puzzles so solo rushing fails.

## Asset Pipeline (zero budget)
1. **Now:** placeholder SVGs in `/assets` (included) — recolorable, tiny footprint.
2. **Prototype:** Kenney.nl isometric packs (CC0) for full tile/prop coverage.
3. **Production:** Stable Diffusion prompts (`2D isometric tile, seamless, hand-painted RPG, clean edges`) → TileSetter for auto-borders; skeletal animation via free Spriter for characters.
4. **Audio:** jsfxr/ChipTone for SFX, free CC0 ambient loops.

## Next Steps
1. `npm create vite@latest . -- --template vanilla-ts`, add `phaser`, `simplex-noise`
2. Milestone 0: render a seeded 64×64 iso chunk using `/assets` tiles
3. Player entity + movement (Milestone 1)

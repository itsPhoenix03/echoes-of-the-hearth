# World, Landmark, And Generation Fix Guide

> **Implementation audit: commit `5e792c7` (2026-07-21).** World version 4, Core mountain ground
> stamping, landmark rendering, deterministic bird paths, complete literal manifest coverage, and
> surface bird visibility restoration are implemented. Server landmark authority, save-index
> validation, explicit minor-island resource rules, Core lava vents, post-stamp temperature cleanup,
> regional open-ocean birds, world metrics, and invariant tests remain incomplete.

## 1. Scope

This guide repairs the current expanded-world first pass without redesigning the map. Preserve the
existing deterministic seed contract, major island locations, Core activation objective, and
runtime asset paths. Apply changes to shared data first so server and client consume one world
definition.

## 2. Authoritative Landmark Model

The current `MOUNTAINS`, `TEMPLE_PIECES`, and `LANDMARK_BLOCK` exports are deterministic, but only
the client checks landmark blocking. The server's `blocked()` helper knows only water and player
structures. That permits forged building commands inside landmarks and allows server-simulated
wildlife to cross their footprints.

Replace parallel constants with structured landmark instances:

```js
export const LANDMARKS = [
  {
    id: 'woods-ridge-1',
    kind: 'mountain',
    asset: 'mountain_woods',
    x: 150,
    y: 150,
    footprint: [[-1,-1],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[1,1]],
    blocksMovement: true,
    blocksBuilding: true,
  },
];
```

Generate sets once:

```js
export function buildLandmarkMasks(landmarks) {
  const movement = new Set();
  const building = new Set();
  for (const lm of landmarks) {
    for (const [dx, dy] of lm.footprint) {
      const x = lm.x + dx, y = lm.y + dy;
      if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
      const i = y * SIZE + x;
      if (lm.blocksMovement) movement.add(i);
      if (lm.blocksBuilding) building.add(i);
    }
  }
  return { movement, building };
}
```

The activation dais is a special case: it should allow the World Engine but reject ordinary
structures. Represent this as an allowed-kind rule rather than removing it from all masks.

```js
function canBuildAt(kind, i) {
  if (i === ACTIVATION_I) return kind === 'engine';
  if (landmarkMasks.building.has(i)) return false;
  return true;
}
```

Use the same masks in:

- Client movement and placement previews.
- Server build validation.
- Creature and wildlife pathing.
- Spawn validation.
- Resource/decor placement exclusion.

Do not let the client water check return before checking a blocking landmark. A mountain placed in
shallow water must either block swimming or be deliberately marked non-blocking.

## 3. Landmark Placement Validation

Validate every deterministic landmark at startup in development/test:

- Every footprint tile is in bounds.
- Biome-specific mountains are anchored on their intended biome.
- Land mountains have a documented minimum percentage of non-water footprint tiles.
- No footprint overlaps spawn, monolith interaction radii, required notes, or temple entrances.
- The Core obsidian mountain is on deliberate volcanic land or explicitly modeled as an islet; do
  not accidentally render it in ordinary ocean while collision code treats all water as open.
- Temple pieces leave at least two approach corridors and enough room for final-wave building.

Throw in tests for invalid static definitions rather than allowing silent bad placement.

## 4. Minor-Island Resource Tables

The current generic minor branch gives bushes and stone to every minor-island kind. Replace it with
an explicit table. Absence from a table means no node.

```js
const MINOR_NODE_RULES = {
  rock: [
    { node: NODE.STONE, noise: 's', op: 'lt', threshold: -0.92 },
  ],
  sandbar: [],
  driftwood: [
    { node: NODE.TREE, noise: 'v', op: 'gt', threshold: 0.82 },
    { node: NODE.BUSH, noise: 's', op: 'gt', threshold: 0.92 },
  ],
  ruin: [],
  icefloe: [],
  blightshard: [],
};
```

Keep these restrictions gameplay-driven:

| Minor kind | Normal supplies | Intended purpose |
|---|---|---|
| `rock` | Rare stone only | Navigation/rest marker |
| `sandbar` | None initially | Safe visual waypoint |
| `driftwood` | Very rare wood/fiber | Emergency recovery |
| `ruin` | No harvest nodes | Future authored POI/chest |
| `icefloe` | None | Hazard/navigation |
| `blightshard` | None | Dangerous landmark |

Do not add crystal, iron, diamond, starmetal, boulders, or dense renewable supplies to minor
islands. The long routes should not replace progression on major islands.

## 5. Core Decor And Lava Vents

The current generator exits early for `T.BLIGHT`, making its later `lava_vent` branch unreachable.
Separate node exclusion from decor eligibility:

```js
const blockedByPoi = nearPOI(x, y);
if (t !== T.WATER && !blockedByPoi) {
  placeNodesForTile(...);
}
if (isDecorEligible(t, i, blockedByPoi)) {
  placeDecorForTile(...);
}
```

For Core vents:

- Use deterministic noise and a minimum spacing rule.
- Keep the activation temple clearing and approach corridors empty.
- Do not place vents under the Core mountain sprite.
- If vents are visual-only, exclude them from gameplay collision.
- If vents define hot-water sources, compute `waterTemp` from shared deterministic source data,
  not from rendered sprite proximity on the client.

## 6. Decor Texture Manifest Coverage

The manifest defect found at commit `ff7e8ee` is resolved. `ice_crystal_cluster` is now loaded at its
native-aspect `50x52` raster size, and every literal URL currently declared in `ASSET_MANIFEST`
resolves to a repository file:

```ts
['ice_crystal_cluster', '/sprites/ice_crystal_cluster.svg', 50, 52],
```

Current repository audit counts 175 SVG files. Building-material and several formerly legacy assets
are now loaded for shelter customization, farming, and expanded content. Do not maintain a static
"intentionally unloaded" list here; add an automated asset-integrity test that checks literal
manifest URLs, referenced texture keys, SVG parsing, and raster aspect ratio.

## 7. Water Temperature Sources

Keep `waterTemp` aligned with `tiles`; non-water entries must stay zero. Define source priority when
freezing and hot ranges could overlap. Recommended priority is nearest-source distance rather than
array order.

World version 4 stamps solid terrain under mountain footprints after the initial temperature pass.
Whenever stamping changes `T.WATER` to land, also set `waterTemp[i] = 0`. The current order leaves
six Spire mountain footprint tiles carrying freezing-water metadata after becoming land.

Add assertions:

- Frozen Spire shoreline water is freezing.
- Core ring water is hot.
- Representative midpoint ocean is temperate.
- Icefloe-adjacent water is freezing if icefloes are intended as cold sources.
- Every non-water tile has temperature zero.
- Generation is identical for repeated calls with the same seed.

## 8. Regional Birds

The current bird system uses deterministic shared-clock flight windows and selects species by
proximity to five island centers. It does not classify the camera-center tile or water temperature;
open ocean receives no birds and gull is never selected. Replace proximity-only selection with
region context:

```ts
function birdRegionAt(x: number, y: number): BirdRegion {
  const i = (y | 0) * SIZE + (x | 0);
  if (world.tiles[i] !== T.WATER) return regionForLandTile(world.tiles[i]);
  if (world.waterTemp[i] === WATER_TEMP.FREEZING) return 'spire-coast';
  if (world.waterTemp[i] === WATER_TEMP.HOT) return 'core-hot-sea';
  return 'temperate-ocean';
}
```

Suggested mapping:

- Woods land/coast: woods thrush, occasional gull.
- Dunes land/coast: dune falcon, occasional gull.
- Spire/freezing water: snow tern.
- Marsh land/coast: marsh heron.
- Core/hot water: ember kite.
- Temperate open ocean: gull.

Fix visibility transitions. On the surface, call `setVisible(true)` for retained birds before
updating them. Alternatively destroy all ambient birds when leaving the surface and restart the
camera-local pool on return. The latter is simpler and avoids hidden sprites counting against the
cap.

Bird lifecycle requirements:

- Shared Phaser animation definitions, not one tween per frame.
- Maximum local sprite count enforced.
- Cull on every camera edge with a margin, including strong vertical drift.
- No server state while birds remain cosmetic.
- No collision, rewards, or combat until moved into authoritative simulation.

## 9. Save And Coordinate Compatibility

Continue using `WORLD_VERSION`, but validate the saved `layout` as well as version and seed. Every
persisted tile-index collection must be rejected or migrated when `SIZE` or layout changes.

Validate restored profile coordinates:

```js
function validSavedPosition(x, y) {
  return Number.isFinite(x) && Number.isFinite(y) &&
    x >= 0 && y >= 0 && x < SIZE && y < SIZE;
}
```

If invalid, use `findSpawn(world)`. If valid but in water and reconnect-on-water is not supported,
restore to saved `lastLand` after validating it, otherwise spawn.

Before loading structure, dig, torch, furniture, removed-node, mud, broken-iceberg, farm, or chest
inventory indices,
verify every index is an integer in `[0, SIZE * SIZE)`. Reject the entire incompatible save rather
than partially loading a corrupt world.

## 10. World Metrics

Add a script such as `scripts/world-metrics.mjs` that records:

- Seed, version, size, and generation duration.
- Land tile count by biome and major/minor classification.
- Node count by resource and island class.
- Minor-island count and node count by kind.
- Iceberg and decor counts.
- Landmark footprint validity and overlaps.
- Shore-to-shore route distance and estimated boat time.
- Temperature tile counts.

Fail CI for invariants; record route timing as a report until target tolerances are agreed. For the
current 6.2 tiles/sec boat speed, target approximately 120-180 seconds for principal major-island
routes. Measure shoreline-to-shoreline, not center-to-center.

## 11. Acceptance Criteria

- Server and client use identical landmark footprints.
- Ordinary structures cannot be built on temple/mountain tiles, including forged packets.
- Engine placement succeeds only at the activation dais after objective prerequisites.
- No required route or interaction radius is blocked.
- Ruin, icefloe, and blight-shard minors have no normal resource nodes.
- Lava vents can actually generate without invading the temple clearing.
- Every decor key emitted by the generator has a matching `ASSET_MANIFEST` entry; snow tiles render
  `ice_crystal_cluster` instead of a missing-texture placeholder.
- Bird species follow biome/thermal region and recover correctly after interior transitions.
- Save loading rejects invalid layouts and indices safely.
- World metrics are deterministic and route timings are recorded.

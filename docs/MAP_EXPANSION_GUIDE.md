# Map Expansion And Long-Distance Sailing Guide

This guide explains how to expand Echoes of the Hearth from a compact archipelago into a much larger ocean map where sailing between major islands takes meaningful time, ideally about 2-3 minutes per major voyage. It is based on the current code in `shared/world.js`, `src/main.ts`, `server/index.js`, and `test.mjs`.

The main goal is to make water travel feel like an expedition instead of a short crossing, while preserving the current architecture: deterministic shared world generation, server-authoritative gameplay, streamed client terrain chunks, and small procedural/SVG assets.

## Implementation Contract

An implementation agent should preserve these invariants:

1. `shared/world.js` remains the only source of deterministic geography. The client and server must receive the same `tiles`, `elev`, `veins`, `nodes`, `bergs`, and any new deterministic hazard/landmark collections for a given seed and world version.
2. Every tile index remains `i = y * SIZE + x`. Changing `SIZE` changes the meaning of every persisted index, even when the seed string stays the same.
3. Major-island order remains Woods, Dunes, Spire, Marsh. `MONOLITHS`, `MONO_NAMES`, wildlife biome assignment, notes, and progression assume this order.
4. Terrain can remain chunk-streamed, but world generation itself is currently a full `SIZE * SIZE` pass and static node/iceberg sprites are currently created globally during `init`.
5. The server remains authoritative for boat destruction, hazards, resources, structures, and recovery. Client-only reefs or islands are decoration and must never affect movement or rewards.
6. Long-route acceptance is based on measured shoreline-to-shoreline play time at the current `6.2 tiles/sec` boat speed, not center distance alone.

Before implementation, record a baseline for the current seed: worldgen time in Node, worldgen time in the browser, node count, iceberg count, first usable frame, and current route times. Use the same machine and seed for the post-change comparison.

## Current World Layout

Current values in `shared/world.js`:

```js
export const SIZE = 320;
export const ISLES = [[80, 80], [240, 80], [80, 240], [240, 240]];
export const ISLE_R = 56;
export const MONOLITHS = ISLES;
export const CORE = [160, 160];
```

Current geography:

- Woods: `[80, 80]`
- Dunes: `[240, 80]`
- Spire: `[80, 240]`
- Marsh: `[240, 240]`
- Core: `[160, 160]`
- Map size: `320 x 320` tiles
- Main island radius: about `56` tiles
- Direct center-to-center distance between neighboring major islands: `160` tiles
- Approximate water gap between island edges: `160 - 56 - 56 = 48` tiles before coastline noise

Current movement in `src/main.ts`:

```ts
const speed = (this.sailing ? 6.2 : this.z === 0 && this.tileAt(this.px, this.py) === T.MUD ? 2.2 : 4.4) * dt * 0.707;
```

The `0.707` factor does not reduce final world-space speed. The isometric transform creates a world vector with magnitude `sqrt(2)`, and `0.707` cancels that increase. With normalized keyboard input, effective straight-line speed is therefore approximately:

- Walking: `4.4 tiles/sec`
- Sailing: `6.2 tiles/sec`

Do not estimate route time from one x/y component. Measure the Euclidean world-space distance traveled per second, or time a real voyage in the browser.

Approximate travel time formula:

```text
seconds = water_route_tiles / 6.2
minutes = water_route_tiles / 372
```

To get 2-3 minutes of sailing, the route needs roughly:

```text
2 minutes: 744 water-route tiles
2.5 minutes: 930 water-route tiles
3 minutes: 1116 water-route tiles
```

So the current 48-160 tile gaps are too short. The map needs larger island separation, route design, or slower boat speed. Prefer map expansion and route design over simply slowing boats, because long ocean space creates room for hazards, reefs, small islands, wrecks, storms, and navigation tension.

## Key Design Goals

### Major Islands Should Feel Like Separate Expeditions

Target major route timing:

| Route | Target Sailing Time | Approx Route Distance |
|---|---:|---:|
| Woods -> Dunes | 2.0-3.0 min | 744-1116 water tiles |
| Dunes -> Marsh | 2.0-3.0 min | 744-1116 water tiles |
| Marsh -> Spire | 2.0-3.0 min | 744-1116 water tiles |
| Spire -> Core | 2.0-3.0 min | 744-1116 water tiles |
| Woods -> Core direct | Should be possible later, but dangerous | 744+ water tiles |

### Ocean Should Not Be Empty

Long travel needs pacing. Add sparse content:

- Tiny islets with few or no supplies.
- Dangerous reefs, iceberg fields, blight slicks, fog banks, storm zones.
- Landmarks that help navigation.
- Rare rescue resources, but not enough to bypass island progression.

### Main Islands Should Remain Biome-Exclusive

The larger map must still respect biome identity:

- Woods assets on Woods.
- Desert assets on Dunes.
- Snow assets on Spire.
- Marsh assets on Marsh.
- Core/Blight assets on Core.
- Small islands can be neutral, barren, or biome-adjacent, but should not mix snow pines into desert ocean unless it is an explicit magical anomaly.

## Recommended Map Size

### Minimum For 2-Minute Side Routes

Use at least:

```js
export const SIZE = 1280;
```

With the 1280 layout below, neighboring corner islands have about 780 water tiles between noisy coast edges, or roughly 2.1 minutes at the current boat speed. Corner-to-Core travel is shorter, around 1.5 minutes, so this size does not satisfy a strict 2-minute target for every route.

### Preferred Size

Use this if every progression voyage, including a corner island to the Core, should take about 2-3 minutes:

```js
export const SIZE = 1536;
```

Reasons:

- Enough room for 2-3 minute side routes and roughly 2-minute corner-to-Core routes.
- Still feasible with the existing chunk-streaming renderer because terrain is not drawn all at once.
- `Uint8Array(SIZE * SIZE)` means three arrays of about 2.25 MB each at 1536.

Memory estimate at `SIZE=1536`:

```text
tiles: 2,359,296 bytes
elev:  2,359,296 bytes
veins: 2,359,296 bytes
Total core typed arrays: about 6.75 MiB per generated world
```

Nodes, structures, and sprites can become more significant, so avoid overpopulating the entire expanded map.

### Upper Bound Warning

Do not jump directly to `SIZE=2048` without profiling.

At 2048:

```text
SIZE * SIZE = 4,194,304 tiles
Core arrays = about 12 MB
Worldgen loops = 4x current 1024 cost, 41x current 320 cost
Potential node counts can explode if placement density is unchanged
```

The client and server each generate their own copy, and `test.mjs` generates another in its process. Profile startup before shipping. If 1536 is too slow on target devices, use 1280 and accept shorter Core routes rather than silently relying on incorrect timing math.

## Recommended Expanded Layout

Use a 1536 map and spread the five major landmasses across it.

Recommended constants:

```js
export const SIZE = 1536;
export const ISLES = [
  [160, 160],  // Woods / Grass start island
  [1376, 160], // Dunes / Desert east
  [160, 1376], // Spire / Snow southwest
  [1376, 1376],// Marsh / Mud southeast
];
export const ISLE_R = 72;
export const CORE = [768, 768];
export const CORE_R = 14;
export const MONOLITHS = ISLES;
```

Approximate center distances:

| Route | Center Distance | Approx Water Gap | Approx Travel Time |
|---|---:|---:|---:|
| Woods -> Dunes | 1216 | 1072 | 2.88 min |
| Woods -> Spire | 1216 | 1072 | 2.88 min |
| Dunes -> Marsh | 1216 | 1072 | 2.88 min |
| Spire -> Marsh | 1216 | 1072 | 2.88 min |
| Any corner -> Core | 860 | 774 | 2.08 min |
| Any corner -> opposite corner | 1720 | 1576 | 4.24 min; not a normal progression leg |

These are geometric estimates before coastline noise, steering, hazards, boarding, and stops. Treat them as configuration checks, then record actual shoreline-to-shoreline times in the browser.

## Minimum 1280 Layout

Use this lower-cost layout if approximately 2-minute side routes are enough and shorter Core routes are acceptable:

```js
export const SIZE = 1280;
export const ISLES = [
  [180, 180],
  [1100, 180],
  [180, 1100],
  [1100, 1100],
];
export const ISLE_R = 70;
export const CORE = [640, 640];
```

Approximate side route:

```text
center distance: 920
edge gap: 920 - 70 - 70 = 780 tiles
travel time: 780 / 6.2 = 126 sec = 2.10 min
```

This hits the requested range for side routes, but corner-to-Core water distance is only about 567 tiles, or 91 seconds.

Tradeoff:

- Worldgen cost is 16x current 320 map.
- Still likely acceptable, but test browser startup and server startup.
- More ocean means you should add minor islands and ocean events or the trip will feel empty.

## Spawn And Notes Must Move With The Woods Island

Current `findSpawn()` is hardcoded near `[68,68]`:

```js
export function findSpawn(world) {
  for (let r = 0; r < 40; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = 68 + dx, y = 68 + dy;
```

If Woods moves to `[160,160]`, update spawn to derive from `ISLES[0]`:

```js
export function findSpawn(world) {
  const [sx, sy] = ISLES[0];
  for (let r = 0; r < 50; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(sx - 12 + dx), y = Math.round(sy - 12 + dy);
        const i = y * SIZE + x;
        if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
        if (world.tiles[i] === T.GRASS && !world.nodes.has(i)) return [x, y];
      }
  return [sx, sy];
}
```

Current note definitions in `src/main.ts` already derive from `ISLES`, so they will move automatically:

```ts
const NOTE_DEFS = [
  [ISLES[0][0] + 7, ISLES[0][1] + 4, ...],
  ...
];
```

Still review note text after expansion, because directions like `RISING SUN`, `DUE SOUTH`, and `SETTING SUN` must match the new island layout.

For the recommended 1536 layout:

- Woods -> Dunes: east, note text still works.
- Dunes -> Marsh: south, note text still works.
- Marsh -> Spire: west, note text still works.
- Spire -> Core: toward center/northeast, note text should say center of the sea rather than only visible from peak.

## Add Minor Islands

Long ocean travel needs small islands. These should be generated deterministically in `shared/world.js`, not manually placed only on the client.

### Minor Island Types

Recommended categories:

| Type | Terrain | Supplies | Purpose |
|---|---|---|---|
| Barren Rock | stone/moss stone | none or 1-2 loose stones | Navigation landmark, rest point. |
| Sandbar | sand | rare fiber/reed, maybe water edge | Visual break, emergency landing. |
| Driftwood Cay | grass/sand | 1-3 trees/bushes | Limited repair/refuel spot. |
| Ruin Islet | stone/sand | note/decor, maybe chest later | Lore/navigation. |
| Ice Floe | snow/water near Spire | no supplies, hazard | Spire approach pacing. |
| Blighted Shard | blight/ash near Core | dangerous, no normal supplies | Endgame warning. |

### Minor Island Placement Rules

Rules to avoid bad placement:

- Do not place minor islands too close to major islands unless they are coastline satellites.
- Do not place minor islands directly in the guaranteed route if you want open-ocean tension; place some off-route as optional stops.
- Do not place resource-rich islands before the progression expects those resources.
- Do not place snow/ice minor islands near the desert unless it is a deliberate anomaly.
- Do not place blight islands near the spawn island early unless the game explicitly teaches corruption.

Recommended minimum distances:

```text
Major island exclusion radius: ISLE_R + 80
Core exclusion radius: 90
Minor-to-minor spacing: 45-80 tiles
Safe starter ocean: no hostile/blight minor islands within 180 tiles of Woods
```

### Static Minor Island List

A simple, controllable approach is to define a deterministic list of minor islands.

Example for the 1536 map:

```js
export const MINOR_ISLES = [
  { x: 410, y: 155, r: 13, t: T.SAND, kind: 'sandbar', supplies: 'none' },
  { x: 680, y: 190, r: 11, t: T.GRASS, kind: 'driftwood', supplies: 'low' },
  { x: 1010, y: 145, r: 12, t: T.SAND, kind: 'rock', supplies: 'none' },
  { x: 1370, y: 440, r: 10, t: T.SAND, kind: 'sandbar', supplies: 'none' },
  { x: 1340, y: 790, r: 12, t: T.MUD, kind: 'reedbank', supplies: 'low' },
  { x: 1100, y: 1370, r: 12, t: T.MUD, kind: 'rock', supplies: 'none' },
  { x: 720, y: 1390, r: 11, t: T.SNOW, kind: 'icefloe', supplies: 'none' },
  { x: 360, y: 1190, r: 10, t: T.SNOW, kind: 'icefloe', supplies: 'none' },
  { x: 500, y: 1040, r: 11, t: T.SAND, kind: 'ruin', supplies: 'none' },
  { x: 650, y: 890, r: 9, t: T.BLIGHT, kind: 'blightshard', supplies: 'none' }
];
```

This is easier to tune than fully procedural minor islands.

### Procedural Minor Island Generation

If you prefer procedural placement, generate candidates with seeded RNG and validate distances.

Pseudo-code:

```js
function distToMajor(x, y) {
  return Math.min(
    ...ISLES.map(([ix, iy]) => Math.hypot(x - ix, y - iy)),
    Math.hypot(x - CORE[0], y - CORE[1])
  );
}

function pickMinorIsles(seed) {
  const rng = alea(seed + 'minor');
  const out = [];
  for (let n = 0; n < 80 && out.length < 18; n++) {
    const x = 80 + rng() * (SIZE - 160);
    const y = 80 + rng() * (SIZE - 160);
    if (distToMajor(x, y) < ISLE_R + 95) continue;
    if (out.some(m => Math.hypot(x - m.x, y - m.y) < 75)) continue;
    out.push({ x, y, r: 8 + rng() * 10, kind: chooseKindByRegion(x, y, rng) });
  }
  return out;
}
```

Static list is recommended first because it supports planned navigation and progression.

## How To Render Minor Islands In `genWorld`

Current terrain selection checks Core first, then major islands:

```js
const dCore = Math.hypot(x - CORE[0], y - CORE[1]);
let t = T.WATER;
if (dCore < 14) t = T.BLIGHT;
else {
  for (let k = 0; k < 4; k++) {
    const d = Math.hypot(x - ISLES[k][0], y - ISLES[k][1]);
    if (d < ISLE_R + coast(x / 9, y / 9) * 7) { t = ISLE_T[k]; break; }
  }
  if (t !== T.WATER && el < -0.4) t = T.WATER;
}
```

Recommended structure after expansion:

1. Start as water.
2. Check Core island.
3. Check major islands.
4. Check minor islands.
5. Apply inland lakes only to major islands, or apply more gently to minor islands.
6. Apply iceberg/reef hazards.

Pseudo-code:

```js
let t = T.WATER;
let landClass = null;

if (dCore < CORE_R + coast(x / 7, y / 7) * 3) {
  t = T.BLIGHT;
  landClass = 'core';
} else {
  for (let k = 0; k < 4; k++) {
    const d = Math.hypot(x - ISLES[k][0], y - ISLES[k][1]);
    if (d < ISLE_R + coast(x / 9, y / 9) * 7) {
      t = ISLE_T[k];
      landClass = 'major';
      break;
    }
  }
  if (t === T.WATER) {
    for (const m of MINOR_ISLES) {
      const d = Math.hypot(x - m.x, y - m.y);
      if (d < m.r + coast(x / 5 + m.x, y / 5 + m.y) * 2.5) {
        t = m.t;
        landClass = 'minor';
        break;
      }
    }
  }
}

if (landClass === 'major' && t !== T.WATER && el < -0.4) t = T.WATER;
if (landClass === 'minor' && t !== T.WATER && el < -0.75) t = T.WATER;
```

Why use a separate `landClass`:

- Major islands can have lakes and rich node placement.
- Minor islands should not be gutted by inland lake noise.
- Minor island supplies can be restricted.
- Core can remain stable and not accidentally become water.

## Keep Minor Island Supplies Sparse

Current node placement is based only on terrain type:

```js
if (t === T.GRASS) {
  if (v > 0.45) nodes.set(i, NODE.TREE);
  else if (s > 0.72) nodes.set(i, NODE.BUSH);
  else if (s < -0.78) nodes.set(i, NODE.STONE);
}
```

If you add grass minor islands and reuse this logic, they may become too resource-rich. Add a supply modifier.

Recommended pattern:

```js
const minor = landClass === 'minor';
const supplyScale = minor ? 0.25 : 1;
```

Then use stricter thresholds on minor islands:

```js
if (t === T.GRASS) {
  if (!minor && v > 0.45) nodes.set(i, NODE.TREE);
  else if (minor && v > 0.84) nodes.set(i, NODE.TREE);
  else if (!minor && s > 0.72) nodes.set(i, NODE.BUSH);
  else if (minor && s > 0.9) nodes.set(i, NODE.BUSH);
  else if (s < (minor ? -0.92 : -0.78)) nodes.set(i, NODE.STONE);
}
```

Better: use each minor island's `supplies` field.

```js
if (landClass === 'minor') {
  if (minorKind === 'driftwood' && v > 0.86) nodes.set(i, NODE.TREE);
  if (minorKind === 'reedbank' && s > 0.88) nodes.set(i, NODE.BUSH);
  if (minorKind === 'rock' && s < -0.9) nodes.set(i, NODE.STONE);
  // No starmetal, no crystal, no dense food sources on minor islands by default.
  continue;
}
```

Important progression rule:

- Do not allow minor islands to provide enough starmetal, crystal, or iron to skip intended biome progression.
- Starmetal should remain rare and not appear on snow; keep that rule.
- Crystal should remain tied to Spire/Marsh progression unless deliberately adding rare POIs.

## Water Traversal, Manual Boats, And Temperature

### Required Traversal States

Replace the current implicit `sailing` boolean with explicit state:

```ts
type TraversalMode = 'land' | 'swim' | 'boat';
type BoatKind = 'boat' | 'sboat';

selectedVehicle: BoatKind | null;
activeVehicle: BoatKind | null;
traversalMode: TraversalMode;
```

These values have different meanings:

- Inventory ownership means the player possesses a boat item.
- `selectedVehicle` means the player intentionally selected that boat in the inventory/quickbar.
- `activeVehicle` means the server accepted a launch and the player is currently using it.
- Entering water without an active/selected boat means swimming. Owning a boat must not auto-equip it.

The current client does the opposite: `blockedAt()` opens water when any boat is owned, and entering water immediately sets `boatKind` to reinforced whenever `inv.sboat > 0`. Remove both ownership-based decisions.

Recommended behavior:

1. Water is traversable on the surface even with no boat because swimming is supported.
2. Clicking `boat` or `sboat` selects/deselects it. Only owned boats can be selected.
3. A selected boat launches when the player crosses a valid shoreline into water, or through an explicit Launch action. Launch must be server-accepted.
4. Selecting nothing and entering water starts `swim` mode.
5. Boats can be switched, docked, or packed only at a valid shore. Do not let a deep-water click instantly replace a broken wooden boat with a reinforced one.
6. Leaving water clears `activeVehicle` and returns to `land`; retaining `selectedVehicle` for the next crossing is acceptable and should be visible in UI.
7. Boat destruction clears `activeVehicle`; the player either begins swimming at the wreck position or is washed to `lastLand`, depending on the hazard rule.

Suggested speeds:

```js
const WALK_SPEED = 4.4;
const SWIM_SPEED = 2.2;
const BOAT_SPEED = 6.2;
```

Keep route targets based on boat speed. Swimming is emergency/local traversal, not a practical way to cross 2-3 minute boat routes.

### Server-Owned Vehicle State

Do not continue trusting `pos.b` as proof of boat type. Store selected/active vehicle on the server and derive collision behavior from that state.

Suggested messages:

```json
{ "t": "selectVehicle", "k": "boat" }
{ "t": "selectVehicle", "k": "sboat" }
{ "t": "selectVehicle", "k": null }
{ "t": "vehicle", "id": "p1", "selected": "boat", "active": null }
{ "t": "vehicle", "id": "p1", "selected": "boat", "active": "boat" }
```

Server validation:

- Accept only `boat`, `sboat`, or `null`.
- Require ownership for non-null selection.
- Validate launch against the previous valid land position and a shoreline transition.
- Use `p.activeVehicle` for iceberg/reef protection, never the client payload.
- If inventory reaches zero after destruction, clear selection and active state.
- Include selected/active vehicle in reconnect snapshots and `init` if reconnecting on water is supported.
- Broadcast active mode so remote clients render boat or swim animation correctly.

Because movement is currently client-authoritative, also validate finite/in-bounds coordinates before indexing water or hazard arrays. Rate-limit impossible land/water mode transitions even if full server-authoritative movement is deferred.

### Deterministic Water Temperature

Keep water temperature separate from `T.WATER`; it is a property of a water tile, not a new terrain biome.

Recommended shared data:

```js
export const WATER_TEMP = { TEMPERATE: 0, FREEZING: 1, HOT: 2 };

// Returned by genWorld(seed), aligned with tiles/elev/veins.
const waterTemp = new Uint8Array(SIZE * SIZE);
```

Initial placement rules:

- `FREEZING`: water surrounding Frozen Spire and snow/ice minor islands, extending beyond the iceberg ring so the warning begins before impact hazards.
- `HOT`: water around Core lava vents, obsidian mountain chains, and explicitly volcanic minor islands.
- `TEMPERATE`: all remaining water.
- Non-water tiles always retain `TEMPERATE`/zero in the array and are ignored by water-temperature logic.

Example deterministic assignment:

```js
if (t === T.WATER) {
  const dSpire = Math.hypot(x - ISLES[2][0], y - ISLES[2][1]);
  const dCore = Math.hypot(x - CORE[0], y - CORE[1]);
  if (dSpire < ISLE_R + 180) waterTemp[i] = WATER_TEMP.FREEZING;
  else if (dCore < CORE_R + 125 || nearHotSource(x, y)) waterTemp[i] = WATER_TEMP.HOT;
}
```

Use explicit source priority or nearest-source distance if zones can overlap. `nearHotSource()` must use static/seeded volcanic sources from shared world generation, never `Math.random()`.

Client tile selection:

```ts
if (world.tiles[i] === T.WATER && world.waterTemp[i] === WATER_TEMP.FREEZING) return 'water_freezing';
if (world.tiles[i] === T.WATER && world.waterTemp[i] === WATER_TEMP.HOT) return 'water_hot';
return TILE_KEYS[world.tiles[i]];
```

Assets:

- `tiles/water_freezing.svg`: pale water, ice flecks, cold route readability.
- `tiles/water_hot.svg`: dark mineral water, orange ripples, steam marks.

These are visual keys, not additions to `TILE_KEYS`; normal `T.WATER` gameplay classification remains intact.

### Thermal Damage Rules

Thermal damage must be based on authoritative tile temperature and traversal state:

| Water | Swimming | Boat | Correct worn cloak |
|---|---|---|---|
| Temperate | No thermal damage | No thermal damage | Not relevant |
| Freezing | 1 HP per 5s after grace | Protected | Fur Cloak slows exposure; it does not make immersion harmless |
| Hot | 1 HP per 5s after grace | Protected initially | Heat Cloak slows exposure; it does not make immersion harmless |

Recommended first pass:

- Give a 2-second entry grace so touching one water tile does not cause immediate damage.
- Accumulate exposure server-side in seconds; do not derive damage from client animation.
- Apply one damage every 5 seconds without the correct cloak and every 10 seconds with it.
- Reset the exposure accumulator after reaching temperate water, land, shelter, or an active boat.
- Send warning toasts on temperature-zone entry, then rate-limit repeated damage messages.
- If both thermal and hunger/weather damage apply on the same server tick, cap combined environmental damage to a documented maximum so the player is not burst-killed unexpectedly.

This integrates with the one-at-a-time `wornGear` design in `SMALL_IMPROVEMENTS_AND_FIXES.md`. Check `q.wornGear`, not ownership in `q.gear`.

### Core Temple Activation POI

The Core activation point should be a fixed ruined temple, not an arbitrary radius where the World Engine can be placed.

Assets:

- `sprites/core_temple/core_temple_ruins.svg`
- `sprites/core_temple/core_activation_dais.svg`
- `sprites/core_temple/core_temple_arch_ruin.svg`
- `sprites/core_temple/core_temple_pillar_broken.svg`

Shared constants:

```js
export const ACTIVATION_I = CORE[1] * SIZE + CORE[0];
export const CORE_TEMPLE_CLEAR_R = 7;
```

Implementation rules:

- Generate a stable, flat, node-free temple clearing around `CORE`.
- Place the activation dais exactly at `ACTIVATION_I` and arrange arches/pillars deterministically around it.
- Treat temple pieces as fixed POI objects, not player-owned structures or craftable modules.
- Reserve collision footprints while keeping at least two clear entrances and enough defense-building space around the exterior.
- Change Engine validation from “within 5 tiles of Core” to “exact activation socket and all four monoliths active.”
- Let the placement ghost snap to the dais and explain why placement elsewhere is invalid.
- Persist only mutable temple state, such as activated/damaged, not deterministic ruin positions.

### Mountains On Expanded Islands

Use the new mountain assets as sparse macro-landmarks:

- `mountain_woods.svg`: Woods ridges.
- `mountain_dunes.svg`: Dunes mesas.
- `mountain_spire.svg`: Spire peaks and approach silhouette.
- `mountain_marsh.svg`: low mossy Marsh crags.
- `mountain_core_obsidian.svg`: Core and volcanic hot-water sources.

World data should return mountain instances with kind, anchor tile, and footprint. Prefer elevation-3 interior tiles and deterministic chains. Never place mountains only on the client if they block movement.

Placement constraints:

- Keep spawn, monoliths, notes, temple entrances, beaches, and required cross-island routes clear.
- Reserve at least one navigable coast-to-monolith corridor per major island.
- Use 2x2 or 3x3 authoritative collision footprints rather than blocking only the sprite anchor.
- Do not place full mountain assets on minor islands smaller than the footprint.
- Use mountains to shape expanded islands, but do not fill the additional land area with impassable walls.

### Ambient Flying Birds

The bird frame sets are route/biome indicators:

- Gulls: temperate ocean, beaches, neutral minor islands.
- Snow terns: freezing water and Frozen Spire routes.
- Ember kites: hot water, volcanic islands, and Core approach.
- Marsh herons: Marsh coast and reedbank islands.

Birds are non-colliding ambient entities by default. Spawn small camera-local groups from deterministic region rules, give them bounded looping flight paths, and despawn visuals outside a generous camera margin. If birds later become huntable, move their state to the server animal simulation rather than extending the ambient system silently.

## Ocean Hazard And Landmark Ideas

### Reefs

Purpose:

- Make routes less straight without requiring massive map size.
- Create navigational choices.

Implementation concept:

- Add `reefs` as a `Set<i>` in worldgen, similar to `bergs`.
- Reefs damage or slow boats, but do not affect reinforced boats as severely.
- Client renders reef sprites/tiles in water.

Server validation:

- In `pos` handling, check nearby reef tiles only when authoritative `p.activeVehicle` is non-null.
- If wooden boat hits reef, maybe damage/warn before breaking.
- If reinforced boat hits reef, slow or ignore.

### Fog Banks

Purpose:

- Navigation challenge, not necessarily damage.

Implementation:

- Client visual only initially, based on seeded zones or weather.
- Avoid server behavior until needed.

### Blight Slicks

Purpose:

- Core approach hazard.

Implementation:

- Use blight water overlays near Core or blight shard minor islands.
- Server can apply slow/damage if sailing through infected water later.

### Iceberg Fields

Current iceberg logic:

```js
if (t === T.WATER && Math.hypot(x - ISLES[2][0], y - ISLES[2][1]) < 95 && sct(...) > 0.72)
  bergs.add(i);
```

When map expands, the Frozen Spire can have a larger iceberg field:

```js
const dSpire = Math.hypot(x - ISLES[2][0], y - ISLES[2][1]);
if (t === T.WATER && dSpire > ISLE_R + 8 && dSpire < ISLE_R + 135 && sct(x / 2 + 900, y / 2 + 900) > 0.72)
  bergs.add(i);
```

This keeps bergs in a ring outside the island rather than filling inland water or odd spots.

## Client Performance Considerations

The client already streams terrain chunks in `src/main.ts`:

```ts
const CHW = 1024, CHH = 512;
ensureChunks()
drawChunk()
setTileMut()
```

This is good. Do not replace it with one giant render texture.

What changes with larger maps:

- `offX = (SIZE - 1) * TW / 2` becomes much larger.
- Camera bounds become much larger:

```ts
const W = SIZE * TW, H = SIZE * TH + 80;
this.cameras.main.setBounds(0, -80, W, H + 160);
```

At `SIZE=1536`:

```text
W = 98,304 pixels
H = 49,232 pixels
```

This is okay because only chunks near the camera render.

Potential issues:

- Initial worldgen loops will take longer.
- Number of nodes can become too high if density remains unchanged.
- `for (const i of this.world.nodes.keys()) this.spawnNode(i);` currently spawns all nodes at world build time, not just nearby nodes.

This is the biggest client-side risk.

Icebergs have the same architectural issue: `buildWorld()` iterates every `world.bergs` entry and creates every sprite immediately. Any new reefs, wrecks, or ocean landmarks will repeat that cost unless they share a streaming layer.

Recommended static-object streaming contract:

- Partition deterministic object indices into coarse tile buckets immediately after `genWorld`, for example `32 x 32` or `64 x 64` tile buckets.
- Keep authoritative/deterministic data in `world.nodes`, `world.bergs`, and similar sets even when no sprite exists.
- Create sprites only for buckets intersecting the camera view plus a one-bucket margin.
- Destroy only the visual object when a bucket leaves the margin. Never delete deterministic world data as a streaming operation.
- Apply `removed` and `brokenBergs` filters every time a bucket is materialized, not only during initial load.
- Make `spawnNode(i)` idempotent by returning when `nodeSpr.has(i)`; apply the same rule to iceberg and landmark spawn helpers.
- Interaction searches must query nearby deterministic indices or active buckets. Do not assume `nodeSpr` contains the entire world after streaming is introduced.

## Important: Node Sprite Scaling Risk

Current client code spawns every node sprite when building the world:

```ts
for (const i of this.world.nodes.keys()) if (!gone.has(i)) this.spawnNode(i);
```

On a 320 map, this is manageable. On a 1280 or 1536 map, node count still scales mostly with land area rather than ocean area, but every node and iceberg is currently instantiated at `init`. If island count, island radius, or hazard density increases, startup and display-list costs can spike even though terrain itself is streamed.

Recommendations:

1. Keep major island radius modest: `64-72`.
2. Keep minor islands sparse.
3. Restrict minor island supplies.
4. If node count exceeds a few thousand, implement streamed node sprites like terrain chunks.

Useful debug metric:

```js
console.log('nodes', world.nodes.size, 'bergs', world.bergs.size);
```

Target rough counts:

- Current: likely low thousands or less.
- Expanded target: under 5,000 node sprites initially.
- If above 8,000, consider node streaming.

## Server Performance Considerations

Server uses the same `world` object from `genWorld(seed)`. Most gameplay checks are local or set/map lookups, so the bigger world is fine.

Potential server risks:

- Creature spawn logic may need larger spawn range or route-specific ocean events.
- Animal spawning currently biases near players, so bigger map does not automatically spawn animals everywhere.
- Save file can grow if players build widely or many world mutations occur.
- `nearestLand(world, x, y)` currently searches radius up to 130. With larger oceans, this is still okay for boat wrecks near islands/bergs, but if used in deep ocean it may fail to find land.
- `ANIMAL_TYPES` currently contains hardcoded fallback spawn rectangles around `[50,50]`, `[210,50]`, `[50,210]`, and `[210,210]`. Derive those fallback centers from `ISLES`; player-biased spawning alone does not remove the stale-coordinate bug.
- Player profile coordinates are restored from persistence. Reject or relocate profiles whose world version differs or whose coordinates are out of bounds/water in the new layout.

Current `nearestLand`:

```js
export function nearestLand(world, x, y) {
  for (let r = 1; r < 130; r++)
```

Do not simply increase this radius to several hundred. The current nested loops rescan increasingly large squares, so its cost grows very quickly and its scan order is not a true nearest-distance search. Use this recovery order instead:

1. Track the player's last valid land tile server-side and use it for boat wreck recovery.
2. For scripted hazards, associate each hazard field with an explicit recovery shore or minor island.
3. If a general nearest-land query is still needed, build a land/coast spatial index once after world generation and query nearby buckets; do not run an expanding full-map scan during gameplay.

Better server-side sailing state:

```js
p.lastLandX = p.x;
p.lastLandY = p.y;
```

Update it only after the server receives a valid surface position on non-water terrain. Persist it with the profile if reconnecting during a voyage must preserve recovery behavior.

## Navigation And Player Experience

If travel takes 2-3 minutes, players need tools to stay oriented.

Recommended additions:

### Compass UI

Simple text direction indicator:

- Add to HUD: current heading, nearest known island direction, or cardinal compass.
- Does not need a full minimap.

### Landmark Notes

Update note text to mention:

- Major direction.
- Approximate sailing time.
- Hazards to expect.
- Landmark sequence.

Example:

```text
From the Woods, keep the sunrise just above your bow. Two songs of open water pass before the first sandbar. Beyond the third lonely reef, the Dunes rise gold.
```

### Ocean Pacing

For a 2.5-minute route, place 2-4 minor landmarks:

```text
0:00 leave shore
0:35 small barren rock / birds
1:10 reef or fog bank
1:45 supply-poor sandbar / wreck
2:20 destination coastline appears
```

This makes long travel feel designed instead of empty.

## Save Compatibility

Changing any of these invalidates old save semantics:

- `SIZE`
- `ISLES`
- `CORE`
- `ISLE_R`
- worldgen land/water rules
- tile index interpretation if old structures are loaded into a different map

Current save stores tile indices for structures, mud, digs, torches, etc. If the map layout changes, old indices may now point to ocean or wrong biomes.

Required action during development:

- Delete `server/save.json` after changing worldgen.
- Or bump the default seed/save version and reject old saves.

Recommended save versioning:

```js
const WORLD_VERSION = 2;
const WORLD_LAYOUT = `v${WORLD_VERSION}:${SIZE}:${SEED}`;
```

Add to save:

```js
version: WORLD_VERSION,
layout: WORLD_LAYOUT,
seed,
```

In `loadSave()`, reject if version does not match:

```js
if (s.version !== WORLD_VERSION || s.layout !== WORLD_LAYOUT || s.seed !== SEED) return;
```

This prevents old structures, digs, broken icebergs, and profile coordinates from being interpreted against a new tile-index layout. On rejection, log one clear reason and start a new world; do not partially load compatible-looking sections.

Validate every restored coordinate before indexing arrays:

```js
const inBounds = (x, y) => Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;
```

Only call `ti(x, y)` after this check. The current `world.tiles[ti(prof.x, prof.y)] !== T.WATER` expression can accept an out-of-range lookup because `undefined !== T.WATER` is true.

## Files To Change

### `shared/world.js`

Main changes:

- Increase `SIZE`.
- Move `ISLES` and `CORE`.
- Adjust `ISLE_R`.
- Add `CORE_R` if desired.
- Add `MINOR_ISLES` static list or procedural generator.
- Update terrain selection to include minor islands.
- Restrict minor island node density.
- Update iceberg ring for the new Spire radius.
- Update `findSpawn()` to derive from `ISLES[0]`.
- Redesign wreck recovery around `lastLand`/indexed coast lookup; do not solve it by expanding the current cubic-style scan.
- Return `waterTemp`, mountain instances/footprints, Core temple POI data, and deterministic ambient-bird regions.
- Keep thermal water as a water property rather than adding semantic tile types.

### `src/main.ts`

Likely changes:

- Review clue note text.
- Possibly add ocean landmarks rendering if using new sets like reefs.
- Possibly add compass/navigation UI.
- Watch node sprite count at startup.
- If adding new hazard sets to `genWorld`, add client render maps.
- Replace ownership-driven auto-sailing with `land`/`swim`/`boat` traversal modes and selected/active vehicle state.
- Preload thermal water, temple, mountain, and bird-frame assets.
- Render swim/boat state for local and remote players and snap Engine placement to the activation dais.

### `server/index.js`

Likely changes:

- Save versioning if changing worldgen.
- Boat destruction recovery: use last land position or increased `nearestLand` radius.
- If adding reefs/blight slicks, validate boat collisions in `pos` handler.
- If adding ocean events, spawn them near players, not globally.
- Store and validate selected/active boat instead of trusting `pos.b`.
- Apply swimmer thermal exposure from shared `waterTemp` and `wornGear`.
- Validate Engine placement at `ACTIVATION_I` and include traversal/vehicle state in join/reconnect payloads.
- Include mountain/temple collision footprints in authoritative blocking where applicable.

### `shared/defs.js`

Only needed if adding craftable navigation items or new resources:

- Compass
- Sail upgrades
- Anchor
- Repair kit
- Map fragment

### `src/ui.ts`

Needed for HUD navigation/new inventory items and explicit boat selection. Show selected versus owned boat clearly; clicking the selected boat should deselect it.

### `test.mjs`

Update tests if:

- Spawn location changes assumptions.
- `nearestLand` behavior changes.
- Iceberg fields move but test already uses `world.bergs`, so it should still work.
- New server-visible hazards are added.
- Manual vehicle selection, launch rejection, swimming, thermal damage, and exact activation placement are added.

Current tests recompute world from seed and search actual nodes, which is good. They should survive larger maps unless timeouts become too short or startup becomes slow.

## Step-By-Step Implementation Plan

### Step 0: Add World Compatibility And Bounds Guards

Before changing `SIZE`, add `WORLD_VERSION`/layout validation to save loading and validate restored/player-reported coordinates before array access. Delete `server/save.json` for the first expanded-world run. This prevents the first test run from producing misleading floating structures or invalid profiles.

### Step 1: Expand Constants Only

In `shared/world.js`:

```js
export const SIZE = 1536;
export const ISLES = [[160, 160], [1376, 160], [160, 1376], [1376, 1376]];
export const ISLE_R = 72;
export const CORE = [768, 768];
```

Update `findSpawn()` to derive from `ISLES[0]`.

Also replace the four hardcoded wildlife fallback spawn rectangles in `server/index.js` with centers/ranges derived from `ISLES`. Keep the biome/type mapping explicit so the `ISLES` order remains visible in code.

Run:

```text
npm run build
```

Then delete `server/save.json`, start fresh server, and verify client loads.

### Step 2: Measure Generated World

Add temporary metrics or use a one-off Node script:

```js
import { genWorld, SIZE, ISLES, CORE } from './shared/world.js';
const w = genWorld('hearth-001');
console.log({ SIZE, nodes: w.nodes.size, bergs: w.bergs.size, isles: ISLES, core: CORE });
```

Check:

- Node count is reasonable.
- Berg count is reasonable.
- Spawn is on grass.
- Major islands are not clipped by map edges.
- Two calls to `genWorld(seed)` produce identical hashes/counts.
- Every monolith center and note resolves to valid land with a clear radius around it.
- No minor island overlaps a major island, Core exclusion zone, or another minor island.

### Step 3: Tune Routes

Use the formula:

```text
travel seconds = water tiles / 6.2
```

If travel is too short:

- Move islands farther apart.
- Move from the 1280 minimum layout to the 1536 preferred layout.
- Add reef/ice/fog detours.

If travel is too long:

- Move islands slightly closer.
- Add optional mid-route safe islets.
- Increase sailing speed only after testing.

Measure from the last land tile at departure to the first land tile at arrival. Record direct no-stop time separately from the designed route with hazards. Keep boarding animation/UI time out of the geometric estimate but include it in the player-experience measurement.

### Step 4: Add Minor Islands

Add a static `MINOR_ISLES` list. Keep it sparse.

Start with 10-14 small islands on a 1536 map:

- 2 along Woods -> Dunes route.
- 2 along Dunes -> Marsh route.
- 2 along Marsh -> Spire route.
- 1-2 near Core but dangerous.
- 1 optional off-route supply-poor rock.

Do not add rich supplies at first.

### Step 5: Restrict Minor Island Supplies

Add `landClass` or `minorKind` tracking in `genWorld`.

Rules:

- Barren rock: no tree, no bush, rare stone.
- Sandbar: no tree, rare fiber/reed if implemented.
- Driftwood: very rare tree/bush.
- Ruin: no normal supplies unless chest/POI system exists.
- Ice floe: no normal supplies.
- Blight shard: no normal supplies, possible danger.

### Step 6: Add Ocean Hazards/Landmarks

Only after the basic expanded map feels good.

Recommended order:

1. More iceberg ring around Spire.
2. Decorative barren rocks/sandbars.
3. Reefs as visual hazards.
4. Blight slicks near Core.
5. Fog banks/weather route events.

Add traversal/temperature work in this order:

1. Make all surface water swimmable and add explicit traversal mode.
2. Add boat selection and server-owned active vehicle state.
3. Add shared `waterTemp` plus thermal visuals.
4. Add server exposure/damage and cloak mitigation.
5. Add Core temple/dais and exact activation validation.
6. Add mountain footprints and ambient bird regions after required routes are verified.

### Step 7: Update Navigation Text

Update note text in `src/main.ts` so it matches the new long routes.

Examples:

- Woods note should warn the Dunes are several minutes east and mention sandbars/reefs.
- Dunes note should say Marsh lies far south, not just a day/night if that feels too vague.
- Marsh note should warn westward route to Spire requires reinforced boat because of ice.
- Spire note should point toward the central Core.

### Step 8: Finalize Save Migration

Confirm the save/world version added in Step 0 covers all persisted tile-index collections and player coordinates.

At minimum, tell the user:

```text
Delete server/save.json before testing the expanded map.
```

Do not ship with manual deletion as the only compatibility mechanism. Development may delete the file, but production must reject incompatible saves automatically.

## Example Expanded `shared/world.js` Shape

This is a conceptual template, not direct drop-in code.

```js
export const SIZE = 1536;
export const ISLES = [[160, 160], [1376, 160], [160, 1376], [1376, 1376]];
export const ISLE_R = 72;
export const CORE = [768, 768];
export const CORE_R = 14;
export const MONOLITHS = ISLES;

export const MINOR_ISLES = [
  { x: 410, y: 155, r: 13, t: T.SAND, kind: 'sandbar', supplies: 'none' },
  { x: 680, y: 190, r: 11, t: T.GRASS, kind: 'driftwood', supplies: 'low' },
  { x: 1010, y: 145, r: 12, t: T.SAND, kind: 'rock', supplies: 'none' },
  { x: 1370, y: 440, r: 10, t: T.SAND, kind: 'sandbar', supplies: 'none' },
  { x: 1340, y: 790, r: 12, t: T.MUD, kind: 'reedbank', supplies: 'low' },
  { x: 1100, y: 1370, r: 12, t: T.MUD, kind: 'rock', supplies: 'none' },
  { x: 720, y: 1390, r: 11, t: T.SNOW, kind: 'icefloe', supplies: 'none' },
  { x: 360, y: 1190, r: 10, t: T.SNOW, kind: 'icefloe', supplies: 'none' },
  { x: 650, y: 890, r: 9, t: T.BLIGHT, kind: 'blightshard', supplies: 'none' }
];
```

For each tile, determine whether it is core, major, minor, or water. Then place nodes based on that class.

## Testing Checklist

### Build And Protocol

Run:

```text
npm run build
```

Start a fresh server and run:

```text
node test.mjs
```

If server/shared behavior changed, add tests.

### Manual World Checks

In browser/dev mode:

1. Delete `server/save.json`.
2. Start `npm run server:dev`.
3. Start `npm run dev`.
4. Use F9 for dev kit.
5. Sail Woods -> Dunes and time it.
6. Sail Dunes -> Marsh and time it.
7. Sail Marsh -> Spire and confirm iceberg approach matters.
8. Sail Spire -> Core and confirm Core is not visible too early.
9. Stop at minor islands and verify supplies are sparse.
10. Confirm no biome mismatch: no snow pines in desert, no cactus in Spire, no rich forest on random sandbars.
11. Enter water with no boat selected and confirm swimming starts without a boat sprite.
12. Own both boats, select the wooden boat, and confirm the reinforced boat is not chosen automatically.
13. Attempt to switch/launch a boat in deep water and confirm the server rejects it.
14. Swim in temperate, freezing, and hot water and verify grace, warnings, damage cadence, and cloak mitigation.
15. Confirm boats prevent swimmer thermal damage and iceberg handling uses the server's active boat kind.
16. Confirm the Engine ghost snaps to the Core dais and every other Core tile is rejected.
17. Verify mountain footprints do not close spawn, beaches, monolith routes, or temple entrances.
18. Verify bird groups use correct regional species, animate all frames, and are cleaned up outside the camera margin.

### Metrics To Record

Record these after generation:

```text
SIZE
node count
berg count
minor island count
spawn x/y
travel time Woods -> Dunes
travel time Dunes -> Marsh
travel time Marsh -> Spire
travel time Spire -> Core
freezing/hot water tile counts
swim speed and thermal damage cadence
mountain count by biome
ambient bird group/sprite count near camera
client startup time
server startup time
average FPS while sailing
```

## Common Pitfalls

### Pitfall: Old Saves On New World

Symptom:

- Structures appear in water.
- Player spawns in wrong biome.
- Digs/torches/furniture appear in invalid places.

Fix:

- Delete `server/save.json` or add save version rejection.

### Pitfall: Too Many Node Sprites

Symptom:

- Browser freezes or loads slowly after `init`.

Cause:

- Larger map plus too much land or too dense node placement.

Fix:

- Lower island radius.
- Restrict minor island supplies.
- Implement node sprite streaming.

### Pitfall: `nearestLand` Fails In Deep Ocean

Symptom:

- Boat breaks and player does not wash ashore properly.

Fix:

- Track `lastLandX/lastLandY` per player.
- Increase nearest-land radius carefully.
- Avoid placing break hazards too far from recoverable land unless reinforced boat is required.

### Pitfall: Routes Are Long But Empty

Symptom:

- Sailing technically takes 3 minutes but feels boring.

Fix:

- Add visible landmarks every 30-60 seconds.
- Add sparse minor islands.
- Add weather and hazard zones.
- Add ocean audio and boat bob/wake.

### Pitfall: Progression Breaks Due To Minor Islands

Symptom:

- Players get crystal/starmetal/iron too early.

Fix:

- Do not use generic major-island node placement on minor islands.
- Explicitly restrict rare resources from minor islands.

### Pitfall: Directional Lore Becomes Wrong

Symptom:

- Notes say east/south/west but the new layout differs.

Fix:

- Keep layout aligned with existing note directions or rewrite notes.

## Recommended Final Direction

Use the 1536 layout when the 2-3 minute requirement includes travel to the Core:

```js
SIZE = 1536
ISLES = [[160,160], [1376,160], [160,1376], [1376,1376]]
ISLE_R = 72
CORE = [768,768]
```

Then add 10-14 sparse minor islands and tune route landmarks. If startup profiling rejects 1536, use this 1280 minimum and document that Core legs are shorter:

```js
SIZE = 1280
ISLES = [[180,180], [1100,180], [180,1100], [1100,1100]]
ISLE_R = 70
CORE = [640,640]
```

Do not solve this only by slowing the boat. The player should feel the world is larger, not that the boat is artificially slow.

## Definition Of Done For Map Expansion

The expanded map is ready when:

- `npm run build` passes.
- Fresh server starts without old save state.
- `node test.mjs` passes or is updated for new server-visible behavior.
- Woods -> Dunes takes about 2-3 minutes by boat.
- Dunes -> Marsh takes about 2-3 minutes by boat.
- Marsh -> Spire route has meaningful iceberg danger.
- Water without a selected boat starts swimming; boat ownership alone never equips or launches one.
- Freezing and hot water are deterministic, visually readable, and damage swimmers on the server with documented cloak mitigation.
- The Core temple is deterministic and the Engine can be placed only on its activation dais.
- Mountains preserve required navigation corridors and use authoritative footprints.
- Biome-appropriate birds animate from frame sets without global sprite accumulation.
- Minor islands exist but do not provide enough supplies to skip progression.
- Biome-specific assets are correctly placed.
- Incompatible saves and profile coordinates are automatically rejected/relocated by world version; manual deletion is only a development reset.
- Worldgen/startup and static-object counts remain within recorded budgets on the target browser/device.

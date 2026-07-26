# Remaining Implementation Roadmap

> **Authoritative audit baseline:** repository commit `5e792c7`, reviewed 2026-07-21 by four
> parallel codebase agents. The production `npm run build` passes. This document is the current-state
> overlay for guides 01-06: use those guides for detailed target designs, but use this roadmap to
> decide what remains and in which order. After selecting a task here, use
> `08_CODE_IMPLEMENTATION_SNIPPETS.md` for code scaffolds matched to the current repository layout.

## 1. How To Use This Roadmap

Do not treat the existence of an asset, client visual, message field, or partial handler as feature
completion. A gameplay feature is complete only when:

- The server owns and validates gameplay state.
- Local and remote clients render the accepted state consistently.
- Reconnect/init restores enough state without guessing.
- Rejection and abuse paths are tested.
- Save compatibility is validated.
- Production build and isolated test suites pass.

The repository contains substantial new combat, enemy AI, farming, shelter customization, decor,
and final-wave work. Preserve those implementations. This roadmap focuses on gaps remaining from the
current guide set rather than reopening completed feature areas.

## 2. Implemented First Passes To Preserve

The following work is present and should not be reimplemented from scratch:

- `WORLD_VERSION = 4` and the Core obsidian mountain was moved onto/stamped into Core land.
- Major/minor island layout, temperature arrays, hot/freezing tile rendering, and lethal thermal
  respawn exist.
- Wooden and reinforced numeric boat modes have different iceberg behavior.
- Numeric boat state is sent in remote init/position packets and remote hulls render.
- Cloak gameplay checks `wornGear`, not mere ownership.
- Mountains, temple pieces, decor, extended tiles, birds, and building-material texture entries are
  loaded; literal asset-manifest URLs resolve.
- Birds use shared Phaser animations and deterministic shared-clock flight windows with a sprite cap.
- Birds regain visibility when returning to the surface.
- Basic player walk, held tools, hurt pose, red vignette, creature feedback, and animal facing exist.
- Passive campfire regeneration and one-HP glowcap healing exist.
- Farms, chest inventory, interior/exterior decor, shelter customization, additional enemies, combat
  feedback, and final-wave logic have been added.
- The TypeScript and Vite production build succeeds.

These are foundations, not proof that their authority, edge cases, or tests are complete.

## 3. Priority Zero: Coordinate And Traversal Authority

### Current Gap

`server/index.js` still copies `m.x`, `m.y`, `m.z`, and `m.b` directly into player state. It indexes
world arrays before finite/bounds validation and uses client `b` for hot-water and iceberg immunity.
A modified client can teleport or claim reinforced-boat protection without owning a boat.

### Required State

```js
const p = {
  // existing fields
  selectedVehicle: null, // 'boat' | 'sboat' | null
  activeVehicle: null,   // server-confirmed launched vehicle
  mode: 'land',          // 'land' | 'swim' | 'boat'
  lastValidX: spawn[0],
  lastValidY: spawn[1],
  lastLandX: spawn[0],
  lastLandY: spawn[1],
  lastPosAt: Date.now(),
};
```

### Required Work

1. Validate finite, bounded coordinates and supported Z levels before array access.
2. Enforce a time-based movement envelope with mode-specific speeds.
3. Add server `selectVehicle` handling with ownership validation.
4. Accept boat launch only on a valid adjacent land-to-water transition.
5. Enter swim mode when crossing into water without a selected/owned boat.
6. Clear active boat only on validated docking, destruction, death, or reconnect policy.
7. Ignore/remove `b` from client `pos`; derive hazards from `p.activeVehicle`.
8. Broadcast `{selected, active, mode}` through a dedicated `vehicle` event.
9. Include local and remote traversal state in `init`.
10. Decrement the exact destroyed inventory item.

Validation skeleton:

```js
function validPosition(x, y, z) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isInteger(z) &&
    x >= 0 && y >= 0 && x < SIZE && y < SIZE && z >= 0 && z <= 2;
}

function ownsVehicle(p, kind) {
  return (kind === 'boat' || kind === 'sboat') && Number(p.inv[kind] || 0) > 0;
}
```

### Exit Gate

- Forged `b`, mode, coordinates, and deep-water launch requests have no effect.
- Owning but not selecting a boat starts swimming.
- Every peer sees the same accepted hull/mode.
- Reconnect behavior is deterministic and tested.

## 4. Priority Zero: Unified Damage, Healing, Death, And Respawn

### Current Gap

The permanent thermal one-HP loop is fixed, but falls, boat wrecks, multiple creature paths,
thermal water, weather, hunger, thirst, glowcaps, and campfires mutate HP independently. Boat wreck
still clamps at one. Respawn resets differ by source, and the client guesses respawn when HP jumps to
10 from a low value. This will conflict with full medic healing.

### Required API

```js
export const MAX_HP = 10;

function applyDamage(playerId, p, amount, reason, now = Date.now()) {
  if (p.dead || !Number.isFinite(amount) || amount <= 0) return { applied: 0 };
  const previousHp = p.hp;
  p.hp = Math.max(0, p.hp - Math.floor(amount));
  const applied = previousHp - p.hp;
  if (!applied) return { applied: 0 };
  p.lastDamageAt = now;
  send(p.ws, { t: 'damage', amount: applied, hp: p.hp, maxHp: MAX_HP, reason });
  if (p.hp === 0) respawnPlayer(playerId, p, reason);
  return { applied, lethal: p.hp === 0 };
}

function applyHealing(p, amount, source) {
  if (p.dead || p.hp <= 0 || p.hp >= MAX_HP) return { applied: 0 };
  const applied = Math.min(Math.floor(amount), MAX_HP - p.hp);
  p.hp += applied;
  send(p.ws, { t: 'heal', amount: applied, hp: p.hp, maxHp: MAX_HP, source });
  return { applied };
}
```

### Required Work

- Add shared `MAX_HP` and stable damage/healing reason strings.
- Add a transient `dead` guard and one validated respawn function.
- Migrate all damage and healing sources.
- Select at most one periodic environmental damage source per environment interval.
- Reset hunger, thirst, Z level, active vehicle, traversal mode, thermal exposure, and temporary
  action state consistently.
- Validate bed/campfire/world spawn coordinates against bounds, water, landmarks, and occupancy.
- Add explicit `damage`, `heal`, `playerDeath`, `respawn`, and `playerRespawn` events.
- Remove client inference based on `hp === 10`.
- Include `hp`, `maxHp`, `hunger`, and `thirst` in `init`.
- Clamp restored profile values and reject invalid saved coordinates.

### Exit Gate

- Every damage source can kill exactly once and respawns exactly once.
- No unchanged-HP damage feedback is emitted.
- Glowcap, campfire, medicine, and medic healing cannot be mistaken for respawn.
- The Core wooden-boat burn sequence has a deterministic regression test.

## 5. Priority One: Authoritative Landmarks And Safe Saves

### Current Gap

`LANDMARK_BLOCK` is shared but used only by client movement. Server build validation, NPC movement,
creature pathing, and wildlife ignore it. Ordinary structures can be forged onto landmarks and the
activation dais. Save loading writes a layout identifier but validates only version/seed and accepts
unchecked indices/coordinates.

### Required Work

- Replace or wrap `MOUNTAINS`/`TEMPLE_PIECES` with structured landmark instances and movement/build
  masks.
- Import masks on the server and use them in `blocked()`, build validation, spawning, and pathing.
- Check landmark masks before the client's early water return.
- Permit only `engine` on `ACTIVATION_I`; reject ordinary structures there.
- Validate save `layout` as well as version/seed.
- Validate every index in removed, mud, structures, digs, torches, furniture, broken icebergs,
  farms, and chest inventory.
- Validate profile health and coordinates before world-array access.
- Add startup/test assertions for biome anchors, approach corridors, overlaps, and spawn safety.

Build rule:

```js
function canBuildAt(kind, i) {
  if (i === ACTIVATION_I) return kind === 'engine';
  return !landmarkMasks.building.has(i);
}
```

### Exit Gate

- Forged build/movement requests cannot enter landmark footprints.
- Creatures and wildlife respect the same masks.
- Invalid or incompatible saves are rejected safely rather than partially loaded.

## 6. Priority One: World Generation Corrections

### Current Gap

The generic minor-island branch gives bushes and stones to ruins, icefloes, and sandbars. Core lava
vents are unreachable because `T.BLIGHT` exits before decor placement. Mountain ground stamping can
convert freezing water to land without clearing `waterTemp`. Birds are selected by island-center
proximity; open-ocean gulls and thermal route species are absent.

### Required Work

```js
const MINOR_NODE_RULES = {
  rock: [{ node: NODE.STONE, noise: 's', threshold: -0.92 }],
  sandbar: [],
  driftwood: [
    { node: NODE.TREE, noise: 'v', threshold: 0.82 },
    { node: NODE.BUSH, noise: 's', threshold: 0.92 },
  ],
  ruin: [],
  icefloe: [],
  blightshard: [],
};
```

- Separate node exclusion from decor placement so deterministic Core vents can generate.
- Preserve temple clearings and approach corridors.
- Set `waterTemp[i] = 0` whenever post-generation stamping changes water to land.
- Select bird region from biome plus water temperature, including temperate-ocean gulls,
  freezing-route terns, and Core hot-sea ember kites.
- Cull birds using camera margins as well as lifetime; add optional glide states later.
- Add `scripts/world-metrics.mjs` for route time, node counts, minor supplies, temperatures,
  landmarks, and deterministic hashes.

### Exit Gate

- Ruin/icefloe/blightshard minors have no normal supplies.
- Lava vents generate without entering the temple clearing.
- Every non-water tile has zero water temperature.
- Open-ocean and thermal routes receive intended bird species.
- Metrics record approximately 2-3 minute principal crossings.

## 7. Priority One: Medicine And Two Medics

### Current Gap

All medicine/medic runtime work is missing. Art remains staged under `C:/z/assets/sprites` and is not
served by Vite. Existing generic inventory persistence is a prerequisite only.

### Required Order

1. Complete unified health helpers and trustworthy coordinate validation first.
2. Copy `medicine.svg`, `medic.svg`, and `medic_snow.svg` into runtime `assets/sprites`.
3. Add manifest entries, medicine inventory key/name/recipe, quickbar item, and server use cooldown.
4. Medicine heals exactly 3, capped at `MAX_HP`, and is not consumed at full health.
5. Add deterministic Woods and Spire medic definitions and valid spawn searches.
6. Send medics in `init`, render labels/prompts, and prioritize NPC interaction before nodes/water.
7. Add per-player server offers, island-valid weighted pools, expiry, reroll cooldown, inspect,
  accept, and explicit decline.
8. Deduct payment and full-heal atomically.
9. Add dialogue, feedback, persistence restart tests, and multiplayer isolation tests.

### Exit Gate

- Medicine heals up to 3 and persists.
- Each medic requests only resources legitimately obtainable in its island pool.
- Offers cannot be rerolled freely, replayed, forged, accepted remotely, or used by another player.
- Full medic healing is an explicit heal event, never a respawn inference.

## 8. Priority Two: Animation And Traversal Presentation

### Current Gap

The rig still uses sibling images and one generic 320ms arm/tool tween. `act(null)` falls back to the
held tool, causing weapon swings for unarmed gathering/water collection. Sounds and target feedback
are not synchronized to clip impact. Swimming is head-only; boats lack seated pose/bob/wake; cloaks
are not rendered or synchronized remotely.

### Required Work

- Add `bodyRoot`, shoulder, hand, and tool pivots plus centralized grip metadata.
- Add preallocated base/action/reaction/cosmetic poses.
- Replace `anim` with validated action context `{kind, tool, target, seq}`.
- Implement distinct chop, mine, slash, and unarmed gather clips with `impactAt`.
- Never infer held tool when `tool: null` is intentional.
- Trigger sound/target feedback at accepted impact, not input time.
- Add idle tread-water, moving swim, shore blends, seated boat poses, hull bob/wakes, and wreck blend.
- Broadcast worn cloak changes and attach one cloak or none to local/remote rigs.
- Add animal gait/flee cadence/hit/death treatment and optional bird glide.
- Add animation lab, finite-transform tests, low-frame-rate tests, and four-player profiling.

### Exit Gate

- Tools remain attached to visible grips throughout distinct clips.
- Unarmed interactions never swing the held weapon.
- Local/remote swim, boat, cloak, action, and impact timing agree.
- No sustained allocation/sprite growth occurs during a five-minute stress run.

## 9. Priority Two: Test Infrastructure

### Current Gap

`npm run build` passes, but no `npm test` script exists. `test.mjs` requires a manually running
server, mutates live save/process state, teleports players, sends forged boat flags, and lacks the
world, thermal, landmark, animation, medicine, and persistence coverage required by the guides.

### Required Scripts

```json
{
  "scripts": {
    "test:unit": "node --test test/unit/**/*.test.mjs",
    "test:world": "node --test test/world/**/*.test.mjs",
    "test:integration": "node test/run-isolated-integration.mjs",
    "test": "npm run test:unit && npm run test:world && npm run test:integration"
  }
}
```

The integration runner must own an isolated port and temporary save path, start/stop the server, and
restart it for persistence tests. Add environment overrides such as `PORT` and `SAVE_PATH`; current
hardcoded values prevent safe parallel isolation.

### Minimum Suites

- Coordinate and movement rejection.
- Vehicle selection/launch/dock/destruction/reconnect.
- Damage/healing/death/respawn for every source.
- Hot/freezing cadence, cloak mitigation, and grace.
- Landmark build/movement/pathing authority.
- World determinism, minor supplies, vents, temperatures, birds, and route metrics.
- Medicine and medic success/rejection/replay/persistence/multiplayer.
- Animation state, explicit-null actions, sequences, impact timing, and finite poses.
- Save layout/index/profile validation.

## 10. Dependency Order

Implement in this order to avoid building features on spoofable state:

1. Coordinate validation and server-owned traversal.
2. Unified damage/healing/death/respawn protocol.
3. Isolated test harness for those authority layers.
4. Landmark authority and save validation.
5. World-generation corrections and metrics.
6. Medicine and medic gameplay.
7. Validated action protocol and rig foundation.
8. Swim/boat/cloak animation and world polish.
9. Full regression, performance, and persistence gates.

## 11. Release Gate

Do not mark this roadmap complete until:

- `npm run build` and aggregate `npm test` pass from a clean checkout.
- No gameplay protection depends on client `b` or unvalidated coordinates.
- Damage and healing use explicit events and one server pipeline.
- Save/layout/index/profile validation passes malformed-input tests.
- Landmark and minor-island invariants pass deterministic tests.
- Medicine and both medics meet guide 05 acceptance criteria.
- Local and remote traversal/action/cloak presentation agree.
- Route timing, world generation, and five-minute client stress metrics are recorded.

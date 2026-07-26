# Testing And Phased Rollout Guide

> **Implementation audit: commit `5e792c7` (2026-07-21).** The production TypeScript/Vite build
> passes. A legacy `test.mjs` smoke/integration script exists and includes additional combat checks,
> but `package.json` exposes no test scripts, the test requires a separately running mutable server,
> and it still teleports players and forges numeric boat state. Unit, isolated integration, world,
> animation, medicine/medic, thermal, landmark, and persistence suites remain pending.

## 1. Testing Principles

Each implementation phase must add tests before the next phase starts. Existing integration tests
currently send a raw `b` value to simulate a boat. Replace that coverage after server-owned vehicle
state is introduced; otherwise the test preserves the vulnerability rather than detecting it.

Use three layers:

1. Pure shared-world tests for deterministic generation and masks.
2. Server WebSocket integration tests for authority, persistence, and broadcasts.
3. Browser/manual tests for rendering, animation quality, and input transitions.

## 2. Shared World Tests

Create a Node test module that generates at least two fixed seeds.

Required assertions:

- Same seed produces identical hashes for `tiles`, `elev`, `veins`, `waterTemp`, node entries,
  icebergs, decor, landmarks, and footprints.
- Different seeds vary noise-driven content but preserve static POI positions.
- Spawn is in bounds, on valid grass, outside nodes and landmark masks.
- Every monolith and note resolves to accessible land.
- Every non-water temperature entry is zero.
- Frozen, hot, and temperate representative water tiles exist.
- Landmark footprints are in bounds and do not overlap forbidden interaction zones.
- Minor-island node rules match the explicit resource table.
- Activation dais index is stable and excluded from ordinary building placement.

Add snapshot counts with tolerances rather than exact counts for intentionally tuned noise output.
Use exact hashes only where changing generation requires a deliberate world-version bump.

## 3. Vehicle Authority Integration Tests

Add WebSocket tests for:

1. Selecting `boat` without ownership is rejected.
2. Selecting unknown strings is rejected.
3. Selecting `null` is accepted.
4. Owning a boat but selecting none enters swim mode.
5. Selecting an owned wooden boat and crossing adjacent shore launches it.
6. Selecting reinforced boat launches reinforced boat even when wooden boat is also owned.
7. Deep-water launch and vehicle switching are rejected.
8. Forged `b`, `mode`, or `activeVehicle` fields in `pos` are ignored.
9. Wooden boat breaks at an intact iceberg and decrements wooden inventory.
10. Reinforced boat breaks the iceberg without decrementing the hull.
11. Boat destruction broadcasts swim mode to all peers.
12. Remote init contains the correct active mode.
13. Disconnect/reconnect follows the documented water restoration policy.

Do not teleport directly to an iceberg while claiming a boat. Build test helpers that grant
inventory in test mode, select the vehicle, place the player on a valid shore, and cross into water.

## 4. Coordinate Security Tests

Send and reject:

- `NaN`-equivalent malformed JSON values where representable.
- Strings, `null`, arrays, and objects as coordinates.
- Negative and `SIZE`-or-greater coordinates.
- Invalid `z` values.
- Teleport-sized movement deltas.
- Replayed stale position sequence numbers if sequences are added.

After each rejection, assert server position and mode did not change and no invalid broadcast was
sent to peers.

## 5. Thermal Tests

Use a controllable clock or extract thermal accumulation into a pure function. Avoid waiting ten
real seconds per test.

Cases:

- Temperate swimming causes no thermal damage.
- Freezing and hot water respect two-second grace.
- No/wrong cloak damages at five-second accumulated cadence.
- Correct cloak damages at ten-second cadence.
- Owning but not wearing a cloak gives no mitigation.
- Wearing one cloak replaces the other; wearing the same cloak toggles it off.
- Land, temperate water, boat, shelter, mine, death, and zone changes reset exposure correctly.
- Forged boat flags do not prevent damage.
- Environmental damage death/clamping behavior matches the documented rule.

## 6. Landmark And Build Tests

- Client preview and server both reject ordinary structures on every blocking footprint tile.
- Forged build packets are rejected.
- Engine is rejected on every tile except the dais.
- Engine is rejected at the dais before all monoliths are active.
- Engine succeeds at the dais after prerequisites.
- Wildlife and creatures cannot enter blocking footprint tiles.
- Core mountain collision behaves deliberately on land/water.
- No resource node or decor overlaps protected temple space.

## 7. Bird Lifecycle Tests

Most bird appearance checks are manual, but lifecycle can be tested through extracted helpers:

- Region mapping returns expected species for every biome and thermal-water type.
- Spawn cap is never exceeded.
- Horizontal and vertical off-camera birds are culled.
- Leaving surface destroys or hides birds according to the selected policy.
- Returning to surface restores visible ambient birds without waiting for stale hidden entries.
- Shared animation definitions are registered once.

## 8. Animation Lab And Manual Matrix

Create a development-only animation lab reachable by a query flag or separate scene. It must show:

- Every tool in held pose.
- Axe, pickaxe, sword, and gather actions on repeat and single-step.
- Left/right facing.
- Idle, walk, tread water, moving swim, wooden boat, and reinforced boat.
- Cloak states: none, heat, fur.
- Normal speed, 0.5x speed, and frame stepping around impact.

Manual matrix:

| Scenario | Verify |
|---|---|
| Walk then chop | Legs continue; torso/arm action blends without root snap |
| Mine while facing both ways | Tool remains attached to hand and impact aligns |
| Slash repeatedly | Cooldown prevents clip overlap and recovery is stable |
| Gather while holding sword | Gather is unarmed unless explicitly designed otherwise |
| Enter water unselected | Swim transition, no boat, no tool leak |
| Stop in water | Tread-water loop replaces moving stroke |
| Launch selected boat | Boat appears only after server confirmation |
| Remote boat | Peer sees correct hull and seated pose |
| Boat destruction | Hull removal, splash, then swim without teleport/pop |
| Switch cloak | Exactly one correct cloak visible; toggle permits none |

Record short captures for review because subjective smoothness cannot be proven by unit tests.

## 9. Map Timing And Content Checks

For each principal route, record:

- Departure and arrival shoreline coordinates.
- Direct water-tile distance.
- Estimated time at 6.2 tiles/sec.
- Measured time without stops.
- Measured intended route with hazards/islet detours.
- Number and type of minor islands encountered.
- Whether destination landmarks become visible too early.

Target approximately 2-3 minutes for intended major-island crossings. Do not achieve this only by
slowing boats. Tune world distance and route content first.

Inspect every biome for placement errors:

- No snow vegetation in Dunes.
- No desert cactus in Spire.
- No dense forest resources on sandbars or icefloes.
- No ordinary mountain sprite floating in open water unless authored as an islet.
- Temple and Core props remain in the Core region.
- Bird species correspond to land or thermal-water region.

## 10. Performance Gates

Measure on a representative browser with:

- Four player rigs animating.
- Maximum nearby creatures and animals.
- Five ambient birds.
- Weather particles active.
- Multiple structures and landmark sprites in view.

Record average FPS, worst frame time, sprite count, and JavaScript heap trend for at least five
minutes. Reject sustained object growth after birds, impacts, boats, or players leave view.

World generation should record server and browser duration. If startup becomes excessive, optimize
generation without changing deterministic output unexpectedly. Any output-changing optimization
requires a world-version decision.

## 11. Rollout Gates

### Gate 1: Authority

- Coordinate validation deployed.
- Server-owned vehicle state deployed.
- Raw `b` ignored.
- Authority integration tests pass.

### Gate 2: Shared World Correctness

- Landmark masks shared and authoritative.
- Minor resources corrected.
- Lava vents and thermal sources deterministic.
- Save/layout validation passes.

### Gate 3: Multiplayer Presentation

- Remote mode/boat rendering correct.
- Reconnect behavior correct.
- Bird lifecycle fixed.

### Gate 4: Animation Foundation

- Joint hierarchy and grips stable.
- Action clips and impact timing accepted in animation lab.

### Gate 5: Traversal Animation And Polish

- Swim/boat/cloak transitions complete.
- Performance and leak checks pass.
- Route timing and biome-placement review recorded.

Do not mark a later gate complete because assets exist or because a local visual approximation is
present. Completion requires server/client agreement, tests, and the gate's manual evidence.

## 12. Clean Checkout Verification

From a clean checkout with dependencies installed:

```text
npm install
npm run build
npm test
```

If the project does not expose all required scripts yet, add explicit scripts for unit tests,
integration tests, world metrics, and the animation lab. CI should start from a clean environment;
do not rely on an existing `server/save.json` or developer inventory.

Required package-script target:

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

The isolated integration runner must create a temporary save directory, choose an unused port,
start and stop its own server, and delete its temporary state. A reconnect persistence test must
restart that isolated server; reconnecting to the same in-memory `profiles` object is not a durable
persistence test. Coordinate/vehicle authority from Gate 1 is a prerequisite for medic range and
trade tests because client-reported positions cannot establish trustworthy proximity.

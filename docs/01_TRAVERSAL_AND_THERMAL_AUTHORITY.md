# Traversal And Thermal Authority Implementation Guide

> **Implementation audit: commit `5e792c7` (2026-07-21).** Thermal water data, cloak mitigation,
> lethal thermal respawn, numeric boat-state broadcasts, and remote hull rendering exist. The
> authority model is still incomplete: the server trusts client coordinates and numeric `b`, has no
> `selectedVehicle`/`activeVehicle`/`mode`, and performs no ownership, shore-transition, bounds, or
> movement-envelope validation. Treat this guide's explicit vehicle protocol as pending work.

## 1. Current State And Failure Modes

The client currently stores `selectedVehicle` and decides whether entering water means sailing or
swimming. It sends `b` in every `pos` packet. The server assigns that untrusted value to `p.b` and
uses it for iceberg and thermal-water protection. This permits a modified client to send `b: 2`
without owning a reinforced boat or any boat at all.

The server now broadcasts the client-supplied numeric `b` in both `init.players` and `pos`, so remote
clients can render a hull. This is presentation progress, not authority: every peer sees the same
untrusted value, and remote swimming is still inferred from `b === 0` plus the local world tile.
Replace this interim numeric state with the explicit server-owned traversal protocol below.

Replace the implicit `b` flag with explicit server-owned state. Ownership, selection, active
vehicle, and locomotion are different concepts:

- `inventory.boat` / `inventory.sboat`: player owns these items.
- `selectedVehicle`: player intent, either `boat`, `sboat`, or `null`.
- `activeVehicle`: server-confirmed launched vehicle, either `boat`, `sboat`, or `null`.
- `mode`: derived state, `land`, `swim`, or `boat`.

## 2. Protocol Contract

Use string kinds rather than numeric flags at the network boundary.

Client to server:

```json
{ "t": "selectVehicle", "k": "boat" }
{ "t": "selectVehicle", "k": null }
{ "t": "pos", "x": 180.25, "y": 181.10, "z": 0 }
```

Server to one client after accepting or rejecting selection/launch:

```json
{
  "t": "vehicle",
  "id": "p1",
  "selected": "boat",
  "active": null,
  "mode": "land",
  "reason": null
}
```

Server broadcast when active traversal changes:

```json
{
  "t": "vehicle",
  "id": "p1",
  "selected": "boat",
  "active": "boat",
  "mode": "boat"
}
```

Include `mode` and `activeVehicle` in `init.players`. Include the local player's selected and active
vehicle in `init`. Position broadcasts may also include mode for resilience, but mode transitions
should have a dedicated event so they are not lost between movement packets.

## 3. Server Player State

Replace `b` with explicit fields when constructing a player:

```js
const p = {
  // existing fields
  selectedVehicle: null,
  activeVehicle: null,
  mode: 'land',
  lastLandX: spawn[0],
  lastLandY: spawn[1],
  waterEnteredAt: 0,
  thermalExposureSec: 0,
  lastThermalAt: now,
};
```

Use helpers shared by selection, movement, hazards, death, and reconnect:

```js
const VEHICLES = new Set(['boat', 'sboat']);

function ownsVehicle(p, kind) {
  return VEHICLES.has(kind) && Number(p.inv[kind] || 0) > 0;
}

function traversalMode(p) {
  if (p.z !== 0) return 'land';
  const water = world.tiles[ti(p.x, p.y)] === T.WATER;
  if (!water) return 'land';
  return p.activeVehicle ? 'boat' : 'swim';
}
```

Do not persist active boat state unless reconnect-on-water is deliberately supported. The safer
first rollout is to persist selection but restore a reconnecting player to `lastLand` with
`activeVehicle: null`. If reconnect-on-water is required, persist the exact mode and validate item
ownership and tile type during restoration.

## 4. Coordinate And Movement Validation

Validate before every array index. Reject malformed packets without changing player state.

```js
function validSurfacePosition(x, y, z) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isInteger(z) &&
    x >= 0 && y >= 0 && x < SIZE && y < SIZE && z >= 0 && z <= 2;
}
```

Also enforce a movement envelope based on elapsed server time. Allow small tolerance for network
jitter and boat speed, but reject teleport-sized deltas. Full server simulation can be a later
phase; finite, bounds, and maximum-delta checks are required now.

```js
const elapsed = Math.max(0.05, Math.min(1, (now - p.lastPosAt) / 1000));
const maxSpeed = p.activeVehicle ? 6.2 : traversalMode(p) === 'swim' ? 2.2 : 4.4;
const maxDistance = maxSpeed * elapsed * 1.75 + 0.35;
if (Math.hypot(x - p.x, y - p.y) > maxDistance) return;
```

Never mutate incoming message fields during respawn. Compute local `nextX` and `nextY` values.

## 5. Selection And Launch

Selection handler:

```js
else if (m.t === 'selectVehicle') {
  const kind = m.k === null ? null : String(m.k);
  if (kind !== null && !VEHICLES.has(kind)) return;
  if (kind !== null && !ownsVehicle(p, kind)) {
    return sendVehicle(p, 'not-owned');
  }
  if (p.activeVehicle && kind !== p.activeVehicle) {
    return sendVehicle(p, 'dock-before-switching');
  }
  p.selectedVehicle = p.selectedVehicle === kind ? null : kind;
  sendVehicle(p, null, true);
}
```

Launch is accepted only for a real land-to-water transition:

1. Previous authoritative tile is non-water.
2. New tile is water and adjacent to the previous valid land tile.
3. `selectedVehicle` is owned.
4. The player is on the surface and not in another transition.
5. The destination is not blocked by a non-traversable hazard.

If no vehicle is selected, entering water sets `activeVehicle = null` and mode becomes `swim`.
Owning a boat must never launch it automatically.

On water-to-land transition, clear `activeVehicle`, set mode to `land`, and keep selection unchanged.
This lets a player intentionally keep the same boat selected for a later crossing.

## 6. Client State And Prediction

The client may predict water entry for responsiveness, but the server response is final. Keep:

```ts
type VehicleKind = 'boat' | 'sboat';
type TraversalMode = 'land' | 'swim' | 'boat';

selectedVehicle: VehicleKind | null;
activeVehicle: VehicleKind | null;
mode: TraversalMode;
```

Clicking the inventory vehicle sends `selectVehicle`; it does not directly create a boat sprite.
Only a server-confirmed `vehicle` event changes `activeVehicle` and durable mode. Prediction may
temporarily show a launch transition, but it must roll back on rejection.

Remove `b` from position packets after the server handler is deployed. During a short compatibility
window, ignore `b` server-side rather than supporting both authority models.

## 7. Remote Rendering

Extend each remote player entry with `mode`, `activeVehicle`, and `boatSpr`. Do not infer mode from
the tile alone.

```ts
interface RemotePlayer {
  rig: Rig;
  mode: TraversalMode;
  activeVehicle: VehicleKind | null;
  boatSpr: Phaser.GameObjects.Image | null;
  // existing interpolation and label fields
}
```

On `vehicle`:

- `land`: remove boat sprite, call `rig.setLocomotion('land')`.
- `swim`: remove boat sprite, call `rig.setLocomotion('swim')`.
- `boat`: create/update the correct hull and call `rig.setLocomotion('boat')`.

Destroy remote boat sprites on player leave. Ensure visibility follows surface/mine/shelter state.

## 8. Icebergs And Boat Destruction

Use `p.activeVehicle`, never packet data:

```js
if (p.activeVehicle === 'boat' && hitsIntactIceberg(p.x, p.y)) {
  destroyActiveVehicle(p, 'berg');
} else if (p.activeVehicle === 'sboat' && hitsIntactIceberg(p.x, p.y)) {
  breakIcebergAndBroadcast();
}
```

`destroyActiveVehicle` must decrement the matching inventory item, not always `boat`. It must clear
active state and clear selection if none remain. The player changes to swimming at the wreck tile,
unless product design chooses wash-ashore behavior. Broadcast the new traversal state immediately.

## 9. Thermal Exposure

Temperature remains a property of water in `world.waterTemp`:

- `0`: temperate.
- `1`: freezing.
- `2`: hot.

Only swimmers accumulate exposure. Active boats, land, underground, shelter interiors, and
temperate water reset it.

Recommended first-pass timings:

- Entry grace: 2 seconds.
- Wrong/no cloak: one HP every 5 accumulated seconds after grace.
- Correct cloak: one HP every 10 accumulated seconds after grace.
- Warning toast: once when entering a thermal zone and when the zone type changes.

Track seconds rather than counting environment ticks:

```js
function updateThermal(p, now) {
  const dt = Math.min(1, Math.max(0, (now - p.lastThermalAt) / 1000));
  p.lastThermalAt = now;
  const i = ti(p.x, p.y);
  const temp = world.tiles[i] === T.WATER ? world.waterTemp[i] : 0;
  const exposed = p.z === 0 && p.mode === 'swim' && temp !== 0;
  if (!exposed) return resetThermal(p);

  if (p.thermalZone !== temp) {
    p.thermalZone = temp;
    p.waterEnteredAt = now;
    p.thermalExposureSec = 0;
    sendThermalWarning(p, temp);
  }
  if (now - p.waterEnteredAt < 2000) return;

  p.thermalExposureSec += dt;
  const protectedByCloak =
    (temp === 1 && p.wornGear === 'furcloak') ||
    (temp === 2 && p.wornGear === 'heatcloak');
  const interval = protectedByCloak ? 10 : 5;
  if (p.thermalExposureSec >= interval) {
    p.thermalExposureSec -= interval;
    applyEnvironmentalDamage(p, 1, temp === 1 ? 'freezing-water' : 'hot-water');
  }
}
```

Use one environmental damage function so thermal, hunger, weather, and death/respawn behavior do
not disagree. Decide explicitly whether thermal damage can kill. Do not accidentally clamp one
source to one HP while other environmental sources kill.

## 10. Acceptance Criteria

- Sending `b: 2` has no effect.
- Selecting an unowned vehicle is rejected.
- Owning an unselected boat and entering water starts swimming.
- A selected owned boat launches only from shore.
- Boats cannot be swapped in deep water.
- Wooden and reinforced boats have different validated iceberg behavior.
- Every client sees the same remote traversal mode and hull.
- Reconnect behavior is deterministic and documented.
- Thermal damage observes grace and five/ten-second cadence.
- Correct cloak mitigation uses `wornGear`, not mere ownership.

# Damage, Death, And Respawn Fix Implementation Guide

> **Implementation audit: commit `5e792c7` (2026-07-21).** The original permanent thermal-water
> one-HP loop is fixed: thermal damage now reaches zero and invokes the legacy immediate respawn.
> Boat-wreck damage still clamps at one, health mutation and respawn behavior remain duplicated,
> the client still infers respawn from overloaded `hp` messages, and no shared constants, reasons,
> dead state, validated respawn, explicit protocol, observability, or regression tests exist.

## 1. Purpose

Fix the Core hot-water failure where a player remains permanently at 1 HP after a wooden boat is
destroyed while damage messages and feedback continue. Replace scattered HP mutation with one
server-authoritative damage, death, healing, and respawn pipeline so every hazard follows the same
rules.

This guide makes the following gameplay decision explicit:

> Freezing and hot water are lethal environmental hazards. A swimmer whose health reaches zero
> dies and respawns through the same authoritative flow used by combat, falls, weather, hunger, and
> thirst.

If design later chooses a nonlethal hazard, feedback must stop at the nonlethal floor. Do not clamp
HP while continuing to emit damage events. The current mixed behavior is the bug.

## 2. Confirmed Current Failure

Wooden boats burn in Core hot water. The boat-wreck helper immediately applies two damage but clamps
the result to one:

```js
p.hp = Math.max(1, p.hp - 2);
```

After the boat is destroyed, the client enters swimming mode. Thermal damage has since been changed
to subtract one without a floor and immediately invoke the existing respawn path at zero:

```js
q.hp -= 1;
send(q.ws, { t: 'msg', s: 'The scalding water burns!' });
if (q.hp <= 0) { /* legacy immediate respawn */ }
send(q.ws, { t: 'hp', hp: q.hp, x: q.x, y: q.y });
```

This removes the reported immortal thermal-swimmer symptom. The remaining defect is architectural:
boat damage and every other source still use separate mutation/respawn branches, and thermal damage
can be followed by a second starvation/dehydration damage decision during the same environment tick.

The client currently infers respawn when HP becomes 10 while previous HP was at most one:

```ts
if (m.hp === 10 && this.hp <= 1) {
  // infer death and move to respawn coordinates
}
```

That inference becomes incorrect once medicine or medic treatment can heal a one-HP player to full.
Death and healing must use explicit event semantics.

## 3. Required Invariants

After this work:

- Health is always an integer in `[0, MAX_HP]`.
- Damage greater than zero either reduces health or is explicitly rejected/absorbed.
- No damage event, sound, animation, or message is emitted when applied damage is zero.
- Lethal damage invokes death exactly once.
- Death resets or preserves survival state according to one documented policy.
- Respawn coordinates are selected and validated only by the server.
- Healing cannot be mistaken for respawning.
- Boat destruction and subsequent thermal damage cannot both kill/respawn a player twice.
- Every damage source records a stable reason.
- Client visuals react to server events; they do not decide whether damage or death occurred.
- Remote clients receive only the state needed to render death/respawn, without private inventory or
  hazard details unless desired.

## 4. Shared Health Constants

Define health constants in `shared/defs.js` and reuse them on server and client:

```js
export const MAX_HP = 10;
export const MEDICINE_HEAL = 3;
```

Do not add a `MIN_HP = 1` constant. Zero is a valid transient server value that triggers death.

Replace hardcoded `10` values in code touched by this feature:

- Player creation.
- Profile restoration validation.
- Creature contact death.
- Fall death.
- Environment death.
- Campfire regeneration cap.
- Medicine/medic healing cap.
- Client HUD empty-heart calculation.

A later cleanup can replace every remaining hardcoded survival constant, but all health mutations
must use `MAX_HP` before this fix is considered complete.

## 5. Damage Reason Contract

Use stable reason strings rather than presentation text:

```js
export const DAMAGE_REASON = {
  CREATURE: 'creature',
  FALL: 'fall',
  BOAT_BURN: 'boat-burn',
  BOAT_WRECK: 'boat-wreck',
  FREEZING_WATER: 'freezing-water',
  HOT_WATER: 'hot-water',
  SANDSTORM: 'sandstorm',
  SNOWSTORM: 'snowstorm',
  DESERT_HEAT: 'desert-heat',
  GLACIAL_COLD: 'glacial-cold',
  STARVATION: 'starvation',
  DEHYDRATION: 'dehydration',
};
```

Reasons are protocol values and test identifiers. Keep user-facing messages in a separate lookup so
copy changes do not break logic or tests.

```js
const DAMAGE_TEXT = {
  'hot-water': 'The scalding water burns!',
  'freezing-water': 'The freezing water saps your life!',
  'boat-burn': 'The scalding sea destroys your wooden hull!',
  // ...
};
```

## 6. Central Server Damage API

Implement one helper in a dedicated module such as `server/health.js`, or initially near the server
state helpers if module extraction would complicate the phase.

Recommended result type:

```js
// JavaScript shape documented for clarity.
// { applied, previousHp, hp, lethal, ignored, reason }
```

Implementation outline:

```js
import { MAX_HP } from '../shared/defs.js';

export function applyDamage({
  playerId,
  player,
  amount,
  reason,
  now = Date.now(),
  send,
  onDeath,
}) {
  if (!Number.isFinite(amount) || amount < 1)
    return { applied: 0, previousHp: player.hp, hp: player.hp, lethal: false, ignored: 'invalid-amount', reason };

  if (player.dead || player.hp <= 0)
    return { applied: 0, previousHp: player.hp, hp: player.hp, lethal: false, ignored: 'already-dead', reason };

  const requested = Math.floor(amount);
  const previousHp = Math.max(0, Math.min(MAX_HP, Math.floor(player.hp)));
  const hp = Math.max(0, previousHp - requested);
  const applied = previousHp - hp;

  if (applied <= 0)
    return { applied: 0, previousHp, hp: previousHp, lethal: false, ignored: 'no-change', reason };

  player.hp = hp;
  player.lastDamageAt = now;

  send(player.ws, {
    t: 'damage',
    amount: applied,
    hp,
    maxHp: MAX_HP,
    reason,
  });

  if (hp <= 0) {
    onDeath(playerId, player, reason, now);
    return { applied, previousHp, hp: 0, lethal: true, ignored: null, reason };
  }

  return { applied, previousHp, hp, lethal: false, ignored: null, reason };
}
```

Important rules:

- Clamp at zero, never one.
- Floor/validate damage values. Reject amounts below one rather than promoting them: with a
  `<= 0` guard, a fractional amount like `0.4` would pass validation and then be silently rounded
  up to a full point of damage. Callers that want fractional accumulation (thermal seconds) must
  accumulate and call with whole numbers.
- Every return path includes the full documented result shape, so tests can destructure
  `previousHp` unconditionally.
- Ignore damage while `player.dead` is true.
- Send the damage event only if HP actually decreases.
- Invoke death synchronously after the lethal HP mutation.
- Do not independently send a legacy `hp` damage message from the caller.
- Do not send damage text before knowing damage was applied.

If armor or temporary immunity is added later, calculate mitigation before `applied` and report zero
damage as an absorbed event only when the UI intentionally needs it.

## 7. Explicit Death State

Even if respawn is immediate, mark the player dead while processing the transition:

```js
function killPlayer(playerId, p, reason, now = Date.now()) {
  if (p.dead) return;
  p.dead = true;
  p.hp = 0;

  const [x, y] = respawnPoint(playerId);
  const respawn = sanitizeRespawn(world, x, y, spawn);

  bcast({
    t: 'playerDeath',
    id: playerId,
    x: p.x,
    y: p.y,
    reason,
  });

  respawnPlayer(playerId, p, respawn, reason, now);
}
```

The first phase may respawn immediately. A later animation phase can add a short server-owned
`deadUntil` delay, but do not let the client move, attack, gather, trade, or send vehicle state while
dead.

## 8. Respawn Policy

Document what death restores. This is the target policy; current behavior differs by source:

- HP: restore to `MAX_HP`.
- Hunger: restore to 10.
- Thirst: restore to 10.
- Surface level: `z = 0`.
- Active vehicle: clear.
- Swimming/sailing mode: clear to land.
- Thermal exposure: reset.
- Fall state and temporary action state: reset client-side after event.
- Inventory, tools, gear, worn cloak, and selected vehicle: preserve unless product design adds a
  death penalty.
- Position: own bed first, then own campfire fallback, then world spawn, using existing
  `respawnPoint()` policy.

Server helper:

```js
function respawnPlayer(playerId, p, [x, y], reason, now) {
  p.x = x;
  p.y = y;
  p.z = 0;
  p.hp = MAX_HP;
  p.hunger = 10;
  p.thirst = 10;
  p.b = 0; // remove once authoritative activeVehicle replaces b
  p.activeVehicle = null;
  p.mode = 'land';
  p.thermN = 0;
  p.thermalExposureSec = 0;
  p.thermalZone = 0;
  p.dead = false;
  p.lastRespawnAt = now;

  send(p.ws, {
    t: 'respawn',
    hp: p.hp,
    maxHp: MAX_HP,
    hunger: p.hunger,
    thirst: p.thirst,
    x,
    y,
    z: 0,
    reason,
  });

  bcast({ t: 'playerRespawn', id: playerId, x, y, z: 0 });
}
```

Validate respawn coordinates before indexing arrays:

- Finite and in bounds.
- Non-water.
- Not a blocking landmark footprint.
- Not inside a non-enterable structure.
- Prefer a clear neighboring tile if the bed/campfire anchor itself is occupied.

## 9. Hot-Water Fix

Replace the thermal HP mutation with `applyDamage()`:

```js
const reason = wt === 1
  ? DAMAGE_REASON.FREEZING_WATER
  : DAMAGE_REASON.HOT_WATER;

const result = applyDamage({
  playerId: pid,
  player: q,
  amount: 1,
  reason,
  now,
  send,
  onDeath: killPlayer,
});

if (result.applied > 0 && !result.lethal) {
  send(q.ws, { t: 'msg', s: DAMAGE_TEXT[reason] });
}
```

For lethal damage, the death/respawn event supplies the primary message. Avoid showing both a
normal burn toast and a death toast in the same frame unless intentionally composed.

Thermal cadence should follow guide 01:

- Two-second entry grace.
- One damage every five accumulated seconds without correct cloak.
- One damage every ten accumulated seconds with correct cloak.
- Reset on land, temperate water, shelter, mine, or active boat.

The one-HP bug must be fixed even if cadence refactoring is delivered later. The minimal safe fix is
zero clamp plus common death handling; the final implementation should use elapsed seconds.

## 10. Wooden Boat Destruction

Boat destruction and player damage are separate state changes:

1. Validate the active vehicle server-side.
2. Remove the exact destroyed boat kind from inventory.
3. Clear active boat state.
4. Broadcast boat destruction and swimmer mode.
5. Apply wreck/burn damage through `applyDamage()`.
6. If lethal, stop processing water-entry effects for that player during the current handler.
7. If alive, leave the player swimming at the wreck position and begin thermal exposure grace/cadence
   according to design.

Example:

```js
function destroyBoat(playerId, p, reason, now) {
  const kind = p.activeVehicle;
  if (kind !== 'boat' && kind !== 'sboat') return { destroyed: false, lethal: false };

  if ((p.inv[kind] || 0) > 0) p.inv[kind]--;
  p.activeVehicle = null;
  p.mode = 'swim';
  if ((p.inv[kind] || 0) <= 0 && p.selectedVehicle === kind) p.selectedVehicle = null;

  bcast({ t: 'vehicleDestroyed', id: playerId, kind, reason, mode: 'swim' });
  sendInv(playerId, p);

  const damageReason = reason === 'burn'
    ? DAMAGE_REASON.BOAT_BURN
    : DAMAGE_REASON.BOAT_WRECK;
  const result = applyDamage({
    playerId, player: p, amount: 2, reason: damageReason, now, send,
    onDeath: killPlayer,
  });
  return { destroyed: true, lethal: result.lethal };
}
```

Do not always decrement `p.inv.boat`; reinforced destruction must decrement `sboat` if that hazard
can destroy reinforced boats. This should be implemented with server-owned vehicle state from guide
01 rather than trusting `m.b`.

## 11. Preventing Double Damage In One Tick

The current environment tick evaluates thermal water and then separately evaluates weather,
biome, hunger, thirst, and campfire regeneration. A player can receive thermal feedback and another
environmental outcome during one interval.

Choose and document a policy. Recommended first pass:

- Apply at most one environmental damage source per five-second environment interval.
- Priority: thermal water, severe weather, biome exposure, dehydration, starvation.
- Campfire regeneration runs only when no damage source applied.
- Creature and fall damage remain independent because they are event-driven.

Represent the selected source before applying it:

```js
function chooseEnvironmentalDamage(q, worldState) {
  // Fall through when thermal damage is not yet due (entry grace, cadence gap):
  // returning early on mere exposure would make a swimmer in grace immune to
  // starvation and dehydration.
  const thermal = isThermallyExposed(q, worldState)
    ? thermalDamageDue(q, worldState)
    : null;
  if (thermal) return thermal;
  if (isSandstormExposed(q, worldState)) return { amount: 1, reason: 'sandstorm' };
  if (isSnowstormExposed(q, worldState)) return { amount: 1, reason: 'snowstorm' };
  if (isDesertHeatExposed(q, worldState)) return { amount: 1, reason: 'desert-heat' };
  if (isGlacialColdExposed(q, worldState)) return { amount: 1, reason: 'glacial-cold' };
  if (q.thirst <= 0) return { amount: 1, reason: 'dehydration' };
  if (q.hunger <= 0) return { amount: 1, reason: 'starvation' };
  return null;
}
```

After lethal damage, `continue` to the next player. Do not run regeneration, another damage source,
or stale-position messages on the just-respawned player in the same loop.

## 12. Migrate Every Damage Source

### Falls

Current fall logic mutates incoming message coordinates during respawn. Instead:

- Validate old/new positions first.
- Compute fall damage.
- Apply through `applyDamage()`.
- If lethal, do not assign the incoming destination after respawn.
- If alive, commit the validated destination.

```js
const result = applyDamage({
  playerId: id, player: p, amount: drop - 1,
  reason: DAMAGE_REASON.FALL, now, send, onDeath: killPlayer,
});
if (result.lethal) return;
```

Note that the legacy `hp` message currently doubles as a position-correction channel: the client
teleports to `m.x`/`m.y` when they differ from its position by more than three tiles, and
nonlethal falls depend on that. The new `damage` event carries no coordinates, so before retiring
the legacy event, move server position corrections to an explicit `{ t: 'pos', x, y, z }` event (or
an equivalent authoritative move message). Do not overload the damage event with coordinates.

### Creature Contact

Use the creature's validated contact damage. If lethal, do not continue checking more creatures for
that player in the same simulation pass.

### Weather, Hunger, And Thirst

Use positive damage amounts rather than `delta = -1`. Keep healing separate from damage so a sign
mistake cannot turn a hazard into healing.

### Boat Wreck

Use `destroyBoat()` and `applyDamage()`, never a special one-HP clamp.

### Future PvP

If added, include attacker ID in a safe optional field and retain the same pipeline. Do not build a
second PvP-only death implementation.

## 13. Healing API

Damage and healing should be separate functions with parallel result semantics:

```js
export function applyHealing({ player, amount, source, send }) {
  if (!Number.isFinite(amount) || amount <= 0 || player.dead || player.hp <= 0)
    return { applied: 0, hp: player.hp, ignored: 'invalid' };

  const previousHp = player.hp;
  const hp = Math.min(MAX_HP, previousHp + Math.floor(amount));
  const applied = hp - previousHp;
  if (applied <= 0) return { applied: 0, hp, ignored: 'full-health' };

  player.hp = hp;
  send(player.ws, { t: 'heal', amount: applied, hp, maxHp: MAX_HP, source });
  return { applied, previousHp, hp, ignored: null };
}
```

This function supersedes the `setHealth`/`healPlayer` sketches in guide 05 section 5 — implement
`applyHealing` once and have the guide 05 handlers call it. The `useResult`/`medicResult`
confirmation messages from guide 05 remain, but the HP change itself travels in the `heal` event,
not a bare `hp` message.

Use this for:

- Campfire regeneration.
- Medicine from guide 05.
- Medic full treatment from guide 05.
- Future food or cooperative healing.

Do not send a generic `hp: 10` message and expect the client to infer whether it was regeneration,
medicine, medic treatment, spawn initialization, or respawn.

## 14. Protocol Events

Recommended server-to-client events:

### Damage

```json
{
  "t": "damage",
  "amount": 1,
  "hp": 3,
  "maxHp": 10,
  "reason": "hot-water"
}
```

### Healing

```json
{
  "t": "heal",
  "amount": 3,
  "hp": 7,
  "maxHp": 10,
  "source": "medicine"
}
```

### Local Respawn

```json
{
  "t": "respawn",
  "hp": 10,
  "maxHp": 10,
  "hunger": 10,
  "thirst": 10,
  "x": 168,
  "y": 168,
  "z": 0,
  "reason": "hot-water"
}
```

### Remote Death/Respawn

```json
{ "t": "playerDeath", "id": "p1", "x": 640.2, "y": 610.8, "reason": "hot-water" }
{ "t": "playerRespawn", "id": "p1", "x": 168, "y": 168, "z": 0 }
```

The server may keep legacy `hp` events for one compatibility phase, but the new client must not use
HP values to infer event type. Remove compatibility after all handlers are migrated. The legacy
`hp` handler also performs large-delta position correction from its optional `x`/`y` fields; that
responsibility must be migrated to a dedicated position event (see the fall migration in the
previous section) before the legacy event is removed.

## 15. Client Handling

Replace the generic HP inference with explicit branches:

```ts
else if (m.t === 'damage') {
  const previous = this.hp;
  this.hp = m.hp;
  if (m.amount > 0 && m.hp < previous) {
    // playDamageFeedback selects sound and effect by reason (section 16);
    // do not play the combat hurt sound unconditionally here, or hunger and
    // exposure ticks inherit it.
    this.playDamageFeedback(m.reason, m.amount);
  }
}
else if (m.t === 'heal') {
  this.hp = m.hp;
  if (m.amount > 0) this.playHealingFeedback(m.source, m.amount);
}
else if (m.t === 'respawn') {
  this.resetLocalTraversalAndActions();
  this.hp = m.hp;
  this.hunger = m.hunger;
  this.thirst = m.thirst;
  this.px = m.x;
  this.py = m.y;
  this.setZ(0);
  showMsg(this.respawnMessage(m.reason));
}
```

Damage sound conditions:

- Play only when `amount > 0` and new HP is below previous HP.
- Never play merely because a damage message string arrived.
- Rate-limit looping environmental audio separately from impact sounds.
- On lethal damage, avoid playing repeated hurt sound plus death sound unless deliberately mixed.

At one HP, the next hot-water tick should produce one final lethal damage event followed by respawn.
There must not be an endless stream of unchanged `hp: 1` events.

## 16. Damage Feedback By Reason

Keep gameplay state independent of effects. Map reasons to presentation:

| Reason | Local feedback |
|---|---|
| `hot-water` | brief red/orange flash, steam/burn sound |
| `freezing-water` | pale-blue flash, ice crack/shiver sound |
| `boat-burn` | hull fire/splash plus one damage reaction |
| `boat-wreck` | impact/splash plus one damage reaction |
| `fall` | short impact, dust, optional camera nudge |
| `creature` | hurt sound and directional recoil if attacker known |
| `sandstorm` | muted hit, sand overlay pulse |
| `snowstorm` | cold pulse, not a physical impact animation |
| `starvation` | HUD pulse, avoid loud combat hit sound |
| `dehydration` | HUD pulse, avoid loud combat hit sound |

Do not use the same aggressive hit sound every five seconds for hunger or exposure. Environmental
loops should communicate danger without becoming audio spam.

## 17. Death And Respawn Presentation

Immediate first-pass sequence:

1. Server applies lethal damage and sends/broadcasts death.
2. Client stops current action, swimming stroke, boat pose, and placement mode.
3. Brief fade or desaturation, approximately 250-400ms.
4. Server-provided respawn position is applied.
5. Client clears stale boat/water effects and restores surface visibility.
6. Fade in and show reason-specific message.

The server should update state immediately even if the client presentation takes longer. During a
future delayed-respawn phase, server `deadUntil` must gate movement/actions; do not let the visual
fade be the only lock.

Clear these local states on respawn:

- `sailing`, `swimming`, `boatKind`, and boat sprite.
- Jump timer.
- Active rig action/tween or pose state.
- Placement ghost and placement selection if placement cannot survive teleport.
- Mine/shelter anchors and Z-level visuals.
- Thermal warning state and waterline effects.
- Camera interpolation that would slowly pan across the full map; snap/fade to respawn instead.

Preserve intentional durable selections such as equipped tool, worn cloak, and optionally selected
vehicle, based on server snapshot.

## 18. Interaction With Medicine And Medics

Guide 05 introduces healing that can move a player from one HP to four or ten. Therefore:

- `heal` must never be interpreted as respawn.
- Medicine cannot be used while `dead` or after lethal damage processing begins.
- Medic offers should be removed or invalidated on death.
- Medic acceptance must revalidate HP and `dead` state atomically.
- `lastDamageAt` from the centralized damage helper powers the medic combat lockout.
- Campfire regeneration and medicine/medic treatment use `applyHealing()`.
- If health changes while the medic dialog is open, the server remains authoritative and may reject
  a now-full-health trade without deducting payment.

## 19. Persistence And Reconnect

- Never persist `dead: true` as a durable profile state in the first phase.
- Snapshot only a valid positive HP after death/respawn processing.
- Clamp restored HP to `[1, MAX_HP]`; invalid, zero, NaN, or missing HP should restore at spawn with
  a documented default.
- Do not restore saved water positions unless reconnect-on-water is deliberately supported.
- Reset ephemeral exposure counters and active vehicle state according to guide 01.
- If the server terminates between damage and a delayed respawn in a future design, recovery logic
  must detect dead/pending states and complete respawn on startup.

In future Postgres-backed sessions, health and respawn position should be committed in one
transaction or represented by an idempotent death event. Redis fanout must not be the sole durable
record of death.

## 20. Observability

Add structured development logs or metrics without logging every nonlethal tick in production:

```js
console.log(JSON.stringify({
  event: 'player_damage',
  playerId,
  reason,
  amount: result.applied,
  hp: result.hp,
  lethal: result.lethal,
}));
```

Useful counters:

- Damage events by reason.
- Deaths by reason.
- Boat burns and wreck deaths.
- Thermal damage that occurs after boat destruction.
- Respawns by bed/campfire/world-spawn source.
- Ignored damage attempts against already-dead players.
- Healing by campfire, medicine, and medic.

Do not include browser tokens, inventory contents, chat, or unnecessary personal data in logs.

## 21. Unit Tests For Health Helpers

Test `applyDamage()` without WebSocket timing:

1. 10 HP minus 1 becomes 9 with `applied: 1`.
2. 1 HP minus 1 becomes 0 and calls death exactly once.
3. 1 HP minus 5 applies only 1 actual damage and is lethal.
4. Zero, negative, NaN, and infinite amounts are ignored.
5. Damage against `dead` player is ignored.
6. Damage cannot produce negative stored HP.
7. Event amount equals actual HP reduction, not requested overkill.
8. `lastDamageAt` updates only when damage applies.
9. No event is sent for zero applied damage.

Test `applyHealing()`:

1. 4 HP plus 3 becomes 7.
2. 9 HP plus 3 becomes 10 with `applied: 1`.
3. Full-health healing is ignored.
4. Dead/zero-HP healing is rejected unless a revive feature is explicitly implemented.
5. Healing never emits damage/death/respawn events.

## 22. Hot-Water Integration Tests

Use a fake clock or extracted thermal function so tests do not wait real seconds.

Required scenario:

1. Give player a wooden boat through test-only server setup.
2. Select and launch it through the authoritative vehicle protocol.
3. Move into valid Core hot water.
4. Verify wooden boat is removed and swimmer mode begins.
5. Verify wreck burn damage is applied once.
6. Advance thermal exposure through its grace/cadence.
7. Verify HP reaches one normally.
8. Advance one more due damage interval.
9. Verify lethal damage, exactly one death, and exactly one respawn.
10. Verify no further hot-water damage/message arrives after respawn.
11. Verify player is on valid land with cleared swimming/boat/exposure state.

Additional thermal cases:

- Correct heat cloak slows cadence but does not create a permanent one-HP floor.
- Reinforced boat prevents swimmer thermal damage while active.
- Leaving hot water resets exposure.
- Re-entering hot water applies grace according to guide 01.
- Starvation and hot water in the same environment interval do not double-kill.
- A swimmer inside the thermal entry grace or between cadence ticks can still take starvation or
  dehydration damage; thermal exposure alone does not mask other environmental sources.
- Forged client boat flags do not prevent damage.

## 23. Every-Source Integration Matrix

| Source | Nonlethal | Lethal | Feedback once | Respawn once |
|---|---|---|---|---|
| Creature contact | Required | Required | Required | Required |
| Fall | Required | Required | Required | Required |
| Wooden boat burn | Required | Required | Required | Required |
| Iceberg wreck | Required | Required | Required | Required |
| Freezing water | Required | Required | Required | Required |
| Hot water | Required | Required | Required | Required |
| Sandstorm | Required | Required | Required | Required |
| Snowstorm | Required | Required | Required | Required |
| Desert heat | Required | Required | Required | Required |
| Glacial cold | Required | Required | Required | Required |
| Starvation | Required | Required | Required | Required |
| Dehydration | Required | Required | Required | Required |

For each source, assert reason, actual amount, HP, death count, respawn coordinates, and cleared
ephemeral state.

## 24. Manual Reproduction And Verification

Before fix:

1. Use dev kit to obtain wooden boat.
2. Approach Core hot water.
3. Enter in wooden boat and allow it to burn.
4. Remain swimming until one HP.
5. Observe that HP remains one while warning/feedback continues.

After fix:

1. Repeat the same route with hunger and thirst above zero.
2. Confirm boat destruction causes exactly one wreck reaction.
3. Confirm hot-water damage cadence is readable.
4. Confirm final damage reaches zero and produces one death sequence.
5. Confirm respawn happens on valid land.
6. Confirm hot-water message, swimming action, thermal particles, and hurt sound stop after respawn.
7. Confirm remote player sees death and respawn instead of a swimmer remaining at Core.
8. Use medicine from one HP in a safe location and confirm healing to four is not treated as death.
9. Use medic treatment from one HP and confirm healing to ten is not treated as respawn.

Also test low frame rate and temporary packet delay. The client must process explicit ordered events
without playing multiple deaths or leaving the rig in swimming pose at the respawn location.

## 25. Phased Implementation

### Phase 1: Minimal Critical Fix

- **Implemented for thermal damage:** allow zero HP.
- **Implemented for thermal damage:** route death through the legacy respawn behavior.
- **Implemented for thermal damage:** stop the unchanged one-HP feedback loop.
- Add the exact Core boat-burn regression test.

This phase removes the live gameplay lock but still leaves duplicated health logic.

### Phase 2: Central Health Pipeline

- Add `MAX_HP`, damage reasons, `applyDamage()`, `applyHealing()`, and explicit dead state.
- Migrate hot/freezing water, boat wrecks, falls, creatures, weather, hunger, and thirst.
- Add unit and every-source integration tests.

### Phase 3: Explicit Protocol

- Add `damage`, `heal`, `playerDeath`, `respawn`, and `playerRespawn` events.
- Remove client HP-value inference.
- Reset local traversal/action state explicitly on respawn.
- Keep a short compatibility bridge only if needed.

### Phase 4: Presentation And Observability

- Add reason-specific sound/effects and death fade.
- Prevent environmental audio spam.
- Add structured metrics/logging.
- Verify four-player remote behavior and reconnect.

## 26. Acceptance Criteria

- A player swimming in Core hot water can reach zero HP and respawn normally.
- No code path clamps lethal damage to one while continuing damage feedback.
- Wooden boat destruction cannot leave a player in an immortal one-HP swimming state.
- Damage messages, animations, and sounds occur only when positive damage is applied.
- Lethal damage produces one death and one respawn, never duplicates.
- Respawn clears active boat, swimming, thermal exposure, and stale action state.
- Healing to full through a medic is never mistaken for respawn.
- Every existing damage source uses one authoritative pipeline and stable reason.
- Client rendering is driven by explicit damage/heal/death/respawn events.
- Unit, integration, multiplayer, and manual Core regression checks pass before completion.

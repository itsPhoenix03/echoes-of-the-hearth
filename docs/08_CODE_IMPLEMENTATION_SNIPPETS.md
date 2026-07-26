# Code Implementation Snippets

> **Baseline:** commit `5e792c7`, reviewed 2026-07-21. These snippets are implementation
> scaffolds for the remaining work in guide 07. They use the repository's current JavaScript server,
> shared ES modules, TypeScript/Phaser client, and `ws` protocol. Do not paste an entire section
> without adapting nearby names and existing handlers. Implement and test one authority layer at a
> time.

## 1. Recommended File Boundaries

`server/index.js` is already large. Move reusable rules into modules before adding more handlers:

```text
server/
  health.js          damage, healing, death and respawn policy
  movement.js        coordinate and traversal validation
  medicine.js        medicine use and medic offer rules
  save-validation.js snapshot and profile validation
shared/
  landmarks.js       landmark masks and placement rules, or keep exports in world.js
  protocol.js        stable event/action/reason constants
test/
  unit/
  world/
  integration/
```

Modules should receive state and callbacks instead of importing the live player map. This keeps
unit tests deterministic and prevents circular imports.

## 2. Configurable Server Startup

Replace hardcoded startup values in `server/index.js`. Tests need separate ports and save files:

```js
import { fileURLToPath } from 'node:url';

const PORT = Number.parseInt(process.env.PORT || '8081', 10);
const SAVE_PATH = process.env.SAVE_PATH || fileURLToPath(new URL('./save.json', import.meta.url));

if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}
```

Keep production defaults unchanged. A value of `PORT=0` can be supported later if the server
reports the OS-selected port to the test runner.

## 3. Server-Owned Movement And Vehicles

Create `server/movement.js`:

```js
import { SIZE, T } from '../shared/world.js';

export const MOVE_SPEED = Object.freeze({ land: 7, swim: 4, boat: 10 }); // tiles/second
export const VEHICLES = new Set(['boat', 'sboat']);

export function validPosition(x, y, z) {
  return Number.isFinite(x) && Number.isFinite(y) && Number.isInteger(z) &&
    x >= 0 && y >= 0 && x < SIZE && y < SIZE && z >= 0 && z <= 2;
}

export function validateStep(p, request, world, now = Date.now()) {
  const { x, y, z } = request;
  if (!validPosition(x, y, z)) return { ok: false, reason: 'invalid_position' };

  const elapsed = Math.min(0.5, Math.max(0.05, (now - p.lastPosAt) / 1000));
  const maxDistance = MOVE_SPEED[p.mode] * elapsed + 0.75; // small network jitter allowance
  if (Math.hypot(x - p.x, y - p.y) > maxDistance) {
    return { ok: false, reason: 'movement_too_fast' };
  }

  const i = (y | 0) * SIZE + (x | 0);
  const water = world.tiles[i] === T.WATER;
  const nextMode = water ? (p.activeVehicle ? 'boat' : 'swim') : 'land';
  return { ok: true, x, y, z, i, water, nextMode };
}

export function selectVehicle(p, kind) {
  if (kind !== null && !VEHICLES.has(kind)) return { ok: false, reason: 'invalid_vehicle' };
  if (kind && Number(p.inv[kind] || 0) < 1) return { ok: false, reason: 'not_owned' };
  p.selectedVehicle = kind;
  return { ok: true, selected: kind };
}
```

Initialize each connected player with server-owned fields:

```js
Object.assign(p, {
  selectedVehicle: null,
  activeVehicle: null,
  mode: 'land',
  lastLandX: p.x,
  lastLandY: p.y,
  lastPosAt: Date.now(),
});
```

Then replace the direct `m.x`/`m.y`/`m.b` assignment in the current `pos` handler:

```js
if (m.t === 'selectVehicle') {
  const result = selectVehicle(p, m.kind ?? null);
  if (!result.ok) return send(ws, { t: 'reject', op: m.t, reason: result.reason });
  return send(ws, { t: 'vehicle', id, selected: p.selectedVehicle,
    active: p.activeVehicle, mode: p.mode });
}

if (m.t === 'pos') {
  if (p.dead) return;
  const step = validateStep(p, m, world);
  if (!step.ok) {
    return send(ws, { t: 'positionCorrection', x: p.x, y: p.y, z: p.z,
      reason: step.reason });
  }

  const wasWater = world.tiles[ti(p.x, p.y)] === T.WATER;
  if (!wasWater && step.water && !p.activeVehicle && p.selectedVehicle) {
    if (Number(p.inv[p.selectedVehicle] || 0) > 0) p.activeVehicle = p.selectedVehicle;
  }
  if (wasWater && !step.water) p.activeVehicle = null; // validated docking transition

  p.x = step.x; p.y = step.y; p.z = step.z;
  p.mode = step.water ? (p.activeVehicle ? 'boat' : 'swim') : 'land';
  p.lastPosAt = Date.now();
  if (!step.water) { p.lastLandX = p.x; p.lastLandY = p.y; }

  broadcast({ t: 'pos', id, x: p.x, y: p.y, z: p.z,
    mode: p.mode, activeVehicle: p.activeVehicle }, id);
}
```

Do not read `m.b` after this migration. Boat hazard protection must use `p.activeVehicle`. Decide
whether launching consumes a boat or whether destruction decrements it, then apply that policy once.

## 4. Central Health Pipeline

Create `server/health.js` with callbacks so the helper does not depend on WebSocket globals:

```js
export const MAX_HP = 10;

export function applyDamage(ctx, p, amount, reason, now = Date.now()) {
  if (p.dead || !Number.isFinite(amount) || amount <= 0) return { applied: 0, lethal: false };
  const before = p.hp;
  p.hp = Math.max(0, before - Math.floor(amount));
  const applied = before - p.hp;
  if (!applied) return { applied: 0, lethal: false };

  p.lastDamageAt = now;
  ctx.send(p.ws, { t: 'damage', hp: p.hp, maxHp: MAX_HP, amount: applied, reason });
  if (p.hp === 0) {
    p.dead = true; // set before callbacks to prevent re-entrant damage
    ctx.respawn(p, reason);
  }
  return { applied, lethal: p.hp === 0 };
}

export function applyHealing(ctx, p, amount, source) {
  if (p.dead || !Number.isFinite(amount) || amount <= 0 || p.hp >= MAX_HP) {
    return { applied: 0 };
  }
  const applied = Math.min(MAX_HP - p.hp, Math.floor(amount));
  p.hp += applied;
  ctx.send(p.ws, { t: 'heal', hp: p.hp, maxHp: MAX_HP, amount: applied, source });
  return { applied };
}
```

Use one respawn function in `server/index.js`:

```js
function respawnPlayer(id, p, reason) {
  const [x, y] = validatedRespawnFor(p); // bed if safe, otherwise world spawn
  Object.assign(p, {
    hp: MAX_HP, hunger: 10, thirst: 10, x, y, z: 0,
    dead: false, selectedVehicle: null, activeVehicle: null, mode: 'land',
    thermalExposure: 0, lastLandX: x, lastLandY: y, lastPosAt: Date.now(),
  });
  send(p.ws, { t: 'respawn', x, y, z: 0, hp: p.hp, maxHp: MAX_HP,
    hunger: p.hunger, thirst: p.thirst, reason });
  broadcast({ t: 'playerRespawn', id, x, y, z: 0 }, id);
}
```

For periodic hazards, select one source per cadence rather than applying several in the same tick:

```js
function environmentalReason(p, tile) {
  if (tile.waterTemp === 2 && p.mode === 'swim') return 'hot_water';
  if (tile.waterTemp === 1 && p.mode === 'swim' && p.wornGear !== 'cloak') return 'freezing_water';
  if (p.hunger <= 0) return 'starvation';
  if (p.thirst <= 0) return 'dehydration';
  return null;
}

const reason = environmentalReason(p, tileState);
if (reason) applyDamage(healthContext, p, 1, reason);
```

Every old direct `p.hp -=`, `Math.max(1, ...)`, glowcap assignment, and campfire increment must be
replaced by `applyDamage` or `applyHealing`.

## 5. Landmark And Build Authority

Import the existing shared mask into `server/index.js`:

```js
import { ACTIVATION_I, LANDMARK_BLOCK, SIZE, T } from '../shared/world.js';

function canBuildAt(kind, i) {
  if (!Number.isInteger(i) || i < 0 || i >= SIZE * SIZE) return false;
  if (i === ACTIVATION_I) return kind === 'engine';
  if (LANDMARK_BLOCK.has(i)) return false;
  if (world.tiles[i] === T.WATER) return false;
  if (structures.has(i) || farms.has(i)) return false;
  return true;
}

if (m.t === 'build') {
  const i = Number(m.i);
  const kind = String(m.kind || '');
  if (!canBuildAt(kind, i)) return send(ws, { t: 'reject', op: 'build', reason: 'blocked' });
  // Continue with distance, recipe, payment, and placement checks.
}
```

Use the same mask inside the server's `blocked()` function used by creatures and wildlife. Keep
interaction-only tiles separate from movement and building masks if later landmarks need different
rules.

## 6. Save Validation

Create `server/save-validation.js` and validate before mutating live maps:

```js
import { SIZE, T, WORLD_VERSION } from '../shared/world.js';

const validIndex = (i) => Number.isInteger(i) && i >= 0 && i < SIZE * SIZE;
const expectedLayout = (seed) => `v${WORLD_VERSION}:${SIZE}:${seed}`;

export function validSnapshot(s, seed) {
  if (!s || s.version !== WORLD_VERSION || s.seed !== seed) return false;
  if (s.layout !== expectedLayout(seed)) return false;
  const indexLists = [s.mud, s.digs, s.torches, s.brokenBergs];
  if (indexLists.some((list) => !Array.isArray(list) || !list.every(validIndex))) return false;
  const pairLists = [s.removed, s.structures, s.furn || [], s.farms || [], s.chestInv || []];
  return pairLists.every((list) => Array.isArray(list) && list.every(([i]) => validIndex(i)));
}

export function sanitizeProfile(profile, spawn, world) {
  const x = Number(profile?.x), y = Number(profile?.y);
  const i = Number.isFinite(x) && Number.isFinite(y) ? (y | 0) * SIZE + (x | 0) : -1;
  const safe = validIndex(i) && world.tiles[i] !== T.WATER;
  return {
    ...profile,
    x: safe ? x : spawn[0], y: safe ? y : spawn[1], z: 0,
    hp: Math.max(1, Math.min(10, Number(profile?.hp) || 10)),
    hunger: Math.max(0, Math.min(10, Number(profile?.hunger) || 10)),
    thirst: Math.max(0, Math.min(10, Number(profile?.thirst) || 10)),
  };
}
```

Parse into a temporary object, validate all sections, and only then populate live maps. Never leave a
half-loaded world after one invalid collection throws.

## 7. World-Generation Corrections

In `shared/world.js`, centralize minor-island supply eligibility:

```js
const MINOR_SUPPLIES = Object.freeze({
  rock: new Set([NODE.STONE]),
  driftwood: new Set([NODE.TREE, NODE.BUSH]),
  sandbar: new Set(),
  ruin: new Set(),
  icefloe: new Set(),
  blightshard: new Set(),
});

function minorAllowsNode(minor, nodeKind) {
  return !minor || MINOR_SUPPLIES[minor.kind]?.has(nodeKind) === true;
}
```

Apply it at the single point where nodes are inserted, not by deleting nodes afterward. When a
landmark stamps land after temperature generation, clear impossible water metadata:

```js
function stampLand(world, x, y, tile, elevation = 1) {
  const i = y * SIZE + x;
  world.tiles[i] = tile;
  world.elev[i] = elevation;
  world.waterTemp[i] = 0;
  world.bergs.delete(i);
  world.nodes.delete(i);
}
```

Fix Core vent placement by handling decor before a `T.BLIGHT` branch exits, or by running a separate
deterministic decor pass:

```js
if (tiles[i] === T.BLIGHT && !nearPOI(x, y) && sct(x / 9, y / 9) > 0.91) {
  decor.set(i, 'lava_vent');
}
```

If `decor` does not currently exist in the returned world model, use the project's existing decor
collection instead of introducing a second one.

## 8. Medicine And Medic Handlers

Add medicine as an inventory item/recipe in `shared/defs.js` using resource keys that already exist:

```js
export const MEDICINE_HEAL = 3;

RECIPES.medicine = {
  station: 'campfire',
  cost: { fiber: 4, water: 1 }, // matches guide 05 and current inventory resource keys
};

NAMES.medicine = 'Medicine';
```

Server use must be atomic and must not consume at full health:

```js
if (m.t === 'useItem' && m.kind === 'medicine') {
  const now = Date.now();
  if (p.dead || p.hp >= MAX_HP) return send(ws, { t: 'useResult', ok: false, reason: 'not_needed' });
  if (now - (p.lastMedicineAt || 0) < 1500) return send(ws, { t: 'useResult', ok: false, reason: 'cooldown' });
  if (Number(p.inv.medicine || 0) < 1) return send(ws, { t: 'useResult', ok: false, reason: 'missing_item' });

  p.inv.medicine -= 1;
  p.lastMedicineAt = now;
  const result = applyHealing(healthContext, p, MEDICINE_HEAL, 'medicine');
  sendInv(id, p);
  return send(ws, { t: 'useResult', ok: true, kind: 'medicine', healed: result.applied });
}
```

Medic acceptance must revalidate offer owner, expiry, range, resources, and HP immediately before
payment:

```js
function acceptMedicOffer(id, p, medic, offer, now = Date.now()) {
  if (!offer || offer.playerId !== id || offer.medicId !== medic.id) return { ok: false, reason: 'invalid_offer' };
  if (offer.expiresAt <= now) return { ok: false, reason: 'expired' };
  if (Math.hypot(p.x - medic.x, p.y - medic.y) > 2.25) return { ok: false, reason: 'too_far' };
  if (p.hp >= MAX_HP) return { ok: false, reason: 'not_needed' };
  if (!canAfford(p.inv, offer.cost)) return { ok: false, reason: 'cannot_afford' };

  pay(p.inv, offer.cost);
  const healed = applyHealing(healthContext, p, MAX_HP, 'medic').applied;
  medicOffers.delete(id); // consume before sending responses to prevent replay
  sendInv(id, p);
  return { ok: true, healed };
}
```

Generate offers only from the Woods or Spire pool defined in guide 05. Store offers per player, not
per socket or globally, and preserve the server-selected cost in the accept path.

## 9. Explicit Client Health And Traversal Events

In `src/main.ts`, update local state only from explicit server events:

```ts
type TraversalMode = 'land' | 'swim' | 'boat';

function onServerMessage(message: ServerMessage) {
  switch (message.t) {
    case 'vehicle':
      localTraversal = { selected: message.selected, active: message.active, mode: message.mode };
      playerRig.setSwim(message.mode === 'swim');
      break;
    case 'damage':
      hp = message.hp;
      showDamageFeedback(message.reason, message.amount);
      break;
    case 'heal':
      hp = message.hp;
      showHealingFeedback(message.source, message.amount);
      break;
    case 'respawn':
      hp = message.hp;
      playerRig.setPosition(message.x * TILE_SIZE, message.y * TILE_SIZE);
      resetTransientPresentation();
      break;
  }
}
```

Remove logic that treats `hp === 10` as proof of respawn. A medic can produce the same HP value.

## 10. Animation Action Context

Fix the explicit-null tool bug first in `src/rig.ts`:

```ts
type ActionKind = 'chop' | 'mine' | 'slash' | 'gather' | 'collectWater';

type ActionContext = {
  kind: ActionKind;
  tool: string | null;
  seq: number;
  impactAt: number;
};

act(action: ActionContext) {
  if (this.acting) return false;
  this.acting = 1;
  const toolKind = action.tool; // null intentionally means bare hands
  if (toolKind) this.tool.setTexture(`i-${toolKind}`).setVisible(true);
  else this.tool.setVisible(false);
  this.startClip(action);
  return true;
}
```

Do not use `kind || this.holdKind`. A caller that wants the held tool must pass it explicitly.
Represent clips as keyframes and emit impact once when normalized time crosses `impactAt`:

```ts
private updateAction(dtMs: number) {
  const previous = this.actionElapsed / this.actionDuration;
  this.actionElapsed = Math.min(this.actionDuration, this.actionElapsed + Math.min(dtMs, 50));
  const current = this.actionElapsed / this.actionDuration;
  this.sampleClip(current);
  if (!this.impactSent && previous < this.action.impactAt && current >= this.action.impactAt) {
    this.impactSent = true;
    this.emit('impact', this.action.seq);
  }
  if (current >= 1) this.finishAction();
}
```

The server should accept gameplay first and broadcast one canonical action:

```js
if (m.t === 'action') {
  const accepted = validateGameplayAction(p, m, world);
  if (!accepted.ok) return send(ws, { t: 'actionResult', seq: m.seq, ok: false, reason: accepted.reason });
  const event = { t: 'action', id, seq: m.seq, kind: accepted.kind,
    tool: accepted.tool, target: accepted.target, startedAt: Date.now() };
  send(ws, { t: 'actionResult', seq: m.seq, ok: true });
  broadcast(event);
}
```

Bind sound and target effects to the accepted clip impact event. For network peers, compensate for
`startedAt` but clamp late arrivals instead of fast-forwarding beyond the end of the clip.

## 11. Isolated Integration Runner

Add scripts to `package.json` as described in guide 04, then create
`test/run-isolated-integration.mjs`:

```js
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const root = await mkdtemp(join(tmpdir(), 'hearth-test-'));
const port = 18081 + Math.floor(Math.random() * 1000);
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(port), SAVE_PATH: join(root, 'save.json'), SEED: 'test-seed' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await waitForServer(`ws://127.0.0.1:${port}`);
  await runTraversalCases(port);
  await runHealthCases(port);
  await runLandmarkCases(port);
  await runMedicineCases(port);
} finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  await rm(root, { recursive: true, force: true });
}
```

`waitForServer` must have a timeout and surface child stderr. Avoid a random fixed range in CI if
parallel workers can collide; reserving an ephemeral port before spawning is safer.

Example unit test for the critical movement trust boundary:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateStep } from '../../server/movement.js';

test('rejects non-finite and over-speed movement', () => {
  const p = { x: 10, y: 10, mode: 'land', lastPosAt: 1_000, activeVehicle: null };
  assert.equal(validateStep(p, { x: Infinity, y: 10, z: 0 }, world, 1_100).ok, false);
  assert.equal(validateStep(p, { x: 30, y: 10, z: 0 }, world, 1_100).reason, 'movement_too_fast');
});
```

## 12. Implementation Checklist

For each snippet:

1. Add the helper and its unit tests without switching callers.
2. Migrate one existing caller and verify unchanged valid behavior.
3. Add malformed/forged request tests.
4. Migrate the remaining callers and remove direct state mutations.
5. Add event fields to `init` and reconnect handling.
6. Verify two clients see identical accepted state.
7. Run `npm run build` and the relevant isolated suites.

Do not implement animation polish before movement/action authority. Do not implement medic full-heal
before explicit healing events. Do not tune route times before deterministic world metrics exist.

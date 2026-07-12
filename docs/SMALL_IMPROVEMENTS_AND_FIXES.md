# Small Improvements And Fixes Guide

This document is the shared place for small, targeted improvements that do not need a full feature design document. Add future small requests here when they are balance tweaks, UX polish, timing changes, visual fixes, minor protocol-safe adjustments, or small quality-of-life improvements.

Use this guide for changes like:

- Day/night cycle feels too fast.
- Hunger or thirst drains too fast/slow.
- Weather happens too often.
- UI messages are unclear.
- Audio timing feels off.
- Animation needs a tiny tuning pass, not a full rig refactor.
- Structure HP or crafting costs need minor rebalance.
- Small visual polish that does not change world generation.

Do not use this guide for large systems like map expansion, custom building, new biomes, major animation rewrites, new persistence formats, or new multiplayer mechanics. Those need their own docs and tests.

## General Workflow For Small Changes

1. Identify whether the change is client-only, server-only, shared data, or protocol-visible.
2. Prefer constants with descriptive names over hardcoded numbers.
3. Keep server-authoritative behavior on the server.
4. If a small change affects persistence or world generation, treat it as a bigger change.
5. Run `npm run build` for any code change.
6. Start a fresh server and run `node test.mjs` if server/shared behavior changed.
7. Tell the player if they need a server restart, hard refresh, or `server/save.json` deletion.

## Change Categories

### Client-Only Polish

Examples:

- HUD wording.
- Toast duration.
- Night overlay strength.
- Particle alpha/quantity.
- Camera smoothing.
- Local-only animation easing.

Usually touched files:

- `src/main.ts`
- `src/ui.ts`
- `src/audio.ts`
- `src/rig.ts`
- `index.html`

Verification:

- `npm run build`
- Manual browser check

### Server Balance

Examples:

- Day length.
- Hunger/thirst drain.
- Weather frequency.
- Monster spawn rate.
- Structure erosion rate.
- Damage values.

Usually touched files:

- `server/index.js`
- Sometimes `shared/defs.js`

Verification:

- `npm run build`
- Fresh server
- `node test.mjs`

### Shared Data Balance

Examples:

- Recipe costs.
- Node HP/yields.
- Structure HP.
- Resource names/inventory shape.

Usually touched files:

- `shared/defs.js`
- `src/ui.ts` if adding/removing visible resources
- `test.mjs` if server behavior changes

Verification:

- `npm run build`
- Fresh server
- `node test.mjs`

### Worldgen Tweaks

Examples:

- Node density.
- Island placement.
- Biome layout.
- Ore/vein density.

Usually touched files:

- `shared/world.js`

Important:

- This is not really a small change if it changes land/water or tile indices.
- Delete `server/save.json` during testing.
- Consider seed/version bump.

## Improvement 1: Day/Night Cycle Feels Too Fast

### Current Behavior

The server owns world time in `server/index.js`.

Current state:

```js
let nextCre = 1, nextAni = 1, time = 0.3, day = 1, won = false, tickN = 0;
```

Current night check:

```js
const isNight = () => time > 0.65 || time < 0.1;
```

Current day progression:

```js
// --- sim tick 200ms ---
setInterval(() => {
  tickN++;
  const prev = time;
  time = (time + 0.2 / 300) % 1; // 300s full day
  if (time < prev) { day++; bcast({ t: 'msg', s: `Day ${day} dawns over The Hearth.` }); }
```

Current values:

- Full day length: `300 seconds` / `5 minutes`.
- Night range: `time > 0.65 || time < 0.1`.
- Night duration fraction: `0.35 + 0.1 = 0.45` / `45%` of a day.
- Current night duration: `300 * 0.45 = 135 seconds` / `2.25 minutes`.
- Current daylight-ish duration: `165 seconds` / `2.75 minutes`.

Why it feels fast:

- A full day is only 5 minutes.
- Night is almost half the cycle.
- Travel, building, and exploration can easily consume an entire day.
- If map travel is expanded, 5-minute days become especially compressed.

### Recommended Target

Use a full day length of `900 seconds` / `15 minutes`.

Recommended values:

```js
const DAY_LENGTH_SEC = 900;
const NIGHT_START = 0.72;
const NIGHT_END = 0.08;
```

Result:

- Full day: 15 minutes.
- Night fraction: `0.28 + 0.08 = 0.36` / `36%`.
- Night duration: `900 * 0.36 = 324 seconds` / `5.4 minutes`.
- Daylight duration: `576 seconds` / `9.6 minutes`.

This gives players more useful daytime while preserving night as a meaningful threat.

### Alternative Targets

| Feel | Full Day | Night Start | Night End | Night Duration | Use When |
|---|---:|---:|---:|---:|---|
| Slightly slower | 600s / 10 min | 0.68 | 0.10 | 4.2 min | Minimal rebalance. |
| Recommended | 900s / 15 min | 0.72 | 0.08 | 5.4 min | Best general survival pacing. |
| Long expedition | 1200s / 20 min | 0.75 | 0.07 | 6.4 min | Expanded map with long sailing. |
| Harsh nights | 900s / 15 min | 0.65 | 0.10 | 6.75 min | More combat pressure. |
| Safer exploration | 900s / 15 min | 0.78 | 0.06 | 4.32 min | More building/travel focus. |

For the current user feedback, choose the recommended `900s` day first.

### Implementation Steps

In `server/index.js`, replace hardcoded time constants with named constants near the top:

```js
const TICK_MS = 200;
const DAY_LENGTH_SEC = 900;
const NIGHT_START = 0.72;
const NIGHT_END = 0.08;
```

Change:

```js
const isNight = () => time > 0.65 || time < 0.1;
```

To:

```js
const isNight = () => time > NIGHT_START || time < NIGHT_END;
```

Change:

```js
time = (time + 0.2 / 300) % 1;
```

To:

```js
time = (time + (TICK_MS / 1000) / DAY_LENGTH_SEC) % 1;
```

Change:

```js
setInterval(() => {
  ...
}, 200);
```

To:

```js
setInterval(() => {
  ...
}, TICK_MS);
```

### Client Night Display Must Match Server

The client currently duplicates night thresholds in two places.

In `src/ui.ts`:

```ts
const night = st.time > 0.65 || st.time < 0.1;
```

In `src/main.ts`:

```ts
const night = this.wtime > 0.65 || this.wtime < 0.1;
```

If server thresholds change but client thresholds do not, the server may spawn night threats while the HUD still shows day, or the client may darken the screen too early.

Minimum safe update:

- Change both client thresholds to match server values.

Better update:

- Put shared constants in a plain JS shared module, for example `shared/time.js`, and import it from both server and client.

Example `shared/time.js`:

```js
export const DAY_LENGTH_SEC = 900;
export const NIGHT_START = 0.72;
export const NIGHT_END = 0.08;
export const isNightTime = (time) => time > NIGHT_START || time < NIGHT_END;
```

Then:

- `server/index.js` imports `DAY_LENGTH_SEC`, `NIGHT_START`, `NIGHT_END`, `isNightTime`.
- `src/main.ts` imports `isNightTime`.
- `src/ui.ts` imports `isNightTime`.

Keep `shared/time.js` plain JS because shared modules must run in Node and browser.

### UI Hour Display

Current UI hour display in `src/ui.ts`:

```ts
const hour = ((st.time * 24 + 6) % 24) | 0;
```

This can remain unchanged. It maps `time=0` to 06:00. If changing night thresholds, verify the displayed hour still makes intuitive sense.

With recommended thresholds:

- Night starts at `time=0.72`: displayed hour `((0.72 * 24 + 6) % 24) = 23.28`, about 23:00.
- Night ends at `time=0.08`: displayed hour `7.92`, about 08:00.

This means night is roughly 23:00-08:00. That is readable.

If you want night to start closer to 20:00 visually, change the UI hour offset or thresholds together. Do not only change the display.

### Survival Drain Interaction

Current hunger/thirst drain happens every 5 seconds:

```js
if (tickN % 25 === 0) {
  q.hunger = Math.max(0, q.hunger - 0.08); // empty in ~10 min
  q.thirst = Math.max(0, q.thirst - 0.12); // empty in ~7 min
```

If day length increases to 15 minutes, survival drain becomes less tied to day count:

- Hunger still empties in about 10 minutes.
- Thirst still empties in about 7 minutes.
- A player can become thirsty before one full day passes.

This may be acceptable because hunger/thirst are real-time survival pressures. If it feels too harsh after day length increases, tune separately.

Recommended follow-up values if needed:

```js
q.hunger = Math.max(0, q.hunger - 0.055); // about 15 min
q.thirst = Math.max(0, q.thirst - 0.083); // about 10 min
```

Do not change hunger/thirst at the same time as day length unless testing shows both need adjustment. One variable at a time is easier to evaluate.

### Weather Interaction

Current weather roll:

```js
else if (!weather.kind && Math.random() < 1 / 450) { // ~every 90s on average
  weather.kind = ['rain', 'sandstorm', 'snowstorm'][(Math.random() * 3) | 0];
  weather.until = nowMs + (40 + Math.random() * 40) * 1000;
```

Because the sim ticks every 200ms, `1 / 450` means roughly one weather event every `450 * 0.2 = 90 seconds`.

If day length changes from 5 minutes to 15 minutes, weather happens about 10 times per day instead of 3-4 times per day. That may be too frequent.

Recommended weather tuning after `DAY_LENGTH_SEC = 900`:

```js
const WEATHER_AVG_INTERVAL_SEC = 180;
const WEATHER_MIN_DURATION_SEC = 45;
const WEATHER_MAX_DURATION_SEC = 90;
```

Roll probability per tick:

```js
Math.random() < TICK_MS / 1000 / WEATHER_AVG_INTERVAL_SEC
```

This gives about 5 weather events per 15-minute day, which is still active but less spammy.

### Monster And Blight Storm Interaction

Current night affects:

- Stalker spawn chance.
- Monster cap scaling.
- Blight Storm erosion every 10s at night.
- Night overlay and music mood on client.

If night becomes longer in seconds, erosion and night combat pressure become stronger unless tuned.

Current erosion check:

```js
if (tickN % 50 === 0 && isNight() && !won) {
```

With 5.4-minute recommended nights, this runs about 32 times per night. If that feels harsh, use a longer interval:

```js
const BLIGHT_EROSION_INTERVAL_SEC = 20;
```

Then check:

```js
if (tickN % Math.round(BLIGHT_EROSION_INTERVAL_SEC / (TICK_MS / 1000)) === 0 && isNight() && !won) {
```

Again, do not tune this until after testing the day length change.

### Test Plan For Day/Night Tuning

Manual test:

1. Start server fresh.
2. Join client and record displayed time.
3. Wait 2-3 real minutes and verify time progresses slower than before.
4. Confirm HUD night indicator appears at the new threshold.
5. Confirm screen darkening matches HUD night indicator.
6. Confirm monsters/stalkers spawn only during server-defined night.
7. Confirm day increments after the configured full day length.

Automated test idea:

- Add a small exported helper for `isNightTime()` in `shared/time.js` and unit-check threshold behavior if the repo later adds unit tests.
- Avoid making `test.mjs` wait for a full day; that would be too slow.

### Definition Of Done For Day/Night Change

- Server uses named constants, not hardcoded `300`, `0.65`, `0.1`, or `200` where related to the sim clock.
- Client HUD and overlay use the same night threshold as server.
- `npm run build` passes.
- Server restart is performed.
- No `server/save.json` deletion is required for time tuning only.
- User is told to hard refresh the browser after client code changes.

## Improvement Template For Future Small Fixes

Copy this section when adding a new small improvement.

### Improvement N: Title

Problem:

- Describe what feels wrong in one or two sentences.

Current behavior:

- File and line/constant/function involved.
- Current values.

Recommended change:

- New constants or behavior.
- Why this is the right first tuning pass.

Implementation:

- Files to edit.
- Specific functions/constants to change.

Risks:

- What else this may affect.
- Whether save files, protocol, or tests are impacted.

Verification:

- Build command.
- Manual test.
- Protocol test if needed.

Rollback:

- What value or code to restore if it feels worse.

## Backlog Of Small Improvements To Consider

### Weather Frequency Feels Too High

Likely file:

- `server/index.js`

Current:

- Average weather interval about 90 seconds.
- Duration 40-80 seconds.

Potential change:

- Use named constants.
- Increase average interval to 180 seconds.
- Keep duration 45-90 seconds.

### Hunger/Thirst Feels Too Harsh During Long Travel

Likely file:

- `server/index.js`

Current:

- Hunger empties in about 10 minutes.
- Thirst empties in about 7 minutes.

Potential change:

- Hunger about 15 minutes.
- Thirst about 10 minutes.
- Add more water collection options only if travel map expands.

### Toast Messages Stay Too Long Or Too Short

Likely files:

- `src/main.ts`
- `src/ui.ts`

Potential change:

- Standardize short toasts: 1200ms.
- Warnings: 3000-6000ms.
- Lore: 12000-15000ms.

### Footsteps Feel Repetitive

Likely file:

- `src/audio.ts`

Potential change:

- Slight random pitch/volume variation per step.
- Different cadence for sailing/walking/mud/snow.

### Boat Travel Needs More Feedback

Likely files:

- `src/main.ts`
- `src/audio.ts`

Potential change:

- Boat bobbing.
- Wake particles.
- Ocean wind loop while sailing.
- Warning sound near iceberg fields.

### Structure Placement Needs Clearer Valid/Invalid Feedback

Likely file:

- `src/main.ts`

Current:

- Ghost tint green/red.

Potential change:

- Add short text reason for invalid placement.
- Add small placement pop animation on successful build.

### Crafting Panel Needs Better Disabled Reasons

Likely file:

- `src/ui.ts`

Potential change:

- Show missing resources and required station in tooltip/subtext.
- Do not rebuild DOM per frame; keep signature-based rebuild.

## Current Recommended Small Change Set

For the specific feedback that day/night feels too fast, make only this first:

```js
DAY_LENGTH_SEC = 900
NIGHT_START = 0.72
NIGHT_END = 0.08
```

Also update client night checks to match. Do not simultaneously rebalance hunger, thirst, weather, and erosion unless testing shows the slower day creates new problems.
## Improvement 2: Heat/Fur Cloaks Should Be Manually Worn, One At A Time

Problem:

- Heat Cloak and Fur Cloak are currently passive gear unlocks.
- Once crafted, both are always active because the server checks ownership with `gear.has(...)`.
- The player cannot choose which cloak is being worn.
- There is no "wear none" state.
- This removes terrain decision-making: desert heat and snow cold become permanently solved after both cloaks are crafted.

Desired behavior:

- Crafting a cloak should unlock/own it, not automatically wear it forever.
- Player can wear only one cloak at a time:
  - `heatcloak`
  - `furcloak`
  - `null` / none
- Clicking the currently worn cloak should unequip it.
- Desert heat protection should require `wornGear === 'heatcloak'`.
- Snow cold protection should require `wornGear === 'furcloak'`.
- The UI should show owned cloaks and clearly mark the currently worn one.
- Ideally the player model should show a visual cloak tint/style when one is worn.

Current behavior:

In `shared/defs.js`, both recipes are gear:

```js
heatcloak: { cost: { fiber: 15, wood: 5 }, station: 'workbench', gear: true },
furcloak:  { cost: { fiber: 20, wood: 8 }, station: 'workbench', gear: true },
```

In `server/index.js`, crafting adds them to owned gear:

```js
else if (r.gear) p.gear.add(m.r);
```

Environmental protection currently checks ownership:

```js
else if (t === T.SAND && !isNight() && !q.gear.has('heatcloak')) { ... }
else if (t === T.SNOW && !q.gear.has('furcloak')) { ... }
```

That is the part that makes both cloaks permanently active after crafting.

Recommended implementation:

### Server State

Add a separate equipped/worn gear slot to each player.

Player shape in `server/index.js` should include:

```js
wornGear: null
```

Example in the `hello` player creation object:

```js
p = {
  ws,
  x: spawn[0],
  y: spawn[1],
  z: 0,
  hp: 10,
  hunger: 10,
  thirst: 10,
  inv: emptyInv(),
  tools: new Set(),
  gear: new Set(),
  equip: null,
  wornGear: null,
  lastGather: 0,
  lastAtk: 0,
  tok: typeof m.tok === 'string' ? m.tok.slice(0, 64) : null
};
```

Owned gear remains a set. Worn gear is only the active slot.

### Persistence

Update `snapshot(p)` to save the worn cloak:

```js
const snapshot = (p) => ({
  inv: p.inv,
  tools: [...p.tools],
  gear: [...p.gear],
  wornGear: p.wornGear || null,
  hp: p.hp,
  hunger: p.hunger,
  thirst: p.thirst,
  x: p.x,
  y: p.y
});
```

On profile restore:

```js
p.wornGear = prof.wornGear && p.gear.has(prof.wornGear) ? prof.wornGear : null;
```

Keep the `p.gear.has(...)` guard so corrupted/old saves cannot equip unowned gear.

### Init And Inventory Messages

Update `sendInv` to include `wornGear`:

```js
const sendInv = (id, p) => send(p.ws, {
  t: 'inv',
  inv: p.inv,
  tools: [...p.tools],
  gear: [...p.gear],
  wornGear: p.wornGear || null
});
```

Update `init` payload:

```js
inv: p.inv,
tools: [...p.tools],
gear: [...p.gear],
wornGear: p.wornGear || null,
```

Optional remote visual support: include `wornGear` in the `players` list if other clients should see cloaks on remote players.

Current list:

```js
players: [...players]
  .filter(([pid]) => pid !== id)
  .map(([pid, q]) => [pid, q.x, q.y, q.equip, q.z])
```

Potential new list:

```js
players: [...players]
  .filter(([pid]) => pid !== id)
  .map(([pid, q]) => [pid, q.x, q.y, q.equip, q.z, q.wornGear || null])
```

If you change this, update client unpacking defensively so old/new payloads do not crash.

### New Server Message: Wear Gear

Add a new client-to-server message, for example:

```json
{ "t": "wear", "k": "heatcloak" }
```

Rules:

- `k` can be `heatcloak`, `furcloak`, or `null`.
- If `k` is non-null, player must own it in `p.gear`.
- If player clicks the currently worn cloak, client can send `null`, or server can toggle it.
- Server is authoritative.

Server handler:

```js
else if (m.t === 'wear') {
  const k = m.k === null ? null : String(m.k);
  if (k !== null && !['heatcloak', 'furcloak'].includes(k)) return;
  if (k !== null && !p.gear.has(k)) return;
  p.wornGear = p.wornGear === k ? null : k;
  sendInv(id, p);
  send(ws, {
    t: 'msg',
    s: p.wornGear ? `Wearing ${NAMES[p.wornGear]}.` : 'No cloak worn.'
  });
}
```

If remote cloak visuals are added, also broadcast a cosmetic message:

```js
bcast({ t: 'wear', id, k: p.wornGear || null });
```

### Environmental Damage Checks

Change checks from owned gear to worn gear.

Current:

```js
else if (t === T.SAND && !isNight() && !q.gear.has('heatcloak')) {
  delta = -1;
  send(q.ws, { t: 'msg', s: 'The desert heat sears you! Craft a Heat Cloak.' });
}
else if (t === T.SNOW && !q.gear.has('furcloak')) {
  delta = -1;
  send(q.ws, { t: 'msg', s: 'The glacial cold bites! Craft a Fur Cloak.' });
}
```

Recommended:

```js
else if (t === T.SAND && !isNight() && q.wornGear !== 'heatcloak') {
  delta = -1;
  send(q.ws, {
    t: 'msg',
    s: q.gear.has('heatcloak')
      ? 'The desert heat sears you! Wear your Heat Cloak.'
      : 'The desert heat sears you! Craft a Heat Cloak.'
  });
}
else if (t === T.SNOW && q.wornGear !== 'furcloak') {
  delta = -1;
  send(q.ws, {
    t: 'msg',
    s: q.gear.has('furcloak')
      ? 'The glacial cold bites! Wear your Fur Cloak.'
      : 'The glacial cold bites! Craft a Fur Cloak.'
  });
}
```

This preserves crafting progression but requires correct terrain-based clothing choice.

### Dev Kit

Current dev kit adds both cloaks to `gear`:

```js
['heatcloak', 'furcloak'].forEach((g) => p.gear.add(g));
```

Recommended:

```js
['heatcloak', 'furcloak'].forEach((g) => p.gear.add(g));
p.wornGear = null;
```

Keep `null` so dev mode tests the new wearing UI instead of silently protecting the player.

### Client State

In `src/main.ts`, add:

```ts
wornGear: string | null = null;
```

On `init`:

```ts
this.wornGear = m.wornGear || null;
```

On `inv`:

```ts
this.inv = m.inv;
this.tools = new Set(m.tools);
this.gear = new Set(m.gear);
this.wornGear = m.wornGear || null;
```

Pass it into UI state:

```ts
this.updateUI({
  ...,
  gear: this.gear,
  equipped: this.equipped,
  wornGear: this.wornGear,
  ...
});
```

Add a method:

```ts
setWear(k: string | null) {
  if (k && !this.gear.has(k)) return;
  this.send({ t: 'wear', k });
}
```

Wire it into `initUI`:

```ts
this.updateUI = initUI(
  (r) => this.send({ t: 'craft', r }),
  (k) => this.setPlacing(k),
  (k) => this.send({ t: 'use', k }),
  (k) => this.setEquip(k),
  (k) => this.setWear(k)
);
```

### UI Changes

In `src/ui.ts`, extend `UIState`:

```ts
wornGear: string | null;
```

Extend `initUI` signature:

```ts
export function initUI(
  onCraft: (r: string) => void,
  onSelectPlace: (kind: string | null) => void,
  onUse: (k: string) => void,
  onEquip: (k: string) => void,
  onWear: (k: string | null) => void
) {
```

Add delegated click support in inventory and quickbar:

```ts
else if (el.dataset.wear) onWear(el.dataset.wear === 'none' ? null : el.dataset.wear);
```

Update inventory signature so UI rebuilds when worn cloak changes:

```ts
const sig = JSON.stringify([st.inv, [...st.tools], [...st.gear], selected, st.equipped, st.wornGear]);
```

Render owned gear as clickable:

```ts
html += [...st.gear].map((t) =>
  `<span class="slot tool ${st.wornGear === t ? 'eq' : ''}" data-wear="${t}">
    ${icon(t)} ${NAMES[t]}${st.wornGear === t ? ' ✓ worn' : ' (wear)'}
  </span>`
).join('');
```

Add a "no cloak" option if player owns at least one cloak:

```ts
if (st.gear.size) {
  html += `<span class="slot tool ${!st.wornGear ? 'eq' : ''}" data-wear="none">No cloak${!st.wornGear ? ' ✓' : ''}</span>`;
}
```

Add quickbar cloak controls if desired:

```ts
for (const g of ['heatcloak', 'furcloak']) {
  if (st.gear.has(g)) {
    qb += `<span class="slot tool ${st.wornGear === g ? 'eq' : ''}" data-wear="${g}">${icon(g)}</span>`;
  }
}
if (st.wornGear) qb += `<span class="slot tool" data-wear="none">× cloak</span>`;
```

This lets players switch without opening the Bag, which matters when crossing biome boundaries.

### Objective Text

Current objective says:

```ts
else if (!st.gear.has('heatcloak') || !st.gear.has('furcloak')) obj = 'Craft Heat & Fur Cloaks to survive the Dunes and the Spire';
```

Recommended:

```ts
else if (!st.gear.has('heatcloak') || !st.gear.has('furcloak')) {
  obj = 'Craft Heat & Fur Cloaks, then wear the right cloak for each island';
}
```

Optional terrain-aware objective later:

- If on sand and owns Heat Cloak but is not wearing it: `Wear your Heat Cloak before crossing the Dunes.`
- If on snow and owns Fur Cloak but is not wearing it: `Wear your Fur Cloak before climbing the Spire.`

### Visual Cloaks On Player

Minimum visual option:

- Add a cape/cloak image or generated texture in `src/rig.ts`.
- Tint it orange for Heat Cloak and pale blue/white for Fur Cloak.
- Hide it when `wornGear === null`.

Add texture generation:

```ts
tex('p-cloak', 18, 20, () => {
  g.fillStyle(0xffffff);
  g.fillTriangle(2, 0, 16, 0, 12, 20);
  g.fillTriangle(2, 0, 6, 20, 12, 20);
});
```

Add field:

```ts
cloak: Phaser.GameObjects.Image;
```

Place cloak behind torso:

```ts
this.cloak = mk('p-cloak', 0, -23, 0).setVisible(false);
this.add([this.legL, this.legR, this.cloak, this.armL, this.torso, this.head, this.armR, this.tool]);
```

Add method:

```ts
wear(kind: string | null) {
  if (!kind) { this.cloak.setVisible(false); return; }
  this.cloak
    .setVisible(true)
    .setTint(kind === 'heatcloak' ? 0xd98232 : 0xd8edf2);
}
```

Then call locally on `init`/`inv`:

```ts
this.me?.wear(this.wornGear);
```

Remote visual support requires broadcasting `wear` messages and calling:

```ts
const o = this.others.get(m.id);
o?.rig.wear(m.k);
```

If you do not add remote support yet, at least local cloak visuals are enough for player feedback.

### Protocol Reference Update

If implemented, update `AGENT_GUIDE.html` or the protocol docs with:

Client -> Server:

```json
wear { k }
```

Where:

- `k = 'heatcloak' | 'furcloak' | null`
- Server rejects non-owned cloaks.
- Equipping one cloak replaces the other.
- Sending the currently worn cloak toggles to none.

Server -> Client:

```json
inv { inv, tools, gear, wornGear }
```

Optional cosmetic broadcast:

```json
wear { id, k }
```

### Test Plan

Add tests to `test.mjs` if this is implemented server-side.

Suggested protocol test stage:

1. Use dev mode or grant resources to craft both cloaks.
2. Craft `heatcloak` and `furcloak`.
3. Assert both appear in `gear`.
4. Assert initial `wornGear` is `null` unless intentionally auto-wearing first crafted cloak.
5. Send `{ t: 'wear', k: 'heatcloak' }`; assert `wornGear === 'heatcloak'` in next `inv`.
6. Send `{ t: 'wear', k: 'furcloak' }`; assert `wornGear === 'furcloak'` and heat is not worn.
7. Send `{ t: 'wear', k: 'furcloak' }` again or `{ t: 'wear', k: null }`; assert `wornGear === null`.
8. Send `{ t: 'wear', k: 'notreal' }`; assert no change.
9. Send `{ t: 'wear', k: 'heatcloak' }` before owning it on a fresh client; assert rejected.

Manual terrain test:

1. Own both cloaks.
2. Wear none and stand in Dunes during day: take heat damage.
3. Wear Fur Cloak in Dunes: still take heat damage.
4. Wear Heat Cloak in Dunes: no heat damage.
5. Wear Heat Cloak in Spire: take cold damage.
6. Wear Fur Cloak in Spire: no cold damage.
7. Enter shelter/mine: no weather/temperature damage regardless of cloak.

### Save Compatibility

This is a backward-compatible save change if handled carefully.

Old profiles do not have `wornGear`. Treat missing value as `null`:

```js
p.wornGear = prof.wornGear && p.gear.has(prof.wornGear) ? prof.wornGear : null;
```

No `server/save.json` deletion is required if missing `wornGear` is handled.

### Definition Of Done

- Crafting cloaks adds them to owned `gear`, not active protection by itself.
- Only `wornGear` protects against heat/cold.
- `wornGear` can be `heatcloak`, `furcloak`, or `null`.
- UI clearly shows owned vs worn cloaks.
- Clicking worn cloak toggles to none, or a separate `No cloak` control exists.
- Optional local cloak visual appears on the player rig.
- Build passes.
- Server test covers valid wear, switch wear, unequip, and invalid wear.
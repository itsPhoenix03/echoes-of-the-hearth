# Combat Feel & Enemy AI Guide

Implementation guide for three connected upgrades: **hit feedback** (knockback + sounds +
visual punch), **smarter enemy AI**, and **new enemy types**. Written against the current
code; line references drift — grep for the named functions/messages before editing.

Read `ARCHITECTURE_ADVISORY.md` first. Standing rules: server stays authoritative for all
damage and creature state; no `Math.random()` outside the server (client effects must be
deterministic reactions to server messages); every change ends with `npm run build`, fresh
server, `node test.mjs`, and a two-tab co-op check.

---

## 1. Current state (what you're building on)

### Combat protocol
- Player attack: client sends `{t:'atk'}` (F key → `attack()`, main.ts ~725). Server
  (index.js ~358–412) enforces a 400 ms cooldown (`p.lastAtk`), finds the nearest
  creature/animal within **2.4 tiles**, applies tool damage (isword 5 / sword 3 / axe 2 /
  hand 1).
- Creature survives → broadcast `{t:'chit', id}`. Dies → removed, essence loot, private
  `{t:'msg'}` to the attacker.
- Creature contact damage: every 5th tick, creatures within 1.1 tiles deal `cdmg`;
  server sends `{t:'hp', hp, x, y}` to the victim.

### Feedback today (the gaps this guide fills)
| Event | Visual | Audio |
|---|---|---|
| Creature hit | 80 ms white `setTintFill` (main.ts ~486) | `audio.hitmob()` |
| Creature dies | sprite vanishes, nothing else | **none** |
| Player hit | **nothing** (hp bar only) | `audio.hurt()` (slow 800 ms sine — mushy) |
| Knockback | **does not exist anywhere** | — |

### Enemy AI today (server tick, ~507–567)
- Types in `CRE_TYPES` arrays `[hpBase, hpPerStrength, speed, contactDmg]`:
  crawler [1,1,0.44,1], stalker [2,1,0.68,1], brute [6,3,0.3,2], wisp [3,0,0.2,0].
- Crawler/stalker: straight-line chase of nearest visible player (z===0) within 26 tiles
  (+40 if the player carries essence/meat). Stalkers spawn only at night.
- Brute: targets structures within 45 tiles, else players; during the final wave, targets
  the engine. Straight line, no avoidance.
- Wisp: random drift, corrupts a tile every 25 ticks.
- **No leashing, no despawn, no pathfinding, no telegraphs, no variety in attack timing.**

### Audio architecture (src/audio.ts)
Everything is synthesized: a shared 2 s white-noise buffer + a `tone(freqStart, freqEnd,
duration, type, volume, filter?)` oscillator helper with exponential ramps. Existing
one-shots: `step, swing, chop, hitmob, hurt, growl(closeness), build`. Ambient rain/wind
layers and a generative pad run per-frame. **Add new sounds as new methods in the same
style — do not add audio files; the zero-asset audio design is deliberate.**

### rig.ts
Procedural body-part rig: walk cycle (`phase += dt*11`) and a 320 ms tool-swing `act()`.
No hurt pose — you will add one using the same pattern.

---

## 2. Hit feedback (do this first — biggest payoff, lowest risk)

Feedback is client-side reaction to messages the server already sends (or one field added
to them). No new authority, no new validation surface.

### 2.1 Protocol: add a hit direction, nothing else
Two message extensions, both backward-compatible (old clients ignore extra fields):
- `{t:'chit', id}` → `{t:'chit', id, ang}` where `ang = Math.atan2(cy-py, cx-px)` — the
  push direction away from the attacker, computed server-side at hit time (index.js ~411).
- `{t:'hp', hp, x, y}` → add `ang` the same way (away from the creature, ~564).

### 2.2 Creature knockback — server-authoritative
Creature positions live on the server, so their knockback must too, or the 5 Hz creature
broadcast will snap them back:
- On a surviving hit (index.js ~411): `c.x += Math.cos(ang)*KB; c.y += Math.sin(ang)*KB`
  with `KB = 0.9` tiles for crawler/stalker/wisp, `0.3` for brute (heavies barely move).
  Clamp with the same land-validity check spawning uses — never knock a creature into
  water or a structure tile; if blocked, skip the displacement (keep the visual flash).
- Add a stagger: `c.stun = 3` (ticks). In the AI tick, `if (c.stun) { c.stun--; continue; }`
  — a hit interrupts movement for 0.3 s. This alone makes melee feel fair, because the
  player can now kite between swings.
- Client (main.ts creature-update handler): the position change arrives in the normal
  broadcast; additionally, on `chit`, tween the sprite `x/y` toward the pushed position
  over 90 ms with `Back.easeOut` so the shove reads instantly instead of at 5 Hz.

### 2.3 Player knockback — client-side, and why that's OK
This codebase trusts client movement (client sends position at 10 Hz; server checks
distance sanity only). Server-pushing the player would fight the client's own prediction.
So: on `{t:'hp', ...}` with `hp < this.hp`, the client applies its own impulse:
- Displace `me` by `0.7` tiles along `ang` over 120 ms (`Sine.easeOut` tween on the
  player container), **rejecting the move if `blockedAt()` says the destination is
  water/blocked** — reuse the exact check ghost preview uses.
- During the tween, suppress input-driven movement (a `this.knockedUntil = time+120`
  guard in the update loop) so the tween and WASD don't fight.
- Do NOT extrapolate this into dodge/dash mechanics here; keep the impulse small enough
  that the server's existing distance sanity check never trips (0.7 tiles is well inside).

### 2.4 Visual punch (all client, all cheap)
On player damage (`hp` decrease), add all three — they're one line each:
- `this.cameras.main.shake(90, 0.004)` — subtle, not nauseating.
- Red vignette flash: a full-screen rect (`setScrollFactor(0)`, depth 9999, fill
  0xaa2222) alpha-tweened 0.25 → 0 over 220 ms. Create it once at startup, reuse.
- Rig hurt pose (rig.ts): add `hurt()` beside `act()` — torso and head rotate `-0.35 rad`
  away from the hit and ease back over 200 ms, plus `setTintFill(0xff6666)` on all body
  parts for 80 ms (mirror the creature flash timing so the language is consistent).

On creature death (new — currently they just vanish): before destroying the sprite, run a
120 ms tween `scale → 0.7, alpha → 0, angle → ±20` and spawn 4 one-frame particles using
the existing `generateTexture` pattern (see weather particles, main.ts). No new assets.

### 2.5 Sounds (new methods in audio.ts, same synthesis style)
| Method | Recipe (match `tone()`/burst conventions) | Trigger |
|---|---|---|
| `thud()` | noise burst 60 ms lowpass 300 Hz at 0.3 + sine 90→40 Hz 150 ms — a punchy layer UNDER the existing `hurt()` tone | player takes contact damage (main.ts ~479, alongside `hurt()`) |
| `killmob()` | sawtooth 220→30 Hz over 350 ms at 0.2 + noise burst 120 ms bandpass 600 Hz | creature death (the branch that removes the sprite) |
| `whoosh()` | noise burst 90 ms bandpass 1400 Hz, volume 0.12 | any knockback impulse (both directions) |
| `telegraph()` | reuse `growl(1.0)` but pitch-shifted +30 Hz | brute windup (section 3.3) |
Keep total simultaneous gain in check: these fire together with `hitmob`/`hurt`; if it
clips, drop per-sound volumes, don't touch master gain (ambient layers depend on it).

---

## 3. Enemy AI improvements (server tick only — client needs zero changes)

Ordered by value. Each is independent; ship and test one at a time. All of these live in
the creature section of the tick (~507–567). **Budget rule: the AI tick must stay O(creatures
× small constant). No per-creature map scans; reuse the existing nearest-player loops.**

### 3.1 Leash + despawn (fixes the "infinite chase" and cap starvation)
- Store `c.homeI` (spawn tile) at spawn. If `dist(c, home) > 60` and no player within 20:
  walk home at half speed; at home, if still no player near, despawn (free the cap slot).
- Stalkers despawn at dawn (`!isNight && no player within 12`) — they're night hunters;
  today they linger forever after one night spawn.

### 3.2 Water/obstacle handling without pathfinding
Full A* is out of scope and unnecessary at these ranges. Do steering instead: before
applying the straight-line step, test the destination tile with the same land check
spawning uses. If blocked, try the step rotated ±35°; if both blocked, stop this tick.
Three checks max per creature per tick — cheap, and creatures stop face-planting into
lakes and stacking on walls.

### 3.3 Attack telegraphs (fairness — pairs with knockback)
- Brute: before its contact damage lands, require a windup — when a player first comes
  within 2.5 tiles, set `c.windup = 8` ticks (0.8 s), broadcast `{t:'ctel', id}` once,
  freeze the brute; damage only applies after windup expires and the player is STILL
  within 1.1. Client: on `ctel`, tint the brute 0xffaa00 and play `telegraph()`. The
  player now has a dodge window, which the new knockback lets them actually use.
- Crawlers stay dumb-rush (they're the fodder); stalkers get 3.4 instead.

### 3.4 Stalker flanking
Stalkers currently out-speed players in a straight line = unavoidable. Change: when
within 8 tiles, steer toward a point 90° around the player (orbit) until behind
(`dot(creature→player, playerFacing) < 0`), then dart straight in at 1.25× speed.
Implement with the same angle math as wisp drift; ~10 lines. Result: stalkers feel like
predators and the player can counter by turning.

### 3.5 Pack pressure (cheap group behavior)
When a crawler is hit, set `c.enraged = 100` ticks on every crawler within 10 tiles
(single loop over creatures, only on-hit — not per tick). Enraged: +20% speed, +6 chase
range. Groups now punish careless aggro without any coordination code.

### 3.6 Wisp self-defense
Wisps are passive loot piñatas. On `chit`, give the wisp a flee impulse (3 tiles away
from attacker over the next 10 ticks) and have it drop one corrupted tile at its feet.
Chasing a fleeing wisp through its corruption trail is a real decision.

---

## 4. New enemy types

`CRE_TYPES` is data-driven — a new enemy is one array entry, a spawn rule, an AI branch
(reuse an existing behavior where possible), and a texture whose key equals the kind
string. **Stats below assume the current arrays `[hpBase, hpPerStrength, speed, cdmg]`.**

### 4.1 `husk_wolf` — Woods night pack hunter (art EXISTS: this pack's `wolf.svg`)
- Stats: `[3, 1, 0.62, 1]`. Spawns at night in GRASS-biome regions, **2–3 at once**
  (spawn loop: on a wolf spawn roll, place siblings within 3 tiles), counts 2 toward cap.
- AI: reuse stalker chase + section 3.5's enrage as a *standing* pack link: wolves within
  12 tiles of each other share the widest aggro. One wolf leashing home pulls the pack.
- Drops meat (like animals) instead of essence — first enemy worth hunting for food.

### 4.2 `bog_shambler` — Marsh area-denial tank
- Stats: `[8, 2, 0.22, 2]`. Spawns only on MUD/BLIGHT tiles near the Marsh island.
- AI: brute behavior (with 3.3 telegraph) but ignores structures; on death, corrupts its
  own tile + 4 neighbors (reuse wisp corruption) — killing it has a cost, route around or
  commit.
- Art: none in pack yet. Fallback per the tint convention: `blight-creature` texture
  tinted 0x557755 and scaled 1.3. Spec for later art: `bog_shambler.svg`, ~48×56, flat
  style, hunched moss-drapes silhouette, soft shadow ellipse.

### 4.3 `frost_wraith` — Spire harasser
- Stats: `[2, 1, 0.5, 1]`. Night + SNOW biome only. Despawns at dawn (3.1 makes this free).
- AI: wisp drift until a player is within 10, then stalker-dart; its contact damage also
  adds a 3 s client slow (`{t:'hp', ..., slow:30}` → client caps move speed 60% for 30
  ticks — client-side is fine, same trust model as knockback).
- Art fallback: `wisp` texture tinted 0x99ddff; spec `frost_wraith.svg` ~40×48 later.

### 4.4 Stretch (needs a projectile system — separate effort, do NOT bundle): `spitter`
Ranged blight enemy. Requires server projectile entities, a new broadcast, dodge
interplay. Design it only after knockback + telegraphs ship and feel right.

### Spawn-table hygiene
Keep the existing cap formula. Add biome gating to the spawn roll (check the tile's
biome at the candidate spawn point — the tile array is already in memory; O(1)).
New enemies enter the wave pool ONLY if playtests show the final wave is too easy —
wave balance is tuned around brutes; don't silently change it.

---

## 5. Ship order & verification

| Step | Scope | Gate before next |
|---|---|---|
| 1 | Sounds (`thud/killmob/whoosh`) + player flash/shake/hurt-pose | co-op: both clients hear/see only their own hits correctly |
| 2 | `ang` field + creature knockback/stun + death tween | knockback never pushes a creature onto water/structures (attack at shoreline to confirm); `node test.mjs` still passes |
| 3 | Player knockback impulse | knock toward water: player never enters blocked tile; server distance sanity never rejects |
| 4 | Leash/despawn + steering (3.1, 3.2) | creature count returns to baseline after players leave an area; tick time unchanged (log it) |
| 5 | Telegraphs + stalker flank + pack enrage (3.3–3.5) | brute is dodgeable; stalker beatable by turning |
| 6 | `husk_wolf`, then `bog_shambler`, then `frost_wraith` — one per pass | each: spawn gating correct biome/time, save/reload with live creatures of the new kind |

Regression watchlist: (a) `{t:'hp'}` is also sent for hunger/fall damage — gate ALL new
hit feedback on `ang !== undefined`, or starving will camera-shake; (b) the final-wave
brute rush at the engine — telegraph freeze must not make waves trivial, retune
`wave` cap if needed; (c) audio: 6+ creatures dying in one wave frame → stagger `killmob()`
calls 30 ms apart or it's one loud click; (d) save.json now carries new creature kinds —
the load-tolerance guard from the customization guide (skip unknown kinds) covers
rollbacks; add it if not present yet.

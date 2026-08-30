# Medicine & Medic, `seq` protocol, menu shell, quit-to-menu, logo — 2026-08-30 13:02

## Session summary

Continued from a compacted session that had just finished the animation-improvement work (boat
sitting pose). This session implemented the two remaining doc-driven features (Medicine + Medic
healing, and the validated `seq`/`act` action protocol), added a medic hut structure, fixed two
camera-zoom bugs, built a front-end menu shell with room/profile/settings pages, added quit-to-menu,
and iterated five times on the title logo. Work was delegated to Sonnet and Opus subagents with
explicit file ownership; the orchestrator ran all authoritative verification.

---

## What shipped

### 1. Medicine + Medic healing (`docs/05_MEDICINE_AND_MEDIC_HEALING_GUIDE.md`)

- `shared/defs.js` — `MAX_HP = 10`, `MEDICINE_HEAL = 3`, `medicine` recipe
  (`{fiber: 4, water: 1}` at a campfire), `NAMES` entry, `emptyInv()` key, `MEDIC_TRADE_POOLS` for
  all four islands (dunes + marsh defined but unused, so a later expansion cannot ship an
  unreviewed pool).
- `shared/world.js` — `MAJOR_ISLANDS`, `MEDIC_ISLANDS`, `findNearestValidTile()` (fixed-order ring
  search, bounded radius), `findMedicSpawns()`, `medicBlockTiles()`.
- `server/index.js` — `healPlayer()` helper now carries medicine, glowcap, and campfire regen.
  Full `medic` handler: inspect / accept / decline, 60s offer expiry, 20s reroll delay, offer
  stability across repeat `E` presses, atomic pay-then-heal, safe public projection of the offer,
  and the exact machine-readable failure reasons from guide §9. `init` now carries `hp`, `maxHp`,
  `hunger`, `thirst`.
- Client — medics render at `setOrigin(0.5, 0.92)`, hide per z-layer, `E` within 2.5 tiles opens a
  bargain behind its own 900ms cooldown. Offer panel in `src/ui.ts`.
- Art — `medic.svg`, `medic_snow.svg`, `medicine.svg`.

**Verified placement on the default seed:** `medic-woods` at (190,172) on grass, `medic-spire` at
(189,1107) on snow, no node collisions.

### 2. Medic hut

Decorative structure two tiles directly behind each medic, so the medic stands outside its door and
the hut sorts behind them. `medic_hut.svg` + `medic_hut_snow.svg` at 96×88. Hut tile blocks movement
client-side (`blockedAt`) and building server-side (added to `medicTiles`). Verified: woods hut at
(190,170), spire hut at (189,1105).

### 3. Validated `seq`/`act` action protocol (`docs/ANIMATION_IMPROVEMENT_GUIDE.md` §805-850)

Client attaches a monotonic `seq` to `gather` / `dig` / `atk`. The server validates using the same
rate-limit, z-layer, distance and target checks that accept gameplay, then **derives** action and
tool from authoritative state, then broadcasts one `{t:'act', id, seq, a, tool, dx, dy, targetI}`.
`node` / `dig` / `chit` gained `by` + `seq` as additive fields. Rejections send
`{t:'actReject', seq, reason}` to the requester only. Attacks broadcast `act` even on a miss,
omitting `chit`. `audio.chop()` moved from keypress to server confirmation, gated on
`m.by === this.id`. The three pre-emptive `anim` sends are gone; `anim` survives only for the
cosmetic jump, whitelisted to `{'j'}`.

New test stages G1–G5 prove: out-of-range emits no `act`; accepted actions echo `seq`; the server
derives tool even when the client lies (G3 sends a false `axe`/`pick` claim and asserts `spick`);
a miss emits `act` with no `chit`; impacts carry matching `by` + `seq`.

### 4. Menu shell + quit-to-menu

- `src/menu.ts` — Home / Create Room / Join Room / Profile / Settings in one overlay, no router.
  Room codes are 6 chars from an unambiguous alphabet (no `0/O/1/I`), persisted to `hearth-room`.
  Profile sanitizes usernames exactly like the server (strip control chars, trim, 2–18 chars).
  Settings persist `hearth-muted` and `hearth-shownames`.
- `src/boot.ts` — new lightweight entry; dynamically `import()`s `main.ts` on join. Bundle now
  splits into a ~6 kB menu entry and a 1.57 MB lazy Phaser chunk; verified the entry chunk contains
  zero Phaser references.
- `src/main.ts` — `new Phaser.Game(...)` wrapped in `export function startGame()` behind a
  double-boot guard. Random `"Keeper-####"` name fallback replaced by
  `localStorage['hearth-name'] || "Keeper"`; `?name=` URL override preserved.
- Quit — delegated `document` click listener on `#quitBtn`. Teardown order: reset UI state → set a
  `quitting` flag so `ws.onclose` cannot fire the "Disconnected" toast → close socket → close
  AudioContext → `game.destroy(true, false)` plus immediate `runDestroy()` → remove dev panel →
  hide in-game DOM → reset `--uiz` → clear `gameStarted` → dispatch `hearth:quit`. `confirm()` first.

### 5. Zoom fixes

Two separate bugs, both in the camera view clamp. See "Bugs found" below.

### 6. Title logo

Five iterations. Final: `assets/sprites/wordmark.svg`, a standalone same-origin asset referenced as
`<img src="/sprites/wordmark.svg">`. Pixel-art letterforms on an 18×18 cell / 23 advance grid,
`viewBox="0 0 140 60"`, 1454 shapes, zero non-integer coordinates, `shape-rendering="crispEdges"`,
no external refs / `<style>` / `<filter>` (required — an SVG loaded via `<img>` cannot reach
outside itself).

---

## Decisions made

- **Medicine scope was cut down from the guide.** Implemented the consumable, the two medics, the
  bargain system and the protocol. Explicitly did NOT do the guide's full damage-pipeline refactor —
  only `healPlayer()` was added, routing medicine, glowcap and campfire regen. Every other damage
  site was left alone.
- **Medic lockout is combat-only.** The guide specifies a 5s in-combat lockout after damage. A
  subagent discovered that environmental chip damage (snow/desert/thermal) perpetually refreshes it,
  making the Spire medic — the one the guide says matters most — permanently unreachable without the
  very cloak you'd visit them to survive without. `lastDamageAt` is now set only by combat sources
  (creature contact, beams, bolts, falls, boat wrecks), not by the environment tick. **Do not
  "restore" environmental damage to that field.**
- **Rooms are cosmetic and the UI says so.** The owner asked for front-end-only rooms. The Create and
  Join screens carry a plainly worded note that codes are not networked and everyone shares one
  world. Keep it.
- **`clipPath` was rejected for the logo bevel, correctly.** The orchestrator prescribed `clipPath`
  for the carved inner bevel; the design agent declined with sound reasoning — clipPath children
  *union*, there is no subtraction, so clipping can only produce a one-directional ramp. A lit
  top-left rim *and* a dark bottom-right rim simultaneously needs the set difference `S \ (S ± 1)`.
  A `<mask>` can express it but rasterizes through a compositing pass, softening a 1-unit rim and
  destroying the pixel read. The agent computed the inward peel on the integer grid and emitted the
  regions as geometry instead.
- **`initUI()` became a page singleton, not per-scene.** Required for quit/rejoin — see below.

---

## Bugs found and root causes

### Camera zoom never clamped at startup (the big one)
`applyViewClamp` was only wired to the window `resize` event and to `setZ`. Neither fires on first
load, so the opening view sat at Phaser's default zoom of 1 with `--uiz` unset, and **entering a mine
was the first time the clamp was ever applied**. Surfacing returned to `1 × fit` — the correct
baseline — which never matched the unclamped opening view, so it read as "zoom stuck in mine mode".

This was also silently defeating the view clamp entirely: on 1920×1080 the intended zoom is 1.364 but
players were at 1.0, seeing ~36% more of the world than the clamp was written to allow — the same
"can see the whole island" problem the clamp existed to solve. Invisible on 1366×768 and smaller,
where `fit` is already 1. Fixed with a single `this.applyViewClamp(0)` after camera bounds are set.

### Phaser `zoomTo` silently drops in-flight requests
`ZoomEffect.start()` does `if (!force && this.isRunning) return`. Any overlapping call — including
the resize handler — could strand the camera. Fixed with `force: true`, plus `cam.zoomEffect.reset()`
on the instant-set path so a live tween cannot overwrite it a frame later. Mine zoom also reduced
1.05 → 1.02.

### `initUI()` per-scene would have doubled every action on rejoin
`src/ui.ts` attaches delegated listeners to `#inv`, `#quickbar`, `#craftPanel`, `#chestPanel`,
`#medicPanel` and a `document` keydown — all DOM that *survives* a quit. A second `initUI()` on
rejoin would have doubled every craft, use, equip and hotkey. Now a singleton whose callbacks read
the active scene at call time.

### Logo: DOOM's corner treatment was inverted
Four passes chamfered the corners (cut them off at 45°). DOOM does the opposite — strokes **flare
outward into hard spurs** at top and bottom and run straight through the waist. Chamfering reads as
softened boxes; flaring reads as splayed and aggressive. No amount of surface tuning could fix a
wrong skeleton.

---

## What did NOT get done

- Modular building system — biggest remaining feature, not started.
- PLAN.md zero-code systems (fire spread, water flow, blight evolution, convergence events,
  transport networks, mini-dungeons, roles).
- Settings toggles are stored but not plumbed into audio/UI.
- `ui.ts` `reset()` for cached signatures on quit.
- Medic huts do not block server-side creature pathing (decorative, judged acceptable).
- Root `README.md` gameplay details remain stale (192×192 map, SPACE-as-attack).

---

## Notes for the next session

- **The logo went five rounds and was never seen rendered by the agent.** It now lives in one
  isolated file (`assets/sprites/wordmark.svg`), so re-cutting it is a single small write rather
  than surgery on inline HTML. If the owner objects again, ask for a screenshot or a single-axis
  correction (grey vs warm / letters heavy vs light / grain noisy vs clean / flares strong vs subtle)
  rather than rebuilding blind.
- **Parallel agents worked well when file ownership was disjoint and they met at an event.** The
  menu agent owned `index.html` + `src/menu.ts`; the quit agent owned `src/main.ts`; they connected
  via a `hearth:quit` window event with neither importing the other. Zero collisions.
- **Do not let two agents run `node test.mjs` concurrently** — port 8081 and `server/save.json`
  conflict. One test run hung for 6m40s and passed cleanly on retry; treated as harness flake since
  the changes were client-side markup the suite never loads.
- Subagents twice claimed things worth double-checking (a `rig.playAction()` reference that turned
  out to be pre-existing; a "third hunk I did not write" that was the orchestrator's own zoom fix).
  Verify claims rather than acting on them.
- Commits `e29faf7` and `af2146c` were made outside the session by the owner.

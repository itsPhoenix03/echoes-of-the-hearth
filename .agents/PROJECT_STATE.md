# Project state — Echoes of the Hearth

**Last updated:** 2026-09-06 — **Go game server, Slices 1 + 2** (branch `go-migration`).
Previous entry: 2026-08-30 — small-fixes pass (settings wiring, `ui.reset()`, scene-owned
tint timers, medic-hut creature blocking, README accuracy) plus **server-authoritative
movement validation**. Prior entry:
`session-context-dump/2026-08-30_1302__medic-seq-menu-logo.md`

This is the status source of truth. Update it in the same pass as any session dump.

---

## Verification status at last update

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | clean |
| `npx vite build` | green |
| `node test.mjs` | ALL TESTS PASSED (24 base stages + medic a–e + protocol G1–G5) |

---

## Shipped and working

### Core game
- Deterministic 1280×1280 worldgen, 4 major islands + Core + minor isles, `WORLD_VERSION = 4`.
- Three z-layers: surface, mine tunnels, shelter interiors.
- Survival loop: hunger, thirst, thermal damage, weather (rain / sandstorm / blizzard), day-night.
- Gathering, crafting (station-gated), building, digging, farming, chests, boats, swimming.
- Combat with 9 creature types including water-capable (`stalker`, `drowned`) and ranged
  (`brute` bolts, `blight_lancer` structure-destroying beams).
- Progression: 4 Monoliths → Aether Forge → Monolith Cores → World Engine → final assault.
- Persistence: `server/save.json` + per-player profiles keyed by `localStorage['hearth-tok']`.
- Dev tester panel (F10) — fast travel, monolith activation, god mode, instant death, spawn by
  category, weather and time control. F9 dev kit unchanged (dev-mode server only).

### Landed 2026-08-30
- **Medicine + Medic healing** — `medicine` consumable (heals 3, capped at `MAX_HP`), two
  deterministic medic NPCs (Woods + Spire) with a server-generated bargain system: 60s offer expiry,
  20s reroll delay, offer stability across repeat interactions, atomic pay-then-heal.
- **Medic huts** — decorative structure two tiles behind each medic; blocks movement client-side and
  building server-side.
- **Validated `seq`/`act` action protocol** — client attaches a monotonic `seq` to `gather`/`dig`/
  `atk`; the server validates, then *derives* action and tool from authoritative state, then
  broadcasts one `act`. `node`/`dig`/`chit` carry `by` + `seq`. Impact audio fires on server
  confirmation. `anim` survives only for the cosmetic jump, whitelisted.
- **Animation system** — `src/rig.ts` rewritten with a documented ONE WRITER RULE (only `tick(dt)`
  writes pose; no tweens, no setTimeouts). `torso.rotation` written exactly once, to 0, as an
  invariant. Boat sitting pose wired.
- **Menu shell** — Home / Create Room / Join Room / Profile / Settings, in `src/menu.ts` with
  `src/boot.ts` as entry. Phaser is lazy-loaded; the world does not boot until Join.
- **Quit to menu** — full Phaser teardown, socket close, `initUI()` singleton, DOM reset,
  re-join works cleanly.
- **Custom cursor** — `assets/sprites/cursor.svg` + `cursor_pointer.svg`.
- **Zoom fixes** — startup view clamp (was never applied until first mine entry) and Phaser
  `zoomTo` force flag. Mine zoom reduced 1.05 → 1.02.

---

## Deliberately deferred (owner's decision — do not start without asking)

- **Elevation rework** — `docs/ELEVATION_AND_WORLD_EDGE_GUIDE.md`.
- **Postgres/Redis room architecture** — `docs/MULTIPLAYER_ROOM_ARCHITECTURE_GUIDE.md`.
- **`docs/07_REMAINING_IMPLEMENTATION_ROADMAP.md`** — owner said to ignore new doc additions for now.

---

## Known gaps and rough edges

1. **Room codes are cosmetic.** The server hosts one shared world, so two players with different
   codes still land together. The Create and Join screens say this plainly — do not remove that note
   or imply isolation the backend cannot deliver. Making it real requires the deferred room
   architecture work.
2. **`test.mjs` is stateful.** It runs against an already-running server on port 8081 and mutates
   `server/save.json`, so a second run on the same save fails part-way (depleted nodes, tiles
   already built on). A green run means a *fresh* save. To verify without disturbing a running dev
   server, copy `server/index.js` with `PORT`/`SAVE_PATH` swapped and point a copy of `test.mjs` at
   the new port.

### Landed: Go game server — Slices 1 and 2 (branch `go-migration`)

The server is being split in two. **Node control plane** (`control/`, :8090) owns identity,
profiles, world allocation and issues a 30s Ed25519-signed ticket. **Go game server**
(`gameserver/`, :8082) owns the world and all gameplay. Go verifies tickets *offline* from a
public key — it never calls Node on the connection path, so a Node hiccup cannot stop players
connecting. Wire spec: `docs/10_GO_WIRE_PROTOCOL.md`. Ticket format: `control/PROTOCOL.md`.

**Worldgen is bit-exact.** `gameserver/world/` is a literal port of `shared/world.js`,
including `alea@1.0.1` and `simplex-noise@4.0.3` (ported by hand — a different-but-valid
Simplex gives a different world). Verified across 5 seeds × 8 fields by
`node tools/worldparity/compare.mjs`, which is the gate: **run it after any worldgen edit.**
Exactness was required because `test.mjs` calls `genWorld('hearth-1')` and asserts against
those exact tiles; keeping it preserves ~1000 lines of black-box tests.

**The client no longer generates terrain.** Go streams 64x64 chunks (20x20 grid, pushed
within Chebyshev radius 2, 2-byte-run RLE + base64). `src/tiles.ts` is the streamed tile
store; unloaded tiles use sentinel `255`, render as void (NOT water — water is walkable and
would mislead), and movement input is gated until the player's own chunk arrives. This
deletes the client/server terrain divergence class permanently.

**Rules data is no longer duplicated.** `shared/defs.json` is the single authored source;
`shared/defs.js` is *generated* from it (`node tools/defs/gen-defs.mjs`, `--check` for drift,
`npm run defs:check`). A runtime JSON re-export was not possible — no import syntax works in
both this repo's Node 18 and a Vite browser build. **Edit the JSON, then regenerate.**

Ported in Slice 2: `gather`, `craft`, `build`, `dig`, `plant`, `harvest`, `furn`, `torch`,
`eq`, `wear`, `use`, `water`, `chest_open`, `chest_move`, structure/node `atk`, boat hazards,
node respawn, crop growth, wooden erosion, survival tick, persistence to
`gameserver/world.save.json` (**never** `server/save.json` — the legacy server owns that).

Concurrency contract, and it must be preserved: **all game state is owned by the single
`Room.Run` goroutine with no locks.** Socket readers only push onto an inbox; writers only
drain a buffered per-player channel. A client whose buffer fills is dropped, never waited on,
so a slow client can never stall the world tick.

### Still open before the Go server can replace Node

1. **Slice 3** — creatures, animals, weather, medic NPCs, `usecore`/progression, `devcmd`.
2. **Medics are not on the wire.** The client used to derive them from the whole generated
   world, which a streaming client cannot do. Needs a protocol addition.
3. **The legacy `?legacy=1` client path against :8081 is untested** — it was written but
   never exercised (agents were barred from binding 8081 while the user's dev server ran).
4. **`hunger`/`thirst` are floats in Go, ints in the legacy server.** The HUD rounds; decide
   which side owns the rounding.
5. Run the suites with `HEARTH_ALLOW_WARP=1` — both `test.mjs` and `gameserver/test-go.mjs`
   position players via `warp`, which is off unless that env var is set.

### Landed: server-authoritative movement

`pos` was the one handler that assigned `m.x`/`m.y` straight to `p.x`/`p.y`. Because every
other handler range-checks against `p.x`/`p.y`, an unvalidated `pos` defeated all of them —
fixing movement retroactively hardened the other 24. The `pos` handler now validates:

- **Speed** — `dt` (clamped to 1s so a quiet client cannot bank a jump) × `MAX_SPEED 6.2`
  (sailing, the game's fastest) × `SPEED_SLACK 1.6` + `POS_SLACK 1.0`. `lastPosAt` advances
  on reject too, or a rejected client accumulates budget.
- **Collision** — new `posBlocked(x,y,z,fromX,fromY)`, a z-aware mirror of the client's
  `blockedAt()`. Deliberately NOT `blocked()`: that treats water as solid, which would forbid
  swimming and boats. z=0 allows water, bounds elevation climb at 2, blocks structures /
  `medicTiles` / `LANDMARK_BLOCK`; z=1 requires `digs`; z=2 is unvalidated (see gaps).
- **Layer changes** — `zAnchor()` requires one mineshaft/shelter within `Z_NEAR 3.0` of *both*
  the origin and the destination, plus a 500ms cooldown. Checking the destination alone was a
  live exploit: it allowed an unbounded hop to any mineshaft or any player's shelter.
- **Snapback** — `{t:'fix',x,y,z,b}`, throttled to one per 250ms, applied client-side next to
  the existing `hp` teleport branch.
- **Grace window** — all 12 server-side repositioning sites call `warped(p)`, which suspends
  the distance check for 1s so an in-flight `pos` from the old location does not start a fight.

`test.mjs` predates this and teleported the player 45 times, so the server gained a `warp`
message gated behind `HEARTH_ALLOW_WARP` (a dedicated var — `DEV` also changes `GROW_DIV` and
would corrupt the crop test). **Run the suite with `HEARTH_ALLOW_WARP=1` or it will fail.**
Verified inert without the flag. New stages H1–H7 cover speed, collision, water-still-passable,
illegal layer change, the remote-mineshaft exploit, and legitimate descent.

Remaining movement gaps, in rough priority order:
1. **z=2 interiors are unvalidated for x/y** — the server has no `shelterAnchor`/`shelterLvl`,
   so inside a shelter a client can walk through walls. Closing it means recording which
   shelter the player entered at the z-transition.
2. **Layer-exit collision is skipped** — the exit tile is a fixed door/shaft the player never
   chose; rejecting it could strand them underground.
3. **`jumpT` is not observable server-side**, so the climb bound stays permissive at 2.
4. **The 1s post-teleport grace fully disables the distance check** — anyone who can trigger a
   server teleport gets one free window.

### Closed in this pass

- ~~Settings toggles stored but not wired~~ — now read through the new `src/settings.ts` leaf module.
- ~~`ui.ts` caches signatures that survive a quit~~ — `reset()` added and called from `quitToMenu()`.
- ~~Two bare `setTimeout`s in gameplay code~~ — both are `this.time.delayedCall` scene-owned timers.
- ~~Medic huts don't block creature pathing~~ — `medicTiles` now gates creature steering, leash
  walk-home, frost-wraith darts, and `blocked()` (which also covers animal AI).
- ~~Root `README.md` gameplay details are stale~~ — full accuracy pass against the source.
- ~~Movement is client-authoritative~~ — see above.

## Next work, in the order previously recommended

1. **Modular building system** — `docs/PLAYER_BUILDING_CUSTOMIZATION_GUIDE.md`. Floor/wall/roof/
   fixture/decor slots, `buildmod` protocol, support and cascade rules, slot-filtered ghost preview,
   bridge-over-water. This is the biggest remaining feature and the only one that unlocks the ~30
   unused `building_materials` assets. Needs care — it touches the build protocol and persistence.
2. **PLAN.md systems with zero code** — fire spread automata, water flow / trenches, blight
   evolution, convergence events, transport networks, Blighted Heart mini-dungeons, roles/classes.
   Fire spread and blight evolution were judged the highest value of these.
Items 3 and 4 of the previous list (Settings wiring, `ui.ts` `reset()`) are done — see above.

---

## Feature → file map

| Area | Files |
|------|-------|
| Worldgen (deterministic) | `shared/world.js` |
| Recipes, items, health constants, trade pools | `shared/defs.js` |
| Day cycle | `shared/time.js` |
| Authoritative server, all handlers, sim tick | `server/index.js` |
| Phaser scene, rendering, input, protocol client | `src/main.ts` |
| Player rig / animation | `src/rig.ts` |
| In-game DOM UI | `src/ui.ts` |
| Menu / lobby / profile / settings | `src/menu.ts`, `src/boot.ts` |
| Persisted setting toggles (leaf module) | `src/settings.ts` |
| Asset manifest | `src/assets.ts` |
| Procedural audio | `src/audio.ts` |
| All art | `assets/sprites/**` (SVG only) |
| Protocol test suite | `test.mjs` |
| Deep technical reference | `AGENT_GUIDE.html` |

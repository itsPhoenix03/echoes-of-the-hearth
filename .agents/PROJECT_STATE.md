# Project state — Echoes of the Hearth

**Last updated:** 2026-09-20 — **Go migration COMPLETE** (Slices 1-4 + integration + dev tooling + admission) (branch `go-migration`).
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

### Slices 3 and 4 — the port is feature-complete

**Slice 3 (living world):** all 9 creature types with exact `CRE_TYPES` stats, the full
ordered spawn roll, chase/orbit/dart AI, enrage and windup telegraphs, lancer beam and brute
bolt, all 7 animal species, weather (rain/sandstorm/blizzard) including the two survival
branches Slice 2 left unreachable, wisp infection with the 120s cure, and creature combat
(`atk` target scan, knockback, essence, `chit`/`act` correlation).

**Slice 4 (endgame):** the medic bargain state machine (60s TTL, 20s reroll, offer stability,
atomic pay-then-heal, all 10 rejection strings in the reference's check order), `usecore` and
monolith progression, the World Engine dais gate, the 4-minute wave assault and victory, and
`dev`/`devcmd`.

**Measured tick cost** (Ryzen 7 4800H, 200ms budget): realistic load — 4 players, 18
creatures, 20 animals, 60 structures, night — is **79 microseconds, 0.04% of budget**, of
which creature AI is only 16% (the rest is JSON encoding). 200 creatures + 200 animals + 16
players costs 1.0ms, still 0.5%. **There is no performance case for breaking the
single-goroutine ownership model**; don't.

Slice 3 added **five ordered mirrors** because Go randomises map iteration where the JS
reference walks Maps in insertion order: `creOrder`, `aniOrder`, `playerOrder`, `infOrder`,
and `structIndices()`. Each decides a real outcome (target selection, spawn bias, which
infected tile breeds a crawler). **If you add state whose iteration order affects an outcome,
add a mirror and maintain it in exactly one add and one remove site.**

### Acceptance status

`gameserver/test-go.mjs` reaches **ALL TESTS PASSED with zero skips** — 67 stages, every
assertion live. The root `test.mjs` still passes against the legacy Node server, so the old
path is not broken. `go build` / `go vet` / `gofmt` / `go test ./...`, `npx tsc --noEmit`,
`npx vite build` and worldgen parity are all green.

**Both suites need `HEARTH_ALLOW_WARP=1`** and a **fresh** server — they are stateful, and a
second run against a live server fails at `gather` because nodes near spawn are on respawn
timers. Delete `gameserver/world.save.json` between runs.

### Integration gaps — all closed 2026-09-13

1. **Medics are on the wire.** `init.medics` carries the eight fields the client's type
   declares (`id, islandId, sprite, x, y, hutSprite, hutX, hutY`), so the client feeds them
   straight into its existing `medicBlockTiles()`. Placed lazily as their anchor chunk
   arrives, via the same `placePendingNotes()` pattern the other landmarks use — `init`
   lands before any chunk, so both medics start pending. Verified in a real browser: sprite,
   hut, client-side hut collision, and a full pay-then-heal (HP 2->10, wood 500->492).
2. **Run scripts.** `tools/dev/stack.mjs` starts control + game + client with one Ctrl-C
   stopping all three; zero dependencies, because the repo has kept zero and `set X=1&&` in
   package.json was Windows-only. `npm start`, `start:dev`, `stack:servers`, `start:legacy`,
   plus `test:go` / `test:control` / `test:legacy` / `test:parity`. The old `npm start`
   pointed the client at :8090 while starting only the legacy server on :8081.
3. **`HEARTH_DEV` is deleted.** Dev panels are gated solely on the `dev` claim the control
   plane signs per-account, from the `HEARTH_DEV_TOKS`/`HEARTH_DEV_USERS` operator allowlist
   — never from client input (a client POSTing `{"dev":true}` gets nothing; asserted).
   Node emits the key only as `true` and omits it otherwise. `stack.mjs --dev` prints a hint
   because it alone does NOT grant the panels.
4. **Legacy `?legacy=1` path verified** — it works as written, no fixes needed. Terrain,
   movement, medics, gathering and the F10 panel all exercised against :8081. Keep it.
5. **Vitals are integers on the wire.** The server applies `ceil` at every boundary
   (`init`, `stat`, `use`), matching `server/index.js`. `ceil` is load-bearing: starvation
   fires at `<= 0`, so a bar must read `1` until the value truly reaches zero. `src/ui.ts`
   dropped its defensive rounding. Note the legacy server sent `init` vitals *raw* — Go is
   deliberately consistent where the legacy one was not.
6. **Multi-world hosting.** `gameserver/hosting` routes every connection on the verified
   ticket: `instanceId` not hosted here -> `authfail: wrong-instance`; unknown `worldId` ->
   `unknown-world`. Rooms are **lazy** (worldgen is 5-6s and hundreds of MB, so eager boot
   would stall on worlds nobody joined); `HEARTH_EAGER_WORLDS=1` flips it. The registry uses
   the same shapes and precedence as `control/store.js` so one config drives both processes.
   Saves are `world.<worldId>.save.json`, and `worldId` is charset-restricted because it
   names a file. Cross-world isolation is asserted directly, and `-race` is clean.

**Zero-config default still works** (`worldId: default`, seed `hearth-1`, `instanceId: local`)
— `test-go.mjs` and the client depend on it.

### Dev / tester tooling on the Go path (2026-09-14)

**Nothing was ever broken.** All eight `devcmd` subcommands and the F9 kit worked on first
contact. The reported "tester functionality is missing" was two presentation faults:

1. The refusal toast still read *"start the server with: npm run server:dev"* — inherited
   verbatim from the legacy server. On the Go path that starts the **legacy** :8081 server and
   refers to a `HEARTH_DEV` env var that no longer exists, so following it changed nothing and
   read as "never ported".
2. The F10 panel opened unconditionally client-side, so buttons looked live but silently did
   nothing, with no up-front signal.

Fixes:
- **`HEARTH_DEV_ALL=1`** on the control plane grants the ticket's `dev` claim, but **only to
  requests whose remote address is loopback**. The check is per-request, not on the bind
  address, because control binds `0.0.0.0` for LAN play — a bind-based check would either
  break LAN or hand dev tools to every LAN player. Exact-match set of the three forms Node
  reports (`127.0.0.1`, `::1`, `::ffff:127.0.0.1`), never a `127.0.0.0/8` prefix, and
  `X-Forwarded-For`/`X-Real-IP` are never read (client-written). ORed with the
  `HEARTH_DEV_TOKS`/`HEARTH_DEV_USERS` allowlist; neither revokes the other. Warns at boot.
- **`npm run start:dev` sets it**, restoring one-command ergonomics. The claim is baked into
  the ticket at join, so **you must reconnect** after enabling it.
- **`init.dev`** (explicit boolean) lets the client distinguish "not a dev" from "server too
  old to say". The F10 panel now shows an honest not-enabled note; F9 explains itself.
  `devEnabled` defaults to `LEGACY` so the `?legacy=1` path keeps its old behaviour.
- **Real coverage at last** — this is why the regression went unnoticed: Slice 4 only ever
  manually probed dev. Every command now asserts observable state (god absorbing creature and
  weather damage then resuming; `tp` pushing the exact clipped 5x5 chunk set; all 9 spawn
  types in a `cre` frame; `mono` changing spawn gating; `kill` opening the movement grace
  window), plus the refused-without-claim case for all eight.

**`gameserver/test-go.mjs` now mints its own tickets** with a pinned keypair, because no single
control-plane policy can produce both a claimed and an unclaimed ticket in one run. It therefore
needs the control plane pinned to that pair — `node tools/dev/stack.mjs --no-client` reads the
keys straight out of the test file and sets them, so `npm run test:go` needs no extra setup.

Two behaviours confirmed as legacy design, not bugs: `godTick` heals *after* damage lands (hp
dips a point inside a tick, restored at the top of the next), and `clearcre` is often not
observably empty at night because the natural spawn roll runs in the same tick.

Known pre-existing wart: `buildDevPanel()` builds once per page, so its click listener closes
over the scene that built it — after quit-and-rejoin it reads the previous scene's state.
Harmless today (the claim is per-account) and it predates this work.

### Room admission: 4-player cap + one session per identity (2026-09-20)

**Cap.** Each room holds **4 players** (the `PLAN.md` co-op target). Before this there was no
cap anywhere — a room accepted unlimited players and then shed whoever's outbound buffer
filled first, surfacing as a random disconnect rather than "the room is full". Enforced in
`Room.admit` on the room goroutine, because only the room knows who is actually connected;
the control plane's count is stale the moment a socket drops. A 5th connection gets
`{t:'authfail',reason:'room-full'}` and is closed **before** any `init` or chunk. Configurable
per world via `maxPlayers` in the same registry the world list uses, plus
`HEARTH_WORLD_MAX_PLAYERS`; absent/invalid falls back to `room.DefaultMaxPlayers = 4`.

**One live session per identity** — fixes a reproduced bug: duplicating a browser tab shares
`localStorage`, so the copy presents the same `hearth-tok`, the control plane signs a ticket
for the same `userId`, and the room had no reason to object. The result was two copies of one
player in the world.

Policy is **takeover, not rejection**: a second ticket for a live `userId` evicts the first,
which receives `{t:'kick',reason:'replaced'}` before its socket closes. Rejecting the newcomer
instead would lock a player out of their own character after a browser crash until the stale
socket timed out — a worse failure than the duplication.

Two things that must not be reordered or simplified:
1. **Takeover resolves BEFORE the cap check.** If a full room contains your own stale session,
   your reconnect replaces a seat rather than claiming a fifth. Reversed, a player who crashed
   could never re-enter their own full room. Pinned by `TestTakeoverIntoAFullRoomSucceeds`.
2. **Eviction goes through the `dropSlow` teardown** — profile snapshotted, removed from
   `players` AND `playerOrder`, `pl` broadcast. A session left in `playerOrder` is a ghost the
   creature AI still targets.

`room.Registry` (identity -> {room, session}) is process-wide and mutex-guarded. That does
**not** breach the no-locks contract: it stores only presence, never anything reachable from a
`*Player` or `*Room`, and cross-room evictions are posted to the target room's `kicks` channel
so every mutation of a room's players still happens on that room's own goroutine.

Client: `kick` and `authfail` both route through `quitToMenu({error})` and the menu banner, so
the evicted tab reads as an intentional handover rather than a crash. **The client must never
auto-reconnect on `replaced`** — two tabs would evict each other forever.

**Cold-start fix found during verification:** worlds build lazily (right for multi-world), so
the FIRST join paid ~6s of worldgen and the wire suites timed out waiting for `init`.
`tools/dev/stack.mjs` now sets `HEARTH_EAGER_WORLDS=1` — a dev stack hosts one world that is
certain to be joined. A cold *production* multi-world instance still makes its first joiner
wait; the client shows no progress during that window, which is worth addressing before anyone
hosts one.

Multi-instance is still open: two `hearthd` processes can each hold a live session for one
`userId`. Closing it needs presence state the control plane does not have (a shared
`userId -> {instanceId, sessionId}` store plus an evict RPC or pub/sub, with leases so a
crashed instance expires). The room-side logic would not change — only who tells it to evict.

### Verification at this update

| Gate | Result |
|---|---|
| `gameserver/test-go.mjs` | ALL TESTS PASSED, **zero skips** |
| `gameserver/test-multiworld.mjs` | ALL MULTI-WORLD TESTS PASSED |
| `control/test.mjs` | ALL TESTS PASSED |
| Root `test.mjs` vs legacy Node server | ALL TESTS PASSED |
| `go build` / `vet` / `gofmt` / `go test` (+ `-race` on hosting) | clean |
| `tsc --noEmit` / `vite build` / worldgen parity | clean / green / exact on 5 seeds |

**Both wire suites need `HEARTH_ALLOW_WARP=1` and a FRESH server** — they are stateful; a
second run against a live server fails at `gather` because nodes are on respawn timers.
Delete `gameserver/world*.save.json` between runs.

### Remaining, genuinely optional

- `control/worlds.json` is not checked in; the single-world env fallback covers the default.
  Add one only when actually hosting several worlds. Format in `docs/10` §11.2.
- Not verified: medic visibility for a *second* connected client, and medic placement across
  a reconnect into an already-chunked world (the `medicSpr.has` guard covers duplicates).
- The dead leash-despawn branch from `server/index.js:1231` is preserved verbatim and pinned
  by a test. Balance decision, not a port bug.

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

# Go game server migration, end to end — 2026-09-20 13:30

## Session summary

One long session, branch `go-migration`. Started with five small fixes from the previous
backlog, then made movement server-authoritative, then ported the entire game server from
Node to Go across four slices, then closed every integration gap, then fixed the dev/tester
tooling, then added room admission (4-player cap + one-session-per-identity).

The port is **feature-complete and verified**: 23/23 inbound and 38/38 outbound message types,
`gameserver/test-go.mjs` green with zero skips, and the legacy Node server still passing its
own suite so the old path is not broken.

Work was delegated to Opus/Sonnet subagents with strict file ownership (`gameserver/**`,
`control/**`, `src/**`, `tools/**` never edited concurrently). The orchestrator ran every
authoritative verification itself and did not trust a subagent's claim — that caught three
real problems, listed under "Reports that did not survive review".

---

## What shipped, in order

### 1. Five small fixes
- Settings toggles wired via a new `src/settings.ts` leaf module (`hearth-muted`,
  `hearth-shownames` were written and never read).
- `ui.reset()` added and called from `quitToMenu()` — cached signature strings survived a quit,
  so a re-offered identical medic bargain never re-opened its panel.
- Two bare `setTimeout` clearTint calls became `this.time.delayedCall` (scene-owned, die with
  the scene).
- Medic huts now block creature pathing.
- `README.md` accuracy pass (192x192 -> 1280, SPACE=jump/F=attack, seven undocumented keys).

### 2. Server-authoritative movement
`pos` was the one handler assigning `m.x`/`m.y` straight to `p.x`/`p.y`. Every other handler
range-checks against `p.x`/`p.y`, so fixing movement retroactively hardened the other 24.
Speed budget, z-aware collision, `zAnchor` layer gating, throttled `fix` snapback, grace
windows on all 12 server-side reposition sites. `test.mjs` teleported the player 45 times, so
the server gained a `warp` message behind `HEARTH_ALLOW_WARP`.

### 3. The port, four slices
- **Slice 1** — Ed25519 ticket auth, 64x64 chunk terrain streaming, the movement validator.
  Client stopped calling `genWorld()`.
- **Slice 2** — every resource/construction handler, `shared/defs.json` extraction.
- **Slice 3** — 9 creature types, 7 animals, weather, wisp infection, creature combat.
- **Slice 4** — medic bargain state machine, progression, waves, `dev`/`devcmd`.

### 4. Integration gaps
Medics on the wire, `tools/dev/stack.mjs` + npm scripts, `HEARTH_DEV` deleted in favour of a
per-account ticket claim, legacy `?legacy=1` path verified, vitals made integral on the wire,
multi-world hosting with per-world rooms and save files.

### 5. Dev/tester tooling
Owner reported it missing. It was not: all eight `devcmd` subcommands and the F9 kit worked on
first contact. Two presentation faults made it *look* missing — see "Bugs found".

### 6. Room admission
4-player cap, and one live session per identity (the duplicate-tab bug).

---

## Decisions made

**Worldgen ported bit-exactly, including `alea` and `simplex-noise` by hand.** A different but
equally valid Simplex gives a different world. This was required because `test.mjs` calls
`genWorld('hearth-1')` and asserts against those exact tiles — bit-exactness preserved ~1000
lines of black-box tests. It does *not* incur the usual "keep two implementations in sync
forever" cost, because the client stopped generating: the JS `genWorld` is now legacy/test-only.

**Terrain streams from the server (assessment doc option B).** Deletes the client/server
divergence class permanently and is the protocol needed anyway for persistent mutated worlds.

**The client sends no world snapshot request; Go answers it.** The owner originally specified
Node sending the snapshot. Under the split that cannot work — the live mutated world exists only
inside the Go process, so Node would need to mirror it (two writers) or read a stale save.
Node allocates and authorises; Go answers what the world looks like.

**"Reject moves into water" was not implemented as specified.** Water is legal at z=0 — that is
swimming and sailing. The server's existing `blocked()` treats water as solid; reusing it would
have made the ocean impassable. `posBlocked` mirrors the *client's* per-layer rules instead.

**Dev tooling gated on a per-account ticket claim, not an env var.** A server-wide flag hands
world-mutating commands to every connected player. `HEARTH_DEV_ALL=1` is the local-developer
bypass and is scoped to **loopback remote addresses**, checked per-request rather than on the
bind address — control binds `0.0.0.0` for LAN play, so a bind-based check would either break
LAN or give dev tools to every LAN player.

**Duplicate identity: takeover, not rejection.** Rejecting the newcomer would lock a player out
of their own character after a browser crash until the stale socket timed out — worse than the
duplication it prevents.

**Takeover resolves before the cap check.** A player reconnecting into a full room containing
their own stale session is replacing a seat, not claiming a fifth.

**`shared/defs.js` is generated, not a runtime re-export.** No JSON import syntax works in both
this repo's Node 18 and a Vite browser build; the agent tested this before choosing.

---

## Bugs found and root causes

### The dev tooling "was missing" — it was the toast
The refusal string was inherited verbatim from the legacy server: *"start the server with:
npm run server:dev"*. On the Go path that starts the **legacy** :8081 server and names a
`HEARTH_DEV` env var that had been deliberately deleted. Following the advice changed nothing,
which reads as "never ported". Compounded by the F10 panel opening unconditionally client-side,
so buttons looked live and silently did nothing.

### Duplicate tab cloned the player
A duplicated tab shares `localStorage`, so it presents the same `hearth-tok`; the control plane
signs a ticket for the same `userId`; the room had no reason to object. Two copies of one player.

### Z-transition validation allowed a global teleport
First implementation checked proximity against the **destination only**, and that branch
deliberately skips the distance check — so a client could "transition" to any mineshaft or any
player's shelter on the map. Fixed by requiring one structure near **both** endpoints.

### `test.mjs` is stateful and misled the orchestrator
Two runs failed at *different* stages; it looked like a regression. It connects to an
already-running server and mutates the save, so a second run fails at whatever the first
consumed. Every real verification since has used an isolated server on a spare port with its
own save file.

### Lazy world build broke cold starts
Worlds build lazily (correct for multi-world), so the first join pays ~6s of worldgen and the
wire suites time out waiting for `init`. `stack.mjs` now sets `HEARTH_EAGER_WORLDS=1`.

### Ocean chunks were 88% vein data
Worldgen fills `veins` from noise on every tile including open ocean. Masking veins to land on
the wire took an all-water chunk from ~1568 to ~240 bytes.

---

## Reports that did not survive review

Three subagent claims were wrong and were caught by running the thing:

1. **"E4 un-skipped and passing"** — it printed *"no chit received … skipping ang check"* and
   asserted nothing. Sent back; now retries within a bounded budget and hard-fails.
2. **"Slice 3 complete"** — the agent was killed by a session limit mid-task; the committed tree
   did not compile (`creatures.go` referenced `Room` fields never added).
3. **"`init.medics` wired"** — the client agent reported `structs` missing `dir` and veins
   masking absent; both had in fact been fixed by the concurrent agent. Cross-checking the two
   reports against the code resolved it.

A fourth was a near miss: an agent restored `src/main.ts` from a backup while debugging and
flagged possible clobbering of concurrent edits. Verified directly — all three bodies of client
work (dev panel, medics, kick/room-full) were present.

---

## Findings not yet fixed

### `userId` is random and in-memory — players lose their character (HIGH)
`control/index.js:20` mints `userId` from `crypto.randomBytes(12)` into an in-memory `Map`. The
Go server persists player profiles **keyed by that `userId`**. Restart the control plane and the
same `hearth-tok` gets a new random `userId`, orphaning the saved profile: inventory, tools,
gear, position, all gone. The player's `tok` is stable in localStorage; only the mapping is
volatile. Fix: derive `userId` deterministically from `tok` (keyed hash) — survives restarts
with no storage at all.

### Room codes still cosmetic
`requestJoin()` sends only `{name, tok}` — no `worldId`. `src/menu.ts` collects a room code into
localStorage and sends it nowhere. The entire multi-world backend works (registry,
`/api/worlds`, server-side resolution, ticket binding, per-world rooms, proven isolation) and
every player still lands in `default`. This is now a wiring job, not an architecture problem.

### Others
No durable storage in the control plane; the legacy server retirement decision;
`buildDevPanel()` closes over the scene that built it; a cold production multi-world instance
makes its first joiner wait ~6s with no progress shown; `pj` is broadcast to the joining player
itself (cosmetic only).

---

## Notes for the next session

- **Run the verification yourself.** Three subagent reports in this session were wrong in ways
  that only running the suite revealed.
- **Both wire suites need a FRESH server and `HEARTH_ALLOW_WARP=1`.** Delete
  `gameserver/world*.save.json` first. `npm run stack:servers` sets the flags and pins the
  ticket keypair `test-go.mjs` needs.
- **Never bind :8081 or touch `server/save.json`** without backing it up — it is the owner's
  real save, and the legacy server owns that file.
- **`node tools/worldparity/compare.mjs` is the gate after any worldgen edit.** Bit-exactness is
  load-bearing for the whole test suite.
- The owner's commit `ccbdc4a` captured a non-compiling tree (see above); the branch tip wants a
  follow-up commit.

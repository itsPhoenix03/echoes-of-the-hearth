# Go Game Server Migration — Assessment Report

**Date:** 2026-08-30
**Revised:** 2026-08-30, after the owner clarified intent — see §3.
**Question posed:** move the socket/game server to Go, keep Node for auth, sessions, and
allocating WebSocket servers per world — so the game becomes properly multiplayer and
account-based rather than local/LAN-only (local play still supported).

**Owner's stated intent (this is the decided destination, not an option under evaluation):**
*all* game-server responsibility moves to Go; *all* management responsibility stays in Node.
Game logic was never going to remain in Node. The motivation is load separation and clear
ownership — being able to tell immediately whether a fault is in the game server or the auth
server.

This report evaluates that plan against the code as it exists today. It is an assessment,
not an implementation plan; the phased plan at the end is a sketch, not a commitment.

---

## 1. What exists today (measured, not assumed)

| Fact | Value |
|---|---|
| Game server | `server/index.js`, single file, 1,499 lines / 74 KB, Node + `ws` |
| Sim tick | `setInterval` at `TICK_MS = 200` → **5 TPS**, one global loop |
| World | 1280 × 1280 = **1,638,400 tiles**, deterministic from `SEED` |
| Worldgen | `shared/world.js`, `simplex-noise` + `alea`, **imported by client AND server** |
| Rules data | `shared/defs.js` (recipes, `STRUCT_HP`, costs), **imported by client AND server** |
| Day cycle | `shared/time.js`, **imported by client AND server** |
| Protocol | JSON over WebSocket, ~25 inbound message types, ~30 broadcast types |
| Fanout | `bcast()` — serialize once, send to **every** connected player. No interest management |
| Persistence | `server/save.json`, full snapshot written every 30 s + on SIGINT |
| Identity | `localStorage['hearth-tok']` → `profiles[tok]`. No auth, no accounts |
| Rooms | **Cosmetic.** One process = one world. Every player lands in the same world |
| Tests | `test.mjs`, ~1,000 lines, **black-box over the wire** (only imports `shared/` for expected values) |

Two properties of that table matter more than the rest:

1. **`shared/` is the contract that keeps client and server agreeing.** Not a convention —
   an actual module import. Worldgen, recipe costs, structure HP and the day cycle have
   exactly one implementation, so they cannot drift.
2. **`test.mjs` is a black-box protocol suite.** It connects to `ws://localhost:8081` and
   asserts on messages. It does not touch server internals. This is the single most
   valuable asset you own for any rewrite, in any language.

---

## 2. The proposal, restated precisely

```
Browser ──HTTP──> Node control plane        (accounts, login, room CRUD, matchmaking,
   │                 │                       "which game server hosts room X?")
   │                 │
   │                 └─ Postgres (users, rooms, memberships, world saves)
   │                 └─ Redis    (session locks, room→instance routing, presence)
   │
   └──WS────> Go game server (N instances, M rooms per instance)
                 authoritative sim, one goroutine per room
```

This is a completely standard shape — it is what Agones, Nakama, Colyseus-at-scale and
essentially every commercial session-based game converge on. The architecture is not the
risk. **The risk is entirely in what crossing a language boundary does to `shared/`.**

---

## 3. Verdict

**The split is right and Go is a sound choice for the game side.** The destination in §2 is
the shape essentially every session-based game converges on. This section records two
things worth being precise about, because they affect *sequencing*, not the destination.

### 3.1 Fault isolation comes from the process boundary, not from the language

The stated motivation — "know which server is at fault" — is delivered the moment the game
runtime and the control plane are **separate deployables with separate logs, metrics and
deploy cycles**. A Node game server and a Node auth server would give the identical
debugging story. Load separation is the same: the two workloads are wildly asymmetric
(auth/lobby is bursty and tiny, the game loop is sustained and CPU-bound), and splitting
them means they scale independently — again, a property of the boundary.

This is not an argument against Go. It means the boundary can be drawn immediately and
cheaply, and Go's timing can then be chosen on Go's own merits rather than being coupled to
the operability goal. Those merits are real and are listed in §5.

### 3.2 The strongest Go-specific argument is local play

Local/offline play is staying a first-class mode. That creates a trap: if hosted play runs a
Go server and local play runs the Node server, **the game rules exist in two languages
forever** — the exact failure mode §4 warns about, but applied to all of gameplay rather than
just worldgen.

A single static Go binary solves this outright. `hearth-server.exe`, double-click, no Node
install, no `npm install`, no `node_modules` — and it is the *same* binary and the *same*
rules that run hosted. This is a better answer than Node can give, and it is the argument
that most justifies Go here.

### 3.3 Revised sequencing

Given Go is the destination, the earlier advice to "ship on the Node runtime first" is
withdrawn: building a full Node room runtime wired into Postgres and Redis, intending to
discard it, is waste.

1. **Phase 0 preparation still happens first**, but it is now prep *for the port* rather than
   for a Node runtime — extract `shared/defs.js` to language-neutral data, hoist room state
   out of module-level globals, grow `test.mjs`. See §10.
2. **Build the Node control plane and the Go room runtime against each other**, to the
   boundary in §7.
3. **Leave today's `server/index.js` untouched and running** for local and LAN play until the
   Go runtime reaches parity, then retire it in favour of the Go binary in both modes.

The cost in §6 and the worldgen problem in §4 are unchanged by any of this. §4 in particular
does not get cheaper by being deferred, and it is the item most likely to derail the port.

---

## 4. The central problem: `shared/` cannot cross a language boundary

> **Two axes, easily conflated — they are independent decisions.**
>
> - **This section (§4) is about *worldgen delivery*:** who generates the 1.6 M terrain tiles
>   and how the client obtains them. Options A / B / C below are the three answers.
> - **§8 item 2 is about *gameplay authority*:** who decides outcomes — position, damage,
>   inventory. That axis is already ~96 % resolved in the current server; only `pos` is
>   client-trusted.
>
> The only link between them: option B makes the Go server the sole source of truth about
> what terrain *is*, which is what a movement check needs in order to say "you cannot walk
> there, that is water." Under A or C the server can still validate movement — it has its own
> tile array — but it would be validating against a map the client may disagree with, and a
> divergent tile becomes a player rubber-banded on ground they can see.

Today `genWorld(seed)` runs **identically** on the client and the server because it is
literally the same file. The client uses it to render terrain; the server uses it to decide
what is walkable, what is minable, where medics spawn. Move the server to Go and that
single implementation becomes two.

The failure this produces is nasty: not a crash, but **silent, seed-dependent divergence**.
One tile at `(417, 903)` is sand on the client and water on the server. The player walks
onto visible ground and is told they are swimming. It reproduces only on some seeds, only
in some regions, and hunting it means diffing 1.6 M tiles between two languages.

Why bit-exact reimplementation is genuinely hard:

- `alea` is a specific PRNG with a specific internal state layout. Reproducing it in Go
  means porting it exactly, not "using a seeded PRNG".
- `simplex-noise`'s output depends on its gradient tables, permutation construction, and
  skew constants. A different Simplex library gives different, equally-valid noise.
- Every number in JS is `float64`. Go will let you write `float32` or `int` by accident and
  the rounding difference only shows up at thresholds — exactly where terrain type is
  decided.
- Ordering matters. Any `Map`/`Set` iteration that feeds generation must be reproduced in
  insertion order; Go map iteration is deliberately randomised.
- It is not a one-time cost. Every future worldgen tweak must land in both, in lockstep,
  forever, or the divergence returns.

### Three ways out

**Option A — Port worldgen to Go and keep both implementations in sync.**
Cheapest to start, most expensive to live with. Only viable with a hard gate: a fixture
test that generates N seeds in both languages and asserts a byte-identical hash of the tile
array, run in CI on every commit. Without that gate this option will fail — not "might".

**Option B — Make worldgen server-authoritative and stream tiles to the client. (Recommended.)**
Go owns generation; the client stops generating and receives terrain. This deletes the
divergence class entirely, permanently. Cost: a chunk-streaming protocol. 1.6 M tiles at
one byte per tile is 1.6 MB raw; with a tile palette + RLE, terrain of this kind compresses
roughly an order of magnitude, and you only ever ship chunks near the player. You need this
protocol anyway the moment worlds become user-owned and persistent — a joining player must
receive the *mutated* world, not regenerate a pristine one. **This is the strongest single
argument for doing the migration properly rather than minimally.**

**Option C — Keep worldgen in Node as a generation service.**
Node generates the tile array once at room creation, persists it to Postgres/blob storage,
Go loads it at room boot. Pragmatic middle ground: no reimplementation, no divergence, one
extra hop that runs once per world lifetime. Weakness: Node stays on the critical path for
room creation, and the client still holds its own copy of `genWorld` — so the divergence
risk returns the moment anyone edits `shared/world.js` without regenerating existing worlds.

**`shared/defs.js` is a separate, easier problem.** Recipes, `STRUCT_HP` and costs are
*data*, not algorithms. Move them to a language-neutral JSON/TOML file that Go unmarshals
and the client imports. Do this **before** the Go work starts — it is a small change, it is
useful regardless of whether you ever migrate, and it removes a whole category of
"crafting costs 3 wood on the client and 4 on the server" bugs. Same for `shared/time.js`
(three constants).

---

## 5. Genuine pros of Go for the room runtime

These are real; I am not arguing the language choice is wrong.

- **Per-room isolation via goroutines.** This is the strongest technical argument, and it
  is about *correctness under load*, not raw speed. In Node, one room's expensive tick
  blocks the event loop for **every** room in the process. `PLAN.md` still has fire-spread
  cellular automata, water flow, blight evolution and A* pathfinding unbuilt — all of which
  are exactly the kind of full-map CPU work that would stall a shared loop. In Go each room
  is a goroutine on its own ticker, and a slow room degrades only itself.
- **True multi-core parallelism in one process.** Node needs `cluster`/worker threads plus
  the routing complexity that follows. Go gets it for free.
- **GC profile.** Go's collector targets sub-millisecond pauses. V8 is good, but a major GC
  landing mid-tick at 5 TPS is a visible hitch; the margin matters more as tick rate rises.
- **Memory footprint per room.** With `[]byte` for the tile layer and struct slices for
  entities, a Go room is compact and predictable. JS objects carry meaningful per-object
  overhead once you have thousands of live entities.
- **Static binary deployment — and this is what makes local play work.** One artifact, no
  `node_modules`, tiny container, fast cold start. Meaningful if rooms are spun up on demand,
  but far more meaningful for the offline/LAN mode: a single `hearth-server.exe` a player
  double-clicks, with no Node toolchain to install. Critically, it is the **same binary and
  the same rules** that run hosted, which is the only way to avoid maintaining local-play
  game logic in JS and hosted game logic in Go. See §3.2.
- **Explicit concurrency primitives.** Channels and `select` map cleanly onto "inbound
  message queue + tick timer + shutdown signal", which is precisely the room loop's shape.
  Today's implicit single-threaded safety would become explicit and enforced.
- **Static typing over a 1,500-line mutable-state file.** The compiler catches a real class
  of bug that the current JS server catches at runtime, in production, as a crash (see
  commit `81c69ac`, "Fixed a reference error causing the server crash").

---

## 6. Genuine cons and costs

- **Rewrite volume.** ~1,500 lines of dense, subtle, shipped server logic plus ~450 lines of
  `shared/`. Ported line count is not the cost — the *behavioural* detail is. Fall damage,
  boat wrecking on icebergs, the medic bargain state machine with its 60 s expiry and 20 s
  reroll, wisp infection spread and decay, mud from over-harvesting, the wave timer,
  amphibious-creature swim rules. Every one of those is a small rule that someone tuned by
  playing, and every one is an opportunity to port it *almost* right.
- **Two languages, one developer.** Every change to a game rule becomes a change in two
  repos, two toolchains, two deploy pipelines, two debug environments. This is the cost
  people consistently underestimate.
- **Feature freeze.** Realistically the JS server stops evolving during the port, or you
  port a moving target. The modular building system — named as the next priority and the
  only thing that unlocks ~30 unused art assets — waits.
- **Zero user-visible payoff at the end.** After a successful port the game plays exactly
  as it does now. Motivationally this is harder than it sounds.
- **Loss of an ecosystem you already use.** `simplex-noise`, `alea`, `ws` all have Go
  equivalents, but they are not drop-in and the noise/PRNG ones are precisely the ones that
  must match bit-for-bit (§4).
- **Debugging asymmetry.** You currently debug the server with the same tools and mental
  model as the client. That ends.

---

## 7. Where the line falls, precisely

The governing rule, and the thing that actually delivers the "pinpoint the fault" property:

> **For any single piece of state, exactly one service writes it.** Where both need it, one
> writes and the other reads. When state is wrong you then know which service to look at,
> because only one could have produced it.

### Go — the room runtime

Every current inbound message type, without exception:

`pos`, `gather`, `atk`, `build`, `craft`, `plant`, `harvest`, `dig`, `furn`, `torch`, `eq`,
`wear`, `use`, `water`, `usecore`, `chest_open`, `chest_move`, `medic`, `anim`, `dev`,
`devcmd`, `hello`

Plus the sim tick, creature and animal AI, weather, the day cycle, wisp infection spread and
decay, the wave timer, and world snapshot writes.

### Node — the control plane

Accounts, login, display names, token issuance. Room CRUD, room codes, invite links, room
listing. Instance allocation ("room X lives on game server Y"). The Redis session lock and
presence. Lobby HTTP APIs behind the existing `src/menu.ts` screens.

### The genuinely ambiguous items

These are the ones that do not sort themselves, and getting them wrong is what produces
two-writer bugs.

| Thing | Owner | Why |
|---|---|---|
| `profiles[tok]` — `inv`, `tools`, `gear`, `wornGear`, `hp`, `hunger`, `thirst`, `x`, `y` | **Go** | World state, not account state — only meaningful inside one room. Re-key from `tok` to `(userId, roomId)` |
| `name` (today inside the player snapshot) | **Node** | Account-level. Go receives it in the ticket and echoes it; Go must not store or mutate it |
| Room chat | **Go** | Must interleave correctly with game events, and the socket is already open. Owning it in Node means a second socket and no ordering guarantee against game messages |
| Global chat | **Node** | I/O-bound cross-room fanout, touches no game state |
| 4-player room cap | **Both** | Node enforces at allocation; Go re-checks on connect. Node's count is stale the instant a socket drops — only Go knows who is actually connected |
| World snapshot writes to Postgres | **Go, exclusively** | The room is sole writer while live. Node may read snapshots, and may write only when the room is provably not running (Redis lease) |
| `users`, `rooms`, `memberships` tables | **Node, exclusively** | Go never writes these |
| `dev` / `devcmd` (F9 / F10 tester panels) | **Go** | Game-state mutation. But gate on a claim in the ticket Node issues, rather than the current server-wide `DEV` env var |

### The auth handoff — a signed ticket, not a shared session store
1. Client authenticates to Node over HTTP.
2. Node validates room membership and issues a **short-lived signed ticket** (JWT, ~30 s
   TTL, single-use) bound to `{userId, roomId, instanceId}`.
3. Client opens the WebSocket to the Go instance with that ticket.
4. Go verifies the signature locally — **no network call to Node on the connection path**.

The mistake to avoid is having Go call Node to validate every connection. That makes Node a
hard dependency of gameplay: Node hiccups and nobody can connect or reconnect. Verify
locally, offline, from a public key.

---

## 8. Concrete issues to expect

Ordered roughly by how likely they are to actually cost you a weekend.

1. **Worldgen divergence.** §4. The one that will hurt. Mitigation: Option B, or a CI
   hash-equality gate.

2. **Gameplay authority: already solved except for movement.**

   The server is *already* authoritative for essentially everything. `gather`
   (`server/index.js:384`) rate-limits at 250 ms, verifies the target is a real node, range-checks
   at 2.5 tiles, and derives the tool from `p.tools` rather than the client's claim. `atk`
   (`:639`) rate-limits at 400 ms, checks the z-layer, derives damage from `p.equip`, and picks
   the target server-side by proximity. `build` (`:444`) validates recipe, inventory, range and
   tile legality. There is even a comment in `gather` reading *"derive the clip/tool from
   authoritative node kind + owned tool — never trust the client."* That work is done.

   **`pos` (`:246`) is the single exception.** It assigns `m.x, m.y` straight to `p.x, p.y` with
   no speed check, no collision check on the accepted position, and no teleport rejection.

   This matters more than "1 of 25 handlers" suggests: every range check above is measured
   against `p.x, p.y` — a real check, but **anchored to a position the client controls**. Set
   yourself to any tile and every range check passes honestly. Fixing movement retroactively
   hardens all the other handlers. On LAN with friends this is harmless; with accounts and
   public rooms it is free teleport, wallhack and speedhack for anyone who opens DevTools.

   **Full server-simulated movement is not required.** Three levels:

   | Level | What it means | Cost |
   |---|---|---|
   | 1. Today | Server writes whatever the client sends | — |
   | **2. Validated (recommended)** | Server keeps last position + timestamp; rejects moves exceeding max speed × elapsed time and moves into water or blocking structures; snaps the client back on reject. Client still predicts locally and in normal play is never corrected | ~a day |
   | 3. Fully simulated | Client sends *input* (`dx, dy`), server simulates position, client does prediction + reconciliation | Weeks, and risks movement feel |

   Level 3 is what competitive shooters do. This is 4-player PvE co-op — the threat is a
   griefer in a public room, not competitive advantage. Level 2 eliminates teleport, wallhack
   and speedhack without rewriting client movement.

   Not caused by the migration, but **going public is what makes it matter**. Fix it as a
   deliberate, separately-tested change — it can ship on the current Node server before the
   port even starts. Do not let it ride along silently inside the rewrite.

3. **Tick-rate semantics differ.** Node's `setInterval` under load queues callbacks and
   fires late; Go's `time.Ticker` **drops** ticks on a full channel. A ported loop that
   assumes "one tick = one fixed time step" will silently run the sim slow under load —
   day/night, crop growth, medic expiry and the wave timer all drift. Use an accumulator
   against a monotonic clock, not a tick counter, for anything time-derived.

4. **Map iteration order.** The JS server iterates `Map`s and `Set`s (`structures`, `farms`,
   `creatures`, `infected`) in insertion order. Go randomises map iteration deliberately.
   Anywhere order affects outcome — spawn selection, target picking, tie-breaks in creature
   AI, the order broadcasts are emitted — behaviour changes. Some of that is harmless
   variety; some is a bug. Audit each site rather than assuming.

5. **`bcast()` does not scale past one room.** Today it sends to every connected player.
   Per-room fanout is a straightforward change, but it has to be deliberate — a missed call
   site leaks one room's events into another, which is both a bug and an information leak.

6. **Float formatting and JSON round-tripping.** Go's `encoding/json` and `JSON.stringify`
   do not always produce identical text for the same float64. If any client logic compares
   or hashes serialised values, that surfaces. Prefer explicit rounding/quantisation of
   positions on the wire (which also cuts bandwidth).

7. **Persistence rewrite.** `save.json` is a whole-world snapshot every 30 s. That does not
   survive contact with N concurrent rooms in Postgres. You need: per-room rows, write
   batching, and a decision about what happens when a room crashes 29 s after its last save.
   Also concurrency — two processes must never believe they own the same room. That is what
   the Redis lease in the room-architecture guide is for; honour it strictly.

8. **Reconnect and instance failover.** Currently a socket drop is a full rejoin into a
   world that never went away. With allocation, a reconnecting player must be routed back to
   the *same* instance, or the room must be rehydrated elsewhere from its last snapshot.
   Expect rollback complaints ("I lost 40 seconds of mining") and design the save cadence
   with that in mind.

9. **`test.mjs` gets awkward mid-migration.** It imports `shared/world.js` to compute
   expected values. If Go becomes the generator, those expectations must come from the
   server instead. Solve it by having the Go server expose the world (or its hash) at
   `init` — which you want anyway under Option B.

10. **Infrastructure realities.** WebSockets need sticky routing and cloud load balancers
    idle-timeout them (commonly 60 s); you need heartbeats. TLS termination in front of Go.
    Graceful shutdown must drain rooms and save before exit, or deploys eat progress.

11. **Windows-first development.** Everything here cross-compiles and runs fine on Windows,
    but the local dev story goes from `npm run server` to "Node + Go + Postgres + Redis".
    Budget time for docker-compose and for the fact that `npm run dev` no longer covers it.

12. **Client protocol churn.** `src/main.ts` is 2,942 lines and speaks this protocol
    directly. If the port also changes message shapes (binary, per-room routing, chunk
    streaming), the client change is not small. Keep the protocol **byte-identical** through
    the port and change it in a separate, later step. One variable at a time.

---

## 9. When the Go payoff actually lands

The decision is made (§3), so this section is no longer a set of go/no-go triggers. It is
what to expect: the port's benefits are **back-loaded**, and knowing which ones arrive when
is what keeps the effort from feeling unrewarded at cutover.

**Arrives immediately at cutover:**
- The single-binary local server (§3.2) — the clearest and earliest win.
- Fault isolation and independent scaling — though strictly this comes from the boundary,
  not from Go (§3.1).
- Compile-time safety over what is currently 1,500 lines of mutable module-level state.

**Arrives only under load you do not have yet:**
- Multi-core parallelism and GC headroom. At 4 players/room and 5 TPS these are latent.
- Many rooms per box. Real, but only visible once room count is high enough to bill for.

**Arrives when you build the systems that are still unwritten:**
- Per-room goroutine isolation. This is the largest technical benefit and it is **entirely
  in the future**: it matters when one room's tick gets expensive, and the things that make a
  tick expensive — fire-spread CA, water flow, blight evolution, A* pathfinding — are all
  still unbuilt `PLAN.md` items. In Node one room's heavy tick stalls every room in the
  process; in Go it degrades only itself.

The practical consequence: **porting before writing those sim systems is meaningfully
cheaper than porting after**, because you write them once, in Go, against the concurrency
model they need. If the modular building system is genuinely the next feature, that is an
argument for doing the port first rather than interleaving it — a large rewrite against a
moving target is the expensive version of this.

---

## 10. Phased sketch

Revised for Go-as-destination (§3.3). Each phase is independently revertible. Do not skip
Phase 0. Throughout, **today's `server/index.js` stays untouched and playable** — it is the
local/LAN server and the behavioural reference until Go reaches parity.

**Phase 0 — Prepare, in JS, no Go yet.**
Extract `shared/defs.js` and `shared/time.js` to language-neutral JSON that Go can unmarshal
and the client can import. Refactor `server/index.js` so all world state lives in an explicit
room object rather than module-level globals, and `bcast` becomes per-room. Extend `test.mjs`
— it is the migration oracle, and every gap in it is a bug you will ship into Go.
*Standalone value: the defs extraction and per-room fanout are improvements regardless.*

**Phase 0.5 — Movement validation (optional here, but cheap and independent).**
Level 2 from §8 item 2, on the current Node server. Doing it in JS first means you port a
*correct* movement rule to Go rather than porting the hole and fixing it later under a
rewrite you cannot A/B against.

**Phase 1 — Node control plane and Go room runtime, built against each other.**
Node: Postgres, Redis, accounts, rooms, allocation, session locks, ticket issuance, wired to
`src/menu.ts`. Go: the room loop speaking the **exact current JSON protocol**, to the
boundary in §7. Resolve worldgen via §4 Option B (recommended) or C.
Success criterion for the Go side: **`test.mjs` passes unmodified against it.**

The previous revision of this document had Phase 1 as a Node room runtime on Postgres/Redis,
with Go deferred to Phase 2. That is withdrawn — it builds a runtime intended for disposal.

**Phase 2 — Cut over behind a flag.**
Route new rooms to Go, keep existing sessions on Node. Shadow-run where practical: feed the
same inputs to both and diff outputs. Keep the Node server as a rollback for at least one
release.

**Phase 3 — Retire the JS server.**
Ship the Go binary as the local-play server too (§3.2). This is the point at which game rules
stop existing in two languages, and it is the phase most likely to get skipped and left
half-done — it has no user-visible payoff, so schedule it explicitly.

**Phase 4 — Only then optimise.**
Binary protocol, interest management / AOI, delta compression, higher tick rate. All easier
once one runtime owns the room and the protocol is the only variable.

Rough effort, solo part-time, order-of-magnitude only: Phase 0 small, Phase 0.5 small,
Phase 1 **the largest single chunk in the project so far** (and it is now two workstreams,
not one), Phase 2 medium (mostly patience), Phase 3 small but easily orphaned.

---

## 11. Summary

- The split — all game responsibility in Go, all management in Node — is the correct
  architecture. No argument.
- Fault isolation and load separation come from the **process boundary**, not from the
  language choice (§3.1). Go still earns its place, most clearly through the single static
  binary that lets local play and hosted play run identical rules (§3.2).
- The blocker is not Go. It is `shared/`, which today is the only thing preventing
  client/server divergence and which does not survive crossing a language boundary. Resolve
  it with server-authoritative streamed worldgen (§4 Option B) rather than two
  implementations maintained in parallel.
- Gameplay authority is already ~96 % server-side. `pos` (`server/index.js:246`) is the lone
  gap, and because every other range check is anchored to `p.x, p.y`, closing it hardens all
  of them. Level-2 validation is enough — full server-simulated movement is not required
  (§8 item 2). It can ship on the current Node server, before the port.
- Go's largest technical benefit — per-room goroutine isolation — is entirely in the future.
  It matters when ticks get expensive, and the expensive systems (fire CA, water flow,
  blight evolution, pathfinding) are unbuilt. That is a real argument for porting *before*
  writing them (§9).
- `test.mjs` is the asset that makes the rewrite survivable — it is black-box over the wire,
  so it can point at the Go server nearly unchanged. Grow it in Phase 0, before you start.
- One writer per piece of state (§7). That rule, not the language, is what makes faults
  attributable.

**One thing to avoid above all:** treating the port as done at cutover. Phase 3 — retiring
the JS server so local and hosted play run the same binary — has no user-visible payoff and
is the step most likely to be orphaned. Leaving it undone means maintaining the game rules in
two languages permanently, which is the single worst outcome available here.

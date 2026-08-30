# Go Game Server Migration — Assessment Report

**Date:** 2026-08-30
**Question posed:** move the socket/game server to Go, keep Node for auth, sessions, and
allocating WebSocket servers per world — so the game becomes properly multiplayer and
account-based rather than local/LAN-only (local play still supported).

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

## 3. Verdict up front

**The architecture is right. The sequencing is wrong.**

The features you actually want — accounts, real isolated rooms, persistent user-owned
worlds, one-session-per-player, reconnect — are **100% control-plane work**. Not one of
them requires Go. Every one of them is already designed in
`docs/MULTIPLAYER_ROOM_ARCHITECTURE_GUIDE.md`, which is currently deferred.

Meanwhile the Go rewrite delivers **zero user-visible features**. It buys headroom you do
not yet need: at 4 players/room and 5 TPS, a single Node process will host hundreds of
rooms before CPU becomes the constraint. You would be spending the largest single chunk of
engineering effort in the project's history to arrive at feature parity.

**Recommended order:**

1. Build the control plane in Node (accounts, rooms, Postgres, Redis routing) **and while
   doing it, sever the room runtime behind a clean process boundary** — spawn/address it,
   never reach into it.
2. Ship real multiplayer on the Node runtime. Learn what the load actually looks like.
3. Port the room runtime to Go **when a measured reason appears** (see §9 for the triggers).
   Because of step 1, that port swaps one process for another and does not touch auth,
   rooms, persistence, or the lobby.

If you go straight to Go now, that is a defensible call — but make it with §4 fully
priced in, because §4 is the part that bites and it does not get cheaper by being ignored.

---

## 4. The central problem: `shared/` cannot cross a language boundary

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
- **Static binary deployment.** One artifact, no `node_modules`, tiny container, fast cold
  start. Meaningful if rooms are spun up on demand.
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

## 7. What Node should and should not own

**Node keeps (good fit, no reason to move):**
- Accounts, login, sessions, token issuance.
- Room CRUD, room codes, invite links, room listing, the 4-player cap.
- Matchmaking / instance allocation: "room X lives on game server Y".
- Postgres and Redis ownership.
- Chat fanout (global chat is I/O-bound, not CPU-bound — Node's strength).
- Lobby HTTP APIs feeding the existing `src/menu.ts` screens.

**Node must NOT keep:**
- Any authoritative game state. If both Node and Go can mutate world state, you have two
  writers and you will get lost writes. The Go room is the sole writer for a live room;
  Node reads snapshots and writes only when the room is not running.

**The auth handoff — do it as a signed ticket, not a shared session store:**
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

2. **Movement is currently client-authoritative — and going public makes that exploitable.**
   `server/index.js:246` accepts `m.x, m.y` from the client and writes them straight to
   `p.x, p.y`, then broadcasts. There is no speed check, no collision check on the accepted
   position, no teleport rejection. On LAN with friends that is harmless. With accounts and
   public rooms it is free teleport, wallhacking and speedhacking for anyone who opens
   DevTools. This is not caused by the migration, but **going public is what makes it
   matter**, and a rewrite is the natural moment to fix it. Fix it as a deliberate,
   separately-tested change — server-side movement validation touches client prediction and
   is its own project. Do not let it ride along silently inside the port.

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

## 9. What would make me recommend Go *now* instead of later

Any one of these flips the recommendation:

- You intend to build the CPU-heavy `PLAN.md` systems (fire CA, water flow, blight
  evolution, A* pathfinding) **soon**. These are what actually break the shared event loop,
  and porting before writing them is far cheaper than porting after.
- You intend to raise tick rate above ~15 TPS or player-per-room count well past 4.
- You want many rooms per box for cost reasons and have done the arithmetic showing Node
  cannot get there.
- You are more productive in Go than in JS and expect to maintain this for years. This is a
  legitimate reason and worth more than most benchmark arguments.

None of these is currently established. If one of them is actually true for you, say so —
it changes the answer.

---

## 10. If you proceed: phased sketch

Each phase is independently shippable and independently revertible. Do not skip Phase 0.

**Phase 0 — Prepare, in JS, no Go yet.**
Extract `shared/defs.js` and `shared/time.js` to language-neutral JSON. Refactor
`server/index.js` so that all world state lives in an explicit room object rather than
module-level globals, and `bcast` becomes per-room. Extend `test.mjs` — it is your
migration oracle and every gap in it is a bug you will ship. *This phase has standalone
value even if the Go work never happens.*

**Phase 1 — Node control plane.**
Postgres, Redis, accounts, real rooms, allocation, session locks. Wire `src/menu.ts` to it.
**Ship this.** It delivers the actual product goal. The room runtime is still Node, behind
a process boundary.

**Phase 2 — Go room runtime, protocol-identical.**
Reimplement the room loop in Go speaking the *exact* current JSON protocol. Success
criterion: `test.mjs` passes unmodified against the Go server. Resolve worldgen via §4
Option B or C.

**Phase 3 — Cut over behind a flag.**
Run both. Route new rooms to Go, keep existing on Node. Shadow-run where you can: feed the
same inputs to both and diff outputs. Keep the Node server as a rollback for at least one
release.

**Phase 4 — Only then optimise.**
Binary protocol, interest management/AOI, delta compression, higher tick rate. All of these
are easier once one runtime owns the room and the protocol is the only variable.

Rough effort, assuming solo part-time work and treating these as order-of-magnitude only:
Phase 0 small, Phase 1 medium-large, Phase 2 **the largest single chunk in the project so
far**, Phase 3 medium (mostly patience and observation).

---

## 11. Summary

- The split — Node control plane, Go game server — is the correct architecture. No argument.
- The blocker is not Go. It is `shared/`, which today is the only thing preventing
  client/server divergence, and which does not survive crossing a language boundary.
  Resolve that with server-authoritative streamed worldgen (Option B) rather than a
  maintained-in-parallel port.
- The features you want are control-plane features. They can ship on Node, now, without a
  rewrite, and they are already designed in
  `docs/MULTIPLAYER_ROOM_ARCHITECTURE_GUIDE.md`.
- Go's real payoff is per-room isolation under CPU load — which matters most for the
  simulation systems you have not built yet. That makes "port before building them" a
  reasonable position, if that is your near-term roadmap.
- `test.mjs` is the asset that makes a rewrite survivable. Grow it before you start.
- Fix client-authoritative movement (`server/index.js:246`) as its own project, on its own
  schedule. Public multiplayer makes it a real exploit; burying it inside a rewrite makes
  both harder to verify.

**One thing to avoid above all:** doing the Go port and the room architecture at the same
time. Two large, coupled, simultaneous changes with no working intermediate state is the
shape of migrations that get abandoned three-quarters finished.

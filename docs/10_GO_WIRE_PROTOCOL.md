# Go game server — wire protocol (Slices 1-4)

**Status:** authoritative spec for the Go runtime and the client. Both implement against
*this document*, not against each other.

Companion: `control/PROTOCOL.md` (the Node ticket format). This document covers only the
WebSocket between the client and the **Go** game server.

---

## 1. Connection

```
Client ──HTTP──> Node control plane (:8090)   POST /api/join -> { ticket, ws, worldId, name }
Client ──WS────> Go game server     (:8082)   first frame: { t:'auth', ticket }
```

The Go server verifies the ticket signature **offline** with the Ed25519 public key it
fetched at boot. It never calls Node on the connection path.

- Ticket invalid/expired → `{ t:'authfail', reason }`, then close. No world data is sent.
- Ticket valid → the server **routes it** (§11) and then replies `init` (§3); the session begins.

`authfail` reasons: `malformed`, `bad-signature`, `bad-json`, `expired` (ticket verification),
the routing refusals `wrong-instance`, `unknown-world` and `world-unavailable` (§11), and the
admission refusal `room-full` (§11.4). Every one of them is sent **before** any `init` or chunk
data, and the socket is closed immediately afterwards.

The client's identity (`userId`, `name`) comes from the **ticket**, never from a client-sent
field. A client that sends its own `name` in `auth` is ignored.

---

## 2. Framing

All messages are JSON text frames, `{ t: "<type>", ... }` — same shape as the legacy Node
server, so existing client handlers port over with minimal change.

**Exception:** chunk payloads are base64 strings inside JSON (§4). Binary frames are
deliberately NOT used in Slice 1 — debuggability over the last few percent of bandwidth.

---

## 3. `init` — sent once, immediately after `auth` succeeds

```jsonc
{
  "t": "init",
  "id": "<playerId>",          // session id, as today
  "name": "<from ticket>",
  "seed": "hearth-1",
  "worldVersion": 4,
  "size": 1280,
  "chunk": 64,                 // CHUNK_SIZE, so the client never hardcodes it
  "x": 168, "y": 168, "z": 0,  // authoritative spawn
  "hp": 10, "hunger": 10, "thirst": 10,
  "inv": { ... }, "tools": [...], "gear": [...],
  "players": [ { id, x, y, z, name, b, eq } ],
  "time": 0.31, "day": 1,
  "mono": [false,false,false,false],
  "won": false, "maxHp": 10, "wornGear": null,
  "dev": false,                // §10.6 — may this session use `dev` / `devcmd`?
  "weather": null,             // §9.4 — current front kind, or null
  "infected": [],              // §9.5 — corrupted tile indices
  "medics": [                  // §10.2 — exactly two, see below
    { "id": "medic-woods", "islandId": "woods", "sprite": "medic",
      "x": 190, "y": 172, "hutSprite": "medic_hut", "hutX": 190, "hutY": 170 },
    { "id": "medic-spire", "islandId": "spire", "sprite": "medic_snow",
      "x": 189, "y": 1107, "hutSprite": "medic_hut_snow", "hutX": 189, "hutY": 1105 }
  ]
}
```

**`hunger` and `thirst` are integers on the wire**, here and in every `stat` frame (§8.2).
The simulation carries them as fractions — the survival tick drains 0.055/0.083 per 5 s
block — but the wire value is `ceil()`, matching `Math.ceil(p.hunger)` in `server/index.js`.
Ceil, not floor: a bar reads 1 until the value has genuinely reached 0. Clients must not
round defensively; a fractional value here is a server bug.

**`dev`** is a plain boolean reporting whether this session holds the dev claim (§10.6) —
exactly the value `devAllowed` will use when a `dev` or `devcmd` frame arrives. It exists so the
client can render an honest tester panel instead of opening one whose buttons silently produce a
refusal toast. It is a *report*, never an input: the gate remains the signed ticket claim, and a
client that ignores this field and sends `devcmd` anyway is refused exactly as before. `false` is
sent explicitly rather than the key being omitted, so a client can distinguish "not a dev" from
"talking to a server too old to say".

**`medics`** is the whole medic roster. There are exactly two per world and both are pure
functions of the seed, so they ride in `init` rather than being streamed with the chunks that
contain them; the client needs them before the chunk containing a medic arrives, because the
hut tile is solid. The field names are exactly those of `findMedicSpawns()` in
`shared/world.js`, so the client can feed the array straight into its own
`medicBlockTiles(medics)` helper — the blocked hut tile is `hutY * SIZE + hutX`, and no
separate tile list is sent. `id` is the same identifier the `medic` frames (§10.2) are keyed
on. Coordinates above are for seed `hearth-1`.

**`players` shape changed** from the legacy array-of-arrays `[pid,x,y,equip,z,name,b]` to
objects. The client's `init` handler must be updated to match — flagged here because it is
the one place where "implement the spec" and "the old client keeps working" conflict.

`init` carries **no terrain.** Terrain arrives as chunks (§4). The client must be able to
render a "loading" state between `init` and the first chunk batch.

**This is the load-bearing change of Slice 1:** the client no longer calls `genWorld()`.
The Go server is the sole source of truth for what terrain *is*.

---

## 4. Chunks

The world is `1280 × 1280`, divided into `64 × 64` tile chunks → a `20 × 20` chunk grid,
400 chunks total. Chunk `(cx, cy)` covers tiles `x ∈ [cx*64, cx*64+63]`, same for `y`.

### 4.1 Push model

The server pushes; the client never requests. On connect, and whenever a player crosses a
chunk boundary, the server sends every chunk within **Chebyshev radius 2** of the player's
chunk (a 5×5 block, 25 chunks) that it has not already sent to that player. The server
tracks a per-player `sentChunks` set.

Rationale: pushing avoids a request storm on join and keeps the client dumb. The radius
covers well beyond the viewport at any supported zoom.

### 4.2 `chunk` message

```jsonc
{
  "t": "chunk",
  "cx": 2, "cy": 2,
  "tiles":     "<base64 RLE>",   // T.* values, 0..5
  "elev":      "<base64 RLE>",   // 0..3
  "veins":     "<base64 RLE>",   // 0 none, 1 iron, 2 diamond
  "waterTemp": "<base64 RLE>",   // 0 temperate, 1 freezing, 2 hot
  "tileVis":   "<base64 RLE>",   // 0/1 decorative variant flag
  "nodes": [[localIdx, kind], ...],     // resource nodes currently present
  "decor": [[localIdx, "key"], ...],    // static decor prop keys
  "bergs": [localIdx, ...],             // iceberg water tiles
  "digs":  [localIdx, ...],             // carved mine tiles (z=1) in this chunk
  "structs": [[localIdx, "kind", hp, dir, lvl], ...]  // player structures
}
```

`localIdx` is `(y - cy*64) * 64 + (x - cx*64)`, range `0..4095`.

`structs` entries are `[localIdx, kind, hp, dir, lvl]` — matching the legacy `init` tuple.
`dir` drives fence and decor orientation on the client and must not be dropped.

Omitted array fields mean empty. A chunk with no nodes may omit `"nodes"` entirely.

### 4.3 RLE encoding — normative

Each layer is 4096 bytes before encoding. Encode as a sequence of 2-byte runs:

```
byte 0: value
byte 1: run length, 1..255   (a run of 300 becomes 255 then 45)
```

Concatenate runs, then standard base64 (RFC 4648 §4, **with** padding).
Decoding MUST produce exactly 4096 bytes; a client that decodes a different length must
treat the chunk as corrupt and ignore it rather than render garbage.

Terrain of this kind is highly uniform, so a typical ocean chunk is a handful of runs.

**`veins` is masked to land on the wire.** Worldgen populates `veins` from noise on every
tile including open ocean, which makes it high-entropy and, measured, **1376 of the 1568
bytes of an all-water chunk**. Ore is only ever reachable underground beneath land, so the
server sends `0` for `veins` on water tiles. The server retains the true value; this is a
wire optimisation only, and it cuts a typical ocean chunk to roughly 200 bytes.

Radius-2 windows are clipped at world edges — a corner spawn receives 9 chunks, not 25.

### 4.4 Mutation after the fact

Chunks are a *snapshot at send time*. Subsequent changes arrive as the existing incremental
messages (`build`, `node`, `dig`, `chit`, …) exactly as they do today. The client applies
them on top of its chunk cache. A chunk is never re-sent for a mutation.

---

## 4.5 The clock

The legacy server piggybacks `time`/`day` on the per-tick `cre` message. Slices 1 and 2 had no
creatures to carry it, so the clock was its own broadcast:

```jsonc
{ "t": "time", "time": 0.31, "day": 1 }
```

**Slice 3 removed that frame.** With creatures simulated, `cre` is sent once per tick again and
carries the clock exactly as the legacy server does (see §9.2). The client has always handled
both shapes, so nothing on the wire needs a compatibility window.

---

## 5. `pos` — movement

Unchanged in shape from the legacy server, and it keeps **all** the validation added in the
server-authoritative movement work:

- speed budget: `dt` (clamped to 1s) × `6.2` × `1.6` + `1.0` tiles
- collision mirroring the client's rules, z-aware; water passable at `z=0`
- layer changes gated by `zAnchor` — one mineshaft/shelter within 3.0 tiles of **both**
  endpoints — plus a 500 ms cooldown
- rejection → `{ t:'fix', x, y, z, b }`, throttled to one per 250 ms per player
- every server-side reposition opens a 1 s grace window suppressing the distance check

Porting this faithfully is mandatory; it is the security boundary for all other handlers,
since every range check anchors on `p.x/p.y`.

---

## 6. Test hook

`{ t:'warp', x, y, z, b }` — unvalidated placement, gated behind the
`HEARTH_ALLOW_WARP` environment variable, exactly as in the Node server. It broadcasts the
same `pos` shape a normal move does. **Off unless the env var is set.**

`test.mjs` depends on this; without it the suite cannot position a player.

---

## 7. Ports

| Service | Port |
|---|---|
| Node control plane | 8090 |
| **Go game server** | **8082** |
| Legacy Node game server (untouched, still runs) | 8081 |
| Vite dev client | 5173 |

---

## 8. Slice 2 — resources, construction, farming, chests

Slice 2 adds the gameplay handlers. Every one of them keeps the legacy Node
message shape, so a client that already talks to `:8081` needs no change beyond
the `init`/chunk work of Slice 1.

### 8.1 Client → server

| type | payload | notes |
|---|---|---|
| `gather` | `i, seq?, dx?, dy?` | 250 ms shared cooldown, range 2.5 |
| `craft` | `r` | station must be within 4 tiles |
| `build` | `i, kind, dir?` | range 6 |
| `dig` | `i, seq?, dx?, dy?` | `z=1` only, range 2, needs pick/spick |
| `plant` / `harvest` | `i, crop?` | range 2.5, on a `farmplot` |
| `furn` | `i, kind` | `z=1` (carved tile) or `z=2` (shelter room) |
| `torch` | — | `z=1`, on the player's own carved tile |
| `eq` / `wear` | `k` (or `null`) | must own the tool / gear |
| `use` | `k` | `medicine` throttled to one per 750 ms |
| `water` | — | 250 ms cooldown, adjacent water, cap 10 |
| `chest_open` / `chest_move` | `i, res?, n?` | same layer, range 2.5 |
| `atk` | `seq?, dx?, dy?` | 400 ms cooldown, `z=0` only |

`seq` is echoed on the resulting `act` and on the `node` / `dig` / `chit`
outcome, and correlates a request to its outcome for reconciliation and dedup
**only** — it is never a security token. An action the server refuses answers
`{ t:'actReject', seq, reason }` and emits **no** `act`.

The server derives the animation clip and the tool from authoritative state, not
from anything the client claims: a bush is always `punch`/`null`, a tree is
`chop`/`axe` only if the player owns an axe, and a dig reports `spick` whenever
the player owns one.

### 8.2 Server → client

`inv`, `msg`, `stat`, `hp`, `act`, `actReject`, `node`, `dig`, `build`, `sd`,
`crop`, `furn`, `torch`, `chest`, `mud`, `berg`, `boat`, `wave`, `win` — all
identical in shape to the legacy server. `stat` is
`{ "t": "stat", "hunger": <int>, "thirst": <int> }`: both values are `ceil()` of the
fractional simulation state, exactly as `Math.ceil(p.hunger)` in `server/index.js`. See §3.

### 8.3 Chunk overlay fields (extends §4.2)

A chunk is the snapshot every player-made change is layered onto, so it carries
the mutable overlays as well as the generated terrain. All are optional; an
omitted array means empty.

```jsonc
{
  "digs":    [localIdx, ...],                  // carved mine tiles (z=1)
  "torches": [localIdx, ...],                  // lit mine tiles
  "mud":     [localIdx, ...],                  // grass turned to mud by logging
  "removed": [localIdx, ...],                  // nodes harvested, awaiting respawn
  "brokenBergs": [localIdx, ...],              // icebergs smashed by a reinforced hull
  "structs": [[localIdx, kind, hp, dir, lvl], ...],
  "furn":    [[localIdx, kind, z], ...],       // chests, beds, mine/shelter decor
  "farms":   [[localIdx, crop, stage], ...],   // stage 0..2
  "mods":    [[localIdx, slot, kind, hp, dir], ...]  // modular building (§12)
}
```

`removed` lists tiles that still appear in the chunk's `nodes` array but are
currently harvested; the client must not draw them until a `{t:'node', hp:-1}`
respawn arrives.

### 8.4 Rules data

Recipes, node definitions, structure hit points, crops and the medic trade pools
live in **`shared/defs.json`**, which the Go server unmarshals at boot and the
JavaScript side consumes through the generated `shared/defs.js`. Neither side
hardcodes a cost or a hit-point total. Regenerate the wrapper with
`node tools/defs/gen-defs.mjs`; `--check` fails if it has drifted.

### 8.5 Persistence

The Go server writes one save file **per world** — `world.<worldId>.save.json` in
`HEARTH_SAVE_DIR` (default: the working directory), so the default setup writes
`gameserver/world.default.save.json`. Keying on `worldId` is what stops two worlds
in one process from clobbering each other; a single-world process may still pin one
path with `HEARTH_SAVE_PATH`. The server never touches `server/save.json`, which the
legacy server owns. The snapshot carries profiles, structures, digs, torches,
furniture, farms, chest contents, mud, felled-tree counters, broken icebergs and
node respawn timers. Two fields are stored as durations rather than absolute
clocks, because neither clock survives a restart: node respawns as milliseconds
remaining, and farms as ticks elapsed since planting.

---

## 9. Slice 3 — creatures, wildlife, weather, creature combat

All shapes are identical to the legacy server; this section exists so the Slice 3 surface is
enumerated in one place.

### 9.1 Client → server

No new message types. `atk` gains its creature/animal half: the handler now scans creatures
and then animals for the nearest target within **2.4** tiles and only falls through to
structure demolition when it finds none.

- `act.targetI` carries the struck creature or animal id (e.g. `"c12"`, `"a3"`), or `null` on
  a miss. It was always `null` in Slices 1-2.
- A landed, non-lethal hit emits `chit`; a killing blow does not. `act` fires either way.

### 9.2 `cre` — the per-tick world frame

Broadcast once per tick whenever at least one player is connected:

```jsonc
{
  "t": "cre",
  "c": [ ["c12", 640.25, 641.00, "crawler"] ],   // id, x, y, type
  "a": [ ["a3", 182.50, 179.75, "deer"] ],       // id, x, y, species
  "time": 0.3141, "day": 2
}
```

Positions are rounded to 2 decimal places and the clock to 4, matching the legacy
`+v.toFixed(n)`. Both arrays are emitted in **spawn order**, not map order (see §9.6).

Creature types: `crawler`, `stalker`, `brute`, `wisp`, `husk_wolf`, `bog_shambler`,
`frost_wraith`, `drowned`, `blight_lancer`.
Wildlife species: `deer`, `boar` (Woods), `lizard`, `crab` (Dunes), `fox`, `hare` (Spire),
`toad` (Marsh).

### 9.3 Combat and creature-driven frames

| Message | Direction | Meaning |
| --- | --- | --- |
| `chit` | broadcast | `{ id, ang, by, seq }` — a creature or animal took a non-lethal hit. `ang` points away from the attacker (the knockback direction); `by` + `seq` correlate it to the attacker's `act`. |
| `hp` | to one player | Gains an `ang` field when the damage came from a creature: the direction to shove the player. |
| `slow` | to one player | `{ ticks: 30 }` — the frost wraith's chilling touch. |
| `ctel` | broadcast | `{ id }` — a brute or bog shambler has begun its 8-tick telegraph windup. |
| `shot` | broadcast | `{ fx, fy, tx, ty }` for the brute's blight bolt, plus `kind: "lance"` for the blight lancer's beam. Coordinates rounded to 1 decimal. |
| `sd` | broadcast | Already in Slice 2; creatures now also drive it by gnawing structures. |

### 9.4 Weather

```jsonc
{ "t": "wx", "kind": "sandstorm" }   // or "rain", "snowstorm", or null to clear
```

Weather is a single global state, not per-region. A front starts with probability
`(TICK_MS/1000)/180` per tick — roughly one every 180 s — and lasts 45-90 s. What differs per
biome is who it hurts:

- `rain` (Woods / Marsh) — cosmetic on the server; the client draws it.
- `sandstorm` (Dunes) — 1 hp per 5 s on `SAND` unless *any* structure is within 2 tiles.
- `snowstorm` (Spire) — 1 hp per 5 s on `SNOW` unless a **campfire** is within 6 tiles. A fur
  cloak does not help; that is what separates a blizzard from ordinary cold.

Being underground or indoors (`z != 0`) shelters from all of it. "Blizzard" is the client's
name for `snowstorm`, and ambient snowfall is a permanent client-side particle layer in the
Spire biome — neither is a distinct server state.

### 9.5 Corruption

```jsonc
{ "t": "infect", "tiles": [820481] }
{ "t": "cure",   "tiles": [820481] }
```

Wisps corrupt the ground they drift over (every 25 ticks), and both wisps and frost wraiths
corrupt on being hit and on death; a bog shambler corrupts its own tile plus the four
orthogonals when it dies. Every corrupted tile cures itself after **120 s**. Corrupted tiles
also breed crawlers: a low spawn roll places a crawler on a random infected tile instead of at
the Core.

`init` continues to carry the current `weather` kind and the full `infected` tile list.

### 9.6 Iteration order is part of the protocol

Go randomises map iteration where the JS reference walks a `Map`/`Set` in insertion order, and
several rules resolve ties by "whichever came first". Every such site iterates an explicitly
ordered slice instead of the map, so behaviour is reproducible across runs:

| Ordered mirror | Decides |
| --- | --- |
| `creOrder` | the `cre` array order, the `atk` target scan, wisp/wolf population counts, husk-wolf pack-link, pack enrage, dawn despawn |
| `aniOrder` | the `cre` array order, the `atk` target scan, the wildlife movement pass |
| `playerOrder` | which player a creature targets or damages first, and which player a spawn is biased toward |
| `infOrder` | which infected tile breeds a crawler, and the `cure` payload order |
| `structIndices()` | which structure a brute walks to (ascending tile index; memoised per tick) |

## 10. Slice 4 — the medic NPC, endgame progression, waves, dev tooling

All shapes are identical to the legacy server. This section enumerates the last of the
gameplay surface, and it closes the protocol: after Slice 4 there is no message type in
`server/index.js` that the Go server does not answer.

### 10.1 Client → server

| Type | Fields | Meaning |
| --- | --- | --- |
| `medic` | `medicId`, `action`, `offerId?` | interact with a medic; `action` is `inspect`, `accept` or `decline` |
| `usecore` | `i` (0-3) | spend one Monolith Core to awaken monolith `i` |
| `dev` | — | grant the F9 dev kit (gated, §10.6) |
| `devcmd` | `cmd`, plus per-command fields (§10.6) | run one F10 tester-panel command (gated) |

`medicId` is the stable, seed-derived id `medic-woods` or `medic-spire`. `offerId` is opaque
and server-minted; a client must echo back exactly the `offer.id` it was given.

`usecore.i` must be a JSON integer in 0..3. The legacy handler indexes its arrays with the raw
value — harmless in JS, where a bad index merely misses — so the Go port validates the type
instead of indexing a real array with it. Same for `devcmd cmd:"mono"`.

### 10.2 The medic bargain

Two medics exist per world, both deterministic functions of the seed
(`shared/world.js findMedicSpawns`): one on the Woods, one on the Frozen Spire. **Both are sent
to the client in `init.medics` (§3)** — the client no longer derives them, because on the Go
path it never generates the world. A medic's own
tile and its hut tile are permanently blocked — they cannot be walked through, built on,
harvested, or pathed over by creatures — so a medic can never be attacked or buried.

The state machine holds **at most one live offer per player**:

```
                 inspect (injured, in range, out of combat)
   no offer  ─────────────────────────────────────────────►  live offer
      ▲                                                       │  │  │
      │  decline / accept / 60 s expiry                       │  │  │
      └───────────────────────────────────────────────────────┘  │  │
                                                                 │  │
              inspect again ── same offer id, smaller expiresInMs ┘  │
              accept, paid in full ── medicResult ok, healed to MAX_HP┘
```

Server → client:

```jsonc
// inspect succeeded, or decline cleared the offer (offer: null)
{ "t": "medicOffer", "medicId": "medic-woods", "hp": 3, "maxHp": 10,
  "offer": { "id": "lkyj7a:1", "medicId": "medic-woods",
             "resource": "fiber", "amount": 4, "expiresInMs": 57300 } }

// accept succeeded
{ "t": "medicResult", "ok": true, "medicId": "medic-woods",
  "paid": { "resource": "fiber", "amount": 4 }, "hp": 10, "healed": 7 }

// anything refused
{ "t": "medicResult", "ok": false, "medicId": "medic-woods", "reason": "in-combat" }
```

The offer's own `createdAt` and owning player id are never sent. `expiresInMs` is relative and
is recomputed on every send, so a repeat `inspect` returns the same `id` with a **smaller**
`expiresInMs` — a client that sees it grow has hit a reroll bug.

Timings and radii, all from `server/index.js` and docs/05 §3:

| Constant | Value | Effect |
| --- | --- | --- |
| offer TTL | 60 s | after which the offer is dead and `accept` answers `offer-expired` |
| reroll delay | 20 s | applied after an expiry **or** an explicit `decline` |
| combat lockout | 5 s since `lastDamageAt` | any medic frame answers `in-combat` |
| spam floor | 200 ms per player | extra frames are dropped with no reply at all |
| interaction range | 2.5 tiles | Euclidean, from the medic's tile |

Rejection reasons, in the order the server checks them — the earlier ones therefore win even
when a later one also applies:

| `reason` | Cause |
| --- | --- |
| `unknown-medic` | `medicId` is not one of the world's medics |
| `wrong-level` | the player is underground or inside a shelter (`z != 0`) |
| `too-far` | further than 2.5 tiles |
| `in-combat` | took combat damage in the last 5 s |
| `offer-mismatch` | `accept` with no offer, the wrong `offerId`, or the other medic's offer |
| `offer-expired` | `accept` on an offer past its 60 s TTL |
| `dead` | `hp <= 0` |
| `full-health` | `hp >= MAX_HP` — a healthy player is never handed an offer, or charged |
| `insufficient-resource` | the player holds less than `offer.amount` of `offer.resource` |
| `rate-limited` | `inspect` inside the 20 s reroll delay |

**Environmental damage does not arm the combat lockout.** Snow, desert heat, thermal water,
starvation and weather all chip 1 hp without stamping `lastDamageAt`. If they did, the Spire
medic would be permanently unreachable without the very Fur Cloak a player would be visiting
them to survive without.

**Payment is atomic.** The three conditions under which healing could be a no-op — dead,
already full, cannot afford — are all checked *before* the resource is deducted, and nothing
between the check and the deduction can change player state (the room is single-goroutine). So
a player is never charged without being healed, and never healed without being charged.
Treatment always restores to `MAX_HP`, whatever the missing amount.

Offers are drawn from `MEDIC_TRADE_POOLS[islandId]` in `shared/defs.json` — a weighted list of
`{resource, min, max, weight}` — by cumulative weight, with the amount uniform over
`[min, max]`. A player's offer and reroll timer are discarded when they disconnect.

### 10.3 Progression

| Rung | Gate | Enforced by |
| --- | --- | --- |
| Aether Forge | `RECIPES.forge.station == "workbench"` | the ordinary `craft` station check |
| Monolith Core | `RECIPES.core.station == "forge"` | same |
| Awaken a monolith | `usecore` within **3** tiles of `MONOLITHS[i]`, holding a Core, monolith not already lit | `usecore` |
| World Engine | `RECIPES.engine.station == "forge"`, built **only** on `ACTIVATION_I` (the Core dais), **only** with all four monoliths lit | `build` |

A successful `usecore` broadcasts `{"t":"mono","i":i}` and charges one `core`. `init` carries
the full `mono` array and `won`.

Lighting a monolith raises `strength = 1 + (monoliths lit)`, which the Slice 3 spawn gates
read: brutes need `strength >= 3`, blight lancers `>= 2`, and the population cap is
`2 + strength` by day / `6 + 3*strength` at night. Progress makes the world harder immediately.

Refused Engine builds answer with `msg`, not a rejection type:

- off the dais — `The World Engine must be built on the activation dais at the temple heart.`
- monoliths unlit — `All 4 Monoliths must be awakened first.`

### 10.4 The final assault

Placing the Engine arms a four-minute wave and broadcasts `{"t":"wave","secs":240}`. The client
counts down locally; the server sends no further ticks.

While a wave is live:

- the creature cap jumps to **20** (from `2 + strength` / `6 + 3*strength`),
- every creature targets the Engine tile instead of a player,
- a creature within **1.6** tiles gnaws the Engine every 5th tick for 1 damage, or 3 for a
  brute or bog shambler,
- a blight lancer's beam does **20** to the Engine rather than vaporising it outright, which is
  the only structure that survives a beam at all.

Four things end a wave, and all four broadcast `{"t":"wave","secs":0}` so the client's
countdown stops:

| Ending | Extra broadcast |
| --- | --- |
| the timer runs out | `{"t":"win"}`, and `won` latches true |
| a creature gnaws the Engine down | `msg` `THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again.` |
| a lancer beam finishes the Engine | the same `msg` |
| a **player** demolishes their own Engine with `atk` | `msg` `You destroyed your own World Engine!` |

`won` zeroes the creature cap for good and stops the nightly Blight Storm erosion of wooden
structures. It is persisted, so a won world stays won across a restart. A destroyed Engine
leaves `won` false: rebuild it and the four minutes start again.

### 10.5 Ordered mirrors (extends §9.6)

Slice 4 adds no ordered mirror, and that is deliberate rather than an omission. `medicOffers`
and `medicRerollAt` are keyed by session id, hold at most one entry per player, and are never
iterated — no outcome can depend on their order, so mirroring them would be dead weight. `mono`
is a fixed four-element array and `wave` is a single struct.

### 10.6 `dev` / `devcmd` — gating

**The legacy server gates both on a process-wide `DEV` env var. The Go server does not.** One
Go process hosts rooms for many players, so a process-wide switch is either on for everyone in
every room or off for everyone. Per docs/09 §7, the authority is a **per-player claim in the
signed ticket** the control plane issues:

```jsonc
// ticket payload — `dev` is optional
{ "userId": "...", "worldId": "...", "instanceId": "...", "name": "...",
  "iat": 1757000000000, "exp": 1757000030000, "jti": "...", "dev": true }
```

The claim is verified offline with the rest of the ticket, so a client cannot grant itself the
tester panel. **There is exactly one rule:**

> `dev` present and `true` → dev tools on. Anything else — the key absent, `null`, or `false` →
> off.

The `HEARTH_DEV` env fallback that used to cover an absent claim is **gone**, along with
`room.Config.DevTools`. An operator flag that hands world-mutating commands to every connected
player has no place in production, and with `control/` minting the claim there is nothing left
for it to cover. `control/PROTOCOL.md` §2 is the contract: Node emits `dev` **only ever as
`true`** and omits the key entirely otherwise, so a ticket for an ordinary account is
byte-identical to the pre-`dev` format, and Go reads absent as false.

The permission itself is per-account and lives on the control plane: the `HEARTH_DEV_TOKS` /
`HEARTH_DEV_USERS` operator allowlist (`control/PROTOCOL.md` §3.3), never client input.

The claim is still decoded as a `*bool`, purely so a re-marshalled payload cannot manufacture a
claim that was never made. A `dev` field of any non-boolean type rejects the whole ticket as
`bad-json` rather than being coerced — there is no path by which a malformed claim becomes a
spurious `true`. Covered by `auth.TestVerifyDevClaim` / `TestVerifyDevClaimWrongType` and
`room.TestDevGateIsTicketClaimOnly`, and end to end by the DEV stage of
`gameserver/test-go.mjs`, which asserts both commands are refused and mutate nothing.

**Both sides of the gate are under test.** `gameserver/room/dev_test.go` drives every command
on a fixture with the claim granted and asserts the resulting room state field by field (the kit
contents, the teleport's chunk push, god mode surviving creature contact and the environmental
tick, one spawn per `creTypes` key, the respawn and its movement grace window, the strength gate
the monoliths move, the survival-tick branch each weather kind selects, the clamped clock) and
the same table with the claim absent, asserting nothing at all changed. The `DEVOK` stage of
`gameserver/test-go.mjs` repeats it over a real socket. That stage needs one dev-claimed and one
unclaimed ticket in the same run, which no single control-plane configuration can produce, so
the suite signs both itself against a pinned throwaway keypair — see its header for the env vars
the control plane must be started with.

A refused command answers with a `msg` toast. **These are no longer the legacy strings.** The
legacy text (`Dev mode is off — start the server with: npm run server:dev`) is wrong on this
path: `npm run server:dev` starts the *legacy* Node server on :8081 and sets the `DEV` env var
the Go server deliberately does not read, so a developer who followed it would see nothing change
and reasonably conclude the feature was never ported. The current strings point at the mechanism
that actually grants the claim:

- `dev` → `Dev tools off — your ticket carries no dev claim. Locally: npm run start:dev, then reconnect.`
- `devcmd` → `Dev tools off — no dev claim. Locally: npm run start:dev, then reconnect.`

`npm run start:dev` sets `HEARTH_DEV_ALL=1` on the control plane, which grants the claim to
loopback callers only (`control/PROTOCOL.md` §3.3); named accounts go through the
`HEARTH_DEV_TOKS` / `HEARTH_DEV_USERS` allowlist. Either way the claim is baked into the ticket
at join time, so a reconnect is required — hence "then reconnect". A client that reads
`init.dev` (§3) never has to see these strings at all.

### 10.7 `devcmd` commands

| `cmd` | Fields | Effect |
| --- | --- | --- |
| `tp` | `x`, `y` (both JSON numbers) | teleport to `(x, y)` on the surface, boat cleared; broadcasts `pos`, sends `hp`, and **pushes chunks** |
| `mono` | `i` (0-3) | light monolith `i` if unlit; broadcasts `mono`, and announces the Engine when the fourth closes the set |
| `god` | — | toggle invulnerability: `godTick` heals the player to full at the top of every tick |
| `wx` | `kind` (`rain` \| `sandstorm` \| `snowstorm`, anything else clears) | force weather for 180 s; broadcasts `wx` |
| `time` | `v` (0..0.999) | set the world clock; the sim tick broadcasts it as usual |
| `spawn` | `type` (a `CRE_TYPES` key) | spawn one creature 4-8 tiles away with `strength`-scaled hp and **no home tile**, so it never disengages |
| `clearcre` | — | remove every creature |
| `kill` | — | clear god mode, respawn at bed/campfire/spawn with full vitals; **pushes chunks** |

Unknown `cmd` values are ignored silently, as in the legacy server.

The two chunk pushes are the only deviation from the legacy behaviour. The legacy server shipped
the whole map inside `init`, so a teleport needed no terrain; the Go server streams chunks, so a
tester who teleports without one lands in an empty world.

---

## 11. Hosting many worlds — routing and the allocation boundary

One `hearthd` process is one **instance**, and an instance hosts one or more **worlds**. Each
world is a `Room` with its own goroutine, its own state, its own overlays and its own save file.
Nothing mutable is shared between two rooms, which is what makes cross-world leakage impossible
rather than merely unlikely.

### 11.1 Routing

The control plane allocates and the ticket carries the result (`control/PROTOCOL.md` §1, §3.1):

```jsonc
{ "userId": "...", "worldId": "frontier", "instanceId": "inst-2", ... }
```

On a verified ticket the game server:

1. compares `instanceId` with its own. **A mismatch is refused** with
   `{ t:'authfail', reason:'wrong-instance' }`. The ticket is valid and correctly signed; it
   simply names a world some other process hosts, and serving it anyway would make allocation
   advisory. An empty `instanceId` never matches.
2. looks `worldId` up among the worlds it hosts; unknown → `authfail: unknown-world`.
3. hands the connection to that world's room. The socket holds a reference to exactly one room
   for its lifetime — there is no path by which a frame crosses worlds.

If the room cannot be produced (world build failed, process shutting down) the reason is
`world-unavailable`.

A client never picks its own binding: `POST /api/join` resolves the world server-side and signs
the result, and `GET /api/worlds` deliberately omits `instanceId`.

### 11.2 Which worlds does a process host?

Config, read once at boot, in the same shapes and the same precedence `control/store.js` uses —
so **one registry can configure both processes**, each taking the slice bound to its own
instance:

| Variable | Default | Meaning |
|---|---|---|
| `HEARTH_INSTANCE_ID` | `local` | which instance this process is |
| `HEARTH_WORLDS` | — | JSON array of `{worldId, seed, instanceId, ws, name}` records (`ws` ignored here) |
| `HEARTH_WORLDS_FILE` | `control/worlds.json`, found by walking up | the same JSON in a file |
| `HEARTH_WORLD_ID` / `HEARTH_WORLD_SEED` / `HEARTH_SEED` | `default` / `hearth-1` | the single-world fallback |
| `HEARTH_EAGER_WORLDS` | unset | build every world at boot instead of on first join |
| `HEARTH_SAVE_DIR` | working directory | where `world.<worldId>.save.json` files go |

First source yielding at least one entry wins. Entries whose `instanceId` is not ours are
skipped — they are someone else's worlds. A registry that names worlds but none of ours **fails
at boot**: that is a misconfigured process, not an idle one. A `worldId` must be
`[A-Za-z0-9._-]{1,64}`, because it names a save file.

With no configuration at all a process is instance `local` hosting one world `default` on seed
`hearth-1`, which is exactly the pre-multi-world behaviour the client and `test-go.mjs` expect.

### 11.3 Lazy by default

Worldgen is ~2-6s of CPU and hundreds of MB per world, so rooms are built **on first join**, not
at boot: a process configured with eight worlds would otherwise stall for a minute at startup
and hold every world resident even if nobody joins. The first player into a world pays the build
inside their handshake window (bounded at 45s); everyone after finds the room warm.
`HEARTH_EAGER_WORLDS=1` builds everything at boot instead, for operators who prefer a warm
process and a slower start.

Two simultaneous first-joins cannot build the same world twice: the room-manager entry is
published under a lock before the build starts, and the second caller waits on its completion
channel. That lock guards the *registry of rooms* only — never game state, which stays owned by
each room's own goroutine (see the contract at the top of `gameserver/room/room.go`).

Covered by `gameserver/hosting/*_test.go` (run them with `-race`) and end to end by
`node gameserver/test-multiworld.mjs`, which starts a control plane and a two-world game server
on private ports and proves routing, isolation and the `wrong-instance` refusal over the wire.

### 11.4 Admission — the player cap and one live session per identity

Routing (§11.1) decides *which* room; admission decides *whether*. Both rules below are resolved
on the room goroutine, in the `join` case of `Room.Run` — not in the socket layer and not in the
control plane, because only the room knows who is actually connected. Allocation is not
admission.

**The player cap.** A world admits at most `maxPlayers` concurrent players; the default is **4**,
the co-op target in `PLAN.md`. A refused client gets `{ t:'authfail', reason:'room-full' }` and
is closed — before `init`, before any chunk. It is a per-world setting carried in the same world
registry §11.2 describes, so one file still configures both processes (the control plane ignores
the field):

```jsonc
[{ "worldId": "frontier", "seed": "s2", "instanceId": "inst-2", "maxPlayers": 8 }]
```

| Variable | Default | Meaning |
|---|---|---|
| `maxPlayers` (per entry in `HEARTH_WORLDS` / `control/worlds.json`) | `4` | concurrent players in that world |
| `HEARTH_WORLD_MAX_PLAYERS` / `HEARTH_MAX_PLAYERS` | `4` | the same cap for the single-world fallback |

Absent, zero, negative or non-numeric all mean the default. A cap is never a promise about
*which* four: see takeover below.

**One live session per identity.** A duplicated browser tab shares `localStorage`, presents the
same `hearth-tok`, and is issued a ticket for the same `userId` — which used to put a second
copy of one player in the room. A second live session for an identity now **takes over**: the
old session is evicted and the new one is admitted.

```jsonc
{ "t": "kick", "reason": "replaced" }   // server -> the session being evicted
```

`kick` is sent to the evicted session and the socket is closed immediately after, so a client
must handle it wherever it handles a disconnect: show the reason ("you opened this world in
another tab"), and do **not** auto-reconnect on `replaced` — an auto-reconnect loop between two
tabs would evict each other forever. `reason` is an open string; unknown reasons should be
treated as a plain disconnect.

Takeover, not rejection, on purpose: rejecting the newcomer would lock a player out of their own
character after a browser crash or a dropped connection until the stale socket timed out, which
is a worse failure than the duplication it prevents.

Eviction runs the **same teardown a disconnect does** — profile snapshotted, player removed from
`players` *and* `playerOrder`, `pl` broadcast to everyone else — so nothing is lost and no ghost
is left in an ordered mirror (§9.6, §10.5).

**Ordering: takeover is resolved BEFORE the cap.** If a full room already holds one of your
sessions, your new connection is replacing a seat, not claiming another one, so it is admitted.
Checking the cap first would mean a player who crashed could never get back into the world their
own stale session is still sitting in.

**Scope.** The rule spans every room a process hosts: joining world B while still live in world A
evicts the world-A session (the identity registry is process-wide, beside the registry of rooms —
`gameserver/room/registry.go`). Across *instances* it is not enforced: that needs shared state
the control plane does not have yet, so two processes can still each hold one session for the
same identity.

Covered by `gameserver/room/admission_test.go`, `gameserver/hosting/hosting_test.go` and, over
the wire, by the ADMIT stage of `gameserver/test-go.mjs`.

---

## 12. Modular building — `buildmod`

Legacy `structures` is one entry per tile, which cannot hold a floor, two wall
edges, a roof, a fixture and a decor piece at once. Modules therefore have their
own store keyed **`tile:slot`**, and the two systems do not mix: a tile carrying
a legacy structure refuses modules, and vice versa.

Slots are `floor`, `wallNE`, `wallNW`, `roof`, `fixture`, `decor`
(`MODULE_SLOTS` in `shared/defs.json`). Each module kind declares a *category* in
`MODULES[kind].slot`; a `wall` kind may occupy either wall edge, every other
category names its slot exactly.

**Modules are not inventory items.** `MODULES[kind].cost` is spent straight from
the player's bag in building materials — the `MATERIALS` tier (`wood_planks`,
`stone_blocks`, `glass_pane`, ...), which are themselves ordinary crafted
recipes. Nothing about a module ever enters `INV_KEYS`.

### 12.1 Client → server

| type | payload | notes |
|---|---|---|
| `buildmod` | `i, kind, slot, dir?, seq?` | range 6, `z=0`, dir is 0 or 1 |

Placement is refused — with nothing charged — when the kind is unknown, the slot
does not fit the kind, the tile is water, a landmark, a medic hut or already
carries a legacy structure, the `tile:slot` is taken, the player is out of reach
or indoors, or the materials are not in the bag.

Modules are taken back down with the ordinary `atk` swing: an attack that finds
no creature and no legacy structure in range hits the nearest module within 2.4
tiles and refunds half its materials, mirroring structure demolition.

### 12.2 Server → client

```jsonc
{ "t": "mod",     "i": 1234, "slot": "wallNE", "kind": "mod_wall_stone", "hp": 40, "dir": 0 }
{ "t": "modhp",   "i": 1234, "slot": "wallNE", "hp": 22 }   // damaged, still standing
{ "t": "modd",    "i": 1234, "slot": "wallNE" }             // destroyed or demolished
{ "t": "modfail", "seq": 17, "why": "slot-occupied" }       // unicast to the sender only
```

`modfail` echoes the request's `seq` so the client clears that exact preview
instead of guessing. `why` is one of `unknown-module`, `bad-slot`, `bad-tile`,
`outdoors-only`, `too-far`, `water`, `blocked`, `tile-occupied`,
`slot-occupied`, `unsupported`, `cost`. It is advisory text for the UI — the authoritative fact
is simply that no `mod` broadcast followed.

Existing modules arrive with their chunk (§8.3 `mods`), never in `init`.

### 12.3 Wall edges and collision

A wall module does not fill its tile — it stands on one edge of it, so a player
can stand inside a room they have walled in. Each edge in the world has exactly
one owning tile:

	wallNE on tile (x,y)  is the edge between (x,y) and (x+1,y)
	wallNW on tile (x,y)  is the edge between (x,y) and (x,y+1)

The server refuses a `pos` that crosses a blocking edge (and snaps the client
back), and creature steering tests the same rule, so a walled enclosure keeps
wolves out as well as players. `mod_door` is a wall that does not block;
floors, roofs, fixtures and decor never block anything. The client renderer must
use the same convention or the ghost preview and the collision will disagree.

### 12.4 Support and cascade

One rule, enforced server-side on both placement and removal:

| slot | needs |
|---|---|
| `floor` | nothing — free-standing |
| `wallNE` / `wallNW` | nothing — a fence or a screen is a legitimate build |
| `roof` | a wall edge or a fixture **on its own tile** |
| `fixture` | a floor on its own tile |
| `decor` | a floor or a wall on its own tile |

Placement of an unsupported piece is refused with `unsupported`. Removal
**cascades**: destroying a piece takes down whatever it was holding up, repeating
until the tile is stable (pulling a floor strands the fixture, which strands the
roof), and every piece that falls refunds half its materials to whoever knocked
it down. The client mirrors the table to colour its ghost; the server decides.

### 12.5 Persistence

The snapshot carries `modules` as an object keyed `"tile:slot"` with
`{kind, hp, dir, owner}`. A load skips any entry whose key is malformed, whose
tile is out of bounds, or whose kind or slot no longer exists in the defs, so
rolling `shared/defs.json` back can never crash the server.

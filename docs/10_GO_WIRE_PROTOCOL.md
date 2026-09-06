# Go game server — wire protocol (Slice 1)

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
- Ticket valid → the server replies `init` (§3) and the session begins.

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
  "won": false, "maxHp": 10, "wornGear": null
}
```

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

## 4.5 `time` — clock

The legacy server piggybacked `time`/`day` on the per-tick `cre` message. Slice 1 does not
send `cre`, so the clock is its own broadcast, once per tick, only when a player is connected:

```jsonc
{ "t": "time", "time": 0.31, "day": 1 }
```

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
identical in shape to the legacy server.

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
  "farms":   [[localIdx, crop, stage], ...]    // stage 0..2
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

The Go server writes `gameserver/world.save.json` (override with
`HEARTH_SAVE_PATH`) and never touches `server/save.json`, which the legacy
server owns. The snapshot carries profiles, structures, digs, torches,
furniture, farms, chest contents, mud, felled-tree counters, broken icebergs and
node respawn timers. Two fields are stored as durations rather than absolute
clocks, because neither clock survives a restart: node respawns as milliseconds
remaining, and farms as ticks elapsed since planting.

# Go game server (`hearthd`) — Slices 1 and 2

Authoritative connection, terrain streaming, movement (Slice 1), and resource
gathering, crafting, construction, digging, farming, chests and structure
demolition (Slice 2). Implements `docs/10_GO_WIRE_PROTOCOL.md` and verifies the
tickets described in `control/PROTOCOL.md`.

Still **not** implemented (Slice 3): creatures and wildlife, creature combat,
weather, infection spread, the medic NPC, and monolith progression. The legacy
Node server (`server/index.js`, port 8081) is untouched and still runs.

## Packages

| Package | Owns |
|---|---|
| `world/` | bit-exact port of `shared/world.js` — **do not modify** |
| `proto/` | chunk RLE codec and the chunk-grid constants |
| `auth/` | offline Ed25519 ticket verification, boot-time pubkey fetch |
| `room/` | the simulation: the single-goroutine room loop, movement validation, chunk streaming |
| `net/` | the WebSocket edge: reader/writer goroutines, the `auth` handshake |
| `persist/` | the save seam (`Store` interface, no-op and JSON implementations) |
| `defs/` | loads `shared/defs.json`, the one source of truth for recipes, node/structure/crop data |
| `cmd/hearthd/` | the binary |

The concurrency contract is documented at the top of `room/room.go`. Short
version: **all game state is owned by the `Room.Run` goroutine and guarded by no
lock at all.** Socket goroutines only marshal frames onto a shared inbox and
drain a per-player buffered outbound channel. Sends to a player never block; a
client whose buffer fills is dropped, so a stalled client can never stall the
world tick.

## Running

```sh
# terminal 1 — the Node control plane (identity + tickets)
node control/index.js

# terminal 2 — the Go game server
cd gameserver
HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd
```

PowerShell equivalent for terminal 2:

```powershell
cd gameserver
$env:HEARTH_ALLOW_WARP = "1"; go run ./cmd/hearthd
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `HEARTH_GAME_PORT` | `8082` | listen port |
| `HEARTH_SEED` | `hearth-1` | world seed |
| `HEARTH_PUBKEY_URL` | `http://localhost:8090/api/pubkey` | where the ticket public key is fetched once at boot |
| `HEARTH_TICKET_PUBKEY` | — | base64 raw 32-byte Ed25519 key; when set, skips the fetch entirely |
| `HEARTH_ALLOW_WARP` | unset | enables `{t:'warp'}`, the unvalidated test-only teleport |
| `HEARTH_SAVE_PATH` | `world.save.json` (relative to the working directory) | persistence file |
| `HEARTH_NO_PERSIST` | unset | disables persistence entirely |
| `HEARTH_DEFS_PATH` | found by walking up for `shared/defs.json` | rules data |
| `DEV` | unset | shortens crop growth 30x (`GROW_DIV`), as in the legacy server |

The server never touches `server/save.json` — that file belongs to the legacy
Node server.

## Tests

```sh
cd gameserver
go build ./... && go vet ./... && go test ./...
```

Coverage worth knowing about:

- `proto/rle_test.go` — every layer of every one of the 400 `hearth-1` chunks
  round-trips encode → decode byte-identically at 4096 bytes, plus the run-split
  rule, base64 padding, and corrupt-payload rejection.
- `auth/ticket_test.go` — valid / expired / tampered / wrong-key, plus a golden
  ticket actually issued by `control/ticket.js` to prove the two
  implementations agree on what bytes are signed.
- `room/movement_test.go` — the speed budget, the dt clamp, `lastPosAt`
  advancing on reject, the fix throttle, collision, **water passable at z=0**,
  the remote-mineshaft `zAnchor` exploit, a legitimate descent, the z cooldown,
  fall damage, the warp grace window, and the slow-client drop.
- `room/chunks_test.go` — the 5×5 join push, dedup, boundary crossing, that
  chunk payloads decode back to the generated world, and that `veins` is masked
  to land on the wire while the server keeps the true value.
- `room/actions_test.go` — recipe station gating (including the 4-tile radius
  and forge-vs-workbench), server-derived action/tool for `gather` and `dig`
  against a lying client, crop growth timing under both `GROW_DIV` values, and
  chest transfers clamping so nothing is minted or destroyed.
- `room/persist_test.go` — structures, digs, torches, furniture, farms and chest
  contents survive a save/load round trip, and a corrupt save cannot make the
  room index a tile out of bounds.

## End-to-end smoke test

`smoke.mjs` starts nothing. Run it against an already-running control plane and
game server (both terminals above):

```sh
node gameserver/smoke.mjs
```

It performs the real join (`POST /api/join` → ticket → WS `auth` → `init` →
chunk receipt), decodes the RLE in JavaScript, and asserts the decoded tiles
match `genWorld('hearth-1')` from `shared/world.js`. It also checks that a
forged ticket gets `authfail` with no world data, that movement is validated,
and that crossing a chunk boundary streams new terrain. Exit code 0 means every
assertion passed.

## Protocol suite

`test-go.mjs` is the root `test.mjs` adapted to the Go front door: it joins
through the control plane, authenticates with a real ticket and consumes chunks
instead of a terrain-carrying `init`. The gameplay assertions are copied
verbatim wherever the behaviour is meant to be identical; the stages that need
Slice 3 log an explicit `skip`.

It needs a **freshly started** game server (harvested nodes take up to five
minutes to respawn, and the suite expects an untouched world):

```sh
node control/index.js                                  # terminal 1
cd gameserver && HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd   # terminal 2
node gameserver/test-go.mjs                            # terminal 3
```

## Rules data

Recipes, `NODE_DEF`, `STRUCT_HP`, `CROPS`, `DECOR_NONBLOCKING`, the inventory
key list and `MEDIC_TRADE_POOLS` live in **`shared/defs.json`**. The Go server
unmarshals it at boot; the client, the legacy server and `test.mjs` read the
same data through `shared/defs.js`, which is generated from it:

```sh
npm run defs          # regenerate shared/defs.js from shared/defs.json
npm run defs:check    # fail if the two have drifted
```

Nothing in `gameserver/` may hardcode a cost, a hit-point total or a respawn
timer.

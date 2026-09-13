# Go game server (`hearthd`) — Slices 1-4 (complete)

The full authoritative simulation, ported from `server/index.js`:

- **Slice 1** — connection and the signed-ticket handshake, terrain streaming,
  server-side movement validation.
- **Slice 2** — resource gathering, crafting, construction, digging, farming,
  chests, structure demolition.
- **Slice 3** — creatures and wildlife, creature combat, weather, wisp
  infection spread and decay.
- **Slice 4** — the medic NPC and its bargain state machine, monolith
  progression (`usecore`) and the World Engine gates, the four-minute final
  assault and victory, and the `dev` / `devcmd` tester tooling.

Implements `docs/10_GO_WIRE_PROTOCOL.md` and verifies the tickets described in
`control/PROTOCOL.md`. Every inbound message type in `server/index.js` is
answered. The legacy Node server (`server/index.js`, port 8081) is untouched
and still runs.

**Dev tooling gate.** `dev` and `devcmd` are gated on the signed `dev` claim in
the ticket and on nothing else: present and true means on, absent/false means
off (docs/10 §10.6). The control plane mints the claim from a per-account
allowlist (`HEARTH_DEV_TOKS` / `HEARTH_DEV_USERS`, `control/PROTOCOL.md` §3.3).
There is no `HEARTH_DEV` env var any more — a server-wide flag would have handed
world-mutating commands to every connected player.

**Many worlds per process.** One process is one *instance* and hosts one or more
worlds; the ticket's `worldId` picks the room and its `instanceId` must be this
process (docs/10 §11). See `hosting/` and the Environment table below.

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
| `HEARTH_INSTANCE_ID` | `local` | which instance this process is; a ticket for another instance is refused with `authfail: wrong-instance` |
| `HEARTH_WORLDS` | — | JSON array of `{worldId, seed, instanceId, ws, name}`, the same shape `control/store.js` reads; entries for other instances are skipped |
| `HEARTH_WORLDS_FILE` | `control/worlds.json` (found by walking up) | the same JSON in a file — one registry configures both processes |
| `HEARTH_WORLD_ID` | `default` | single-world fallback id |
| `HEARTH_WORLD_SEED` | `$HEARTH_SEED` | single-world fallback seed |
| `HEARTH_SEED` | `hearth-1` | world seed (single-world fallback) |
| `HEARTH_EAGER_WORLDS` | unset | build every hosted world at boot instead of on first join |
| `HEARTH_PUBKEY_URL` | `http://localhost:8090/api/pubkey` | where the ticket public key is fetched once at boot |
| `HEARTH_TICKET_PUBKEY` | — | base64 raw 32-byte Ed25519 key; when set, skips the fetch entirely |
| `HEARTH_ALLOW_WARP` | unset | enables `{t:'warp'}`, the unvalidated test-only teleport |
| `HEARTH_SAVE_DIR` | working directory | where `world.<worldId>.save.json` files are written |
| `HEARTH_SAVE_PATH` | — | pin the save file; single-world processes only, ignored (with a warning) when several worlds are hosted |
| `HEARTH_NO_PERSIST` | unset | disables persistence entirely |
| `HEARTH_DEFS_PATH` | found by walking up for `shared/defs.json` | rules data |
| `DEV` | unset | shortens crop growth 30x (`GROW_DIV`), as in the legacy server |

Each world saves to its own `world.<worldId>.save.json`, so the default setup
writes `gameserver/world.default.save.json` and two worlds can never clobber each
other. The server never touches `server/save.json` — that file belongs to the
legacy Node server.

### Hosting several worlds

```sh
cd gameserver
HEARTH_INSTANCE_ID=local HEARTH_WORLDS='[{"worldId":"default","seed":"hearth-1","instanceId":"local","ws":"ws://localhost:8082"},
                {"worldId":"frontier","seed":"seed-frontier","instanceId":"local","ws":"ws://localhost:8082"}]' go run ./cmd/hearthd
```

Give the control plane the same registry (it reads `HEARTH_WORLDS` /
`control/worlds.json` identically) and `POST /api/join {"worldId":"frontier"}`
binds a ticket to that world. Rooms are built lazily on first join — worldgen is
seconds and hundreds of MB, so a process does not pay for a world nobody is in;
`HEARTH_EAGER_WORLDS=1` builds them all at boot instead.

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
- `hosting/hosting_test.go` — registry parsing and instance filtering, the
  `wrong-instance` / `unknown-world` refusals, lazy creation building each world
  exactly once under eight concurrent first-joins (run with `-race`), per-world
  save files, and — the one that matters most — that a broadcast in one world
  never reaches a player in another.
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
verbatim wherever the behaviour is meant to be identical. **There are no `skip`
lines left, and none may be added** — a stage that cannot fail asserts nothing.

It needs a **freshly started** game server (harvested nodes take up to five
minutes to respawn, and the suite expects an untouched world):

```sh
rm -f gameserver/world.*.save.json                     # a run dirties the world
node control/index.js                                  # terminal 1
cd gameserver && HEARTH_ALLOW_WARP=1 go run ./cmd/hearthd   # terminal 2
node gameserver/test-go.mjs                            # terminal 3
```

Delete `world.default.save.json` and restart the server between runs: nodes near spawn
are on respawn timers afterwards, and a lit monolith would change creature
strength for the next run.

The suite's tickets carry no `dev` claim, so its `DEV` stage asserts that `dev`
and `devcmd` are refused and mutate nothing.

## Multi-world suite

`test-multiworld.mjs` starts its own control plane and game server on private
ports (8390/8382 by default), configures two worlds on this instance and a third
allocated elsewhere, and asserts over the wire that routing works, that a
broadcast in one world never reaches the other, and that a valid ticket for
another instance is refused with `authfail: wrong-instance`:

```sh
node gameserver/test-multiworld.mjs
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

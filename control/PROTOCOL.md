# Control-plane / Game-server wire protocol

This document is the contract the Go game server implements against. Node
(control plane) issues signed tickets; Go verifies them **offline**, with no
network call back to Node. If Node is down or slow, players must still be able
to connect — the ticket alone must be enough for Go to authorize a connection.

## 1. Endpoints (control plane, default port 8090, override via `CONTROL_PORT`)

### `POST /api/join`
Request body (JSON):
```json
{ "name": "Wanderer", "tok": "<client's localStorage['hearth-tok']>", "worldId": "default" }
```
- `tok`: required string, the client's persistent identity token (see
  `src/main.ts` around `localStorage.getItem("hearth-tok")`). Missing/non-string
  `tok` -> `400 { "error": "missing tok" }`. Truncated to 64 chars.
- `name`: sanitized exactly as `server/index.js`'s `hello` handler does:
  strip `[\x00-\x1f\x7f]`, trim, cap at 18 chars; if the result is shorter than
  2 chars, fall back to `"Keeper"`. A fallback never overwrites a previously
  saved name for that `tok`; a real name is treated as an explicit rename.
- `worldId`: **optional** string, a world the client would like to join (from
  `GET /api/worlds`). Missing, non-string, or unknown -> the default world (see
  §3). This is a *request*, not an assertion: the ticket always binds the world
  the control plane resolved, never the string the client sent.
- **Any other field in the body is ignored.** In particular `dev` is not read
  from the request at any point — see §3.3.

Response `200`:
```json
{
  "ticket": "<base64url payload>.<base64url signature>",
  "ws": "ws://localhost:8082",
  "worldId": "default",
  "name": "Wanderer"
}
```
`ws` and `worldId` are the *resolved* world's, and match the `worldId` /
`instanceId` inside the signed ticket. The client connects to `ws` and presents
`ticket`.

### `GET /api/worlds`
The player-facing world list — what a lobby UI renders.
```json
{
  "defaultWorldId": "default",
  "worlds": [
    { "worldId": "default", "name": "The Hearth", "seed": "hearth-1", "ws": "ws://localhost:8082" },
    { "worldId": "frontier", "name": "frontier", "seed": "seed-frontier", "ws": "ws://localhost:8083" }
  ]
}
```
Exactly these four fields per entry. `instanceId` is an internal allocation
detail and is deliberately **not** in this response; it reaches Go only through
the signed ticket.

### `GET /api/health`
Ops endpoint, unchanged in shape — the full registry including `instanceId`:
```json
{ "ok": true, "worlds": [ { "worldId": "default", "seed": "hearth-1", "instanceId": "local", "ws": "ws://localhost:8082", "name": "default" } ] }
```

### `GET /api/pubkey`
```json
{ "publicKey": "<base64, 32 raw bytes, Ed25519 public key>" }
```
Go fetches this **once at boot** (or on its own refresh schedule) and verifies
tickets against the cached key locally. Node being unreachable after boot must
never block a player from connecting — never design a per-connection call back
to this endpoint.

For pinning both processes to the same keypair in dev, set on the Node side:
`HEARTH_TICKET_PRIVKEY` / `HEARTH_TICKET_PUBKEY` (both base64, raw 32/32 bytes —
Ed25519 seed format for the private key is NOT used here; see `control/ticket.js`
`rawPrivateKeyToKeyObject`/`rawPublicKeyToKeyObject` for the exact DER wrapping
if you need to generate a compatible pair from Go or openssl). Without these
env vars, Node generates an ephemeral keypair at process start and publishes it
via `/api/pubkey` — fine for a single dev run, but the key changes every
restart, so anything cached across a Node restart must re-fetch it.

## 2. Ticket format — the security boundary

```
ticket := base64url(payload_json_bytes) + "." + base64url(signature_bytes)
```

- **Alphabet**: standard base64url per RFC 4648 §5 — `+`→`-`, `/`→`_`, and `=`
  padding is stripped entirely (not just made optional). Decoders must restore
  padding based on length before decoding.
- **Payload** (before base64url-encoding, this is exactly this JSON object,
  no extra whitespace requirements — Go should parse it as generic JSON):
  ```json
  {
    "userId": "u_<hex>",
    "worldId": "default",
    "instanceId": "local",
    "name": "Wanderer",
    "iat": 1767657600000,
    "exp": 1767657630000,
    "jti": "<opaque unique string>",
    "dev": true
  }
  ```
  All fields except `dev` are always present.

  **`dev` — optional boolean, the dev-tools claim.**
  - Type: JSON `true`. It is **only ever emitted as `true`**.
  - When the account does not hold the permission the key is **omitted from the
    payload entirely** — not `"dev": false`, not `"dev": null`. Tickets for
    normal accounts are therefore byte-identical to the pre-`dev` format.
  - **Go must read an absent `dev` as `false`.** A `*bool` that stays `nil` is
    fine as an internal representation, but there is no longer a
    "control plane did not say" state to fall back on: absent means the account
    is not a dev. Node never mints `"dev": false`, so if Go ever sees an
    explicit `false` it came from somewhere else — treat it as false too.
  - The claim is inside the signed payload, so tampering with it invalidates the
    signature. `dev`/`devcmd` must be gated on this value and nothing else; the
    `HEARTH_DEV` env fallback should now be removed (docs/09 §7, docs/10 §10.6).
  `iat`/`exp` are **milliseconds since Unix epoch** (JS `Date.now()`), not
  seconds. TTL is fixed at **30000 ms (30s)** — this is intentionally short;
  the ticket is meant to be consumed within seconds of issuance to open the
  WebSocket, not held.
- **What the signature covers**: the Ed25519 signature is computed over the
  **ASCII bytes of the base64url-encoded payload string** — i.e. the exact
  substring that appears before the `.` in the wire format, taken as raw
  ASCII/UTF-8 bytes. It is **NOT** computed over the decoded JSON bytes, and
  **NOT** computed over the whole `payload.sig` string. This mirrors how
  compact JWTs sign `base64url(header).base64url(payload)` — here there is no
  header, just the one payload segment.
- **Algorithm**: Ed25519 (`crypto/ed25519` in Go; Node's `crypto.sign(null, data, privateKey)` /
  `crypto.verify(null, data, publicKey, signature)`). Signature is the raw
  64-byte Ed25519 signature, base64url-encoded with no ASN.1 wrapping.

### Verifying a ticket in Go (step by step)
1. Split the ticket string on the **first** `.` into `payloadB64` and `sigB64`.
   (There is exactly one `.`; reject anything else as malformed.)
2. Base64url-decode `sigB64` (restore `=` padding as needed) → 64-byte signature.
3. Verify: `ed25519.Verify(pubKey, []byte(payloadB64), sig)` — note the message
   is the **base64url string bytes**, not the decoded JSON.
4. If verification fails, reject the connection.
5. Only after verification succeeds, base64url-decode `payloadB64` and
   `json.Unmarshal` it into the payload struct.
6. Check `exp` (ms since epoch) against current time; reject if expired. A
   30-second TTL means clock skew between Node and Go should be kept small;
   do not add extra grace period beyond what's operationally necessary.
7. Use `payload.userId`, `payload.worldId`, `payload.instanceId`, `payload.name`
   as the authenticated identity for the new WebSocket connection, and
   `payload.dev` (absent == false) as the sole authority for `dev` / `devcmd`.
   `payload.jti` is available if Go wants to defend against replay within the
   TTL window (e.g. an in-memory seen-set with a 30s+ expiry); Node does not
   track ticket usage itself, since it never sees the WebSocket connect.

### Public key transport
`GET /api/pubkey` returns `{ "publicKey": "<base64>" }` where the base64
decodes to exactly 32 raw bytes — the raw Ed25519 public key, no DER/SPKI
wrapping, no PEM. Go should `base64.StdEncoding.DecodeString` (standard
alphabet, not url-safe — this field is plain base64, unlike the ticket itself)
and pass the resulting 32 bytes directly as `ed25519.PublicKey`.

## 3. World registry and permissions (control-plane config)

Configuration only — Go never reads any of this. It matters to Go solely
because it determines the `worldId` / `instanceId` a ticket binds.

### 3.1 Worlds
The registry is a list of `{ worldId, seed, instanceId, ws, name? }`. Sources,
first one that yields at least one valid entry wins:

1. `HEARTH_WORLDS` — a JSON array, for containers with no writable file system.
2. `control/worlds.json` (override the path with `HEARTH_WORLDS_FILE`) — a JSON
   array, the normal way to host several worlds:
   ```json
   [
     { "worldId": "default",  "name": "The Hearth", "seed": "hearth-1",      "instanceId": "local",  "ws": "ws://localhost:8082" },
     { "worldId": "frontier", "name": "Frontier",   "seed": "seed-frontier", "instanceId": "inst-2", "ws": "ws://localhost:8083" }
   ]
   ```
3. The historical single-world env vars — `HEARTH_WORLD_ID`,
   `HEARTH_WORLD_SEED`, `HEARTH_INSTANCE_ID`, `HEARTH_GAME_WS`,
   `HEARTH_WORLD_NAME` — defaulting to
   `default` / `hearth-1` / `local` / `ws://localhost:8082`. This is what you
   get with no config at all, so an existing dev setup is unaffected.

`worldId` and `ws` are required per entry; `seed`, `instanceId` and `name`
default to `hearth-1`, `local` and the `worldId` respectively. Malformed or
duplicate entries are logged and skipped rather than taking the service down.

### 3.2 The default world
`HEARTH_DEFAULT_WORLD_ID` names the fallback; if unset (or naming a world that
is not configured) the **first entry in config order** is the default. A join
with a missing or unknown `worldId` resolves here.

### 3.3 The `dev` permission
Granted by an operator allowlist read once at boot:
- `HEARTH_DEV_TOKS` — comma-separated `tok` values, and/or
- `HEARTH_DEV_USERS` — comma-separated `userId` values.

An account matching either list gets `dev: true` in its ticket. There is no DB
and no admin UI yet, so this is the smallest mechanism that is still
*per-account* rather than server-wide; it is re-evaluated on every join and
stored on the profile record, so when a real users table lands only
`isDevGranted()` in `control/store.js` changes. `POST /api/join` never reads a
`dev` field from the request body — a client posting `{"dev":true}` gets an
ordinary ticket with no `dev` key (asserted in `control/test.mjs`).

#### `HEARTH_DEV_ALL` — the local-developer bypass
`HEARTH_DEV_ALL=1` grants `dev: true` to **any request whose TCP peer address is
loopback**, with no allowlist entry. It replaces the old `npm run server:dev`
(`DEV=1`) ergonomics: a developer gets the F9 dev kit / F10 tester panel from one
env var instead of copying `localStorage['hearth-tok']` out of devtools.

- **Scoped per request, not per bind.** The control plane listens on `0.0.0.0`
  because LAN play (`vite --host`) is supported, so the check is on
  `req.socket.remoteAddress`, never on the bind address. The developer on the
  same machine is covered; a LAN or remote player never is, even with the flag
  set.
- **Accepted addresses** — exact string match against `127.0.0.1`, `::1`, and the
  IPv4-mapped `::ffff:127.0.0.1` (case-insensitive). No prefix matching, so
  `127.0.0.1.evil.com` and friends do not pass. **`X-Forwarded-For`, `X-Real-IP`
  and any other forwarding header are ignored entirely** — they are
  client-written strings, and honoring one would make the bypass remotely
  reachable. Behind a real reverse proxy every request therefore looks like
  loopback to this server: do not put a proxy in front of it with the flag set.
- **Precedence: independent, ORed, never subtractive.**
  `dev = allowlisted(tok/userId) OR (HEARTH_DEV_ALL AND loopback)`. The allowlist
  keeps granting a named account from *any* address with the flag unset; the flag
  keeps granting loopback with an empty allowlist. Neither can revoke the other,
  and nothing here ever emits `dev: false` — the key is still simply omitted when
  neither source grants (§2).
- **Boot log.** With the flag set, the process logs exactly once at startup:
  `[control] HEARTH_DEV_ALL=1 — ANY client connecting from loopback (127.0.0.1/::1) will be issued dev privileges (F9 dev kit, F10 tester panel). Local development only; do not set this in production.`
- This is a **local-development affordance, not a production mechanism.** The
  per-account allowlist above is the production grant. Leave `HEARTH_DEV_ALL`
  unset anywhere real players connect.

## 4. What Node deliberately does NOT own
Node's profile store holds only `{ userId, tok, name, dev, createdAt, lastSeen }`
— account state, where `dev` is a permission, not a game setting.
Inventory, tools, gear, hp, hunger, thirst, x, y, and anything else about the
world are Go's exclusively — Node never reads or writes them, and the ticket
payload carries no such fields.

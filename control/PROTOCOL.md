# Control-plane / Game-server wire protocol

This document is the contract the Go game server implements against. Node
(control plane) issues signed tickets; Go verifies them **offline**, with no
network call back to Node. If Node is down or slow, players must still be able
to connect — the ticket alone must be enough for Go to authorize a connection.

## 1. Endpoints (control plane, default port 8090, override via `CONTROL_PORT`)

### `POST /api/join`
Request body (JSON):
```json
{ "name": "Wanderer", "tok": "<client's localStorage['hearth-tok']>" }
```
- `tok`: required string, the client's persistent identity token (see
  `src/main.ts` around `localStorage.getItem("hearth-tok")`). Missing/non-string
  `tok` -> `400 { "error": "missing tok" }`. Truncated to 64 chars.
- `name`: sanitized exactly as `server/index.js`'s `hello` handler does:
  strip `[\x00-\x1f\x7f]`, trim, cap at 18 chars; if the result is shorter than
  2 chars, fall back to `"Keeper"`. A fallback never overwrites a previously
  saved name for that `tok`; a real name is treated as an explicit rename.

Response `200`:
```json
{
  "ticket": "<base64url payload>.<base64url signature>",
  "ws": "ws://localhost:8082",
  "worldId": "default",
  "name": "Wanderer"
}
```

### `GET /api/health`
```json
{ "ok": true, "worlds": [ { "worldId": "default", "seed": "hearth-1", "instanceId": "local", "ws": "ws://localhost:8082" } ] }
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
    "jti": "<opaque unique string>"
  }
  ```
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
   as the authenticated identity for the new WebSocket connection.
   `payload.jti` is available if Go wants to defend against replay within the
   TTL window (e.g. an in-memory seen-set with a 30s+ expiry); Node does not
   track ticket usage itself, since it never sees the WebSocket connect.

### Public key transport
`GET /api/pubkey` returns `{ "publicKey": "<base64>" }` where the base64
decodes to exactly 32 raw bytes — the raw Ed25519 public key, no DER/SPKI
wrapping, no PEM. Go should `base64.StdEncoding.DecodeString` (standard
alphabet, not url-safe — this field is plain base64, unlike the ticket itself)
and pass the resulting 32 bytes directly as `ed25519.PublicKey`.

## 3. What Node deliberately does NOT own
Node's profile store holds only `{ userId, tok, name, createdAt, lastSeen }`.
Inventory, tools, gear, hp, hunger, thirst, x, y, and anything else about the
world are Go's exclusively — Node never reads or writes them, and the ticket
payload carries no such fields.

# Multiplayer Rooms And Scalable Architecture Guide

This document describes the target architecture for adding a start screen, named players, room creation/joining, multiple player-owned worlds, four-player room caps, in-game/global chat, single-active-session enforcement, Postgres persistence, Redis fanout/coordination, and reconnect/pod failover.

The current game is a single authoritative WebSocket server with one in-memory world:

- One `SEED`.
- One `world = genWorld(SEED)`.
- One set of mutations: structures, digs, torches, mud, removed nodes, monoliths, creatures, animals.
- One global `players` map.
- One JSON file: `server/save.json`.
- Browser identity comes from `localStorage` token `hearth-tok`.

The new architecture should preserve the most important property: gameplay remains server-authoritative.

## Goals

Product goals:

- Add a start screen before entering the game world.
- Let players set/display a name.
- Let players create worlds/rooms.
- Let friends join a room using room code, invite link, or room list.
- A new room creates a new deterministic world seed and persistent world state.
- Cap each active room to `4` players.
- Allow one player account/browser identity to create multiple worlds.
- Allow one player to be a member of multiple worlds.
- Allow only one active game session per player at a time.
- Prevent one player from opening two browsers/tabs and joining two separate active worlds simultaneously.
- Add in-game room chat and global chat fanout.
- Show player names above player rigs.
- Support reconnect after socket drop.
- Support pod/process failure: reconnecting players should land in the same room/world on a new process/pod.

Engineering goals:

- Keep room simulation authoritative.
- Avoid storing critical state only in process memory.
- Use Postgres for durable relational state, world snapshots, player profiles, room metadata, and optional chat history.
- Use Redis for active-session locks, room/pod routing, pub/sub fanout, reconnect leases, and ephemeral presence.
- Keep current protocol style initially: JSON over WebSocket.
- Migrate incrementally from the current single-world server.

## Recommended Architecture

```text
Browser
  |
  | HTTP: start screen, room list, create/join room
  | WS: game connection and chat
  v
API/Game Gateway
  |
  | Postgres: durable users, rooms, memberships, saves, optional chat history
  | Redis: active sessions, room ownership, pub/sub, presence, reconnect leases
  v
Game Room Runtime
  |
  | one authoritative room simulation per active room
  | deterministic world from room.seed + durable mutations
  v
Clients in same room
```

For the current repo, start as one Node process running:

- HTTP routes for lobby/start screen.
- WebSocket server for room/game connections.
- Postgres connection via `DATABASE_URL`.
- Redis connection.
- In-process room runtimes keyed by `roomId`.

Later, the same design can scale to multiple pods/processes.

## Core Concepts

### Player

A durable identity. Initially this can be anonymous browser-token based. Later it can become real login.

Suggested fields:

- `player_id`: stable server-generated id.
- `token_hash`: hash of browser token or auth subject.
- `display_name`: visible player name.
- `created_at`.
- `last_seen_at`.

Do not trust a raw client-provided name or token as the identity. The server should resolve/issue `player_id`.

### Room / World

A persistent world created by a player.

Suggested fields:

- `room_id`: stable opaque id or UUID.
- `owner_player_id`.
- `name`.
- `join_code`: optional short invite code.
- `seed`: deterministic world seed.
- `max_players`: default `4`.
- `visibility`: private/friends/public if needed.
- `created_at`, `updated_at`.
- `archived_at` optional.

A room can exist when nobody is connected. Its simulation is loaded when players join and saved while active.

### Room Membership

A player can belong to many rooms.

Suggested fields:

- `room_id`.
- `player_id`.
- `role`: owner/member.
- `joined_at`.
- `last_played_at`.

This supports multiple worlds per player while still allowing only one active game session.

### Active Session

A short-lived Redis lock saying one player is currently in one active game session.

```text
active_player:{playerId} = { roomId, connectionId, podId, expiresAt }
TTL: 30-90 seconds, refreshed by heartbeat
```

Rules:

- If no active session exists, player can join a room.
- If an active session exists for the same room and the reconnect token is valid, allow reconnect and replace socket.
- If an active session exists for a different room, reject join or require explicit disconnect of the previous session.
- Enforcement must be server-side.

### Room Runtime

Current global world state should become per-room state:

```js
class RoomRuntime {
  roomId;
  seed;
  world;
  spawn;
  players = new Map();
  nodeHp = new Map();
  removed = new Map();
  mudTiles = new Set();
  sectorChops = {};
  structures = new Map();
  mono = [false, false, false, false];
  creatures = new Map();
  animals = new Map();
  digs = new Set();
  torches = new Set();
  furn = new Map();
  brokenBergs = new Set();
  infected = new Map();
  weather = { kind: null, until: 0 };
  day = 1;
  time = 0.3;
  won = false;
  wave = null;
}
```

Every current module-level game variable in `server/index.js` should either move into `RoomRuntime` or become true infrastructure.

## Start Screen

The browser should start in a lobby/start screen, not immediately connect to the game world.

Start screen should support:

- Player name input/edit.
- Create room/world.
- Join by room code/link.
- List own rooms.
- List rooms the player has joined.
- Continue last played room.
- Show room capacity and online count.
- Show error if player is already active in another room.

Recommended flow:

1. Browser loads client.
2. Client resolves local token with server via HTTP or lobby WS.
3. Server returns `player_id`, display name, active session status, and room list.
4. Player creates or joins room.
5. Server validates room access and capacity.
6. Client opens game WebSocket with token and `roomId`.
7. Server loads/attaches room runtime and sends room-specific `init`.

## Protocol Changes

Current first message:

```json
{ "t": "hello", "tok": "..." }
```

New game hello:

```json
{
  "t": "hello",
  "tok": "browser-token-or-session-token",
  "roomId": "room_abc123",
  "clientId": "tab-connection-id",
  "resumeToken": "optional-reconnect-token",
  "name": "display name fallback"
}
```

Server reply:

```json
{
  "t": "init",
  "id": "player_123",
  "playerId": "player_123",
  "roomId": "room_abc123",
  "name": "Mira",
  "seed": "room-specific-seed",
  "x": 68,
  "y": 68,
  "time": 0.3,
  "day": 1,
  "players": [
    ["player_456", "Tavi", 72.1, 67.8, "axe", 0]
  ]
}
```

Use stable `playerId` for identity and names. Use connection/session ids only for sockets.

## Player Names Above Heads

Server stores and broadcasts display names.

Validation:

- Trim whitespace.
- Limit length, for example `2-18` visible characters.
- Reject control characters.
- Render as text, not HTML.

Protocol:

```json
{ "t": "pj", "id": "player_456", "name": "Tavi", "x": 72, "y": 67 }
{ "t": "name", "id": "player_456", "name": "Tavi" }
```

Client rendering:

```ts
others = new Map<string, {
  rig: Rig;
  label: Phaser.GameObjects.Text;
  tx: number;
  ty: number;
  z: number;
  name: string;
}>();
```

Update every frame:

```ts
label.setPosition(rig.x, rig.y - 58).setDepth(rig.depth + 1);
```

Hide labels for players on different z-layers.

## Room Capacity

Room cap must be enforced server-side.

Join check:

1. Resolve player identity.
2. Check active session lock.
3. Load room.
4. Count active players in room using Redis presence or room runtime.
5. If count >= `max_players` and player is not reconnecting to an existing slot, reject.
6. If reconnecting, replace old socket and keep slot.

Error:

```json
{ "t": "err", "code": "room_full", "s": "This world already has 4 active Keepers." }
```

## Single Active Game Session

Requirement: a player can own/join many rooms but actively play only one room at a time.

Use Redis:

```text
SET active_player:{playerId} {roomId, connectionId, podId} NX EX 60
```

Refresh on heartbeat:

```text
EXPIRE active_player:{playerId} 60
```

On clean disconnect, delete only if the value matches this connection. Use Lua or a compare-and-delete helper:

```lua
if redis.call('GET', key) == expectedValue then
  return redis.call('DEL', key)
end
return 0
```

Join behavior:

- Same player, same room, valid reconnect: allow reconnect and replace old socket.
- Same player, different room: reject with `already_active`.
- Optional UX: provide a "Disconnect other session" action.

## Reconnect Model

When a socket drops:

- Do not immediately remove the player from room simulation.
- Mark disconnected with a reconnect deadline, for example 60 seconds.
- Keep active session lock during the lease.
- If the player reconnects before deadline, reattach and send a fresh `init` or compact resync.
- If deadline expires, remove presence, release active lock, save profile/world state, and broadcast `pl`.

Resume token:

```json
{ "t": "resume", "token": "opaque-short-lived-token", "expiresIn": 60 }
```

Redis key:

```text
resume:{resumeToken} = { playerId, roomId, connectionId }
TTL: 60 seconds
```

## Pod / Process Failure Recovery

Minimum safe model:

- Save room state to Postgres every 15-30 seconds and on graceful shutdown.
- On pod death, lose up to the save interval.
- New pod loads latest snapshot from Postgres.
- Clients reconnect and receive fresh `init`.

Better model:

- Append important mutations to a durable event log.
- Periodically compact into snapshot.
- Replay events after last snapshot.

Use Redis for room ownership:

```text
room_owner:{roomId} = { podId, fence }
TTL: 10-20 seconds
```

Only one pod should simulate a room at a time. For stronger correctness, use fencing tokens:

```text
INCR room_owner_fence:{roomId}
room_owner:{roomId} = { podId, fence }
```

Postgres writes include the current fence so stale pods cannot overwrite newer state.

## Postgres Persistence

Postgres is the primary durable database from the start. Use it for players, rooms, memberships, player-room profiles, world snapshots, durable event logs, and optional chat history. Recommended Node driver: `pg`. Add a small query/helper layer rather than scattering SQL through gameplay code.

Suggested tables:

```sql
CREATE TABLE players (
  player_id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE rooms (
  room_id TEXT PRIMARY KEY,
  owner_player_id TEXT NOT NULL REFERENCES players(player_id),
  name TEXT NOT NULL,
  join_code TEXT UNIQUE,
  seed TEXT NOT NULL,
  max_players INTEGER NOT NULL DEFAULT 4,
  visibility TEXT NOT NULL DEFAULT 'private',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);

CREATE TABLE room_members (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  player_id TEXT NOT NULL REFERENCES players(player_id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  last_played_at INTEGER,
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE room_snapshots (
  room_id TEXT PRIMARY KEY REFERENCES rooms(room_id),
  version INTEGER NOT NULL,
  seed TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  saved_at INTEGER NOT NULL,
  fence INTEGER DEFAULT 0
);

CREATE TABLE player_room_profiles (
  room_id TEXT NOT NULL REFERENCES rooms(room_id),
  player_id TEXT NOT NULL REFERENCES players(player_id),
  profile_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, player_id)
);

CREATE TABLE chat_messages (
  message_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  room_id TEXT,
  player_id TEXT NOT NULL REFERENCES players(player_id),
  display_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
```

Room snapshot JSON can initially mirror `server/save.json`, minus player profiles. Store player inventory/position per room in `player_room_profiles`. For stronger recovery later, add a `room_events` table for durable mutation events between snapshots.

## Redis Responsibilities

Use Redis for ephemeral coordination and fanout, not durable game state.

Keys:

```text
active_player:{playerId} -> JSON { roomId, connectionId, podId }
room_owner:{roomId} -> JSON { podId, fence }
room_presence:{roomId} -> hash/set of active player sessions
connection:{connectionId} -> JSON { playerId, roomId, podId }
resume:{resumeToken} -> JSON { playerId, roomId, connectionId }
```

Pub/sub channels:

```text
chat:global
chat:room:{roomId}
room:{roomId}:events
player:{playerId}:control
```

## Chat Architecture

Implement room chat and global chat.

Client message:

```json
{ "t": "chat", "scope": "room", "body": "Need wood near camp." }
{ "t": "chat", "scope": "global", "body": "Anyone running Spire?" }
```

Server validation:

- Authenticated player.
- Active room session for room chat.
- Body length limit, e.g. 1-240 chars.
- Trim whitespace.
- Rate limit, e.g. 5 messages per 10 seconds.
- Render as text on client.

Broadcast:

```json
{
  "t": "chat",
  "scope": "room",
  "roomId": "room_abc",
  "from": "player_123",
  "name": "Mira",
  "body": "Need wood near camp.",
  "at": 1720000000000
}
```

For global chat: validate, optionally save to Postgres, publish to `chat:global`, and every pod subscribed to that channel sends it to connected clients.

## Create / Join Room Flows

Create room:

```http
POST /api/rooms
{ "name": "Mira's Hearth" }
```

Server:

1. Resolve player.
2. Generate `room_id`.
3. Generate `join_code`.
4. Generate seed.
5. Insert into `rooms`.
6. Insert owner into `room_members`.
7. Return room metadata.

Join by code:

```http
POST /api/rooms/join
{ "joinCode": "EMBER7" }
```

Server:

1. Resolve player.
2. Find room.
3. Add membership if allowed.
4. Return room metadata.

Actual play begins only after game WS `hello` for that room passes validation.

## Game WS Join Flow

1. Client connects WS.
2. Client sends `hello` with token, roomId, and optional resumeToken.
3. Server resolves player.
4. Server checks membership/access.
5. Server checks active player lock.
6. Server checks room capacity.
7. Server acquires/loads room runtime.
8. Server loads player room profile.
9. Server attaches player to runtime.
10. Server sends `init`.
11. Server broadcasts `pj` to that room only.

All existing gameplay broadcasts must become room-scoped.

## Refactoring Plan

### Stage 1: Wrap Single World In `RoomRuntime`

- Create `server/room-runtime.js`.
- Move world state and tick logic into a class.
- Keep one default room.
- Existing protocol still works.

### Stage 2: Add Room Id To Hello

- Support `hello { tok, roomId }`.
- If missing roomId, use default room for compatibility.
- Maintain `rooms = new Map<roomId, RoomRuntime>`.
- Scope broadcasts per room.

### Stage 3: Add Postgres

- Add players/rooms/memberships/snapshots/profile tables in Postgres.
- Replace `server/save.json`.
- Persist rooms and player-room profiles.

### Stage 4: Add Start Screen

- Lobby UI with create/join/list.
- Game starts after selecting room.

### Stage 5: Add Redis Sessions

- Active player lock.
- Room presence.
- Reconnect leases.
- Four-player cap enforcement across pods.

### Stage 6: Add Chat

- Room chat first.
- Global chat through Redis pub/sub.

### Stage 7: Multi-Pod Readiness

- Room owner locks.
- Fencing token.
- Reconnect-to-new-pod behavior.

## Suggested File Layout

```text
server/
  index.js
  db.js
  redis.js
  identity.js
  rooms.js
  sessions.js
  room-runtime.js
  room-manager.js
  chat.js
  protocol.js
  migrations/
    001_initial.sql

src/
  main.ts
  lobby.ts
  chat.ts
  ui.ts
  rig.ts
```

## Tech Choices

Recommended next stack:

```text
Fastify + ws + pg + redis
```

Why:

- `Fastify`: clean HTTP APIs and good performance.
- `ws`: already used and sufficient.
- `pg`: standard Postgres driver for durable relational persistence.
- `redis`: locks, TTLs, pub/sub, presence, reconnect leases.

Alternatives:

- Hosted Postgres providers: Render Postgres, Neon, Supabase, Railway, or AWS RDS.
- `Turso/libSQL + Redis`: SQLite-compatible hosted option, but no longer the primary recommendation for this project.
- `Colyseus`: room/matchmaking framework, useful but requires adapting current custom runtime.
- `uWebSockets.js`: faster sockets, not needed until `ws` is a bottleneck.
- `NATS`: good messaging, but Redis is still useful for TTL locks/presence.

Recommendation:

- Use Postgres + Redis from the start, even for a single Render service.
- Keep Redis for active sessions, presence, reconnect leases, room owner locks, and global chat fanout.
- Keep authoritative room simulation in memory; do not query Postgres on every movement/action tick.

## Tests To Add

- Create room creates unique seed and owner membership.
- Join by code works; invalid code rejects.
- Four distinct players can join; fifth rejects with `room_full`.
- Reconnect of one of four active players is allowed.
- Same player cannot join room A and room B simultaneously.
- Room A events do not broadcast to room B.
- Room snapshots persist and reload.
- Player profile is per-room.
- Room chat reaches only room players.
- Global chat reaches all connected players.
- Chat rate limit rejects spam.
- Socket reconnect restores same player/room.
- Process restart loads room snapshot from Postgres and lets clients rejoin.

## Risks

- Postgres adds a network dependency, so keep it out of the gameplay hot path. Use it for joins, saves, snapshots, profiles, room metadata, and optional chat history.
- Redis pub/sub is not durable; save important chat/events before publish if history matters.
- Room split-brain corrupts state; use Redis room owner locks and fencing before multi-pod deployment.
- Active session locks can linger after crash until TTL expires; keep TTL short and refresh by heartbeat.
- Saving only every 30 seconds can lose recent progress on pod death; add event log later if this is unacceptable.

## Definition Of Done

- Client opens a start screen before game connection.
- Player can create multiple rooms/worlds.
- Player can join multiple rooms over time.
- Player can actively play only one room at a time.
- Server rejects a second simultaneous active room for the same player.
- Room has max 4 active players.
- Room state is isolated from other rooms.
- Room state persists after all players leave.
- Player profile is stored per room.
- Names appear above player heads.
- Room chat works.
- Global chat fans out across connected players/pods.
- Reconnect restores same room session after socket drop.
- Pod/process death can be recovered by loading the room from Postgres persistent storage.
- Existing server-authoritative validation remains intact.

# Architecture & Asset Advisory

Advisory notes for implementers working from these guides against `../echoes-of-the-hearth`.
Rule of thumb for every item below: prefer changes that are data-driven, additive, and
server-validated. If a change touches `shared/world.js`, stop and read item 2 first.

## Architecture improvements (ordered by value / risk)

### 1. Manifest-driven asset preload (low risk, do first)
`src/main.ts` preloads ~49 sprites as hardcoded `this.load.svg(...)` lines. This pack adds
~118 more. Before integrating, refactor preload to iterate a single key→path→size table
(see `MANIFEST.md`). One loop, one data structure; adding an asset becomes a data edit,
not a code edit. Verify by loading the game and confirming zero missing-texture warnings.

### 2. Save/worldgen versioning (do BEFORE any MAP_EXPANSION work)
`genWorld(seed)` is deterministic; `server/save.json` implicitly assumes the current
generator. Any change to noise params, map size, or tile rules silently corrupts existing
saves. Add a `worldVersion` constant written into save.json and checked on load — refuse
to load (with a clear message) on mismatch. This is ~10 lines and makes the entire
MAP_EXPANSION_GUIDE safe to attempt.

### 3. Blight/weather tick cost vs. map expansion
Blight spread and storm erosion sweep tiles on the 10 TPS tick. At 320×320 this is fine;
the MAP_EXPANSION_GUIDE's larger ocean multiplies the swept area with mostly-inert water
tiles. Before expanding, switch the cellular-automata passes to a dirty-set (only tiles
adjacent to active Blight/wooden structures), or at minimum skip WATER tiles early.
Measure tick time before/after as the guide already instructs.

### 4. Profile persistence fragility
Profiles are keyed by a localStorage token (`hearth-tok`). Clearing browser storage loses
the character. Before investing in the MULTIPLAYER_ROOM guide's Postgres/Redis stack, add
the cheap fix: show the token in settings with copy/restore, or derive recovery from a
player-chosen name. The full room architecture is over-scaled for 4-player caps — stage
it: named players + rooms in-memory first, external storage only when needed.

### 5. Bird animation — use Phaser anims, not timers
Load the 3 frames as separate textures and register one `this.anims.create` per species
with frame order 1→2→3→2. Do not add per-entity `setTimeout`/tick timers; the existing
rig code in `rig.ts` already shows the procedural pattern for characters — birds are the
one place a texture-swap animation is simpler and cheaper.

### 6. Multi-tile landmarks and depth sorting
The game depth-sorts by screen Y. Mountains and core-temple pieces span multiple tiles;
anchor each sprite at its *southern-most footprint tile* so it sorts correctly against
players walking in front. Collision footprints belong in `shared/` data (both READMEs
already say this) so client and server agree — never client-only.

## Asset pack improvements

- **water_freezing / water_hot are visual-only.** Server gameplay uses its own water
  temperature data. When placing these tiles, drive them *from* the server data, not the
  reverse — otherwise visuals and damage zones drift apart.
- **Tile dimensions verified compatible.** All 5 `tiles/*.svg` here and the game's
  existing tiles (e.g. `grass.svg`) share `64×40` viewBox (64×32 iso diamond + 8px side
  face). Load new tiles with the same `{width, height}` as existing ones and no seams
  will appear. If you ever add a tile, keep this exact footprint.
- **Dedupe against `.feature-update/` in the game repo.** The repo already contains
  copies of birds/, core_temple/, and mountains/ sprites under `.feature-update/`. Pick
  ONE source of truth (this pack), delete or ignore the stale copies, and never load the
  same art under two keys.

## Guardrails for implementing agents

1. Never introduce `Math.random()` into placement or worldgen — determinism is load-bearing.
2. Every new interactable must be server-validated (distance + rate-limit) like existing actions.
3. After each change: `npm run build`, fresh server, `node test.mjs` (co-op smoke test),
   and load a saved world to confirm compatibility.
4. Keep Vite's `publicDir: 'assets'` and absolute `/sprites/...` `/tiles/...` paths — do not
   convert to relative imports.

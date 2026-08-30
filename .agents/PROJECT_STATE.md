# Project state — Echoes of the Hearth

**Last updated:** 2026-08-30 by the session recorded in
`session-context-dump/2026-08-30_1302__medic-seq-menu-logo.md`

This is the status source of truth. Update it in the same pass as any session dump.

---

## Verification status at last update

| Gate | Result |
|------|--------|
| `npx tsc --noEmit` | clean |
| `npx vite build` | green |
| `node test.mjs` | ALL TESTS PASSED (24 base stages + medic a–e + protocol G1–G5) |

---

## Shipped and working

### Core game
- Deterministic 1280×1280 worldgen, 4 major islands + Core + minor isles, `WORLD_VERSION = 4`.
- Three z-layers: surface, mine tunnels, shelter interiors.
- Survival loop: hunger, thirst, thermal damage, weather (rain / sandstorm / blizzard), day-night.
- Gathering, crafting (station-gated), building, digging, farming, chests, boats, swimming.
- Combat with 9 creature types including water-capable (`stalker`, `drowned`) and ranged
  (`brute` bolts, `blight_lancer` structure-destroying beams).
- Progression: 4 Monoliths → Aether Forge → Monolith Cores → World Engine → final assault.
- Persistence: `server/save.json` + per-player profiles keyed by `localStorage['hearth-tok']`.
- Dev tester panel (F10) — fast travel, monolith activation, god mode, instant death, spawn by
  category, weather and time control. F9 dev kit unchanged (dev-mode server only).

### Landed 2026-08-30
- **Medicine + Medic healing** — `medicine` consumable (heals 3, capped at `MAX_HP`), two
  deterministic medic NPCs (Woods + Spire) with a server-generated bargain system: 60s offer expiry,
  20s reroll delay, offer stability across repeat interactions, atomic pay-then-heal.
- **Medic huts** — decorative structure two tiles behind each medic; blocks movement client-side and
  building server-side.
- **Validated `seq`/`act` action protocol** — client attaches a monotonic `seq` to `gather`/`dig`/
  `atk`; the server validates, then *derives* action and tool from authoritative state, then
  broadcasts one `act`. `node`/`dig`/`chit` carry `by` + `seq`. Impact audio fires on server
  confirmation. `anim` survives only for the cosmetic jump, whitelisted.
- **Animation system** — `src/rig.ts` rewritten with a documented ONE WRITER RULE (only `tick(dt)`
  writes pose; no tweens, no setTimeouts). `torso.rotation` written exactly once, to 0, as an
  invariant. Boat sitting pose wired.
- **Menu shell** — Home / Create Room / Join Room / Profile / Settings, in `src/menu.ts` with
  `src/boot.ts` as entry. Phaser is lazy-loaded; the world does not boot until Join.
- **Quit to menu** — full Phaser teardown, socket close, `initUI()` singleton, DOM reset,
  re-join works cleanly.
- **Custom cursor** — `assets/sprites/cursor.svg` + `cursor_pointer.svg`.
- **Zoom fixes** — startup view clamp (was never applied until first mine entry) and Phaser
  `zoomTo` force flag. Mine zoom reduced 1.05 → 1.02.

---

## Deliberately deferred (owner's decision — do not start without asking)

- **Elevation rework** — `docs/ELEVATION_AND_WORLD_EDGE_GUIDE.md`.
- **Postgres/Redis room architecture** — `docs/MULTIPLAYER_ROOM_ARCHITECTURE_GUIDE.md`.
- **`docs/07_REMAINING_IMPLEMENTATION_ROADMAP.md`** — owner said to ignore new doc additions for now.

---

## Known gaps and rough edges

1. **Room codes are cosmetic.** The server hosts one shared world, so two players with different
   codes still land together. The Create and Join screens say this plainly — do not remove that note
   or imply isolation the backend cannot deliver. Making it real requires the deferred room
   architecture work.
2. **Settings toggles are stored but not wired.** `hearth-muted` and `hearth-shownames` persist to
   localStorage but are not plumbed into `src/audio.ts` / `src/ui.ts`. Mute already works in-game
   via the `M` key.
3. **`ui.ts` caches signature strings that survive a quit.** Quit with a medic offer open, rejoin,
   and if the server re-sends an *identical* offer the signature matches so `#medicPanel` stays
   hidden until the offer changes. Proper fix is a `reset()` in `ui.ts`.
4. **Two bare `setTimeout`s in gameplay code** (`src/main.ts`, `clearTint` calls) can fire after the
   game is destroyed. They only assign tint on a dead sprite and self-expire in under a second.
5. **Medic huts don't block creature pathing.** They block the player client-side and building
   server-side, but server-side creature AI walks through the footprint.
6. **Root `README.md` gameplay details are stale** — it says 192×192 map (actual 1280) and lists
   SPACE as attack (actual: F attacks, SPACE jumps). Worth a pass.

---

## Next work, in the order previously recommended

1. **Modular building system** — `docs/PLAYER_BUILDING_CUSTOMIZATION_GUIDE.md`. Floor/wall/roof/
   fixture/decor slots, `buildmod` protocol, support and cascade rules, slot-filtered ghost preview,
   bridge-over-water. This is the biggest remaining feature and the only one that unlocks the ~30
   unused `building_materials` assets. Needs care — it touches the build protocol and persistence.
2. **PLAN.md systems with zero code** — fire spread automata, water flow / trenches, blight
   evolution, convergence events, transport networks, Blighted Heart mini-dungeons, roles/classes.
   Fire spread and blight evolution were judged the highest value of these.
3. **Wire the Settings toggles** (small, self-contained).
4. **`ui.ts` `reset()`** to clear cached signatures on quit (small).

---

## Feature → file map

| Area | Files |
|------|-------|
| Worldgen (deterministic) | `shared/world.js` |
| Recipes, items, health constants, trade pools | `shared/defs.js` |
| Day cycle | `shared/time.js` |
| Authoritative server, all handlers, sim tick | `server/index.js` |
| Phaser scene, rendering, input, protocol client | `src/main.ts` |
| Player rig / animation | `src/rig.ts` |
| In-game DOM UI | `src/ui.ts` |
| Menu / lobby / profile / settings | `src/menu.ts`, `src/boot.ts` |
| Asset manifest | `src/assets.ts` |
| Procedural audio | `src/audio.ts` |
| All art | `assets/sprites/**` (SVG only) |
| Protocol test suite | `test.mjs` |
| Deep technical reference | `AGENT_GUIDE.html` |

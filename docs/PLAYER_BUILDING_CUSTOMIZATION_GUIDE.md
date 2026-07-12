# Player Building Customization Guide

Implementation guide for letting players craft and place **decorations, furniture, storage,
and farms** — both inside their shelter ("safe house", z-level 2) and in the outside world
(z-level 0). Written against the current code; verify line references before editing, they
drift.

Read `ARCHITECTURE_ADVISORY.md` first. The two hard rules from it apply to everything here:
**server is authoritative for every placement**, and **nothing here may touch
`shared/world.js` worldgen** (decor/farms live in the `structures`/`furn` maps, never in the
tile array — that keeps saves compatible and determinism intact).

---

## 1. What already exists (build on it, don't replace it)

The game already has two placement systems. All new customization slots into them.

### Exterior structures (z=0)
- Client sends `{t:'build', i, kind, dir}` (i = tile index `y*320+x`, dir for walls).
- Server (`server/index.js` ~305–346) validates: player distance ≤ 6 tiles, tile not
  `blocked()` (water/existing structure), inventory holds the crafted item, then decrements
  `p.inv[kind]`, stores in the `structures` Map (`i → {kind, hp, owner, dir?, lvl?}`), and
  broadcasts `{t:'build', i, kind, hp, dir, lvl}`.
- Walls stack to lvl 2, shelters to lvl 3; stacking increments `lvl` and adds HP.
- Client `addStruct()` (src/main.ts ~529) creates a sprite: texture key **is** the `kind`
  string, origin `(0.5, 0.92)`, `depth = screenY + 20`. Stacked levels get extra sprites
  offset by `STORY_OFF[kind]`.
- Build UI (src/ui.ts): recipes with `place:true` become click-to-place; ghost preview via
  `unIso()`, green/red by `blockedAt()` + distance, `R` rotates walls.
- Persistence: `structures` serialized into `server/save.json` every 30 s.

### Interior furniture (z=2)
- Client sends `{t:'furn', i, kind}`; server (~204–217) allows only kinds in the furniture
  set (currently chest/bed/torch), requires z===2, tile inside a shelter interior
  (Chebyshev distance ≤ `shelter.lvl` from the shelter anchor), distance ≤ 5, item in
  inventory. Stored in the `furn` Map (`i → {kind, owner}`).
- Interiors render as a flat floor square of radius `shelterLvl` (src/main.ts ~335).
- Beds set the respawn point (`respawnPoint()`, prefers own bed over campfires).

### Recipes (`shared/defs.js` ~15–37)
Shape: `{cost:{resource:amount}, station:'workbench'|'forge'|null, place:true, ...}`.
`STRUCT_HP` (~line 51) maps kind → hit points. The crafting panel and server validation
both read RECIPES — **one data edit adds a craftable item everywhere**.

### Not implemented (this guide adds them)
- **Farming**: no farmplot/crop/harvest code exists — only flavor text. Section 4 is a
  full new system.
- **Chest storage**: chests place and detect interaction but show a "coming soon" message.
  Section 5 completes them.

---

## 2. Data model: one new concept, two extensions

Add a `DECOR` category flag to recipes rather than a parallel system:

```js
// shared/defs.js — additions. decor:true → no HP bar, no collision, purely cosmetic.
// zone: 'out' | 'in' | 'both' controls where it may be placed.
banner:       { cost:{cloth:2, wood:1},  station:'workbench', place:true, decor:true, zone:'both' },
lantern:      { cost:{iron:1, resin:1},  station:'forge',     place:true, decor:true, zone:'both' },
stone_path:   { cost:{stone:2},          station:null,        place:true, decor:true, zone:'out'  },
flower_pot:   { cost:{clay:1, fiber:1},  station:'workbench', place:true, decor:true, zone:'in'   },
rug:          { cost:{cloth:3, fiber:2}, station:'workbench', place:true, decor:true, zone:'in'   },
trophy_antler:{ cost:{bone:2, wood:2},   station:'workbench', place:true, decor:true, zone:'in'   },
fence:        { cost:{wood:2},           station:null,        place:true, decor:true, zone:'out'  },
farmplot:     { cost:{wood:4, fiber:2},  station:null,        place:true },            // NOT decor — functional
```

Rules that keep this bug-free:

1. **Exterior decor goes in the `structures` Map** with `hp` from `STRUCT_HP` (give decor a
   low default, e.g. 5) so the existing damage/destroy path (`{t:'sd', i, hp}`) works
   unchanged. Do NOT invent a third map for exterior items.
2. **Interior decor goes in the `furn` Map** — just widen the allowed-kind set from
   `chest/bed/torch` to include `zone:'in'|'both'` decor. The furn path already has the
   interior-bounds check; reuse it.
3. **Zone enforcement is server-side**: on `{t:'build'}` reject `zone:'in'` kinds; on
   `{t:'furn'}` reject `zone:'out'` kinds. Client greys them out in the UI too, but the
   client check is cosmetic — never trust it.
4. **Decor never blocks movement** — exclude `decor:true` kinds from `blocked()` so paths,
   rugs, and banners don't create invisible walls. `fence` is the deliberate exception:
   leave it blocking (that's its purpose) but keep it `decor:true` for the no-HP-bar UI.
5. **Ownership**: keep writing `owner: id` on every placement. Then add ONE new rule:
   only the owner (or any player, your call — decide once, document it) may demolish
   decor. Griefing in co-op is otherwise free.

## 3. Protocol: no new message types needed for decor

`{t:'build'}` and `{t:'furn'}` already carry `i` + `kind`. Extend, don't add:

- Add optional `dir` support beyond walls: banners/fences look better with 2 facings.
  The field already exists in the message and the store; just stop hard-coding
  "walls only" in the rotate handler (ui.ts `R`-key, ~line 143) — allow any kind with a
  new `rot:true` recipe flag.
- Save compatibility: old saves deserialize into the same two Maps; unknown-kind guards
  should already be tolerated, but add one defensive line on load — skip entries whose
  `kind` is no longer in RECIPES — so a rollback of defs.js never crashes the server.

Client rendering needs two small changes in `addStruct()` / the furn renderer:
- Ground-flat decor (`stone_path`, `rug`) must render **under** entities: use
  `depth = screenY - 8` and origin `(0.5, 0.5)` instead of the standing-sprite defaults.
  Add a `flat:true` flag in the recipe and branch on it — do not special-case kind strings
  in the renderer.
- Everything else uses the existing standing-sprite path unmodified.

## 4. Farming (new system — the biggest piece)

Design goal: fits the existing tick/broadcast architecture, zero new render tech.

### Data
```js
// shared/defs.js
CROPS = {
  wheat:    { seedCost:{fiber:2},        growTicks: 3600, yield:{grain:3},  tile:['GRASS'] },
  glowcap:  { seedCost:{glow_mushroom:1},growTicks: 5400, yield:{glowcap:2},tile:['MUD','GRASS'] },
  frostroot:{ seedCost:{fiber:3},        growTicks: 7200, yield:{frostroot:2}, tile:['SNOW'] },
}
// growTicks at 10 TPS: 3600 = 6 real minutes. Tune later via SMALL_IMPROVEMENTS workflow.
```

### Server
- `farmplot` is a normal structure (build path unchanged). Add a `farms` Map:
  `i → {crop, plantedTick, owner, watered?}` — separate from `structures` so a farmplot
  with no crop is just a structure.
- New messages (the one place new protocol IS warranted):
  - client `{t:'plant', i, crop}` — validate: farmplot exists at `i`, no crop growing,
    biome tile is in `CROPS[crop].tile`, player within 6, has seedCost; deduct, set
    `plantedTick = tick`, broadcast `{t:'crop', i, crop, stage:0}`.
  - client `{t:'harvest', i}` — validate grown (`tick - plantedTick >= growTicks`),
    within 6; add `yield` to `p.inv`, clear the farm entry, broadcast `{t:'crop', i, crop:null}`.
  - server broadcasts `{t:'crop', i, crop, stage}` on each stage change only (see below).
- **Growth on the world tick — but cheaply.** Do NOT scan farms every tick. Quantize to
  3 stages (0 sprout / 1 growing / 2 ready): on each tick, check only every 50th tick
  (`tick % 50 === 0`), loop the `farms` Map (it's small — player-created only), compute
  `stage = min(2, floor(3*(tick-plantedTick)/growTicks))`, broadcast only when the stage
  changed. This follows the dirty-set principle from the advisory.
- **Hazard coupling (optional, recommended):** during rain, crops on stage < 2 advance
  25% faster; during sandstorm/blizzard, unsheltered crops (no wall within 1 tile) lose
  progress. Both are one-line multipliers inside the existing weather branch — do not
  build a new weather system.
- Persist `farms` in save.json exactly like `structures` (`[...farms]`). Store
  `plantedTick` relative to the saved global tick so reload doesn't insta-grow crops.

### Client
- Farmplot sprite: base `farmplot` texture. Crop overlay: one extra Image on top keyed
  `${crop}_${stage}` with fallback to a single `crop` texture tinted by stage if per-stage
  art doesn't exist yet (ship with the tint fallback; art can come later).
- Interact (`E`) on a farmplot: no crop → open a tiny crop-picker (reuse the crafting
  panel's list component in ui.ts); stage 2 → send `{t:'harvest'}`; else show progress %
  in the tooltip.

### Asset mapping (this pack)
- `raw_fiber_bundle`, `raw_clay` already exist for costs. For crop stages, commission or
  request three-stage sprites later (`wheat_0/1/2.svg`, same footprint as `crop.svg` in
  the game repo). `cactus_bloom` and `glow_mushroom` from this pack can serve as exotic
  "planted" visuals immediately.

## 5. Finish chests (storage)

Smallest slice that's real storage, no UI rewrite:
- Server: `chestInv` Map `i → {slots:{resource:count}}`, created on chest placement,
  persisted like the others. Messages: `{t:'chest_open', i}` → server replies
  `{t:'chest', i, slots}`; `{t:'chest_move', i, res, n}` where negative n = withdraw —
  server clamps against both inventories atomically and re-broadcasts `{t:'chest', ...}`
  to ALL players (co-op shared stash: two players may have it open at once; broadcast,
  don't reply unicast, or the second player's view goes stale).
- Client: reuse the inventory panel component in ui.ts side-by-side. The interact hook
  already exists (src/main.ts ~638 currently prints the placeholder message) — replace
  the message with `{t:'chest_open'}`.
- Validation: distance ≤ 2 on every chest message; reject moves of resources the sender
  doesn't have. Never let the client compute resulting counts.

## 6. Implementation order (each step ships alone, game stays playable)

| Step | Scope | Risk gate before moving on |
|---|---|---|
| 1 | Recipe flags (`decor`, `zone`, `flat`, `rot`) + server zone checks; ship 2 decor items (banner, stone_path) | build/place/destroy both; reload save from before the change |
| 2 | Interior decor (widen furn kinds) + owner-only demolish | two clients: A places in shelter, B sees it; B cannot demolish |
| 3 | Remaining decor items + `mod_*` module art from this pack | ghost preview correct for flat items |
| 4 | Chest storage (Section 5) | two clients moving items from the same chest simultaneously — counts never go negative |
| 5 | Farmplot + wheat only (Section 4) | plant→save→restart server→load→harvest yields correctly |
| 6 | Remaining crops + weather coupling | blizzard doesn't tank tick time (measure) |

## 7. Guardrails (non-negotiable)

1. Every new client message gets the same treatment as `build`: distance check, inventory
   check, rate limit. Copy the existing pattern; do not write a fresh validation style.
2. No `Math.random()` in placement or growth. Growth is tick-arithmetic; any variance
   comes from the seeded world state.
3. New Maps (`farms`, `chestInv`) serialize alongside `structures` in save.json and are
   loaded with unknown-kind tolerance. Test load of a PRE-change save at every step.
4. Texture keys == recipe kind strings, one canonical key, preloaded via the manifest
   table (see `MANIFEST.md` / advisory item 1 — do that refactor first if not done; this
   feature adds ~15 textures and hardcoded preloads will hurt).
5. Depth rule stays `depth = screenY` (+offset), flat decor below entities. Never sort by
   insertion order.
6. After every step: `npm run build`, fresh server, `node test.mjs`, then a manual co-op
   smoke test (two tabs). Extend test.mjs with one build+furn assertion in step 1 and one
   plant/harvest assertion in step 5 — they're ~20 lines each following its existing style.

## 8. Explicit non-goals (v1)

- Free-form/sub-tile placement — everything snaps to the tile grid like current structures.
- Structure rotation beyond 2 facings, resizable interiors, or moving placed items
  (demolish + rebuild is the move mechanic).
- Per-player locked chests (owner field is recorded; enforcement can come later).
- NPC interaction with player decor.

# Elevation & World Edge Guide

Implementation guide for two visual-credibility problems: **terrain elevation exists but
reads as flat**, and **the map edge shows dark emptiness instead of ocean**. Most of this
guide is client-only and save-safe; the one section that touches worldgen is explicitly
gated. Line references drift — grep the named functions first.

Read `ARCHITECTURE_ADVISORY.md` first, especially item 2 (save versioning): **any change
inside `shared/world.js` silently corrupts every existing save.** Sections 2–5 here avoid
worldgen entirely; Section 6 requires the `worldVersion` guard to exist before you start.

---

## 1. Current state (measured, not assumed)

### Elevation IS implemented — it's just invisible
- `shared/world.js` (~lines 50–56): `elev` is a 320×320 Uint8Array, 0–3. Water = 0; land
  gets 1 + noise thresholds (`el > 0.05` → +1, `el > 0.42` → +1) + a ridged-noise pass
  (`ridge > 0.82`) that adds mountain chains. The Blight island is clamped to 1.
- Gameplay already uses it: climbing >1 level is blocked (>2 while jumping,
  src/main.ts ~616), dropping ≥2 levels deals fall damage (server/index.js ~167).
- Rendering already uses it: `isoE(x,y)` lifts everything by `(elev-1)*10` px
  (main.ts ~86–89), and `drawChunk` (~251–259) stacks each tile texture `elev` times at
  10 px intervals into the chunk RenderTexture, so cliff faces exist as stacked skirts.
  All z=0 sprites (player, creatures, nodes, structures, monoliths) go through `isoE`.

### Why it reads as flat (the actual causes to fix)
1. **10 px per level on a 40 px-tall tile** — a full cliff is a 25% tile-height nudge.
2. **Identical pixels at every level** — a level-3 peak tile is byte-for-byte the same
   texture as level-1 plains; nothing signals "high ground."
3. **Cliff faces are just repeated 8 px skirts** — same color as the top face's sides, so
   they blend into a smear instead of reading as a wall.
4. **No shadows** — a tile at the base of a cliff renders identically to open ground.

### The edge problem (root cause)
- The square tile grid projects to a **diamond** in screen space, but
  `cameras.main.setBounds(0,-80,W,H+160)` (~line 595) is the diamond's rectangular
  bounding box. Near map corners/edges the camera legitimately shows the area outside
  the diamond — which is the scene background `#0d1520` (~line 908): near-black.
- Out-of-bounds queries already return `T.WATER` (`tileAt` ~602) and `blockedAt` ~608
  returns blocked; the player is clamped to [0,320) (~748). So the *data* model already
  says "infinite ocean" — only the renderer refuses to draw it.
- There is no minimap; don't budget for one here.

---

## 2. Make elevation read — geometry (client-only, save-safe)

### 2.1 One shared constant
`10` appears independently in `isoE` and in `drawChunk`'s stack loop (`p.y - l*10`).
First change: extract `const ELEV_PX = 10` used by BOTH — they must never diverge or
sprites will float above / sink into their tiles. Verify nothing else hardcodes the 10
(grep `*10` near iso math; `STORY_OFF` for wall/shelter stacking is unrelated — leave it).

### 2.2 Carve down, not up — anchor the ground plane at the TOP level
Keep the 0–3 range, but invert the anchor: instead of lifting high ground
(`p.y -= max(0, elev-1)*10`, plains as baseline, peaks floating up), sink low ground
below a level-3 ground plane. Replace 2.1's single constant with a shared lookup table:

```ts
// px each level sits BELOW the ground plane (level 3). Non-uniform on purpose:
// water gets 1.5 levels of extra sink so the sea reads as genuinely deep.
const ELEV_OFF = [56, 32, 16, 0];   // index = elev 0..3
// isoE:      p.y += ELEV_OFF[elevAt(x,y)]
// drawChunk: draw the top face at +ELEV_OFF[e], cliff strips downward below it
```

Be honest about what this changes and what it doesn't:
- **Land-to-land steps render identically either way** — a 1-level wall is the same wall
  whether you call it "hill up" or "valley down"; flipping the anchor alone just
  translates the map on screen. Don't expect it to transform the look by itself.
- **The two real wins:** (a) the old `max(0, elev-1)` clamp drew WATER at the same
  height as plains — with the table, the sea finally sits below the land, so every
  shoreline becomes a visible bank with cliff strips (2.3) dropping to the water. This
  is the strongest "carved world" cue in the whole guide, and it's free. (b) The extra
  water sink (56 px ≈ 1.5 levels) makes coasts and valley lakes read *deep* while the
  elevation range stays 0–3.
- The full "valleys cut into high ground" feel also needs the terrain *distribution* to
  change (most land high, lows carved) — that's worldgen, Section 6. Ship this
  rendering flip first; it's save-safe and Section 6 becomes pure tuning on top.

Everything through `isoE` moves together (boats sink with their water tiles;
players/creatures/structures stay glued). Check two spots that assumed the old lift-up:
- Chunk vertical bounds: `drawChunk`'s screen-rect→tile-range inverse projection must
  pad its BOTTOM edge by `ELEV_OFF[0]` px — sunken tiles extend below their nominal
  row and will clip at chunk seams otherwise. Test along a shoreline.
- Camera bounds `-80/+160` margins: add `ELEV_OFF[0]` to the bottom margin.

### 2.3 Fill the cliff faces
Stacked 8 px skirts leave gaps at 16 px spacing (and can't span the 24 px water drop at
all). Two options; take the second:
- **(a) Draw the skirt-only region stretched**: batchDraw supports source frames poorly
  on RenderTexture; simpler is (b).
- **(b) Generate a dedicated cliff-face strip at startup**: for each tile texture, use
  the existing `generateTexture()` pattern (weather particles do this) to bake a
  64×16 strip sampling the tile's two side-face colors, darkened ~25% (left face) and
  ~40% (right face). Draw the top face once at its `ELEV_OFF` height, then tile the
  strip downward to fill the gap to each lower neighbor's height (up to `ELEV_OFF[0]`
  total for a coast bank). Result: continuous shaded earth/rock walls dropping into
  valleys and sea — the single biggest visual win in this guide.

## 3. Make elevation read — light (client-only, save-safe)

All of these are baked into the chunk RenderTexture at draw time — zero per-frame cost.

1. **Depth shade**: pre-generate darkened, slightly cool-tinted variants of each tile
   texture at startup (−9% brightness per level below 3; ~18 tile textures × 2 variants —
   trivial memory). `batchDraw` the variant matching the tile's level. The ground plane
   stays sunlit; valley floors and shores sit in shadow — carved, not painted.
2. **Cliff-base contact shadow**: when drawing tile `(x,y)`, if the north or west
   neighbor (`elevAt`) is higher, overlay a pre-generated soft shadow diamond
   (black, alpha 0.18) on this tile. Grounds the cliffs; reads as ambient occlusion.
3. **Ledge rim**: if the south or east neighbor is LOWER, overlay a 2 px light rim along
   that edge of the top face (pre-generated 64×40 overlay with just the edge line, one
   per direction). This is also a **gameplay legibility** feature: rims mark exactly the
   drops that deal fall damage.
4. Order per tile: cliff strips (bottom-up) → top face (tinted variant) → contact shadow
   → rim. Keep it one code path in `drawChunk`; no per-kind special cases.

**Perf gate:** draw calls per tile go from `elev` to `elev + 0~2` overlays. Chunks bake
once and cache (24-chunk LRU), so steady-state cost is unchanged. Measure `drawChunk`
time before/after (console.time around it); regression budget: ≤2× per chunk bake.

## 4. The cliffs you can't see — occlusion in a 2D iso renderer

Two facts about this renderer create blind spots that Sections 2–3 alone don't fix:

- **Cliff faces only exist on camera-facing drops.** Skirts/cliff strips render *below*
  a tile's top face, so a drop is visible only where the lower neighbor is to the
  south/east (toward the camera). A drop on the north/west side faces away — the player
  sees flat ground that suddenly refuses to let them walk "up-screen", with no visual
  reason why.
- **Terrain can never hide an entity.** Tiles are baked into chunk RenderTextures that
  sit below all sprites in depth, while sprites sort among themselves by `depth =
  screenY`. Carving down (2.2) already removes the worst case — with the ground plane
  on top, there are no raised caps for entities to float over. What remains: an entity
  standing in a valley or on the water is drawn up to `ELEV_OFF[e]` px lower, where it
  can overlap the *near* (south/east) valley wall's top face — feet visually "on" the
  rim they should be below. Small (≤56 px worst case at the coast), but present.
  Conversely, nothing can ever ambush you from behind terrain visually.

### 4.1 Mark the away-facing edges (pairs with 3.3's rims)
Section 3.3 puts a light rim on top faces whose south/east neighbor is lower. Add the
inverse: a **dark crease line** (2 px, alpha ~0.35) along the north/west edge of any top
face whose N/W neighbor is lower. Mnemonic for the implementer: *light rim toward the
camera, dark crease away from it.* Same pre-generated overlay mechanism as the rims, two
more one-off textures. Now every ledge is marked from both sides, and "why can't I walk
up here" always has a visible answer.

### 4.2 Pick an occlusion policy — deliberately, not by accident
Decide once and write it in the PR description. Two sane options:

- **Option A (recommended — and with a carved world, almost certainly final): terrain
  never occludes entities.** Keep the current depth model. It's simple, has zero perf
  cost, and is *fair* (no enemy is ever invisible behind a ridge). With 2.2's carve-down
  anchor the residual artifact is only the near-wall overlap described above, which
  4.3's grounding markers neutralize. This is what most 2D survival games do.
- **Option B (only relevant if playtests still object): depth-sorted rim rows.** For
  tiles whose south/east neighbor is ≥2 levels lower (valley rims, coast cliffs), draw
  that tile's top face + strips as individual depth-sorted Images so the rim genuinely
  covers the feet of entities down in the valley. Rims are sparse lines, not areas, but
  MEASURE: log the live-image count, budget ≤300 in view, else revert to A. Option B
  makes 4.3 mandatory, because entities low in valleys can now be partially hidden.

### 4.3 Grounding markers / silhouettes (cheap, fixes both options)
Give the player, other players, and hostile creatures a small **ground marker**: a flat
diamond outline at the entity's feet (pre-generated texture, entity-colored, alpha 0.5),
drawn at high depth so it's never hidden. Show it only when the entity is
terrain-obscured: some tile 1–2 steps toward the camera (`x+1,y`, `x,y+1`, `x+1,y+1`,
out to 2) has `elev ≥ entityElev + 2`. That check is a handful of array reads per
visible entity — run it on the existing per-frame entity update, or every 3rd frame.
Under Option A the marker explains the floating ("you're BEHIND the cliff"); under
Option B it keeps hidden entities trackable and combat fair.

### 4.4 Fairness backstop that already exists
`audio.growl(closeness)` is distance-based on server data, so audible threat warnings
already work regardless of visual occlusion — verify it still triggers for creatures in
terrain-obscured positions after your changes (it should; it never consults rendering).
Combined with 4.3, nothing can ambush from a blind spot silently. If you implement the
COMBAT guide's telegraphs, those tints must go on the marker too when the creature is
obscured.

### 4.5 Design-side note (feeds Section 6)
When carving worldgen valleys (6.2) or placing landmark highlands (6.3), remember which
walls the renderer can show: a valley's *north/west* wall faces the camera and is
visible; its *south/east* wall faces away and shows only as a rim. So valleys read best
approached from the south/east (you look down into them, far wall in view), and
landmark highlands read best when the approach climbs from the south. Cheap rule of
thumb: the camera loves drops that open toward the viewer — bias carving so canyon
mouths and monolith overlooks face south/east.

## 5. Fix the edge — infinite ocean (client-only, save-safe)

Ship these in order; each stands alone.

### 5.1 Background color (one line, do it immediately)
Change the scene background from `#0d1520` to the water tile's top-face fill color (read
it from `tiles/water.svg`). The corner voids instantly become "distant sea" instead of
"end of the universe." Everything after this is polish on top of a working fix.

### 5.2 Ocean skirt — draw water beyond the grid
The data model already returns WATER out of bounds; teach the renderer to agree:
- In `drawChunk`, the tile-range clamp to `[0, SIZE-1]` is the blocker (~245–249).
  Remove the clamp for RENDERING only and, for out-of-range `(x,y)`, batchDraw a plain
  water tile (elev 0, single layer, no nodes/structures lookups — guard those with a
  bounds check so array indexing never goes negative or wraps: `y*SIZE+x` on negative y
  would alias into valid tiles, which is a real corruption bug, not a cosmetic one).
- Extend `setBounds` outward by `PAD = 24` tiles on every side (in iso pixel terms:
  x by `PAD*64`, y by `PAD*32`). The player clamp (~748) and `blockedAt` stay UNTOUCHED —
  the playable diamond is unchanged; there is simply always sea in view.
- test.mjs still passes untouched (server never sees any of this).

### 5.3 Horizon treatment (polish, optional)
- **Depth shading**: skirt water drawn with a pre-generated darker water variant when
  `dist_outside > 8` tiles — shallow coastal water fading to deep ocean. Two variants
  (mid, deep), banded, baked into chunks; no gradients at runtime.
- **Edge haze**: one screen-space overlay image (`setScrollFactor(0)`) — a soft vignette
  tinted the background color, alpha ~0.12, faint at center, stronger at screen edges.
  Sells atmospheric distance for one draw call. Generate with `generateTexture`, don't
  ship an asset.
- Do NOT animate skirt water per-frame (the chunk cache exists precisely to avoid
  per-frame tile work). If motion is wanted later, a single slow-scrolling sparkle
  overlay above the skirt region is the ceiling.

## 6. MORE elevation in the world (worldgen — gated, breaks saves)

Only enter this section after: (a) `worldVersion` check exists (advisory item 2), and
(b) Sections 2–4 shipped — better rendering may make current terrain sufficient. Apply
the placement bias from 4.5 to anything you add here.

Goal: keep the 0–3 range but **invert the distribution** — today most land sits at 1
with rare raised ridges; a carved world wants most land HIGH with valleys cut down.
Knobs in `shared/world.js` (~50–56), in increasing order of disruption:
1. **Raise the floor**: base land level 1 → 2 (`e = 2 + (el > 0.42 ? 1 : 0)`). Most
   terrain now sits one level above the water's bank, and every existing downward
   feature automatically deepens by contrast. The single most "valley-making" knob.
2. **Carve with the ridge noise instead of building with it**: the ridged pass
   (`ridge > 0.82 → e++`) currently raises mountain chains. Flip it to cut:
   `if (ridge > 0.78 && e > 1) e--`. The same winding chain shapes become canyon and
   river-valley systems threading the islands — level-1 floors under level-2/3 walls.
3. **Highlands at landmarks**: force `elev = 3` in a radius-4 disc around each monolith
   and radius-6 around CORE (after the noise pass, before the Blight clamp), with a
   1-tile ring of 2 so they stay climbable. Destinations read as high ground overlooking
   the carved lowlands; pairs with the mountain/temple sprites in this pack.
4. Keep invariants: WATER stays 0; Blight island stays clamped to 1 — which now reads
   as a sunken, drowned basin (a mood upgrade for free), but see the trap check below:
   entering it is a drop, leaving it requires a climbable route. Do not touch the
   tile-type noise, only `elev`.

**Mandatory verification for ANY knob — now in BOTH directions:** climbing is limited
to +1 (+2 jumping) while any drop is legal, so carved terrain has a hazard raised
terrain didn't: **inescapable pits**. A valley floor whose every wall is ≥2 high is a
one-way trap (and dropping in deals fall damage on arrival). Extend the test.mjs
reachability check to a two-way BFS: from spawn, assert all 4 monoliths + CORE are
reachable, AND assert every walkable tile reachable from spawn can also reach BACK to
spawn (reverse edges: drops become climbs). Any asymmetric region = regenerate or add a
ramp tile. Expect more fall-damage incidents near canyon rims — retune only if playtests
complain (SMALL_IMPROVEMENTS workflow).

## 7. Ship order

| Step | Scope | Gate |
|---|---|---|
| 1 | `ELEV_OFF` table + carve-down anchor (2.1–2.2) | walk a shoreline: sea visibly below the land, boats sit ON the sunken water, no chunk-seam clipping at the coast |
| 2 | Cliff strips (2.3) | shorelines and ledges read as walls/banks; chunk bake ≤2× baseline |
| 3 | Depth shades + shadows + rims + dark creases (3, 4.1) | every ledge marked from BOTH sides; screenshot compare day AND night (night palette must not crush the shading) |
| 4 | Grounding markers (4.3) under Option A | stand in a valley/on a boat below a rim: marker appears, disappears on level ground; creature above the rim still growls (4.4) |
| 5 | Background color (5.1) | corners no longer black |
| 6 | Ocean skirt + bounds pad (5.2) | sail the full coastline: no negative-index artifacts (watch NW corner specifically), player clamp unchanged, `node test.mjs` passes |
| 7 | Depth bands + haze (5.3) | steady 60 fps while panning at the edge |
| 8 | (Only if playtests demand) Option B rim rows (4.2) | ≤300 live rim images in view; markers keep low entities trackable; 60 fps held |
| 9 | (Optional) worldgen valley carving (6) | `worldVersion` bumped; TWO-WAY BFS green (no inescapable pits); fresh-world playtest with 4.5 placement bias |

## 8. Guardrails

1. Sections 2–5 must not touch `shared/` or `server/` at all — if you find yourself
   editing them, you've drifted out of scope.
2. `ELEV_OFF` is ONE table, used by `isoE` AND `drawChunk`. Divergence = floating sprites.
   Water's extra sink lives only in that table — never special-case water in the iso math.
3. Out-of-bounds render lookups must bounds-check BEFORE computing `y*SIZE+x` — negative
   y aliases into valid tiles silently.
4. All overlays/variants are `generateTexture` products baked at startup — no new asset
   files, no per-frame tile drawing, chunk LRU cache untouched.
5. Underground (z=1) and shelter interiors (z=2) intentionally ignore elevation (flat
   `iso()` + offset) — do not "fix" them.
6. After every step: `npm run build`, fresh server, `node test.mjs`, two-tab co-op sanity,
   and load a PRE-change save (steps 1–8 must load old saves cleanly; step 9 must refuse
   them via `worldVersion`).

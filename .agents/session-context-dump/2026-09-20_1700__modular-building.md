# Modular building, end to end — 2026-09-20 17:00

## Session summary

One session on branch `dev`, six commits. Built the modular building system — the feature
`PROJECT_STATE.md` §7 had ranked first and the only thing that unlocks the ~25 unused
`building_materials` assets — from the data tier up to the client, in Go rather than the legacy
`server/index.js`.

Verification was run by the orchestrator, not delegated: `tsc`, `vite build`, `go build/vet/test`,
the defs drift check, the worldgen parity harness, `test:control`, `test-multiworld.mjs`, and
three fresh-server runs of `gameserver/test-go.mjs` — the last ending `ALL TESTS PASSED`.

---

## What shipped, in order

### 1. The materials tier (`2de7670`)
Ten crafted intermediates — `wood_planks`, `stone_blocks`, `reed_thatch`, `rope_coil`,
`cloth_roll`, `clay_bricks`, `glass_pane`, `iron_beam`, `crystal_lattice`, `starmetal_plate` —
as ordinary recipes with a `material: true` flag, new `INV_KEYS`, and a `MATERIALS` list that
drives the inventory row so a future material needs no UI edit. The crafting panel already
enumerates `RECIPES`, so they appeared there for free.

### 2. The module store and protocol (`56d65d6`)
18 module kinds across `floor / wall / roof / fixture / decor`, keyed **`tile:slot`** in a map
beside `structures` with an ordered mirror (`modOrder`). `buildmod` in; `mod`, `modhp`, `modd`
and a unicast `modfail` out; modules stream with their chunk as `mods`; the save carries a
`modules` object that skips unknown kinds and malformed keys on load. Demolition reuses the
`atk` swing — an attack that finds no creature and no legacy structure hits the nearest module
and refunds half. Documented as §12 of `docs/10_GO_WIRE_PROTOCOL.md`.

### 3. Wall edges (`a7f1c0a`)
A wall occupies an *edge*, not a tile, so a player can stand inside a room they walled in.
`wallNE` on (x,y) owns the edge to (x+1,y), `wallNW` the edge to (x,y+1) — one owning tile per
edge, no way to express the same barrier twice. The pos validator refuses a crossing (with the
usual `fix` snapback) and creature steering tests the same rule, so an enclosure keeps wolves
out too.

### 4. The client (`7d6a753`)
A `#buildPanel` (B) listing pieces grouped by slot with material costs, a slot-aware ghost whose
geometry mirrors the server's convention exactly, R flipping a wall between the two edges,
module sprites from the chunk stream, and roofs fading to 0.3 alpha while the player stands
under them (recomputed only on a tile change).

### 5. Support and cascade (`21e58f9`)
One rule: roofs need a wall or fixture on their own tile, fixtures need a floor, decor needs
either; floors and walls are free-standing. Placement refuses with `unsupported`; removal
cascades to a fixed point (pull the floor → the pillar falls → the roof falls) refunding half of
each piece to whoever knocked it down.

### 6. Bridges (`af72e49`)
`mod_bridge_segment` is the one piece allowed over water, and only while the span reaches land —
anchoring is a breadth-first walk over the span, so a long causeway costs one traversal. Cutting
it drops everything that can no longer reach shore. Standing on a deck is not being in the
water: the survival tick skips thermal damage and the client neither swims nor launches a boat.

---

## Decisions made

**Modules are not inventory items.** `MODULES[kind].cost` is spent straight from the bag in
materials. The alternative — craft `mod_wall_stone` into a placeable slot — would have added 19
`INV_KEYS` and a cluttered bag for no rule the materials tier does not already express.

**`tile:slot` as the identity, not an opaque module id.** The asset guide allows either. A
composite key needs no counter, no second index, and makes "is this slot taken" a map lookup;
the wire messages address modules the same way, so there is nothing to correlate.

**Walls block the edge; doors do not; fixtures block nothing.** A pillar that blocks its tile
would let a player wall themselves into a tile they cannot leave. The one deliberate asymmetry:
`mod_railing` blocks (that is its purpose) while `mod_door` does not.

**Cascade destroy with refunds, not rejection or floating orphans.** The guide left the choice
open. Orphans read as a bug; rejecting the removal would mean a piece you can never take back
down once something rests on it.

**Legacy structures and modules never share a tile.** A tile carrying a structure refuses
modules and vice versa. Mixing them would mean two collision models on one tile for no gain.

**Modules are surface-only (`z=0`) in this pass.** Interiors already have the `furn` system with
its own bounds check; extending modular building to `z=2` needs the missing `shelterAnchor`
validation first (§5.7 of the state doc).

---

## Bugs found

### Two stale-buffer races in `test-go.mjs` (pre-existing, both fixed)
`c.wait(t)` scans the *whole* accumulated message buffer, not messages arriving after the call.
The DEVOK weather stage therefore matched a natural `{t:'wx',kind:null}` frame from the previous
11-second window and failed with `broadcast {"kind":null}`. The same shape bit the new MOD stage
once. Both now filter the type before sending. A third variant is inherent rather than a bug:
after `devcmd wx clear` the weather tick is free to roll a *new* storm during the assertion
window, so that assertion now only fails when damage continues with no storm running.

### Coastal wildlife eats demolition swings
An `atk` takes the nearest creature or animal before any structure or module, and the shoreline
is where fish and crabs live, so the bridge-cutting probe spent its whole 12-swing budget on
wildlife. Raised to 30 swings; the failure message now reports how many landed on animals.

---

## Notes for the next session

- **The wire suite is stateful.** Delete `gameserver/world*.save.json` and restart
  `npm run stack:servers` between runs, every time.
- **`gofmt -l .` lists most of `gameserver/` as unformatted.** That is a working-directory CRLF
  artifact of `core.autocrlf=true`, not real drift — the committed content is LF and `git diff`
  stays minimal. Do not "fix" it with a tree-wide rewrite.
- Modules are rendered from a single `modSpr` map keyed `"i:slot"`; the geometry lives in one
  place (`modPlacement`) and the server's edge convention is documented in wire spec §12.3.
  Change one without the other and the ghost will lie about collision.
- Left deliberately undone: owner-only demolition (§5.9 — free griefing today), module rotation
  beyond the two wall edges, interior (`z=2`) modules, and the smaller farming leftovers from
  `docs/PLAYER_BUILDING_CUSTOMIZATION_GUIDE.md` (crop weather coupling, `frostroot`, the crop
  picker, per-stage crop art).

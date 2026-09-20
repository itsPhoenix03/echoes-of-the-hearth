package room

import (
	"fmt"
	"math"
	"sort"
	"strconv"
	"strings"

	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// Modular building.
//
// The legacy `structures` map is one entry per tile, which cannot represent a
// floor, two wall edges, a roof, a fixture and a decor piece on the same tile.
// Modules therefore live in their own map keyed `tile:slot`, and are NOT
// inventory items: `buildmod` spends the module's material cost straight out of
// the player's bag (see defs.Module). Legacy structures are untouched — the two
// systems coexist and a tile carrying a structure refuses modules.
//
// Everything here runs on the room goroutine like the rest of the game state.

// Module is one placed piece of modular construction.
type Module struct {
	I     int
	Slot  string // one of defs.ModuleSlots
	Kind  string
	HP    int
	Dir   int
	Owner string
}

// modKey is the map key and the wire identity of a module: a tile plus a slot.
// The asset guide allows either an opaque id or tile:slot; tile:slot needs no
// counter and no second index.
func modKey(i int, slot string) string { return strconv.Itoa(i) + ":" + slot }

// parseModKey is the inverse, used when loading a save.
func parseModKey(k string) (int, string, bool) {
	sep := strings.IndexByte(k, ':')
	if sep <= 0 || sep == len(k)-1 {
		return 0, "", false
	}
	i, err := strconv.Atoi(k[:sep])
	if err != nil {
		return 0, "", false
	}
	return i, k[sep+1:], true
}

// moduleAt returns the module occupying one tile slot.
func (r *Room) moduleAt(i int, slot string) (*Module, bool) {
	m, ok := r.modules[modKey(i, slot)]
	return m, ok
}

// addModule inserts into the map and its ordered mirror together. Iteration
// order decides what a chunk frame and a save look like, so the two are
// maintained in exactly one add site and one remove site (invariant §3).
func (r *Room) addModule(m *Module) {
	k := modKey(m.I, m.Slot)
	if _, dup := r.modules[k]; dup {
		return
	}
	r.modules[k] = m
	r.modOrder = append(r.modOrder, k)
}

func (r *Room) removeModule(i int, slot string) {
	k := modKey(i, slot)
	if _, ok := r.modules[k]; !ok {
		return
	}
	delete(r.modules, k)
	for n, key := range r.modOrder {
		if key == k {
			r.modOrder = append(r.modOrder[:n], r.modOrder[n+1:]...)
			break
		}
	}
}

// slotFits reports whether a module kind may occupy a given tile slot. Every
// category names its slot directly — the art draws walls as tile-filling blocks,
// so a wall owns its tile rather than one of its edges.
func slotFits(defSlot, slot string) bool { return defSlot == slot }

// legacySlot maps the edge slots an older save may hold onto the tile slot that
// replaced them, so a world built before the rework still loads.
func legacySlot(slot string) string {
	if slot == "wallNE" || slot == "wallNW" {
		return "wall"
	}
	return slot
}

// modFail tells the sender why a placement was refused, echoing its seq so the
// client can clear that exact preview instead of guessing.
func (r *Room) modFail(p *Player, seq int, why string) {
	r.send(p, map[string]any{"t": "modfail", "seq": seq, "why": why})
}

// handleBuildMod places one module. Validation order mirrors handleBuild:
// everything is checked before any inventory is consumed.
func (r *Room) handleBuildMod(p *Player, m map[string]any) {
	seq := getInt32(m, "seq")
	kind := getString(m, "kind")
	slot := getString(m, "slot")
	i, okI := tileIndex(m, "i")

	def, known := r.defs.Modules[kind]
	if !known {
		r.modFail(p, seq, "unknown-module")
		return
	}
	if !r.defs.ModuleSlotSet[slot] || !slotFits(def.Slot, slot) {
		r.modFail(p, seq, "bad-slot")
		return
	}
	if !okI {
		r.modFail(p, seq, "bad-tile")
		return
	}
	if p.Z != 0 {
		r.modFail(p, seq, "outdoors-only")
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 6 {
		r.modFail(p, seq, "too-far")
		return
	}
	// terrain: only a bridge segment may stand over open water, and only when it
	// reaches back to land. Landmarks and medic huts are never buildable.
	if r.world.Tiles[i] == world.TWater {
		if !def.Water {
			r.modFail(p, seq, "water")
			return
		}
		if !r.bridgeAnchored(i) {
			r.modFail(p, seq, "no-anchor")
			return
		}
	}
	if r.medicTiles[i] || world.LandmarkBlock[i] {
		r.modFail(p, seq, "blocked")
		return
	}
	// legacy structures own their whole tile — do not mix the two systems.
	if _, taken := r.structures[i]; taken {
		r.modFail(p, seq, "tile-occupied")
		return
	}
	if _, taken := r.moduleAt(i, slot); taken {
		r.modFail(p, seq, "slot-occupied")
		return
	}
	if def.Blocks && r.playerOnTile(i) {
		r.modFail(p, seq, "occupied")
		return
	}
	if !r.supported(i, slot) {
		r.modFail(p, seq, "unsupported")
		return
	}
	if !canAfford(p.Inv, def.Cost) {
		r.modFail(p, seq, "cost")
		return
	}
	dir := getInt32(m, "dir")
	if dir != 1 {
		dir = 0 // the art only has two facings; anything else is a client bug
	}
	pay(p.Inv, def.Cost)
	mod := &Module{I: i, Slot: slot, Kind: kind, HP: def.HP, Dir: dir, Owner: p.S.ID}
	r.addModule(mod)
	r.broadcast(map[string]any{
		"t": "mod", "i": i, "slot": slot, "kind": kind, "hp": mod.HP, "dir": dir,
	})
	r.sendInv(p)
}

// Bridges.
//
// A bridge segment is the one module that may stand over open water, and it must
// reach back to dry land: it is anchored if a 4-neighbour is land or another
// segment that is itself anchored. Removing a segment mid-span therefore drops
// everything beyond it into the sea, which is the same cascade rule §12.4 applies
// on land, expressed over a span instead of a stack.
func (r *Room) isBridge(i int) bool {
	mod, ok := r.moduleAt(i, "floor")
	if !ok {
		return false
	}
	def, known := r.defs.Modules[mod.Kind]
	return known && def.Water
}

// neighbours4 returns the four orthogonal tiles that stay inside the world.
func neighbours4(i int) []int {
	x, y := i%world.SIZE, i/world.SIZE
	out := make([]int, 0, 4)
	if x > 0 {
		out = append(out, i-1)
	}
	if x < world.SIZE-1 {
		out = append(out, i+1)
	}
	if y > 0 {
		out = append(out, i-world.SIZE)
	}
	if y < world.SIZE-1 {
		out = append(out, i+world.SIZE)
	}
	return out
}

// bridgeAnchored reports whether a segment placed at i would reach land, walking
// the span it would join. It is breadth-first over segments, so a hundred-tile
// causeway costs one traversal of itself and nothing more.
func (r *Room) bridgeAnchored(i int) bool {
	seen := map[int]bool{i: true}
	queue := []int{i}
	for len(queue) > 0 {
		cur := queue[0]
		queue = queue[1:]
		for _, n := range neighbours4(cur) {
			if r.world.Tiles[n] != world.TWater {
				return true // dry land: the span is moored
			}
			if r.isBridge(n) && !seen[n] {
				seen[n] = true
				queue = append(queue, n)
			}
		}
	}
	return false
}

// recheckBridges runs after a segment is removed: every segment still connected
// to the gap is re-tested, and whatever no longer reaches land falls in, refunded
// to whoever cut the span. Iterating to a fixed point matters — the tile next to
// the gap can be anchored through a segment that is itself about to fall.
func (r *Room) recheckBridges(p *Player, removed int) {
	for again := true; again; {
		again = false
		for _, n := range neighbours4(removed) {
			if r.isBridge(n) && !r.bridgeAnchored(n) {
				mod, _ := r.moduleAt(n, "floor")
				r.refundModule(p, mod)
				r.destroyModule(n, "floor")
				r.cascadeUnsupported(p, n)
				r.recheckBridges(p, n) // the rest of the span goes with it
				again = true
			}
		}
	}
}

// Support.
//
// One rule, applied server-side on both placement and removal (the asset guide
// leaves the choice open; this is the choice):
//
//	floor   free-standing
//	wall    free-standing — a fence or a screen is a legitimate build
//	roof    needs a fixture on its own tile, or a wall on a neighbouring one
//	fixture needs a floor on its own tile
//	decor   needs a floor or a wall on its own tile to hang from
//
// Placement refuses an unsupported piece; removal cascades, destroying whatever
// the removed piece was holding up and refunding it to whoever knocked it down.
// The alternative — leaving orphans floating — reads as a bug to a player.
func (r *Room) supported(i int, slot string) bool {
	switch slot {
	case "floor", "wall":
		return true
	case "roof":
		// its own tile must stay walkable, so a roof leans on a fixture here or
		// on a wall next door — the shape of an actual hut
		if _, fx := r.moduleAt(i, "fixture"); fx {
			return true
		}
		for _, n := range neighbours4(i) {
			if _, w := r.moduleAt(n, "wall"); w {
				return true
			}
		}
		return false
	case "fixture":
		_, fl := r.moduleAt(i, "floor")
		return fl
	case "decor":
		_, fl := r.moduleAt(i, "floor")
		_, w := r.moduleAt(i, "wall")
		return fl || w
	}
	return false
}

// cascadeUnsupported removes everything on a tile that has lost its support,
// repeating until the tile is stable — taking a floor out from under a fixture
// can in turn strand the roof the fixture was holding. Materials go back to the
// player who caused it, at the same half rate as a deliberate demolition.
func (r *Room) cascadeUnsupported(p *Player, i int) {
	// a wall holds up the roofs around it, so the neighbours are re-checked too
	for _, n := range neighbours4(i) {
		if _, roofed := r.moduleAt(n, "roof"); roofed && !r.supported(n, "roof") {
			mod, _ := r.moduleAt(n, "roof")
			r.refundModule(p, mod)
			r.destroyModule(n, "roof")
		}
	}
	// checked in dependency order, deepest first, so one pass usually settles it
	for again := true; again; {
		again = false
		for _, slot := range []string{"fixture", "decor", "roof"} {
			if _, ok := r.moduleAt(i, slot); !ok || r.supported(i, slot) {
				continue
			}
			mod, _ := r.moduleAt(i, slot)
			r.refundModule(p, mod)
			r.destroyModule(i, slot)
			again = true
		}
	}
}

// refundModule returns half of a module's materials to a player, if there is a
// player to return them to. It is the shared half of demolition and cascade.
func (r *Room) refundModule(p *Player, mod *Module) []string {
	if p == nil {
		return nil
	}
	def, ok := r.defs.Modules[mod.Kind]
	if !ok {
		return nil
	}
	keys := make([]string, 0, len(def.Cost))
	for k := range def.Cost {
		keys = append(keys, k)
	}
	sort.Strings(keys) // deterministic message text
	var back []string
	for _, k := range keys {
		if n := def.Cost[k] / 2; n > 0 {
			p.Inv[k] += n
			back = append(back, fmt.Sprintf("%d %s", n, k))
		}
	}
	return back
}

// Walls.
//
// A wall module fills its tile, the way the legacy palisade does and the way the
// art is drawn: a block with a diamond top, two side faces and a ground shadow.
// An earlier pass modelled walls as edges (wallNE/wallNW) and it failed on both
// counts — the block art rendered as a post floating between tiles, and a player
// could fence themselves in on all four edges of the tile they were standing on
// with no way out. A room is now a ring of wall tiles around floor tiles, which
// is what the sprites look like and what players already know from palisades.
//
// mod_door is the deliberate exception: a wall you can walk through.
func (r *Room) wallBlocks(i int) bool {
	mod, ok := r.moduleAt(i, "wall")
	if !ok {
		return false
	}
	def, known := r.defs.Modules[mod.Kind]
	return known && def.Blocks
}

// roofed reports whether a tile has a roof over it. A roof is what makes a
// modular build worth the materials: it is shelter from the weather and from
// biome exposure, the same protection the z=2 shelter interior gives, without
// leaving the surface. Support (§12.4) already guarantees a roofed tile is part
// of a real structure — a pillar under it or a wall beside it.
func (r *Room) roofed(i int) bool {
	_, ok := r.moduleAt(i, "roof")
	return ok
}

// playerOnTile reports whether any player is standing on a tile. Placing a
// blocking wall under someone is the other half of the trap the edge model
// allowed, so it is refused.
func (r *Room) playerOnTile(i int) bool {
	for _, q := range r.playerOrder {
		if q.Z == 0 && ti(q.X, q.Y) == i {
			return true
		}
	}
	return false
}

// destroyModule removes a module and broadcasts its disappearance.
func (r *Room) destroyModule(i int, slot string) {
	r.removeModule(i, slot)
	r.broadcast(map[string]any{"t": "modd", "i": i, "slot": slot})
}

// nearestModule finds the module closest to a player within maxDist tiles,
// walking the ordered mirror so ties resolve the same way on every server.
func (r *Room) nearestModule(p *Player, maxDist float64) (*Module, float64) {
	var best *Module
	bestD := maxDist
	for _, k := range r.modOrder {
		mod := r.modules[k]
		d := math.Hypot(float64(mod.I%world.SIZE)-p.X, float64(mod.I/world.SIZE)-p.Y)
		if d < bestD {
			bestD, best = d, mod
		}
	}
	return best, bestD
}

// hitModule is the demolition path: modules take damage from an attack that
// found no creature and no legacy structure, and refund half their materials.
func (r *Room) hitModule(p *Player, mod *Module, dmg int) {
	mod.HP -= dmg * 2 // demolition is quick work, as it is for structures
	if mod.HP > 0 {
		r.broadcast(map[string]any{"t": "modhp", "i": mod.I, "slot": mod.Slot, "hp": mod.HP})
		return
	}
	back := r.refundModule(p, mod)
	r.destroyModule(mod.I, mod.Slot)
	// whatever this piece was holding up comes down with it
	r.cascadeUnsupported(p, mod.I)
	if mod.Slot == "floor" {
		r.recheckBridges(p, mod.I) // a cut span drifts away from the gap outwards
	}
	r.sendInv(p)
	msg := "Removed " + r.moduleName(mod.Kind)
	if len(back) > 0 {
		msg += " — recovered " + strings.Join(back, ", ")
	}
	r.send(p, map[string]any{"t": "msg", "s": msg})
}

// moduleName is the display name from defs, falling back to the raw kind.
func (r *Room) moduleName(kind string) string {
	if n, ok := r.defs.Names[kind]; ok {
		return n
	}
	return kind
}

// modulesSnapshot serialises the modules for a save, walking the ordered mirror
// so the file is byte-stable for a given world state.
func (r *Room) modulesSnapshot() map[string]*persist.Module {
	out := make(map[string]*persist.Module, len(r.modules))
	for _, k := range r.modOrder {
		mod := r.modules[k]
		out[k] = &persist.Module{Kind: mod.Kind, HP: mod.HP, Dir: mod.Dir, Owner: mod.Owner}
	}
	return out
}

// loadModules restores a saved modules map, skipping entries whose kind or slot
// no longer exists so a defs rollback cannot crash the server.
func (r *Room) loadModules(saved map[string]*persist.Module) {
	keys := make([]string, 0, len(saved))
	for k := range saved {
		keys = append(keys, k)
	}
	sort.Strings(keys) // a map has no order; the mirror must not depend on one
	for _, k := range keys {
		pm := saved[k]
		i, slot, ok := parseModKey(k)
		if !ok || i < 0 || i >= world.SIZE*world.SIZE {
			continue
		}
		slot = legacySlot(slot) // saves written before walls became tile pieces
		def, known := r.defs.Modules[pm.Kind]
		if !known || !r.defs.ModuleSlotSet[slot] || !slotFits(def.Slot, slot) {
			continue
		}
		if _, dup := r.moduleAt(i, slot); dup {
			continue // both edges of one tile collapse onto the same wall slot
		}
		hp := pm.HP
		if hp <= 0 {
			hp = def.HP
		}
		r.addModule(&Module{I: i, Slot: slot, Kind: pm.Kind, HP: hp, Dir: pm.Dir, Owner: pm.Owner})
	}
}

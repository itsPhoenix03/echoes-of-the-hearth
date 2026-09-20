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

// slotFits reports whether a module kind may occupy a given tile slot. A
// 'wall' module picks one of the two isometric edges; every other category
// names its slot directly.
func slotFits(defSlot, slot string) bool {
	if defSlot == "wall" {
		return slot == "wallNE" || slot == "wallNW"
	}
	return defSlot == slot
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
	// terrain: water is reserved for bridge segments, which land in their own
	// pass; landmarks and medic huts are never buildable.
	if r.world.Tiles[i] == world.TWater {
		r.modFail(p, seq, "water")
		return
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
	r.destroyModule(mod.I, mod.Slot)
	var back []string
	if def, ok := r.defs.Modules[mod.Kind]; ok {
		keys := make([]string, 0, len(def.Cost))
		for k := range def.Cost {
			keys = append(keys, k)
		}
		sort.Strings(keys) // deterministic message text
		for _, k := range keys {
			if n := def.Cost[k] / 2; n > 0 {
				p.Inv[k] += n
				back = append(back, fmt.Sprintf("%d %s", n, k))
			}
		}
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
		def, known := r.defs.Modules[pm.Kind]
		if !known || !r.defs.ModuleSlotSet[slot] || !slotFits(def.Slot, slot) {
			continue
		}
		hp := pm.HP
		if hp <= 0 {
			hp = def.HP
		}
		r.addModule(&Module{I: i, Slot: slot, Kind: pm.Kind, HP: hp, Dir: pm.Dir, Owner: pm.Owner})
	}
}

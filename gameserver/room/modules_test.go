package room

import (
	"testing"

	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// Modular building: one tile carries several slots, the cost comes out of the
// materials bag rather than a placeable inventory item, and every refusal says
// why so the client can drop exactly the preview it was holding.

// modTile returns the nth free land tile within reach of the spawn. The spawn
// island is not a uniform slab, so the offsets are searched rather than assumed.
func modTile(t *testing.T, f *fixture, nth int) int {
	t.Helper()
	found := 0
	for dy := -3; dy <= 3; dy++ {
		for dx := -3; dx <= 3; dx++ {
			x, y := f.r.spawn[0]+dx, f.r.spawn[1]+dy
			i := y*world.SIZE + x
			if f.r.world.Tiles[i] == world.TWater || world.LandmarkBlock[i] || f.r.medicTiles[i] {
				continue
			}
			if _, taken := f.r.structures[i]; taken {
				continue
			}
			if found == nth {
				return i
			}
			found++
		}
	}
	t.Fatal("no free land tile near the spawn")
	return 0
}

// stock fills the bag with every material a module test could need.
func stock(f *fixture) {
	for _, k := range f.r.defs.Materials {
		f.p.Inv[k] = 20
	}
}

func TestBuildModPlacesAndCharges(t *testing.T) {
	f := newFixture(t)
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	stock(f)
	i := modTile(t, f, 0)

	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(1), "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	mod, ok := f.r.moduleAt(i, "floor")
	if !ok {
		t.Fatalf("floor module was not placed: %v", f.lastOfType("modfail"))
	}
	if mod.Kind != "mod_floor_wood" || mod.HP != f.r.defs.Modules["mod_floor_wood"].HP {
		t.Fatalf("module stored wrong: %+v", mod)
	}
	if f.p.Inv["wood_planks"] != 18 {
		t.Fatalf("cost not charged: wood_planks=%d, want 18", f.p.Inv["wood_planks"])
	}
	if m := f.lastOfType("mod"); m == nil || m["slot"] != "floor" {
		t.Fatalf("no mod broadcast, got %v", m)
	}

	// a second slot on the SAME tile is the whole point of the system
	f.reset()
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(2), "i": float64(i), "kind": "mod_wall_stone", "slot": "wallNE", "dir": float64(1)})
	if w, ok := f.r.moduleAt(i, "wallNE"); !ok || w.Dir != 1 {
		t.Fatalf("wall on the same tile was refused: %v", f.lastOfType("modfail"))
	}
	// ...but the same slot twice is not
	f.reset()
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(3), "i": float64(i), "kind": "mod_wall_wood", "slot": "wallNE"})
	if m := f.lastOfType("modfail"); m == nil || m["why"] != "slot-occupied" {
		t.Fatalf("expected slot-occupied, got %v", m)
	}
	if f.r.modules[modKey(i, "wallNE")].Kind != "mod_wall_stone" {
		t.Fatal("a refused placement overwrote the occupant")
	}
}

func TestBuildModRefusals(t *testing.T) {
	f := newFixture(t)
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	stock(f)
	i := modTile(t, f, 1)

	cases := []struct {
		name string
		msg  map[string]any
		why  string
	}{
		{"unknown kind", map[string]any{"i": float64(i), "kind": "mod_nope", "slot": "floor"}, "unknown-module"},
		{"wrong slot for kind", map[string]any{"i": float64(i), "kind": "mod_floor_wood", "slot": "roof"}, "bad-slot"},
		{"invented slot", map[string]any{"i": float64(i), "kind": "mod_floor_wood", "slot": "basement"}, "bad-slot"},
		{"out of reach", map[string]any{"i": float64(i + 40*world.SIZE), "kind": "mod_floor_wood", "slot": "floor"}, "too-far"},
	}
	for _, c := range cases {
		f.reset()
		c.msg["t"], c.msg["seq"] = "buildmod", float64(9)
		f.r.handleBuildMod(f.p, c.msg)
		m := f.lastOfType("modfail")
		if m == nil || m["why"] != c.why {
			t.Fatalf("%s: expected %s, got %v", c.name, c.why, m)
		}
		if int(m["seq"].(float64)) != 9 {
			t.Fatalf("%s: seq must be echoed so the client can clear its preview: %v", c.name, m)
		}
	}

	// cannot afford: nothing is charged and nothing is placed
	f.reset()
	for _, k := range f.r.defs.Materials {
		f.p.Inv[k] = 0
	}
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(4), "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	if m := f.lastOfType("modfail"); m == nil || m["why"] != "cost" {
		t.Fatalf("expected cost refusal, got %v", m)
	}
	if _, ok := f.r.moduleAt(i, "floor"); ok {
		t.Fatal("a module was placed without paying for it")
	}

	// a legacy structure owns its whole tile
	f.reset()
	stock(f)
	f.r.structures[i] = &Structure{Kind: "workbench", HP: 15}
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(5), "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	if m := f.lastOfType("modfail"); m == nil || m["why"] != "tile-occupied" {
		t.Fatalf("expected tile-occupied, got %v", m)
	}
	delete(f.r.structures, i)

	// indoors is not a modular building site in this pass
	f.reset()
	f.p.Z = 2
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(6), "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	if m := f.lastOfType("modfail"); m == nil || m["why"] != "outdoors-only" {
		t.Fatalf("expected outdoors-only, got %v", m)
	}
}

func TestModuleDemolishRefunds(t *testing.T) {
	f := newFixture(t)
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	stock(f)
	i := modTile(t, f, 2)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_wall_stone", "slot": "wallNW"})
	mod, ok := f.r.moduleAt(i, "wallNW")
	if !ok {
		t.Fatal("setup: wall not placed")
	}
	before := f.p.Inv["stone_blocks"]

	f.reset()
	f.r.hitModule(f.p, mod, 100) // one overwhelming blow
	if _, still := f.r.moduleAt(i, "wallNW"); still {
		t.Fatal("module survived a lethal hit")
	}
	if len(f.r.modOrder) != 0 {
		t.Fatalf("ordered mirror still holds %d keys after removal", len(f.r.modOrder))
	}
	if got := f.p.Inv["stone_blocks"] - before; got != 1 {
		t.Fatalf("expected half of 3 stone_blocks back (1), got %d", got)
	}
	if m := f.lastOfType("modd"); m == nil || m["slot"] != "wallNW" {
		t.Fatalf("no modd broadcast, got %v", m)
	}
}

func TestModulesSurviveSaveLoad(t *testing.T) {
	f := newFixture(t)
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	stock(f)
	i := modTile(t, f, 3)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_floor_stone", "slot": "floor"})
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_roof_thatch", "slot": "roof"})
	saved := f.r.modulesSnapshot()
	if len(saved) != 2 {
		t.Fatalf("snapshot holds %d modules, want 2", len(saved))
	}
	// an unknown kind and a bad key must be skipped, not crash the load
	saved["9999999999:floor"] = saved[modKey(i, "floor")]
	saved["not-a-key"] = saved[modKey(i, "floor")]
	saved[modKey(i+1, "floor")] = &persist.Module{Kind: "mod_from_a_rolled_back_defs", HP: 10}

	g := newFixture(t)
	g.r.loadModules(saved)
	if len(g.r.modules) != 2 || len(g.r.modOrder) != 2 {
		t.Fatalf("loaded %d modules (%d mirrored), want 2", len(g.r.modules), len(g.r.modOrder))
	}
	if m, ok := g.r.moduleAt(i, "roof"); !ok || m.Kind != "mod_roof_thatch" {
		t.Fatalf("roof did not survive the round trip: %+v", g.r.modules)
	}
}

// --- wall edges ------------------------------------------------------------

// A wall stops a crossing, not a tile: both endpoints stay walkable, which is
// the only way a player can stand inside a room they have walled in.
func TestWallEdgeBlocksOneCrossing(t *testing.T) {
	f := newFixture(t)
	i := modTile(t, f, 0)
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	f.stand(x, y, 0)
	stock(f)

	// wallNE on (x,y) owns the edge between (x,y) and (x+1,y)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_wall_stone", "slot": "wallNE"})
	if _, ok := f.r.moduleAt(i, "wallNE"); !ok {
		t.Fatalf("setup: wall not placed: %v", f.lastOfType("modfail"))
	}

	if !f.r.crossingBlocked(x, y, x+1, y) {
		t.Fatal("stepping through a stone wall was allowed")
	}
	if !f.r.crossingBlocked(x+1, y, x, y) {
		t.Fatal("a wall must block both directions")
	}
	if f.r.crossingBlocked(x, y, x, y+1) {
		t.Fatal("a wallNE blocked the wallNW edge too")
	}
	if f.r.crossingBlocked(x, y, x-1, y) {
		t.Fatal("a wallNE blocked the far side of its own tile")
	}
	// a diagonal that would slip around the corner is still refused
	if !f.r.crossingBlocked(x, y, x+1, y+1) {
		t.Fatal("a diagonal step slipped through the wall")
	}
}

func TestDoorDoesNotBlock(t *testing.T) {
	f := newFixture(t)
	i := modTile(t, f, 1)
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	f.stand(x, y, 0)
	stock(f)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_door", "slot": "wallNE"})
	if _, ok := f.r.moduleAt(i, "wallNE"); !ok {
		t.Fatalf("setup: door not placed: %v", f.lastOfType("modfail"))
	}
	if f.r.crossingBlocked(x, y, x+1, y) {
		t.Fatal("a door is a wall you can walk through")
	}
}

// The movement validator must refuse a pos that crosses a wall, and say so with
// the usual fix snapback rather than silently accepting it.
func TestHandlePosRefusesWallCrossing(t *testing.T) {
	f := newFixture(t)
	i := modTile(t, f, 2)
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	f.stand(x, y, 0)
	stock(f)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_wall_wood", "slot": "wallNE"})
	if _, ok := f.r.moduleAt(i, "wallNE"); !ok {
		t.Fatalf("setup: wall not placed: %v", f.lastOfType("modfail"))
	}

	f.reset()
	f.now += 500
	f.r.handlePos(f.p, map[string]any{"t": "pos", "x": x + 1, "y": y})
	if f.p.X != x || f.p.Y != y {
		t.Fatalf("player walked through a wall to %.2f,%.2f", f.p.X, f.p.Y)
	}
	if m := f.lastOfType("fix"); m == nil {
		t.Fatal("a refused move must snap the client back")
	}
}

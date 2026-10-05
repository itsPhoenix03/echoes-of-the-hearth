package room

import (
	"testing"

	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// Felled trees and mined rocks must not regrow through what has been built on
// their tile, and nothing may be built over one still standing.

// respawnPass runs the 5 s node-respawn block of the sim tick.
func (f *fixture) respawnPass() {
	f.r.tickN = (f.r.tickN/25 + 1) * 25
	f.r.onSimTick()
}

func TestNodeDoesNotRegrowUnderBuild(t *testing.T) {
	f := newFixture(t)
	i := firstOf(t, f.r.world, world.NodeTree)
	f.r.removed[i] = f.now - 1 // respawn due
	f.r.addModule(&Module{I: i, Slot: "floor", Kind: "mod_floor_wood", HP: 10})
	f.reset()
	f.respawnPass()
	if !f.r.removedAt(i) {
		t.Fatal("a tree regrew through a floor built on its stump")
	}
	for _, m := range f.drain() {
		if m["t"] == "node" && m["hp"] == float64(-1) {
			t.Fatal("respawn was broadcast for a built-over tile")
		}
	}
	// the floor goes: the tree comes back at the next due check
	f.r.removeModule(i, "floor")
	f.r.removed[i] = f.now - 1
	f.respawnPass()
	if f.r.removedAt(i) {
		t.Fatal("tree never regrew once its tile was clear")
	}
}

func TestStructureAndFarmBlockRegrowth(t *testing.T) {
	f := newFixture(t)
	i := firstOf(t, f.r.world, world.NodeTree)
	for _, build := range []func(){
		func() { f.r.structures[i] = &Structure{Kind: "campfire", HP: 10} },
		func() { f.r.farms[i] = &Farm{Crop: "wheat"} },
	} {
		delete(f.r.structures, i)
		delete(f.r.farms, i)
		build()
		f.r.removed[i] = f.now - 1
		f.respawnPass()
		if !f.r.removedAt(i) {
			t.Fatal("a node regrew under a structure or farm")
		}
	}
}

func TestModuleRefusedOnStandingNode(t *testing.T) {
	f := newFixture(t)
	stock(f)
	i := firstOf(t, f.r.world, world.NodeTree)
	f.stand(float64(i%world.SIZE), float64(i/world.SIZE), 0)
	f.reset()
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "seq": float64(1), "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	if _, placed := f.r.moduleAt(i, "floor"); placed {
		t.Fatal("a floor was laid over a standing tree")
	}
	if fail := f.lastOfType("modfail"); fail == nil || fail["why"] != "node" {
		t.Fatalf("want modfail why=node, got %v", fail)
	}
}

// Saves from before this rule have trees grown up through floors: loading one
// fells them.
func TestLoadFellsNodesUnderBuilds(t *testing.T) {
	i := firstOf(t, sharedWorldOrGen(), world.NodeTree)
	snap := &persist.Snapshot{
		Version: world.WorldVersion, Seed: "hearth-1", Day: 1,
		Modules: map[string]*persist.Module{modKey(i, "floor"): {Kind: "mod_floor_wood", HP: 10}},
	}
	r, err := New(Config{Seed: "hearth-1", World: sharedWorldOrGen(), Store: memStore{snap}})
	if err != nil {
		t.Fatal(err)
	}
	if !r.removedAt(i) {
		t.Fatal("tree under a saved floor is still standing after load")
	}
}

func sharedWorldOrGen() *world.World {
	if sharedWorld == nil {
		sharedWorld = world.GenWorld("hearth-1")
	}
	return sharedWorld
}

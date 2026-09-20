package room

import (
	"testing"

	"hearth/gameserver/world"
)

// The demolition path: an ordinary swing with nothing else in range must reach
// the module. This is the only way to take a placed piece back down.
func TestAtkDemolishesAModule(t *testing.T) {
	f := newFixture(t)
	i := modTile(t, f, 0)
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	f.stand(x+0.5, y+0.5, 0)
	stock(f)
	f.r.handleBuildMod(f.p, map[string]any{"t": "buildmod", "i": float64(i), "kind": "mod_floor_wood", "slot": "floor"})
	if _, ok := f.r.moduleAt(i, "floor"); !ok {
		t.Fatalf("setup: floor not placed: %v", f.lastOfType("modfail"))
	}
	for n := 0; n < 20; n++ {
		f.now += 500
		f.p.LastAtk = 0
		f.r.handleAtk(f.p, map[string]any{"t": "atk"})
		if _, still := f.r.moduleAt(i, "floor"); !still {
			return // came down as it should
		}
	}
	t.Fatalf("20 swings did not demolish a floor underfoot: %v", f.lastOfType("modhp"))
}

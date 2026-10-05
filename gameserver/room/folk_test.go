package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// Island camps and their folk (folk.go).

func TestCampsPlacedAndBlocked(t *testing.T) {
	f := newFixture(t)
	if len(f.r.camps) != 3 {
		t.Fatalf("want 3 island camps, got %d", len(f.r.camps))
	}
	seen := map[string]bool{}
	for _, c := range f.r.camps {
		seen[c.IslandID] = true
		for _, i := range world.CampBlockTiles(c) {
			if !f.r.medicTiles[i] {
				t.Fatalf("%s: tile %d not blocked", c.ID, i)
			}
		}
		door := (c.HutY+1)*world.SIZE + c.HutX + 1
		if f.r.medicTiles[door] {
			t.Fatalf("%s: the hut door is blocked", c.ID)
		}
	}
	for _, id := range []string{"woods", "dunes", "marsh"} {
		if !seen[id] {
			t.Fatalf("no camp on %s", id)
		}
	}
	if len(f.r.folk) != 7 {
		t.Fatalf("want 7 folk across the camps, got %d", len(f.r.folk))
	}
	// deterministic: a second room on the same world places them identically
	g := newFixture(t)
	for i := range f.r.camps {
		a, b := f.r.camps[i], g.r.camps[i]
		if a.HutX != b.HutX || a.HutY != b.HutY || a.FireX != b.FireX || a.FireY != b.FireY {
			t.Fatalf("camp %s moved between rooms", a.ID)
		}
	}
}

// A creature near a villager sends them into the hut; once it is gone and the
// coast has been clear a while, they come back out.
func TestFolkFleeHideAndReturn(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	f.p.X, f.p.Y = 0, 0 // nobody to talk to
	fk := f.r.folk[0]
	f.r.newCreature(fk.X+3, fk.Y, 1, "crawler", ti(fk.X, fk.Y), true)
	for k := 0; k < 80 && fk.state != fsHidden; k++ {
		f.r.folkTick()
	}
	if fk.state != fsHidden || fk.Act != "hide" {
		t.Fatalf("villager did not take cover: state %d act %s", fk.state, fk.Act)
	}
	if f.r.nearestFolk(fk.X, fk.Y, 50) == fk {
		t.Fatal("hidden villager is still visible to hunters")
	}
	f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	for k := 0; k < folkClearTk+2; k++ {
		f.r.folkTick()
	}
	if fk.state == fsHidden {
		t.Fatal("villager stayed hidden after the danger passed")
	}
}

// At night the folk turn in; the watcher keeps the fire.
func TestFolkTurnInAtNight(t *testing.T) {
	f := newFixture(t)
	f.setNight()
	f.p.X, f.p.Y = 0, 0
	for k := 0; k < 300; k++ {
		f.r.folkTick()
	}
	for _, fk := range f.r.folk {
		if fk.watcher && fk.state == fsHidden {
			t.Fatalf("%s (watcher) went to bed", fk.Kind)
		}
		if !fk.watcher && fk.state != fsHidden {
			t.Fatalf("%s still out at night (act %s)", fk.Kind, fk.Act)
		}
	}
}

// A player close by gets their attention: they stop and talk.
func TestFolkStopForPlayer(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	fk := f.r.folk[0]
	f.p.X, f.p.Y, f.p.Z = fk.X+1, fk.Y, 0
	x, y := fk.X, fk.Y
	for k := 0; k < 20; k++ {
		f.r.folkTick()
	}
	if fk.X != x || fk.Y != y {
		t.Fatal("villager walked off mid-conversation")
	}
	if fk.Act != "talk" && fk.Act != "sit" {
		t.Fatalf("villager act %q, want talk", fk.Act)
	}
}

// With no player to hunt, a crawler goes after a villager in the open.
func TestIdleCrawlerHarassesFolk(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	f.p.X, f.p.Y = 0, 0
	fk := f.r.folk[0]
	c := f.r.newCreature(fk.X+8, fk.Y, 1, "crawler", ti(fk.X+8, fk.Y), true)
	d0 := math.Hypot(c.X-fk.X, c.Y-fk.Y)
	for k := 0; k < 4; k++ {
		f.r.tickN++
		f.r.stepCreature(c, 1, f.now)
	}
	if d1 := math.Hypot(c.X-fk.X, c.Y-fk.Y); d1 >= d0-0.5 {
		t.Fatalf("idle crawler ignored the villager: %.2f -> %.2f", d0, d1)
	}
}

// Folk ride the cre frame; camps ride init.
func TestFolkOnTheWire(t *testing.T) {
	f := newFixture(t)
	f.reset()
	f.r.broadcastCre()
	m := f.lastOfType("cre")
	fl, ok := m["f"].([]any)
	if !ok || len(fl) != len(f.r.folk) {
		t.Fatalf("cre frame folk list: %#v", m["f"])
	}
	row := fl[0].([]any)
	if len(row) != 5 || row[0] != f.r.folk[0].ID || row[3] != f.r.folk[0].Kind {
		t.Fatalf("folk row shape: %#v", row)
	}
	if len(f.r.campsWire()) != len(f.r.camps) {
		t.Fatal("campsWire dropped a camp")
	}
}

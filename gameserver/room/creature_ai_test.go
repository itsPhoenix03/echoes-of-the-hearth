package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// The hunting brain (creature_ai.go): detours, gnaw fallback, memory, alerts,
// per-type tactics, fire fear and spacing.

// landPatch finds the centre of an open (2r+1)² patch of one tile type with no
// medic or camp tiles in it.
func landPatch(t *testing.T, r *Room, kind uint8, rad int) (float64, float64) {
	t.Helper()
	w := r.world
	for i := range w.Tiles {
		x, y := i%world.SIZE, i/world.SIZE
		if x < rad+1 || y < rad+1 || x >= world.SIZE-rad-1 || y >= world.SIZE-rad-1 || w.Tiles[i] != kind {
			continue
		}
		ok := true
		for dy := -rad; dy <= rad && ok; dy++ {
			for dx := -rad; dx <= rad; dx++ {
				j := (y+dy)*world.SIZE + (x + dx)
				if w.Tiles[j] != kind || r.medicTiles[j] || world.LandmarkBlock[j] {
					ok = false
					break
				}
			}
		}
		if ok {
			return float64(x) + 0.5, float64(y) + 0.5
		}
	}
	t.Fatalf("no open %dx%d patch of tile %d", 2*rad+1, 2*rad+1, kind)
	return 0, 0
}

// run steps one creature n ticks with the clock advancing.
func (f *fixture) run(c *Creature, n int) {
	for k := 0; k < n; k++ {
		f.r.tickN++
		f.r.sampleVelocities()
		if _, alive := f.r.creatures[c.ID]; !alive {
			return
		}
		f.r.stepCreature(c, 1, f.now)
	}
}

func (f *fixture) wallAt(x, y int) *Structure {
	s := &Structure{Kind: "wall", HP: 1000}
	f.r.structures[y*world.SIZE+x] = s
	f.r.structIdx = nil
	return s
}

// A wall with open ends between a crawler and its prey: the crawler walks
// round it rather than chewing through.
func TestCreatureDetoursAroundWall(t *testing.T) {
	f := newFixture(t)
	f.p.HP = 1 << 20
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx+3, gy
	var walls []*Structure
	for dy := -3; dy <= 3; dy++ {
		walls = append(walls, f.wallAt(int(gx), int(gy)+dy))
	}
	c := f.spawnAt("crawler", gx-3, gy, true)
	f.run(c, 120)
	for _, s := range walls {
		if s.HP != 1000 {
			t.Fatalf("crawler gnawed the wall (hp %d) though it had open ends", s.HP)
		}
	}
	if d := math.Hypot(c.X-f.p.X, c.Y-f.p.Y); d > 1.6 {
		t.Fatalf("crawler never got round the wall: %.2f tiles from its prey at %.2f,%.2f", d, c.X, c.Y)
	}
}

// Prey fully walled in: there is no way round, so the old siege applies.
func TestCreatureGnawsWhenEnclosed(t *testing.T) {
	f := newFixture(t)
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx, gy
	var walls []*Structure
	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			if max(abs(dx), abs(dy)) == 2 {
				walls = append(walls, f.wallAt(int(gx)+dx, int(gy)+dy))
			}
		}
	}
	c := f.spawnAt("crawler", gx-5, gy, true)
	f.run(c, 80)
	chewed := false
	for _, s := range walls {
		if s.HP < 1000 {
			chewed = true
		}
	}
	if !chewed {
		t.Fatalf("crawler outside a closed ring never attacked it (at %.2f,%.2f)", c.X, c.Y)
	}
}

// Prey that leaves aggro range is searched for where it was last seen.
func TestCreatureSearchesLastKnownPosition(t *testing.T) {
	f := newFixture(t)
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx+5, gy
	c := f.spawnAt("crawler", gx-3, gy, true)
	f.run(c, 1)
	if c.Memory == 0 {
		t.Fatal("hunting crawler did not remember its prey")
	}
	f.p.X, f.p.Y = gx+500, gy+500 // vanished
	f.p.velSeeded = false
	before := math.Hypot(c.X-(gx+5), c.Y-gy)
	f.run(c, 8)
	if after := math.Hypot(c.X-(gx+5), c.Y-gy); after >= before-0.5 {
		t.Fatalf("crawler did not go to the last known spot: %.2f -> %.2f", before, after)
	}
}

// One alert when a creature first locks on, not one per tick.
func TestCalertOncePerSighting(t *testing.T) {
	f := newFixture(t)
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx+5, gy
	f.reset()
	c := f.spawnAt("crawler", gx-3, gy, true)
	f.run(c, 5)
	n := 0
	for _, m := range f.drain() {
		if m["t"] == "calert" && m["id"] == c.ID {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("got %d calert frames over 5 ticks of one hunt, want 1", n)
	}
}

// A stalker that lands a blow falls back before coming in again.
func TestStalkerHitAndRun(t *testing.T) {
	f := newFixture(t)
	f.p.HP = 1 << 20
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx, gy
	c := f.spawnAt("stalker", gx+0.5, gy, true)
	f.r.tickN = 4 // the next tick is a contact tick
	f.run(c, 1)
	if c.Retreat == 0 {
		t.Fatal("stalker did not fall back after striking")
	}
	d0 := math.Hypot(c.X-f.p.X, c.Y-f.p.Y)
	f.run(c, 3)
	if d1 := math.Hypot(c.X-f.p.X, c.Y-f.p.Y); d1 <= d0 {
		t.Fatalf("retreating stalker closed in: %.2f -> %.2f", d0, d1)
	}
}

// The lancer backs off from a player who crowds it.
func TestLancerKeepsBeamRange(t *testing.T) {
	f := newFixture(t)
	f.p.HP = 1 << 20
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx, gy
	c := f.spawnAt("blight_lancer", gx+2.5, gy, true)
	f.run(c, 6)
	if d := math.Hypot(c.X-f.p.X, c.Y-f.p.Y); d <= 2.5 {
		t.Fatalf("lancer let itself be crowded: %.2f tiles", d)
	}
}

// At night a crawler will not walk into a campfire's ring; by day it will.
func TestCrawlerFearsFireAtNight(t *testing.T) {
	for _, night := range []bool{true, false} {
		f := newFixture(t)
		f.p.HP = 1 << 20
		gx, gy := landPatch(t, f.r, world.TGrass, 7)
		f.r.structures[ti(gx, gy)] = &Structure{Kind: "campfire", HP: 50}
		f.r.structIdx = nil
		if night {
			f.setNight()
		} else {
			f.setDay()
		}
		f.p.X, f.p.Y = gx+1.2, gy+0.5
		c := f.spawnAt("crawler", gx+6, gy, true)
		closest := 99.0
		for k := 0; k < 60; k++ {
			f.run(c, 1)
			closest = math.Min(closest, math.Hypot(c.X-(math.Floor(gx)+0.5), c.Y-(math.Floor(gy)+0.5)))
		}
		if night && closest < aiFireRadius-0.01 {
			t.Fatalf("night: crawler entered the fire ring (%.2f < %.2f)", closest, aiFireRadius)
		}
		if !night && closest >= aiFireRadius {
			t.Fatalf("day: crawler kept away from the fire (closest %.2f)", closest)
		}
	}
}

// A husk wolf pack spreads round its prey rather than queueing up behind the
// leader.
func TestWolfPackFlanks(t *testing.T) {
	f := newFixture(t)
	f.p.HP = 1 << 20
	gx, gy := landPatch(t, f.r, world.TGrass, 9)
	f.p.X, f.p.Y = gx, gy
	var pack []*Creature
	for k := 0; k < 3; k++ {
		pack = append(pack, f.spawnAt("husk_wolf", gx-7, gy+float64(k)*0.4, true))
	}
	for k := 0; k < 14; k++ {
		f.r.tickN++
		f.r.sampleVelocities()
		for _, c := range pack {
			f.r.stepCreature(c, 1, f.now)
		}
	}
	// angular spread of the pack around the prey
	minA, maxA := math.Pi, -math.Pi
	for _, c := range pack {
		a := math.Atan2(c.Y-f.p.Y, c.X-f.p.X)
		if a < 0 && minA > 0 { // keep the arc continuous across ±π (pack starts west)
			a += 2 * math.Pi
		}
		minA, maxA = math.Min(minA, a), math.Max(maxA, a)
	}
	if spread := maxA - minA; spread < math.Pi/3 {
		t.Fatalf("wolves stayed bunched: %.0f° spread", spread*180/math.Pi)
	}
}

// Two creatures on one spot push apart while they hunt.
func TestCreaturesKeepSpacing(t *testing.T) {
	f := newFixture(t)
	f.p.HP = 1 << 20
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	f.p.X, f.p.Y = gx+6, gy
	a := f.spawnAt("crawler", gx-2, gy, true)
	b := f.spawnAt("crawler", gx-2, gy+0.05, true)
	for k := 0; k < 6; k++ {
		f.r.tickN++
		f.r.stepCreature(a, 1, f.now)
		f.r.stepCreature(b, 1, f.now)
	}
	if d := math.Hypot(a.X-b.X, a.Y-b.Y); d < 0.3 {
		t.Fatalf("crawlers stacked: %.2f apart", d)
	}
}

// Striking one creature rouses its neighbours toward the attacker.
func TestStruckCreatureRousesNeighbours(t *testing.T) {
	f := newFixture(t)
	gx, gy := landPatch(t, f.r, world.TGrass, 7)
	hit := f.spawnAt("stalker", gx, gy, true)
	other := f.spawnAt("drowned", gx+4, gy, true)
	f.p.X, f.p.Y = gx-1, gy
	f.r.alertPack(hit, f.p)
	if other.Memory == 0 || other.LastX != f.p.X {
		t.Fatalf("neighbour not roused: memory %d at %.1f", other.Memory, other.LastX)
	}
}

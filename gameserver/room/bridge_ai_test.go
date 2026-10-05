package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// Creatures cross water on keepers' bridges (creature_ai.go: creFooting,
// pickBridge). The shared test world is never mutated: these tests carve their
// channel into a private copy of the tiles.

// channelFixture builds a room whose grass patch at (gx, gy) is cut by a
// north–south water channel three tiles wide (x = cx..cx+2) running 50 tiles
// either way, too long for any creature to walk round.
func channelFixture(t *testing.T) (f *fixture, cx, gy int) {
	t.Helper()
	base := newFixture(t)
	gxf, gyf := landPatch(t, base.r, world.TGrass, 7)
	w := *base.r.world
	w.Tiles = append([]uint8(nil), w.Tiles...)
	cx, gy = int(gxf), int(gyf)
	for y := gy - 50; y <= gy+50; y++ {
		for x := cx; x <= cx+2; x++ {
			if x >= 0 && y >= 0 && x < world.SIZE && y < world.SIZE {
				w.Tiles[y*world.SIZE+x] = world.TWater
			}
		}
	}
	r, err := New(Config{Seed: "hearth-1", AllowWarp: true, World: &w})
	if err != nil {
		t.Fatal(err)
	}
	f = &fixture{r: r, t: t, now: base.now}
	r.nowFn = func() int64 { return f.now }
	f.sess = NewSession("test01", "u_test", "Tester", "test")
	f.p = newPlayer(f.sess, r.spawn, f.now, r.defs)
	f.p.HP = 1 << 20
	r.players[f.sess.ID] = f.p
	r.playerOrder = append(r.playerOrder, f.p)
	f.p.chunkInit = true
	f.p.chunkCX, f.p.chunkCY = chunkOf(f.p.X, f.p.Y)
	return f, cx, gy
}

// bridgeRow lays bridge segments across the channel on row y.
func (f *fixture) bridgeRow(cx, y int) {
	for x := cx; x <= cx+2; x++ {
		f.r.addModule(&Module{I: y*world.SIZE + x, Slot: "floor", Kind: "mod_bridge_segment", HP: 20})
	}
}

// chase steps a crawler after the player, failing if it ever stands on open
// (unbridged) water; it returns the closest approach.
func (f *fixture) chase(c *Creature, ticks int) float64 {
	closest := math.Inf(1)
	for k := 0; k < ticks; k++ {
		f.run(c, 1)
		i := ti(c.X, c.Y)
		if f.r.world.Tiles[i] == world.TWater && !f.r.bridgeTiles()[i] {
			f.t.Fatalf("tick %d: crawler is standing in open water at %.2f,%.2f", k, c.X, c.Y)
		}
		closest = math.Min(closest, math.Hypot(c.X-f.p.X, c.Y-f.p.Y))
	}
	return closest
}

// A bridge a few tiles off the straight line is found by the short-range
// detour search and crossed.
func TestCrawlerCrossesNearbyBridge(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy+4)
	f.p.X, f.p.Y = float64(cx)+6.5, float64(gy)+0.5
	c := f.spawnAt("crawler", float64(cx)-3.5, float64(gy)+0.5, true)
	if d := f.chase(c, 150); d > 1.2 {
		t.Fatalf("crawler never crossed the bridge: closest %.2f, ended at %.2f,%.2f", d, c.X, c.Y)
	}
}

// A bridge far down the channel — outside the detour search window — is still
// used: the creature makes for it along the shore.
func TestCrawlerMakesForDistantBridge(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy+30)
	f.p.X, f.p.Y = float64(cx)+6.5, float64(gy)+0.5
	c := f.spawnAt("crawler", float64(cx)-3.5, float64(gy)+0.5, true)
	if d := f.chase(c, 500); d > 1.2 {
		t.Fatalf("crawler never reached its prey over the far bridge: closest %.2f, at %.2f,%.2f (via %v)", d, c.X, c.Y, c.ViaAt != 0)
	}
}

// No bridge: the crawler stays on its shore, as before.
func TestCrawlerStaysAshoreWithoutBridge(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.p.X, f.p.Y = float64(cx)+6.5, float64(gy)+0.5
	c := f.spawnAt("crawler", float64(cx)-3.5, float64(gy)+0.5, true)
	f.chase(c, 120)
	if c.X >= float64(cx) {
		t.Fatalf("crawler crossed a channel with no bridge: at %.2f,%.2f", c.X, c.Y)
	}
}

// A brute does not fire its water bolt at a player standing on a bridge — it
// can walk out there.
func TestBruteHoldsBoltForPlayerOnBridge(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy)
	f.p.X, f.p.Y = float64(cx)+1.5, float64(gy)+0.5
	hp := f.p.HP
	c := f.spawnAt("brute", float64(cx)-3.5, float64(gy)+0.5, true)
	f.r.bruteBolt(c, f.now)
	if f.p.HP != hp {
		t.Fatal("brute bolted a player standing on a bridge")
	}
}

// A keeper standing out on the span is not safe from creatures that walk.
func TestCrawlerFollowsPlayerOntoBridge(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy)
	f.p.X, f.p.Y = float64(cx)+1.5, float64(gy)+0.5 // mid-span
	c := f.spawnAt("crawler", float64(cx)-4.5, float64(gy)+3.5, true)
	if d := f.chase(c, 120); d > 1.1 {
		t.Fatalf("crawler did not reach a keeper on the bridge: closest %.2f", d)
	}
}

// The bridge is cut with a crawler on it: it flounders to the nearest shore,
// harmless while it does, then hunts again.
func TestCrawlerWadesAshoreWhenBridgeCut(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy)
	f.p.X, f.p.Y = float64(cx)+30.5, float64(gy)+0.5 // far off: no contact
	c := f.spawnAt("crawler", float64(cx)+1.5, float64(gy)+0.5, true)
	for x := cx; x <= cx+2; x++ {
		f.r.removeModule(gy*world.SIZE+x, "floor")
	}
	hp := f.p.HP
	ashore := -1
	for k := 0; k < 40 && ashore < 0; k++ {
		f.run(c, 1)
		if f.r.creFooting(ti(c.X, c.Y)) {
			ashore = k
		}
	}
	if ashore < 0 {
		t.Fatalf("stranded crawler never reached land: at %.2f,%.2f", c.X, c.Y)
	}
	if f.p.HP != hp {
		t.Fatal("a floundering crawler dealt damage")
	}
	if _, alive := f.r.creatures[c.ID]; !alive {
		t.Fatal("crawler drowned within reach of a shore")
	}
}

// Stranded too far from any land, a non-swimmer drowns.
func TestStrandedCrawlerDrownsFarFromShore(t *testing.T) {
	f, cx, gy := channelFixture(t)
	for y := gy - 20; y <= gy+20; y++ {
		for x := cx - 20; x <= cx+20; x++ {
			f.r.world.Tiles[y*world.SIZE+x] = world.TWater
		}
	}
	f.p.X, f.p.Y = float64(cx)+60, float64(gy)
	c := f.spawnAt("crawler", float64(cx)+0.5, float64(gy)+0.5, true)
	f.run(c, 1)
	if _, alive := f.r.creatures[c.ID]; alive {
		t.Fatal("crawler 20 tiles from land did not drown")
	}
}

// Cutting a bridge drops every cached route, so nobody keeps walking at it.
func TestBridgeCutDropsCachedRoutes(t *testing.T) {
	f, cx, gy := channelFixture(t)
	f.bridgeRow(cx, gy+4)
	f.p.X, f.p.Y = float64(cx)+6.5, float64(gy)+0.5
	c := f.spawnAt("crawler", float64(cx)-3.5, float64(gy)+0.5, true)
	// a route over the span, as planPath / pickBridge would have left it
	c.Path = []int{(gy+4)*world.SIZE + cx, (gy+4)*world.SIZE + cx + 1, (gy+4)*world.SIZE + cx + 2}
	c.PathGoal, c.PathAt = ti(f.p.X, f.p.Y), int(f.r.tickN)
	c.ViaI, c.ViaAt = (gy+4)*world.SIZE+cx+2, max(f.r.tickN, 1)
	f.r.removeModule((gy+4)*world.SIZE+cx+1, "floor")
	if len(c.Path) != 0 || c.ViaAt != 0 {
		t.Fatal("route over the cut bridge survived")
	}
	// and it now stays ashore: the span is broken
	f.chase(c, 120)
	if c.X >= float64(cx) && c.X < float64(cx)+3 && !f.r.creFooting(ti(c.X, c.Y)) {
		t.Fatalf("crawler walked into the gap at %.2f,%.2f", c.X, c.Y)
	}
}

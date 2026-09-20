package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// These cover the Slice 3 creature rules that are easy to port subtly wrong:
// the spawn gates (strength, night, biome, standoff distance), who may cross
// water, the medic-hut movement block, the leash and its despawn, and what a
// landed swing does to a creature.

// --- helpers ---------------------------------------------------------------

// landTile finds the centre of an open 5x5 patch of one tile type, so a
// creature placed there has somewhere legal to step in every direction.
func landTile(t *testing.T, w *world.World, kind uint8) (float64, float64) {
	t.Helper()
	for i := range w.Tiles {
		if w.Tiles[i] != kind {
			continue
		}
		x, y := i%world.SIZE, i/world.SIZE
		if x < 4 || y < 4 || x >= world.SIZE-4 || y >= world.SIZE-4 {
			continue
		}
		ok := true
		for dy := -2; dy <= 2 && ok; dy++ {
			for dx := -2; dx <= 2; dx++ {
				if w.Tiles[(y+dy)*world.SIZE+(x+dx)] != kind {
					ok = false
					break
				}
			}
		}
		if ok {
			return float64(x), float64(y)
		}
	}
	t.Fatalf("no open 5x5 patch of tile %d in the world", kind)
	return 0, 0
}

func (f *fixture) setNight() { f.r.time = 0.8 }
func (f *fixture) setDay()   { f.r.time = 0.3 }

// spawnAt drops a creature directly, bypassing the spawn roll.
func (f *fixture) spawnAt(typ string, x, y float64, hasHome bool) *Creature {
	ct := creTypes[typ]
	return f.r.newCreature(x, y, ct.hpBase+ct.hpStr, typ, ti(x, y), hasHome)
}

// rollTypes runs the spawn roll many times, clearing between attempts, and
// returns the set of types it managed to produce.
func (f *fixture) rollTypes(attempts int) map[string]bool {
	seen := map[string]bool{}
	for i := 0; i < attempts; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
		for _, c := range f.r.creOrder {
			seen[c.Type] = true
		}
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	}
	return seen
}

// --- spawn gating ----------------------------------------------------------

// Brutes need three monoliths worth of strength and blight lancers two. Below
// the threshold the roll that would have chosen them falls through, so neither
// type may ever appear.
func TestSpawnStrengthGating(t *testing.T) {
	f := newFixture(t)
	f.setNight()
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)

	// strength 1 (no monoliths): no brutes, no blight lancers, ever.
	f.r.mono = [4]bool{}
	seen := f.rollTypes(4000)
	if seen["brute"] {
		t.Error("a brute spawned at strength 1 (needs strength >= 3)")
	}
	if seen["blight_lancer"] {
		t.Error("a blight lancer spawned at strength 1 (needs strength >= 2)")
	}
	if !seen["crawler"] {
		t.Error("no crawlers spawned at all — the roll is not reaching the default")
	}

	// strength 2 (one monolith): lancers unlock, brutes still do not.
	f.r.mono = [4]bool{true}
	seen = f.rollTypes(8000)
	if seen["brute"] {
		t.Error("a brute spawned at strength 2 (needs strength >= 3)")
	}
	if !seen["blight_lancer"] {
		t.Error("no blight lancer at strength 2, where roll 0.45-0.5 should produce one")
	}

	// strength 3 (two monoliths): brutes unlock.
	f.r.mono = [4]bool{true, true}
	if f.r.strength() != 3 {
		t.Fatalf("two monoliths should give strength 3, got %d", f.r.strength())
	}
	seen = f.rollTypes(8000)
	if !seen["brute"] {
		t.Error("no brute at strength 3, where roll > 0.85 should produce one")
	}
}

// husk_wolf, frost_wraith and stalker are night-only. During the day their
// branches of the roll are unreachable.
func TestSpawnNightOnlyTypes(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	f.r.mono = [4]bool{true, true, true, true} // strength 5: widest table
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)
	seen := f.rollTypes(8000)
	for _, nightOnly := range []string{"husk_wolf", "frost_wraith", "stalker"} {
		if seen[nightOnly] {
			t.Errorf("%s spawned during the day", nightOnly)
		}
	}
}

// The population cap: zero once the world is won, and otherwise a night/day
// split scaled by monolith count. Husk wolves count double toward it.
func TestSpawnPopulationCap(t *testing.T) {
	f := newFixture(t)
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)

	fill := func() int {
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
		for i := 0; i < 3000; i++ {
			f.r.tickN = 3
			f.r.creatureSpawnTick(f.r.strength())
		}
		wolves := 0
		for _, c := range f.r.creOrder {
			if c.Type == "husk_wolf" {
				wolves++
			}
		}
		return len(f.r.creatures) + wolves
	}

	f.setDay()
	f.r.mono = [4]bool{}
	// The gate compares the pre-spawn count, so the population may finish one
	// over the cap; what must not happen is it running away.
	if got := fill(); got < 3 || got > 4 {
		t.Fatalf("day/strength-1 population settled at %d, want the cap of 3", got)
	}
	f.setNight()
	if got := fill(); got < 9 || got > 11 {
		t.Fatalf("night/strength-1 population settled at %d, want the cap of 9", got)
	}

	// won zeroes the cap: nothing may ever spawn again.
	f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	f.r.won = true
	for i := 0; i < 500; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
	}
	if len(f.r.creatures) != 0 {
		t.Fatalf("creatures spawned after the world was won: %d", len(f.r.creatures))
	}
}

// The spawn tick only runs every third tick.
func TestSpawnEveryThirdTick(t *testing.T) {
	f := newFixture(t)
	f.setNight()
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)
	for _, tn := range []int64{1, 2, 4, 5, 7, 8} {
		f.r.tickN = tn
		for i := 0; i < 50; i++ {
			f.r.creatureSpawnTick(f.r.strength())
		}
	}
	if len(f.r.creatures) != 0 {
		t.Fatalf("spawned on a tick that is not a multiple of 3: %d creatures", len(f.r.creatures))
	}
}

// A bog shambler must land on MUD or BLIGHT and never within 9 tiles of a
// player; a frost wraith must land on SNOW under the same standoff rule.
func TestSpawnBiomeAndStandoff(t *testing.T) {
	f := newFixture(t)
	f.setNight()
	f.r.mono = [4]bool{true, true, true, true}
	f.p.X, f.p.Y = float64(world.ISLES[3][0]), float64(world.ISLES[3][1])
	checked := 0
	for i := 0; i < 20000 && checked < 40; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
		for _, c := range f.r.creOrder {
			switch c.Type {
			case "bog_shambler":
				tile := f.r.tileAtXY(c.X, c.Y)
				if tile != world.TMud && tile != world.TBlight {
					t.Fatalf("bog shambler on tile %d, want MUD or BLIGHT", tile)
				}
				if d := math.Hypot(f.p.X-c.X, f.p.Y-c.Y); d < 9 {
					t.Fatalf("bog shambler spawned %.2f tiles from a player, want >= 9", d)
				}
				checked++
			case "frost_wraith":
				if tile := f.r.tileAtXY(c.X, c.Y); tile != world.TSnow {
					t.Fatalf("frost wraith on tile %d, want SNOW", tile)
				}
				if d := math.Hypot(f.p.X-c.X, f.p.Y-c.Y); d < 9 {
					t.Fatalf("frost wraith spawned %.2f tiles from a player, want >= 9", d)
				}
				checked++
			}
		}
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	}
	if checked == 0 {
		t.Fatal("no biome-gated creature spawned at all, so nothing was verified")
	}
}

// A drowned rises from water, and only from water.
func TestSpawnDrownedRisesFromWater(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	wx, wy, ok := findTile(f.r.world, func(i int) bool {
		x, y := i%world.SIZE, i/world.SIZE
		if x < 30 || y < 30 || x >= world.SIZE-30 || y >= world.SIZE-30 {
			return false
		}
		return f.r.world.Tiles[i] == world.TGrass && f.r.world.Tiles[i+14] == world.TWater
	})
	if !ok {
		t.Skip("no grass tile with water 14 tiles east in this world")
	}
	f.p.X, f.p.Y = float64(wx), float64(wy)
	found := 0
	for i := 0; i < 20000 && found < 10; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
		for _, c := range f.r.creOrder {
			if c.Type != "drowned" {
				continue
			}
			if f.r.tileAtXY(c.X, c.Y) != world.TWater {
				t.Fatalf("drowned spawned on land at %.0f,%.0f", c.X, c.Y)
			}
			found++
		}
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	}
	if found == 0 {
		t.Skip("no drowned spawned near this coast within the attempt budget")
	}
}

// Corruption breeds crawlers: with at least one infected tile, a low roll puts
// the crawler on an infected tile rather than at the Core.
func TestSpawnCorruptionBreedsCrawlers(t *testing.T) {
	f := newFixture(t)
	f.setDay()
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx, gy
	inf := ti(gx, gy)
	f.r.setInfected(inf, f.now+120000)

	onInfected := false
	for i := 0; i < 8000 && !onInfected; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
		for _, c := range f.r.creOrder {
			if c.Type == "crawler" && ti(c.X, c.Y) == inf {
				onInfected = true
			}
		}
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	}
	if !onInfected {
		t.Fatal("no crawler ever bred on the infected tile")
	}
}

// A husk wolf spawn produces a pack of 2-3 on GRASS, not a lone wolf.
func TestSpawnHuskWolfPack(t *testing.T) {
	f := newFixture(t)
	f.setNight()
	f.r.mono = [4]bool{true, true, true, true} // lift the cap so a pack fits
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)
	sawPack := false
	for i := 0; i < 30000 && !sawPack; i++ {
		f.r.tickN = 3
		f.r.creatureSpawnTick(f.r.strength())
		n := 0
		for _, c := range f.r.creOrder {
			if c.Type == "husk_wolf" {
				n++
				if f.r.tileAtXY(c.X, c.Y) != world.TGrass {
					t.Fatalf("husk wolf spawned off GRASS at %.0f,%.0f", c.X, c.Y)
				}
			}
		}
		if n >= 2 {
			if n > 3 {
				t.Fatalf("husk wolf pack of %d, want 2-3", n)
			}
			sawPack = true
		}
		f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	}
	if !sawPack {
		t.Fatal("husk wolves never spawned as a pack of 2-3")
	}
}

// --- CAN_SWIM --------------------------------------------------------------

// Only the stalker and the drowned may cross water. Everything else must be
// turned back by the steering gate even with the player straight across it.
func TestCanSwimEnforcement(t *testing.T) {
	probe := newFixture(t)
	wi, ok := -1, false
	for i := range probe.r.world.Tiles {
		x, y := i%world.SIZE, i/world.SIZE
		if x < 10 || y < 10 || x >= world.SIZE-10 || y >= world.SIZE-10 {
			continue
		}
		if probe.r.world.Tiles[i] != world.TWater {
			continue
		}
		if probe.r.world.Tiles[i+1] == world.TWater && probe.r.world.Tiles[i+2] == world.TWater &&
			probe.r.world.Tiles[i-1] != world.TWater {
			wi, ok = i, true
			break
		}
	}
	if !ok {
		t.Skip("no suitable shoreline in this world")
	}
	shoreX, shoreY := float64(wi%world.SIZE-1), float64(wi/world.SIZE)

	for _, typ := range []string{"crawler", "husk_wolf", "brute", "bog_shambler", "stalker", "drowned"} {
		f := newFixture(t)
		f.p.X, f.p.Y, f.p.Z = shoreX+4, shoreY, 0 // player across the water
		c := f.spawnAt(typ, shoreX, shoreY, false)
		for step := 0; step < 60; step++ {
			f.r.tickN++
			if _, alive := f.r.creatures[c.ID]; !alive {
				break
			}
			f.r.stepCreature(c, 1, f.now)
			if !canSwim[typ] && f.r.tileAtXY(c.X, c.Y) == world.TWater {
				t.Fatalf("%s crossed onto water at %.2f,%.2f — CAN_SWIM excludes it", typ, c.X, c.Y)
			}
		}
	}
}

// --- medic hut -------------------------------------------------------------

// medicTiles must block creature steering, the leash walk-home and the frost
// wraith dart. This was a fixed bug: without it monsters walk into the medic
// hut and camp the one safe place in the game.
func TestMedicTilesBlockCreatureMovement(t *testing.T) {
	probe := newFixture(t)
	if len(probe.r.medicTiles) == 0 {
		t.Skip("this world has no medic huts")
	}
	// A medic tile whose eastern neighbour is walkable and NOT itself part of
	// the hut. The creature stands on that neighbour and everything it tries
	// aims west, straight into the hut.
	mi, found := 0, false
	for i := range probe.r.medicTiles {
		x, y := i%world.SIZE, i/world.SIZE
		if x < 6 || y < 6 || x >= world.SIZE-6 || y >= world.SIZE-6 {
			continue
		}
		east := i + 1
		if probe.r.medicTiles[east] || probe.r.world.Tiles[east] == world.TWater {
			continue
		}
		mi, found = i, true
		break
	}
	if !found {
		t.Skip("no medic tile with a clear eastern approach in this world")
	}
	mx, my := float64(mi%world.SIZE), float64(mi/world.SIZE)
	// 0.1 into the neighbouring tile: every creature step below is larger than
	// 0.1, so the next step always aims across the hut boundary.
	standX, standY := mx+1.1, my

	// Steering: a crawler chasing a player who stands inside the hut.
	//
	// The player is healed back to full every step. Without that, contact
	// damage kills them inside ~16 ticks, they respawn far away, the creature
	// loses its target and simply stops — and the test would pass vacuously
	// without ever exercising the guard.
	t.Run("steering", func(t *testing.T) {
		f := newFixture(t)
		f.p.X, f.p.Y, f.p.Z = mx, my, 0
		c := f.spawnAt("crawler", standX, standY, false)
		for step := 0; step < 80; step++ {
			f.r.tickN++
			f.p.HP = f.r.defs.MaxHP
			f.p.X, f.p.Y, f.p.Z = mx, my, 0
			f.r.stepCreature(c, 1, f.now)
			if f.r.medicTiles[ti(c.X, c.Y)] {
				t.Fatalf("crawler stepped onto medic tile at %.2f,%.2f", c.X, c.Y)
			}
		}
	})

	// The frost wraith dart bypasses the ordinary steering path entirely, so it
	// needs its own guard and its own test.
	//
	// The player must stay alive here too, and for a sharper reason: the dart
	// only runs while a player is within 10 tiles. Let the player die and the
	// wraith falls back to its wisp DRIFT path, which has no medic guard in
	// server/index.js either — so the test would be asserting against a path
	// the fix was never about.
	t.Run("frost wraith dart", func(t *testing.T) {
		f := newFixture(t)
		f.p.X, f.p.Y, f.p.Z = mx, my, 0
		c := f.spawnAt("frost_wraith", standX, standY, false)
		for step := 0; step < 80; step++ {
			f.r.tickN++
			f.p.HP = f.r.defs.MaxHP
			f.p.X, f.p.Y, f.p.Z = mx, my, 0
			f.r.stepCreature(c, 1, f.now)
			if f.r.medicTiles[ti(c.X, c.Y)] {
				t.Fatalf("frost wraith darted onto medic tile at %.2f,%.2f", c.X, c.Y)
			}
		}
	})

	// The leash walk-home is a third movement path, with a third guard. The
	// creature's home lies beyond the hut, so the walk-home step aims into it.
	t.Run("leash walk home", func(t *testing.T) {
		f := newFixture(t)
		f.p.X, f.p.Y, f.p.Z = mx+400, my+400, 0 // nobody within the 20-tile guard
		c := f.spawnAt("crawler", standX, standY, true)
		c.HomeI, c.HasHome = ti(mx-61, my), true
		for step := 0; step < 20; step++ {
			f.r.tickN++
			f.r.stepCreature(c, 1, f.now)
			if f.r.medicTiles[ti(c.X, c.Y)] {
				t.Fatalf("leashed crawler walked home onto medic tile at %.2f,%.2f", c.X, c.Y)
			}
		}
		// and it really was trying: the step was refused, not merely unneeded
		if c.X != standX {
			t.Fatalf("the walk-home step into the hut was not refused: x %.4f -> %.4f", standX, c.X)
		}
	})
}

// --- leash and despawn -----------------------------------------------------

// Beyond 60 tiles from home with no player within 20, a creature walks home at
// half speed.
//
// The creature sits at the centre of an open patch and its HOME is the distant
// tile, so the walk-home step is guaranteed to land somewhere walkable — the
// other way round, the step would land on whatever terrain happens to be 61
// tiles away and the test would be measuring the world, not the leash.
func TestLeashWalkHomeAtHalfSpeed(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx+500, gy+500 // far enough that neither leash nor chase fires

	c := f.spawnAt("crawler", gx, gy, true)
	c.HomeI, c.HasHome = ti(gx-61, gy), true // home is due west, 61 tiles off

	f.r.tickN++
	f.r.stepCreature(c, 1, f.now)

	// crawler baseSp is 0.44, and walk-home is half of it
	if math.Abs((gx-c.X)-0.22) > 1e-9 {
		t.Fatalf("walk-home step moved %.4f tiles west, want 0.22 (half of 0.44)", gx-c.X)
	}
	if c.Y != gy {
		t.Fatalf("walk-home drifted off the axis: y %.4f, want %.4f", c.Y, gy)
	}
}

// The leash stops applying at 60 tiles: inside that, the creature is on its own
// again and does not trudge home.
func TestLeashOnlyBeyond60(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx+500, gy+500

	c := f.spawnAt("crawler", gx, gy, true)
	c.HomeI, c.HasHome = ti(gx-59, gy), true // 59 tiles: inside the leash
	f.r.tickN++
	f.r.stepCreature(c, 1, f.now)
	if c.X != gx || c.Y != gy {
		t.Fatalf("a creature 59 tiles from home walked home: moved to %.4f,%.4f", c.X, c.Y)
	}
}

// The despawn-at-home branch is unreachable, exactly as it is in
// server/index.js: `distHome < 1` is nested inside `distHome > 60`. A leashed
// creature therefore walks back to the 60-tile boundary and keeps living. This
// test pins that behaviour so the dead branch is not "fixed" into life by
// accident, which would silently shorten every creature's lifetime.
func TestLeashedCreatureNeverDespawnsAtHome(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx+500, gy+500

	c := f.spawnAt("crawler", gx, gy, true)
	c.HomeI, c.HasHome = ti(gx-61, gy), true
	for step := 0; step < 3000; step++ {
		f.r.tickN++
		if _, alive := f.r.creatures[c.ID]; !alive {
			t.Fatal("a leashed creature despawned; the legacy despawn branch is unreachable")
		}
		f.r.stepCreature(c, 1, f.now)
	}
	if _, alive := f.r.creatures[c.ID]; !alive {
		t.Fatal("leashed creature vanished")
	}
}

// A player within 20 tiles suppresses the leash entirely: the creature hunts
// instead of walking home.
func TestLeashSuppressedByNearbyPlayer(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	c := f.spawnAt("crawler", gx, gy, true)
	c.HomeI, c.HasHome = ti(gx-61, gy), true
	// player due east, inside both the 20-tile leash guard and the chase radius
	f.p.X, f.p.Y, f.p.Z = gx+2, gy, 0

	f.r.tickN++
	f.r.stepCreature(c, 1, f.now)
	if c.X <= gx {
		t.Fatalf("creature moved toward home (west) with a player 2 tiles east: x %.4f -> %.4f", gx, c.X)
	}
}

// Stalkers and frost wraiths despawn at dawn when no player is within 12;
// everything else survives the sunrise.
func TestDawnDespawn(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx-500, gy-500

	f.setNight()
	st := f.spawnAt("stalker", gx, gy, false)
	fw := f.spawnAt("frost_wraith", gx+1, gy, false)
	cr := f.spawnAt("crawler", gx+2, gy, false)
	f.r.tickN = 1
	f.r.creatureTick(1, f.now)
	if _, ok := f.r.creatures[st.ID]; !ok {
		t.Fatal("stalker despawned at night")
	}

	f.setDay()
	f.r.tickN = 2
	f.r.creatureTick(1, f.now)
	if _, ok := f.r.creatures[st.ID]; ok {
		t.Error("stalker survived dawn with no player within 12")
	}
	if _, ok := f.r.creatures[fw.ID]; ok {
		t.Error("frost wraith survived dawn with no player within 12")
	}
	if _, ok := f.r.creatures[cr.ID]; !ok {
		t.Error("crawler despawned at dawn — only stalkers and frost wraiths do")
	}

	// with a player inside 12, the stalker stays
	f2 := newFixture(t)
	f2.setDay()
	f2.p.X, f2.p.Y = gx+5, gy
	st2 := f2.spawnAt("stalker", gx, gy, false)
	f2.r.tickN = 1
	f2.r.creatureTick(1, f2.now)
	if _, ok := f2.r.creatures[st2.ID]; !ok {
		t.Error("stalker despawned at dawn with a player 5 tiles away")
	}
}

// --- ordered mirrors -------------------------------------------------------

// The map and its ordered mirror must never disagree. A drifted mirror is the
// bug class the mirrors exist to make impossible, so it gets its own test.
func TestOrderedMirrorsStayConsistent(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	var ids []string
	for i := 0; i < 8; i++ {
		ids = append(ids, f.spawnAt("crawler", gx+float64(i), gy, false).ID)
	}
	for i, c := range f.r.creOrder {
		if c.ID != ids[i] {
			t.Fatalf("creOrder[%d] = %s, want spawn order %s", i, c.ID, ids[i])
		}
	}
	for _, n := range []int{3, 0, 7} { // middle and both ends
		f.r.delCreature(ids[n])
	}
	if len(f.r.creOrder) != len(f.r.creatures) {
		t.Fatalf("mirror drift: creOrder=%d creatures=%d", len(f.r.creOrder), len(f.r.creatures))
	}
	for _, c := range f.r.creOrder {
		if _, ok := f.r.creatures[c.ID]; !ok {
			t.Fatalf("creOrder holds %s, which is not in the map", c.ID)
		}
	}
	f.r.delCreature(ids[0]) // deleting twice is a no-op, not a corruption
	if len(f.r.creOrder) != len(f.r.creatures) {
		t.Fatal("a repeated delete corrupted the mirror")
	}
}

// A creature that despawns mid-pass must not be stepped again in the same tick.
func TestCreatureTickSkipsCreaturesRemovedMidPass(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx-500, gy-500
	f.setDay()
	for i := 0; i < 5; i++ {
		f.spawnAt("stalker", gx+float64(i), gy, false)
	}
	f.r.tickN = 1
	f.r.creatureTick(1, f.now) // dawn despawn removes all five
	if len(f.r.creatures) != 0 || len(f.r.creOrder) != 0 {
		t.Fatalf("dawn despawn left %d creatures / %d in the mirror",
			len(f.r.creatures), len(f.r.creOrder))
	}
}

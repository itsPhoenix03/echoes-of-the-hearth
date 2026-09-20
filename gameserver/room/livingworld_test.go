package room

import (
	"math"
	"testing"

	"hearth/gameserver/world"
)

// Slice 3, part two: what a landed swing does, what contact damage does to a
// player, wildlife behaviour and the weather damage/shelter rules.

// --- creature damage, knockback and drops ----------------------------------

// A surviving hit knocks the creature back along the swing angle, stuns it for
// three ticks and correlates the chit back to the swing via by + seq.
func TestCreatureHitKnockbackStunAndCorrelation(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = "" // dmg 1

	// bog shambler: 10 hp at strength 1, so it survives a bare-handed hit
	c := f.spawnAt("bog_shambler", gx+1, gy, false)
	hpBefore := c.HP
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk", "seq": float64(77), "dx": float64(1)})

	if c.HP != hpBefore-1 {
		t.Fatalf("hp %d -> %d, want -1", hpBefore, c.HP)
	}
	if c.Stun != 3 {
		t.Fatalf("stun = %d, want 3", c.Stun)
	}
	// heavies take the 0.3 knockback, not 0.9
	if moved := c.X - (gx + 1); math.Abs(moved-0.3) > 1e-9 {
		t.Fatalf("bog shambler knocked back %.4f tiles, want 0.3", moved)
	}

	act := f.lastOfType("act")
	if act == nil || act["targetI"] != c.ID {
		t.Fatalf("act.targetI = %v, want the struck creature id %q", act["targetI"], c.ID)
	}
	chit := f.lastOfType("chit")
	if chit == nil {
		t.Fatal("no chit for a survived hit")
	}
	if chit["id"] != c.ID {
		t.Fatalf("chit.id = %v, want %q", chit["id"], c.ID)
	}
	if chit["by"] != f.p.S.ID {
		t.Fatalf("chit.by = %v, want %q", chit["by"], f.p.S.ID)
	}
	if chit["seq"] != float64(77) {
		t.Fatalf("chit.seq = %v, want 77", chit["seq"])
	}
	ang, isNum := chit["ang"].(float64)
	if !isNum {
		t.Fatalf("chit.ang = %v, want a number", chit["ang"])
	}
	// the creature is due east, so the push angle is ~0
	if math.Abs(ang) > 1e-9 {
		t.Fatalf("chit.ang = %f, want ~0 for a target due east", ang)
	}
}

// A light creature takes the 0.9 knockback, and a struck wisp flees and
// corrupts the ground it left.
func TestCreatureKnockbackLightAndWispReaction(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = ""
	c := f.spawnAt("wisp", gx+1, gy, false) // 3 hp, survives a bare hand
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if moved := c.X - (gx + 1); math.Abs(moved-0.9) > 1e-9 {
		t.Fatalf("wisp knocked back %.4f tiles, want 0.9", moved)
	}
	if c.FleeTk != 10 {
		t.Fatalf("struck wisp fleeTicks = %d, want 10", c.FleeTk)
	}
	// the flee heading points away from the attacker
	if math.Abs(math.Abs(c.FleeAng)-math.Pi) > 1e-9 {
		t.Fatalf("wisp flee angle = %f, want +/-pi (away from a player due west)", c.FleeAng)
	}
	if !f.r.isInfected(ti(c.X, c.Y)) {
		t.Error("a struck wisp did not corrupt the tile it fled from")
	}
}

// A killing blow removes the creature from both mirrors, drops essence and
// emits no chit.
func TestCreatureKillDropsEssenceAndNoChit(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = "isword" // dmg 5
	c := f.spawnAt("crawler", gx+1, gy, false)
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk", "seq": float64(5)})

	if _, alive := f.r.creatures[c.ID]; alive {
		t.Fatal("crawler survived 5 damage with 2 hp")
	}
	if len(f.r.creOrder) != 0 {
		t.Fatalf("creOrder leaked a dead creature: %d entries", len(f.r.creOrder))
	}
	if f.p.Inv["essence"] < 1 || f.p.Inv["essence"] > 2 {
		t.Fatalf("crawler essence drop = %d, want 1 or 2", f.p.Inv["essence"])
	}
	if m := f.lastOfType("chit"); m != nil {
		t.Fatal("a killing blow emitted a chit")
	}
	// act still fires on the swing, and still names the target it killed
	if act := f.lastOfType("act"); act == nil || act["targetI"] != c.ID {
		t.Fatalf("act.targetI = %v on a killing blow, want %q", act["targetI"], c.ID)
	}
}

// Drop sizes are per type: heavies drop 4, wisps and wraiths 3, everything else
// 1, each with a 40% chance of one extra.
func TestEssenceDropSizes(t *testing.T) {
	for _, tc := range []struct {
		typ  string
		base int
	}{
		{"brute", 4}, {"bog_shambler", 4},
		{"wisp", 3}, {"frost_wraith", 3},
		{"crawler", 1}, {"stalker", 1}, {"drowned", 1}, {"blight_lancer", 1},
	} {
		f := newFixture(t)
		gx, gy := landTile(t, f.r.world, world.TGrass)
		f.stand(gx, gy, 0)
		c := f.spawnAt(tc.typ, gx+1, gy, false)
		c.HP = 1
		f.p.Equip = "isword"
		f.r.handleAtk(f.p, map[string]any{"t": "atk"})
		got := f.p.Inv["essence"]
		if got != tc.base && got != tc.base+1 {
			t.Errorf("%s essence drop = %d, want %d or %d", tc.typ, got, tc.base, tc.base+1)
		}
	}
}

// Killing a husk wolf yields meat, not essence.
func TestHuskWolfDropsMeat(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = "isword"
	f.spawnAt("husk_wolf", gx+1, gy, false)
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if f.p.Inv["meat"] != 1 {
		t.Fatalf("husk wolf meat = %d, want exactly 1", f.p.Inv["meat"])
	}
	if f.p.Inv["essence"] != 0 {
		t.Fatalf("husk wolf dropped essence: %d", f.p.Inv["essence"])
	}
}

// Killing a bog shambler corrupts its tile and the four orthogonals.
func TestBogShamblerDeathCorruption(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = "isword"
	c := f.spawnAt("bog_shambler", gx+1, gy, false)
	c.HP = 1
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	for _, d := range [5][2]float64{{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
		i := ti(gx+1+d[0], gy+d[1])
		if !f.r.isInfected(i) {
			t.Errorf("bog shambler death left tile %+v uncorrupted", d)
		}
	}
	if m := f.lastOfType("infect"); m == nil {
		t.Fatal("no infect broadcast on bog shambler death")
	}
}

// Striking a crawler enrages every crawler and wolf within 10 tiles, and
// nothing beyond it.
func TestPackEnrageRadius(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	f.p.Equip = ""
	target := f.spawnAt("bog_shambler", gx+1, gy, false) // heavy: survives
	near := f.spawnAt("crawler", gx+1+9, gy, false)
	far := f.spawnAt("crawler", gx+1+11, gy, false)
	other := f.spawnAt("stalker", gx+1+2, gy, false)

	// a bog shambler is not a pack animal, so striking it enrages nothing
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if near.Enraged != 0 {
		t.Fatal("striking a bog shambler enraged a crawler")
	}
	_ = target

	// striking a crawler does
	f2 := newFixture(t)
	f2.stand(gx, gy, 0)
	f2.p.Equip = ""
	cr := f2.spawnAt("crawler", gx+1, gy, false)
	cr.HP = 5 // survive the hit
	near2 := f2.spawnAt("crawler", gx+1+9, gy, false)
	far2 := f2.spawnAt("crawler", gx+1+11, gy, false)
	wolf := f2.spawnAt("husk_wolf", gx+1+5, gy, false)
	other2 := f2.spawnAt("stalker", gx+1+2, gy, false)
	f2.r.handleAtk(f2.p, map[string]any{"t": "atk"})
	if near2.Enraged != 100 {
		t.Errorf("crawler 9 tiles away enraged = %d, want 100", near2.Enraged)
	}
	if wolf.Enraged != 100 {
		t.Errorf("husk wolf 5 tiles away enraged = %d, want 100", wolf.Enraged)
	}
	if far2.Enraged != 0 {
		t.Errorf("crawler 11 tiles away enraged = %d, want 0", far2.Enraged)
	}
	if other2.Enraged != 0 {
		t.Errorf("a stalker was enraged; only crawlers and wolves are pack animals")
	}
	_ = other
	_ = far
}

// --- contact damage --------------------------------------------------------

// Contact damage stamps LastDamageAt and carries the push angle.
func TestCreatureContactDamage(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP = 10
	f.p.LastDamageAt = 0

	c := f.spawnAt("crawler", gx+0.5, gy, false)
	f.r.tickN = 5 // contact damage runs every fifth tick
	f.reset()
	f.r.stepCreature(c, 1, f.now)
	if f.p.HP != 9 {
		t.Fatalf("crawler contact damage left hp %d, want 9", f.p.HP)
	}
	if f.p.LastDamageAt != f.now {
		t.Fatal("contact damage did not stamp LastDamageAt — the medic lockout depends on it")
	}
	hp := f.lastOfType("hp")
	if hp == nil {
		t.Fatal("no hp frame after contact damage")
	}
	if _, isNum := hp["ang"].(float64); !isNum {
		t.Fatalf("hp.ang = %v, want a number", hp["ang"])
	}
}

// Contact damage only lands on ticks that are multiples of five.
func TestContactDamageCadence(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP = 10
	c := f.spawnAt("crawler", gx+0.5, gy, false)
	for _, tn := range []int64{1, 2, 3, 4, 6, 7} {
		f.r.tickN = tn
		c.X, c.Y = gx+0.5, gy // hold it in contact range
		c.Stun = 0
		f.r.stepCreature(c, 1, f.now)
	}
	if f.p.HP != 10 {
		t.Fatalf("contact damage landed off the 5-tick cadence: hp %d", f.p.HP)
	}
}

// A brute deals 2, and only after its telegraph windup is spent.
func TestBruteWindupThenDamage(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP = 10
	b := f.spawnAt("brute", gx+0.5, gy, false)

	f.r.tickN = 5
	f.reset()
	f.r.stepCreature(b, 1, f.now) // triggers the windup, deals nothing
	if f.p.HP != 10 {
		t.Fatalf("brute damaged during its telegraph windup: hp %d", f.p.HP)
	}
	if !b.WindupTriggered {
		t.Fatal("brute did not enter its windup with a player 0.5 tiles away")
	}
	if b.Windup != 8 {
		t.Fatalf("brute windup = %d, want 8", b.Windup)
	}
	if m := f.lastOfType("ctel"); m == nil || m["id"] != b.ID {
		t.Fatalf("no ctel telegraph broadcast for the brute: %v", m)
	}

	// spend the windup, then land on a 5-tick boundary
	for i := 0; i < 8; i++ {
		f.r.tickN++
		f.r.stepCreature(b, 1, f.now)
	}
	if b.Windup != 0 {
		t.Fatalf("brute windup did not run out: %d", b.Windup)
	}
	f.r.tickN = 20
	f.p.HP = 10
	b.X, b.Y = gx+0.5, gy
	f.r.stepCreature(b, 1, f.now)
	if f.p.HP != 8 {
		t.Fatalf("brute contact damage left hp %d, want 8 (2 damage)", f.p.HP)
	}
}

// The frost wraith's contact damage carries the slow.
func TestFrostWraithSlow(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TSnow)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP = 10
	c := f.spawnAt("frost_wraith", gx+0.5, gy, false)
	f.r.tickN = 5
	f.reset()
	f.r.stepCreature(c, 1, f.now)
	if f.p.HP != 9 {
		t.Fatalf("frost wraith contact damage left hp %d, want 9", f.p.HP)
	}
	m := f.lastOfType("slow")
	if m == nil {
		t.Fatal("frost wraith contact damage sent no slow")
	}
	if m["ticks"] != float64(30) {
		t.Fatalf("slow.ticks = %v, want 30", m["ticks"])
	}
}

// A wisp deals no contact damage at all: its CRE_TYPES damage is zero.
func TestWispDealsNoContactDamage(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP = 10
	c := f.spawnAt("wisp", gx+0.5, gy, false)
	c.DX, c.DY = 0, 0
	for _, tn := range []int64{5, 10, 15, 20} {
		f.r.tickN = tn
		c.X, c.Y = gx+0.5, gy
		f.r.stepCreature(c, 1, f.now)
	}
	if f.p.HP != 10 {
		t.Fatalf("a wisp dealt contact damage: hp %d", f.p.HP)
	}
}

// A player who is underground or indoors takes no contact damage.
func TestNoContactDamageOffSurface(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 1
	f.p.HP = 10
	c := f.spawnAt("crawler", gx+0.5, gy, false)
	f.r.tickN = 5
	f.r.stepCreature(c, 1, f.now)
	if f.p.HP != 10 {
		t.Fatalf("a creature reached a player underground: hp %d", f.p.HP)
	}
}

// A creature underground or indoors cannot be hit: the atk z-guard refuses the
// swing before the target scan.
func TestAtkRefusedOffSurface(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 1)
	c := f.spawnAt("crawler", gx+1, gy, false)
	hp := c.HP
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk", "seq": float64(3)})
	if c.HP != hp {
		t.Fatal("a swing from underground hit a surface creature")
	}
	if m := f.lastOfType("actReject"); m == nil || m["reason"] != "wrong_z" {
		t.Fatalf("expected a wrong_z rejection, got %v", m)
	}
}

// A creature just beyond 2.4 tiles is out of reach, and the swing falls through
// to the structure-demolition branch instead.
func TestAtkReachIs24Tiles(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.stand(gx, gy, 0)
	c := f.spawnAt("crawler", gx+2.5, gy, false)
	hp := c.HP
	f.reset()
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if c.HP != hp {
		t.Fatal("a creature 2.5 tiles away was hit; the reach is 2.4")
	}
	if act := f.lastOfType("act"); act == nil || act["targetI"] != nil {
		t.Fatalf("act.targetI = %v on a miss, want null", act["targetI"])
	}
}

// --- animals ---------------------------------------------------------------

// Animals flee from players at their species speed, and drop meat by size.
func TestAnimalFleeAndMeatDrop(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)

	// a boar (flee radius 3, speed 0.3) runs from a player at 2 tiles
	a := &Animal{ID: "a1", X: gx, Y: gy, HP: 4, Type: "boar", Home: world.TGrass}
	f.r.addAnimal(a)
	f.p.X, f.p.Y = gx-2, gy
	f.r.tickN = 1
	before := math.Hypot(a.X-f.p.X, a.Y-f.p.Y)
	f.r.animalTick()
	if after := math.Hypot(a.X-f.p.X, a.Y-f.p.Y); after <= before {
		t.Fatalf("boar did not flee: distance %.3f -> %.3f", before, after)
	}
	if moved := math.Hypot(a.X-gx, a.Y-gy); math.Abs(moved-0.3) > 1e-9 {
		t.Fatalf("boar fled %.4f tiles, want its flee speed 0.3", moved)
	}

	// killing it yields 3 meat (its ANIMAL_TYPES size) plus a possible bonus
	f.stand(a.X, a.Y, 0)
	f.p.Equip = "isword"
	f.r.handleAtk(f.p, map[string]any{"t": "atk"})
	if _, alive := f.r.animals[a.ID]; alive {
		t.Fatal("boar survived 5 damage with 4 hp")
	}
	if f.p.Inv["meat"] < 3 || f.p.Inv["meat"] > 4 {
		t.Fatalf("boar meat drop = %d, want 3 or 4", f.p.Inv["meat"])
	}
	if len(f.r.aniOrder) != 0 {
		t.Fatalf("aniOrder leaked a dead animal: %d entries", len(f.r.aniOrder))
	}
}

// Every species has its documented meat size, and a wandering animal outside
// its flee radius does not run.
func TestAnimalMeatSizesAndFleeRadius(t *testing.T) {
	for _, tc := range []struct {
		typ  string
		meat int
	}{
		{"deer", 2}, {"boar", 3}, {"lizard", 1}, {"crab", 1},
		{"fox", 2}, {"hare", 1}, {"toad", 1},
	} {
		if got := animalTypes[tc.typ].meat; got != tc.meat {
			t.Errorf("%s meat = %d, want %d", tc.typ, got, tc.meat)
		}
	}
	// a crab has flee radius 5; a player 6 tiles away does not spook it
	f := newFixture(t)
	sx, sy := landTile(t, f.r.world, world.TSand)
	a := &Animal{ID: "a1", X: sx, Y: sy, HP: 1, Type: "crab", Home: world.TSand,
		DX: 0, DY: 0, TW: 100}
	f.r.addAnimal(a)
	f.p.X, f.p.Y = sx-6, sy
	f.r.animalTick()
	if a.X != sx || a.Y != sy {
		t.Fatalf("crab moved with a player 6 tiles away and a full wander timer: %.3f,%.3f", a.X, a.Y)
	}
}

// Animals never leave their home biome: a step onto a foreign tile is refused
// and the animal reverses instead.
func TestAnimalStaysOnBiome(t *testing.T) {
	f := newFixture(t)
	bx, by, ok := findTile(f.r.world, func(i int) bool {
		x, y := i%world.SIZE, i/world.SIZE
		if x < 10 || y < 10 || x >= world.SIZE-10 || y >= world.SIZE-10 {
			return false
		}
		return f.r.world.Tiles[i] == world.TGrass && f.r.world.Tiles[i+1] != world.TGrass
	})
	if !ok {
		t.Skip("no grass/non-grass boundary in this world")
	}
	f.p.X, f.p.Y = float64(bx)-500, float64(by)-500 // nobody near, so no flee
	a := &Animal{ID: "a1", X: float64(bx) + 0.95, Y: float64(by), HP: 2,
		Type: "deer", Home: world.TGrass, DX: 1, DY: 0, TW: 100}
	f.r.addAnimal(a)
	f.r.animalTick()
	if f.r.tileAtXY(a.X, a.Y) != world.TGrass {
		t.Fatalf("deer left GRASS onto tile %d at %.2f,%.2f", f.r.tileAtXY(a.X, a.Y), a.X, a.Y)
	}
	if a.DX != -1 {
		t.Fatalf("a blocked animal did not reverse: dx=%v", a.DX)
	}
}

// The wildlife population is capped at 20, the spawn only runs every fifth
// tick, and every animal lands on its own biome.
func TestAnimalSpawnCapCadenceAndBiome(t *testing.T) {
	f := newFixture(t)
	f.p.X, f.p.Y = landTile(t, f.r.world, world.TGrass)
	f.r.tickN = 1
	for i := 0; i < 200; i++ {
		f.r.animalSpawnTick()
	}
	if len(f.r.animals) != 0 {
		t.Fatalf("wildlife spawned on a tick that is not a multiple of 5: %d", len(f.r.animals))
	}
	f.r.tickN = 5
	for i := 0; i < 5000; i++ {
		f.r.animalSpawnTick()
	}
	if len(f.r.animals) == 0 {
		t.Fatal("no wildlife spawned at all near a player on grass")
	}
	if len(f.r.animals) > 20 {
		t.Fatalf("wildlife population %d exceeds the cap of 20", len(f.r.animals))
	}
	for _, a := range f.r.aniOrder {
		if f.r.tileAtXY(a.X, a.Y) != animalTypes[a.Type].home {
			t.Fatalf("%s spawned on tile %d, want its home tile %d", a.Type,
				f.r.tileAtXY(a.X, a.Y), animalTypes[a.Type].home)
		}
	}
}

// A fleeing animal does not burn its wander timer: the legacy condition
// short-circuits before the decrement.
func TestFleeingAnimalKeepsWanderTimer(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	a := &Animal{ID: "a1", X: gx, Y: gy, HP: 2, Type: "deer", Home: world.TGrass, TW: 7}
	f.r.addAnimal(a)
	f.p.X, f.p.Y = gx-1, gy // inside the deer flee radius of 4
	f.r.animalTick()
	if a.TW != 7 {
		t.Fatalf("a fleeing animal burned its wander timer: tw = %v, want 7", a.TW)
	}
}

// --- infection -------------------------------------------------------------

// A wisp corrupts the tile it drifts over every 25 ticks, and the corruption
// cures itself 120 seconds later.
func TestWispInfectionSpreadAndCure(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx-500, gy-500
	w := f.spawnAt("wisp", gx, gy, false)
	w.DX, w.DY = 0, 0 // stand still so the infected tile is predictable
	w.TW = 100

	f.r.tickN = 25
	f.r.stepCreature(w, 1, f.now)
	tile := ti(w.X, w.Y)
	if !f.r.isInfected(tile) {
		t.Fatalf("wisp did not infect tile %d on tick 25", tile)
	}
	if len(f.r.infOrder) != 1 || f.r.infOrder[0] != tile {
		t.Fatalf("infOrder mirror is wrong: %v", f.r.infOrder)
	}
	if got, want := f.r.infected[tile], f.now+120000; got != want {
		t.Fatalf("cure timer = %d, want %d (120s)", got, want)
	}

	// 119s in: still corrupt.
	f.r.infectionDecayTick(f.now + 119_000)
	if !f.r.isInfected(tile) {
		t.Fatal("corruption cured before its 120s timer expired")
	}
	// past 120s: cured, broadcast, and both mirrors cleared.
	f.reset()
	f.r.infectionDecayTick(f.now + 120_001)
	if f.r.isInfected(tile) {
		t.Fatal("corruption outlived its 120s cure timer")
	}
	if len(f.r.infOrder) != 0 {
		t.Fatalf("infOrder still holds %v after the cure", f.r.infOrder)
	}
	m := f.lastOfType("cure")
	if m == nil {
		t.Fatal("no cure broadcast when the corruption expired")
	}
	tiles, ok := m["tiles"].([]any)
	if !ok || len(tiles) != 1 || tiles[0] != float64(tile) {
		t.Fatalf("cure.tiles = %v, want [%d]", m["tiles"], tile)
	}
}

// A wisp never corrupts water, existing blight, an already-infected tile or a
// tile under a structure.
func TestWispInfectionExclusions(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y = gx-500, gy-500

	// under a structure: no infection
	f.r.structures[ti(gx, gy)] = &Structure{Kind: "wall", HP: 20, Lvl: 1}
	w := f.spawnAt("wisp", gx, gy, false)
	w.DX, w.DY, w.TW = 0, 0, 100
	f.r.tickN = 25
	f.r.stepCreature(w, 1, f.now)
	if f.r.isInfected(ti(gx, gy)) {
		t.Error("wisp infected a tile occupied by a structure")
	}
	delete(f.r.structures, ti(gx, gy))

	// on water: no infection
	if wx, wy, ok := findTile(f.r.world, func(i int) bool {
		x, y := i%world.SIZE, i/world.SIZE
		return f.r.world.Tiles[i] == world.TWater && x > 10 && y > 10
	}); ok {
		w2 := f.spawnAt("wisp", float64(wx), float64(wy), false)
		w2.DX, w2.DY, w2.TW = 0, 0, 100
		f.r.tickN = 25
		f.r.stepCreature(w2, 1, f.now)
		if f.r.isInfected(ti(float64(wx), float64(wy))) {
			t.Error("wisp infected a water tile")
		}
	}

	// on existing blight: no infection
	if bx, by, ok := findTile(f.r.world, func(i int) bool {
		x, y := i%world.SIZE, i/world.SIZE
		return f.r.world.Tiles[i] == world.TBlight && x > 10 && y > 10
	}); ok {
		w3 := f.spawnAt("wisp", float64(bx), float64(by), false)
		w3.DX, w3.DY, w3.TW = 0, 0, 100
		f.r.tickN = 25
		f.r.stepCreature(w3, 1, f.now)
		if f.r.isInfected(ti(float64(bx), float64(by))) {
			t.Error("wisp infected an already-blighted tile")
		}
	}
}

// setInfected is idempotent: re-infecting a live tile refreshes the timer
// without duplicating the ordered mirror.
func TestSetInfectedIdempotent(t *testing.T) {
	f := newFixture(t)
	f.r.setInfected(1234, 100)
	f.r.setInfected(1234, 900)
	if len(f.r.infOrder) != 1 {
		t.Fatalf("infOrder duplicated a tile: %v", f.r.infOrder)
	}
	if f.r.infected[1234] != 900 {
		t.Fatalf("re-infection did not refresh the timer: %d", f.r.infected[1234])
	}
	f.r.delInfected(1234)
	f.r.delInfected(1234) // repeat delete must not corrupt anything
	if len(f.r.infOrder) != 0 || len(f.r.infected) != 0 {
		t.Fatalf("delInfected left %v / %v", f.r.infOrder, f.r.infected)
	}
}

// --- weather ---------------------------------------------------------------

// A sandstorm chips a player standing on sand with no structure within 2 tiles,
// and any structure inside 2 shelters them.
func TestSandstormDamageAndShelter(t *testing.T) {
	f := newFixture(t)
	sx, sy := landTile(t, f.r.world, world.TSand)
	f.p.X, f.p.Y, f.p.Z = sx, sy, 0
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.p.Worn = "heatcloak" // rule out the plain desert-heat branch
	f.r.weather.kind = "sandstorm"
	f.r.weather.until = f.now + 60000

	f.reset()
	f.r.survivalTick()
	if f.p.HP != 9 {
		t.Fatalf("sandstorm left hp %d, want 9", f.p.HP)
	}
	if m := f.lastOfType("msg"); m == nil || m["s"] != "The sandstorm flays you — shelter beside a structure!" {
		t.Fatalf("expected the sandstorm message, got %v", m)
	}

	// a structure 2 tiles away is shelter
	f.r.structures[ti(sx+2, sy)] = &Structure{Kind: "wall", HP: 20, Lvl: 1}
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.r.survivalTick()
	if f.p.HP != 10 {
		t.Fatalf("a structure 2 tiles away did not shelter from the sandstorm: hp %d", f.p.HP)
	}
}

// A snowstorm chips a player on snow unless a campfire is within 6 — a fur
// cloak is not enough, which is what separates the blizzard from ordinary cold.
func TestSnowstormNeedsCampfireNotCloak(t *testing.T) {
	f := newFixture(t)
	sx, sy := landTile(t, f.r.world, world.TSnow)
	f.p.X, f.p.Y, f.p.Z = sx, sy, 0
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.p.Worn = "furcloak"
	f.r.weather.kind = "snowstorm"
	f.r.weather.until = f.now + 60000

	f.reset()
	f.r.survivalTick()
	if f.p.HP != 9 {
		t.Fatalf("a fur cloak blocked the blizzard: hp %d, want 9", f.p.HP)
	}
	if m := f.lastOfType("msg"); m == nil || m["s"] != "The blizzard freezes you — get to a campfire!" {
		t.Fatalf("expected the blizzard message, got %v", m)
	}

	// a campfire 6 tiles away is shelter; a plain wall is not
	f.r.structures[ti(sx+6, sy)] = &Structure{Kind: "wall", HP: 20, Lvl: 1}
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.r.survivalTick()
	if f.p.HP != 9 {
		t.Fatalf("a wall sheltered from the blizzard: hp %d, want 9", f.p.HP)
	}
	f.r.structures[ti(sx+6, sy)] = &Structure{Kind: "campfire", HP: 10, Lvl: 1}
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.r.survivalTick()
	if f.p.HP != 10 {
		t.Fatalf("a campfire 6 tiles away did not shelter from the blizzard: hp %d", f.p.HP)
	}
}

// Rain is cosmetic: it never damages anyone.
func TestRainIsHarmless(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP, f.p.Hunger, f.p.Thirst = 5, 10, 10
	f.r.weather.kind = "rain"
	f.r.weather.until = f.now + 60000
	f.r.survivalTick()
	if f.p.HP != 5 {
		t.Fatalf("rain changed hp to %d, want 5", f.p.HP)
	}
}

// Weather only bites on its own biome: a sandstorm does not touch a player
// standing on grass.
func TestWeatherIsBiomeScoped(t *testing.T) {
	f := newFixture(t)
	gx, gy := landTile(t, f.r.world, world.TGrass)
	f.p.X, f.p.Y, f.p.Z = gx, gy, 0
	f.p.HP, f.p.Hunger, f.p.Thirst = 5, 10, 10
	f.r.weather.kind = "sandstorm"
	f.r.weather.until = f.now + 60000
	f.r.survivalTick()
	if f.p.HP != 5 {
		t.Fatalf("a sandstorm hurt a player on grass: hp %d", f.p.HP)
	}
}

// Being underground or indoors shelters from every weather front.
func TestWeatherShelteredOffSurface(t *testing.T) {
	f := newFixture(t)
	sx, sy := landTile(t, f.r.world, world.TSand)
	f.p.X, f.p.Y, f.p.Z = sx, sy, 1
	f.p.HP, f.p.Hunger, f.p.Thirst = 10, 10, 10
	f.r.weather.kind = "sandstorm"
	f.r.weather.until = f.now + 60000
	f.r.survivalTick()
	if f.p.HP != 10 {
		t.Fatalf("a sandstorm reached a player underground: hp %d", f.p.HP)
	}
}

// A weather front expires on its own clock and clears with a wx broadcast.
func TestWeatherExpiry(t *testing.T) {
	f := newFixture(t)
	f.r.weather.kind = "sandstorm"
	f.r.weather.until = f.now + 1000
	f.reset()
	f.r.weatherTick(f.now + 500)
	if f.r.weather.kind != "sandstorm" {
		t.Fatal("weather cleared before its expiry")
	}
	f.r.weatherTick(f.now + 1001)
	if f.r.weather.kind != "" {
		t.Fatalf("weather did not clear past its expiry: %q", f.r.weather.kind)
	}
	m := f.lastOfType("wx")
	if m == nil {
		t.Fatal("no wx broadcast when the weather cleared")
	}
	if m["kind"] != nil {
		t.Fatalf("wx.kind = %v on clear, want null", m["kind"])
	}
}

// Every started front is one of the three legacy kinds and lasts 45-90 seconds.
func TestWeatherOnsetKindsAndDuration(t *testing.T) {
	f := newFixture(t)
	kinds := map[string]bool{}
	started := 0
	for i := 0; i < 400000 && started < 60; i++ {
		f.r.weather.kind, f.r.weather.until = "", 0
		f.r.weatherTick(f.now)
		if f.r.weather.kind == "" {
			continue
		}
		started++
		kinds[f.r.weather.kind] = true
		switch f.r.weather.kind {
		case "rain", "sandstorm", "snowstorm":
		default:
			t.Fatalf("unknown weather kind %q", f.r.weather.kind)
		}
		if d := f.r.weather.until - f.now; d < 45000 || d > 90000 {
			t.Fatalf("weather duration %dms, want 45000-90000", d)
		}
	}
	if started == 0 {
		t.Fatal("no weather front ever started")
	}
	for _, k := range weatherKinds {
		if !kinds[k] {
			t.Errorf("weather kind %q never rolled in %d onsets", k, started)
		}
	}
}

package room

import (
	"testing"

	"hearth/gameserver/persist"
)

// --- Starmetal Armor -------------------------------------------------------

func (f *fixture) wear(k any) {
	f.r.handleWear(f.p, map[string]any{"t": "wear", "k": k})
}

// The recipe is a late-game bill at the forge, and it is gear (crafted once).
func TestArmorRecipeIsLateGameGear(t *testing.T) {
	f := newFixture(t)
	rec, ok := f.r.defs.Recipes[ArmorKey]
	if !ok {
		t.Fatal("no starmetal_armor recipe")
	}
	if st, _ := rec.StationName(); !rec.Gear || st != "forge" {
		t.Fatalf("armor should be forge gear, got %+v", rec)
	}
	total := 0
	for _, n := range rec.Cost {
		total += n
	}
	if rec.Cost["starmetal"] < 10 || rec.Cost["diamond"] < 1 || total < 40 {
		t.Fatalf("armor is too cheap to be a long-term goal: %v", rec.Cost)
	}
	if _, still := f.r.defs.Recipes["starmetal_plate"]; still {
		t.Fatal("starmetal_plate should have become the armor")
	}
}

// Wearing needs the gear; it toggles in its own slot and stacks with a cloak.
func TestArmorWearToggleStacksWithCloak(t *testing.T) {
	f := newFixture(t)
	f.wear(ArmorKey)
	if f.p.Armor {
		t.Fatal("armor went on without being crafted")
	}
	f.p.Gear[ArmorKey] = true
	f.p.Gear["furcloak"] = true
	f.wear("furcloak")
	f.wear(ArmorKey)
	if !f.p.Armor || f.p.Worn != "furcloak" {
		t.Fatalf("armor and cloak should both be on: armor=%v worn=%q", f.p.Armor, f.p.Worn)
	}
	var worn map[string]any
	for _, m := range f.drain() {
		if m["t"] == "worn" {
			worn = m
		}
	}
	if worn == nil || worn["armor"] != true || worn["k"] != "furcloak" {
		t.Fatalf("other clients were not told about the armor: %v", worn)
	}
	// taking the cloak off leaves the armor on
	f.wear(nil)
	if !f.p.Armor || f.p.Worn != "" {
		t.Fatalf("removing the cloak touched the armor: armor=%v worn=%q", f.p.Armor, f.p.Worn)
	}
	f.wear(ArmorKey)
	if f.p.Armor {
		t.Fatal("a second wear did not take the armor off")
	}
}

// Armored, creature hits cost half — a 1-damage hit lands every other time.
func TestArmorHalvesCreatureDamage(t *testing.T) {
	f := newFixture(t)
	c := f.spawnAt("crawler", f.p.X+0.5, f.p.Y, false)

	f.p.HP = 10
	for i := 0; i < 4; i++ {
		f.r.hitPlayer(f.p, c, 1, f.now, false)
	}
	if f.p.HP != 6 {
		t.Fatalf("unarmored: 4 hits of 1 left %d HP, want 6", f.p.HP)
	}

	f.p.Gear[ArmorKey] = true
	f.wear(ArmorKey)
	f.p.HP = 10
	f.drain()
	for i := 0; i < 4; i++ {
		f.r.hitPlayer(f.p, c, 1, f.now, false)
	}
	if f.p.HP != 8 {
		t.Fatalf("armored: 4 hits of 1 left %d HP, want 8", f.p.HP)
	}
	blocked := 0
	for _, m := range f.drain() {
		if m["t"] == "hp" && m["blocked"] != nil {
			blocked++
		}
	}
	// every other 1-damage hit is absorbed outright; the rest land in full
	if blocked != 2 {
		t.Fatalf("%d of 4 armored hits reported a block, want 2", blocked)
	}
	f.p.HP = 10
	f.r.hitPlayer(f.p, c, 2, f.now, false)
	if f.p.HP != 9 {
		t.Fatalf("armored: a 2-damage hit left %d HP, want 9", f.p.HP)
	}
}

// Armor stops claws, not the weather.
func TestArmorDoesNotStopTheCold(t *testing.T) {
	f := newFixture(t)
	f.p.Gear[ArmorKey] = true
	f.wear(ArmorKey)
	if got := f.r.creatureDamage(f.p, 0); got != 0 {
		t.Fatalf("zero damage became %d", got)
	}
	f.p.Armor = false
	if got := f.r.creatureDamage(f.p, 3); got != 3 {
		t.Fatalf("unarmored damage changed: %d", got)
	}
}

// The armor survives a save: worn state rides the profile, gated on the gear.
func TestArmorSurvivesSaveLoad(t *testing.T) {
	f := newFixture(t)
	f.p.Gear[ArmorKey] = true
	f.wear(ArmorKey)
	f.r.snapshotInto(f.p)
	prof := f.r.profiles[f.p.S.UserID]
	if prof == nil || !prof.Armor {
		t.Fatalf("profile did not record the armor: %+v", prof)
	}

	g := newFixture(t)
	g.r.restore(g.p, prof)
	if !g.p.Armor {
		t.Fatal("restored player is not wearing their armor")
	}
	// a profile that claims armor without the gear is not believed
	h := newFixture(t)
	h.r.restore(h.p, &persist.Profile{Armor: true})
	if h.p.Armor {
		t.Fatal("armor restored without the gear")
	}
}

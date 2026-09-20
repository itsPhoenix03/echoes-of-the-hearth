package room

import (
	"path/filepath"
	"testing"

	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// TestSaveLoadRoundTripsWorldMutation proves the persist seam actually carries
// Slice 2 state: structures, carved mine tiles, torches, furniture, farms and
// chest contents all have to come back, or a restart silently deletes what
// players built.
func TestSaveLoadRoundTripsWorldMutation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "world.save.json")
	store := persist.NewJSONStore(path)

	base := ti(float64(world.ISLES[0][0]), float64(world.ISLES[0][1]))
	chestI := base + 1
	farmI := base + 2
	digI := base + 3

	src, err := New(Config{Seed: "hearth-1", World: sharedWorld, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	src.tickN = 500
	src.day, src.time = 7, 0.42
	src.structures[base] = &Structure{Kind: "wall", HP: 40, Owner: "u1", Dir: 1, Lvl: 2}
	src.structures[farmI] = &Structure{Kind: "farmplot", HP: 10, Owner: "u1", Lvl: 1}
	src.digs[digI] = true
	src.torches[digI] = true
	src.furn[chestI] = &Furniture{Kind: "chest", Owner: "u1", Z: 1}
	src.chestInv[chestI] = map[string]int{"wood": 7, "iron": 2}
	src.farms[farmI] = &Farm{Crop: "wheat", PlantedTick: 200, Owner: "u1", lastStage: 0}
	src.removed[base+9] = src.now() + 120_000
	src.mudTiles[base+10] = true
	src.sectorChops[1234] = 8
	src.brokenBergs[base+11] = true
	src.profiles["u_a"] = &persist.Profile{Name: "Keeper", HP: 6, Hunger: 4.5, Inv: map[string]int{"wood": 3}}

	if err := src.saveGame(); err != nil {
		t.Fatal(err)
	}

	dst, err := New(Config{Seed: "hearth-1", World: sharedWorld, Store: persist.NewJSONStore(path)})
	if err != nil {
		t.Fatal(err)
	}

	if dst.day != 7 || dst.time != 0.42 {
		t.Errorf("clock not restored: day=%d time=%v", dst.day, dst.time)
	}
	got := dst.structures[base]
	if got == nil || got.Kind != "wall" || got.HP != 40 || got.Dir != 1 || got.Lvl != 2 {
		t.Errorf("wall not restored: %+v", got)
	}
	if !dst.digs[digI] || !dst.torches[digI] {
		t.Error("dig/torch not restored")
	}
	if f := dst.furn[chestI]; f == nil || f.Kind != "chest" || f.Z != 1 {
		t.Errorf("chest furniture not restored: %+v", f)
	}
	if c := dst.chestInv[chestI]; c["wood"] != 7 || c["iron"] != 2 {
		t.Errorf("chest contents not restored: %v", dst.chestInv[chestI])
	}
	if !dst.mudTiles[base+10] || dst.sectorChops[1234] != 8 || !dst.brokenBergs[base+11] {
		t.Error("mud / sectorChops / brokenBergs not restored")
	}
	if p := dst.profiles["u_a"]; p == nil || p.HP != 6 || p.Hunger != 4.5 {
		t.Errorf("profile not restored: %+v", p)
	}
	// removed is stored as time REMAINING, so it comes back as a future instant.
	if at, ok := dst.removed[base+9]; !ok || at <= dst.now() {
		t.Errorf("node respawn timer not restored as a future instant: %v", at)
	}
	// Farms are stored as ticks ELAPSED. The room's tick counter restarts at
	// zero, so 300 ticks of growth must survive as 300 ticks of growth rather
	// than becoming an unreachable absolute plantedTick.
	fm := dst.farms[farmI]
	if fm == nil || fm.Crop != "wheat" {
		t.Fatalf("farm not restored: %+v", fm)
	}
	if dst.tickN-fm.PlantedTick != 300 {
		t.Errorf("crop age not preserved: %d ticks elapsed, want 300", dst.tickN-fm.PlantedTick)
	}
	if src.cropStage(src.farms[farmI]) != dst.cropStage(fm) {
		t.Errorf("crop stage changed across the save: %d -> %d",
			src.cropStage(src.farms[farmI]), dst.cropStage(fm))
	}
}

// TestLoadRejectsCorruptTileIndices guards the room against a hand-edited or
// truncated save: a tile index outside the world would panic on the first
// lookup, where JavaScript would merely read undefined.
func TestLoadRejectsCorruptTileIndices(t *testing.T) {
	path := filepath.Join(t.TempDir(), "world.save.json")
	bad := &persist.Snapshot{
		Version: world.WorldVersion, Seed: "hearth-1", Day: 1,
		Structures: map[string]*persist.Struct{
			"-5":       {Kind: "wall", HP: 20, Lvl: 1},
			"99999999": {Kind: "wall", HP: 20, Lvl: 1},
			"notanint": {Kind: "wall", HP: 20, Lvl: 1},
			"1000":     {Kind: "definitely-not-a-real-kind", HP: 20, Lvl: 1},
		},
		Digs: []int{-1, 1 << 30}, Torches: []int{-2},
		Farms:    map[string]*persist.Farm{"2000": {Crop: "not-a-crop", Elapsed: 5}},
		ChestInv: map[string]map[string]int{"3000": {"wood": 4, "sword": 9}},
	}
	if err := persist.NewJSONStore(path).Save(bad); err != nil {
		t.Fatal(err)
	}
	r, err := New(Config{Seed: "hearth-1", World: sharedWorld, Store: persist.NewJSONStore(path)})
	if err != nil {
		t.Fatal(err)
	}
	if len(r.structures) != 0 {
		t.Errorf("corrupt structures were loaded: %v", r.structures)
	}
	if len(r.digs) != 0 || len(r.torches) != 0 {
		t.Errorf("out-of-world digs/torches were loaded: %v %v", r.digs, r.torches)
	}
	if len(r.farms) != 0 {
		t.Errorf("a farm with an unknown crop was loaded: %v", r.farms)
	}
	if r.chestInv[3000]["sword"] != 0 || r.chestInv[3000]["wood"] != 4 {
		t.Errorf("chest contents were not filtered to storable resources: %v", r.chestInv[3000])
	}
}

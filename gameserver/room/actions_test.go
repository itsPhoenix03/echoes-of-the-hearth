package room

import (
	"testing"

	"hearth/gameserver/defs"
	"hearth/gameserver/world"
)

// These cover the rules that are easy to port subtly wrong: which station a
// recipe needs and how far away it may be, which tool the server derives for an
// action (never the client's claim), when a crop is ripe, and that a chest
// transfer can never mint or destroy resources.

// stand puts the player on a tile and clears the action cooldowns, so a handler
// range check sees exactly this position and no rate limit is left over.
func (f *fixture) stand(x, y float64, z int) {
	f.place(x, y, z)
	f.p.LastGather, f.p.LastAtk, f.p.LastUseAt = 0, 0, 0
}

// firstOf returns the world tile index of the first node of the given kind.
func firstOf(t *testing.T, w *world.World, kind uint8) int {
	t.Helper()
	for _, i := range world.SortedNodeKeys(w.Nodes) {
		if w.Nodes[i] == kind {
			return i
		}
	}
	t.Fatalf("no node of kind %d in the world", kind)
	return 0
}

// lastOfType returns the most recent message of a type since the last reset.
// It drains into f.seen so several lookups after one action all observe the
// same batch — drain() itself is destructive.
func (f *fixture) lastOfType(t string) map[string]any {
	f.seen = append(f.seen, f.drain()...)
	var out map[string]any
	for _, m := range f.seen {
		if m["t"] == t {
			out = m
		}
	}
	return out
}

// reset forgets everything observed so far.
func (f *fixture) reset() {
	f.drain()
	f.seen = nil
}

// --- recipe station gating -------------------------------------------------

func TestCraftStationGating(t *testing.T) {
	f := newFixture(t)
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	f.p.Inv["wood"], f.p.Inv["fiber"] = 100, 100

	// axe requires a workbench; with none placed the craft is refused and says so.
	f.r.handleCraft(f.p, map[string]any{"t": "craft", "r": "axe"})
	if f.p.Tools["axe"] {
		t.Fatal("axe was crafted with no workbench in range")
	}
	if m := f.lastOfType("msg"); m == nil || m["s"] != "You must stand near a workbench to craft this." {
		t.Fatalf("expected the station message, got %v", m)
	}
	if f.p.Inv["wood"] != 100 {
		t.Fatalf("a refused craft must not charge the player: wood=%d", f.p.Inv["wood"])
	}

	// A workbench 5 tiles away is still out of range: the radius is 4.
	far := ti(f.p.X+5, f.p.Y)
	f.r.structures[far] = &Structure{Kind: "workbench", HP: 15, Lvl: 1}
	f.r.handleCraft(f.p, map[string]any{"t": "craft", "r": "axe"})
	if f.p.Tools["axe"] {
		t.Fatal("a workbench 5 tiles away satisfied a station:4 recipe")
	}
	delete(f.r.structures, far)

	// Within 4 it works, and the cost comes out of the inventory exactly once.
	near := ti(f.p.X+3, f.p.Y)
	f.r.structures[near] = &Structure{Kind: "workbench", HP: 15, Lvl: 1}
	f.reset()
	f.r.handleCraft(f.p, map[string]any{"t": "craft", "r": "axe"})
	if !f.p.Tools["axe"] {
		t.Fatal("axe was not crafted next to a workbench")
	}
	cost := f.r.defs.Recipes["axe"].Cost
	if f.p.Inv["wood"] != 100-cost["wood"] || f.p.Inv["fiber"] != 100-cost["fiber"] {
		t.Fatalf("axe cost not charged from shared/defs.json: wood=%d fiber=%d cost=%v",
			f.p.Inv["wood"], f.p.Inv["fiber"], cost)
	}

	// A forge recipe is not satisfied by a workbench.
	f.p.Inv["iron"] = 100
	f.r.handleCraft(f.p, map[string]any{"t": "craft", "r": "isword"})
	if f.p.Tools["isword"] {
		t.Fatal("a workbench satisfied a station:forge recipe")
	}

	// station:null crafts from anywhere.
	f.p.X, f.p.Y = f.p.X+80, f.p.Y+80
	f.r.handleCraft(f.p, map[string]any{"t": "craft", "r": "torch"})
	if f.p.Inv["torch"] != 1 {
		t.Fatalf("a station:null recipe was gated: torch=%d", f.p.Inv["torch"])
	}
}

// --- tool derivation -------------------------------------------------------

func TestGatherDerivesActionFromWorldStateNotTheClient(t *testing.T) {
	tree := firstOf(t, sharedWorld, world.NodeTree)
	boulder := firstOf(t, sharedWorld, world.NodeBoulder)
	bush := firstOf(t, sharedWorld, world.NodeBush)

	cases := []struct {
		name     string
		target   int
		tools    []string
		wantA    string
		wantTool any
	}{
		{"bare hands on a tree punch", tree, nil, "punch", nil},
		{"axe on a tree chops", tree, []string{"axe"}, "chop", "axe"},
		{"a sword does not chop", tree, []string{"sword"}, "punch", nil},
		{"pick on a boulder mines", boulder, []string{"pick"}, "mine", "pick"},
		{"spick outranks pick on a boulder", boulder, []string{"pick", "spick"}, "mine", "spick"},
		{"spick alone still mines a boulder", boulder, []string{"spick"}, "mine", "spick"},
		{"a bush is always hand-gathered", bush, []string{"axe", "spick", "sword"}, "punch", nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			for _, tool := range tc.tools {
				f.p.Tools[tool] = true
			}
			f.stand(float64(tc.target%world.SIZE), float64(tc.target/world.SIZE), 0)
			f.reset()
			// The client lies about both fields; the server must ignore them.
			f.r.handleGather(f.p, map[string]any{
				"t": "gather", "i": float64(tc.target), "seq": float64(7),
				"a": "slash", "tool": "isword",
			})
			act := f.lastOfType("act")
			if act == nil {
				t.Fatal("no act broadcast")
			}
			if act["a"] != tc.wantA {
				t.Errorf("a = %v, want %v", act["a"], tc.wantA)
			}
			if act["tool"] != tc.wantTool {
				t.Errorf("tool = %v, want %v", act["tool"], tc.wantTool)
			}
			if act["seq"] != float64(7) {
				t.Errorf("seq must be echoed unchanged, got %v", act["seq"])
			}
		})
	}
}

func TestGatherToolGatingAndDamage(t *testing.T) {
	boulder := firstOf(t, sharedWorld, world.NodeBoulder)
	def, _ := defs.Get().NodeDefFor(int(world.NodeBoulder))

	// No pickaxe at all: refused with no_tool, and the node is untouched.
	f := newFixture(t)
	f.stand(float64(boulder%world.SIZE), float64(boulder/world.SIZE), 0)
	f.reset()
	f.r.handleGather(f.p, map[string]any{"t": "gather", "i": float64(boulder), "seq": float64(1)})
	if rej := f.lastOfType("actReject"); rej == nil || rej["reason"] != "no_tool" {
		t.Fatalf("expected no_tool, got %v", rej)
	}
	if _, damaged := f.r.nodeHP[boulder]; damaged {
		t.Fatal("a refused gather damaged the node")
	}

	// A plain pick does 1 damage per swing; a stone pick does 2.
	for _, tc := range []struct {
		tools []string
		want  int
	}{{[]string{"pick"}, def.HP - 1}, {[]string{"pick", "spick"}, def.HP - 2}} {
		f := newFixture(t)
		for _, tool := range tc.tools {
			f.p.Tools[tool] = true
		}
		f.stand(float64(boulder%world.SIZE), float64(boulder/world.SIZE), 0)
		f.r.handleGather(f.p, map[string]any{"t": "gather", "i": float64(boulder)})
		if got := f.r.nodeHP[boulder]; got != tc.want {
			t.Errorf("tools %v: node hp = %d, want %d", tc.tools, got, tc.want)
		}
	}
}

func TestDigDerivesSpickFromOwnedTools(t *testing.T) {
	f := newFixture(t)
	// Carve a mine under a diggable tile near spawn and stand in it.
	var target int
	found := false
	for i := 0; i < world.SIZE*world.SIZE && !found; i++ {
		if world.Diggable(f.r.world, i) {
			target = i
			found = true
		}
	}
	if !found {
		t.Fatal("no diggable tile in the world")
	}
	// Stand on the tile NEXT to the target: the target itself must still be
	// uncarved for the dig to be legal.
	f.stand(float64(target%world.SIZE)+1, float64(target/world.SIZE), 1)
	f.r.digs[ti(f.p.X, f.p.Y)] = true

	// Without a pickaxe: refused.
	f.reset()
	f.r.handleDig(f.p, map[string]any{"t": "dig", "i": float64(target)})
	if rej := f.lastOfType("actReject"); rej == nil || rej["reason"] != "no_tool" {
		t.Fatalf("dig without a pickaxe: expected no_tool, got %v", rej)
	}
	if f.r.digs[target] {
		t.Fatal("a refused dig carved the tile anyway")
	}

	for _, tc := range []struct{ owned, want string }{{"pick", "pick"}, {"spick", "spick"}} {
		f := newFixture(t)
		f.p.Tools[tc.owned] = true
		f.stand(float64(target%world.SIZE)+1, float64(target/world.SIZE), 1)
		f.r.digs[ti(f.p.X, f.p.Y)] = true
		f.reset()
		// The client claims an axe; the server must use the tool it validated.
		f.r.handleDig(f.p, map[string]any{
			"t": "dig", "i": float64(target), "seq": float64(9003), "tool": "axe", "a": "pick",
		})
		act := f.lastOfType("act")
		if act == nil {
			t.Fatalf("owned %s: no act broadcast", tc.owned)
		}
		if act["a"] != "mine" || act["tool"] != tc.want {
			t.Errorf("owned %s: act a=%v tool=%v, want mine/%s", tc.owned, act["a"], act["tool"], tc.want)
		}
		dig := f.lastOfType("dig")
		if dig == nil || dig["by"] != f.p.S.ID || dig["seq"] != float64(9003) {
			t.Errorf("owned %s: dig outcome missing by/seq: %v", tc.owned, dig)
		}
	}
}

// --- crop growth timing ----------------------------------------------------

func TestCropGrowthTiming(t *testing.T) {
	d := defs.Get()
	wheat := d.Crops["wheat"]
	if wheat.GrowTicks != 1800 {
		t.Fatalf("this test is written against wheat's 1800 growTicks, defs says %d", wheat.GrowTicks)
	}

	for _, tc := range []struct {
		name    string
		dev     bool
		wantGT  int
		samples map[int64]int // ticks since planting -> expected stage
	}{
		{"production", false, 1800, map[int64]int{
			0: 0, 599: 0, 600: 1, 1199: 1, 1200: 2, 5000: 2,
		}},
		// GROW_DIV is 30 under DEV: 1800/30 = 60 ticks, 12 seconds end to end.
		{"dev", true, 60, map[int64]int{
			0: 0, 19: 0, 20: 1, 39: 1, 40: 2, 100: 2,
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r, err := New(Config{Seed: "hearth-1", World: sharedWorld, Dev: tc.dev})
			if err != nil {
				t.Fatal(err)
			}
			if got := r.growTicks(wheat); got != tc.wantGT {
				t.Fatalf("growTicks = %d, want %d", got, tc.wantGT)
			}
			fm := &Farm{Crop: "wheat", PlantedTick: 0, lastStage: -1}
			for elapsed, want := range tc.samples {
				r.tickN = elapsed
				if got := r.cropStage(fm); got != want {
					t.Errorf("%d ticks after planting: stage %d, want %d", elapsed, got, want)
				}
			}
		})
	}
}

func TestHarvestRefusedUntilRipe(t *testing.T) {
	f := newFixture(t)
	i := ti(float64(f.r.spawn[0]), float64(f.r.spawn[1]))
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0)
	f.r.structures[i] = &Structure{Kind: "farmplot", HP: 10, Lvl: 1}
	f.p.Inv["fiber"] = 10

	f.r.handlePlant(f.p, map[string]any{"t": "plant", "i": float64(i), "crop": "wheat"})
	if f.r.farms[i] == nil {
		t.Fatal("wheat was not planted on a farmplot")
	}
	if f.p.Inv["fiber"] != 8 {
		t.Fatalf("seed cost not charged: fiber=%d", f.p.Inv["fiber"])
	}

	// Immediately: not ready, nothing yielded, the crop stays.
	f.reset()
	f.r.handleHarvest(f.p, map[string]any{"t": "harvest", "i": float64(i)})
	if f.p.Inv["grain"] != 0 || f.r.farms[i] == nil {
		t.Fatalf("an unripe crop was harvested: grain=%d farm=%v", f.p.Inv["grain"], f.r.farms[i])
	}

	// One tick short of ripe is still refused; the ripe tick yields.
	gt := int64(f.r.growTicks(f.r.defs.Crops["wheat"]))
	f.r.tickN = (2*gt)/3 - 1
	f.r.handleHarvest(f.p, map[string]any{"t": "harvest", "i": float64(i)})
	if f.p.Inv["grain"] != 0 {
		t.Fatal("harvested one tick before ripe")
	}
	f.r.tickN = (2 * gt) / 3
	f.r.handleHarvest(f.p, map[string]any{"t": "harvest", "i": float64(i)})
	if f.p.Inv["grain"] != f.r.defs.Crops["wheat"].Yield["grain"] {
		t.Fatalf("ripe harvest yielded %d grain", f.p.Inv["grain"])
	}
	if f.r.farms[i] != nil {
		t.Fatal("the farm entry survived the harvest")
	}
}

// --- chest transfer --------------------------------------------------------

func TestChestTransferConservesResources(t *testing.T) {
	f := newFixture(t)
	i := ti(float64(f.r.spawn[0]), float64(f.r.spawn[1]))
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 2)
	f.r.furn[i] = &Furniture{Kind: "chest", Owner: f.p.S.ID, Z: 2}
	f.p.Inv["wood"] = 10

	total := func() int { return f.p.Inv["wood"] + f.r.chestInv[i]["wood"] }
	move := func(n int) {
		f.r.handleChestMove(f.p, map[string]any{"t": "chest_move", "i": float64(i), "res": "wood", "n": float64(n)})
	}

	move(4)
	if f.p.Inv["wood"] != 6 || f.r.chestInv[i]["wood"] != 4 || total() != 10 {
		t.Fatalf("deposit: player=%d chest=%d", f.p.Inv["wood"], f.r.chestInv[i]["wood"])
	}
	// Depositing more than held is clamped to what is held — never negative.
	move(999)
	if f.p.Inv["wood"] != 0 || f.r.chestInv[i]["wood"] != 10 || total() != 10 {
		t.Fatalf("over-deposit: player=%d chest=%d", f.p.Inv["wood"], f.r.chestInv[i]["wood"])
	}
	// Withdrawing more than stored is clamped to what is stored — never minted.
	move(-999)
	if f.p.Inv["wood"] != 10 || f.r.chestInv[i]["wood"] != 0 || total() != 10 {
		t.Fatalf("over-withdraw: player=%d chest=%d", f.p.Inv["wood"], f.r.chestInv[i]["wood"])
	}
	// An empty slot is deleted rather than left at zero.
	if _, present := f.r.chestInv[i]["wood"]; present {
		t.Fatal("an emptied chest slot was left behind")
	}
	// A withdraw from an empty chest is a no-op, not a free 5 wood.
	move(-5)
	if total() != 10 || f.p.Inv["wood"] != 10 {
		t.Fatalf("withdraw from empty chest minted resources: player=%d", f.p.Inv["wood"])
	}
	// Crafted goods are not storable.
	f.p.Inv["torch"] = 3
	f.r.handleChestMove(f.p, map[string]any{"t": "chest_move", "i": float64(i), "res": "torch", "n": float64(2)})
	if f.p.Inv["torch"] != 3 || f.r.chestInv[i]["torch"] != 0 {
		t.Fatal("a non-resource was accepted into a chest")
	}
}

func TestChestIsUnreachableFromAnotherLayer(t *testing.T) {
	f := newFixture(t)
	i := ti(float64(f.r.spawn[0]), float64(f.r.spawn[1]))
	f.stand(float64(f.r.spawn[0]), float64(f.r.spawn[1]), 0) // chest is on z=2
	f.r.furn[i] = &Furniture{Kind: "chest", Owner: f.p.S.ID, Z: 2}
	f.r.chestInv[i] = map[string]int{"wood": 5}
	f.reset()
	f.r.handleChestOpen(f.p, map[string]any{"t": "chest_open", "i": float64(i)})
	if m := f.lastOfType("chest"); m != nil {
		t.Fatal("a chest on the shelter layer was opened from the surface")
	}
	f.r.handleChestMove(f.p, map[string]any{"t": "chest_move", "i": float64(i), "res": "wood", "n": float64(-5)})
	if f.p.Inv["wood"] != 0 {
		t.Fatalf("withdrew across layers: wood=%d", f.p.Inv["wood"])
	}
}

// --- defs wiring -----------------------------------------------------------

// TestDefsAreLoadedFromSharedJSON guards the extraction itself: if the Go server
// ever stops reading shared/defs.json, or reads a different one, this catches it.
func TestDefsAreLoadedFromSharedJSON(t *testing.T) {
	d := defs.Get()
	if d.Recipes["workbench"].Cost["wood"] != 8 {
		t.Errorf("workbench costs %d wood, shared/defs.json says 8", d.Recipes["workbench"].Cost["wood"])
	}
	if st, _ := d.Recipes["axe"].StationName(); st != "workbench" {
		t.Errorf("axe station = %q, want workbench", st)
	}
	if _, needs := d.Recipes["torch"].StationName(); needs {
		t.Error("torch must be craftable anywhere")
	}
	if d.StructHP["wall"] != 20 || d.StructHP["farmplot"] != 10 {
		t.Errorf("STRUCT_HP mismatch: wall=%d farmplot=%d", d.StructHP["wall"], d.StructHP["farmplot"])
	}
	nd, ok := d.NodeDefFor(int(world.NodeStarmetal))
	if !ok || nd.HP != 6 {
		t.Errorf("starmetal node def = %+v", nd)
	}
	if tool, needs := nd.ToolName(); !needs || tool != "spick" {
		t.Errorf("starmetal tool = %q (needs=%v), want spick", tool, needs)
	}
	if !d.DecorNonBlk["rug"] || d.DecorNonBlk["fence"] {
		t.Error("DECOR_NONBLOCKING did not survive the JSON round trip")
	}
	// Every inventory slot the handlers touch must exist in INV_KEYS, or a
	// crafted item would silently land in a key the client never renders.
	for _, k := range []string{"wood", "grain", "glowcap", "medicine", "farmplot", "torch"} {
		if !d.InvKeySet[k] {
			t.Errorf("INV_KEYS is missing %q", k)
		}
	}
	if len(d.EmptyInv()) != len(d.InvKeys) {
		t.Error("EmptyInv did not produce one slot per INV_KEYS entry")
	}
}

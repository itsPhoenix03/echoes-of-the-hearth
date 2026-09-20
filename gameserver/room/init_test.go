package room

import (
	"encoding/json"
	"math"
	"testing"

	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// joinFresh runs a real onJoin and returns the `init` frame it produced, so
// these tests observe exactly what the client would receive.
func (f *fixture) joinFresh(id string) (map[string]any, *Session) {
	f.t.Helper()
	s := NewSession(id, "u_"+id, "Tester2", "test")
	f.r.onJoin(s)
	var init map[string]any
	for {
		select {
		case b := <-s.Out:
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				f.t.Fatalf("unmarshal outbound: %v", err)
			}
			if m["t"] == "init" {
				init = m
			}
		default:
			if init == nil {
				f.t.Fatal("onJoin sent no init frame")
			}
			return init, s
		}
	}
}

// --- Slice 4: medics on the wire -------------------------------------------

// The client derives its medic sprites AND its hut collision set from
// init.medics, so the field names and coordinates must match findMedicSpawns()
// exactly. Cross-checked against world.FindMedicSpawns, the bit-exact port of
// the shared/world.js helper the client itself uses on the legacy path.
func TestInitCarriesMedics(t *testing.T) {
	f := newFixture(t)
	init, _ := f.joinFresh("init01")

	raw, ok := init["medics"].([]any)
	if !ok {
		t.Fatalf("init.medics missing or not an array: %T", init["medics"])
	}
	want, err := world.FindMedicSpawns(f.r.world)
	if err != nil {
		t.Fatal(err)
	}
	if len(want) != 2 {
		t.Fatalf("expected exactly two medics in the world, got %d", len(want))
	}
	if len(raw) != len(want) {
		t.Fatalf("init.medics has %d entries, want %d", len(raw), len(want))
	}
	// Exactly the keys src/main.ts declares — no more, no less. An extra key is
	// as much of a contract break as a missing one, because the client feeds
	// these objects straight back into medicBlockTiles().
	wantKeys := []string{"id", "islandId", "sprite", "x", "y", "hutSprite", "hutX", "hutY"}
	for i, e := range raw {
		m, ok := e.(map[string]any)
		if !ok {
			t.Fatalf("medics[%d] is not an object: %T", i, e)
		}
		if len(m) != len(wantKeys) {
			t.Fatalf("medics[%d] has keys %v, want exactly %v", i, keysOfAny(m), wantKeys)
		}
		for _, k := range wantKeys {
			if _, ok := m[k]; !ok {
				t.Fatalf("medics[%d] is missing %q", i, k)
			}
		}
		w := want[i]
		if m["id"] != w.ID || m["islandId"] != w.IslandID || m["sprite"] != w.Sprite || m["hutSprite"] != w.HutSprite {
			t.Fatalf("medics[%d] identity mismatch: got %v, want %+v", i, m, w)
		}
		for k, wv := range map[string]int{"x": w.X, "y": w.Y, "hutX": w.HutX, "hutY": w.HutY} {
			gv, ok := m[k].(float64)
			if !ok {
				t.Fatalf("medics[%d].%s is not a number: %T", i, k, m[k])
			}
			if gv != math.Trunc(gv) {
				t.Fatalf("medics[%d].%s = %v, want an integer tile coordinate", i, k, gv)
			}
			if int(gv) != wv {
				t.Fatalf("medics[%d].%s = %d, want %d", i, k, int(gv), wv)
			}
		}
	}

	// The hut tiles the client will block must be the same set the server
	// already refuses to let anyone stand on.
	srv := world.MedicBlockTiles(want)
	for i, e := range raw {
		m := e.(map[string]any)
		idx := int(m["hutY"].(float64))*world.SIZE + int(m["hutX"].(float64))
		if !srv[idx] {
			t.Fatalf("medics[%d] hut tile %d is not in the server's block set", i, idx)
		}
		if !f.r.medicTiles[idx] {
			t.Fatalf("medics[%d] hut tile %d is not blocked by the room", i, idx)
		}
	}
}

// The ids are the ones the medic frames are keyed on, so a client can click a
// medic from init and address it directly without a second lookup.
func TestInitMedicIDsAddressTheBargain(t *testing.T) {
	f := newFixture(t)
	init, _ := f.joinFresh("init02")
	for _, e := range init["medics"].([]any) {
		id, _ := e.(map[string]any)["id"].(string)
		if f.r.medicByID(id) == nil {
			t.Fatalf("init advertised medic %q that medicByID cannot resolve", id)
		}
	}
}

// --- hunger/thirst are integral on the wire --------------------------------

// The legacy server puts Math.ceil() on every `stat` frame (server/index.js
// survival tick and the `use` handler), so the bars only read empty at a true
// zero. The Go simulation keeps fractional precision internally but must round
// at the boundary — on `init` as well as `stat`, which is where the two servers
// used to disagree.
func TestVitalsIntegralOnTheWire(t *testing.T) {
	f := newFixture(t)
	// A player mid-decay: floats internally, integers on the wire. The saved
	// profile is the only way fractional vitals reach a joining player, and it
	// is also the case the legacy `init` got wrong.
	f.p.Hunger, f.p.Thirst = 9.945, 8.334
	f.r.profiles["u_init03"] = &persist.Profile{
		HP: 7, Hunger: 9.945, Thirst: 8.334, X: -1, Y: -1,
	}

	init, _ := f.joinFresh("init03")
	if got := f.r.players["init03"].Hunger; got != 9.945 {
		t.Fatalf("restored Hunger = %v, want the fraction kept internally", got)
	}
	for k, want := range map[string]float64{"hunger": 10, "thirst": 9} { // ceil(9.945), ceil(8.334)
		v, ok := init[k].(float64)
		if !ok {
			t.Fatalf("init.%s is not a number: %T", k, init[k])
		}
		if v != math.Trunc(v) {
			t.Fatalf("init.%s = %v, want an integer", k, v)
		}
		if v != want {
			t.Fatalf("init.%s = %v, want ceil() = %v", k, v, want)
		}
	}

	f.reset()
	f.r.survivalTick()
	st := f.lastOfType("stat")
	if st == nil {
		t.Fatal("survivalTick sent no stat frame")
	}
	for k, want := range map[string]float64{"hunger": math.Ceil(9.945 - 0.055), "thirst": math.Ceil(8.334 - 0.083)} {
		v, ok := st[k].(float64)
		if !ok {
			t.Fatalf("stat.%s is not a number: %T", k, st[k])
		}
		if v != math.Trunc(v) {
			t.Fatalf("stat.%s = %v, want an integer", k, v)
		}
		if v != want {
			t.Fatalf("stat.%s = %v, want ceil() = %v", k, v, want)
		}
	}
	// Decay itself must stay fractional — rounding at the boundary must not
	// leak back into the simulation or starvation timing shifts.
	if f.p.Hunger == math.Trunc(f.p.Hunger) {
		t.Fatalf("internal Hunger was rounded: %v", f.p.Hunger)
	}
}

// ceil, not floor or round: a bar reads 1 until the value truly hits 0, and
// exact integers are left alone.
func TestStatIntSemantics(t *testing.T) {
	cases := []struct {
		in   float64
		want int
	}{{10, 10}, {9.945, 10}, {0.001, 1}, {0, 0}, {-0.5, 0}, {4.5, 5}}
	for _, c := range cases {
		if got := statInt(c.in); got != c.want {
			t.Fatalf("statInt(%v) = %d, want %d", c.in, got, c.want)
		}
	}
}

func keysOfAny(m map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

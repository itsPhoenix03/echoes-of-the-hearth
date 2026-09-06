package world

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"
	"testing"
)

// These are the digests produced by the JavaScript reference implementation
// (shared/world.js) via tools/worldparity/digest.mjs. They pin the Go port to
// bit-exact parity: if a future edit changes the generated world at all, this
// test fails.
//
// Re-derive with:  node tools/worldparity/compare.mjs
var hearth1 = map[string]string{
	"tiles":     "c44825ef4dfb25b0392a753d2d9d4d263253daa2552a52ce293c87d9defe653c",
	"elev":      "59eb3018a951eb885aff9e545ec93587b688819498191799b7ee92c9c5b2c465",
	"veins":     "de376adc851095ed23e40aae7fb76a8458f243551e8717eb7a648186679161c1",
	"waterTemp": "85cbb461a6f158920877931d55368f7ee06ac13485be5a52cf93aa006a2254e1",
	"tileVis":   "a6deecd9781c9de109d51d430327636bfd4ba20f599a3ebdaa4403982ccf1117",
	"nodes":     "35712e5c72dadff3558933c4b938d4ee9a8586ad85bc3ab4cbb8d47e71583404",
	"bergs":     "6ee3cd711442bc4115d9b41d370816dd632d1a7144b0ba438168a6451da5217d",
	"decor":     "b4042a0cf976675f215398fb6ce4f264d3000f5e6978d4f74d1813eee2c1c805",
}

const (
	hearth1Nodes = 3947
	hearth1Bergs = 1044
	hearth1Decor = 165
)

func sha(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// joined mirrors the JS `arr.join('\n') + '\n'` used by digest.mjs.
func joined(lines []string) []byte {
	return []byte(strings.Join(lines, "\n") + "\n")
}

func TestGenWorldHearth1Digest(t *testing.T) {
	w := GenWorld("hearth-1")

	for name, arr := range map[string][]uint8{
		"tiles": w.Tiles, "elev": w.Elev, "veins": w.Veins,
		"waterTemp": w.WaterTemp, "tileVis": w.TileVis,
	} {
		if len(arr) != SIZE*SIZE {
			t.Fatalf("%s: length = %d, want %d", name, len(arr), SIZE*SIZE)
		}
		if got := sha(arr); got != hearth1[name] {
			t.Errorf("%s digest = %s, want %s (world generation drifted from shared/world.js)", name, got, hearth1[name])
		}
	}

	if len(w.Nodes) != hearth1Nodes {
		t.Errorf("nodes count = %d, want %d", len(w.Nodes), hearth1Nodes)
	}
	if len(w.Bergs) != hearth1Bergs {
		t.Errorf("bergs count = %d, want %d", len(w.Bergs), hearth1Bergs)
	}
	if len(w.Decor) != hearth1Decor {
		t.Errorf("decor count = %d, want %d", len(w.Decor), hearth1Decor)
	}

	var nl []string
	for _, i := range SortedNodeKeys(w.Nodes) {
		nl = append(nl, strconv.Itoa(i)+" "+strconv.Itoa(int(w.Nodes[i])))
	}
	if got := sha(joined(nl)); got != hearth1["nodes"] {
		t.Errorf("nodes digest = %s, want %s", got, hearth1["nodes"])
	}

	var bl []string
	for _, i := range SortedBergKeys(w.Bergs) {
		bl = append(bl, strconv.Itoa(i))
	}
	if got := sha(joined(bl)); got != hearth1["bergs"] {
		t.Errorf("bergs digest = %s, want %s", got, hearth1["bergs"])
	}

	var dl []string
	for _, i := range SortedDecorKeys(w.Decor) {
		dl = append(dl, strconv.Itoa(i)+" "+w.Decor[i])
	}
	if got := sha(joined(dl)); got != hearth1["decor"] {
		t.Errorf("decor digest = %s, want %s", got, hearth1["decor"])
	}
}

// TestAleaKnownValues pins alea@1.0.1's output for the seed used by genWorld.
// Reference values from: alea('hearth-1e') in Node.
func TestAleaKnownValues(t *testing.T) {
	want := []float64{
		0.13823944795876741,
		0.9355960583779961,
		0.13693887717090547,
		0.020699897315353155,
		0.20401701563969254,
	}
	a := NewAlea("hearth-1e")
	for i, w := range want {
		if got := a.Next(); got != w {
			t.Errorf("Next()[%d] = %v, want %v", i, got, w)
		}
	}
}

// TestNoise2DKnownValues pins simplex-noise@4.0.3 output.
// Reference values from: createNoise2D(alea('hearth-1e')) in Node.
func TestNoise2DKnownValues(t *testing.T) {
	n := NewNoise2D(NewAlea("hearth-1e"))
	cases := []struct {
		x, y, want float64
	}{
		{0, 0, 0},
		{1.0 / 28, 1.0 / 28, 0.15308554548343936},
		{37.5, -12.25, 0.6239538314618094},
		{900, 900, -0.6850322974610329},
	}
	for _, c := range cases {
		if got := n.Eval(c.x, c.y); got != c.want {
			t.Errorf("Eval(%v, %v) = %v, want %v", c.x, c.y, got, c.want)
		}
	}
}

// TestToInt32IsTruncationNotFloor guards the `t | 0` semantics: JS truncates
// toward zero, so -3.7|0 == -3 while Math.floor(-3.7) == -4.
func TestToInt32IsTruncationNotFloor(t *testing.T) {
	if got := toInt32(-3.7); got != -3 {
		t.Errorf("toInt32(-3.7) = %v, want -3", got)
	}
	if got := toUint32(-1); got != 4294967295 {
		t.Errorf("toUint32(-1) = %v, want 4294967295", got)
	}
	if got := toInt32(4294967296 + 5); got != 5 {
		t.Errorf("toInt32(2^32+5) = %v, want 5", got)
	}
}

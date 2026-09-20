package room

import (
	"encoding/json"
	"testing"

	"hearth/gameserver/proto"
	"hearth/gameserver/world"
)

func chunkFrames(f *fixture) map[[2]int]map[string]any {
	out := map[[2]int]map[string]any{}
	for _, m := range f.drain() {
		if m["t"] != "chunk" {
			continue
		}
		key := [2]int{int(m["cx"].(float64)), int(m["cy"].(float64))}
		out[key] = m
	}
	return out
}

func TestPushChunksOnJoinSendsFiveByFive(t *testing.T) {
	f := newFixture(t)
	f.p.chunkInit = false
	f.p.sentChunks = map[int]bool{}
	f.drain()

	f.r.pushChunks(f.p)
	got := chunkFrames(f)
	cx, cy := chunkOf(f.p.X, f.p.Y)
	want := 0
	for dy := -proto.ChunkRadius; dy <= proto.ChunkRadius; dy++ {
		for dx := -proto.ChunkRadius; dx <= proto.ChunkRadius; dx++ {
			nx, ny := cx+dx, cy+dy
			if nx < 0 || ny < 0 || nx >= ChunkGrid || ny >= ChunkGrid {
				continue
			}
			want++
			if _, ok := got[[2]int{nx, ny}]; !ok {
				t.Fatalf("chunk (%d,%d) was not pushed on join", nx, ny)
			}
		}
	}
	if len(got) != want {
		t.Fatalf("pushed %d chunks, want %d", len(got), want)
	}

	// A second call with no movement pushes nothing.
	f.r.pushChunks(f.p)
	if again := chunkFrames(f); len(again) != 0 {
		t.Fatalf("a no-op pushChunks re-sent %d chunks", len(again))
	}
}

func TestPushChunksOnBoundaryCrossingSendsOnlyTheNewColumn(t *testing.T) {
	f := newFixture(t)
	f.p.chunkInit = false
	f.p.sentChunks = map[int]bool{}
	f.r.pushChunks(f.p)
	f.drain()

	cx, _ := chunkOf(f.p.X, f.p.Y)
	// Step one chunk east.
	f.p.X = float64((cx + 1) * proto.ChunkSize)
	f.r.pushChunks(f.p)
	got := chunkFrames(f)
	if len(got) == 0 {
		t.Fatal("crossing a chunk boundary pushed nothing")
	}
	for key := range got {
		if key[0] != cx+1+proto.ChunkRadius {
			t.Fatalf("chunk (%d,%d) was re-sent; only the newly revealed column should be", key[0], key[1])
		}
	}
	if len(got) > 2*proto.ChunkRadius+1 {
		t.Fatalf("pushed %d chunks for a one-column step", len(got))
	}
}

// TestChunkPayloadDecodesToTheRealWorld is the in-process half of the
// end-to-end proof smoke.mjs completes against a live server: what the room
// puts on the wire must decode back to the generated world's tiles.
func TestChunkPayloadDecodesToTheRealWorld(t *testing.T) {
	f := newFixture(t)
	for _, c := range [][2]int{{0, 0}, {2, 2}, {10, 5}, {19, 19}} {
		raw := marshal(f.r.chunkMessage(c[0], c[1]))
		var m map[string]any
		if err := json.Unmarshal(raw, &m); err != nil {
			t.Fatal(err)
		}
		for _, layer := range []struct {
			key string
			src []uint8
			// veins is masked to land on the wire (§4.3): the server keeps the
			// true value but sends 0 over water, since ore is only reachable
			// underground beneath land.
			maskWater bool
		}{
			{key: "tiles", src: f.r.world.Tiles}, {key: "elev", src: f.r.world.Elev},
			{key: "veins", src: f.r.world.Veins, maskWater: true},
			{key: "waterTemp", src: f.r.world.WaterTemp}, {key: "tileVis", src: f.r.world.TileVis},
		} {
			got, err := proto.DecodeRLE(m[layer.key].(string), proto.ChunkTiles)
			if err != nil {
				t.Fatalf("chunk (%d,%d) %s: %v", c[0], c[1], layer.key, err)
			}
			for ly := 0; ly < proto.ChunkSize; ly++ {
				for lx := 0; lx < proto.ChunkSize; lx++ {
					wx := c[0]*proto.ChunkSize + lx
					wy := c[1]*proto.ChunkSize + ly
					want := layer.src[wy*world.SIZE+wx]
					if layer.maskWater && f.r.world.Tiles[wy*world.SIZE+wx] == world.TWater {
						want = 0
					}
					if got[ly*proto.ChunkSize+lx] != want {
						t.Fatalf("chunk (%d,%d) %s: tile (%d,%d) differs: got %d want %d",
							c[0], c[1], layer.key, wx, wy, got[ly*proto.ChunkSize+lx], want)
					}
				}
			}
		}
	}
}

func TestChunkNodesAndDecorAreLocalIndices(t *testing.T) {
	f := newFixture(t)
	// The Woods island chunk certainly has nodes.
	raw := marshal(f.r.chunkMessage(2, 2))
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	nodes, ok := m["nodes"].([]any)
	if !ok || len(nodes) == 0 {
		t.Fatal("chunk (2,2) reported no resource nodes")
	}
	for _, n := range nodes {
		pair := n.([]any)
		local := int(pair[0].(float64))
		kind := uint8(pair[1].(float64))
		if local < 0 || local >= proto.ChunkTiles {
			t.Fatalf("local index %d out of range", local)
		}
		wx := 2*proto.ChunkSize + local%proto.ChunkSize
		wy := 2*proto.ChunkSize + local/proto.ChunkSize
		if got, ok := f.r.world.Nodes[wy*world.SIZE+wx]; !ok || got != kind {
			t.Fatalf("node at local %d maps to world (%d,%d), which has no matching node", local, wx, wy)
		}
	}
	// Empty collections are omitted entirely (§4.2).
	raw = marshal(f.r.chunkMessage(10, 5)) // open ocean
	var ocean map[string]any
	if err := json.Unmarshal(raw, &ocean); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"nodes", "decor", "digs", "structs"} {
		if _, present := ocean[key]; present {
			t.Fatalf("ocean chunk carried an empty %q field", key)
		}
	}
}

// TestVeinsMaskShrinksOceanChunks locks in the §4.3 wire optimisation: worldgen
// fills veins from noise on every tile including open ocean, which made it the
// overwhelming majority of an all-water chunk's payload. Masking it to land
// leaves the server's own copy untouched but collapses the wire form to a
// single run.
func TestVeinsMaskShrinksOceanChunks(t *testing.T) {
	f := newFixture(t)
	// Find a chunk that is entirely water.
	cx, cy := -1, -1
outer:
	for gy := 0; gy < ChunkGrid && cx < 0; gy++ {
		for gx := 0; gx < ChunkGrid; gx++ {
			allWater := true
			for ly := 0; ly < proto.ChunkSize && allWater; ly++ {
				for lx := 0; lx < proto.ChunkSize; lx++ {
					i := (gy*proto.ChunkSize+ly)*world.SIZE + gx*proto.ChunkSize + lx
					if f.r.world.Tiles[i] != world.TWater {
						allWater = false
						break
					}
				}
			}
			if allWater {
				cx, cy = gx, gy
				break outer
			}
		}
	}
	if cx < 0 {
		t.Skip("no all-water chunk in this world")
	}
	m := f.r.chunkMessage(cx, cy)
	veins := m["veins"].(string)
	// One value over 4096 tiles is 4096/255 = 17 runs, so 34 raw bytes.
	if len(veins) > 64 {
		t.Errorf("masked ocean veins is %d base64 chars, expected a handful of runs", len(veins))
	}
	// The server still knows the truth.
	raw := 0
	for ly := 0; ly < proto.ChunkSize; ly++ {
		for lx := 0; lx < proto.ChunkSize; lx++ {
			if f.r.world.Veins[(cy*proto.ChunkSize+ly)*world.SIZE+cx*proto.ChunkSize+lx] != 0 {
				raw++
			}
		}
	}
	if raw == 0 {
		t.Skip("this ocean chunk had no generated veins to mask")
	}
	total := 0
	for _, k := range []string{"tiles", "elev", "veins", "waterTemp", "tileVis"} {
		total += len(m[k].(string))
	}
	t.Logf("ocean chunk (%d,%d): %d veined tiles masked, whole chunk now %d base64 chars", cx, cy, raw, total)
	if total > 400 {
		t.Errorf("an all-water chunk is still %d base64 chars", total)
	}
}

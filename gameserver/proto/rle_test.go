package proto

import (
	"bytes"
	"encoding/base64"
	"fmt"
	"testing"

	"hearth/gameserver/world"
)

// TestRLERoundTripEveryChunk is the load-bearing one: an RLE bug corrupts
// terrain for every player, so every layer of every chunk of the real hearth-1
// world is pushed through encode -> decode and compared byte for byte.
func TestRLERoundTripEveryChunk(t *testing.T) {
	w := world.GenWorld("hearth-1")
	const grid = world.SIZE / ChunkSize

	layers := map[string][]uint8{
		"tiles": w.Tiles, "elev": w.Elev, "veins": w.Veins,
		"waterTemp": w.WaterTemp, "tileVis": w.TileVis,
	}

	var buf [ChunkTiles]byte
	checked := 0
	for cy := 0; cy < grid; cy++ {
		for cx := 0; cx < grid; cx++ {
			for name, src := range layers {
				sliceChunk(src, cx, cy, buf[:])
				enc := EncodeRLE(buf[:])
				got, err := DecodeRLE(enc, ChunkTiles)
				if err != nil {
					t.Fatalf("chunk (%d,%d) layer %s: decode: %v", cx, cy, name, err)
				}
				if len(got) != ChunkTiles {
					t.Fatalf("chunk (%d,%d) layer %s: decoded %d bytes, want %d", cx, cy, name, len(got), ChunkTiles)
				}
				if !bytes.Equal(got, buf[:]) {
					t.Fatalf("chunk (%d,%d) layer %s: round trip differs", cx, cy, name)
				}
				checked++
			}
		}
	}
	if want := grid * grid * len(layers); checked != want {
		t.Fatalf("checked %d layers, want %d", checked, want)
	}
}

func sliceChunk(src []uint8, cx, cy int, dst []byte) {
	x0, y0 := cx*ChunkSize, cy*ChunkSize
	for ly := 0; ly < ChunkSize; ly++ {
		s := (y0+ly)*world.SIZE + x0
		copy(dst[ly*ChunkSize:(ly+1)*ChunkSize], src[s:s+ChunkSize])
	}
}

func TestRLELongRunSplits(t *testing.T) {
	// 4096 identical bytes must become 16 runs of 255 plus one of 16.
	in := bytes.Repeat([]byte{7}, ChunkTiles)
	enc := EncodeRLE(in)
	raw, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) != 2*17 {
		t.Fatalf("got %d encoded bytes, want %d", len(raw), 2*17)
	}
	for i := 0; i < len(raw); i += 2 {
		if raw[i] != 7 {
			t.Fatalf("run %d has value %d, want 7", i/2, raw[i])
		}
		want := byte(255)
		if i == len(raw)-2 {
			want = 16
		}
		if raw[i+1] != want {
			t.Fatalf("run %d has length %d, want %d", i/2, raw[i+1], want)
		}
	}
	got, err := DecodeRLE(enc, ChunkTiles)
	if err != nil || !bytes.Equal(got, in) {
		t.Fatalf("round trip failed: %v", err)
	}
}

func TestRLEBase64IsPadded(t *testing.T) {
	// One run: 2 bytes -> 4 base64 chars with two '=' of padding (§4.3 requires
	// padding to be present).
	enc := EncodeRLE(bytes.Repeat([]byte{3}, 5))
	if enc != base64.StdEncoding.EncodeToString([]byte{3, 5}) {
		t.Fatalf("unexpected encoding %q", enc)
	}
	if enc[len(enc)-1] != '=' {
		t.Fatalf("encoding %q is not padded", enc)
	}
}

func TestRLERejectsCorruptPayloads(t *testing.T) {
	cases := map[string]string{
		"odd byte count": base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		"zero run":       base64.StdEncoding.EncodeToString([]byte{1, 0}),
		"too short":      base64.StdEncoding.EncodeToString([]byte{1, 4}),
		"too long":       EncodeRLE(bytes.Repeat([]byte{1}, ChunkTiles+1)),
		"not base64":     "!!!!",
	}
	for name, enc := range cases {
		if _, err := DecodeRLE(enc, ChunkTiles); err == nil {
			t.Fatalf("%s: expected an error", name)
		}
	}
}

// TestChunkSizeReport prints the measured wire cost of a representative ocean
// chunk and a representative island chunk. It asserts only that RLE beats raw;
// the numbers themselves go in the migration report.
func TestChunkSizeReport(t *testing.T) {
	w := world.GenWorld("hearth-1")
	var buf [ChunkTiles]byte
	report := func(label string, cx, cy int) {
		total := 0
		for _, src := range [][]uint8{w.Tiles, w.Elev, w.Veins, w.WaterTemp, w.TileVis} {
			sliceChunk(src, cx, cy, buf[:])
			enc := EncodeRLE(buf[:])
			raw := base64.StdEncoding.DecodedLen(len(enc))
			total += len(enc)
			t.Log(fmt.Sprintf("%s (%d,%d): raw 4096 -> rle ~%d -> b64 %d", label, cx, cy, raw, len(enc)))
		}
		if total >= 5*ChunkTiles {
			t.Fatalf("%s: base64 total %d is no better than raw %d", label, total, 5*ChunkTiles)
		}
		t.Log(fmt.Sprintf("%s (%d,%d): all five layers, base64 total %d bytes (raw would be %d)", label, cx, cy, total, 5*ChunkTiles))
	}
	report("open ocean", 10, 5)
	report("Woods island", 2, 2)
}

// Command worldparity is the Go side of the worldgen parity harness. It emits
// the same digests (and the same raw dumps) as tools/worldparity/digest.mjs.
//
//	go run ./cmd/worldparity -seeds ../tools/worldparity/seeds.json
//	go run ./cmd/worldparity -seeds ... -mode dump -seed 0 -field tiles -out FILE
package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"

	"hearth/gameserver/world"
)

func fieldBytes(w *world.World, field string) []byte {
	switch field {
	case "tiles":
		return w.Tiles
	case "elev":
		return w.Elev
	case "veins":
		return w.Veins
	case "waterTemp":
		return w.WaterTemp
	case "tileVis":
		return w.TileVis
	case "nodes":
		var b strings.Builder
		for _, i := range world.SortedNodeKeys(w.Nodes) {
			b.WriteString(strconv.Itoa(i))
			b.WriteByte(' ')
			b.WriteString(strconv.Itoa(int(w.Nodes[i])))
			b.WriteByte('\n')
		}
		return []byte(joinTrailing(b.String()))
	case "bergs":
		var b strings.Builder
		for _, i := range world.SortedBergKeys(w.Bergs) {
			b.WriteString(strconv.Itoa(i))
			b.WriteByte('\n')
		}
		return []byte(joinTrailing(b.String()))
	case "decor":
		var b strings.Builder
		for _, i := range world.SortedDecorKeys(w.Decor) {
			b.WriteString(strconv.Itoa(i))
			b.WriteByte(' ')
			b.WriteString(w.Decor[i])
			b.WriteByte('\n')
		}
		return []byte(joinTrailing(b.String()))
	}
	panic("unknown field " + field)
}

// joinTrailing matches the JS `arr.join('\n') + '\n'`, which for an EMPTY array
// yields a single "\n" rather than "".
func joinTrailing(s string) string {
	if s == "" {
		return "\n"
	}
	return s
}

func sha(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Digest mirrors the JSON object produced by digest.mjs.
type Digest struct {
	Seed       string `json:"seed"`
	Tiles      string `json:"tiles"`
	Elev       string `json:"elev"`
	Veins      string `json:"veins"`
	WaterTemp  string `json:"waterTemp"`
	TileVis    string `json:"tileVis"`
	NodesCount int    `json:"nodesCount"`
	Nodes      string `json:"nodes"`
	BergsCount int    `json:"bergsCount"`
	Bergs      string `json:"bergs"`
	DecorCount int    `json:"decorCount"`
	Decor      string `json:"decor"`
}

// DigestSeed generates the world for seed and hashes every field.
func DigestSeed(seed string) Digest {
	w := world.GenWorld(seed)
	return Digest{
		Seed:       seed,
		Tiles:      sha(fieldBytes(w, "tiles")),
		Elev:       sha(fieldBytes(w, "elev")),
		Veins:      sha(fieldBytes(w, "veins")),
		WaterTemp:  sha(fieldBytes(w, "waterTemp")),
		TileVis:    sha(fieldBytes(w, "tileVis")),
		NodesCount: len(w.Nodes),
		Nodes:      sha(fieldBytes(w, "nodes")),
		BergsCount: len(w.Bergs),
		Bergs:      sha(fieldBytes(w, "bergs")),
		DecorCount: len(w.Decor),
		Decor:      sha(fieldBytes(w, "decor")),
	}
}

func main() {
	seedsPath := flag.String("seeds", "../tools/worldparity/seeds.json", "path to seeds.json")
	mode := flag.String("mode", "digest", "digest | dump")
	seedIdx := flag.Int("seed", 0, "seed index for dump mode")
	field := flag.String("field", "tiles", "field for dump mode")
	out := flag.String("out", "", "output file for dump mode")
	flag.Parse()

	raw, err := os.ReadFile(*seedsPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var seeds []string
	if err := json.Unmarshal(raw, &seeds); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	switch *mode {
	case "digest":
		res := make([]Digest, 0, len(seeds))
		for _, s := range seeds {
			res = append(res, DigestSeed(s))
		}
		enc := json.NewEncoder(os.Stdout)
		enc.SetIndent("", "  ")
		enc.SetEscapeHTML(false)
		if err := enc.Encode(res); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	case "dump":
		w := world.GenWorld(seeds[*seedIdx])
		if err := os.WriteFile(*out, fieldBytes(w, *field), 0o644); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	default:
		fmt.Fprintln(os.Stderr, "unknown -mode")
		os.Exit(2)
	}
}

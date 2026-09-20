package room

import (
	"sort"

	"hearth/gameserver/proto"
	"hearth/gameserver/world"
)

// ChunkGrid is the number of chunks along one world edge: 1280 / 64 = 20.
const ChunkGrid = world.SIZE / proto.ChunkSize

// staticChunk is the part of a chunk message derived purely from the immutable
// generated world. It is built once per chunk, lazily, and shared by every
// player — the RLE encode is the expensive part and the world never changes.
type staticChunk struct {
	tiles     string
	elev      string
	veins     string
	waterTemp string
	tileVis   string
	nodes     [][2]int
	decor     []any
	bergs     []int
}

func chunkKey(cx, cy int) int { return cy*ChunkGrid + cx }

// chunkOf returns the chunk coordinates containing a tile position.
func chunkOf(x, y float64) (int, int) {
	cx := int(trunc32(x)) / proto.ChunkSize
	cy := int(trunc32(y)) / proto.ChunkSize
	return cx, cy
}

// buildStatic slices the five world layers for one chunk and RLE-encodes them.
func (r *Room) buildStatic(cx, cy int) *staticChunk {
	if sc, ok := r.chunkCache[chunkKey(cx, cy)]; ok {
		return sc
	}
	x0, y0 := cx*proto.ChunkSize, cy*proto.ChunkSize
	var tiles, elev, veins, wtemp, tvis [proto.ChunkTiles]byte
	for ly := 0; ly < proto.ChunkSize; ly++ {
		src := (y0+ly)*world.SIZE + x0
		dst := ly * proto.ChunkSize
		copy(tiles[dst:dst+proto.ChunkSize], r.world.Tiles[src:src+proto.ChunkSize])
		copy(elev[dst:dst+proto.ChunkSize], r.world.Elev[src:src+proto.ChunkSize])
		// veins is masked to land ON THE WIRE (protocol §4.3). Worldgen fills
		// it from noise on every tile including open ocean, which makes it
		// high-entropy and, measured, 1376 of the 1568 bytes of an all-water
		// chunk. Ore is only ever reachable underground beneath land, so the
		// wire carries 0 over water. r.world.Veins keeps the true value — dig
		// and every other server rule still read it unmasked.
		for lx := 0; lx < proto.ChunkSize; lx++ {
			if r.world.Tiles[src+lx] != world.TWater {
				veins[dst+lx] = r.world.Veins[src+lx]
			}
		}
		copy(wtemp[dst:dst+proto.ChunkSize], r.world.WaterTemp[src:src+proto.ChunkSize])
		copy(tvis[dst:dst+proto.ChunkSize], r.world.TileVis[src:src+proto.ChunkSize])
	}
	sc := &staticChunk{
		tiles:     proto.EncodeRLE(tiles[:]),
		elev:      proto.EncodeRLE(elev[:]),
		veins:     proto.EncodeRLE(veins[:]),
		waterTemp: proto.EncodeRLE(wtemp[:]),
		tileVis:   proto.EncodeRLE(tvis[:]),
	}
	// Sparse per-tile data. Iterating the whole-world maps once per chunk would
	// be 400 x len(map); instead walk the chunk's own tile range.
	for ly := 0; ly < proto.ChunkSize; ly++ {
		for lx := 0; lx < proto.ChunkSize; lx++ {
			i := (y0+ly)*world.SIZE + (x0 + lx)
			local := ly*proto.ChunkSize + lx
			if k, ok := r.world.Nodes[i]; ok {
				sc.nodes = append(sc.nodes, [2]int{local, int(k)})
			}
			if d, ok := r.world.Decor[i]; ok {
				sc.decor = append(sc.decor, []any{local, d})
			}
			if r.world.Bergs[i] {
				sc.bergs = append(sc.bergs, local)
			}
		}
	}
	r.chunkCache[chunkKey(cx, cy)] = sc
	return sc
}

// chunkMessage assembles the full chunk frame: cached static layers plus the
// mutable overlays (digs, structures) as of this moment. Chunks are a snapshot
// at send time; later changes arrive as incremental messages (§4.4).
func (r *Room) chunkMessage(cx, cy int) map[string]any {
	sc := r.buildStatic(cx, cy)
	m := map[string]any{
		"t": "chunk", "cx": cx, "cy": cy,
		"tiles": sc.tiles, "elev": sc.elev, "veins": sc.veins,
		"waterTemp": sc.waterTemp, "tileVis": sc.tileVis,
	}
	if len(sc.nodes) > 0 {
		m["nodes"] = sc.nodes
	}
	if len(sc.decor) > 0 {
		m["decor"] = sc.decor
	}
	if len(sc.bergs) > 0 {
		m["bergs"] = sc.bergs
	}
	x0, y0 := cx*proto.ChunkSize, cy*proto.ChunkSize
	inChunk := func(i int) (int, bool) {
		x, y := i%world.SIZE, i/world.SIZE
		if x < x0 || x >= x0+proto.ChunkSize || y < y0 || y >= y0+proto.ChunkSize {
			return 0, false
		}
		return (y-y0)*proto.ChunkSize + (x - x0), true
	}
	// Mutable overlays. Everything below is a snapshot at send time; later
	// changes arrive as the incremental messages (§4.4).
	locals := func(set map[int]bool) []int {
		var out []int
		for i := range set {
			if local, ok := inChunk(i); ok {
				out = append(out, local)
			}
		}
		sort.Ints(out)
		return out
	}
	if v := locals(r.digs); len(v) > 0 {
		m["digs"] = v
	}
	if v := locals(r.torches); len(v) > 0 {
		m["torches"] = v
	}
	if v := locals(r.mudTiles); len(v) > 0 {
		m["mud"] = v
	}
	if v := locals(r.brokenBergs); len(v) > 0 {
		m["brokenBergs"] = v
	}
	// removed: nodes the chunk's `nodes` array still lists but that are
	// currently harvested and awaiting respawn.
	var removed []int
	for i := range r.removed {
		if local, ok := inChunk(i); ok {
			removed = append(removed, local)
		}
	}
	if len(removed) > 0 {
		sort.Ints(removed)
		m["removed"] = removed
	}
	// structs are [localIdx, kind, hp, dir, lvl] — the same tuple the legacy
	// init sent. dir drives fence and decor orientation and must not be dropped.
	if v := sortedInChunk(r.structures, inChunk); len(v) > 0 {
		structs := make([]any, 0, len(v))
		for _, e := range v {
			s := r.structures[e.i]
			structs = append(structs, []any{e.local, s.Kind, s.HP, s.Dir, s.lvlOr1()})
		}
		m["structs"] = structs
	}
	if v := sortedInChunk(r.furn, inChunk); len(v) > 0 {
		furn := make([]any, 0, len(v))
		for _, e := range v {
			f := r.furn[e.i]
			furn = append(furn, []any{e.local, f.Kind, f.Z})
		}
		m["furn"] = furn
	}
	if v := sortedInChunk(r.farms, inChunk); len(v) > 0 {
		farms := make([]any, 0, len(v))
		for _, e := range v {
			fm := r.farms[e.i]
			farms = append(farms, []any{e.local, fm.Crop, r.cropStage(fm)})
		}
		m["farms"] = farms
	}
	return m
}

// chunkEntry pairs a world tile index with its local index inside a chunk.
type chunkEntry struct{ i, local int }

// sortedInChunk returns the entries of a tile-keyed map that fall inside a
// chunk, in tile order, so a chunk frame is byte-stable for a given state.
func sortedInChunk[V any](m map[int]V, inChunk func(int) (int, bool)) []chunkEntry {
	var out []chunkEntry
	for i := range m {
		if local, ok := inChunk(i); ok {
			out = append(out, chunkEntry{i, local})
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].i < out[b].i })
	return out
}

// pushChunks sends every not-yet-sent chunk within Chebyshev radius
// proto.ChunkRadius of the player's current chunk (§4.1). It is a no-op unless
// the player has just joined or crossed a chunk boundary, so the common case
// costs two integer divisions and a comparison.
func (r *Room) pushChunks(p *Player) {
	cx, cy := chunkOf(p.X, p.Y)
	if p.chunkInit && cx == p.chunkCX && cy == p.chunkCY {
		return
	}
	p.chunkCX, p.chunkCY, p.chunkInit = cx, cy, true
	for dy := -proto.ChunkRadius; dy <= proto.ChunkRadius; dy++ {
		for dx := -proto.ChunkRadius; dx <= proto.ChunkRadius; dx++ {
			nx, ny := cx+dx, cy+dy
			if nx < 0 || ny < 0 || nx >= ChunkGrid || ny >= ChunkGrid {
				continue
			}
			k := chunkKey(nx, ny)
			if p.sentChunks[k] {
				continue
			}
			p.sentChunks[k] = true
			r.send(p, r.chunkMessage(nx, ny))
		}
	}
}

package world

// Island camps: small settlements of non-player folk (villagers, a hunter, an
// elder) around a hut and a fire. Like the medics, a camp's tiles are a
// deterministic function of the world, so every restart puts it in the same
// place — except that a tile in `reserved` (medic tiles, the spawn, player
// structures already in the save) is never chosen, so an old base is never
// built over.

// FolkCamp is one camp: its hut tile, the fire in front of it, and the roster
// of folk sprite keys who live there.
type FolkCamp struct {
	ID         string
	IslandID   string
	HutSprite  string
	HutX, HutY int
	FireX      int
	FireY      int
	Folk       []string
}

type folkCampDef struct {
	island string
	off    [2]int
	hut    string
	folk   []string
}

// folkCampDefs: the Woods camp is the Hearthfolk's, the Dunes camp an Ashmark
// hunter's lodge, the Marsh camp Elder Yvenne's. The Spire has its medic and is
// too harsh for anyone else.
var folkCampDefs = []folkCampDef{
	{"woods", [2]int{-8, 7}, "folk_hut", []string{"villager", "villager2", "woods_child"}},
	{"dunes", [2]int{-8, -9}, "folk_hut_dunes", []string{"ashmark_hunter", "villager2"}},
	{"marsh", [2]int{9, -9}, "folk_hut_marsh", []string{"elder_yvenne", "villager"}},
}

// CampBlockTiles are the tiles a camp occupies: the hut and the fire. The door
// tile in front of the hut is left open — folk walk through it.
func CampBlockTiles(c FolkCamp) [2]int {
	return [2]int{c.HutY*SIZE + c.HutX, c.FireY*SIZE + c.FireX}
}

// FindFolkCamps places every camp it can. A camp with no valid site is skipped
// rather than failing the world: folk are ambience, not progression.
func FindFolkCamps(w *World, reserved map[int]bool) []FolkCamp {
	out := make([]FolkCamp, 0, len(folkCampDefs))
	for _, d := range folkCampDefs {
		var island MajorIsland
		for _, cand := range MajorIslands {
			if cand.ID == d.island {
				island = cand
			}
		}
		cx, cy := island.Center[0], island.Center[1]
		open := func(x, y int) bool {
			if x < 0 || y < 0 || x >= SIZE || y >= SIZE {
				return false
			}
			i := y*SIZE + x
			_, hasNode := w.Nodes[i]
			return w.Tiles[i] == island.Tile && !hasNode && !LandmarkBlock[i] && !reserved[i]
		}
		hx, hy, ok := FindNearestValidTile(cx+d.off[0], cy+d.off[1], func(x, y, _ int) bool {
			// the hut, its door and a yard in front of it are all open ground
			return jsHypot(float64(x-cx), float64(y-cy)) > 5 &&
				open(x, y) && open(x+1, y+1) && open(x+2, y+1) && open(x+1, y+2)
		}, 30)
		if !ok {
			continue
		}
		fx, fy, ok := FindNearestValidTile(hx+2, hy+3, func(x, y, _ int) bool {
			return open(x, y) && max(abs(x-hx), abs(y-hy)) >= 2 && !(x == hx+1 && y == hy+1)
		}, 4)
		if !ok {
			continue
		}
		out = append(out, FolkCamp{
			ID: "camp-" + d.island, IslandID: d.island, HutSprite: d.hut,
			HutX: hx, HutY: hy, FireX: fx, FireY: fy,
			Folk: append([]string(nil), d.folk...),
		})
	}
	return out
}

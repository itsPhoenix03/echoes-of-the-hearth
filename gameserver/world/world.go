package world

import (
	"fmt"
	"math"
	"sort"
)

// Literal port of shared/world.js. Ordering, comparison thresholds and
// arithmetic are kept exactly as written in the JS; the only structural change
// is that JS Maps/Sets become Go maps whose iteration is never used to drive
// generation (only lookups), and every ordered output is produced by sorting.

const (
	WorldVersion = 4
	SIZE         = 1280
)

// Tile types (shared/world.js T).
const (
	TGrass  uint8 = 0
	TSand   uint8 = 1
	TSnow   uint8 = 2
	TMud    uint8 = 3
	TWater  uint8 = 4
	TBlight uint8 = 5
)

// Node kinds (shared/defs.js NODE).
const (
	NodeTree      uint8 = 0
	NodeBoulder   uint8 = 1
	NodeBush      uint8 = 2
	NodeStone     uint8 = 3
	NodeCrystal   uint8 = 4
	NodeStarmetal uint8 = 5
)

// TileKeys mirrors TILE_KEYS.
var TileKeys = []string{"grass", "sand", "snow", "mud", "water", "blight"}

// ISLES: Woods, Dunes, Spire, Marsh.
var ISLES = [4][2]int{{180, 180}, {1100, 180}, {180, 1100}, {1100, 1100}}

// ISLE_R is the base major-island radius.
const ISLE_R = 70

// MONOLITHS aliases ISLES in the JS.
var MONOLITHS = ISLES

// CORE is the world centre.
var CORE = [2]int{640, 640}

// MajorIsland mirrors an entry of MAJOR_ISLANDS.
type MajorIsland struct {
	ID     string
	Center [2]int
	Tile   uint8
}

// MajorIslands mirrors MAJOR_ISLANDS.
var MajorIslands = []MajorIsland{
	{"woods", ISLES[0], TGrass},
	{"dunes", ISLES[1], TSand},
	{"spire", ISLES[2], TSnow},
	{"marsh", ISLES[3], TMud},
}

// MedicIsland mirrors an entry of MEDIC_ISLANDS.
type MedicIsland struct {
	IslandID string
	Sprite   string
}

// MedicIslands mirrors MEDIC_ISLANDS.
var MedicIslands = []MedicIsland{
	{"woods", "medic"},
	{"spire", "medic_snow"},
}

var medicAnchorOffsets = map[string][2]int{
	"woods": {10, -8},
	"spire": {10, 8},
}

// ACTIVATION_I is CORE[1] * SIZE + CORE[0].
var ACTIVATION_I = CORE[1]*SIZE + CORE[0]

// MinorIsle mirrors an entry of MINOR_ISLES.
type MinorIsle struct {
	X, Y, R int
	Kind    string
}

// MinorIsles mirrors MINOR_ISLES.
var MinorIsles = []MinorIsle{
	{640, 180, 14, "rock"},
	{640, 1100, 13, "sandbar"},
	{180, 640, 13, "driftwood"},
	{1100, 640, 14, "ruin"},
	{420, 420, 11, "rock"},
	{860, 420, 11, "ruin"},
	{420, 860, 12, "icefloe"},
	{860, 860, 11, "blightshard"},
	{340, 180, 9, "sandbar"},
	{180, 940, 10, "icefloe"},
	{940, 1100, 10, "driftwood"},
	{1100, 340, 9, "rock"},
}

// Mountain mirrors an entry of MOUNTAINS.
type Mountain struct {
	X, Y int
	Key  string
}

// Mountains mirrors MOUNTAINS.
var Mountains = []Mountain{
	{150, 150, "mountain_woods"},
	{1130, 150, "mountain_dunes"},
	{150, 1130, "mountain_spire"},
	{1130, 1130, "mountain_marsh"},
	{640, 630, "mountain_core_obsidian"},
}

// TemplePiece mirrors an entry of TEMPLE_PIECES.
type TemplePiece struct {
	I   int
	Key string
}

// TemplePieces mirrors TEMPLE_PIECES.
var TemplePieces = []TemplePiece{
	{ACTIVATION_I, "core_activation_dais"},
	{(CORE[1]-5)*SIZE + CORE[0], "core_temple_ruins"},
	{(CORE[1]+1)*SIZE + CORE[0] - 5, "core_temple_arch_ruin"},
	{(CORE[1]+1)*SIZE + CORE[0] + 5, "core_temple_pillar_broken"},
	{(CORE[1]+5)*SIZE + CORE[0] - 3, "core_temple_pillar_broken"},
}

// LandmarkBlock holds tile indices blocked by mountains (3x3 footprint) and
// temple pieces other than the dais.
var LandmarkBlock = func() map[int]bool {
	s := map[int]bool{}
	for _, m := range Mountains {
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				s[(m.Y+dy)*SIZE+(m.X+dx)] = true
			}
		}
	}
	for p := 1; p < len(TemplePieces); p++ {
		s[TemplePieces[p].I] = true
	}
	return s
}()

var minorKindTile = map[string]uint8{
	"sandbar":     TSand,
	"ruin":        TSand,
	"driftwood":   TGrass,
	"rock":        TGrass,
	"icefloe":     TSnow,
	"blightshard": TBlight,
}

var isleT = [4]uint8{TGrass, TSand, TSnow, TMud}

func abs(a int) int {
	if a < 0 {
		return -a
	}
	return a
}

func nearPOI(x, y int) bool {
	for _, m := range MONOLITHS {
		if abs(m[0]-x) < 3 && abs(m[1]-y) < 3 {
			return true
		}
	}
	if abs(x-CORE[0]) < 6 && abs(y-CORE[1]) < 6 {
		return true
	}
	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			if LandmarkBlock[(y+dy)*SIZE+(x+dx)] {
				return true
			}
		}
	}
	return false
}

// World mirrors the object returned by genWorld().
type World struct {
	Tiles     []uint8
	Elev      []uint8
	Veins     []uint8
	WaterTemp []uint8
	TileVis   []uint8
	Nodes     map[int]uint8
	Bergs     map[int]bool
	Decor     map[int]string
}

// GenWorld is genWorld(seed).
func GenWorld(seed string) *World {
	elevN := NewNoise2D(NewAlea(seed + "e"))
	veg := NewNoise2D(NewAlea(seed + "t"))
	sct := NewNoise2D(NewAlea(seed + "s"))
	coast := NewNoise2D(NewAlea(seed + "c"))

	w := &World{
		Tiles:     make([]uint8, SIZE*SIZE),
		Elev:      make([]uint8, SIZE*SIZE),
		Veins:     make([]uint8, SIZE*SIZE),
		WaterTemp: make([]uint8, SIZE*SIZE),
		TileVis:   make([]uint8, SIZE*SIZE),
		Nodes:     map[int]uint8{},
		Bergs:     map[int]bool{},
		Decor:     map[int]string{},
	}

	// tile index -> minor isle kind string
	minorKindAt := map[int]string{}

	for y := 0; y < SIZE; y++ {
		fy := float64(y)
		for x := 0; x < SIZE; x++ {
			fx := float64(x)
			i := y*SIZE + x
			el := elevN.Eval(fx/28, fy/28)
			dCore := jsHypot(fx-float64(CORE[0]), fy-float64(CORE[1]))
			t := TWater
			landClass := ""

			if dCore < 14 {
				t = TBlight
				landClass = "core"
			} else {
				// Major islands
				for k := 0; k < 4; k++ {
					d := jsHypot(fx-float64(ISLES[k][0]), fy-float64(ISLES[k][1]))
					if d < float64(ISLE_R)+coast.Eval(fx/9, fy/9)*7 {
						t = isleT[k]
						landClass = "major"
						break
					}
				}
				// Minor islands (only in water)
				if t == TWater {
					for _, m := range MinorIsles {
						d := jsHypot(fx-float64(m.X), fy-float64(m.Y))
						if d < float64(m.R)+coast.Eval(fx/9, fy/9)*4 {
							t = minorKindTile[m.Kind]
							landClass = "minor"
							minorKindAt[i] = m.Kind
							break
						}
					}
				}
				// Inland lakes
				if landClass == "major" && t != TWater && el < -0.4 {
					t = TWater
					landClass = ""
				}
				if landClass == "minor" && t != TWater && el < -0.75 {
					t = TWater
					landClass = ""
					delete(minorKindAt, i)
				}
			}

			w.Tiles[i] = t

			// Iceberg ring around the Frozen Spire
			dSpire := jsHypot(fx-float64(ISLES[2][0]), fy-float64(ISLES[2][1]))
			if t == TWater && dSpire > float64(ISLE_R)+8 && dSpire < float64(ISLE_R)+135 &&
				sct.Eval(fx/2+900, fy/2+900) > 0.88 {
				w.Bergs[i] = true
			}

			// Water temperature
			if t == TWater {
				if dSpire < float64(ISLE_R)+180 {
					w.WaterTemp[i] = 1
				} else if dCore < 125 {
					w.WaterTemp[i] = 2
				}
			}

			// Elevation
			if t == TWater {
				w.Elev[i] = 0
			} else {
				e := uint8(1)
				if el > 0.05 {
					e++
				}
				if el > 0.42 {
					e++
				}
				ridge := 1 - math.Abs(elevN.Eval(fx/13+40, fy/13+40))
				if ridge > 0.82 && e < 3 {
					e++
				}
				w.Elev[i] = e
			}
			if t == TBlight {
				w.Elev[i] = 1
			}

			// Veins
			vm := sct.Eval(fx/5+250, fy/5+250)
			switch {
			case vm > 0.68:
				w.Veins[i] = 1
			case vm < -0.74:
				w.Veins[i] = 2
			default:
				w.Veins[i] = 0
			}

			// tileVis: ~6% of land tiles
			if t != TWater {
				if sct.Eval(fx/4+55, fy/4+55) > 0.55 {
					w.TileVis[i] = 1
				} else {
					w.TileVis[i] = 0
				}
			}

			if t == TWater || t == TBlight || nearPOI(x, y) {
				continue
			}

			v := veg.Eval(fx/6, fy/6)
			s := sct.Eval(fx/3, fy/3)
			isMinor := landClass == "minor"
			mKind := ""
			if isMinor {
				mKind = minorKindAt[i]
			}

			// Starmetal: extremely rare, never on Frozen Spire, never on minors
			if !isMinor && t != TSnow && sct.Eval(fx/2+700, fy/2+700) > 0.985 {
				w.Nodes[i] = NodeStarmetal
				continue
			}

			switch {
			case isMinor:
				if mKind == "driftwood" && v > 0.62 {
					w.Nodes[i] = NodeTree
				} else if s > 0.80 {
					w.Nodes[i] = NodeBush
				} else if s < -0.85 {
					w.Nodes[i] = NodeStone
				}
			case t == TGrass:
				if v > 0.62 {
					w.Nodes[i] = NodeTree
				} else if s > 0.80 {
					w.Nodes[i] = NodeBush
				} else if s < -0.85 {
					w.Nodes[i] = NodeStone
				}
			case t == TSand:
				if s > 0.82 {
					w.Nodes[i] = NodeBoulder
				} else if s < -0.85 {
					w.Nodes[i] = NodeStone
				}
			case t == TSnow:
				if s > 0.84 {
					w.Nodes[i] = NodeCrystal
				} else if v > 0.72 {
					w.Nodes[i] = NodeBoulder
				} else if s < -0.85 {
					w.Nodes[i] = NodeStone
				}
			case t == TMud:
				if s > 0.80 {
					w.Nodes[i] = NodeBush
				} else if v > 0.80 {
					w.Nodes[i] = NodeCrystal
				}
			}

			// Decor: sparse deterministic props, land tiles only, not on node tiles
			if _, has := w.Nodes[i]; !has && !isMinor {
				ds := sct.Eval(fx/3+400, fy/3+400)
				nearSpawn := jsHypot(fx-float64(ISLES[0][0]-12), fy-float64(ISLES[0][1]-12)) < 20
				if !nearSpawn {
					switch {
					case t == TGrass && ds > 0.88 && v < 0:
						w.Decor[i] = "glow_mushroom"
					case t == TSand && ds > 0.93:
						w.Decor[i] = "sand_ruin_pillar"
					case t == TSnow && ds > 0.92:
						w.Decor[i] = "ice_crystal_cluster"
					case t == TMud && ds > 0.92:
						w.Decor[i] = "bone_totem"
					case t == TBlight && ds > 0.85:
						w.Decor[i] = "lava_vent"
					}
				}
			}
		}
	}

	// Clear ALL nodes within radius 7 of CORE (temple clearing).
	// The JS iterates the Map here; the effect is order-independent, so a
	// sorted key slice reproduces it exactly without relying on map order.
	for _, ni := range sortedKeys(w.Nodes) {
		nx := ni % SIZE
		ny := int(toInt32(float64(ni) / SIZE)) // (ni / SIZE) | 0
		if jsHypot(float64(nx-CORE[0]), float64(ny-CORE[1])) < 7 {
			delete(w.Nodes, ni)
		}
	}

	// Stamp solid ground under landmark footprints.
	for _, m := range Mountains {
		isCore := jsHypot(float64(m.X-CORE[0]), float64(m.Y-CORE[1])) < 20
		k, bd := 0, math.Inf(1)
		for q := 0; q < 4; q++ {
			d := jsHypot(float64(m.X-ISLES[q][0]), float64(m.Y-ISLES[q][1]))
			if d < bd {
				bd = d
				k = q
			}
		}
		ground := isleT[k]
		if isCore {
			ground = TBlight
		}
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				i := (m.Y+dy)*SIZE + (m.X + dx)
				if w.Tiles[i] == TWater {
					w.Tiles[i] = ground
					w.Elev[i] = 1
					delete(w.Nodes, i)
				}
			}
		}
	}

	return w
}

func sortedKeys[V any](m map[int]V) []int {
	out := make([]int, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// SortedNodeKeys returns the node tile indices in ascending order.
func SortedNodeKeys(m map[int]uint8) []int { return sortedKeys(m) }

// SortedBergKeys returns the iceberg tile indices in ascending order.
func SortedBergKeys(m map[int]bool) []int { return sortedKeys(m) }

// SortedDecorKeys returns the decor tile indices in ascending order.
func SortedDecorKeys(m map[int]string) []int { return sortedKeys(m) }

// NearestLand is nearestLand(world, x, y).
func NearestLand(w *World, x, y float64) [2]float64 {
	for r := 1; r < 130; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				nx := jsRound(x + float64(dx))
				ny := jsRound(y + float64(dy))
				if nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE {
					continue
				}
				if w.Tiles[int(ny)*SIZE+int(nx)] != TWater {
					return [2]float64{nx, ny}
				}
			}
		}
	}
	return [2]float64{x, y}
}

// Diggable is DIGGABLE(world, i): mining under Woods, Dunes and Spire only.
func Diggable(w *World, i int) bool {
	return w.Tiles[i] == TGrass || w.Tiles[i] == TSand || w.Tiles[i] == TSnow
}

// FindSpawn is findSpawn(world).
func FindSpawn(w *World) [2]int {
	sx, sy := ISLES[0][0]-12, ISLES[0][1]-12 // (168, 168)
	for r := 0; r < 50; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				x, y := sx+dx, sy+dy
				if x < 0 || y < 0 || x >= SIZE || y >= SIZE {
					continue
				}
				i := y*SIZE + x
				if w.Tiles[i] == TGrass {
					if _, has := w.Nodes[i]; !has {
						return [2]int{x, y}
					}
				}
			}
		}
	}
	return [2]int{sx, sy}
}

// FindNearestValidTile is findNearestValidTile(cx, cy, pred, maxR).
func FindNearestValidTile(cx, cy int, pred func(x, y, i int) bool, maxR int) (int, int, bool) {
	for r := 0; r <= maxR; r++ {
		for dy := -r; dy <= r; dy++ {
			for dx := -r; dx <= r; dx++ {
				if max(abs(dx), abs(dy)) != r {
					continue
				}
				x, y := cx+dx, cy+dy
				if x < 0 || y < 0 || x >= SIZE || y >= SIZE {
					continue
				}
				if pred(x, y, y*SIZE+x) {
					return x, y, true
				}
			}
		}
	}
	return 0, 0, false
}

// Medic is one entry of findMedicSpawns().
type Medic struct {
	ID         string
	IslandID   string
	Sprite     string
	X, Y       int
	HutSprite  string
	HutX, HutY int
}

// FindMedicSpawns is findMedicSpawns(world).
func FindMedicSpawns(w *World) ([]Medic, error) {
	out := make([]Medic, 0, len(MedicIslands))
	for _, mi := range MedicIslands {
		var island MajorIsland
		for _, cand := range MajorIslands {
			if cand.ID == mi.IslandID {
				island = cand
				break
			}
		}
		off := medicAnchorOffsets[mi.IslandID]
		cx, cy := island.Center[0], island.Center[1]
		x, y, ok := FindNearestValidTile(cx+off[0], cy+off[1], func(tx, ty, i int) bool {
			_, hasNode := w.Nodes[i]
			return w.Tiles[i] == island.Tile && !hasNode && !LandmarkBlock[i] &&
				jsHypot(float64(tx-cx), float64(ty-cy)) > 5
		}, 40)
		if !ok {
			return nil, fmt.Errorf("findMedicSpawns: no valid tile for medic-%s", mi.IslandID)
		}
		hx, hy, ok := FindNearestValidTile(x, y-2, func(tx, ty, i int) bool {
			_, hasNode := w.Nodes[i]
			return w.Tiles[i] == island.Tile && !hasNode && !LandmarkBlock[i] &&
				jsHypot(float64(tx-x), float64(ty-y)) >= 2
		}, 6)
		if !ok {
			return nil, fmt.Errorf("findMedicSpawns: no valid hut tile for medic-%s", mi.IslandID)
		}
		hutSprite := "medic_hut"
		if mi.IslandID == "spire" {
			hutSprite = "medic_hut_snow"
		}
		out = append(out, Medic{
			ID: "medic-" + mi.IslandID, IslandID: mi.IslandID, Sprite: mi.Sprite,
			X: x, Y: y, HutSprite: hutSprite, HutX: hx, HutY: hy,
		})
	}
	return out, nil
}

// MedicBlockTiles is medicBlockTiles(medics).
func MedicBlockTiles(medics []Medic) map[int]bool {
	s := map[int]bool{}
	for _, m := range medics {
		s[m.HutY*SIZE+m.HutX] = true
	}
	return s
}

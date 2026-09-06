// Package defs loads the game's rules data from shared/defs.json.
//
// shared/defs.json is the single source of truth for recipes, node definitions,
// structure hit points, crops and the medic trade pools. The browser client and
// the legacy Node server read the same file through the generated
// shared/defs.js wrapper; this package unmarshals it directly. Nothing in the Go
// tree may hardcode a cost, a hit-point total or a respawn timer — that is
// exactly the "3 wood on the client, 4 on the server" drift this file exists to
// make impossible.
//
// The data is immutable after load and is therefore safe to read from the room
// goroutine without a lock.
package defs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// NodeDef is one entry of NODE_DEF, keyed by node kind (0..5).
type NodeDef struct {
	HP       int     `json:"hp"`
	Tool     *string `json:"tool"` // nil means bare hands
	AxeBonus bool    `json:"axeBonus"`
	Res      string  `json:"res"`
	N        int     `json:"n"`
	Respawn  int     `json:"respawn"` // seconds
}

// ToolName returns the required tool and whether one is required at all.
func (n NodeDef) ToolName() (string, bool) {
	if n.Tool == nil {
		return "", false
	}
	return *n.Tool, true
}

// Recipe is one entry of RECIPES.
type Recipe struct {
	Cost       map[string]int `json:"cost"`
	Station    *string        `json:"station"` // nil means craftable anywhere
	Place      bool           `json:"place"`
	Tool       bool           `json:"tool"`
	Gear       bool           `json:"gear"`
	Decor      bool           `json:"decor"`
	Zone       string         `json:"zone"` // "in", "out", "both" or ""
	Rot        bool           `json:"rot"`
	Flat       bool           `json:"flat"`
	EngineOnly bool           `json:"engineOnly"`
}

// StationName returns the required crafting station and whether one is needed.
func (r Recipe) StationName() (string, bool) {
	if r.Station == nil {
		return "", false
	}
	return *r.Station, true
}

// Crop is one entry of CROPS.
type Crop struct {
	SeedCost  map[string]int `json:"seedCost"`
	GrowTicks int            `json:"growTicks"`
	Yield     map[string]int `json:"yield"`
}

// TradeRule is one weighted entry of a MEDIC_TRADE_POOLS island pool.
type TradeRule struct {
	Resource string `json:"resource"`
	Min      int    `json:"min"`
	Max      int    `json:"max"`
	Weight   int    `json:"weight"`
}

// Defs is the whole of shared/defs.json.
type Defs struct {
	MaxHP           int                    `json:"MAX_HP"`
	MedicineHeal    int                    `json:"MEDICINE_HEAL"`
	NodeKeys        []string               `json:"NODE_KEYS"`
	Node            map[string]int         `json:"NODE"`
	NodeDef         map[string]NodeDef     `json:"NODE_DEF"`
	Recipes         map[string]Recipe      `json:"RECIPES"`
	Names           map[string]string      `json:"NAMES"`
	Furniture       []string               `json:"FURNITURE"`
	StructHP        map[string]int         `json:"STRUCT_HP"`
	Wooden          []string               `json:"WOODEN"`
	Resources       []string               `json:"RESOURCES"`
	Placeables      []string               `json:"PLACEABLES"`
	DecorNonBlockL  []string               `json:"DECOR_NONBLOCKING"`
	Crops           map[string]Crop        `json:"CROPS"`
	InvKeys         []string               `json:"INV_KEYS"`
	MedicTradePools map[string][]TradeRule `json:"MEDIC_TRADE_POOLS"`

	// Derived set views, built once by finish(). The JSON carries arrays
	// because JSON has no set type; every lookup site wants a set.
	FurnitureSet map[string]bool `json:"-"`
	WoodenSet    map[string]bool `json:"-"`
	DecorNonBlk  map[string]bool `json:"-"`
	// InvKeySet answers "is this a real inventory slot" without a linear scan.
	InvKeySet map[string]bool `json:"-"`
}

func (d *Defs) finish() error {
	if d.MaxHP == 0 || len(d.Recipes) == 0 || len(d.NodeDef) == 0 || len(d.InvKeys) == 0 {
		return fmt.Errorf("defs: shared/defs.json is missing required sections")
	}
	set := func(xs []string) map[string]bool {
		m := make(map[string]bool, len(xs))
		for _, x := range xs {
			m[x] = true
		}
		return m
	}
	d.FurnitureSet = set(d.Furniture)
	d.WoodenSet = set(d.Wooden)
	d.DecorNonBlk = set(d.DecorNonBlockL)
	d.InvKeySet = set(d.InvKeys)
	return nil
}

// NodeDefFor looks up a node definition by numeric kind, mirroring the JS
// NODE_DEF[kind] coercion (JS object keys are strings either way).
func (d *Defs) NodeDefFor(kind int) (NodeDef, bool) {
	nd, ok := d.NodeDef[fmt.Sprint(kind)]
	return nd, ok
}

// EmptyInv builds a fresh inventory with every slot present and zeroed,
// mirroring shared/defs.js emptyInv().
func (d *Defs) EmptyInv() map[string]int {
	m := make(map[string]int, len(d.InvKeys))
	for _, k := range d.InvKeys {
		m[k] = 0
	}
	return m
}

// CanAfford mirrors shared/defs.js canAfford.
func CanAfford(inv map[string]int, cost map[string]int) bool {
	for k, v := range cost {
		if inv[k] < v {
			return false
		}
	}
	return true
}

// Pay mirrors shared/defs.js pay. Callers must have checked CanAfford first —
// the JS version does not check either.
func Pay(inv map[string]int, cost map[string]int) {
	for k, v := range cost {
		inv[k] -= v
	}
}

// LoadFile parses one defs.json.
func LoadFile(path string) (*Defs, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var d Defs
	if err := json.Unmarshal(b, &d); err != nil {
		return nil, fmt.Errorf("defs: %s is not valid JSON: %w", path, err)
	}
	if err := d.finish(); err != nil {
		return nil, err
	}
	return &d, nil
}

// Resolve finds shared/defs.json. HEARTH_DEFS_PATH wins; otherwise it walks up
// from the working directory and then from the executable, so `go test
// ./room`, `go run ./cmd/hearthd` from gameserver/, and a binary run from the
// repo root all find the same file.
func Resolve() (string, error) {
	if p := os.Getenv("HEARTH_DEFS_PATH"); p != "" {
		if _, err := os.Stat(p); err != nil {
			return "", fmt.Errorf("defs: HEARTH_DEFS_PATH=%s: %w", p, err)
		}
		return p, nil
	}
	var roots []string
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, wd)
	}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	for _, root := range roots {
		dir := root
		for i := 0; i < 8; i++ {
			cand := filepath.Join(dir, "shared", "defs.json")
			if _, err := os.Stat(cand); err == nil {
				return cand, nil
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", fmt.Errorf("defs: could not find shared/defs.json above %v — set HEARTH_DEFS_PATH", roots)
}

var (
	once   sync.Once
	loaded *Defs
	loadEr error
)

// Get returns the process-wide definitions, loading them on first use. The data
// is read-only after load, so every goroutine may share it.
func Get() *Defs {
	d, err := Load()
	if err != nil {
		panic(err)
	}
	return d
}

// Load resolves and parses shared/defs.json exactly once per process.
func Load() (*Defs, error) {
	once.Do(func() {
		var path string
		path, loadEr = Resolve()
		if loadEr != nil {
			return
		}
		loaded, loadEr = LoadFile(path)
		if loadEr == nil {
			loadedPath = path
		}
	})
	return loaded, loadEr
}

var loadedPath string

// Path reports which file Load actually read. Empty before a successful load.
func Path() string { return loadedPath }

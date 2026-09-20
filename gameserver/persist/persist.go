// Package persist is the save-game seam: per-player profiles plus everything
// players have changed about the world — structures, carved mine tiles,
// torches, furniture, farms and chest contents.
//
// The legacy Node server owns server/save.json. This package never touches it —
// the Go server writes gameserver/world.save.json instead.
//
// Two fields are stored as elapsed/remaining durations rather than absolute
// clocks, because neither clock survives a restart:
//
//   - Removed holds milliseconds LEFT until a node respawns, not the wall-clock
//     instant (this matches what the legacy save does).
//   - Farms hold ticks ELAPSED since planting, not the absolute tick number.
//     The room's tick counter restarts at zero, so an absolute plantedTick
//     would leave every saved crop permanently unripe.
package persist

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// Profile is the durable per-player record, keyed by ticket userId.
type Profile struct {
	Name   string         `json:"name"`
	X      float64        `json:"x"`
	Y      float64        `json:"y"`
	Z      int            `json:"z"`
	HP     int            `json:"hp"`
	Hunger float64        `json:"hunger"`
	Thirst float64        `json:"thirst"`
	Inv    map[string]int `json:"inv"`
	Tools  []string       `json:"tools"`
	Gear   []string       `json:"gear"`
	Worn   string         `json:"wornGear,omitempty"`
}

// Struct is one placed player structure.
type Struct struct {
	Kind  string `json:"kind"`
	HP    int    `json:"hp"`
	Owner string `json:"owner,omitempty"`
	Dir   int    `json:"dir"`
	Lvl   int    `json:"lvl"`
}

// Furn is one piece of shelter/mine furniture.
type Furn struct {
	Kind  string `json:"kind"`
	Owner string `json:"owner,omitempty"`
	Z     int    `json:"z"`
}

// Module is one placed modular-building piece. The map key is "tile:slot".
type Module struct {
	Kind  string `json:"kind"`
	HP    int    `json:"hp"`
	Dir   int    `json:"dir"`
	Owner string `json:"owner,omitempty"`
}

// Farm is one planted crop. Elapsed is ticks since planting (see the package
// comment for why it is not the absolute plantedTick).
type Farm struct {
	Crop    string `json:"crop"`
	Elapsed int64  `json:"elapsed"`
	Owner   string `json:"owner,omitempty"`
}

// NodeRespawn is one harvested node: the tile and the milliseconds remaining
// before it returns.
type NodeRespawn struct {
	I         int   `json:"i"`
	Remaining int64 `json:"ms"`
}

// Snapshot is everything the room hands to the store on a save. Tile-keyed maps
// use the decimal tile index as the JSON key, because JSON object keys must be
// strings.
type Snapshot struct {
	Version  int                 `json:"version"`
	Seed     string              `json:"seed"`
	Day      int                 `json:"day"`
	Time     float64             `json:"time"`
	Won      bool                `json:"won"`
	Mono     [4]bool             `json:"mono"`
	Profiles map[string]*Profile `json:"profiles"`

	Removed     []NodeRespawn             `json:"removed,omitempty"`
	Mud         []int                     `json:"mud,omitempty"`
	SectorChops map[string]int            `json:"sectorChops,omitempty"`
	Structures  map[string]*Struct        `json:"structures,omitempty"`
	Digs        []int                     `json:"digs,omitempty"`
	Torches     []int                     `json:"torches,omitempty"`
	Furn        map[string]*Furn          `json:"furn,omitempty"`
	BrokenBergs []int                     `json:"brokenBergs,omitempty"`
	Farms       map[string]*Farm          `json:"farms,omitempty"`
	ChestInv    map[string]map[string]int `json:"chestInv,omitempty"`
	Modules     map[string]*Module        `json:"modules,omitempty"`
}

// Store is the persistence seam. Implementations must be safe to call from the
// room goroutine only; the room is the sole caller.
type Store interface {
	Load() (*Snapshot, error) // returns nil, nil when there is nothing saved
	Save(*Snapshot) error
}

// NopStore discards everything. Used in tests and when persistence is disabled.
type NopStore struct{}

// Load reports no saved state.
func (NopStore) Load() (*Snapshot, error) { return nil, nil }

// Save discards the snapshot.
func (NopStore) Save(*Snapshot) error { return nil }

// JSONStore writes a single JSON document, replaced atomically via a temp file
// plus rename so a crash mid-write cannot truncate the save.
type JSONStore struct {
	Path string
	mu   sync.Mutex
}

// NewJSONStore returns a store backed by path.
func NewJSONStore(path string) *JSONStore { return &JSONStore{Path: path} }

// Load reads the snapshot, returning (nil, nil) when the file does not exist.
func (s *JSONStore) Load() (*Snapshot, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.Path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var snap Snapshot
	if err := json.Unmarshal(b, &snap); err != nil {
		return nil, fmt.Errorf("persist: %s is not valid JSON: %w", s.Path, err)
	}
	return &snap, nil
}

// Save writes the snapshot atomically.
func (s *JSONStore) Save(snap *Snapshot) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if dir := filepath.Dir(s.Path); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, s.Path)
}

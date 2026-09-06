package room

import (
	"sort"

	"hearth/gameserver/defs"
)

// Player is the room's view of a connected client. Every field is owned by the
// room goroutine — nothing here is read or written from a socket goroutine, so
// none of it is guarded by a lock.
type Player struct {
	S *Session

	X, Y float64
	Z    int
	B    int // boat: 0 none, 1 wooden, 2 reinforced

	HP int
	// Hunger and Thirst are fractional: the survival tick drains them by
	// 0.055 / 0.083 every five seconds, and the client is shown the ceiling.
	Hunger float64
	Thirst float64
	// ThermN counts consecutive thermal-water ticks; a matching cloak halves
	// the damage by only letting every second tick through.
	ThermN int

	Inv   map[string]int
	Tools map[string]bool
	Gear  map[string]bool
	Worn  string
	Equip string

	Name string

	LastLandX, LastLandY float64

	// Movement validation clocks, all in ms since the Unix epoch, mirroring the
	// legacy server's Date.now() fields one for one.
	LastPosAt    int64
	LastZAt      int64
	LastFixAt    int64
	WarpUntil    int64
	LastDamageAt int64
	LastGather   int64
	LastAtk      int64
	LastUseAt    int64

	// Terrain streaming state (§4.1). sentChunks is keyed by cy*ChunkGrid+cx.
	sentChunks map[int]bool
	chunkCX    int
	chunkCY    int
	chunkInit  bool
}

func newPlayer(s *Session, spawn [2]int, now int64, d *defs.Defs) *Player {
	return &Player{
		S: s,
		X: float64(spawn[0]), Y: float64(spawn[1]), Z: 0, B: 0,
		HP: d.MaxHP, Hunger: 10, Thirst: 10,
		Inv:   d.EmptyInv(),
		Tools: map[string]bool{},
		Gear:  map[string]bool{},
		Name:  s.Name,
		// The legacy server tracks the last non-water tile so a wrecked boat has
		// somewhere to put the swimmer. Slice 1 keeps the field current; the
		// recovery move that consumes it arrives with the later slice.
		LastLandX: float64(spawn[0]), LastLandY: float64(spawn[1]),
		LastPosAt:  now,
		sentChunks: map[int]bool{},
	}
}

// keysOf returns the set as a sorted slice so the JSON is deterministic.
func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out
}

package room

import (
	"math"
	"math/rand"

	"hearth/gameserver/defs"
	"hearth/gameserver/world"
)

// Farm is one planted crop. plantedTick is the room tick at planting, which is
// what the growth formula measures against; lastStage is the last stage already
// broadcast, so the growth tick only speaks when something actually changed.
type Farm struct {
	Crop        string
	PlantedTick int64
	Owner       string
	lastStage   int // -1 until the first broadcast
}

// waveState mirrors the legacy `wave` object: a four-minute defence timer armed
// by building the World Engine.
type waveState struct {
	until   int64
	engineI int
}

// growDiv mirrors server/index.js GROW_DIV: DEV shortens every crop by 30x.
// It is read once at room construction so a test can flip the env var.
func growDiv(dev bool) int {
	if dev {
		return 30
	}
	return 1
}

// growTicks is the legacy `(crop.growTicks / GROW_DIV) | 0`.
func (r *Room) growTicks(c defs.Crop) int {
	return int(trunc32(float64(c.GrowTicks) / float64(r.growDivisor)))
}

// cropStage is the legacy stage formula, shared by init, plant, harvest and the
// growth tick so they can never disagree about what is ripe.
//
//	stage = min(2, floor(3 * (tickN - plantedTick) / growTicks))
func (r *Room) cropStage(f *Farm) int {
	c, ok := r.defs.Crops[f.Crop]
	if !ok {
		return 0
	}
	gt := r.growTicks(c)
	if gt <= 0 {
		return 2
	}
	stage := int(math.Floor(3 * float64(r.tickN-f.PlantedTick) / float64(gt)))
	if stage > 2 {
		stage = 2
	}
	if stage < 0 {
		stage = 0 // the legacy init clamps with Math.max(0, stage)
	}
	return stage
}

// isNight mirrors shared/time.js isNightTime.
func (r *Room) isNight() bool { return r.time > NightStart || r.time < NightEnd }

// Day/night boundaries, shared/time.js.
const (
	NightStart = 0.72
	NightEnd   = 0.08
)

// tileVoid is what a tile lookup outside the world returns. JavaScript hands
// back `undefined` for an out-of-range array index, which compares equal to no
// real tile value; Go would panic on the same index, so every lookup that can
// escape the world (a 3x3 neighbourhood on the world edge, a carve radius
// around a shaft) goes through the helpers below instead of indexing directly.
const tileVoid uint8 = 255

// tileAt reads world.tiles[i] safely.
func (r *Room) tileAt(i int) uint8 {
	if i < 0 || i >= len(r.world.Tiles) {
		return tileVoid
	}
	return r.world.Tiles[i]
}

// tileAtXY reads world.tiles[ti(x, y)] safely, including for coordinates that
// fall off the edge of the world.
func (r *Room) tileAtXY(x, y float64) uint8 {
	if x < 0 || y < 0 || x >= world.SIZE || y >= world.SIZE {
		return tileVoid
	}
	return r.tileAt(ti(x, y))
}

// diggable is world.Diggable with the bounds check the JS version gets for free.
func (r *Room) diggable(i int) bool {
	if i < 0 || i >= len(r.world.Tiles) {
		return false
	}
	return world.Diggable(r.world, i)
}

// blockedTile is the legacy blocked(): used for BUILD placement, where water is
// solid. It is deliberately not posBlocked(), which lets a player swim.
func (r *Room) blockedTile(x, y float64) bool {
	if x < 0 || y < 0 || x >= world.SIZE || y >= world.SIZE {
		return true
	}
	i := ti(x, y)
	if r.world.Tiles[i] == world.TWater {
		return true
	}
	if r.medicTiles[i] {
		return true
	}
	s, ok := r.structures[i]
	if !ok {
		return false
	}
	// non-blocking decor and farmplots do not obstruct movement
	if r.defs.DecorNonBlk[s.Kind] || s.Kind == "farmplot" {
		return false
	}
	return true
}

// nearAnyStruct reports whether any structure sits within r tiles of the player.
func (rm *Room) nearAnyStruct(p *Player, radius float64) bool {
	for i := range rm.structures {
		if math.Hypot(float64(i%world.SIZE)-p.X, float64(i/world.SIZE)-p.Y) <= radius {
			return true
		}
	}
	return false
}

// nearStruct reports whether a structure of the given kind is within radius.
// The legacy default radius is 4 (crafting stations).
func (rm *Room) nearStruct(p *Player, kind string, radius float64) bool {
	for i, s := range rm.structures {
		if s.Kind != kind {
			continue
		}
		if math.Hypot(float64(i%world.SIZE)-p.X, float64(i/world.SIZE)-p.Y) <= radius {
			return true
		}
	}
	return false
}

// sendInv is the legacy sendInv: the client's whole inventory view in one frame.
func (r *Room) sendInv(p *Player) {
	r.send(p, map[string]any{
		"t": "inv", "inv": p.Inv, "tools": keysOf(p.Tools), "gear": keysOf(p.Gear),
		"wornGear": nullable(p.Worn),
	})
}

// healPlayer mirrors the legacy helper, returning how much was actually healed.
func (r *Room) healPlayer(p *Player, amount int, source string) int {
	if amount <= 0 || p.HP <= 0 || p.HP >= r.defs.MaxHP {
		return 0
	}
	healed := amount
	if room := r.defs.MaxHP - p.HP; healed > room {
		healed = room
	}
	p.HP += healed
	r.send(p, map[string]any{"t": "hp", "hp": p.HP, "healed": healed, "source": source})
	return healed
}

// --- validated action protocol (seq/act) ---------------------------------
//
// seq correlates client requests to server outcomes for reconciliation and
// dedup ONLY — it is never a security token. An invalid seq becomes null and
// the action still runs, exactly as in the legacy server.

// validSeq mirrors `Number.isInteger(v) && v >= 0 && v < 2**31 ? v : null`.
// The bool result distinguishes "null" from "zero".
func validSeq(m map[string]any) any {
	v, ok := m["seq"]
	if !ok {
		return nil
	}
	f, isNum := v.(float64)
	if !isNum || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f >= 2147483648 {
		return nil
	}
	return int64(f)
}

// clampDir mirrors `Math.max(-1, Math.min(1, Number(v) || 0))`. It is a float
// clamp, not a sign — the client sends fractional facing components.
func clampDir(m map[string]any, key string) float64 {
	f := getNum(m, key)
	if math.IsNaN(f) || f == 0 {
		return 0 // Number(v) || 0
	}
	return math.Max(-1, math.Min(1, f))
}

func (r *Room) reject(p *Player, seq any, reason string) {
	r.send(p, map[string]any{"t": "actReject", "seq": seq, "reason": reason})
}

// --- small JS-coercion helpers -------------------------------------------

// nullable renders an empty string as JSON null, which is how the legacy server
// represents "no cloak worn" / "nothing equipped".
func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// tileIndex reads a client-supplied tile index. JS would happily use a
// fractional or out-of-range value as a Map key and simply miss; Go indexes
// slices directly, so anything that is not a real tile is refused up front.
func tileIndex(m map[string]any, key string) (int, bool) {
	f := getNum(m, key)
	if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || f < 0 || f >= world.SIZE*world.SIZE {
		return 0, false
	}
	return int(f), true
}

// jsTruthy mirrors JS truthiness for the one place the legacy server relies on
// it: `const dir = m.dir ? 1 : 0`.
func jsTruthy(m map[string]any, key string) bool {
	switch v := m[key].(type) {
	case nil:
		return false
	case bool:
		return v
	case float64:
		return v != 0 && !math.IsNaN(v)
	case string:
		return v != ""
	default:
		return v != nil
	}
}

// chance is `Math.random() < p`.
func chance(p float64) bool { return rand.Float64() < p }

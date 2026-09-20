package room

import (
	"math"

	"hearth/gameserver/world"
)

// --- movement validation: client positions are untrusted, and every other
// handler range-checks against p.X/p.Y — so an unvalidated 'pos' would defeat
// all of them. Constants and logic are a straight port of server/index.js.
const (
	MaxSpeed     = 6.2   // fastest world-space speed in the game: sailing
	SpeedSlack   = 1.6   // headroom for lag, jitter and frame batching
	PosSlack     = 1.0   // flat allowance absorbing the client's 100ms send-throttle boundary
	ZNear        = 3.0   // a layer change must land next to its mineshaft/shelter anchor
	ZCooldownMS  = 500   // minimum gap between accepted layer changes
	FixMS        = 250   // at most one snapback per player per window
	WarpGraceMS  = 1000  // after a server-side teleport, forgive in-flight 'pos' from the old spot
	MaxHP        = 10    // shared/defs.js MAX_HP
	DayLengthSec = 900.0 // shared/time.js DAY_LENGTH_SEC
	TickMS       = 200   // shared/time.js TICK_MS
)

// ti is the JS ti(x, y) helper: truncate both coordinates, then index.
func ti(x, y float64) int {
	return int(trunc32(y))*world.SIZE + int(trunc32(x))
}

// trunc32 mirrors the JS bitwise-or-zero coercion for coordinates already
// range-checked to [0, SIZE), where it is simply truncation toward zero.
func trunc32(v float64) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	return math.Trunc(v)
}

// Structure is a placed player structure. Slice 1 never creates one — the
// gathering/crafting/building slice does — but the movement rules read the map,
// so it exists from day one and posBlocked/zAnchor are already correct for it.
type Structure struct {
	Kind  string
	HP    int
	Owner string
	Dir   int
	Lvl   int
}

// Furniture is shelter/mine furniture. Empty in Slice 1; see Structure.
type Furniture struct {
	Kind  string
	Owner string
	Z     int
}

// posBlocked mirrors the client's blockedAt() — z-aware. It is deliberately NOT
// the legacy blocked(), which treats WATER as solid: that would forbid swimming
// and boats outright. Water is passable at z=0.
func (r *Room) posBlocked(x, y float64, z int, fromX, fromY float64) bool {
	if !(x >= 0 && y >= 0 && x < world.SIZE && y < world.SIZE) {
		return true
	}
	i := ti(x, y)
	if z == 1 {
		return !r.digs[i] // underground: only carved tunnels
	}
	if z == 2 {
		return false // shelter interior: the server has no shelterAnchor
	}
	if r.world.Tiles[i] == world.TWater {
		return false // swim / sail
	}
	// the permissive jump bound: the server cannot observe the client's jumpT,
	// so allow the jump case
	if int(r.world.Elev[i])-int(r.world.Elev[ti(fromX, fromY)]) > 2 {
		return true
	}
	if r.medicTiles[i] || world.LandmarkBlock[i] {
		return true
	}
	s, ok := r.structures[i]
	// shelters are enterable; non-blocking decor and farmplots are walkable
	if ok && s.Kind != "shelter" && !r.defs.DecorNonBlk[s.Kind] && s.Kind != "farmplot" {
		return true
	}
	return false
}

// warped is called after ANY server-side reposition — otherwise the client's
// already-in-flight pos from the OLD location is rejected and the two sides
// fight over the position.
func (r *Room) warped(p *Player) {
	t := r.now()
	p.LastPosAt = t
	p.WarpUntil = t + WarpGraceMS
}

// zAnchor gates layer changes. A legit layer change happens at ONE structure:
// the player stands next to it and lands on its anchor, so origin AND
// destination are both within ZNear of that same structure. Checking the
// destination alone would let a client "transition" to any mineshaft or shelter
// on the map — an unbounded teleport, since the z branch skips the distance
// check.
func (r *Room) zAnchor(kind string, ax, ay, bx, by float64) bool {
	for i, s := range r.structures {
		if s.Kind != kind {
			continue
		}
		sx := float64(i % world.SIZE)
		sy := float64(i / world.SIZE)
		if math.Hypot(sx-ax, sy-ay) <= ZNear && math.Hypot(sx-bx, sy-by) <= ZNear {
			return true
		}
	}
	return false
}

// respawnPoint mirrors the legacy helper. Slice 1 has no beds or campfires, so
// it always falls through to the world spawn; the loops are kept so the later
// slice only has to populate the maps.
func (r *Room) respawnPoint(id string) (float64, float64) {
	for i, f := range r.furn {
		if f.Kind == "bed" && f.Owner == id {
			return float64(i % world.SIZE), float64(i/world.SIZE) + 1
		}
	}
	bx, by := float64(r.spawn[0]), float64(r.spawn[1])
	bd := 1e9
	for i, s := range r.structures {
		if s.Kind == "campfire" && s.Owner == id {
			x := float64(i % world.SIZE)
			y := float64(i / world.SIZE)
			d := math.Hypot(x-float64(r.spawn[0]), y-float64(r.spawn[1]))
			if d < bd {
				bd = d
				bx, by = x, y+1
			}
		}
	}
	return bx, by
}

// handlePos is the port of the legacy pos handler, including the snapback
// throttle, the dt clamp, the zAnchor gate, the exit-collision skip and fall
// damage. Read alongside server/index.js — the ordering matters.
func (r *Room) handlePos(p *Player, m map[string]any) {
	now := r.now()
	nx := getNum(m, "x")
	ny := getNum(m, "y")
	nz := p.Z
	if has(m, "z") {
		nz = getInt32(m, "z")
	}
	nb := 0
	if has(m, "b") {
		nb = getInt32(m, "b")
	}

	snapback := func() {
		// on reject too, or a rejected client accumulates movement budget
		p.LastPosAt = now
		if now-p.LastFixAt >= FixMS {
			p.LastFixAt = now
			r.send(p, map[string]any{"t": "fix", "x": p.X, "y": p.Y, "z": p.Z, "b": p.B})
		}
	}

	if math.IsNaN(nx) || math.IsInf(nx, 0) || math.IsNaN(ny) || math.IsInf(ny, 0) ||
		nx < 0 || ny < 0 || nx >= world.SIZE || ny >= world.SIZE ||
		nz < 0 || nz > 2 || nb < 0 || nb > 2 {
		snapback()
		return
	}

	zChange := nz != p.Z
	if zChange {
		// every legit layer change is a scripted teleport onto a
		// mineshaft/shelter anchor, so travelled distance is meaningless — a
		// single shared structure bounding BOTH endpoints is the gate
		if (nz == 1 || p.Z == 1) && !r.zAnchor("mineshaft", p.X, p.Y, nx, ny) {
			snapback()
			return
		}
		if (nz == 2 || p.Z == 2) && !r.zAnchor("shelter", p.X, p.Y, nx, ny) {
			snapback()
			return
		}
		if now-p.LastZAt < ZCooldownMS {
			snapback()
			return
		}
	} else if now >= p.WarpUntil {
		// dt is clamped to 1s: a client that goes quiet for 30s must not bank a
		// 190-tile jump
		dt := math.Min(1, math.Max(0, float64(now-p.LastPosAt)/1000))
		if math.Hypot(nx-p.X, ny-p.Y) > MaxSpeed*SpeedSlack*dt+PosSlack {
			snapback()
			return
		}
	}
	// stepping OUT to the surface lands on a fixed door/shaft tile the player
	// never chose; collision-checking it could strand them underground, so only
	// check entries and normal steps
	if !(zChange && nz == 0) && r.posBlocked(nx, ny, nz, p.X, p.Y) {
		snapback()
		return
	}
	// modular wall edges block a crossing, not a tile — a step that passes
	// through one is refused even though both endpoints are walkable. A layer
	// change is a scripted teleport and never crosses anything.
	if !zChange && nz == 0 && r.crossingBlocked(p.X, p.Y, nx, ny) {
		snapback()
		return
	}

	mx, my := nx, ny
	p.LastPosAt = now
	if zChange {
		p.LastZAt = now
	}

	// fall damage: dropping 2+ elevation levels in one step hurts (drop - 1 hp)
	moved := math.Hypot(mx-p.X, my-p.Y)
	if p.Z == 0 && nb == 0 && moved > 0.01 && moved < 3 {
		drop := int(r.world.Elev[ti(p.X, p.Y)]) - int(r.world.Elev[ti(mx, my)])
		if drop >= 2 && r.world.Tiles[ti(mx, my)] != world.TWater {
			p.LastDamageAt = now
			p.HP = max(0, p.HP-(drop-1))
			if p.HP <= 0 {
				// the fall-damage death path does NOT refill hunger/thirst
				r.respawn(p, false)
				mx, my = p.X, p.Y
			}
			r.send(p, map[string]any{"t": "hp", "hp": p.HP, "x": mx, "y": my})
			r.send(p, map[string]any{"t": "msg", "s": "\U0001F4A5 You fell hard!"})
		}
	}

	p.X, p.Y = mx, my
	p.Z = nz
	p.B = nb
	// track last land position for boat-wreck recovery
	if r.world.Tiles[ti(p.X, p.Y)] != world.TWater {
		p.LastLandX, p.LastLandY = p.X, p.Y
	}
	r.broadcast(map[string]any{"t": "pos", "id": p.S.ID, "x": p.X, "y": p.Y, "z": p.Z, "b": p.B})
	r.pushChunks(p)
	r.sailingHazards(p, nb, now)
}

// sailingHazards is the legacy tail of the pos handler: icebergs and scalding
// water. Losing the boat leaves the player swimming in place — no teleport.
func (r *Room) sailingHazards(p *Player, b int, now int64) {
	wreckBoat := func(reason string) {
		if p.Inv["boat"] > 0 {
			p.Inv["boat"]--
		}
		p.LastDamageAt = now
		p.HP = max(1, p.HP-2)
		p.B = 0
		r.send(p, map[string]any{"t": "boat", "r": reason})
		r.send(p, map[string]any{"t": "hp", "hp": p.HP})
		r.sendInv(p)
	}
	if b == 1 && r.world.WaterTemp[ti(p.X, p.Y)] == 2 {
		wreckBoat("burn") // wooden hulls ignite in the Core's scalding sea
		return
	}
	if b == 0 {
		return
	}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			bi := ti(p.X+float64(dx), p.Y+float64(dy))
			if !r.world.Bergs[bi] || r.brokenBergs[bi] {
				continue
			}
			if b == 2 { // a reinforced hull smashes through
				r.brokenBergs[bi] = true
				r.broadcast(map[string]any{"t": "berg", "i": bi, "pid": p.S.ID})
				continue
			}
			wreckBoat("berg") // a wooden boat shatters
			return
		}
	}
}

// handleWarp is the test-only unvalidated teleport, gated behind
// HEARTH_ALLOW_WARP. It broadcasts the same pos shape the real handler does so
// relay assertions keep working.
func (r *Room) handleWarp(p *Player, m map[string]any) {
	if !r.cfg.AllowWarp {
		return
	}
	wx := getNum(m, "x")
	wy := getNum(m, "y")
	if math.IsNaN(wx) || math.IsInf(wx, 0) || math.IsNaN(wy) || math.IsInf(wy, 0) {
		return
	}
	// The JS version does no range check here; it gets away with it because an
	// out-of-range index yields undefined rather than a crash. Go indexes the
	// tile arrays directly on the next pos, so clamp instead of trusting it.
	p.X = math.Min(world.SIZE-1, math.Max(0, wx))
	p.Y = math.Min(world.SIZE-1, math.Max(0, wy))
	p.Z = getInt32(m, "z")
	if p.Z < 0 || p.Z > 2 {
		p.Z = 0
	}
	p.B = getInt32(m, "b")
	if r.world.Tiles[ti(p.X, p.Y)] != world.TWater {
		p.LastLandX, p.LastLandY = p.X, p.Y
	}
	r.warped(p)
	p.LastZAt = 0
	r.broadcast(map[string]any{"t": "pos", "id": p.S.ID, "x": p.X, "y": p.Y, "z": p.Z, "b": p.B})
	r.pushChunks(p)
}

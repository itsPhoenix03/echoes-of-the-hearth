package room

import (
	"math"
	"math/rand"

	"hearth/gameserver/world"
)

// The hunting brain layered over the legacy creature port in creatures.go.
//
// The legacy AI walks every hunter in a straight line at the nearest player,
// gives up when it is not in range, and turns ±35° when that line is blocked.
// On top of that, this file gives creatures:
//
//   - memory: prey that slips out of range is searched for at its last known
//     spot instead of being forgotten on the spot;
//   - a call to arms: a creature that is struck rouses its neighbours toward the
//     attacker, and a creature that first spots prey announces it (`calert`);
//   - a way round: when the straight line and the ±35° turns are all blocked, a
//     short bounded BFS finds the gap in the wall or the shore of the lake.
//     Only when there is no way round does the legacy gnaw-through happen, so a
//     fully walled base is still besieged the old way;
//   - aim: chasers lead a moving target instead of tail-chasing it;
//   - tactics per type: husk wolves fan out around their prey, stalkers,
//     drowned and wolves strike and fall back, wounded skirmishers break off
//     once, and the blight lancer holds beam range and strafes;
//   - fear of fire: crawlers and husk wolves will not step inside a lit
//     campfire's ring at night unless enraged;
//   - spacing: creatures do not stack on one tile;
//   - idle life: with nothing to hunt they amble near home, and harass the
//     folk of the island camps (folk.go), who run for their huts.

type aiMode uint8

const (
	aiHunt   aiMode = iota // a player or structure: full speed, may gnaw
	aiSearch               // last known prey position
	aiFolk                 // chasing a villager off — never gnaws
	aiWander               // idle amble
)

const (
	aiMemoryTicks = 30   // 6 s of remembering where the prey was
	aiAlertRadius = 10.0 // a struck creature rouses others this close
	aiFolkRadius  = 12.0 // idle hunters notice villagers this close
	aiFireRadius  = 2.6  // the ring a lit campfire keeps clear at night
	aiPathRadius  = 22   // BFS window half-width, tiles
	aiPathTTL     = 30   // ticks a cached detour stays trusted
	aiPathRetry   = 20   // ticks between failed BFS attempts
	aiSpacing     = 0.75 // creatures push apart inside this distance
)

// sampleVelocities records each player's per-tick motion so hunters can lead
// them. A jump of more than a few tiles is a respawn or teleport, not motion.
func (r *Room) sampleVelocities() {
	for _, q := range r.playerOrder {
		if !q.velSeeded {
			q.PrevX, q.PrevY, q.velSeeded = q.X, q.Y, true
		}
		vx, vy := q.X-q.PrevX, q.Y-q.PrevY
		if math.Hypot(vx, vy) > 2.5 {
			vx, vy = 0, 0
		}
		q.VX, q.VY = q.VX*0.5+vx*0.5, q.VY*0.5+vy*0.5
		q.PrevX, q.PrevY = q.X, q.Y
	}
}

// creatureSawPrey refreshes the creature's memory of its prey and, the first
// time it locks on, tells clients so they can show the alert.
func (r *Room) creatureSawPrey(c *Creature, q *Player) {
	c.LastX, c.LastY, c.Memory = q.X, q.Y, aiMemoryTicks
	if !c.Hunting {
		c.Hunting = true
		r.broadcast(map[string]any{"t": "calert", "id": c.ID})
	}
}

// alertPack: a struck creature's neighbours turn toward the attacker. Wisps and
// frost wraiths drift on their own rules and are not roused.
func (r *Room) alertPack(c *Creature, p *Player) {
	for _, o := range r.creOrder {
		if o == c || o.Type == "wisp" || o.Type == "frost_wraith" {
			continue
		}
		if math.Hypot(o.X-c.X, o.Y-c.Y) > aiAlertRadius {
			continue
		}
		o.LastX, o.LastY = p.X, p.Y
		if o.Memory < aiMemoryTicks {
			o.Memory = aiMemoryTicks
		}
	}
}

// creatureIdle picks a goal for a creature with no prey in range: the last
// known prey position, a villager to chase off, or an amble near home.
func (r *Room) creatureIdle(c *Creature, typ string) (float64, float64, aiMode, bool) {
	if c.Memory > 0 {
		c.Memory--
		if math.Hypot(c.LastX-c.X, c.LastY-c.Y) > 0.8 {
			return c.LastX, c.LastY, aiSearch, true
		}
		c.Memory = 0 // reached the spot: the trail is cold
	}
	c.Hunting = false
	switch typ {
	case "crawler", "stalker", "husk_wolf", "drowned":
		if f := r.nearestFolk(c.X, c.Y, aiFolkRadius); f != nil {
			return f.X, f.Y, aiFolk, true
		}
	}
	c.WanderTk--
	if c.WanderTk <= 0 {
		c.WanderTk = 15 + rand.Intn(30)
		if rand.Float64() < 0.35 {
			c.WDX, c.WDY = 0, 0
		} else {
			ang := rand.Float64() * math.Pi * 2
			if c.HasHome {
				// drift back toward home when it has strayed
				hx, hy := float64(c.HomeI%world.SIZE)+0.5, float64(c.HomeI/world.SIZE)+0.5
				if math.Hypot(hx-c.X, hy-c.Y) > 10 {
					ang = math.Atan2(hy-c.Y, hx-c.X) + (rand.Float64()-0.5)*1.2
				}
			}
			c.WDX, c.WDY = math.Cos(ang), math.Sin(ang)
		}
	}
	if c.WDX == 0 && c.WDY == 0 {
		return 0, 0, aiWander, false
	}
	return c.X + c.WDX*2, c.Y + c.WDY*2, aiWander, true
}

// creatureTactics bends a hunter's aim point (tx, ty) by its type's tactics.
// (tx, ty) arrives as the legacy target; it equals the prey's position for a
// straight chase.
func (r *Room) creatureTactics(c *Creature, typ string, q *Player, tx, ty, sp float64) (float64, float64) {
	d := math.Hypot(q.X-c.X, q.Y-c.Y)
	if d < 1e-6 {
		return tx, ty
	}
	ax, ay := (q.X-c.X)/d, (q.Y-c.Y)/d // unit vector toward the prey

	// a skirmisher that drops under a third of its hp breaks off once
	if !c.Fled && c.MaxHP >= 3 && c.HP*3 <= c.MaxHP && c.Enraged == 0 {
		switch typ {
		case "crawler", "stalker", "drowned", "husk_wolf":
			c.Fled, c.Retreat = true, 12
		}
	}
	if c.Retreat > 0 {
		c.Retreat--
		// fall back at a slant so the next pass comes from a new angle
		return c.X - (ax+ay*0.5*c.Orbit)*4, c.Y - (ay-ax*0.5*c.Orbit)*4
	}

	switch typ {
	case "blight_lancer":
		// hold beam range (1.5–9): back off when crowded, strafe in the band
		if d < 4.5 {
			return c.X - ax*3, c.Y - ay*3
		}
		if d <= 8 {
			return c.X - ay*c.Orbit*3, c.Y + ax*c.Orbit*3
		}
		return tx, ty
	case "husk_wolf":
		if fx, fy, ok := r.wolfFlank(c, q, d); ok {
			return fx, fy
		}
	}

	direct := tx == q.X && ty == q.Y
	if direct && d > 1.5 && sp > 0 {
		switch typ {
		case "crawler", "husk_wolf", "drowned", "stalker":
			// lead the prey: aim where it will be when we get there
			t := math.Min(d/sp, 6) * 0.7
			return q.X + q.VX*t, q.Y + q.VY*t
		}
	}
	return tx, ty
}

// wolfFlank spreads the husk wolves hunting one player evenly around it: the
// pack leader runs straight in, the rest swing to their own side first.
func (r *Room) wolfFlank(c *Creature, q *Player, d float64) (float64, float64, bool) {
	if d <= 2.6 {
		return 0, 0, false
	}
	var pack []*Creature
	k := -1
	for _, o := range r.creOrder {
		if o.Type != "husk_wolf" || o.Retreat > 0 || math.Hypot(o.X-q.X, o.Y-q.Y) > 16 {
			continue
		}
		if o == c {
			k = len(pack)
		}
		pack = append(pack, o)
	}
	if k <= 0 || len(pack) < 2 {
		return 0, 0, false
	}
	lead := pack[0]
	base := math.Atan2(lead.Y-q.Y, lead.X-q.X)
	ang := base + float64(k)*2*math.Pi/float64(len(pack))
	fx, fy := q.X+math.Cos(ang)*2.2, q.Y+math.Sin(ang)*2.2
	if math.Hypot(fx-c.X, fy-c.Y) < 0.9 {
		return 0, 0, false // in position: close in
	}
	return fx, fy, true
}

// fearsFire: crawlers and husk wolves shun firelight at night unless enraged.
func (r *Room) fearsFire(c *Creature, typ string) bool {
	return (typ == "crawler" || typ == "husk_wolf") && c.Enraged == 0 && r.isNight() && len(r.campfires()) > 0
}

// campfires lists campfire tiles, cached for the tick.
func (r *Room) campfires() []int {
	if r.fireIdxTick == r.tickN && r.fireIdx != nil {
		return r.fireIdx
	}
	out := r.fireIdx[:0]
	for _, i := range r.structIndices() {
		if s, ok := r.structures[i]; ok && s.Kind == "campfire" {
			out = append(out, i)
		}
	}
	if out == nil {
		out = []int{}
	}
	r.fireIdx, r.fireIdxTick = out, r.tickN
	return out
}

// fireBlocks: stepping to (nx, ny) would move a fire-shy creature deeper into a
// campfire's ring. Moving out of a ring is always allowed.
func (r *Room) fireBlocks(c *Creature, nx, ny float64) bool {
	for _, i := range r.campfires() {
		fx, fy := float64(i%world.SIZE)+0.5, float64(i/world.SIZE)+0.5
		nd := math.Hypot(nx-fx, ny-fy)
		if nd < aiFireRadius && nd < math.Hypot(c.X-fx, c.Y-fy) {
			return true
		}
	}
	return false
}

// inFireRing: (x, y) lies inside some campfire's ring.
func (r *Room) inFireRing(x, y float64) bool {
	for _, i := range r.campfires() {
		if math.Hypot(x-float64(i%world.SIZE)-0.5, y-float64(i/world.SIZE)-0.5) < aiFireRadius {
			return true
		}
	}
	return false
}

// creFooting: a creature can stand on tile i — land, or water a keeper has
// bridged. Bridges are the only way a non-swimmer crosses water.
func (r *Room) creFooting(i int) bool {
	return r.tileAt(i) != world.TWater || (len(r.modules) > 0 && r.bridgeTiles()[i])
}

// bridgeTiles is the set of bridged water tiles, memoised for the tick and
// invalidated by addModule / removeModule.
func (r *Room) bridgeTiles() map[int]bool {
	if r.bridgeValid && r.bridgeTick == r.tickN {
		return r.bridges
	}
	b := make(map[int]bool)
	for _, k := range r.modOrder {
		if m, ok := r.modules[k]; ok && m.Slot == "floor" {
			if def, known := r.defs.Modules[m.Kind]; known && def.Water {
				b[m.I] = true
			}
		}
	}
	r.bridges, r.bridgeTick, r.bridgeValid = b, r.tickN, true
	return b
}

const (
	aiBridgeReach = 45.0 // how far a creature will go out of its way for a bridge
	aiViaTTL      = 150  // ticks a chosen bridge stays the plan
)

// pickBridge chooses the bridge tile to make for when water stands between a
// non-swimmer and its target and no short path exists: the bridged tile
// nearest the far side, weighed against the walk to it. Its far end is
// preferred, so a creature already on the span keeps crossing.
func (r *Room) pickBridge(c *Creature, tx, ty float64) (int, bool) {
	best, bestCost := -1, math.Inf(1)
	for i := range r.bridgeTiles() {
		bx, by := float64(i%world.SIZE)+0.5, float64(i/world.SIZE)+0.5
		dc := math.Hypot(bx-c.X, by-c.Y)
		if dc > aiBridgeReach || dc < 1.2 {
			continue
		}
		cost := dc + 1.5*math.Hypot(tx-bx, ty-by)
		// ties break on tile index so the pick does not depend on map order
		if cost < bestCost-1e-9 || (math.Abs(cost-bestCost) <= 1e-9 && i < best) {
			best, bestCost = i, cost
		}
	}
	// (a detour bridge is usually farther from the target than the creature
	// is — the caller only asks once water has blocked every short path)
	return best, best >= 0
}

// bridgeGone: a bridge segment was removed. Every cached route and bridge plan
// may run over it, so all of them are dropped and re-planned from the ground
// that is actually there.
func (r *Room) bridgeGone() {
	for _, c := range r.creOrder {
		c.Path, c.PathFailAt, c.ViaAt = nil, 0, 0
	}
}

const (
	aiAshoreReach = 12  // a stranded creature farther than this from land drowns
	aiWadeFactor  = 0.5 // floundering speed, of the creature's own
)

// wadeAshore: a non-swimmer left in open water (its bridge destroyed under it)
// flounders slowly to the nearest land and cannot fight while it does. With no
// shore in reach it drowns. Keepers can use this: cut the bridge, and what was
// crossing is out of the fight for a while, or for good.
func (r *Room) wadeAshore(c *Creature, baseSp float64) {
	if c.AshoreI < 0 || !r.landing(c.AshoreI) {
		cx, cy := int(c.X), int(c.Y)
		x, y, ok := world.FindNearestValidTile(cx, cy, func(_, _, i int) bool { return r.landing(i) }, aiAshoreReach)
		if !ok {
			r.delCreature(c.ID) // dropped from the cre frame: clients play the death
			return
		}
		c.AshoreI = y*world.SIZE + x
	}
	ax, ay := float64(c.AshoreI%world.SIZE)+0.5, float64(c.AshoreI/world.SIZE)+0.5
	d := math.Hypot(ax-c.X, ay-c.Y)
	sp := math.Min(baseSp*aiWadeFactor, d)
	if d > 1e-6 {
		c.X += (ax - c.X) / d * sp
		c.Y += (ay - c.Y) / d * sp
	}
	c.Path, c.ViaAt = nil, 0
	if r.creFooting(ti(c.X, c.Y)) {
		c.AshoreI = -1 // ashore: back to the hunt next tick
	}
}

// landing: a tile a stranded creature can climb out onto.
func (r *Room) landing(i int) bool {
	return inBounds(i) && r.creFooting(i) && !r.creStepBlocked(i, false)
}

// viaGoal is the bridge the creature is heading for, if it still has one.
func (r *Room) viaGoal(c *Creature) (float64, float64, bool) {
	if c.ViaAt == 0 {
		return 0, 0, false
	}
	vx, vy := float64(c.ViaI%world.SIZE)+0.5, float64(c.ViaI/world.SIZE)+0.5
	if r.tickN-c.ViaAt > aiViaTTL || math.Hypot(vx-c.X, vy-c.Y) < 1.2 || !r.bridgeTiles()[c.ViaI] {
		c.ViaAt = 0 // arrived, gave up, or the bridge is gone
		return 0, 0, false
	}
	return vx, vy, true
}

// creStepBlocked is the legacy steering obstacle test for one tile.
func (r *Room) creStepBlocked(i int, swims bool) bool {
	if !inBounds(i) {
		return true
	}
	if !swims && !r.creFooting(i) {
		return true
	}
	if r.medicTiles[i] || (len(r.modules) > 0 && r.wallBlocks(i)) {
		return true
	}
	_, occupied := r.structures[i]
	return occupied && r.creBlocked(i)
}

// followPath returns the next waypoint of a cached detour that still leads to
// the current target, dropping waypoints already reached.
func (r *Room) followPath(c *Creature, tx, ty float64) (float64, float64, bool) {
	if len(c.Path) == 0 {
		return 0, 0, false
	}
	gi := ti(tx, ty)
	if r.tickN-int64(c.PathAt) > aiPathTTL || !inBounds(gi) ||
		cheb(c.PathGoal, gi) > 2 {
		c.Path = nil
		return 0, 0, false
	}
	for len(c.Path) > 0 {
		w := c.Path[0]
		wx, wy := float64(w%world.SIZE)+0.5, float64(w/world.SIZE)+0.5
		if math.Hypot(wx-c.X, wy-c.Y) < 0.45 {
			c.Path = c.Path[1:]
			continue
		}
		return wx, wy, true
	}
	return 0, 0, false
}

// cheb is the Chebyshev distance between two tile indices.
func cheb(a, b int) int {
	dx, dy := a%world.SIZE-b%world.SIZE, a/world.SIZE-b/world.SIZE
	if dx < 0 {
		dx = -dx
	}
	if dy < 0 {
		dy = -dy
	}
	return max(dx, dy)
}

// planPath runs a bounded 8-way BFS from the creature to any tile next to the
// target and caches the result, returning the first waypoint.
//
// When the target cannot be reached inside the window — it lies beyond it, or
// across water — the search settles for the reachable tile nearest the target,
// provided that is at least a tile closer than where the creature stands. That
// is what walks a creature off the far end of a long bridge or round a lake.
// It fails when nothing gets closer (prey fully walled in: gnaw), when the only
// route is a detour three times the straight line, or when a retry is too soon.
func (r *Room) planPath(c *Creature, tx, ty float64, swims, fear bool) (float64, float64, bool) {
	if c.PathFailAt != 0 && r.tickN-int64(c.PathFailAt) < aiPathRetry {
		return 0, 0, false
	}
	sx, sy := int(c.X), int(c.Y)
	gx, gy := int(tx), int(ty)
	const R = aiPathRadius
	if abs(gx-sx) <= 1 && abs(gy-sy) <= 1 {
		return 0, 0, false
	}
	const W = 2*R + 1
	var prev [W * W]int16 // 0 = unseen; else 1 + local index of the parent
	var open [W * W]int8  // pass() memo: 0 unknown, 1 open, 2 blocked
	local := func(x, y int) int { return (y-sy+R)*W + (x - sx + R) }
	pass := func(x, y int) bool {
		if x < 0 || y < 0 || x >= world.SIZE || y >= world.SIZE {
			return false
		}
		li := local(x, y)
		if open[li] == 0 {
			open[li] = 2
			if !r.creStepBlocked(y*world.SIZE+x, swims) &&
				(!fear || !r.inFireRing(float64(x)+0.5, float64(y)+0.5)) {
				open[li] = 1
			}
		}
		return open[li] == 1
	}
	queue := make([]int32, 0, 256)
	start := local(sx, sy)
	prev[start] = int16(start + 1)
	queue = append(queue, int32(start))
	found := -1
	// best-effort fallback: the reachable tile nearest the target
	best, bestD := -1, math.Hypot(tx-c.X, ty-c.Y)-1
	for h := 0; h < len(queue) && found < 0; h++ {
		cur := int(queue[h])
		cx, cy := cur%W-R+sx, cur/W-R+sy
		for _, dd := range [8][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}, {1, 1}, {1, -1}, {-1, 1}, {-1, -1}} {
			nx, ny := cx+dd[0], cy+dd[1]
			if abs(nx-sx) > R || abs(ny-sy) > R {
				continue
			}
			li := local(nx, ny)
			if prev[li] != 0 || !pass(nx, ny) {
				continue
			}
			// no cutting a blocked corner on a diagonal
			if dd[0] != 0 && dd[1] != 0 && (!pass(cx+dd[0], cy) || !pass(cx, cy+dd[1])) {
				continue
			}
			prev[li] = int16(cur + 1)
			if abs(nx-gx) <= 1 && abs(ny-gy) <= 1 {
				found = li
				break
			}
			if d := math.Hypot(tx-float64(nx)-0.5, ty-float64(ny)-0.5); d < bestD {
				best, bestD = li, d
			}
			queue = append(queue, int32(li))
		}
	}
	exact := found >= 0
	if !exact {
		found = best
	}
	if found < 0 {
		c.PathFailAt = int(r.tickN)
		c.Path = nil
		return 0, 0, false
	}
	var rev []int
	for li := found; li != start; li = int(prev[li]) - 1 {
		rev = append(rev, (li/W-R+sy)*world.SIZE+(li%W-R+sx))
	}
	// a detour three times the straight line is not worth walking: gnaw instead
	if exact && float64(len(rev)) > 3*math.Hypot(tx-c.X, ty-c.Y)+10 {
		c.PathFailAt = int(r.tickN)
		return 0, 0, false
	}
	path := make([]int, len(rev))
	for i, t := range rev {
		path[len(rev)-1-i] = t
	}
	c.Path, c.PathGoal, c.PathAt, c.PathFailAt = path, ti(tx, ty), int(r.tickN), 0
	w := path[0]
	return float64(w%world.SIZE) + 0.5, float64(w/world.SIZE) + 0.5, true
}

// separate nudges a step away from other creatures crowding the same spot.
func (r *Room) separate(c *Creature, nx, ny float64) (float64, float64) {
	var px, py float64
	for _, o := range r.creOrder {
		if o == c || o.Type == "wisp" || o.Type == "frost_wraith" {
			continue
		}
		dx, dy := nx-o.X, ny-o.Y
		d := math.Hypot(dx, dy)
		if d >= aiSpacing || d < 1e-6 {
			continue
		}
		push := (aiSpacing - d) * 0.35
		px += dx / d * push
		py += dy / d * push
	}
	return nx + px, ny + py
}

// struckRetreat: the skirmishers fall back after landing a blow.
func struckRetreat(c *Creature, typ string) {
	switch typ {
	case "stalker":
		c.Retreat = 7
	case "husk_wolf", "drowned":
		c.Retreat = 4
	}
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

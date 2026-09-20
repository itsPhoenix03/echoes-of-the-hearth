package room

import (
	"math"
	"math/rand"
	"sort"

	"hearth/gameserver/world"
)

// Slice 3: the living world — creature types, spawn gating, AI and combat.
//
// This is a line-by-line port of the creature half of the legacy sim tick in
// server/index.js. The tuning constants (hit points, speeds, aggro radii, RNG
// thresholds, cooldowns) are reproduced exactly; every one of them was tuned by
// playing and none of them is rounded or "improved" here.
//
// # Iteration order
//
// JavaScript Map and Set iterate in insertion order, Go maps do not. Anywhere
// the legacy code lets iteration order decide an outcome — which player a
// creature picks when two are equidistant, which structure a brute walks to,
// which infected tile breeds a crawler, which creature the `atk` scan finds
// first — this port iterates an explicitly ordered slice instead of the map, so
// behaviour is reproducible. See creOrder, aniOrder, playerOrder, infOrder and
// structIndices.

// creType is one CRE_TYPES row: [hp base, hp/strength, speed, contact dmg].
type creType struct {
	hpBase int
	hpStr  int
	speed  float64
	dmg    int
}

// creTypes is CRE_TYPES verbatim.
var creTypes = map[string]creType{
	"crawler":       {1, 1, 0.44, 1},
	"stalker":       {2, 1, 0.68, 1},
	"brute":         {6, 3, 0.3, 2},
	"wisp":          {3, 0, 0.2, 0},
	"husk_wolf":     {3, 1, 0.62, 1},
	"bog_shambler":  {8, 2, 0.22, 2},
	"frost_wraith":  {2, 1, 0.5, 1},
	"drowned":       {1, 1, 0.4, 1},   // early amphibious hunter
	"blight_lancer": {14, 4, 0.13, 1}, // slow, tanky siege caster
}

// canSwim is CAN_SWIM: only these may chase onto water.
var canSwim = map[string]bool{"stalker": true, "drowned": true}

// Creature is one live monster. Fields that JS leaves `undefined` until first
// use are zero-valued here, which the ports below rely on exactly as the legacy
// code relies on `(c.tw || 0)`.
type Creature struct {
	ID   string
	X, Y float64
	HP   int
	Type string

	// HomeI is the leash anchor. The legacy dev `spawn` command deliberately
	// creates creatures without one so a test subject always commits to the
	// chase, so "has a home" is a flag rather than a sentinel index.
	HomeI   int
	HasHome bool

	Stun       int
	Enraged    int
	OrbitTicks int
	ShotCd     int

	// brute / bog_shambler telegraph
	Windup          int
	WindupTriggered bool

	// wisp / frost_wraith drift and flee
	TW      float64
	DX, DY  float64
	FleeTk  int
	FleeAng float64
}

// addCreature registers a creature in both the map and the ordered slice.
func (r *Room) addCreature(c *Creature) {
	r.creatures[c.ID] = c
	r.creOrder = append(r.creOrder, c)
}

// delCreature removes a creature from the map and the ordered slice.
func (r *Room) delCreature(id string) {
	c, ok := r.creatures[id]
	if !ok {
		return
	}
	delete(r.creatures, id)
	for i, o := range r.creOrder {
		if o == c {
			r.creOrder = append(r.creOrder[:i], r.creOrder[i+1:]...)
			break
		}
	}
}

// strength is the legacy `1 + mono.filter(Boolean).length`.
func (r *Room) strength() int {
	n := 1
	for _, m := range r.mono {
		if m {
			n++
		}
	}
	return n
}

// structIndices returns every structure tile in ascending index order, cached
// for the duration of one tick. The legacy brute scan walks `structures` in
// insertion order and keeps the first strictly-nearest hit; Go map order would
// make that tie-break non-reproducible, so the scan walks this instead.
func (r *Room) structIndices() []int {
	if r.structIdx != nil && r.structIdxTick == r.tickN {
		return r.structIdx
	}
	idx := make([]int, 0, len(r.structures))
	for i := range r.structures {
		idx = append(idx, i)
	}
	sort.Ints(idx)
	r.structIdx, r.structIdxTick = idx, r.tickN
	return idx
}

// surfacePlayers is `[...players.values()].filter((q) => q.z === 0)`, in join
// order.
func (r *Room) surfacePlayers() []*Player {
	out := make([]*Player, 0, len(r.playerOrder))
	for _, q := range r.playerOrder {
		if q.Z == 0 {
			out = append(out, q)
		}
	}
	return out
}

// anyPlayerWithin is the legacy `some(...)` leash/despawn check. Note it does
// NOT filter by z, matching server/index.js.
func (r *Room) anyPlayerWithin(x, y, radius float64) bool {
	for _, q := range r.playerOrder {
		if math.Hypot(q.X-x, q.Y-y) <= radius {
			return true
		}
	}
	return false
}

// anyPlayerCloserThan is the legacy `some((q) => Math.hypot(...) < d)` guard
// used by the bog shambler and frost wraith spawn sites.
func (r *Room) anyPlayerCloserThan(x, y, d float64) bool {
	for _, q := range r.playerOrder {
		if math.Hypot(q.X-x, q.Y-y) < d {
			return true
		}
	}
	return false
}

// inBounds mirrors the legacy `i >= 0 && i < SIZE * SIZE` guard that precedes
// every raw tile index.
func inBounds(i int) bool { return i >= 0 && i < world.SIZE*world.SIZE }

// creBlocked is the legacy local of the same name: a structure blocks a
// creature unless it is non-blocking decor or a farmplot.
func (r *Room) creBlocked(i int) bool {
	cs, ok := r.structures[i]
	if !ok {
		return true
	}
	return !r.defs.DecorNonBlk[cs.Kind] && cs.Kind != "farmplot"
}

// --- spawning -------------------------------------------------------------

// creatureSpawnTick is the legacy spawn block: population cap, type roll and
// per-type placement.
func (r *Room) creatureSpawnTick(strength int) {
	wolfCount := 0
	for _, c := range r.creOrder {
		if c.Type == "husk_wolf" {
			wolfCount++
		}
	}
	// husk_wolf counts 2 toward the cap
	effective := len(r.creatures) + wolfCount
	capN := 0
	switch {
	case r.won:
		capN = 0
	case r.wave != nil:
		capN = 20
	case r.isNight():
		capN = 6 + 3*strength
	default:
		capN = 2 + strength
	}
	if effective >= capN || len(r.players) == 0 || r.tickN%3 != 0 {
		return
	}

	roll := rand.Float64()
	typ := "crawler"
	wisps := 0
	for _, c := range r.creOrder {
		if c.Type == "wisp" {
			wisps++
		}
	}
	night := r.isNight()
	switch {
	case roll > 0.97 && wisps < 2:
		typ = "wisp"
	case strength >= 3 && roll > 0.85:
		typ = "brute"
	case night && roll < 0.05:
		typ = "husk_wolf"
	case night && roll < 0.08:
		typ = "frost_wraith"
	case roll > 0.90 && roll <= 0.93:
		typ = "bog_shambler"
	case night && roll < 0.3:
		typ = "stalker"
	case roll >= 0.32 && roll < 0.45:
		typ = "drowned"
	case strength >= 2 && roll >= 0.45 && roll < 0.5:
		typ = "blight_lancer"
	}

	a := rand.Float64() * math.Pi * 2
	rr := rand.Float64() * 13
	sx := float64(world.CORE[0]) + math.Cos(a)*rr
	sy := float64(world.CORE[1]) + math.Sin(a)*rr
	ok := true

	switch {
	case typ == "drowned":
		// rises from the water near a player's coast
		qs := r.surfacePlayers()
		ok = false
		if len(qs) > 0 {
			q := qs[rand.Intn(len(qs))]
			for att := 0; att < 20; att++ {
				da := rand.Float64() * math.Pi * 2
				dr := 10 + rand.Float64()*8
				dx2 := math.Round(q.X + math.Cos(da)*dr)
				dy2 := math.Round(q.Y + math.Sin(da)*dr)
				if dx2 > 0 && dy2 > 0 && dx2 < world.SIZE && dy2 < world.SIZE &&
					r.world.Tiles[ti(dx2, dy2)] == world.TWater {
					sx, sy, ok = dx2, dy2, true
					break
				}
			}
		}

	case len(r.infOrder) > 0 && roll < 0.25 && typ == "crawler":
		// corruption breeds crawlers far from the core. infOrder keeps the pick
		// reproducible; Go map order would not.
		fi := r.infOrder[rand.Intn(len(r.infOrder))]
		sx, sy = float64(fi%world.SIZE), float64(fi/world.SIZE)

	case typ == "husk_wolf":
		// near a random player on GRASS, 2-3 at once
		qs := r.surfacePlayers()
		if len(qs) == 0 {
			ok = false
			break
		}
		q := qs[rand.Intn(len(qs))]
		placed := false
		for attempt := 0; attempt < 20 && !placed; attempt++ {
			wa := rand.Float64() * math.Pi * 2
			wr := 9 + rand.Float64()*8
			wx := math.Round(q.X + math.Cos(wa)*wr)
			wy := math.Round(q.Y + math.Sin(wa)*wr)
			if wx < 0 || wy < 0 || wx >= world.SIZE || wy >= world.SIZE {
				continue
			}
			if r.world.Tiles[ti(wx, wy)] != world.TGrass {
				continue
			}
			packN := 2
			if rand.Float64() < 0.4 {
				packN = 3
			}
			// the legacy loop tests the cap against the count sampled before
			// this pack started spawning, not a running total
			for pw := 0; pw < packN && effective+pw*2 < capN; pw++ {
				offA := (float64(pw) / float64(packN)) * math.Pi * 2
				px2 := math.Round(wx + math.Cos(offA)*(1+float64(pw)))
				py2 := math.Round(wy + math.Sin(offA)*(1+float64(pw)))
				if px2 < 0 || py2 < 0 || px2 >= world.SIZE || py2 >= world.SIZE {
					continue
				}
				if r.world.Tiles[ti(px2, py2)] != world.TGrass {
					continue
				}
				ct := creTypes["husk_wolf"]
				r.newCreature(px2, py2, ct.hpBase+ct.hpStr*strength, "husk_wolf", ti(px2, py2), true)
			}
			placed = true
			ok = false // already spawned above
		}
		if !placed {
			ok = false
		}

	case typ == "bog_shambler":
		// MUD/BLIGHT near the Marsh island, >=9 tiles from every player
		mx, my := float64(world.ISLES[3][0]), float64(world.ISLES[3][1])
		for attempt := 0; attempt < 20 && ok; attempt++ {
			ba := rand.Float64() * math.Pi * 2
			br := 5 + rand.Float64()*25
			bx := math.Round(mx + math.Cos(ba)*br)
			by := math.Round(my + math.Sin(ba)*br)
			if bx < 0 || by < 0 || bx >= world.SIZE || by >= world.SIZE {
				continue
			}
			bt := r.world.Tiles[ti(bx, by)]
			if bt != world.TMud && bt != world.TBlight {
				continue
			}
			if r.anyPlayerCloserThan(bx, by, 9) {
				continue
			}
			sx, sy, ok = bx, by, true
			break
		}
		if ok {
			t := r.tileAtXY(sx, sy)
			if t != world.TMud && t != world.TBlight {
				ok = false
			}
		}

	case typ == "frost_wraith":
		// night only, SNOW near the Spire, >=9 tiles from every player
		if !night {
			ok = false
			break
		}
		spx, spy := float64(world.ISLES[2][0]), float64(world.ISLES[2][1])
		for attempt := 0; attempt < 20 && ok; attempt++ {
			fa := rand.Float64() * math.Pi * 2
			fr := 5 + rand.Float64()*20
			fx := math.Round(spx + math.Cos(fa)*fr)
			fy := math.Round(spy + math.Sin(fa)*fr)
			if fx < 0 || fy < 0 || fx >= world.SIZE || fy >= world.SIZE {
				continue
			}
			if r.world.Tiles[ti(fx, fy)] != world.TSnow {
				continue
			}
			if r.anyPlayerCloserThan(fx, fy, 9) {
				continue
			}
			sx, sy, ok = fx, fy, true
			break
		}
		if ok && r.tileAtXY(sx, sy) != world.TSnow {
			ok = false
		}

	case night && roll < 0.55 && typ != "bog_shambler":
		// islands: night horrors near players
		qs := r.surfacePlayers()
		if len(qs) > 0 {
			q := qs[rand.Intn(len(qs))]
			sx = math.Round(q.X + (rand.Float64()-0.5)*36)
			sy = math.Round(q.Y + (rand.Float64()-0.5)*36)
			ok = sx >= 0 && sy >= 0 && sx < world.SIZE && sy < world.SIZE &&
				r.tileAtXY(sx, sy) != world.TWater && math.Hypot(sx-q.X, sy-q.Y) > 9
		}
	}

	if !ok {
		return
	}
	ct := creTypes[typ]
	r.newCreature(sx, sy, ct.hpBase+ct.hpStr*strength, typ, ti(sx, sy), true)
}

func (r *Room) newCreature(x, y float64, hp int, typ string, homeI int, hasHome bool) *Creature {
	r.nextCre++
	c := &Creature{
		ID: "c" + itoa(r.nextCre), X: x, Y: y, HP: hp, Type: typ,
		HomeI: homeI, HasHome: hasHome,
	}
	r.addCreature(c)
	return c
}

// --- per-tick AI ----------------------------------------------------------

// creatureTick runs dawn despawn and then the AI/attack pass for every
// creature, in spawn order.
func (r *Room) creatureTick(strength int, nowMs int64) {
	// stalkers + frost_wraith despawn at dawn if no player within 12
	if !r.isNight() {
		for _, c := range append([]*Creature(nil), r.creOrder...) {
			if c.Type != "stalker" && c.Type != "frost_wraith" {
				continue
			}
			if !r.anyPlayerWithin(c.X, c.Y, 12) {
				r.delCreature(c.ID)
			}
		}
	}

	for _, c := range append([]*Creature(nil), r.creOrder...) {
		if _, alive := r.creatures[c.ID]; !alive {
			continue // died or despawned earlier in this same pass
		}
		r.stepCreature(c, strength, nowMs)
	}
}

// stepCreature is one creature's slice of the legacy
// `for (const [cid, c] of creatures)` body.
func (r *Room) stepCreature(c *Creature, strength int, nowMs int64) {
	typ := c.Type
	if typ == "" {
		typ = "crawler"
	}
	ct := creTypes[typ]
	baseSp, cdmg := ct.speed, ct.dmg

	// stun check
	if c.Stun > 0 {
		c.Stun--
		return
	}
	if c.Enraged > 0 {
		c.Enraged--
	}
	enrageBonus, enrageRange := 0.0, 0.0
	if c.Enraged > 0 {
		enrageBonus, enrageRange = 0.2, 6 // +20% speed, +6 chase range
	}

	var tx, ty float64
	haveTarget := false

	// --- wisp + frost_wraith: drift behaviour ---
	if typ == "wisp" || typ == "frost_wraith" {
		if typ == "frost_wraith" {
			var nearP *Player
			nearD := 10.0
			for _, q := range r.playerOrder {
				if q.Z != 0 {
					continue
				}
				if d := math.Hypot(q.X-c.X, q.Y-c.Y); d < nearD {
					nearD, nearP = d, q
				}
			}
			if nearP != nil {
				// dart straight at the player
				tx, ty = nearP.X, nearP.Y
				dfw := math.Hypot(tx-c.X, ty-c.Y)
				if dfw == 0 {
					dfw = 0.001
				}
				spfw := math.Min(baseSp*1.25, dfw)
				nxfw := c.X + ((tx-c.X)/dfw)*spfw
				nyfw := c.Y + ((ty-c.Y)/dfw)*spfw
				stifw := ti(nxfw, nyfw)
				// medicTiles must block the dart, exactly as it blocks steering
				// and the leash walk-home. This is a fixed bug — do not drop it.
				if inBounds(stifw) && r.world.Tiles[stifw] != world.TWater &&
					!r.medicTiles[stifw] && r.structures[stifw] == nil {
					c.X, c.Y = nxfw, nyfw
				}
				r.creatureContact(c, cdmg, true, nowMs)
				return
			}
		}
		if c.FleeTk > 0 {
			c.FleeTk--
			fspeed := baseSp * 3 / 10 // 3 tiles over 10 ticks
			fnx := c.X + math.Cos(c.FleeAng)*fspeed
			fny := c.Y + math.Sin(c.FleeAng)*fspeed
			fni := ti(fnx, fny)
			if inBounds(fni) && r.world.Tiles[fni] != world.TWater {
				c.X, c.Y = fnx, fny
			}
		} else {
			c.TW--
			if c.TW <= 0 {
				ang := rand.Float64() * math.Pi * 2
				c.DX, c.DY = math.Cos(ang), math.Sin(ang)
				c.TW = 20 + rand.Float64()*30
			}
			nx, ny := c.X+c.DX*baseSp, c.Y+c.DY*baseSp
			if nx > 1 && ny > 1 && nx < world.SIZE-1 && ny < world.SIZE-1 {
				c.X, c.Y = nx, ny
			}
		}
		if r.tickN%25 == 0 {
			i := ti(c.X, c.Y)
			if inBounds(i) && r.world.Tiles[i] != world.TWater && r.world.Tiles[i] != world.TBlight &&
				!r.isInfected(i) && r.structures[i] == nil {
				r.setInfected(i, nowMs+120000)
				r.broadcast(map[string]any{"t": "infect", "tiles": []int{i}})
			}
		}
		// cdmg is 0 for a wisp, so this is a no-op unless frost_wraith
		r.creatureContact(c, cdmg, false, nowMs)
		return
	}

	// --- brute / bog_shambler telegraph windup ---
	if typ == "brute" || typ == "bog_shambler" {
		if c.Windup > 0 {
			c.Windup--
			return // frozen during windup
		}
		if !c.WindupTriggered {
			for _, q := range r.playerOrder {
				if q.Z == 0 && math.Hypot(q.X-c.X, q.Y-c.Y) < 2.5 {
					c.Windup, c.WindupTriggered = 8, true
					r.broadcast(map[string]any{"t": "ctel", "id": c.ID})
					break
				}
			}
		} else {
			// reset the trigger once the player has left range
			anyNear := false
			for _, q := range r.playerOrder {
				if q.Z == 0 && math.Hypot(q.X-c.X, q.Y-c.Y) < 2.5 {
					anyNear = true
					break
				}
			}
			if !anyNear {
				c.WindupTriggered = false
			}
		}
	}

	// --- leash: walk home if too far and no player near ---
	if c.HasHome {
		homeX := float64(c.HomeI % world.SIZE)
		homeY := float64(c.HomeI / world.SIZE)
		distHome := math.Hypot(c.X-homeX, c.Y-homeY)
		if distHome > 60 && !r.anyPlayerWithin(c.X, c.Y, 20) {
			dhw := distHome
			if dhw == 0 {
				dhw = 0.001
			}
			sphw := baseSp * 0.5 // walk home at half speed
			nhx := c.X + ((homeX-c.X)/dhw)*sphw
			nhy := c.Y + ((homeY-c.Y)/dhw)*sphw
			nhI := ti(nhx, nhy)
			// medicTiles blocks the walk-home too (medic-hut fix).
			if inBounds(nhI) && r.world.Tiles[nhI] != world.TWater &&
				!r.medicTiles[nhI] && r.structures[nhI] == nil {
				c.X, c.Y = nhx, nhy
			}
			// Despawn at home if still no player near.
			//
			// NOTE: this branch is UNREACHABLE, and deliberately so. In
			// server/index.js the `distHome < 1` test is nested inside
			// `distHome > 60`, and no distance is both, so the legacy server
			// never despawns a creature this way either — a leashed creature
			// walks until distHome drops to 60 and then resumes hunting. The
			// dead branch is preserved rather than removed or "fixed": making
			// it reachable would change how long creatures persist, which is
			// balance, not a port. See the Slice 3 report.
			if distHome < 1 && !r.anyPlayerWithin(c.X, c.Y, 20) {
				r.delCreature(c.ID)
			}
			return
		}
	}

	// --- target selection ---
	if r.wave != nil {
		tx = float64(r.wave.engineI % world.SIZE)
		ty = float64(r.wave.engineI / world.SIZE)
		haveTarget = true
		// adjacent to the Engine: gnaw it down (the d>1.2 path-attack never
		// fires at the target itself)
		if math.Hypot(tx-c.X, ty-c.Y) <= 1.6 && r.tickN%5 == 0 {
			if es, ok := r.structures[r.wave.engineI]; ok {
				dmg := 1
				if typ == "brute" || typ == "bog_shambler" {
					dmg = 3
				}
				es.HP -= dmg
				if es.HP <= 0 {
					ei := r.wave.engineI
					r.destroyStructure(ei)
					r.broadcast(map[string]any{"t": "sd", "i": ei, "hp": 0})
					r.wave = nil
					r.broadcast(map[string]any{"t": "wave", "secs": 0})
					r.broadcast(map[string]any{"t": "msg", "s": "THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again."})
				} else {
					r.broadcast(map[string]any{"t": "sd", "i": r.wave.engineI, "hp": es.HP})
				}
			}
			return
		}
	} else if typ == "brute" || typ == "bog_shambler" {
		if typ == "brute" {
			// brutes prefer structures; ties resolve by ascending tile index
			bd := 45.0
			for _, si := range r.structIndices() {
				ss, ok := r.structures[si]
				if !ok || r.defs.DecorNonBlk[ss.Kind] || ss.Kind == "farmplot" {
					continue
				}
				d := math.Hypot(float64(si%world.SIZE)-c.X, float64(si/world.SIZE)-c.Y)
				if d < bd {
					bd = d
					tx, ty = float64(si%world.SIZE), float64(si/world.SIZE)
					haveTarget = true
				}
			}
			if !haveTarget {
				for _, q := range r.playerOrder {
					if d := math.Hypot(q.X-c.X, q.Y-c.Y); d < bd {
						bd = d
						tx, ty = q.X, q.Y
						haveTarget = true
					}
				}
			}
		} else {
			// bog_shambler: targets players only
			bd := 45.0
			for _, q := range r.surfacePlayers() {
				if d := math.Hypot(q.X-c.X, q.Y-c.Y); d < bd {
					bd = d
					tx, ty = q.X, q.Y
					haveTarget = true
				}
			}
		}
	} else if typ == "stalker" {
		// flanking: orbit within 8 tiles, then dart
		var nearP *Player
		nearD := 26 + enrageRange
		for _, q := range r.surfacePlayers() {
			rad := 26 + enrageRange
			if q.Inv["essence"] > 0 || q.Inv["meat"] > 0 {
				rad = 40 + enrageRange
			}
			d := math.Hypot(q.X-c.X, q.Y-c.Y)
			if d < math.Min(nearD, rad) {
				nearD, nearP = d, q
			}
		}
		if nearP != nil {
			haveTarget = true
			if nearD <= 8 {
				toPlayer := math.Atan2(nearP.Y-c.Y, nearP.X-c.X)
				orbitAng := toPlayer + math.Pi/2
				c.OrbitTicks++
				if c.OrbitTicks >= 3 {
					tx, ty = nearP.X, nearP.Y // dart straight at 1.25x
					c.OrbitTicks = 0
				} else {
					tx = c.X + math.Cos(orbitAng)*4
					ty = c.Y + math.Sin(orbitAng)*4
				}
			} else {
				tx, ty = nearP.X, nearP.Y
				c.OrbitTicks = 0
			}
		}
	} else {
		// crawler / husk_wolf / drowned / blight_lancer: straight chase
		baseRange := 26 + enrageRange
		bd := baseRange
		for _, q := range r.surfacePlayers() {
			rad := baseRange
			if q.Inv["essence"] > 0 || q.Inv["meat"] > 0 {
				rad = 40 + enrageRange
			}
			d := math.Hypot(q.X-c.X, q.Y-c.Y)
			if d < math.Min(bd, rad) {
				bd = d
				tx, ty = q.X, q.Y
				haveTarget = true
			}
		}
		// husk_wolf pack-link: inherit a pack-mate's enrage within 12 tiles
		if typ == "husk_wolf" && !haveTarget {
			for _, wc := range r.creOrder {
				if wc == c || wc.Type != "husk_wolf" {
					continue
				}
				if math.Hypot(wc.X-c.X, wc.Y-c.Y) > 12 {
					continue
				}
				if wc.Enraged > 0 && wc.Enraged > c.Enraged {
					c.Enraged = wc.Enraged
				}
			}
		}
	}

	if !haveTarget {
		return
	}

	distT := math.Hypot(tx-c.X, ty-c.Y)
	if distT == 0 {
		distT = 0.001
	}
	spMult := 1.0
	if typ == "stalker" && c.OrbitTicks == 0 {
		spMult = 1.25
	}
	sp := math.Min((baseSp*(1+enrageBonus)+float64(strength)*0.03)*spMult, distT)
	moveAng := math.Atan2(ty-c.Y, tx-c.X)

	// water/obstacle steering: try +/-35 degrees if blocked. medicTiles blocks
	// creature steering — the medic-hut fix.
	nx := c.X + math.Cos(moveAng)*sp
	ny := c.Y + math.Sin(moveAng)*sp
	ni := ti(nx, ny)
	swims := canSwim[typ]
	_, occupied := r.structures[ni]
	if !inBounds(ni) || (r.tileAt(ni) == world.TWater && !swims) || r.medicTiles[ni] ||
		(occupied && r.creBlocked(ni)) {
		moved := false
		for _, rot := range [2]float64{35 * math.Pi / 180, -35 * math.Pi / 180} {
			tryAng := moveAng + rot
			tnx := c.X + math.Cos(tryAng)*sp
			tny := c.Y + math.Sin(tryAng)*sp
			tni := ti(tnx, tny)
			_, tOcc := r.structures[tni]
			if inBounds(tni) && (r.tileAt(tni) != world.TWater || swims) && !r.medicTiles[tni] &&
				(!tOcc || !r.creBlocked(tni)) {
				nx, ny, ni = tnx, tny, tni
				moved = true
				break
			}
		}
		if !moved {
			nx, ny = c.X, c.Y // stop this tick
		}
	}

	s := r.structures[ni]
	switch {
	case s != nil && r.defs.DecorNonBlk[s.Kind]:
		// creatures walk over non-blocking decor
		c.X, c.Y = nx, ny
	case s != nil && distT > 1.2 && typ != "bog_shambler":
		// bog_shambler ignores structures
		if r.tickN%5 == 0 {
			dmg := 1
			if typ == "brute" {
				dmg = 3
			}
			s.HP -= dmg
			if s.HP <= 0 {
				r.destroyStructure(ni)
				r.broadcast(map[string]any{"t": "sd", "i": ni, "hp": 0})
				if r.wave != nil && ni == r.wave.engineI {
					r.wave = nil
					r.broadcast(map[string]any{"t": "wave", "secs": 0})
					r.broadcast(map[string]any{"t": "msg", "s": "THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again."})
				}
			} else {
				r.broadcast(map[string]any{"t": "sd", "i": ni, "hp": s.HP})
			}
		}
	default:
		c.X, c.Y = nx, ny
	}

	if typ == "blight_lancer" && r.tickN%5 == 0 {
		r.lancerBeam(c, nowMs)
	}
	if typ == "brute" && r.tickN%5 == 0 {
		r.bruteBolt(c, nowMs)
	}

	// contact damage: brute/bog_shambler only land it once the windup is spent
	if r.tickN%5 == 0 && cdmg != 0 {
		bruteReady := (typ != "brute" && typ != "bog_shambler") || !c.WindupTriggered || c.Windup == 0
		if bruteReady {
			for _, q := range r.playerOrder {
				if q.Z != 0 || math.Hypot(q.X-c.X, q.Y-c.Y) >= 1.1 {
					continue
				}
				if (typ == "brute" || typ == "bog_shambler") && c.WindupTriggered && c.Windup > 0 {
					continue
				}
				r.hitPlayer(q, c, cdmg, nowMs, false)
			}
		}
	}
}

// creatureContact is the wisp/frost_wraith contact-damage block. sendSlow
// mirrors the legacy dart branch, which sends `slow` unconditionally; the drift
// branch only sends it for a frost_wraith.
func (r *Room) creatureContact(c *Creature, cdmg int, sendSlow bool, nowMs int64) {
	if r.tickN%5 != 0 || cdmg == 0 {
		return
	}
	for _, q := range r.playerOrder {
		if q.Z != 0 || math.Hypot(q.X-c.X, q.Y-c.Y) >= 1.1 {
			continue
		}
		r.hitPlayer(q, c, cdmg, nowMs, sendSlow || c.Type == "frost_wraith")
	}
}

// hitPlayer applies creature contact damage with the knockback angle, respawns
// on death, and optionally sends the frost-wraith slow.
func (r *Room) hitPlayer(q *Player, c *Creature, dmg int, nowMs int64, slow bool) {
	q.LastDamageAt = nowMs
	q.HP -= dmg
	cAng := math.Atan2(q.Y-c.Y, q.X-c.X) // away from the creature = push direction
	if q.HP <= 0 {
		r.respawn(q, false)
	}
	r.send(q, map[string]any{"t": "hp", "hp": q.HP, "x": q.X, "y": q.Y, "ang": cAng})
	if slow {
		r.send(q, map[string]any{"t": "slow", "ticks": 30})
	}
}

// lancerBeam is the blight lancer's siege shot: the first blocking structure on
// the line eats the beam and is annihilated (the Engine only takes 20).
func (r *Room) lancerBeam(c *Creature, nowMs int64) {
	if c.ShotCd > 0 {
		c.ShotCd--
	}
	if c.ShotCd != 0 {
		return
	}
	for _, q := range r.playerOrder {
		d := math.Hypot(q.X-c.X, q.Y-c.Y)
		if q.Z != 0 || d < 1.5 || d > 9 {
			continue
		}
		c.ShotCd = 4 // ~4s between beams
		// walk the line: the first blocking structure eats the beam
		hitI := -1
		steps := int(math.Ceil(d * 2))
		for st := 1; st <= steps; st++ {
			li := ti(c.X+((q.X-c.X)*float64(st))/float64(steps),
				c.Y+((q.Y-c.Y)*float64(st))/float64(steps))
			ls, ok := r.structures[li]
			if ok && !r.defs.DecorNonBlk[ls.Kind] && ls.Kind != "farmplot" {
				hitI = li
				break
			}
		}
		bx, by := q.X, q.Y
		if hitI >= 0 {
			bx, by = float64(hitI%world.SIZE), float64(hitI/world.SIZE)
		}
		r.broadcast(map[string]any{
			"t": "shot", "kind": "lance",
			"fx": toFixed(c.X, 1), "fy": toFixed(c.Y, 1),
			"tx": toFixed(bx, 1), "ty": toFixed(by, 1),
		})
		if hitI >= 0 {
			ls := r.structures[hitI]
			if ls.Kind == "engine" { // never one-shot the finale objective
				ls.HP -= 20
				if ls.HP <= 0 {
					r.destroyStructure(hitI)
					r.broadcast(map[string]any{"t": "sd", "i": hitI, "hp": 0})
					if r.wave != nil && hitI == r.wave.engineI {
						r.wave = nil
						r.broadcast(map[string]any{"t": "wave", "secs": 0})
						r.broadcast(map[string]any{"t": "msg", "s": "THE WORLD ENGINE WAS DESTROYED! Rebuild it to try again."})
					}
				} else {
					r.broadcast(map[string]any{"t": "sd", "i": hitI, "hp": ls.HP})
				}
			} else {
				r.destroyStructure(hitI)
				r.broadcast(map[string]any{"t": "sd", "i": hitI, "hp": 0})
				r.broadcast(map[string]any{"t": "msg", "s": "⚡ A Blight Lancer's beam vaporised a structure!"})
			}
		} else {
			q.LastDamageAt = nowMs
			q.HP -= 2
			lAng := math.Atan2(q.Y-c.Y, q.X-c.X)
			if q.HP <= 0 {
				r.respawn(q, false)
			}
			r.send(q, map[string]any{"t": "hp", "hp": q.HP, "x": q.X, "y": q.Y, "ang": lAng})
		}
		break
	}
}

// bruteBolt is the brute's ranged answer to players hiding in water it cannot
// enter.
func (r *Room) bruteBolt(c *Creature, nowMs int64) {
	if c.ShotCd > 0 {
		c.ShotCd--
	}
	if c.ShotCd != 0 {
		return
	}
	for _, q := range r.playerOrder {
		d := math.Hypot(q.X-c.X, q.Y-c.Y)
		if q.Z == 0 && d > 1.5 && d < 7 && r.tileAtXY(q.X, q.Y) == world.TWater {
			c.ShotCd = 3 // one bolt every ~3s
			q.LastDamageAt = nowMs
			q.HP--
			cAng := math.Atan2(q.Y-c.Y, q.X-c.X)
			r.broadcast(map[string]any{
				"t":  "shot",
				"fx": toFixed(c.X, 1), "fy": toFixed(c.Y, 1),
				"tx": toFixed(q.X, 1), "ty": toFixed(q.Y, 1),
			})
			if q.HP <= 0 {
				r.respawn(q, false)
			}
			r.send(q, map[string]any{"t": "hp", "hp": q.HP, "x": q.X, "y": q.Y, "ang": cAng})
			break
		}
	}
}

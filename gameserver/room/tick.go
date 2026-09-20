package room

import (
	"math"

	"hearth/gameserver/world"
)

// Tick-driven simulation: node respawn timers, weather, infection decay,
// creature spawning and AI, wildlife, the survival clock, structure erosion,
// crop growth and the wave/victory timer.
//
// The order of the blocks below is the order of the legacy setInterval body in
// server/index.js and is load-bearing: creature contact damage lands before the
// survival tick reads hp, and the `cre` broadcast at the end is the frame that
// also carries the clock.

// onSimTick runs everything the legacy setInterval body does.
func (r *Room) onSimTick() {
	now := r.now()
	strength := r.strength()

	// --- node respawns (every 5s) ---
	if r.tickN%25 == 0 {
		for i, at := range r.removed {
			if now > at {
				delete(r.removed, i)
				r.broadcast(map[string]any{"t": "node", "i": i, "hp": -1})
			}
		}
	}

	// --- weather fronts: rain (Woods/Marsh), sandstorm (Dunes),
	// snowstorm (Spire) ---
	r.weatherTick(now)

	// --- wisp-spread corruption decays over time (every 5s) ---
	if r.tickN%25 == 0 {
		r.infectionDecayTick(now)
	}

	// --- creatures: spawn gating, dawn despawn, AI, attacks ---
	r.creatureSpawnTick(strength)
	r.creatureTick(strength, now)

	// --- wildlife ---
	r.animalSpawnTick()
	r.animalTick()

	// --- environmental damage, hunger/thirst, campfire regen (every 5s) ---
	if r.tickN%25 == 0 {
		r.survivalTick()
	}

	// --- Blight Storm erosion: wooden structures decay at night unless a
	// campfire is near (every 20s) ---
	if r.tickN%100 == 0 && r.isNight() && !r.won {
		r.erodeWooden()
	}

	// --- farm growth check (every 50 ticks) ---
	if r.tickN%50 == 0 && len(r.farms) > 0 {
		for i, fm := range r.farms {
			if _, ok := r.defs.Crops[fm.Crop]; !ok {
				continue
			}
			stage := r.cropStage(fm)
			if stage != fm.lastStage {
				fm.lastStage = stage
				r.broadcast(map[string]any{"t": "crop", "i": i, "crop": fm.Crop, "stage": stage})
			}
		}
	}

	// --- wave victory ---
	if r.wave != nil && now > r.wave.until {
		r.wave = nil
		r.won = true
		r.broadcast(map[string]any{"t": "win"})
	}

	r.broadcastCre()
}

// broadcastCre is the legacy per-tick `cre` frame: every creature and animal
// position, plus the world clock the legacy server piggybacks on it. Both lists
// are emitted in spawn order (creOrder / aniOrder) rather than map order, so a
// client that diffs by array position sees a stable sequence.
func (r *Room) broadcastCre() {
	if len(r.players) == 0 {
		return
	}
	c := make([][]any, 0, len(r.creOrder))
	for _, cr := range r.creOrder {
		typ := cr.Type
		if typ == "" {
			typ = "crawler"
		}
		c = append(c, []any{cr.ID, toFixed(cr.X, 2), toFixed(cr.Y, 2), typ})
	}
	a := make([][]any, 0, len(r.aniOrder))
	for _, an := range r.aniOrder {
		a = append(a, []any{an.ID, toFixed(an.X, 2), toFixed(an.Y, 2), an.Type})
	}
	r.broadcast(map[string]any{
		"t": "cre", "c": c, "a": a,
		"time": toFixed(r.time, 4), "day": r.day,
	})
}

// survivalTick is the legacy `tickN % 25` player block: hunger and thirst decay,
// thermal water damage, biome exposure, starvation and campfire regeneration.
func (r *Room) survivalTick() {
	for _, q := range r.players {
		q.Hunger = math.Max(0, q.Hunger-0.055) // empty in ~15 min
		q.Thirst = math.Max(0, q.Thirst-0.083) // empty in ~10 min
		r.send(q, map[string]any{"t": "stat", "hunger": statInt(q.Hunger), "thirst": statInt(q.Thirst)})

		idx := ti(q.X, q.Y)
		tile := r.world.Tiles[idx]

		// Thermal water damage (BEFORE the weather checks) — boats protect, and
		// so does a bridge: standing on the deck is not being in the water.
		if tile == world.TWater && q.Z == 0 && q.B == 0 && !r.isBridge(idx) {
			if wt := r.world.WaterTemp[idx]; wt > 0 {
				q.ThermN++
				prot := (wt == 1 && q.Worn == "furcloak") || (wt == 2 && q.Worn == "heatcloak")
				if !prot || q.ThermN%2 == 0 {
					q.HP--
					msg := "The freezing water saps your life!"
					if wt == 2 {
						msg = "The scalding water burns!"
					}
					r.send(q, map[string]any{"t": "msg", "s": msg})
					if q.HP <= 0 {
						r.respawn(q, true)
					}
					r.send(q, map[string]any{"t": "hp", "hp": q.HP, "x": q.X, "y": q.Y})
				}
			} else {
				q.ThermN = 0
			}
		} else {
			q.ThermN = 0
		}

		delta := 0
		var msg string
		switch {
		case q.Z != 0:
			// underground or indoors: sheltered from the weather
		case r.weather.kind == "sandstorm" && tile == world.TSand && !r.nearAnyStruct(q, 2):
			// any structure within 2 tiles counts as shelter from the sand
			delta, msg = -1, "The sandstorm flays you — shelter beside a structure!"
		case r.weather.kind == "snowstorm" && tile == world.TSnow && !r.nearStruct(q, "campfire", 6):
			// only a campfire keeps the blizzard off, and it reaches 6 tiles
			delta, msg = -1, "The blizzard freezes you — get to a campfire!"
		case tile == world.TSand && !r.isNight() && q.Worn != "heatcloak":
			delta, msg = -1, "The desert heat sears you! Craft a Heat Cloak."
		case tile == world.TSnow && q.Worn != "furcloak":
			delta, msg = -1, "The glacial cold bites! Craft a Fur Cloak."
		case q.Hunger <= 0 || q.Thirst <= 0:
			delta = -1
			msg = "You are starving!"
			if q.Thirst <= 0 {
				msg = "You are dying of thirst!"
			}
		case q.HP < r.defs.MaxHP && r.nearStruct(q, "campfire", 4):
			delta = 1
		}
		if delta > 0 {
			r.healPlayer(q, delta, "campfire")
		} else if delta < 0 {
			r.send(q, map[string]any{"t": "msg", "s": msg})
			// NOTE: deliberately does NOT stamp LastDamageAt. Environmental
			// chip damage must not count as combat, or the Spire medic becomes
			// unreachable without the very cloak you would visit them to
			// survive without (see the legacy medic handler).
			q.HP += delta
			if q.HP > r.defs.MaxHP {
				q.HP = r.defs.MaxHP
			}
			if q.HP <= 0 {
				r.respawn(q, true)
			}
			r.send(q, map[string]any{"t": "hp", "hp": q.HP, "x": q.X, "y": q.Y})
		}
	}
}

// respawn puts a dead player back at their bed, own campfire or the world spawn.
// resetVitals mirrors the legacy environmental-death path, which also refills
// hunger and thirst; the fall-damage path does not.
func (r *Room) respawn(q *Player, resetVitals bool) {
	q.HP = r.defs.MaxHP
	q.Z = 0
	if resetVitals {
		q.Hunger, q.Thirst, q.ThermN = 10, 10, 0
	}
	q.X, q.Y = r.respawnPoint(q.S.ID)
	r.warped(q)
	r.pushChunks(q)
}

// erodeWooden is the legacy Blight Storm decay: wooden structures lose 1 hp per
// 20s of night unless a campfire stands within 6 tiles.
func (r *Room) erodeWooden() {
	for i, s := range r.structures {
		if !r.defs.WoodenSet[s.Kind] {
			continue
		}
		x, y := float64(i%world.SIZE), float64(i/world.SIZE)
		safe := false
		for j, s2 := range r.structures {
			if s2.Kind == "campfire" &&
				math.Hypot(float64(j%world.SIZE)-x, float64(j/world.SIZE)-y) <= 6 {
				safe = true
				break
			}
		}
		if safe {
			continue
		}
		s.HP--
		if s.HP <= 0 {
			r.destroyStructure(i)
			r.broadcast(map[string]any{"t": "sd", "i": i, "hp": 0})
		} else {
			r.broadcast(map[string]any{"t": "sd", "i": i, "hp": s.HP})
		}
	}
}

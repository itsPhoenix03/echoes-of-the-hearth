package room

import (
	"math"

	"hearth/gameserver/world"
)

// Tick-driven simulation for Slice 2: node respawn timers, crop growth,
// structure erosion, the survival clock and the wave/victory timer.
//
// Creature spawning and movement, wildlife, weather and infection spread are
// Slice 3. Weather is therefore always "no weather", which is a state the legacy
// server also spends most of its time in — the branches below that test
// weather.kind simply never fire, and the code takes the same path it does on a
// clear day.

// onSimTick runs everything the legacy setInterval body does, minus the
// creature/animal/weather sections.
func (r *Room) onSimTick() {
	now := r.now()

	// --- node respawns (every 5s) ---
	if r.tickN%25 == 0 {
		for i, at := range r.removed {
			if now > at {
				delete(r.removed, i)
				r.broadcast(map[string]any{"t": "node", "i": i, "hp": -1})
			}
		}
	}

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
}

// survivalTick is the legacy `tickN % 25` player block: hunger and thirst decay,
// thermal water damage, biome exposure, starvation and campfire regeneration.
func (r *Room) survivalTick() {
	for _, q := range r.players {
		q.Hunger = math.Max(0, q.Hunger-0.055) // empty in ~15 min
		q.Thirst = math.Max(0, q.Thirst-0.083) // empty in ~10 min
		r.send(q, map[string]any{"t": "stat", "hunger": math.Ceil(q.Hunger), "thirst": math.Ceil(q.Thirst)})

		idx := ti(q.X, q.Y)
		tile := r.world.Tiles[idx]

		// Thermal water damage (BEFORE the weather checks) — boats protect.
		if tile == world.TWater && q.Z == 0 && q.B == 0 {
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
		// The two weather branches of the legacy server (sandstorm/snowstorm)
		// sit here; weather is Slice 3 and is always inactive in Slice 2, so
		// they are unreachable and omitted rather than stubbed with a
		// permanently false condition.
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

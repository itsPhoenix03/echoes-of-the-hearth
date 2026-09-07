package room

import (
	"math/rand"
)

// Slice 3: weather and the wisp-spread corruption overlay.
//
// Weather is a single global state, exactly as in server/index.js — there is no
// per-region weather. What differs per biome is which tiles the active weather
// hurts, which is why the survival tick, not this file, owns the damage rules:
//
//	rain       (Woods / Marsh)  cosmetic on the server; the client draws it
//	sandstorm  (Dunes)          1 hp per 5s on SAND with no structure within 2
//	snowstorm  (Spire)          1 hp per 5s on SNOW with no campfire within 6
//
// "blizzard" is the client's name for snowstorm and "ambient snowfall" is the
// client's permanent SNOW-biome particle layer (src/main.ts) — neither is a
// distinct server state, and inventing one would desync the two sides.

// weatherState mirrors the legacy `weather = { kind, until }`. An empty kind is
// the JS `null`: no weather, which is where the world spends most of its time.
type weatherState struct {
	kind  string
	until int64
}

// weatherKinds is the legacy `['rain', 'sandstorm', 'snowstorm']`, and the index
// order matters: the roll is `[(Math.random() * 3) | 0]`.
var weatherKinds = [3]string{"rain", "sandstorm", "snowstorm"}

// weatherTick is the legacy weather block: an active front expires on its own
// clock, and otherwise a new one starts with probability (TICK_MS/1000)/180 per
// tick — about one every 180 seconds — and lasts 45-90 seconds.
func (r *Room) weatherTick(nowMs int64) {
	if r.weather.kind != "" {
		if nowMs > r.weather.until {
			r.weather.kind = ""
			r.broadcast(map[string]any{"t": "wx", "kind": nil})
		}
		return
	}
	if rand.Float64() < (TickMS/1000.0)/180 {
		r.weather.kind = weatherKinds[int(rand.Float64()*3)]
		r.weather.until = nowMs + int64((45+rand.Float64()*45)*1000)
		r.broadcast(map[string]any{"t": "wx", "kind": r.weather.kind})
	}
}

// --- infection ------------------------------------------------------------

// isInfected reports whether a tile currently carries corruption.
func (r *Room) isInfected(i int) bool {
	_, ok := r.infected[i]
	return ok
}

// setInfected marks a tile corrupt until `at`. Re-infecting a tile that is
// already corrupt only refreshes the timer and never duplicates the ordered
// mirror — every caller in the legacy server guards with `!infected.has(i)`
// first, but keeping this idempotent means infOrder can never drift.
func (r *Room) setInfected(i int, at int64) {
	if _, exists := r.infected[i]; !exists {
		r.infOrder = append(r.infOrder, i)
	}
	r.infected[i] = at
}

// delInfected clears one tile.
func (r *Room) delInfected(i int) {
	if _, exists := r.infected[i]; !exists {
		return
	}
	delete(r.infected, i)
	for n, v := range r.infOrder {
		if v == i {
			r.infOrder = append(r.infOrder[:n], r.infOrder[n+1:]...)
			break
		}
	}
}

// infectionDecayTick is the legacy `tickN % 25` cure pass. It walks infOrder so
// the `cure` payload comes out in infection order rather than Go's randomised
// map order — the client applies the list as a batch, but a reproducible batch
// makes the behaviour testable.
func (r *Room) infectionDecayTick(nowMs int64) {
	var cured []int
	for _, i := range r.infOrder {
		if nowMs > r.infected[i] {
			cured = append(cured, i)
		}
	}
	for _, i := range cured {
		r.delInfected(i)
	}
	if len(cured) > 0 {
		r.broadcast(map[string]any{"t": "cure", "tiles": cured})
	}
}

// infectedTiles is the corruption overlay for a joining client, in infection
// order. The legacy server sends `[...infected.keys()]` in `init` for exactly
// this reason: a player who joins mid-outbreak must see the blight already on
// the ground, not only the tiles corrupted after they arrived.
func (r *Room) infectedTiles() []int {
	out := make([]int, len(r.infOrder))
	copy(out, r.infOrder)
	return out
}

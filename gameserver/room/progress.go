package room

import (
	"math"

	"hearth/gameserver/world"
)

// Slice 4: endgame progression.
//
// The whole ladder, and where each rung is enforced:
//
//	1. Aether Forge   RECIPES.forge is station:'workbench'   handleCraft
//	2. Monolith Core  RECIPES.core is station:'forge'        handleCraft
//	3. Awaken a Monolith  `usecore` within 3 tiles           handleUseCore (here)
//	4. World Engine   RECIPES.engine is station:'forge', and
//	                  build requires ACTIVATION_I + all 4 mono   handleBuild
//	5. Final assault  4 minutes of wave, then `win`          onSimTick
//
// The Forge and Core gates are the ordinary recipe-station check, so they need
// no code of their own — shared/defs.json carries `station` and handleCraft
// enforces it. What lives here is the one step with its own message type.
//
// `mono` also feeds creature difficulty: strength = 1 + (monoliths lit), which
// Slice 3's spawn gating already reads (brutes at strength >= 3, blight lancers
// at >= 2, and the population cap). Lighting a monolith therefore makes the
// world harder immediately, which is the intended cost of progressing.

// handleUseCore is the legacy `usecore`: spend one Monolith Core to awaken the
// monolith you are standing at.
func (r *Room) handleUseCore(p *Player, m map[string]any) {
	// The legacy handler indexes mono[m.i] and MONOLITHS[m.i] with the raw
	// client value. In JS that is merely sloppy — a string "0" coerces to an
	// array index and a null index yields undefined and then throws inside the
	// destructure. Go indexes a real array, so the index is validated as a JSON
	// number that is an integer in 0..3, which is exactly what the client sends
	// (src/main.ts: `{ t: "usecore", i: idx }`).
	f, isNum := m["i"].(float64)
	if !isNum || math.IsNaN(f) || f != math.Trunc(f) || f < 0 || f > 3 {
		return
	}
	i := int(f)
	if r.mono[i] || p.Inv["core"] < 1 {
		return
	}
	mx, my := world.MONOLITHS[i][0], world.MONOLITHS[i][1]
	if math.Hypot(float64(mx)-p.X, float64(my)-p.Y) > 3 {
		return
	}
	p.Inv["core"]--
	r.mono[i] = true
	r.broadcast(map[string]any{"t": "mono", "i": i})
	r.sendInv(p)
}

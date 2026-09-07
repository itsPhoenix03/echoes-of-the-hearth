package room

import (
	"fmt"
	"math"
	"math/rand"

	"hearth/gameserver/world"
)

// Slice 4: the F9 dev kit (`dev`) and the F10 tester panel (`devcmd`).
//
// # Gating
//
// The legacy server gates both on a process-wide `DEV` env var, which cannot
// work once one Go process hosts rooms for many players: the switch is either
// on for everybody in every room or off for everybody. Per the architecture
// decision in docs/09 §7 ("gate on a claim in the ticket Node issues, rather
// than the current server-wide DEV env var"), the authority here is a per-player
// claim carried in the signed ticket.
//
// TODO(control-plane): the Node control plane does not yet mint that claim.
// `control/` must add an optional boolean `dev` to the ticket payload it signs
// in /api/join (see control/PROTOCOL.md §2), set from the account's own
// permissions — NOT from anything the client sends, or the gate is worthless.
// Until it does, Session.DevClaim is nil for every connection and this falls
// back to the process-wide HEARTH_DEV env var, which is a strict improvement on
// DEV only in that it no longer shares a name with the crop-growth switch.
// Once the claim ships, drop the env fallback: an operator flag that grants
// world-mutating commands to every connected player has no place in production.
//
// devAllowed is the single choke point. Every command below goes through it.
func (r *Room) devAllowed(p *Player) bool {
	if claim := p.S.DevClaim; claim != nil {
		return *claim
	}
	return r.cfg.DevTools
}

// The legacy refusal strings, verbatim: the client renders them as-is, and the
// two differ from each other in the reference server.
const (
	devOffMsg    = "Dev mode is off — start the server with: npm run server:dev"
	devCmdOffMsg = "Dev mode off — start with: npm run server:dev"
)

// devKitInv is the `dev` grant, verbatim from server/index.js. Every key is a
// real INV_KEYS slot, so this only ever overwrites existing counters.
var devKitInv = map[string]int{
	"wood": 500, "stone": 500, "fiber": 200, "crystal": 100, "iron": 100,
	"diamond": 50, "starmetal": 50, "essence": 100, "water": 10, "meat": 5,
	"cookedmeat": 10, "wall": 50, "campfire": 5, "workbench": 3, "forge": 2,
	"mineshaft": 3, "shelter": 9, "engine": 1, "core": 4, "boat": 2,
	"sboat": 1, "torch": 30,
}

var devKitTools = []string{"axe", "pick", "spick", "sword", "isword"}
var devKitGear = []string{"heatcloak", "furcloak"}

// handleDev is the F9 kit: every tool, both cloaks, and enough of everything to
// reach the endgame in one sitting.
func (r *Room) handleDev(p *Player) {
	if !r.devAllowed(p) {
		r.send(p, map[string]any{"t": "msg", "s": devOffMsg})
		return
	}
	for k, v := range devKitInv {
		p.Inv[k] = v
	}
	for _, t := range devKitTools {
		p.Tools[t] = true
	}
	for _, g := range devKitGear {
		p.Gear[g] = true
	}
	p.HP, p.Hunger, p.Thirst = r.defs.MaxHP, 10, 10
	r.sendInv(p)
	r.send(p, map[string]any{"t": "stat", "hunger": 10, "thirst": 10})
	r.send(p, map[string]any{"t": "msg", "s": "\U0001F6E0 DEV KIT granted: all tools, gear and materials."})
}

// handleDevCmd is the F10 tester panel. Unknown commands are silently ignored,
// as in the legacy server.
func (r *Room) handleDevCmd(p *Player, m map[string]any) {
	if !r.devAllowed(p) {
		r.send(p, map[string]any{"t": "msg", "s": devCmdOffMsg})
		return
	}
	switch getString(m, "cmd") {
	case "tp":
		// `typeof m.x === 'number'`: a numeric JSON value and nothing else.
		fx, okX := m["x"].(float64)
		fy, okY := m["y"].(float64)
		if !okX || !okY || math.IsNaN(fx) || math.IsInf(fx, 0) || math.IsNaN(fy) || math.IsInf(fy, 0) {
			return
		}
		// The legacy handler does not clamp; it survives because JS returns
		// undefined for an out-of-range tile index where Go would panic.
		p.X = math.Min(world.SIZE-1, math.Max(0, fx))
		p.Y = math.Min(world.SIZE-1, math.Max(0, fy))
		p.Z, p.B = 0, 0
		if r.world.Tiles[ti(p.X, p.Y)] != world.TWater {
			p.LastLandX, p.LastLandY = p.X, p.Y
		}
		r.warped(p)
		r.broadcast(map[string]any{"t": "pos", "id": p.S.ID, "x": p.X, "y": p.Y, "z": 0})
		r.send(p, map[string]any{"t": "hp", "hp": p.HP, "x": p.X, "y": p.Y})
		// Not in the legacy server, which shipped the whole map inside `init`:
		// the Go server streams terrain, so a teleport has to push the chunks
		// around the destination or the tester lands in an empty world.
		r.pushChunks(p)

	case "mono":
		// `m.i >= 0 && m.i < 4`, restricted to an actual JSON integer for the
		// same array-indexing reason as handleUseCore.
		f, isNum := m["i"].(float64)
		if !isNum || math.IsNaN(f) || f != math.Trunc(f) || f < 0 || f >= 4 {
			return
		}
		i := int(f)
		if r.mono[i] {
			return
		}
		r.mono[i] = true
		r.broadcast(map[string]any{"t": "mono", "i": i})
		if allTrue(r.mono) && !r.won && r.wave == nil {
			r.send(p, map[string]any{"t": "msg", "s": "All Monoliths lit — build the Engine at the Core."})
		}

	case "god":
		p.God = !p.God
		if p.God {
			p.HP = r.defs.MaxHP
		}
		r.send(p, map[string]any{"t": "hp", "hp": p.HP, "x": p.X, "y": p.Y})
		state := "OFF"
		if p.God {
			state = "ON — you cannot die"
		}
		r.send(p, map[string]any{"t": "msg", "s": "\U0001F6E1 God mode " + state})

	case "wx":
		kind := getString(m, "kind")
		if kind != "rain" && kind != "sandstorm" && kind != "snowstorm" {
			kind = ""
		}
		r.weather.kind = kind
		if kind == "" {
			r.weather.until = 0
		} else {
			r.weather.until = r.now() + 180000 // 3 min for testing
		}
		r.broadcast(map[string]any{"t": "wx", "kind": nullable(kind)})

	case "time":
		v, ok := m["v"].(float64)
		if !ok || math.IsNaN(v) {
			return
		}
		r.time = math.Max(0, math.Min(0.999, v)) // the sim tick broadcasts it
		label := "day"
		if r.isNight() {
			label = "night"
		}
		r.send(p, map[string]any{"t": "msg", "s": "\U0001F550 Time set to " + label})

	case "spawn":
		typ := getString(m, "type")
		ct, known := creTypes[typ]
		if !known {
			return
		}
		// place it a few tiles away on terrain it can actually occupy
		wantWater := typ == "drowned"
		sx, sy, found := p.X, p.Y, false
		for att := 0; att < 40 && !found; att++ {
			a2 := rand.Float64() * math.Pi * 2
			r2 := 4 + rand.Float64()*4
			cx2 := math.Round(p.X + math.Cos(a2)*r2)
			cy2 := math.Round(p.Y + math.Sin(a2)*r2)
			if cx2 <= 0 || cy2 <= 0 || cx2 >= world.SIZE || cy2 >= world.SIZE {
				continue
			}
			if wantWater == (r.world.Tiles[ti(cx2, cy2)] == world.TWater) {
				sx, sy, found = cx2, cy2, true
			}
		}
		hp := ct.hpBase + ct.hpStr*r.strength()
		// no home tile -> no leash, so the test subject always commits to the
		// chase instead of wandering back
		r.newCreature(sx, sy, hp, typ, 0, false)
		tail := ""
		if !found {
			tail = " — no valid tile, placed on you"
		}
		r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("\U0001F9EA Spawned %s (%d hp)%s", typ, hp, tail)})

	case "clearcre":
		n := len(r.creatures)
		r.creatures = map[string]*Creature{}
		r.creOrder = nil
		r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("\U0001F9F9 Cleared %d monsters", n)})

	case "kill":
		p.God = false
		p.HP, p.Z = r.defs.MaxHP, 0
		p.Hunger, p.Thirst = 10, 10
		p.X, p.Y = r.respawnPoint(p.S.ID)
		r.warped(p)
		r.send(p, map[string]any{"t": "hp", "hp": p.HP, "x": p.X, "y": p.Y})
		r.send(p, map[string]any{"t": "msg", "s": "\U0001F480 Killed — respawned."})
		r.pushChunks(p) // see the note under `tp`
	}
}

// godTick is the legacy dev god mode: heal any protected player back to full
// every tick. One choke point is enough because no single hit exceeds MAX_HP, so
// hp never reaches the respawn threshold between two ticks.
func (r *Room) godTick() {
	for _, gp := range r.playerOrder {
		if gp.God && gp.HP < r.defs.MaxHP {
			gp.HP = r.defs.MaxHP
			r.send(gp, map[string]any{"t": "hp", "hp": gp.HP, "x": gp.X, "y": gp.Y})
		}
	}
}

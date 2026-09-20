package room

import (
	"encoding/json"
	"math"
	"sort"
	"strings"
	"testing"

	"hearth/gameserver/proto"
	"hearth/gameserver/world"
)

// Coverage for the F9 dev kit and the F10 tester panel (dev.go).
//
// Slice 4 shipped these with a single end-to-end assertion — that an
// unprivileged session is refused — which is exactly the shape of test that
// lets the *granted* path rot unnoticed: every command could have been a no-op
// and the suite would still have been green. Everything below asserts observable
// room state after the command, not the absence of an error.
//
// The room is single-goroutine by design, so these call the handlers directly on
// the room struct, the same ownership Room.Run provides minus the loop.

// devFixture is newFixture with the ticket's dev claim granted.
func devFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	yes := true
	f.sess.DevClaim = &yes
	return f
}

// devcmd is the room's `devcmd` entry point with the frame built for us.
func (f *fixture) devcmd(m map[string]any) {
	f.r.handleDevCmd(f.p, m)
}

// msgs returns every `msg` string drained since the last drain.
func (f *fixture) msgs() []string {
	var out []string
	for _, m := range f.drain() {
		if m["t"] == "msg" {
			s, _ := m["s"].(string)
			out = append(out, s)
		}
	}
	return out
}

// countType counts drained frames of one type.
func countType(ms []map[string]any, t string) int {
	n := 0
	for _, m := range ms {
		if m["t"] == t {
			n++
		}
	}
	return n
}

func frameOfType(ms []map[string]any, t string) map[string]any {
	for _, m := range ms {
		if m["t"] == t {
			return m
		}
	}
	return nil
}

// openPatch finds the centre of an open 5x5 patch of one tile kind that is also
// clear of structures and medic huts, so a creature placed there can step in any
// direction and the survival tick sees no shelter.
func openPatch(t *testing.T, r *Room, kind uint8) (float64, float64) {
	t.Helper()
	return landTile(t, r.world, kind)
}

// --- the gate --------------------------------------------------------------

// devAllowed is the single choke point, and the claim is the only thing that
// opens it. Anything an unprivileged session sends must leave the room byte for
// byte as it found it.
func TestDevRefusedWithoutClaimMutatesNothing(t *testing.T) {
	frames := []map[string]any{
		{"cmd": "tp", "x": 640.0, "y": 640.0},
		{"cmd": "mono", "i": 0.0},
		{"cmd": "god"},
		{"cmd": "wx", "kind": "sandstorm"},
		{"cmd": "time", "v": 0.8},
		{"cmd": "spawn", "type": "crawler"},
		{"cmd": "clearcre"},
		{"cmd": "kill"},
	}
	for _, fr := range frames {
		cmd, _ := fr["cmd"].(string)
		t.Run(cmd, func(t *testing.T) {
			f := newFixture(t) // no DevClaim
			f.place(640.5, 640.5, 0)
			f.p.HP, f.p.Hunger, f.p.Thirst = 4, 3, 2
			f.r.time = 0.3
			f.spawnAt("crawler", 645, 645, true)
			f.drain()

			before := struct {
				x, y           float64
				hp             int
				hunger, thirst float64
				god            bool
				mono           [4]bool
				wx             string
				clock          float64
				creatures      int
				warpUntil      int64
			}{f.p.X, f.p.Y, f.p.HP, f.p.Hunger, f.p.Thirst, f.p.God, f.r.mono,
				f.r.weather.kind, f.r.time, len(f.r.creatures), f.p.WarpUntil}

			f.devcmd(fr)

			got := f.drain()
			if n := len(got); n != 1 {
				t.Fatalf("a refused %s sent %d frames, want exactly the refusal toast: %v", cmd, n, got)
			}
			if got[0]["t"] != "msg" || got[0]["s"] != devCmdOffMsg {
				t.Fatalf("a refused %s answered %v, want the devcmd refusal string", got[0], devCmdOffMsg)
			}
			if f.p.X != before.x || f.p.Y != before.y {
				t.Errorf("%s moved an unprivileged player to %v,%v", cmd, f.p.X, f.p.Y)
			}
			if f.p.HP != before.hp || f.p.Hunger != before.hunger || f.p.Thirst != before.thirst {
				t.Errorf("%s changed vitals: hp=%d hunger=%v thirst=%v", cmd, f.p.HP, f.p.Hunger, f.p.Thirst)
			}
			if f.p.God != before.god {
				t.Errorf("%s toggled god mode", cmd)
			}
			if f.r.mono != before.mono {
				t.Errorf("%s lit a monolith: %v", cmd, f.r.mono)
			}
			if f.r.weather.kind != before.wx {
				t.Errorf("%s changed the weather to %q", cmd, f.r.weather.kind)
			}
			if f.r.time != before.clock {
				t.Errorf("%s moved the clock to %v", cmd, f.r.time)
			}
			if len(f.r.creatures) != before.creatures {
				t.Errorf("%s changed the creature count: %d -> %d", cmd, before.creatures, len(f.r.creatures))
			}
			if f.p.WarpUntil != before.warpUntil {
				t.Errorf("%s opened a movement grace window", cmd)
			}
		})
	}
}

// The F9 kit has its own refusal string, and its own "nothing was granted".
func TestDevKitRefusedWithoutClaim(t *testing.T) {
	f := newFixture(t)
	f.p.HP, f.p.Hunger, f.p.Thirst = 3, 1, 1
	f.drain()

	f.r.handleDev(f.p)

	got := f.drain()
	if len(got) != 1 || got[0]["t"] != "msg" || got[0]["s"] != devOffMsg {
		t.Fatalf("a refused dev kit answered %v, want just the refusal string %q", got, devOffMsg)
	}
	for k := range devKitInv {
		if f.p.Inv[k] != 0 {
			t.Fatalf("the dev kit granted %s=%d with no dev claim", k, f.p.Inv[k])
		}
	}
	if len(keysOf(f.p.Tools)) != 0 || len(keysOf(f.p.Gear)) != 0 {
		t.Fatalf("the dev kit granted tools/gear with no dev claim: %v %v", f.p.Tools, f.p.Gear)
	}
	if f.p.HP != 3 || f.p.Hunger != 1 || f.p.Thirst != 1 {
		t.Fatalf("the dev kit healed a player with no dev claim: hp=%d", f.p.HP)
	}
}

// The refusal strings must not be the legacy ones: `npm run server:dev` starts
// the legacy Node server on :8081 and sets an env var this server never reads,
// so that advice sends a developer to a dead end. This is the regression that
// made the dev path look unported.
func TestRefusalStringsDoNotPointAtTheLegacyServer(t *testing.T) {
	for _, s := range []string{devOffMsg, devCmdOffMsg} {
		if strings.Contains(s, "server:dev") {
			t.Errorf("refusal string points at the legacy server: %q", s)
		}
		if !strings.Contains(s, "start:dev") {
			t.Errorf("refusal string names no way to actually get dev: %q", s)
		}
	}
}

// --- init.dev --------------------------------------------------------------

// The client used to open its tester panel unconditionally and learn the answer
// only from a refusal toast. `init.dev` is the honest answer, up front, and it
// must track devAllowed exactly.
func TestInitReportsDevClaim(t *testing.T) {
	for _, tc := range []struct {
		name  string
		claim *bool
		want  bool
	}{
		{"absent", nil, false},
		{"false", boolPtr(false), false},
		{"true", boolPtr(true), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			s := NewSession("initdev"+tc.name, "u_initdev"+tc.name, "Tester", "test")
			s.DevClaim = tc.claim
			f.r.onJoin(s)
			var init map[string]any
			for _, m := range drainSession(t, s) {
				if m["t"] == "init" {
					init = m
				}
			}
			if init == nil {
				t.Fatal("onJoin sent no init frame")
			}
			got, ok := init["dev"].(bool)
			if !ok {
				t.Fatalf("init.dev is %T, want a bool (a client must be able to tell 'not a dev' from 'old server')", init["dev"])
			}
			if got != tc.want {
				t.Fatalf("init.dev = %v, want %v", got, tc.want)
			}
			// and the report must agree with the gate it reports on
			if got != f.r.devAllowed(f.r.players[s.ID]) {
				t.Fatal("init.dev disagrees with devAllowed for the same session")
			}
		})
	}
}

func boolPtr(b bool) *bool { return &b }

func drainSession(t *testing.T, s *Session) []map[string]any {
	t.Helper()
	var out []map[string]any
	for {
		select {
		case b := <-s.Out:
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatalf("unmarshal outbound: %v", err)
			}
			out = append(out, m)
		default:
			return out
		}
	}
}

// --- dev (F9 kit) ----------------------------------------------------------

// Every slot of the kit, not just "a message came back": the whole point of the
// kit is that the tester can reach the endgame without grinding.
func TestDevKitGrantsEverything(t *testing.T) {
	f := devFixture(t)
	f.p.HP, f.p.Hunger, f.p.Thirst = 2, 0.4, 0.2
	f.drain()

	f.r.handleDev(f.p)

	for k, want := range devKitInv {
		if f.p.Inv[k] != want {
			t.Errorf("inv[%s] = %d, want %d", k, f.p.Inv[k], want)
		}
	}
	for _, tool := range devKitTools {
		if !f.p.Tools[tool] {
			t.Errorf("tool %s not granted", tool)
		}
	}
	for _, g := range devKitGear {
		if !f.p.Gear[g] {
			t.Errorf("gear %s not granted", g)
		}
	}
	if f.p.HP != f.r.defs.MaxHP || f.p.Hunger != 10 || f.p.Thirst != 10 {
		t.Errorf("vitals not restored: hp=%d hunger=%v thirst=%v", f.p.HP, f.p.Hunger, f.p.Thirst)
	}

	// and the client is told, or the bars and belt stay stale until the next tick
	out := f.drain()
	inv := frameOfType(out, "inv")
	if inv == nil {
		t.Fatal("no inv frame after the dev kit — the client would show an empty belt")
	}
	tools, _ := inv["tools"].([]any)
	if len(tools) != len(devKitTools) {
		t.Errorf("inv frame carried %v, want %v", tools, devKitTools)
	}
	stat := frameOfType(out, "stat")
	if stat == nil || stat["hunger"] != float64(10) || stat["thirst"] != float64(10) {
		t.Errorf("stat frame after the dev kit = %v, want hunger/thirst 10", stat)
	}
	if len(f.msgsOf(out)) == 0 {
		t.Error("the dev kit produced no confirmation toast")
	}
}

func (f *fixture) msgsOf(ms []map[string]any) []string {
	var out []string
	for _, m := range ms {
		if m["t"] == "msg" {
			s, _ := m["s"].(string)
			out = append(out, s)
		}
	}
	return out
}

// --- tp --------------------------------------------------------------------

// A teleport that does not push chunks strands the tester in an empty world:
// the legacy server shipped the whole map in `init`, this one streams it. That
// is the one deliberate deviation from legacy behaviour and it is easy to lose.
func TestDevTpMovesAndPushesChunks(t *testing.T) {
	f := devFixture(t)
	f.drain()
	// far enough from spawn that the destination shares no chunk with the origin
	const dx, dy = 640.0, 640.0
	if math.Abs(dx-f.p.X) < 5*float64(proto.ChunkSize) {
		t.Fatalf("destination %v is too close to spawn %v to force a chunk push", dx, f.p.X)
	}

	f.devcmd(map[string]any{"cmd": "tp", "x": dx, "y": dy})

	if f.p.X != dx || f.p.Y != dy {
		t.Fatalf("tp left the player at %v,%v, want %v,%v", f.p.X, f.p.Y, dx, dy)
	}
	if f.p.Z != 0 || f.p.B != 0 {
		t.Errorf("tp did not surface the player / clear the boat: z=%d b=%d", f.p.Z, f.p.B)
	}
	out := f.drain()
	// The 5x5 Chebyshev-radius-2 neighbourhood, none of it previously sent.
	wantChunks := (2*proto.ChunkRadius + 1) * (2*proto.ChunkRadius + 1)
	if got := countType(out, "chunk"); got != wantChunks {
		t.Fatalf("tp pushed %d chunks, want %d — the tester would land in void", got, wantChunks)
	}
	cx, cy := chunkOf(dx, dy)
	for ddy := -proto.ChunkRadius; ddy <= proto.ChunkRadius; ddy++ {
		for ddx := -proto.ChunkRadius; ddx <= proto.ChunkRadius; ddx++ {
			if !f.p.sentChunks[chunkKey(cx+ddx, cy+ddy)] {
				t.Fatalf("chunk %d,%d around the destination was not sent", cx+ddx, cy+ddy)
			}
		}
	}
	pos := frameOfType(out, "pos")
	if pos == nil || pos["x"] != dx || pos["y"] != dy {
		t.Errorf("tp broadcast %v, want a pos at the destination", pos)
	}
	if hp := frameOfType(out, "hp"); hp == nil || hp["x"] != dx {
		t.Errorf("tp sent %v, want an hp frame carrying the new position", hp)
	}
	// in-flight `pos` from the old spot must be forgiven, or the client fights back
	if f.p.WarpUntil <= f.now {
		t.Error("tp did not open the movement grace window")
	}
}

// Clamped, never out of bounds: the legacy handler survives a bad index because
// JS returns undefined where Go would panic on the tile lookup.
func TestDevTpClampsAndRejectsNonNumbers(t *testing.T) {
	f := devFixture(t)
	f.devcmd(map[string]any{"cmd": "tp", "x": -9999.0, "y": 1e9})
	if f.p.X != 0 || f.p.Y != world.SIZE-1 {
		t.Fatalf("tp clamped to %v,%v, want 0,%d", f.p.X, f.p.Y, world.SIZE-1)
	}
	before := [2]float64{f.p.X, f.p.Y}
	for _, bad := range []map[string]any{
		{"cmd": "tp", "x": "40", "y": 40.0},
		{"cmd": "tp", "x": 40.0},
		{"cmd": "tp", "x": math.NaN(), "y": 40.0},
	} {
		f.devcmd(bad)
		if f.p.X != before[0] || f.p.Y != before[1] {
			t.Fatalf("tp accepted a non-numeric frame %v", bad)
		}
	}
}

// --- god -------------------------------------------------------------------

// "God mode on" must mean the tester survives, not merely that a flag flipped.
// The mechanism is godTick healing to full at the top of every tick (the legacy
// design), so the assertion is that hp is back at max after the tick and the
// player is never respawned — and that switching it off restores mortality.
func TestDevGodSurvivesCreatureContactAndEnvironment(t *testing.T) {
	f := devFixture(t)
	gx, gy := openPatch(t, f.r, world.TGrass)
	f.place(gx, gy, 0)
	f.drain()

	f.devcmd(map[string]any{"cmd": "god"})
	if !f.p.God {
		t.Fatal("god did not switch on")
	}

	// A brute does 2 contact damage; contact fires on tickN%5. Twenty rounds of
	// it is ten times the player's whole hp pool, so an ungodded player would
	// have been respawned many times over.
	c := f.spawnAt("brute", gx+0.5, gy, false)
	for i := 0; i < 20; i++ {
		f.r.tickN = 5
		f.r.creatureContact(c, creTypes["brute"].dmg, false, f.now)
		f.r.tickN = 4 // onTick increments to 5 again
		f.r.onTick()
		f.drain() // the outbound queue is 96 deep; a dropped player would stop ticking
		if f.p.HP <= 0 {
			t.Fatalf("god mode: hp fell to %d on round %d", f.p.HP, i)
		}
		if f.p.X != gx || f.p.Y != gy {
			t.Fatalf("god mode: the player was respawned to %v,%v on round %d", f.p.X, f.p.Y, i)
		}
	}
	// The mechanism: godTick puts a protected player back to full at the top of
	// every tick, so any chip taken inside a tick is gone before the next one.
	f.r.godTick()
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("god mode: hp settled at %d, want %d", f.p.HP, f.r.defs.MaxHP)
	}

	// Environmental damage too: the desert heat branch of the survival tick.
	sx, sy := openPatch(t, f.r, world.TSand)
	f.place(sx, sy, 0)
	f.r.time = 0.3 // day, so the heat branch is live
	f.p.Worn = ""
	for i := 0; i < 4; i++ {
		f.r.tickN = 24 // onTick -> 25 -> survivalTick
		f.r.onTick()
		f.r.tickN = 0
		f.r.onTick() // the next tick's godTick heals what the last one burned
		f.drain()
		if f.r.players[f.p.S.ID] == nil {
			t.Fatal("the fixture player was dropped mid-test")
		}
		if f.p.HP != f.r.defs.MaxHP {
			t.Fatalf("god mode: the desert burned the player down to %d", f.p.HP)
		}
	}

	// Off again: the same contact must now stick. Clear the arena first so the
	// only damage in play is the one this half of the test drives.
	f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	f.place(gx, gy, 0)
	f.p.HP = f.r.defs.MaxHP
	f.drain()
	f.devcmd(map[string]any{"cmd": "god"})
	if f.p.God {
		t.Fatal("god did not switch off")
	}
	if !hasMsgContaining(f.msgs(), "OFF") {
		t.Error("switching god off produced no toast saying so")
	}
	c2 := f.spawnAt("crawler", gx+0.5, gy, false)
	f.r.tickN = 5
	f.r.creatureContact(c2, creTypes["crawler"].dmg, false, f.now)
	if f.p.HP != f.r.defs.MaxHP-1 {
		t.Fatalf("with god off, contact left hp at %d, want %d", f.p.HP, f.r.defs.MaxHP-1)
	}
	hurt := f.p.HP
	f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	f.r.godTick()
	if f.p.HP != hurt {
		t.Fatalf("with god off, godTick healed the player back to %d", f.p.HP)
	}
}

func hasMsgContaining(ms []string, sub string) bool {
	for _, m := range ms {
		if strings.Contains(m, sub) {
			return true
		}
	}
	return false
}

// --- spawn -----------------------------------------------------------------

// Every CRE_TYPES key, not a representative sample: the panel lists all of them
// and a typo in one row is invisible to a spot check.
func TestDevSpawnEveryCreatureType(t *testing.T) {
	names := make([]string, 0, len(creTypes))
	for k := range creTypes {
		names = append(names, k)
	}
	sort.Strings(names)
	if len(names) == 0 {
		t.Fatal("creTypes is empty")
	}

	gx, gy := 0.0, 0.0
	wx, wy := 0.0, 0.0
	for _, typ := range names {
		t.Run(typ, func(t *testing.T) {
			f := devFixture(t)
			if typ == "drowned" {
				if wx == 0 {
					wx, wy = openPatch(t, f.r, world.TWater)
				}
				f.place(wx, wy, 0)
			} else {
				if gx == 0 {
					gx, gy = openPatch(t, f.r, world.TGrass)
				}
				f.place(gx, gy, 0)
			}
			f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
			f.drain()

			f.devcmd(map[string]any{"cmd": "spawn", "type": typ})

			if len(f.r.creOrder) != 1 {
				t.Fatalf("spawn %s created %d creatures, want 1", typ, len(f.r.creOrder))
			}
			c := f.r.creOrder[0]
			if c.Type != typ {
				t.Fatalf("spawn %s created a %s", typ, c.Type)
			}
			ct := creTypes[typ]
			if want := ct.hpBase + ct.hpStr*f.r.strength(); c.HP != want {
				t.Errorf("spawn %s hp = %d, want %d (strength-scaled)", typ, c.HP, want)
			}
			if c.HasHome {
				t.Errorf("spawn %s gave the test subject a leash anchor — it will wander off mid-test", typ)
			}
			if math.Hypot(c.X-f.p.X, c.Y-f.p.Y) > 12 {
				t.Errorf("spawn %s placed the creature %.1f tiles away", typ, math.Hypot(c.X-f.p.X, c.Y-f.p.Y))
			}
			if !hasMsgContaining(f.msgsOf(f.drain()), typ) {
				t.Errorf("spawn %s sent no confirmation naming the type", typ)
			}

			// It must reach the client: the panel is useless if the creature is
			// only in server memory until the next natural broadcast drops it.
			f.r.broadcastCre()
			cre := frameOfType(f.drain(), "cre")
			if cre == nil {
				t.Fatalf("spawn %s: no cre frame", typ)
			}
			list, _ := cre["c"].([]any)
			found := false
			for _, e := range list {
				row, _ := e.([]any)
				if len(row) == 4 && row[0] == c.ID && row[3] == typ {
					found = true
				}
			}
			if !found {
				t.Fatalf("spawn %s: the creature is not in the cre broadcast: %v", typ, list)
			}
		})
	}
}

// An unknown type is ignored rather than spawning a default monster.
func TestDevSpawnUnknownTypeIsIgnored(t *testing.T) {
	f := devFixture(t)
	f.r.creatures, f.r.creOrder = map[string]*Creature{}, nil
	f.devcmd(map[string]any{"cmd": "spawn", "type": "dragon"})
	if len(f.r.creOrder) != 0 {
		t.Fatalf("spawn of an unknown type created %d creatures", len(f.r.creOrder))
	}
}

// --- clearcre --------------------------------------------------------------

func TestDevClearCreRemovesEveryCreature(t *testing.T) {
	f := devFixture(t)
	gx, gy := openPatch(t, f.r, world.TGrass)
	f.place(gx, gy, 0)
	for i := 0; i < 5; i++ {
		f.spawnAt("crawler", gx+float64(i), gy, true)
	}
	if len(f.r.creatures) != 5 {
		t.Fatalf("setup: %d creatures", len(f.r.creatures))
	}
	f.drain()

	f.devcmd(map[string]any{"cmd": "clearcre"})

	if len(f.r.creatures) != 0 || len(f.r.creOrder) != 0 {
		t.Fatalf("clearcre left %d/%d creatures (map/order)", len(f.r.creatures), len(f.r.creOrder))
	}
	if !hasMsgContaining(f.msgsOf(f.drain()), "Cleared 5") {
		t.Error("clearcre did not report the count it cleared")
	}
	// and the next frame the client sees must be empty, not stale
	f.r.broadcastCre()
	cre := frameOfType(f.drain(), "cre")
	if cre == nil {
		t.Fatal("no cre frame after clearcre")
	}
	if list, _ := cre["c"].([]any); len(list) != 0 {
		t.Fatalf("cre frame still lists %d creatures after clearcre", len(list))
	}
}

// --- kill ------------------------------------------------------------------

// `kill` is the panel's "get me out of here". It must land the tester at their
// respawn point with full vitals, drop god mode, push the chunks there, and open
// the movement grace window — without the last one, the client's in-flight `pos`
// from the old location is snapped back and the player appears not to have moved.
func TestDevKillRespawnsWithGraceAndChunks(t *testing.T) {
	f := devFixture(t)
	f.devcmd(map[string]any{"cmd": "tp", "x": 640.0, "y": 640.0})
	f.p.God = true
	f.p.HP, f.p.Hunger, f.p.Thirst, f.p.Z = 2, 0.5, 0.5, 1
	f.p.WarpUntil = 0
	f.drain()

	wantX, wantY := f.r.respawnPoint(f.p.S.ID)
	f.devcmd(map[string]any{"cmd": "kill"})

	if f.p.X != wantX || f.p.Y != wantY {
		t.Fatalf("kill left the player at %v,%v, want the respawn point %v,%v", f.p.X, f.p.Y, wantX, wantY)
	}
	if f.p.God {
		t.Error("kill did not clear god mode")
	}
	if f.p.HP != f.r.defs.MaxHP || f.p.Hunger != 10 || f.p.Thirst != 10 || f.p.Z != 0 {
		t.Errorf("kill left vitals hp=%d hunger=%v thirst=%v z=%d", f.p.HP, f.p.Hunger, f.p.Thirst, f.p.Z)
	}
	if f.p.WarpUntil <= f.now {
		t.Error("kill did not open the movement grace window — the client's in-flight pos would be snapped back")
	}
	out := f.drain()
	if hp := frameOfType(out, "hp"); hp == nil || hp["x"] != wantX || hp["y"] != wantY {
		t.Errorf("kill sent %v, want an hp frame at the respawn point", hp)
	}
	if countType(out, "chunk") == 0 {
		t.Error("kill pushed no chunks — the tester respawns into void")
	}
}

// --- mono ------------------------------------------------------------------

// Lighting a monolith is not cosmetic: strength gates which creature types the
// spawn roll can reach, so the panel's mono button is how a tester gets to see
// brutes and blight lancers at all.
func TestDevMonoLightsAndRaisesStrength(t *testing.T) {
	f := devFixture(t)
	f.drain()
	if f.r.strength() != 1 {
		t.Fatalf("setup: strength %d, want 1", f.r.strength())
	}

	f.devcmd(map[string]any{"cmd": "mono", "i": 0.0})
	if !f.r.mono[0] {
		t.Fatal("mono 0 did not light")
	}
	if f.r.strength() != 2 {
		t.Fatalf("strength after one monolith = %d, want 2", f.r.strength())
	}
	out := f.drain()
	if m := frameOfType(out, "mono"); m == nil || m["i"] != float64(0) {
		t.Fatalf("mono broadcast = %v, want i=0", m)
	}

	// idempotent: an already-lit monolith is a no-op, not a second broadcast
	f.devcmd(map[string]any{"cmd": "mono", "i": 0.0})
	if countType(f.drain(), "mono") != 0 {
		t.Error("re-lighting monolith 0 broadcast a second time")
	}

	// the gate actually moves: brutes need strength >= 3, lancers >= 2
	f.setNight()
	f.p.X, f.p.Y = openPatch(t, f.r, world.TGrass)
	if seen := f.rollTypes(8000); seen["brute"] {
		t.Error("a brute spawned at strength 2")
	}
	f.devcmd(map[string]any{"cmd": "mono", "i": 1.0})
	if f.r.strength() != 3 {
		t.Fatalf("strength after two monoliths = %d, want 3", f.r.strength())
	}
	if seen := f.rollTypes(8000); !seen["brute"] {
		t.Error("no brute at strength 3 — the mono command did not move the spawn gate")
	}

	// the fourth closes the set and announces the Engine
	f.drain()
	f.devcmd(map[string]any{"cmd": "mono", "i": 2.0})
	f.devcmd(map[string]any{"cmd": "mono", "i": 3.0})
	if !allTrue(f.r.mono) {
		t.Fatalf("mono = %v, want all four lit", f.r.mono)
	}
	if !hasMsgContaining(f.msgsOf(f.drain()), "Monoliths lit") {
		t.Error("closing the set announced nothing")
	}
}

// Out-of-range and non-integer indices are ignored, not clamped — the value
// indexes a fixed-size array.
func TestDevMonoRejectsBadIndex(t *testing.T) {
	f := devFixture(t)
	for _, bad := range []any{-1.0, 4.0, 1.5, "0", nil} {
		f.devcmd(map[string]any{"cmd": "mono", "i": bad})
	}
	if f.r.mono != [4]bool{} {
		t.Fatalf("a bad mono index lit something: %v", f.r.mono)
	}
}

// --- wx --------------------------------------------------------------------

// Weather is only observable to a tester through what it does to them, so the
// assertion is that the survival tick takes the corresponding branch.
func TestDevWxSetsClearsAndDrivesTheSurvivalTick(t *testing.T) {
	f := devFixture(t)
	for _, kind := range []string{"rain", "sandstorm", "snowstorm"} {
		f.drain()
		f.devcmd(map[string]any{"cmd": "wx", "kind": kind})
		if f.r.weather.kind != kind {
			t.Fatalf("wx %s set weather to %q", kind, f.r.weather.kind)
		}
		if f.r.weather.until <= f.now {
			t.Fatalf("wx %s set no expiry (until=%d, now=%d)", kind, f.r.weather.until, f.now)
		}
		m := frameOfType(f.drain(), "wx")
		if m == nil || m["kind"] != kind {
			t.Fatalf("wx %s broadcast %v", kind, m)
		}
	}
	// anything else clears
	f.drain()
	f.devcmd(map[string]any{"cmd": "wx", "kind": "hurricane"})
	if f.r.weather.kind != "" || f.r.weather.until != 0 {
		t.Fatalf("an unknown wx kind left weather %q until %d", f.r.weather.kind, f.r.weather.until)
	}
	m := frameOfType(f.drain(), "wx")
	if m == nil {
		t.Fatal("clearing the weather broadcast nothing")
	}
	if m["kind"] != nil {
		t.Fatalf("cleared wx broadcast kind=%v, want null", m["kind"])
	}

	// Now the branch itself. Night on SAND with no cloak: the desert-heat case
	// is day-only, so any damage here can only come from the sandstorm branch.
	sx, sy := openPatch(t, f.r, world.TSand)
	f.place(sx, sy, 0)
	f.r.time = 0.8 // night
	f.p.Worn = ""
	f.p.HP = f.r.defs.MaxHP
	f.drain()
	f.r.survivalTick()
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("with no weather, night sand cost %d hp", f.r.defs.MaxHP-f.p.HP)
	}

	f.devcmd(map[string]any{"cmd": "wx", "kind": "sandstorm"})
	f.drain()
	f.r.survivalTick()
	if f.p.HP != f.r.defs.MaxHP-1 {
		t.Fatalf("a forced sandstorm cost %d hp on exposed sand, want 1", f.r.defs.MaxHP-f.p.HP)
	}
	if !hasMsgContaining(f.msgsOf(f.drain()), "sandstorm") {
		t.Error("the sandstorm branch sent no sandstorm message")
	}

	f.devcmd(map[string]any{"cmd": "wx", "kind": ""})
	f.p.HP = f.r.defs.MaxHP
	f.drain()
	f.r.survivalTick()
	if f.p.HP != f.r.defs.MaxHP {
		t.Fatalf("clearing the weather did not stop the damage: hp=%d", f.p.HP)
	}
}

// --- time ------------------------------------------------------------------

func TestDevTimeSetsClockAndDayNight(t *testing.T) {
	f := devFixture(t)
	for _, tc := range []struct {
		v     float64
		night bool
		label string
	}{
		{0.8, true, "night"},
		{0.3, false, "day"},
		{0.05, true, "night"},
	} {
		f.drain()
		f.devcmd(map[string]any{"cmd": "time", "v": tc.v})
		if f.r.time != tc.v {
			t.Fatalf("time %v set the clock to %v", tc.v, f.r.time)
		}
		if f.r.isNight() != tc.night {
			t.Fatalf("at time %v isNight() = %v, want %v", tc.v, f.r.isNight(), tc.night)
		}
		if !hasMsgContaining(f.msgsOf(f.drain()), tc.label) {
			t.Errorf("time %v did not report %q", tc.v, tc.label)
		}
	}
	// clamped to the legacy range, and non-numbers ignored
	f.devcmd(map[string]any{"cmd": "time", "v": 5.0})
	if f.r.time != 0.999 {
		t.Errorf("time 5 clamped to %v, want 0.999", f.r.time)
	}
	f.devcmd(map[string]any{"cmd": "time", "v": -5.0})
	if f.r.time != 0 {
		t.Errorf("time -5 clamped to %v, want 0", f.r.time)
	}
	f.devcmd(map[string]any{"cmd": "time", "v": "noon"})
	if f.r.time != 0 {
		t.Errorf("a non-numeric time moved the clock to %v", f.r.time)
	}
	// and the clock reaches the client on the next cre frame
	f.devcmd(map[string]any{"cmd": "time", "v": 0.42})
	f.drain()
	f.r.broadcastCre()
	cre := frameOfType(f.drain(), "cre")
	if cre == nil || cre["time"] != 0.42 {
		t.Fatalf("cre frame carried time=%v, want 0.42", cre["time"])
	}
}

// --- unknown ---------------------------------------------------------------

// Unknown commands are silently ignored, as in the legacy server: no toast, no
// state change.
func TestDevUnknownCommandIsSilent(t *testing.T) {
	f := devFixture(t)
	f.drain()
	f.devcmd(map[string]any{"cmd": "nuke"})
	if out := f.drain(); len(out) != 0 {
		t.Fatalf("an unknown devcmd answered %v, want silence", out)
	}
}

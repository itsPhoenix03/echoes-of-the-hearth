package room

import (
	"encoding/json"
	"math"
	"testing"

	"hearth/gameserver/world"
)

// --- harness --------------------------------------------------------------

// The room is single-goroutine by design, so these tests simply call the
// handlers directly on the room struct — exactly the goroutine ownership the
// real loop provides, minus the loop.

type fixture struct {
	r    *Room
	p    *Player
	now  int64
	t    *testing.T
	sess *Session
	// seen accumulates everything drained through lastOfType, so several
	// lookups after one action all see the same batch.
	seen []map[string]any
}

var sharedWorld *world.World

func newFixture(t *testing.T) *fixture {
	t.Helper()
	if sharedWorld == nil {
		sharedWorld = world.GenWorld("hearth-1")
	}
	r, err := New(Config{Seed: "hearth-1", AllowWarp: true, World: sharedWorld})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{r: r, t: t, now: 1_700_000_000_000}
	r.nowFn = func() int64 { return f.now }
	f.sess = NewSession("test01", "u_test", "Tester", "test")
	f.p = newPlayer(f.sess, r.spawn, f.now, r.defs)
	r.players[f.sess.ID] = f.p
	// playerOrder is the stable iteration order every creature loop walks, so a
	// fixture player that is only in the map is invisible to creature AI.
	r.playerOrder = append(r.playerOrder, f.p)
	// Chunk streaming is exercised elsewhere; pre-mark the join push so these
	// tests only observe movement traffic.
	f.p.chunkInit = true
	f.p.chunkCX, f.p.chunkCY = chunkOf(f.p.X, f.p.Y)
	return f
}

// drain returns every message queued for the player since the last drain.
func (f *fixture) drain() []map[string]any {
	var out []map[string]any
	for {
		select {
		case b := <-f.sess.Out:
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				f.t.Fatalf("unmarshal outbound: %v", err)
			}
			out = append(out, m)
		default:
			return out
		}
	}
}

// gotFix reports whether a snapback was sent.
func (f *fixture) gotFix() bool {
	for _, m := range f.drain() {
		if m["t"] == "fix" {
			return true
		}
	}
	return false
}

// pos runs the handler with a fresh fix throttle so every rejection is visible.
func (f *fixture) pos(m map[string]any) {
	f.p.LastFixAt = 0
	f.drain()
	f.r.handlePos(f.p, m)
}

// place puts the player on a tile without going through validation.
func (f *fixture) place(x, y float64, z int) {
	f.p.X, f.p.Y, f.p.Z = x, y, z
	if f.r.world.Tiles[ti(x, y)] != world.TWater {
		f.p.LastLandX, f.p.LastLandY = x, y
	}
	f.p.LastPosAt = f.now
	f.p.WarpUntil = 0
	f.p.LastZAt = 0
}

// findTile scans the world for the first tile satisfying pred.
func findTile(w *world.World, pred func(i int) bool) (int, int, bool) {
	for i := range w.Tiles {
		if pred(i) {
			return i % world.SIZE, i / world.SIZE, true
		}
	}
	return 0, 0, false
}

// --- tests ----------------------------------------------------------------

func TestPosAcceptsAStepWithinTheSpeedBudget(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.now += 200 // dt = 0.2s -> budget 6.2*1.6*0.2 + 1.0 = 2.98 tiles
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy})
	if f.gotFix() {
		t.Fatal("a one-tile step inside the budget was rejected")
	}
	if f.p.X != sx+1 || f.p.Y != sy {
		t.Fatalf("position not applied: got (%v,%v)", f.p.X, f.p.Y)
	}
}

func TestPosRejectsSpeedHack(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.now += 200
	// 40 tiles in 200 ms: an order of magnitude past MaxSpeed*SpeedSlack*dt+PosSlack.
	f.pos(map[string]any{"t": "pos", "x": sx + 40, "y": sy})
	if !f.gotFix() {
		t.Fatal("a 40-tile jump in 200ms was accepted")
	}
	if f.p.X != sx || f.p.Y != sy {
		t.Fatalf("rejected move still moved the player to (%v,%v)", f.p.X, f.p.Y)
	}
}

func TestPosRejectRefreshesLastPosAt(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	// A client that goes quiet for 10s then spams rejects must not be able to
	// bank the elapsed time: lastPosAt advances on rejection too.
	f.now += 10_000
	f.pos(map[string]any{"t": "pos", "x": sx + 100, "y": sy})
	if !f.gotFix() {
		t.Fatal("the 100-tile jump was accepted")
	}
	if f.p.LastPosAt != f.now {
		t.Fatalf("lastPosAt = %d, want %d — a rejected client is banking budget", f.p.LastPosAt, f.now)
	}
	// Immediately afterwards the budget is only PosSlack, so 3 tiles is out.
	f.pos(map[string]any{"t": "pos", "x": sx + 3, "y": sy})
	if !f.gotFix() {
		t.Fatal("3 tiles with dt=0 was accepted; the reject refilled the budget")
	}
}

func TestPosDtIsClampedToOneSecond(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.now += 30_000 // 30 seconds of silence
	// Budget must clamp to 1s: 6.2*1.6 + 1.0 = 10.92 tiles, not 190.
	f.pos(map[string]any{"t": "pos", "x": sx + 20, "y": sy})
	if !f.gotFix() {
		t.Fatal("a 20-tile jump after 30s of silence was accepted; dt is not clamped")
	}
}

func TestPosFixIsThrottled(t *testing.T) {
	f := newFixture(t)
	f.drain()
	bad := map[string]any{"t": "pos", "x": f.p.X + 500, "y": f.p.Y}
	f.r.handlePos(f.p, bad)
	first := f.drain()
	f.r.handlePos(f.p, bad)
	second := f.drain()
	if len(first) != 1 || first[0]["t"] != "fix" {
		t.Fatalf("expected exactly one fix, got %v", first)
	}
	if len(second) != 0 {
		t.Fatalf("expected the second fix to be throttled, got %v", second)
	}
	f.now += FixMS
	f.r.handlePos(f.p, bad)
	if !f.gotFix() {
		t.Fatal("no fix after the throttle window elapsed")
	}
}

func TestPosRejectsOutOfRangeAndNonFinite(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	for _, m := range []map[string]any{
		{"t": "pos", "x": -1.0, "y": sy},
		{"t": "pos", "x": sx, "y": float64(world.SIZE)},
		{"t": "pos", "x": "nope", "y": sy},          // Number("nope") === NaN
		{"t": "pos", "y": sy},                       // x undefined
		{"t": "pos", "x": sx, "y": sy, "z": 3.0},    // z out of range
		{"t": "pos", "x": sx, "y": sy, "b": 7.0},    // b out of range
		{"t": "pos", "x": sx, "y": sy, "z": -1.0},   // negative z
		{"t": "pos", "x": math.MaxFloat64, "y": sy}, // enormous but finite
	} {
		f.pos(m)
		if !f.gotFix() {
			t.Fatalf("sanitisation accepted %v", m)
		}
		if f.p.X != sx || f.p.Y != sy {
			t.Fatalf("%v moved the player", m)
		}
	}
}

func TestPosRejectsCollisionWithAStructure(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.r.structures[ti(sx+1, sy)] = &Structure{Kind: "wall", HP: 20, Lvl: 1}
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy})
	if !f.gotFix() {
		t.Fatal("walked straight into a wall")
	}
	// ...but non-blocking decor on the same tile is walkable.
	f.r.structures[ti(sx+1, sy)] = &Structure{Kind: "rug", HP: 5, Lvl: 1}
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy})
	if f.gotFix() {
		t.Fatal("a rug blocked movement")
	}
}

// TestPosRejectsCollisionWithWorldBlockers covers the two collision sources
// that exist in the real hearth-1 world with no structures placed: landmark
// tiles and the medics' huts. (hearth-1 has no adjacent land pair with an
// elevation gap above 2, so the jump bound cannot be exercised against real
// terrain; the same elevation array is exercised by TestFallDamage.)
func TestPosRejectsCollisionWithWorldBlockers(t *testing.T) {
	f := newFixture(t)

	tryStepInto := func(name string, blocked map[int]bool) {
		for i := range blocked {
			x, y := i%world.SIZE, i/world.SIZE
			if x == 0 {
				continue
			}
			from := i - 1
			if blocked[from] || f.r.world.Tiles[from] == world.TWater {
				continue
			}
			if int(f.r.world.Elev[i])-int(f.r.world.Elev[from]) > 2 {
				continue // would be rejected by the jump bound instead
			}
			f.place(float64(x-1), float64(y), 0)
			f.now += 200
			f.pos(map[string]any{"t": "pos", "x": float64(x), "y": float64(y)})
			if !f.gotFix() {
				t.Fatalf("%s tile (%d,%d) did not block movement", name, x, y)
			}
			if f.p.X != float64(x-1) {
				t.Fatalf("%s: rejected move still applied", name)
			}
			return
		}
		t.Fatalf("%s: found no testable blocked tile", name)
	}

	tryStepInto("landmark", world.LandmarkBlock)
	tryStepInto("medic", f.r.medicTiles)
}

// TestPosBlockedJumpBound checks the elevation guard. hearth-1 contains no
// natural 0 -> 3 adjacency, so the test clones the world and carves one; the
// clone keeps the rest of the terrain real.
func TestPosBlockedJumpBound(t *testing.T) {
	if sharedWorld == nil {
		sharedWorld = world.GenWorld("hearth-1")
	}
	clone := *sharedWorld
	clone.Elev = append([]uint8(nil), sharedWorld.Elev...)
	r, err := New(Config{Seed: "hearth-1", World: &clone})
	if err != nil {
		t.Fatal(err)
	}
	f := &fixture{r: r, t: t, now: 1_700_000_000_000}
	r.nowFn = func() int64 { return f.now }
	f.sess = NewSession("test01", "u_test", "Tester", "test")
	f.p = newPlayer(f.sess, r.spawn, f.now, r.defs)
	f.p.chunkInit = true
	r.players[f.sess.ID] = f.p

	sx, sy := f.p.X, f.p.Y
	clone.Elev[ti(sx, sy)] = 0
	clone.Elev[ti(sx+1, sy)] = 3
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy})
	if !f.gotFix() {
		t.Fatal("climbed 3 elevation levels in one step")
	}
	// A 2-level climb is inside the permissive jump bound.
	clone.Elev[ti(sx+1, sy)] = 2
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy})
	if f.gotFix() {
		t.Fatal("a 2-level climb was rejected; the jump bound is too strict")
	}
}

// TestPosAcceptsWaterAtZeroZ is the regression guard for reusing the legacy
// blocked(), which treats WATER as solid and would forbid swimming and boats
// outright.
func TestPosAcceptsWaterAtZeroZ(t *testing.T) {
	f := newFixture(t)
	// A land tile with water immediately to its east.
	x, y, ok := findTile(f.r.world, func(i int) bool {
		x := i % world.SIZE
		return x+1 < world.SIZE &&
			f.r.world.Tiles[i] != world.TWater &&
			f.r.world.Tiles[i+1] == world.TWater &&
			!f.r.medicTiles[i] && !world.LandmarkBlock[i]
	})
	if !ok {
		t.Fatal("hearth-1 has no shoreline tile, which cannot be right")
	}
	f.place(float64(x), float64(y), 0)
	f.now += 200

	// Swimming (b = 0).
	f.pos(map[string]any{"t": "pos", "x": float64(x + 1), "y": float64(y)})
	if f.gotFix() {
		t.Fatalf("swimming into water at (%d,%d) was rejected", x+1, y)
	}
	if f.p.X != float64(x+1) {
		t.Fatal("the accepted swim did not move the player")
	}
	// lastLand must stay on the shore for boat-wreck recovery.
	if f.p.LastLandX != float64(x) || f.p.LastLandY != float64(y) {
		t.Fatalf("lastLand drifted onto water: (%v,%v)", f.p.LastLandX, f.p.LastLandY)
	}

	// Sailing (b = 1) over the same tile.
	f.place(float64(x), float64(y), 0)
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": float64(x + 1), "y": float64(y), "b": 1.0})
	if f.gotFix() {
		t.Fatal("sailing into water was rejected")
	}
	if f.p.B != 1 {
		t.Fatalf("boat state not applied: b = %d", f.p.B)
	}
}

// TestZAnchorRejectsARemoteMineshaft is the exploit test: the z branch skips the
// distance check, so anchoring on the destination alone would turn every
// mineshaft on the map into an unbounded teleport.
func TestZAnchorRejectsARemoteMineshaft(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	// A mineshaft 400 tiles away, with a carved tile right beside it.
	remoteX, remoteY := sx+400, sy
	f.r.structures[ti(remoteX, remoteY)] = &Structure{Kind: "mineshaft", HP: 25, Lvl: 1}
	f.r.digs[ti(remoteX+1, remoteY)] = true

	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": remoteX + 1, "y": remoteY, "z": 1.0})
	if !f.gotFix() {
		t.Fatal("descended into a mineshaft 400 tiles away")
	}
	if f.p.Z != 0 || f.p.X != sx || f.p.Y != sy {
		t.Fatalf("the exploit moved the player to (%v,%v,z=%d)", f.p.X, f.p.Y, f.p.Z)
	}

	// A second mineshaft at the player's feet does not help either: the gate
	// needs ONE structure within ZNear of BOTH endpoints.
	f.r.structures[ti(sx, sy)] = &Structure{Kind: "mineshaft", HP: 25, Lvl: 1}
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": remoteX + 1, "y": remoteY, "z": 1.0})
	if !f.gotFix() {
		t.Fatal("two distant mineshafts were chained into a teleport")
	}
}

func TestZAnchorAcceptsALegitimateDescent(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.r.structures[ti(sx+1, sy)] = &Structure{Kind: "mineshaft", HP: 25, Lvl: 1}
	f.r.digs[ti(sx+1, sy)] = true // the carved anchor tile under the shaft

	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy, "z": 1.0})
	if f.gotFix() {
		t.Fatal("a legitimate descent at the player's own mineshaft was rejected")
	}
	if f.p.Z != 1 {
		t.Fatalf("z = %d after descending, want 1", f.p.Z)
	}

	// Underground, only carved tiles are walkable.
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 2, "y": sy})
	if !f.gotFix() {
		t.Fatal("walked into solid rock underground")
	}
	f.r.digs[ti(sx+2, sy)] = true
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx + 2, "y": sy})
	if f.gotFix() {
		t.Fatal("walking down a carved tunnel was rejected")
	}

	// Coming back out skips the collision check (the exit tile is not chosen by
	// the player) but still needs the shared anchor and the cooldown.
	f.now += ZCooldownMS
	f.place(sx+1, sy, 1)
	f.pos(map[string]any{"t": "pos", "x": sx + 1, "y": sy, "z": 0.0})
	if f.gotFix() {
		t.Fatal("surfacing at the mineshaft was rejected")
	}
	if f.p.Z != 0 {
		t.Fatalf("z = %d after surfacing, want 0", f.p.Z)
	}
}

func TestZChangeCooldown(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	f.r.structures[ti(sx, sy)] = &Structure{Kind: "mineshaft", HP: 25, Lvl: 1}
	f.r.digs[ti(sx, sy)] = true

	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": sx, "y": sy, "z": 1.0})
	if f.gotFix() {
		t.Fatal("first descent rejected")
	}
	// Immediately back up: inside the 500 ms cooldown.
	f.now += 100
	f.pos(map[string]any{"t": "pos", "x": sx, "y": sy, "z": 0.0})
	if !f.gotFix() {
		t.Fatal("layer flip inside the cooldown was accepted")
	}
	f.now += ZCooldownMS
	f.pos(map[string]any{"t": "pos", "x": sx, "y": sy, "z": 0.0})
	if f.gotFix() {
		t.Fatal("layer change after the cooldown was rejected")
	}
}

func TestFallDamage(t *testing.T) {
	f := newFixture(t)
	// Adjacent land tiles with a drop of 2 or more.
	var fromX, fromY, toX, toY float64
	var drop int
	found := false
	for i := 0; i < world.SIZE*world.SIZE && !found; i++ {
		x, y := i%world.SIZE, i/world.SIZE
		if x+1 >= world.SIZE {
			continue
		}
		if f.r.world.Tiles[i] == world.TWater || f.r.world.Tiles[i+1] == world.TWater {
			continue
		}
		if f.r.medicTiles[i+1] || world.LandmarkBlock[i+1] {
			continue
		}
		d := int(f.r.world.Elev[i]) - int(f.r.world.Elev[i+1])
		if d >= 2 {
			fromX, fromY, toX, toY, drop = float64(x), float64(y), float64(x+1), float64(y), d
			found = true
		}
	}
	if !found {
		t.Skip("hearth-1 has no adjacent land pair with a drop of 2 or more")
	}
	f.place(fromX, fromY, 0)
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": toX, "y": toY})
	msgs := f.drain()
	if f.p.HP != MaxHP-(drop-1) {
		t.Fatalf("hp = %d after a %d-level drop, want %d", f.p.HP, drop, MaxHP-(drop-1))
	}
	var sawHP bool
	for _, m := range msgs {
		if m["t"] == "hp" {
			sawHP = true
		}
		if m["t"] == "fix" {
			t.Fatal("the fall was also rejected as a collision")
		}
	}
	if !sawHP {
		t.Fatal("no hp message was sent for the fall")
	}
	// A boat absorbs it: the JS guard is `!m.b`.
	f.p.HP = MaxHP
	f.place(fromX, fromY, 0)
	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": toX, "y": toY, "b": 1.0})
	if f.p.HP != MaxHP {
		t.Fatalf("fall damage applied while boating: hp = %d", f.p.HP)
	}
}

func TestWarpGraceSuppressesTheDistanceCheck(t *testing.T) {
	f := newFixture(t)
	sx, sy := f.p.X, f.p.Y
	// Warp far away; the client's in-flight pos from the OLD spot must not be
	// rejected, or the two sides fight over the position.
	f.r.handleWarp(f.p, map[string]any{"t": "warp", "x": sx + 300, "y": sy})
	f.drain()
	if f.p.X != sx+300 {
		t.Fatalf("warp did not move the player: %v", f.p.X)
	}
	f.now += 50
	f.pos(map[string]any{"t": "pos", "x": sx, "y": sy})
	if f.gotFix() {
		t.Fatal("an in-flight pos inside the warp grace window was rejected")
	}
	// Once the grace window lapses, the check is live again.
	f.r.handleWarp(f.p, map[string]any{"t": "warp", "x": sx + 300, "y": sy})
	f.drain()
	f.now += WarpGraceMS + 1
	f.pos(map[string]any{"t": "pos", "x": sx, "y": sy})
	if !f.gotFix() {
		t.Fatal("a 300-tile move after the grace window was accepted")
	}
}

func TestWarpIsOffUnlessEnabled(t *testing.T) {
	f := newFixture(t)
	f.r.cfg.AllowWarp = false
	sx, sy := f.p.X, f.p.Y
	f.r.handleWarp(f.p, map[string]any{"t": "warp", "x": sx + 300, "y": sy})
	if f.p.X != sx || f.p.Y != sy {
		t.Fatal("warp worked with HEARTH_ALLOW_WARP unset")
	}
}

func TestPosBroadcastsAndRelays(t *testing.T) {
	f := newFixture(t)
	// A second player must see the first one's move.
	other := NewSession("test02", "u_other", "Other", "test")
	q := newPlayer(other, f.r.spawn, f.now, f.r.defs)
	q.chunkInit = true
	f.r.players[other.ID] = q

	f.now += 200
	f.pos(map[string]any{"t": "pos", "x": f.p.X + 1, "y": f.p.Y})
	var relayed map[string]any
	for {
		select {
		case b := <-other.Out:
			var m map[string]any
			_ = json.Unmarshal(b, &m)
			if m["t"] == "pos" {
				relayed = m
			}
			continue
		default:
		}
		break
	}
	if relayed == nil {
		t.Fatal("the move was not relayed to the other player")
	}
	if relayed["id"] != "test01" {
		t.Fatalf("relay carried id %v, want test01", relayed["id"])
	}
}

func TestSlowClientIsDroppedNotBlocking(t *testing.T) {
	f := newFixture(t)
	// Fill the outbound buffer without draining it, then broadcast once more.
	for i := 0; i < OutboundBuffer+1; i++ {
		f.r.broadcast(map[string]any{"t": "msg", "s": "flood"})
		if _, still := f.r.players[f.sess.ID]; !still {
			// Dropped, as intended, and the broadcast never blocked.
			select {
			case <-f.sess.Closed():
			default:
				t.Fatal("the player was removed but the session was not closed")
			}
			return
		}
	}
	t.Fatal("a client that never drains was not dropped")
}

package room

import (
	"encoding/json"
	"testing"

	"hearth/gameserver/world"
)

// --- helpers ---------------------------------------------------------------

// newRoom builds a bare room on the package's shared world. cap 0 means the
// default (4).
func newRoom(t *testing.T, max int, reg *Registry) *Room {
	t.Helper()
	if sharedWorld == nil {
		sharedWorld = world.GenWorld("hearth-1")
	}
	r, err := New(Config{Seed: "hearth-1", World: sharedWorld, MaxPlayers: max, Registry: reg})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// admitSession runs the real join path and returns the room's verdict: "" when
// admitted, otherwise the authfail reason.
func admitSession(t *testing.T, r *Room, sessID, userID string) (*Session, string) {
	t.Helper()
	s := NewSession(sessID, userID, "Tester-"+sessID, "test")
	r.onJoin(s)
	select {
	case reason := <-s.admit:
		return s, reason
	default:
		t.Fatalf("onJoin(%s) produced no verdict", sessID)
		return nil, ""
	}
}

// frames decodes everything currently queued for a session.
func frames(t *testing.T, s *Session) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, b := range s.Drain() {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("unmarshal outbound: %v", err)
		}
		out = append(out, m)
	}
	return out
}

func frameOf(ms []map[string]any, t string) map[string]any {
	for _, m := range ms {
		if m["t"] == t {
			return m
		}
	}
	return nil
}

// serviceKicks applies whatever cross-room eviction requests are pending,
// exactly as Room.Run's `kicks` case does. Tests drive it by hand instead of
// starting the room goroutine (worldgen ticks are not what is under test here).
func serviceKicks(r *Room) int {
	n := 0
	for {
		select {
		case kr := <-r.kicks:
			n++
			if p, ok := r.players[kr.s.ID]; ok {
				r.kickPlayer(p, kr.reason)
			} else {
				kr.s.Close()
			}
		default:
			return n
		}
	}
}

// --- the cap ---------------------------------------------------------------

// Four players fit — including the fourth, which is the case a fencepost error
// would silently eat — and the fifth is refused with a reason it can show.
func TestRoomCapAdmitsFourAndRefusesTheFifth(t *testing.T) {
	r := newRoom(t, 0, nil)
	if r.MaxPlayers() != DefaultMaxPlayers {
		t.Fatalf("default cap = %d, want %d", r.MaxPlayers(), DefaultMaxPlayers)
	}
	for i, id := range []string{"s1", "s2", "s3", "s4"} {
		s, reason := admitSession(t, r, id, "u_"+id)
		if reason != "" {
			t.Fatalf("player %d refused: %q", i+1, reason)
		}
		if frameOf(frames(t, s), "init") == nil {
			t.Fatalf("player %d got no init frame", i+1)
		}
	}
	if len(r.players) != 4 || len(r.playerOrder) != 4 {
		t.Fatalf("after four joins: players=%d order=%d", len(r.players), len(r.playerOrder))
	}

	fifth, reason := admitSession(t, r, "s5", "u_s5")
	if reason != ReasonRoomFull {
		t.Fatalf("fifth player verdict = %q, want %q", reason, ReasonRoomFull)
	}
	// A refused client must learn nothing about the world: no init, no chunk.
	for _, m := range frames(t, fifth) {
		t.Fatalf("refused session was sent a %q frame before authfail", m["t"])
	}
	if _, ok := r.players["s5"]; ok {
		t.Fatal("refused session was added to players")
	}
	if len(r.players) != 4 || len(r.playerOrder) != 4 {
		t.Fatalf("refusal disturbed the room: players=%d order=%d", len(r.players), len(r.playerOrder))
	}
	if _, live := r.registry.Lookup("u_s5"); live {
		t.Fatal("refused session claimed the identity registry")
	}
}

// The cap is per-world configuration, not a constant.
func TestRoomCapIsConfigurable(t *testing.T) {
	r := newRoom(t, 2, nil)
	if _, reason := admitSession(t, r, "c1", "u_c1"); reason != "" {
		t.Fatalf("first refused: %q", reason)
	}
	if _, reason := admitSession(t, r, "c2", "u_c2"); reason != "" {
		t.Fatalf("second refused: %q", reason)
	}
	if _, reason := admitSession(t, r, "c3", "u_c3"); reason != ReasonRoomFull {
		t.Fatalf("third verdict = %q, want %q", reason, ReasonRoomFull)
	}
}

// A seat freed by a leave is reusable — the cap counts live players, not joins.
func TestRoomCapFreesSeatsOnLeave(t *testing.T) {
	r := newRoom(t, 1, nil)
	s1, _ := admitSession(t, r, "l1", "u_l1")
	if _, reason := admitSession(t, r, "l2", "u_l2"); reason != ReasonRoomFull {
		t.Fatalf("second player was admitted into a cap-1 room")
	}
	r.onLeave(s1)
	if _, reason := admitSession(t, r, "l2", "u_l2"); reason != "" {
		t.Fatalf("seat was not freed on leave: %q", reason)
	}
}

// --- takeover --------------------------------------------------------------

// The duplicate-tab bug: a second ticket for the same userId must REPLACE the
// live session, never add a second copy of the same player to the room.
func TestTakeoverReplacesRatherThanDuplicates(t *testing.T) {
	r := newRoom(t, 0, nil)
	witness, _ := admitSession(t, r, "w1", "u_witness")
	old, reason := admitSession(t, r, "dup1", "u_dup")
	if reason != "" {
		t.Fatalf("first session refused: %q", reason)
	}
	frames(t, witness) // discard the join traffic

	fresh, reason := admitSession(t, r, "dup2", "u_dup")
	if reason != "" {
		t.Fatalf("takeover was refused: %q", reason)
	}

	if len(r.players) != 2 {
		t.Fatalf("players = %d after takeover, want 2 (the witness and one copy)", len(r.players))
	}
	if len(r.playerOrder) != 2 {
		t.Fatalf("playerOrder = %d after takeover, want 2 — a half-evicted session is still in the ordered mirror", len(r.playerOrder))
	}
	if _, stale := r.players["dup1"]; stale {
		t.Fatal("the replaced session is still in players")
	}
	for _, p := range r.playerOrder {
		if p.S.ID == "dup1" {
			t.Fatal("the replaced session is still in playerOrder")
		}
	}
	if _, ok := r.players["dup2"]; !ok {
		t.Fatal("the new session did not join")
	}

	// The evicted session is told why, and only then closed.
	k := frameOf(frames(t, old), "kick")
	if k == nil {
		t.Fatal("the evicted session got no kick frame")
	}
	if k["reason"] != ReasonReplaced {
		t.Fatalf("kick reason = %v, want %q", k["reason"], ReasonReplaced)
	}
	select {
	case <-old.Closed():
	default:
		t.Fatal("the evicted session was not closed")
	}

	// Everyone else is told the old session left, so no ghost is left on screen.
	pl := frameOf(frames(t, witness), "pl")
	if pl == nil || pl["id"] != "dup1" {
		t.Fatalf("witness saw %v, want pl for the evicted session", pl)
	}

	// And the identity now points at the new session.
	pres, ok := r.registry.Lookup("u_dup")
	if !ok || pres.S != fresh || pres.Room != r {
		t.Fatalf("registry points at %+v, want the new session in this room", pres)
	}
}

// Ordering: takeover is resolved BEFORE the cap. One of four seats in a full
// room is mine; reconnecting replaces it rather than asking for a fifth. Getting
// this backwards means a player who crashes cannot rejoin a full room.
func TestTakeoverIntoAFullRoomSucceeds(t *testing.T) {
	r := newRoom(t, 0, nil)
	for _, id := range []string{"f1", "f2", "f3", "f4"} {
		if _, reason := admitSession(t, r, id, "u_"+id); reason != "" {
			t.Fatalf("%s refused: %q", id, reason)
		}
	}
	if len(r.players) != r.MaxPlayers() {
		t.Fatalf("room is not full: %d players", len(r.players))
	}

	old := r.players["f2"].S
	fresh, reason := admitSession(t, r, "f2b", "u_f2")
	if reason != "" {
		t.Fatalf("takeover into a full room was refused with %q — a crashed player can never get back in", reason)
	}
	if len(r.players) != 4 || len(r.playerOrder) != 4 {
		t.Fatalf("after takeover: players=%d order=%d, want 4/4", len(r.players), len(r.playerOrder))
	}
	if _, stale := r.players["f2"]; stale {
		t.Fatal("the replaced session survived the takeover")
	}
	if frameOf(frames(t, old), "kick") == nil {
		t.Fatal("the replaced session got no kick frame")
	}
	if frameOf(frames(t, fresh), "init") == nil {
		t.Fatal("the new session got no init frame")
	}

	// A genuinely new fifth identity is still refused.
	if _, reason := admitSession(t, r, "f5", "u_f5"); reason != ReasonRoomFull {
		t.Fatalf("a fifth identity got %q, want %q", reason, ReasonRoomFull)
	}
}

// Takeover runs the same teardown a disconnect does, so the evicted session's
// progress is snapshotted and the replacement inherits it. Anything less makes
// duplicating a tab a way to lose your inventory.
func TestTakeoverSnapshotsTheEvictedProfile(t *testing.T) {
	r := newRoom(t, 0, nil)
	_, _ = admitSession(t, r, "sn1", "u_snap")
	p := r.players["sn1"]
	p.Inv["wood"] = 17
	p.HP = 5
	p.Tools["axe"] = true

	if _, reason := admitSession(t, r, "sn2", "u_snap"); reason != "" {
		t.Fatalf("takeover refused: %q", reason)
	}
	prof := r.profiles["u_snap"]
	if prof == nil {
		t.Fatal("the evicted session was not snapshotted")
	}
	if prof.Inv["wood"] != 17 || prof.HP != 5 {
		t.Fatalf("snapshot lost state: %+v", prof)
	}
	np := r.players["sn2"]
	if np.Inv["wood"] != 17 || np.HP != 5 || !np.Tools["axe"] {
		t.Fatalf("the replacement did not inherit the profile: inv=%d hp=%d tools=%v", np.Inv["wood"], np.HP, np.Tools)
	}
}

// Scope: the registry is process-wide, so the same identity joining world B
// while still live in world A evicts the world-A session. Two rooms, one
// registry — exactly how hosting.Manager wires it.
func TestTakeoverCrossesRooms(t *testing.T) {
	reg := NewRegistry()
	a := newRoom(t, 0, reg)
	b := newRoom(t, 0, reg)

	old, reason := admitSession(t, a, "x1", "u_cross")
	if reason != "" {
		t.Fatalf("join into world A refused: %q", reason)
	}
	frames(t, old)

	if _, reason := admitSession(t, b, "x2", "u_cross"); reason != "" {
		t.Fatalf("join into world B refused: %q", reason)
	}
	// World A is evicted on its own goroutine; drive that step by hand.
	if n := serviceKicks(a); n != 1 {
		t.Fatalf("world A received %d eviction requests, want 1", n)
	}
	if len(a.players) != 0 || len(a.playerOrder) != 0 {
		t.Fatalf("world A still holds the session: players=%d order=%d", len(a.players), len(a.playerOrder))
	}
	if len(b.players) != 1 {
		t.Fatalf("world B has %d players, want 1", len(b.players))
	}
	k := frameOf(frames(t, old), "kick")
	if k == nil || k["reason"] != ReasonReplaced {
		t.Fatalf("the cross-world eviction sent %v, want kick/replaced", k)
	}
	pres, ok := reg.Lookup("u_cross")
	if !ok || pres.Room != b {
		t.Fatal("the registry did not follow the identity to world B")
	}
}

// A disconnect must give the identity back, or a player who closes the tab and
// opens a new one would evict a session that no longer exists.
func TestLeaveReleasesTheIdentity(t *testing.T) {
	r := newRoom(t, 0, nil)
	s, _ := admitSession(t, r, "r1", "u_rel")
	r.onLeave(s)
	if _, ok := r.registry.Lookup("u_rel"); ok {
		t.Fatal("leaving did not release the identity")
	}
	if _, reason := admitSession(t, r, "r2", "u_rel"); reason != "" {
		t.Fatalf("rejoin after leave refused: %q", reason)
	}
}

// A takeover replaces the registry entry BEFORE the old session is torn down,
// so the old session's teardown must not delete the new session's claim.
func TestEvictedTeardownDoesNotStealTheIdentity(t *testing.T) {
	r := newRoom(t, 0, nil)
	old, _ := admitSession(t, r, "t1", "u_steal")
	fresh, _ := admitSession(t, r, "t2", "u_steal")
	// The socket goroutine of the evicted connection reports the leave late.
	r.onLeave(old)
	pres, ok := r.registry.Lookup("u_steal")
	if !ok || pres.S != fresh {
		t.Fatalf("the late leave of the evicted session cleared the live claim: %+v ok=%v", pres, ok)
	}
	if _, live := r.players["t2"]; !live {
		t.Fatal("the late leave removed the wrong player")
	}
}

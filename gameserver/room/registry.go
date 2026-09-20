package room

import "sync"

// Registry answers one process-wide question: which session, if any, is
// currently live for a given ticket identity (`userId`)?
//
// # Why this is not room state
//
// A duplicated browser tab shares localStorage, so it presents the same
// `hearth-tok`, the control plane signs a ticket for the same `userId`, and two
// sockets arrive claiming to be one player. A room can see that on its own only
// when both sockets land in the same room; the same user joining world B while
// still live in world A is the identical duplication and no single room can see
// it. So the answer lives one level up, beside the *registry of rooms* in
// hosting.Manager, and is guarded by a mutex for the same reason that one is:
// it is bookkeeping about rooms, never game state. Nothing reachable from a
// *Player or a *Room is stored here — only the session identity and the room
// that owns it — so the contract at the top of room.go is untouched: every
// mutation of a room's players still happens on that room's own goroutine.
//
// # Policy: takeover, not rejection
//
// A second live ticket for one identity evicts the first. Rejecting the
// newcomer instead would lock a player out of their own character after a
// browser crash or a dropped connection until the stale socket timed out, which
// is a worse failure than the duplication it prevents.
type Registry struct {
	mu   sync.Mutex
	live map[string]Presence
}

// Presence is where one identity is currently playing.
type Presence struct {
	Room *Room
	S    *Session
}

// NewRegistry builds an empty registry. One per process is the intent; a Room
// constructed without one gets a private registry, so takeover still works for
// a single-room process and in tests.
func NewRegistry() *Registry { return &Registry{live: map[string]Presence{}} }

// Claim decides admission for a joining session and, if admitted, makes it the
// live session for userID.
//
// admit is called with the lock held, so it must not block and must not take
// another lock. It is passed the identity's current presence (zero value when
// had is false) and returns whether the join may proceed; on false nothing is
// changed. It is always invoked from the joining room's own goroutine and only
// ever reads that room's state, which is what lets the "is this a takeover or a
// fifth player?" decision be atomic with respect to every other room.
//
// The returned prev/had describe the session being displaced, for the caller to
// evict; ok reports whether admit allowed the join.
func (g *Registry) Claim(userID string, r *Room, s *Session, admit func(prev Presence, had bool) bool) (prev Presence, had bool, ok bool) {
	if g == nil || userID == "" {
		return Presence{}, false, true
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	prev, had = g.live[userID]
	if had && prev.S == s {
		// Re-claiming the same session displaces nobody.
		had = false
		prev = Presence{}
	}
	if admit != nil && !admit(prev, had) {
		return Presence{}, false, false
	}
	if g.live == nil {
		g.live = map[string]Presence{}
	}
	g.live[userID] = Presence{Room: r, S: s}
	return prev, had, true
}

// Release forgets userID, but only if it still points at s. The guard is the
// whole point: a takeover replaces the entry before the old session is torn
// down, and the old session's teardown must not then delete the new session's
// claim.
func (g *Registry) Release(userID string, s *Session) {
	if g == nil || userID == "" {
		return
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	if cur, ok := g.live[userID]; ok && cur.S == s {
		delete(g.live, userID)
	}
}

// Lookup reports the live presence for an identity. For tests and logging.
func (g *Registry) Lookup(userID string) (Presence, bool) {
	if g == nil {
		return Presence{}, false
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	p, ok := g.live[userID]
	return p, ok
}

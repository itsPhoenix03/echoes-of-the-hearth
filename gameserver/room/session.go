package room

import (
	"encoding/json"
	"sync"
)

// OutboundBuffer is the depth of a player's outbound queue. A join burst is 25
// chunk messages (~2-6 KB each), so the buffer must comfortably hold one full
// chunk push plus the tick chatter that overlaps it. Anything deeper only
// delays the moment we notice a client is not draining.
const OutboundBuffer = 96

// Session is one authenticated WebSocket connection. It is created by the net
// layer, handed to the room, and thereafter its mutable game state (see Player)
// lives exclusively on the room goroutine.
//
// The only fields touched from more than one goroutine are Out and the close
// signal, and both are designed for it: Out is a buffered channel the room
// writes and the writer goroutine drains, and Close is idempotent.
type Session struct {
	ID     string // session id, 6 base36 chars, as the legacy server generates
	UserID string // authenticated identity from the ticket
	Name   string // authenticated name from the ticket
	Addr   string

	// DevClaim is the ticket's optional `dev` claim: nil when the control plane
	// said nothing (the current state — see the TODO in room/dev.go), otherwise
	// the authenticated answer to "may this account use dev commands". It is
	// written once by the net layer before the session is handed to the room
	// and never mutated afterwards.
	DevClaim *bool

	Out chan []byte

	closeOnce sync.Once
	closed    chan struct{}
}

// NewSession builds a session with its outbound queue.
func NewSession(id, userID, name, addr string) *Session {
	return &Session{
		ID: id, UserID: userID, Name: name, Addr: addr,
		Out:    make(chan []byte, OutboundBuffer),
		closed: make(chan struct{}),
	}
}

// Closed is closed exactly once, when the session is torn down. The writer and
// reader goroutines select on it to exit.
func (s *Session) Closed() <-chan struct{} { return s.closed }

// Close is safe to call from any goroutine, any number of times.
func (s *Session) Close() {
	s.closeOnce.Do(func() { close(s.closed) })
}

// trySend queues a pre-marshalled frame without ever blocking. It returns false
// when the queue is full, which the room treats as "this client is not keeping
// up" and answers by dropping the connection. A slow client must never stall
// the world tick, so there is deliberately no blocking path here.
func (s *Session) trySend(b []byte) bool {
	select {
	case <-s.closed:
		return false
	case s.Out <- b:
		return true
	default:
		return false
	}
}

// Inbound is one decoded client frame on its way to the room goroutine.
type Inbound struct {
	S    *Session
	Data map[string]any
}

func marshal(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		// Every message we build is a plain struct/map of JSON-safe values, so
		// this is a programming error rather than a runtime condition.
		panic("room: marshal: " + err.Error())
	}
	return b
}

// Package net is the WebSocket edge. It owns the socket goroutines and nothing
// else: no game state is read or written here. See the package comment in
// room/room.go for the concurrency contract these goroutines uphold.
package net

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"time"

	ws "github.com/coder/websocket"

	"hearth/gameserver/auth"
	"hearth/gameserver/room"
)

const (
	// authTimeout bounds how long an unauthenticated socket may sit open. No
	// world data is sent before a valid ticket, so an idle socket here costs
	// only a file descriptor — but it should still not cost one forever.
	authTimeout = 10 * time.Second
	// roomTimeout bounds how long a connection waits for its room. A world that
	// is built lazily takes a couple of seconds to generate, and a second player
	// arriving mid-build waits for the same build, so this is generous.
	roomTimeout = 45 * time.Second
	// maxFrame is generous for a client frame (they are all tiny) while still
	// bounding what a hostile peer can make us buffer.
	maxFrame = 64 * 1024
)

// Rooms routes an authenticated ticket binding to the room that serves it. It
// is implemented by hosting.Manager; the interface keeps the socket layer from
// depending on how worlds are configured or when they are built.
//
// Resolve may block — a lazily built world takes a couple of seconds to
// generate — so it is given a context and called before the room is joined.
type Rooms interface {
	Resolve(ctx context.Context, instanceID, worldID string) (*room.Room, error)
}

// AuthFailReason is implemented by resolution errors a client may be told
// about. Anything else becomes a generic reason, so internal failures do not
// leak out of the handshake.
type AuthFailReason interface{ AuthFailReason() string }

// Server wires the HTTP listener to the hosted rooms.
type Server struct {
	Rooms    Rooms
	Verifier *auth.Verifier
	Logger   *log.Logger
}

// Handler returns the HTTP handler serving the game WebSocket.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	})
	mux.HandleFunc("/", s.serveWS)
	return mux
}

func (s *Server) serveWS(w http.ResponseWriter, r *http.Request) {
	c, err := ws.Accept(w, r, &ws.AcceptOptions{
		// The dev client is served from Vite on another origin, and the ticket
		// — not the origin — is the security boundary here.
		InsecureSkipVerify: true,
	})
	if err != nil {
		return
	}
	c.SetReadLimit(maxFrame)

	ctx := r.Context()
	sess, payload, err := s.handshake(ctx, c, r.RemoteAddr)
	if err != nil {
		// handshake already sent authfail where appropriate.
		_ = c.Close(ws.StatusPolicyViolation, "auth")
		return
	}

	// Routing happens here and nowhere else: the ticket's worldId picks the
	// room, and its instanceId must be this process. A connection therefore
	// only ever holds a reference to one room, which is what keeps worlds
	// isolated — there is no path by which a frame crosses between them.
	rctx, cancel := context.WithTimeout(ctx, roomTimeout)
	rm, err := s.Rooms.Resolve(rctx, payload.InstanceID, payload.WorldID)
	cancel()
	if err != nil {
		s.authFail(ctx, c, resolveReason(err))
		_ = c.Close(ws.StatusPolicyViolation, "auth")
		return
	}

	// The room, not this layer, decides admission: the player cap and the
	// one-live-session-per-identity takeover both need to know who is actually
	// connected, which only the room goroutine does. A refusal comes back with
	// an authfail reason and is relayed verbatim — before any init or chunk
	// data, because a refused session never joined at all.
	if err := rm.Join(ctx, sess); err != nil {
		var af AuthFailReason
		if errors.As(err, &af) {
			s.authFail(ctx, c, af.AuthFailReason())
			_ = c.Close(ws.StatusPolicyViolation, "auth")
			return
		}
		_ = c.Close(ws.StatusGoingAway, "shutting down")
		return
	}

	// One writer goroutine per connection, draining that connection's own
	// buffered channel. It never touches room state.
	go s.writeLoop(c, sess)

	s.readLoop(ctx, c, rm, sess)

	sess.Close()
	rm.Leave(sess)
	_ = c.Close(ws.StatusNormalClosure, "bye")
}

// resolveReason picks the authfail reason for a routing failure.
func resolveReason(err error) string {
	var r AuthFailReason
	if errors.As(err, &r) {
		return r.AuthFailReason()
	}
	return "world-unavailable"
}

// handshake reads the single `auth` frame and verifies its ticket offline. It
// returns the session and the verified payload; routing on the payload's world
// binding is the caller's job.
func (s *Server) handshake(ctx context.Context, c *ws.Conn, addr string) (*room.Session, *auth.Payload, error) {
	actx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	_, data, err := c.Read(actx)
	if err != nil {
		return nil, nil, err
	}
	var m struct {
		T      string `json:"t"`
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(data, &m); err != nil || m.T != "auth" {
		s.authFail(actx, c, "malformed")
		return nil, nil, errors.New("net: first frame was not auth")
	}
	payload, err := s.Verifier.Verify(m.Ticket, time.Now())
	if err != nil {
		s.authFail(actx, c, err.Error())
		return nil, nil, err
	}
	// Identity comes from the ticket, never from a client-sent field (§1). The
	// same goes for the world binding and the dev-tools claim: both ride in the
	// signed payload, so a client can neither pick its own world nor grant
	// itself the F9/F10 commands.
	sess := room.NewSession(room.NewSessionID(), payload.UserID, payload.Name, addr)
	sess.DevClaim = payload.Dev
	return sess, payload, nil
}

func (s *Server) authFail(ctx context.Context, c *ws.Conn, reason string) {
	b, _ := json.Marshal(map[string]any{"t": "authfail", "reason": reason})
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_ = c.Write(wctx, ws.MessageText, b)
}

// readLoop decodes frames and hands them to this connection's room — the one
// its ticket bound it to, fixed for the life of the socket. It never
// dereferences a player; the room resolves the session to its player itself.
func (s *Server) readLoop(ctx context.Context, c *ws.Conn, rm *room.Room, sess *room.Session) {
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != ws.MessageText {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal(data, &m); err != nil {
			continue // the legacy server silently ignores unparseable frames
		}
		select {
		case rm.Inbox() <- room.Inbound{S: sess, Data: m}:
		case <-sess.Closed():
			return
		case <-ctx.Done():
			return
		}
	}
}

// writeLoop drains the session's outbound queue. The room has already
// marshalled everything, so this goroutine only moves bytes.
func (s *Server) writeLoop(c *ws.Conn, sess *room.Session) {
	for {
		select {
		case <-sess.Closed():
			// Flush whatever the room queued immediately before closing — the
			// `kick` an evicted session is owed above all — so the client can
			// show an honest reason instead of an unexplained disconnect.
			for _, b := range sess.Drain() {
				wctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
				err := c.Write(wctx, ws.MessageText, b)
				cancel()
				if err != nil {
					break
				}
			}
			// Give the peer a moment to see the close frame.
			_ = c.Close(ws.StatusNormalClosure, "bye")
			return
		case b := <-sess.Out:
			wctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err := c.Write(wctx, ws.MessageText, b)
			cancel()
			if err != nil {
				sess.Close()
				return
			}
		}
	}
}

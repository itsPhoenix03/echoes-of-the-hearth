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
	// maxFrame is generous for a client frame (they are all tiny) while still
	// bounding what a hostile peer can make us buffer.
	maxFrame = 64 * 1024
)

// Server wires the HTTP listener to the room.
type Server struct {
	Room     *room.Room
	Verifier *auth.Verifier
	Logger   *log.Logger
	// WorldID, when non-empty, is checked against the ticket's worldId.
	WorldID string
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
	sess, err := s.handshake(ctx, c, r.RemoteAddr)
	if err != nil {
		// handshake already sent authfail where appropriate.
		_ = c.Close(ws.StatusPolicyViolation, "auth")
		return
	}

	if err := s.Room.Join(ctx, sess); err != nil {
		_ = c.Close(ws.StatusGoingAway, "shutting down")
		return
	}

	// One writer goroutine per connection, draining that connection's own
	// buffered channel. It never touches room state.
	go s.writeLoop(c, sess)

	s.readLoop(ctx, c, sess)

	sess.Close()
	s.Room.Leave(sess)
	_ = c.Close(ws.StatusNormalClosure, "bye")
}

// handshake reads the single `auth` frame and verifies its ticket offline.
func (s *Server) handshake(ctx context.Context, c *ws.Conn, addr string) (*room.Session, error) {
	actx, cancel := context.WithTimeout(ctx, authTimeout)
	defer cancel()

	_, data, err := c.Read(actx)
	if err != nil {
		return nil, err
	}
	var m struct {
		T      string `json:"t"`
		Ticket string `json:"ticket"`
	}
	if err := json.Unmarshal(data, &m); err != nil || m.T != "auth" {
		s.authFail(actx, c, "malformed")
		return nil, errors.New("net: first frame was not auth")
	}
	payload, err := s.Verifier.Verify(m.Ticket, time.Now())
	if err != nil {
		s.authFail(actx, c, err.Error())
		return nil, err
	}
	if s.WorldID != "" && payload.WorldID != s.WorldID {
		s.authFail(actx, c, "wrong-world")
		return nil, errors.New("net: ticket is for another world")
	}
	// Identity comes from the ticket, never from a client-sent field (§1).
	return room.NewSession(room.NewSessionID(), payload.UserID, payload.Name, addr), nil
}

func (s *Server) authFail(ctx context.Context, c *ws.Conn, reason string) {
	b, _ := json.Marshal(map[string]any{"t": "authfail", "reason": reason})
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_ = c.Write(wctx, ws.MessageText, b)
}

// readLoop decodes frames and hands them to the room. It never dereferences a
// player; the room resolves the session to its player itself.
func (s *Server) readLoop(ctx context.Context, c *ws.Conn, sess *room.Session) {
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
		case s.Room.Inbox() <- room.Inbound{S: sess, Data: m}:
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

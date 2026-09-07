// Package auth verifies the Ed25519 connection tickets minted by the Node
// control plane. See control/PROTOCOL.md §2 — verification is entirely offline:
// the public key is fetched once at boot (or supplied by env) and every ticket
// afterwards is checked locally, so Node being down never blocks a player.
package auth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Payload is the decoded ticket body. iat/exp are milliseconds since the Unix
// epoch (JS Date.now()), not seconds.
type Payload struct {
	UserID     string `json:"userId"`
	WorldID    string `json:"worldId"`
	InstanceID string `json:"instanceId"`
	Name       string `json:"name"`
	IAT        int64  `json:"iat"`
	Exp        int64  `json:"exp"`
	JTI        string `json:"jti"`
	// Dev is the optional dev-tools claim (docs/09 §7). A pointer so "the
	// control plane did not say" stays distinguishable from an explicit false;
	// Node does not mint this field yet, so today it is always nil and the game
	// server falls back to its HEARTH_DEV env var.
	Dev *bool `json:"dev"`
}

// Verifier holds the cached public key. It is immutable after construction and
// therefore safe to share across goroutines.
type Verifier struct {
	pub ed25519.PublicKey
}

// Errors returned by Verify. They double as the `reason` in `authfail`.
var (
	ErrMalformed = errors.New("malformed")
	ErrBadSig    = errors.New("bad-signature")
	ErrBadJSON   = errors.New("bad-json")
	ErrExpired   = errors.New("expired")
)

// NewVerifier wraps a raw 32-byte Ed25519 public key.
func NewVerifier(raw []byte) (*Verifier, error) {
	if len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("auth: public key is %d bytes, want %d", len(raw), ed25519.PublicKeySize)
	}
	return &Verifier{pub: ed25519.PublicKey(append([]byte(nil), raw...))}, nil
}

// NewVerifierFromBase64 decodes a standard-alphabet (not url-safe) base64 key,
// which is the form /api/pubkey and HEARTH_TICKET_PUBKEY both use.
func NewVerifierFromBase64(s string) (*Verifier, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, fmt.Errorf("auth: decode public key: %w", err)
	}
	return NewVerifier(raw)
}

// b64urlDecode restores the stripped '=' padding before decoding. The control
// plane strips padding entirely, so a plain RawURLEncoding decode would also
// work; restoring padding first accepts both forms.
func b64urlDecode(s string) ([]byte, error) {
	if pad := len(s) % 4; pad != 0 {
		s += strings.Repeat("=", 4-pad)
	}
	return base64.URLEncoding.DecodeString(s)
}

// Verify checks a ticket and returns its payload. Steps follow PROTOCOL.md §2
// exactly: split on the single '.', verify the signature over the ASCII bytes
// of the payload segment (NOT the decoded JSON), and only then parse and check
// expiry.
func (v *Verifier) Verify(ticket string, now time.Time) (*Payload, error) {
	payloadB64, sigB64, ok := strings.Cut(ticket, ".")
	if !ok || payloadB64 == "" || sigB64 == "" || strings.Contains(sigB64, ".") {
		return nil, ErrMalformed
	}
	sig, err := b64urlDecode(sigB64)
	if err != nil || len(sig) != ed25519.SignatureSize {
		return nil, ErrMalformed
	}
	if !ed25519.Verify(v.pub, []byte(payloadB64), sig) {
		return nil, ErrBadSig
	}
	rawJSON, err := b64urlDecode(payloadB64)
	if err != nil {
		return nil, ErrBadJSON
	}
	var p Payload
	if err := json.Unmarshal(rawJSON, &p); err != nil {
		return nil, ErrBadJSON
	}
	if p.Exp == 0 || now.UnixMilli() > p.Exp {
		return nil, ErrExpired
	}
	return &p, nil
}

// FetchPublicKey does the one boot-time GET against the control plane.
func FetchPublicKey(url string, timeout time.Duration) (string, error) {
	c := &http.Client{Timeout: timeout}
	resp, err := c.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("auth: %s returned %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4096))
	if err != nil {
		return "", err
	}
	var out struct {
		PublicKey string `json:"publicKey"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return "", fmt.Errorf("auth: %s returned unparseable JSON: %w", url, err)
	}
	if out.PublicKey == "" {
		return "", fmt.Errorf("auth: %s returned no publicKey", url)
	}
	return out.PublicKey, nil
}

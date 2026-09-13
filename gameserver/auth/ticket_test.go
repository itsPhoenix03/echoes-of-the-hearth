package auth

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

func b64url(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// issue mints a ticket the way control/ticket.js does: sign the ASCII bytes of
// the base64url payload segment, not the JSON.
func issue(t *testing.T, priv ed25519.PrivateKey, p Payload) string {
	t.Helper()
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	seg := b64url(raw)
	return seg + "." + b64url(ed25519.Sign(priv, []byte(seg)))
}

func keypair(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, priv
}

func livePayload() Payload {
	now := time.Now().UnixMilli()
	return Payload{
		UserID: "u_abc123", WorldID: "default", InstanceID: "local",
		Name: "Wanderer", IAT: now, Exp: now + 30_000, JTI: "jti-1",
	}
}

func TestVerifyValidTicket(t *testing.T) {
	pub, priv := keypair(t)
	v, err := NewVerifier(pub)
	if err != nil {
		t.Fatal(err)
	}
	got, err := v.Verify(issue(t, priv, livePayload()), time.Now())
	if err != nil {
		t.Fatalf("valid ticket rejected: %v", err)
	}
	if got.UserID != "u_abc123" || got.Name != "Wanderer" || got.WorldID != "default" {
		t.Fatalf("payload came back wrong: %+v", got)
	}
}

func TestVerifyExpiredTicket(t *testing.T) {
	pub, priv := keypair(t)
	v, _ := NewVerifier(pub)
	p := livePayload()
	p.IAT = time.Now().UnixMilli() - 60_000
	p.Exp = p.IAT + 30_000 // expired 30s ago
	if _, err := v.Verify(issue(t, priv, p), time.Now()); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired, got %v", err)
	}
	// Exactly at exp is still valid; one millisecond past is not.
	fresh := livePayload()
	tk := issue(t, priv, fresh)
	if _, err := v.Verify(tk, time.UnixMilli(fresh.Exp)); err != nil {
		t.Fatalf("ticket rejected at exp: %v", err)
	}
	if _, err := v.Verify(tk, time.UnixMilli(fresh.Exp+1)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired one ms past exp, got %v", err)
	}
}

func TestVerifyMissingExp(t *testing.T) {
	pub, priv := keypair(t)
	v, _ := NewVerifier(pub)
	p := livePayload()
	p.Exp = 0 // an unsigned-lifetime ticket must never be accepted
	if _, err := v.Verify(issue(t, priv, p), time.Now()); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired for a ticket with no exp, got %v", err)
	}
}

func TestVerifyTamperedTicket(t *testing.T) {
	pub, priv := keypair(t)
	v, _ := NewVerifier(pub)

	// Swap the payload for one claiming a different identity and a far exp,
	// keeping the original signature. This is the attack the signature exists
	// to stop.
	orig := issue(t, priv, livePayload())
	sig := orig[strings.Index(orig, ".")+1:]
	evil := livePayload()
	evil.UserID = "u_attacker"
	evil.Exp = time.Now().UnixMilli() + 86_400_000
	raw, _ := json.Marshal(evil)
	if _, err := v.Verify(b64url(raw)+"."+sig, time.Now()); !errors.Is(err, ErrBadSig) {
		t.Fatalf("expected ErrBadSig for a swapped payload, got %v", err)
	}

	// Flip a bit in the signature.
	sigBytes, _ := base64.RawURLEncoding.DecodeString(sig)
	sigBytes[0] ^= 0x01
	payloadSeg := orig[:strings.Index(orig, ".")]
	if _, err := v.Verify(payloadSeg+"."+b64url(sigBytes), time.Now()); !errors.Is(err, ErrBadSig) {
		t.Fatalf("expected ErrBadSig for a flipped signature bit, got %v", err)
	}

	// Malformed shapes.
	for _, bad := range []string{"", ".", "abc", payloadSeg, payloadSeg + "." + sig + "." + sig, payloadSeg + ".zz"} {
		if _, err := v.Verify(bad, time.Now()); err == nil {
			t.Fatalf("expected an error for malformed ticket %q", bad)
		}
	}
}

func TestVerifyWrongKey(t *testing.T) {
	_, priv := keypair(t)
	otherPub, _ := keypair(t)
	v, _ := NewVerifier(otherPub)
	if _, err := v.Verify(issue(t, priv, livePayload()), time.Now()); !errors.Is(err, ErrBadSig) {
		t.Fatalf("expected ErrBadSig when verifying against a different key, got %v", err)
	}
}

func TestNewVerifierRejectsWrongKeyLength(t *testing.T) {
	if _, err := NewVerifier(make([]byte, 31)); err == nil {
		t.Fatal("expected an error for a 31-byte key")
	}
	if _, err := NewVerifierFromBase64("not base64!!"); err == nil {
		t.Fatal("expected an error for undecodable base64")
	}
}

// TestVerifyNodeIssuedTicket is the cross-implementation check: this ticket was
// produced by control/ticket.js (issueTicket) under a pinned keypair. It proves
// the Go verifier agrees with the Node signer about what bytes are signed and
// how they are encoded. It is long expired, so verification is pinned to a
// timestamp inside its original window.
func TestVerifyNodeIssuedTicket(t *testing.T) {
	const (
		pubB64 = "f4b4ZOYeBkCoZ6TBzsDcRZ/lMDnbRPpzwMqePasjDs4="
		ticket = "eyJ1c2VySWQiOiJ1X2RlYWRiZWVmZGVhZGJlZWZkZWFkYmVlZiIsIndvcmxkSWQiOiJkZWZhdWx0IiwiaW5zdGFuY2VJZCI6ImxvY2FsIiwibmFtZSI6IldhbmRlcmVyIiwiaWF0IjoxNzg4NjkxMDQ2NDU3LCJleHAiOjE3ODg2OTEwNzY0NTcsImp0aSI6Im10cG9nc2hsLTEteWR2ZnY0In0.Y_BSLaEjnEsGlVqg8T2H9XdC9HfMJ4srzlt47TCR1egQIMLzIK_yFyObG2mu915jTR4Acmd3uirsAIGMsYpqCA"
		issued = 1788691046457
	)
	v, err := NewVerifierFromBase64(pubB64)
	if err != nil {
		t.Fatal(err)
	}
	p, err := v.Verify(ticket, time.UnixMilli(issued+1000))
	if err != nil {
		t.Fatalf("Node-issued ticket rejected: %v", err)
	}
	if p.UserID != "u_deadbeefdeadbeefdeadbeef" || p.Name != "Wanderer" || p.Exp != issued+30_000 {
		t.Fatalf("payload mismatch: %+v", p)
	}
	// Same ticket, past its 30s TTL.
	if _, err := v.Verify(ticket, time.UnixMilli(issued+31_000)); !errors.Is(err, ErrExpired) {
		t.Fatalf("expected ErrExpired past the TTL, got %v", err)
	}
}

// --- the optional `dev` claim (control/PROTOCOL.md §2, docs/10 §10.6) --------

// issueRaw signs an arbitrary payload object, so a test can mint a ticket whose
// JSON genuinely lacks the `dev` key rather than carrying an explicit null.
func issueRaw(t *testing.T, priv ed25519.PrivateKey, obj map[string]any) string {
	t.Helper()
	raw, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	seg := b64url(raw)
	return seg + "." + b64url(ed25519.Sign(priv, []byte(seg)))
}

func basePayloadMap() map[string]any {
	now := time.Now().UnixMilli()
	return map[string]any{
		"userId": "u_abc123", "worldId": "default", "instanceId": "local",
		"name": "Wanderer", "iat": now, "exp": now + 30_000, "jti": "jti-1",
	}
}

func TestVerifyDevClaim(t *testing.T) {
	pub, priv := keypair(t)
	v, err := NewVerifier(pub)
	if err != nil {
		t.Fatal(err)
	}
	yes, no := true, false
	cases := []struct {
		name string
		obj  map[string]any
		want *bool
	}{
		{"present-true", map[string]any{"dev": true}, &yes},
		{"present-false", map[string]any{"dev": false}, &no},
		{"absent", nil, nil},
		{"explicit-null", map[string]any{"dev": nil}, nil},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			obj := basePayloadMap()
			for k, val := range tc.obj {
				obj[k] = val
			}
			got, err := v.Verify(issueRaw(t, priv, obj), time.Now())
			if err != nil {
				t.Fatalf("ticket rejected: %v", err)
			}
			switch {
			case tc.want == nil && got.Dev != nil:
				t.Fatalf("Dev = %v, want nil (no claim)", *got.Dev)
			case tc.want != nil && got.Dev == nil:
				t.Fatalf("Dev = nil, want %v", *tc.want)
			case tc.want != nil && *got.Dev != *tc.want:
				t.Fatalf("Dev = %v, want %v", *got.Dev, *tc.want)
			}
		})
	}
}

// A non-boolean `dev` must not be silently coerced into a claim: the ticket is
// rejected as bad JSON rather than yielding a spurious true.
func TestVerifyDevClaimWrongType(t *testing.T) {
	pub, priv := keypair(t)
	v, err := NewVerifier(pub)
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []any{"true", 1, map[string]any{}} {
		obj := basePayloadMap()
		obj["dev"] = bad
		if _, err := v.Verify(issueRaw(t, priv, obj), time.Now()); !errors.Is(err, ErrBadJSON) {
			t.Fatalf("dev=%v (%T): err = %v, want ErrBadJSON", bad, bad, err)
		}
	}
}

// A nil claim must stay off the wire when a Payload round-trips through JSON,
// so re-marshalling can never manufacture one.
func TestPayloadOmitsAbsentDev(t *testing.T) {
	raw, err := json.Marshal(livePayload())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), "dev") {
		t.Fatalf("marshalled payload mentions dev: %s", raw)
	}
}

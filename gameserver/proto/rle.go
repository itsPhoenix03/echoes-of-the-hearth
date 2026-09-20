// Package proto holds the wire types shared by the network layer and the room:
// message envelopes and the chunk-layer RLE codec described in
// docs/10_GO_WIRE_PROTOCOL.md §4.3.
package proto

import (
	"encoding/base64"
	"errors"
	"fmt"
)

// ChunkSize is the edge length of a terrain chunk in tiles (§4).
const ChunkSize = 64

// ChunkTiles is the number of tiles in one chunk, i.e. the exact decoded length
// of every RLE layer payload.
const ChunkTiles = ChunkSize * ChunkSize // 4096

// ChunkRadius is the Chebyshev radius, in chunks, of the push window (§4.1).
const ChunkRadius = 2

// EncodeRLE encodes a layer as a sequence of 2-byte runs (value, length 1..255)
// and returns the standard-alphabet, padded base64 of that byte sequence.
//
// A run longer than 255 is split into consecutive runs of the same value, the
// first being 255 — exactly as the spec's "a run of 300 becomes 255 then 45".
func EncodeRLE(layer []byte) string {
	if len(layer) == 0 {
		return ""
	}
	// Worst case is one run per byte; typical terrain is a few dozen runs.
	out := make([]byte, 0, 64)
	val := layer[0]
	run := 1
	flush := func() {
		for run > 0 {
			n := run
			if n > 255 {
				n = 255
			}
			out = append(out, val, byte(n))
			run -= n
		}
	}
	for _, b := range layer[1:] {
		if b == val && run < 1<<30 {
			run++
			continue
		}
		flush()
		val = b
		run = 1
	}
	flush()
	return base64.StdEncoding.EncodeToString(out)
}

// ErrBadLength reports a payload that did not decode to the expected size.
var ErrBadLength = errors.New("proto: RLE payload decoded to the wrong length")

// DecodeRLE reverses EncodeRLE and asserts the result is exactly want bytes.
// The spec requires a decoder that produces a different length to treat the
// chunk as corrupt rather than render garbage, so this returns an error.
func DecodeRLE(s string, want int) ([]byte, error) {
	raw, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("proto: base64: %w", err)
	}
	if len(raw)%2 != 0 {
		return nil, fmt.Errorf("proto: odd RLE byte count %d", len(raw))
	}
	out := make([]byte, 0, want)
	for i := 0; i < len(raw); i += 2 {
		n := int(raw[i+1])
		if n == 0 {
			return nil, errors.New("proto: zero-length RLE run")
		}
		if len(out)+n > want {
			return nil, ErrBadLength
		}
		for j := 0; j < n; j++ {
			out = append(out, raw[i])
		}
	}
	if len(out) != want {
		return nil, ErrBadLength
	}
	return out, nil
}

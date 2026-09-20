// Package world is a bit-exact Go port of shared/world.js.
//
// Every value that is a JavaScript Number in the original is a float64 here.
// Conversions to integers happen only where the JS does them explicitly
// (`| 0`, `>>> 0`, `~~`, `Math.floor`) and are implemented with the matching
// ECMAScript semantics below.
package world

import (
	"math"
	"unicode/utf16"
)

const two32 = 4294967296.0
const two31 = 2147483648.0

// toUint32 mirrors the ECMAScript ToUint32 abstract operation (`x >>> 0`).
// It truncates toward zero and then wraps modulo 2^32.
func toUint32(x float64) float64 {
	if math.IsNaN(x) || math.IsInf(x, 0) {
		return 0
	}
	m := math.Mod(math.Trunc(x), two32)
	if m < 0 {
		m += two32
	}
	return m
}

// toInt32 mirrors the ECMAScript ToInt32 abstract operation (`x | 0`).
// NOTE: this is truncation toward zero, *not* Math.floor — they differ for
// negative operands.
func toInt32(x float64) float64 {
	m := toUint32(x)
	if m >= two31 {
		m -= two32
	}
	return m
}

// charCodes returns the UTF-16 code units of s, matching String#charCodeAt.
func charCodes(s string) []uint16 {
	return utf16.Encode([]rune(s))
}

// jsHypot reproduces V8's Math.hypot (builtins/math.tq): the arguments are
// normalised by the largest magnitude and summed with Kahan compensation.
// This is deliberately NOT math.Hypot nor sqrt(x*x+y*y) — those disagree with
// V8 in the last ulp for some inputs, and the world generator compares the
// result against hard thresholds.
//
// The float64(...) conversions pin each intermediate rounding so the Go
// compiler may not contract the expressions into FMAs.
func jsHypot(vals ...float64) float64 {
	oneArgIsNaN := false
	max := 0.0
	abs := make([]float64, len(vals))
	for i, v := range vals {
		if math.IsNaN(v) {
			oneArgIsNaN = true
			continue
		}
		a := math.Abs(v)
		abs[i] = a
		if a > max {
			max = a
		}
	}
	if math.IsInf(max, 1) {
		return math.Inf(1)
	}
	if oneArgIsNaN {
		return math.NaN()
	}
	if max == 0 {
		return 0
	}
	sum := 0.0
	compensation := 0.0
	for _, a := range abs {
		n := a / max
		summand := float64(n*n) - compensation
		preliminary := sum + summand
		compensation = float64(preliminary-sum) - summand
		sum = preliminary
	}
	return math.Sqrt(sum) * max
}

// jsRound mirrors Math.round (round half toward +Infinity).
func jsRound(x float64) float64 {
	return math.Floor(x + 0.5)
}

package room

import (
	"math"
	"strconv"
	"strings"
)

// The pos handler is a faithful port of an untrusted-input path written in
// JavaScript, so the coercions it relies on (Number(), |0) have to behave the
// same way here. Inbound frames are decoded into map[string]any precisely so
// that "field absent" and "field is a string" stay distinguishable, exactly as
// undefined and "abc" are on the JS side.

// jsNumber mimics JS Number(v). A missing key must be passed as (nil, false),
// which yields NaN — Number(undefined).
func jsNumber(v any, present bool) float64 {
	if !present {
		return math.NaN() // Number(undefined)
	}
	switch t := v.(type) {
	case nil:
		return 0 // Number(null) === 0
	case float64:
		return t
	case bool:
		if t {
			return 1
		}
		return 0
	case string:
		s := strings.TrimSpace(t)
		if s == "" {
			return 0 // Number("") === 0
		}
		f, err := strconv.ParseFloat(s, 64)
		if err != nil {
			return math.NaN()
		}
		return f
	default:
		return math.NaN() // objects and arrays
	}
}

// getNum reads a field with JS Number() semantics.
func getNum(m map[string]any, key string) float64 {
	v, ok := m[key]
	return jsNumber(v, ok)
}

// has reports whether the key is present, i.e. not `undefined` in JS terms.
func has(m map[string]any, key string) bool {
	_, ok := m[key]
	return ok
}

// toInt32 mimics the JS `x | 0` operator: NaN and infinities become 0, and the
// value is truncated toward zero then wrapped to 32 bits.
func toInt32(f float64) int {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	t := math.Trunc(f)
	m := math.Mod(t, 4294967296)
	if m < 0 {
		m += 4294967296
	}
	if m >= 2147483648 {
		m -= 4294967296
	}
	return int(m)
}

// getInt32 reads a field with JS `Number(v) | 0` semantics.
func getInt32(m map[string]any, key string) int {
	return toInt32(getNum(m, key))
}

// getString reads a field with JS String(v) semantics limited to actual
// strings; anything else yields "".
func getString(m map[string]any, key string) string {
	if s, ok := m[key].(string); ok {
		return s
	}
	return ""
}

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

// itoa is strconv.Itoa under a shorter name, used to build creature and animal
// ids ("c" + n) the way the legacy server does.
func itoa(n int) string { return strconv.Itoa(n) }

// toFixed mirrors JS `+v.toFixed(n)`: format to n decimal places, then read the
// result back as a number. The legacy server rounds creature positions this way
// before putting them on the wire, and the client's lerp assumes that
// precision, so the rounding happens here rather than being left to the JSON
// encoder.
func toFixed(v float64, n int) float64 {
	if math.IsNaN(v) || math.IsInf(v, 0) {
		return 0
	}
	f, err := strconv.ParseFloat(strconv.FormatFloat(v, 'f', n, 64), 64)
	if err != nil {
		return v
	}
	return f
}

// statInt is the wire rounding for hunger and thirst. The simulation carries
// both as fractions (survivalTick drains 0.055/0.083 per 5 s block), but the
// wire contract is integral: server/index.js puts `Math.ceil(p.hunger)` on
// every `stat` frame, so a bar only reads empty once the value has actually
// reached 0 and 0.001 still shows as 1. Every frame that carries these values —
// `init` included — goes through here so the two servers agree.
func statInt(v float64) int {
	if math.IsNaN(v) {
		return 0
	}
	return int(math.Ceil(v))
}

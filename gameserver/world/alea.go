package world

// Port of alea@1.0.1 (node_modules/alea/alea.js), the Johannes Baagoe PRNG.
// Transcribed literally; every variable is a float64 because every variable in
// the original is a JS Number.

const inv2p32 = 2.3283064365386963e-10 // 2^-32

// mash is the `Mash()` closure from alea.js. Its single piece of state, n,
// starts at 0xefc8249d and is carried across calls — the three `mash(' ')`
// seeding calls therefore affect every later call.
type mash struct {
	n float64
}

func newMash() *mash { return &mash{n: 0xefc8249d} }

func (m *mash) hash(data string) float64 {
	for _, code := range charCodes(data) {
		m.n += float64(code)
		h := 0.02519603282416938 * m.n
		m.n = toUint32(h)
		h -= m.n
		h *= m.n
		m.n = toUint32(h)
		h -= m.n
		m.n += h * two32
	}
	return toUint32(m.n) * inv2p32
}

// Alea is the generator returned by `alea(...args)`.
type Alea struct {
	s0, s1, s2, c float64
}

// NewAlea mirrors `alea(args...)`. The JS constructor seeds with three
// mash(' ') calls before folding in the arguments.
func NewAlea(args ...string) *Alea {
	a := &Alea{c: 1}
	m := newMash()
	a.s0 = m.hash(" ")
	a.s1 = m.hash(" ")
	a.s2 = m.hash(" ")
	for _, arg := range args {
		a.s0 -= m.hash(arg)
		if a.s0 < 0 {
			a.s0 += 1
		}
		a.s1 -= m.hash(arg)
		if a.s1 < 0 {
			a.s1 += 1
		}
		a.s2 -= m.hash(arg)
		if a.s2 < 0 {
			a.s2 += 1
		}
	}
	return a
}

// Next is `random()`: t = 2091639 * s0 + c * 2^-32; c = t | 0; s2 = t - c.
func (a *Alea) Next() float64 {
	t := float64(2091639*a.s0) + float64(a.c*inv2p32)
	a.s0 = a.s1
	a.s1 = a.s2
	a.c = toInt32(t)
	a.s2 = t - a.c
	return a.s2
}

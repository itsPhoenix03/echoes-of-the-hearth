package world

import "math"

// Port of simplex-noise@4.0.3 createNoise2D / buildPermutationTable
// (node_modules/simplex-noise/dist/cjs/simplex-noise.js). Transcribed
// literally, including the gradient table layout and the perm/permGrad
// precomputation, so the output matches value-for-value.

var (
	sqrt3 = math.Sqrt(3.0)
	f2    = 0.5 * (sqrt3 - 1.0)
	g2    = (3.0 - sqrt3) / 6.0
)

var grad2 = [24]float64{
	1, 1,
	-1, 1,
	1, -1,
	-1, -1,
	1, 0,
	-1, 0,
	1, 0,
	-1, 0,
	0, 1,
	0, -1,
	0, 1,
	0, -1,
}

// fastFloor is `Math.floor(x) | 0`.
func fastFloor(x float64) int32 {
	return int32(toInt32(math.Floor(x)))
}

// buildPermutationTable is the JS function of the same name. p is a Uint8Array
// of 512 entries; the Fisher-Yates pass uses `~~(random() * (256 - i))`, i.e.
// truncation toward zero.
func buildPermutationTable(random *Alea) [512]uint8 {
	const tableSize = 512
	var p [tableSize]uint8
	for i := 0; i < tableSize/2; i++ {
		p[i] = uint8(i)
	}
	for i := 0; i < tableSize/2-1; i++ {
		r := i + int(toInt32(math.Trunc(random.Next()*float64(256-i))))
		aux := p[i]
		p[i] = p[r]
		p[r] = aux
	}
	for i := 256; i < tableSize; i++ {
		p[i] = p[i-256]
	}
	return p
}

// Noise2D is the closure returned by createNoise2D.
type Noise2D struct {
	perm       [512]uint8
	permGrad2x [512]float64
	permGrad2y [512]float64
}

// NewNoise2D is createNoise2D(random).
func NewNoise2D(random *Alea) *Noise2D {
	n := &Noise2D{perm: buildPermutationTable(random)}
	for i, v := range n.perm {
		n.permGrad2x[i] = grad2[(int(v)%12)*2]
		n.permGrad2y[i] = grad2[(int(v)%12)*2+1]
	}
	return n
}

// Eval is noise2D(x, y). The float64(...) conversions pin intermediate
// roundings so the Go compiler cannot contract multiply-adds into FMAs, which
// would diverge from JS.
func (nz *Noise2D) Eval(x, y float64) float64 {
	n0, n1, n2 := 0.0, 0.0, 0.0
	s := (x + y) * f2
	i := fastFloor(x + s)
	j := fastFloor(y + s)
	t := float64(i+j) * g2
	x0 := x - (float64(i) - t)
	y0 := y - (float64(j) - t)

	var i1, j1 int32
	if x0 > y0 {
		i1, j1 = 1, 0
	} else {
		i1, j1 = 0, 1
	}

	x1 := x0 - float64(i1) + g2
	y1 := y0 - float64(j1) + g2
	x2 := x0 - 1.0 + 2.0*g2
	y2 := y0 - 1.0 + 2.0*g2

	ii := i & 255
	jj := j & 255

	t0 := 0.5 - float64(x0*x0) - float64(y0*y0)
	if t0 >= 0 {
		gi0 := ii + int32(nz.perm[jj])
		g0x := nz.permGrad2x[gi0]
		g0y := nz.permGrad2y[gi0]
		t0 *= t0
		n0 = t0 * t0 * (float64(g0x*x0) + float64(g0y*y0))
	}
	t1 := 0.5 - float64(x1*x1) - float64(y1*y1)
	if t1 >= 0 {
		gi1 := ii + i1 + int32(nz.perm[jj+j1])
		g1x := nz.permGrad2x[gi1]
		g1y := nz.permGrad2y[gi1]
		t1 *= t1
		n1 = t1 * t1 * (float64(g1x*x1) + float64(g1y*y1))
	}
	t2 := 0.5 - float64(x2*x2) - float64(y2*y2)
	if t2 >= 0 {
		gi2 := ii + 1 + int32(nz.perm[jj+1])
		g2x := nz.permGrad2x[gi2]
		g2y := nz.permGrad2y[gi2]
		t2 *= t2
		n2 = t2 * t2 * (float64(g2x*x2) + float64(g2y*y2))
	}
	return 70.0 * (n0 + n1 + n2)
}

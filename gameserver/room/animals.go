package room

import (
	"math"
	"math/rand"

	"hearth/gameserver/world"
)

// Slice 3: huntable wildlife. One species pair per biome, spawned biased toward
// players so wildlife is actually encountered, fleeing on sight, dropping meat
// by size when killed.
//
// This is a port of ANIMAL_TYPES and the wildlife block of the legacy sim tick.

// aniType is one ANIMAL_TYPES row:
// [home tile, island x0, y0, hp, meat, flee radius, flee speed].
type aniType struct {
	home   uint8
	qx, qy int
	hp     int
	meat   int
	fleeR  float64
	fleeSp float64
}

// animalOrder is Object.keys(ANIMAL_TYPES) — JS object key order is the literal
// order in server/index.js, and the spawn roll indexes into it, so the order is
// load-bearing and must not be sorted.
var animalOrder = [7]string{"deer", "boar", "lizard", "crab", "fox", "hare", "toad"}

// animalTypes is ANIMAL_TYPES verbatim. The island origin is ISLES[n] - 35,
// i.e. the top-left of a 60x60 box the fallback spawn samples.
var animalTypes = map[string]aniType{
	"deer":   {world.TGrass, world.ISLES[0][0] - 35, world.ISLES[0][1] - 35, 2, 2, 4, 0.42},
	"boar":   {world.TGrass, world.ISLES[0][0] - 35, world.ISLES[0][1] - 35, 4, 3, 3, 0.3},
	"lizard": {world.TSand, world.ISLES[1][0] - 35, world.ISLES[1][1] - 35, 2, 1, 4, 0.5},
	"crab":   {world.TSand, world.ISLES[1][0] - 35, world.ISLES[1][1] - 35, 1, 1, 5, 0.35},
	"fox":    {world.TSnow, world.ISLES[2][0] - 35, world.ISLES[2][1] - 35, 2, 2, 6, 0.42},
	"hare":   {world.TSnow, world.ISLES[2][0] - 35, world.ISLES[2][1] - 35, 1, 1, 7, 0.55},
	"toad":   {world.TMud, world.ISLES[3][0] - 35, world.ISLES[3][1] - 35, 2, 1, 2.5, 0.25},
}

// Animal is one live wild animal.
type Animal struct {
	ID     string
	X, Y   float64
	HP     int
	DX, DY float64
	TW     float64
	Type   string
	Home   uint8
}

func (r *Room) addAnimal(a *Animal) {
	r.animals[a.ID] = a
	r.aniOrder = append(r.aniOrder, a)
}

func (r *Room) delAnimal(id string) {
	a, ok := r.animals[id]
	if !ok {
		return
	}
	delete(r.animals, id)
	for i, o := range r.aniOrder {
		if o == a {
			r.aniOrder = append(r.aniOrder[:i], r.aniOrder[i+1:]...)
			break
		}
	}
}

// animalSpawnTick is the legacy wildlife spawn block: up to three placement
// attempts every fifth tick while the population is under 20, stopping at the
// first success.
func (r *Room) animalSpawnTick() {
	if len(r.animals) >= 20 || r.tickN%5 != 0 || len(r.players) == 0 {
		return
	}
	for n := 0; n < 3; n++ {
		typ := animalOrder[rand.Intn(len(animalOrder))]
		at := animalTypes[typ]
		var x, y float64
		if rand.Float64() < 0.6 {
			// biased near a player. players is walked in join order via
			// playerOrder so the pick is reproducible.
			if len(r.playerOrder) == 0 {
				return
			}
			q := r.playerOrder[rand.Intn(len(r.playerOrder))]
			x = math.Round(q.X + (rand.Float64()-0.5)*36)
			y = math.Round(q.Y + (rand.Float64()-0.5)*36)
			if math.Hypot(x-q.X, y-q.Y) < 7 {
				continue // not on top of the player
			}
		} else {
			x = float64(at.qx) + math.Trunc(rand.Float64()*60)
			y = float64(at.qy) + math.Trunc(rand.Float64()*60)
		}
		if x < 0 || y < 0 || x >= world.SIZE || y >= world.SIZE {
			continue
		}
		i := ti(x, y)
		_, isNode := r.world.Nodes[i]
		_, isStruct := r.structures[i]
		if r.world.Tiles[i] == at.home && !isNode && !isStruct {
			r.nextAni++
			r.addAnimal(&Animal{
				ID: "a" + itoa(r.nextAni), X: x, Y: y, HP: at.hp,
				Type: typ, Home: at.home,
			})
			break
		}
	}
}

// animalTick is the legacy wildlife movement pass: flee from the first player
// inside the species' flee radius, otherwise wander, and bounce off anything
// that is not the species' home tile.
func (r *Room) animalTick() {
	for _, a := range r.aniOrder {
		at := animalTypes[a.Type]
		fleeing := false
		// playerOrder, not the map: the legacy loop breaks on the FIRST player
		// inside the radius, so which one it is decides the flee direction.
		for _, q := range r.playerOrder {
			d := math.Hypot(q.X-a.X, q.Y-a.Y)
			if d < at.fleeR && d > 0.1 {
				a.DX, a.DY = (a.X-q.X)/d, (a.Y-q.Y)/d
				fleeing = true
				break
			}
		}
		// `!fleeing && --a.tw <= 0` short-circuits: a fleeing animal does not
		// burn its wander timer, so it resumes the same heading afterwards.
		if !fleeing {
			a.TW--
		}
		if !fleeing && a.TW <= 0 {
			a.TW = 10 + rand.Float64()*25
			if rand.Float64() < 0.4 {
				a.DX, a.DY = 0, 0
			} else {
				ang := rand.Float64() * math.Pi * 2
				a.DX, a.DY = math.Cos(ang), math.Sin(ang)
			}
		}
		sp := 0.1
		if fleeing {
			sp = at.fleeSp
		}
		nx, ny := a.X+a.DX*sp, a.Y+a.DY*sp
		if !r.blockedTile(nx, ny) && r.tileAtXY(nx, ny) == a.Home {
			a.X, a.Y = nx, ny
		} else {
			a.DX, a.DY = -a.DX, -a.DY
		}
	}
}

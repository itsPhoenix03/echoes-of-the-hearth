package room

import (
	"fmt"
	"math"

	"hearth/gameserver/world"
)

// Slice 3: the player's half of combat — what a landed swing does to a creature
// or an animal. handleAtk in actions.go picks the target; everything that
// follows from the hit lives here.
//
// The knockback angle `ang` points AWAY from the attacker, so the client can
// shove the sprite in the right direction. It is computed once and reused for
// the wisp's flee heading (which is `ang + PI`, i.e. away from the player).

// hitAnimal resolves a swing that landed on wildlife: either it dies and drops
// meat, or it survives, takes the same knockback a creature does and keeps
// fleeing.
//
// The legacy handler shares one code path for animals and creatures, so it also
// writes `best.stun = 3` on a surviving animal. Nothing in the wildlife AI ever
// reads that field, so this port does not carry it — the observable behaviour is
// identical.
func (r *Room) hitAnimal(p *Player, a *Animal, dmg int, seq any) {
	atkAng := math.Atan2(a.Y-p.Y, a.X-p.X)
	a.HP -= dmg
	if a.HP > 0 {
		// animals are light, so they take the 0.9 knockback. Note the landing
		// tile is only checked for water and structures, not for the species'
		// home tile — an animal shoved off its biome walks back under its own
		// bounce rule.
		knx := a.X + math.Cos(atkAng)*0.9
		kny := a.Y + math.Sin(atkAng)*0.9
		kni := ti(knx, kny)
		_, occupied := r.structures[kni]
		if inBounds(kni) && r.world.Tiles[kni] != world.TWater && !occupied {
			a.X, a.Y = knx, kny
		}
		r.broadcast(map[string]any{"t": "chit", "id": a.ID, "ang": atkAng, "by": p.S.ID, "seq": seq})
		return
	}
	r.delAnimal(a.ID)
	// meat by size, plus a 40% bonus cut
	drop := animalTypes[a.Type].meat
	if chance(0.4) {
		drop++
	}
	p.Inv["meat"] += drop
	r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("+%d Raw Meat — cook it at a campfire", drop)})
	r.sendInv(p)
}

// hitCreature resolves a swing that landed on a monster.
func (r *Room) hitCreature(p *Player, c *Creature, dmg int, seq any, now int64) {
	atkAng := math.Atan2(c.Y-p.Y, c.X-p.X)
	c.HP -= dmg
	if c.HP > 0 {
		r.creatureSurvived(p, c, atkAng, seq, now)
		return
	}
	r.creatureDied(p, c, now)
}

// creatureDied applies the on-death effects: corruption, the essence or meat
// drop, and the pack enrage.
func (r *Room) creatureDied(p *Player, c *Creature, now int64) {
	// wisp / frost_wraith on death: corrupt the tile they fell on
	if c.Type == "wisp" || c.Type == "frost_wraith" {
		di := ti(c.X, c.Y)
		if inBounds(di) && r.world.Tiles[di] != world.TWater && !r.isInfected(di) {
			r.setInfected(di, now+120000)
			r.broadcast(map[string]any{"t": "infect", "tiles": []int{di}})
		}
	}
	// bog_shambler on death: corrupt its own tile plus the four orthogonals
	if c.Type == "bog_shambler" {
		bsx, bsy := math.Trunc(c.X), math.Trunc(c.Y)
		var corrupted []int
		for _, d := range [5][2]float64{{0, 0}, {1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			ci := ti(bsx+d[0], bsy+d[1])
			if inBounds(ci) && r.world.Tiles[ci] != world.TWater && !r.isInfected(ci) {
				r.setInfected(ci, now+120000)
				corrupted = append(corrupted, ci)
			}
		}
		if len(corrupted) > 0 {
			r.broadcast(map[string]any{"t": "infect", "tiles": corrupted})
		}
	}
	r.delCreature(c.ID)

	if c.Type == "husk_wolf" {
		// wolves are meat, not essence
		p.Inv["meat"]++
		r.send(p, map[string]any{"t": "msg", "s": "+1 Raw Meat"})
	} else {
		drop := 1
		switch c.Type {
		case "brute", "bog_shambler":
			drop = 4
		case "wisp", "frost_wraith":
			drop = 3
		}
		if chance(0.4) {
			drop++
		}
		p.Inv["essence"] += drop
		r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("+%d Blight Essence", drop)})
	}
	r.packEnrage(c)
	r.sendInv(p)
}

// creatureSurvived applies knockback, the stun, the wisp flee-and-corrupt
// reaction and the pack enrage, then correlates the hit back to the swing.
func (r *Room) creatureSurvived(p *Player, c *Creature, atkAng float64, seq any, now int64) {
	// knockback: heavies barely budge
	kb := 0.9
	if c.Type == "brute" || c.Type == "bog_shambler" {
		kb = 0.3
	}
	knx := c.X + math.Cos(atkAng)*kb
	kny := c.Y + math.Sin(atkAng)*kb
	kni := ti(knx, kny)
	_, occupied := r.structures[kni]
	if inBounds(kni) && r.world.Tiles[kni] != world.TWater && !occupied {
		c.X, c.Y = knx, kny
	}
	c.Stun = 3

	// wisp / frost_wraith on hit: flee away from the attacker and corrupt where
	// they stood
	if c.Type == "wisp" || c.Type == "frost_wraith" {
		c.FleeTk = 10
		c.FleeAng = atkAng + math.Pi
		fi := ti(c.X, c.Y)
		if inBounds(fi) && r.world.Tiles[fi] != world.TWater && !r.isInfected(fi) {
			r.setInfected(fi, now+120000)
			r.broadcast(map[string]any{"t": "infect", "tiles": []int{fi}})
		}
	}
	r.packEnrage(c)
	r.broadcast(map[string]any{"t": "chit", "id": c.ID, "ang": atkAng, "by": p.S.ID, "seq": seq})
}

// packEnrage is the legacy pack-enrage reaction: striking a crawler or a husk
// wolf enrages every crawler and wolf within 10 tiles for 100 ticks. It fires on
// both a killing blow and a survived hit.
func (r *Room) packEnrage(c *Creature) {
	if c.Type != "crawler" && c.Type != "husk_wolf" {
		return
	}
	for _, ec := range r.creOrder {
		if ec.Type != "crawler" && ec.Type != "husk_wolf" {
			continue
		}
		if math.Hypot(ec.X-c.X, ec.Y-c.Y) <= 10 {
			ec.Enraged = 100
		}
	}
}

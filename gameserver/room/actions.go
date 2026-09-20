package room

import (
	"fmt"
	"math"
	"math/rand"
	"sort"
	"strings"

	"hearth/gameserver/world"
)

// This file is the Slice 2 port of server/index.js: resource gathering,
// crafting, construction, farming, chests and the structure-damage half of
// `atk`. Every handler is a line-by-line port — the validation order, the
// cooldown constants and the message shapes all match the legacy server,
// because test.mjs asserts against that behaviour and the client already
// speaks it.
//
// Creature and animal combat is Slice 3. Where the legacy handler scans them,
// this port keeps the surrounding structure intact and notes the omission
// rather than restructuring the handler around it.

// --- gather ---------------------------------------------------------------

func (r *Room) handleGather(p *Player, m map[string]any) {
	now := r.now()
	seq := validSeq(m)
	if now-p.LastGather < 250 {
		r.reject(p, seq, "rate_limit")
		return
	}
	p.LastGather = now
	i, ok := tileIndex(m, "i")
	if !ok {
		r.reject(p, seq, "invalid_target")
		return
	}
	kindByte, isNode := r.world.Nodes[i]
	if !isNode || r.removedAt(i) {
		r.reject(p, seq, "invalid_target")
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 2.5 {
		r.reject(p, seq, "out_of_range")
		return
	}
	kind := int(kindByte)
	def, okDef := r.defs.NodeDefFor(kind)
	if !okDef {
		r.reject(p, seq, "invalid_target")
		return
	}
	reqTool, needsTool := def.ToolName()
	if needsTool && reqTool == "pick" && !p.Tools["pick"] && !p.Tools["spick"] {
		r.send(p, map[string]any{"t": "msg", "s": "You need a Pickaxe for this."})
		r.reject(p, seq, "no_tool")
		return
	}
	if needsTool && reqTool == "spick" && !p.Tools["spick"] {
		r.send(p, map[string]any{"t": "msg", "s": "You need a Stone Pickaxe for this."})
		r.reject(p, seq, "no_tool")
		return
	}
	dmg := 1
	if def.AxeBonus && p.Tools["axe"] {
		dmg = 3
	}
	if needsTool && reqTool == "pick" && p.Tools["spick"] {
		dmg = 2
	}
	// The clip and tool are derived from the authoritative node kind and the
	// tools the player actually owns — never from the client's claim.
	var actA string
	var actTool any
	switch {
	case kind == int(world.NodeTree):
		if p.Tools["axe"] {
			actTool, actA = "axe", "chop"
		} else {
			actTool, actA = nil, "punch"
		}
	case needsTool:
		if p.Tools["spick"] {
			actTool = "spick"
		} else {
			actTool = reqTool
		}
		actA = "mine"
	default:
		actTool, actA = nil, "punch"
	}
	r.broadcast(map[string]any{
		"t": "act", "id": p.S.ID, "seq": seq, "a": actA, "tool": actTool,
		"dx": clampDir(m, "dx"), "dy": clampDir(m, "dy"), "targetI": i,
	})

	hp := def.HP
	if cur, damaged := r.nodeHP[i]; damaged {
		hp = cur
	}
	hp -= dmg
	if hp > 0 {
		r.nodeHP[i] = hp
		r.broadcast(map[string]any{"t": "node", "i": i, "hp": hp, "by": p.S.ID, "seq": seq})
		return
	}
	delete(r.nodeHP, i)
	r.removed[i] = now + int64(def.Respawn)*1000
	p.Inv[def.Res] += def.N
	r.broadcast(map[string]any{"t": "node", "i": i, "hp": 0, "by": p.S.ID, "seq": seq})
	r.sendInv(p)

	if kind == int(world.NodeTree) {
		r.chopEcosystem(int(x), int(y))
	}
}

// removedAt reports whether a node is currently harvested (awaiting respawn).
func (r *Room) removedAt(i int) bool { _, ok := r.removed[i]; return ok }

// chopEcosystem is the legacy tree reaction: every 8th tree felled in a 16x16
// sector turns a few grass tiles to mud.
func (r *Room) chopEcosystem(x, y int) {
	sk := ((x >> 4) << 8) | (y >> 4)
	r.sectorChops[sk]++
	if r.sectorChops[sk]%8 != 0 {
		return
	}
	var newMud []int
	bx, by := (x>>4)<<4, (y>>4)<<4
	for n := 0; n < 40 && len(newMud) < 14; n++ {
		mi := ti(float64(bx)+rand.Float64()*16, float64(by)+rand.Float64()*16)
		if r.tileAt(mi) == world.TGrass && !r.mudTiles[mi] {
			if _, isNode := r.world.Nodes[mi]; !isNode {
				r.mudTiles[mi] = true
				newMud = append(newMud, mi)
			}
		}
	}
	if len(newMud) > 0 {
		r.broadcast(map[string]any{"t": "mud", "tiles": newMud})
	}
}

// --- craft ----------------------------------------------------------------

func (r *Room) handleCraft(p *Player, m map[string]any) {
	key := getString(m, "r")
	rec, ok := r.defs.Recipes[key]
	if !ok || !canAfford(p.Inv, rec.Cost) {
		return
	}
	if station, needs := rec.StationName(); needs && !r.nearStruct(p, station, 4) {
		r.send(p, map[string]any{"t": "msg", "s": "You must stand near a " + station + " to craft this."})
		return
	}
	pay(p.Inv, rec.Cost)
	switch {
	case rec.Tool:
		p.Tools[key] = true
	case rec.Gear:
		p.Gear[key] = true
	default:
		p.Inv[key]++
	}
	r.sendInv(p)
}

// --- build ----------------------------------------------------------------

func (r *Room) handleBuild(p *Player, m map[string]any) {
	kind := getString(m, "kind")
	i, okI := tileIndex(m, "i")
	baseHP, known := r.defs.StructHP[kind]
	if !known || p.Inv[kind] <= 0 || !okI || r.medicTiles[i] {
		return
	}
	rec, hasRec := r.defs.Recipes[kind]
	// zone enforcement: zone:'in' decor cannot be built outdoors (the furn path
	// handles those)
	if hasRec && rec.Zone == "in" {
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 6 {
		return
	}
	if existing, occupied := r.structures[i]; occupied {
		// stack: walls to 2, shelters to 3 stories
		maxLvl := 0
		switch kind {
		case "wall":
			maxLvl = 2
		case "shelter":
			maxLvl = 3
		}
		if kind != existing.Kind || existing.lvlOr1() >= maxLvl {
			return
		}
		p.Inv[kind]--
		existing.Lvl = existing.lvlOr1() + 1
		existing.HP += baseHP
		r.broadcast(map[string]any{
			"t": "build", "i": i, "kind": kind, "hp": existing.HP,
			"dir": existing.Dir, "lvl": existing.Lvl,
		})
		r.sendInv(p)
		return
	}
	// non-blocking decor and farmplots may share a tile with other non-blocking
	// things; everything else needs clear ground.
	isNonBlock := r.defs.DecorNonBlk[kind] || kind == "farmplot"
	if isNonBlock {
		if r.tileAtXY(x, y) == world.TWater {
			return
		}
	} else {
		if r.blockedTile(x, y) {
			return
		}
		if _, isNode := r.world.Nodes[i]; isNode && !r.removedAt(i) {
			return
		}
	}
	if kind == "mineshaft" && !r.diggable(i) {
		r.send(p, map[string]any{"t": "msg", "s": "Mines can only be dug in the Woods, Dunes or Spire."})
		return
	}
	if kind == "shelter" {
		// rooms are (lvl+2)-radius: keep them from overlapping
		for si, s2 := range r.structures {
			if s2.Kind != "shelter" {
				continue
			}
			if maxAbs(float64(si%world.SIZE)-x, float64(si/world.SIZE)-y) <= 10 {
				r.send(p, map[string]any{"t": "msg", "s": "Too close to another shelter — their rooms would overlap."})
				return
			}
		}
	}
	if kind == "engine" && i != world.ACTIVATION_I {
		r.send(p, map[string]any{"t": "msg", "s": "The World Engine must be built on the activation dais at the temple heart."})
		return
	}
	if kind == "engine" && !allTrue(r.mono) {
		r.send(p, map[string]any{"t": "msg", "s": "All 4 Monoliths must be awakened first."})
		return
	}
	p.Inv[kind]--
	dir := 0
	if jsTruthy(m, "dir") {
		dir = 1
	}
	r.structures[i] = &Structure{Kind: kind, HP: baseHP, Owner: p.S.ID, Dir: dir, Lvl: 1}
	r.broadcast(map[string]any{"t": "build", "i": i, "kind": kind, "hp": baseHP, "dir": dir, "lvl": 1})
	if kind == "chest" {
		if _, ok := r.chestInv[i]; !ok {
			r.chestInv[i] = map[string]int{}
		}
	}
	r.sendInv(p)
	if kind == "engine" {
		r.wave = &waveState{until: r.now() + 4*60*1000, engineI: i}
		r.broadcast(map[string]any{"t": "wave", "secs": 240})
	}
	if kind == "mineshaft" {
		// carve the starting chamber below the entrance
		var opened []int
		for dy := -1; dy <= 1; dy++ {
			for dx := -1; dx <= 1; dx++ {
				di := ti(x+float64(dx), y+float64(dy))
				if r.diggable(di) && !r.digs[di] {
					r.digs[di] = true
					opened = append(opened, di)
				}
			}
		}
		if len(opened) > 0 {
			sort.Ints(opened)
			r.broadcast(map[string]any{"t": "dig", "tiles": opened})
		}
	}
}

func (s *Structure) lvlOr1() int {
	if s.Lvl == 0 {
		return 1
	}
	return s.Lvl
}

func maxAbs(a, b float64) float64 { return math.Max(math.Abs(a), math.Abs(b)) }

func allTrue(b [4]bool) bool {
	for _, v := range b {
		if !v {
			return false
		}
	}
	return true
}

// --- dig ------------------------------------------------------------------

func (r *Room) handleDig(p *Player, m map[string]any) {
	now := r.now()
	seq := validSeq(m)
	if now-p.LastGather < 250 {
		r.reject(p, seq, "rate_limit")
		return
	}
	if p.Z != 1 {
		r.reject(p, seq, "wrong_z")
		return
	}
	p.LastGather = now
	i, okI := tileIndex(m, "i")
	if !okI || r.digs[i] || !r.diggable(i) {
		r.reject(p, seq, "invalid_target")
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 2 {
		r.reject(p, seq, "out_of_range")
		return
	}
	if !p.Tools["pick"] && !p.Tools["spick"] {
		r.send(p, map[string]any{"t": "msg", "s": "You need a Pickaxe to dig."})
		r.reject(p, seq, "no_tool")
		return
	}
	// derive pick vs spick from the tool actually validated above — never trust
	// a client claim
	tool := "pick"
	if p.Tools["spick"] {
		tool = "spick"
	}
	r.broadcast(map[string]any{
		"t": "act", "id": p.S.ID, "seq": seq, "a": "mine", "tool": tool,
		"dx": clampDir(m, "dx"), "dy": clampDir(m, "dy"), "targetI": i,
	})
	r.digs[i] = true
	got := ""
	switch r.world.Veins[i] {
	case 1:
		n := 2
		if chance(0.5) {
			n++
		}
		p.Inv["iron"] += n
		got = fmt.Sprintf("+%d Iron!", n)
	case 2:
		n := 1
		if chance(0.3) {
			n++
		}
		p.Inv["diamond"] += n
		got = fmt.Sprintf("+%d \U0001F537 DIAMOND!", n)
	default:
		if chance(0.25) {
			p.Inv["stone"]++
			got = "+1 Stone"
		}
	}
	r.broadcast(map[string]any{"t": "dig", "tiles": []int{i}, "by": p.S.ID, "seq": seq})
	r.sendInv(p)
	if got != "" {
		r.send(p, map[string]any{"t": "msg", "s": got})
	}
}

// --- plant / harvest ------------------------------------------------------

func (r *Room) handlePlant(p *Player, m map[string]any) {
	cropName := getString(m, "crop")
	cropDef, ok := r.defs.Crops[cropName]
	if !ok {
		return
	}
	i, okI := tileIndex(m, "i")
	if !okI {
		return
	}
	s, has := r.structures[i]
	if !has || s.Kind != "farmplot" {
		r.send(p, map[string]any{"t": "msg", "s": "No farm plot here."})
		return
	}
	if _, planted := r.farms[i]; planted {
		r.send(p, map[string]any{"t": "msg", "s": "Something is already growing here."})
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 2.5 {
		return
	}
	if !canAfford(p.Inv, cropDef.SeedCost) {
		r.send(p, map[string]any{"t": "msg", "s": "Not enough seeds."})
		return
	}
	pay(p.Inv, cropDef.SeedCost)
	r.farms[i] = &Farm{Crop: cropName, PlantedTick: r.tickN, Owner: p.S.ID, lastStage: -1}
	r.broadcast(map[string]any{"t": "crop", "i": i, "crop": cropName, "stage": 0})
	r.sendInv(p)
}

func (r *Room) handleHarvest(p *Player, m map[string]any) {
	i, okI := tileIndex(m, "i")
	if !okI {
		r.send(p, map[string]any{"t": "msg", "s": "Nothing to harvest here."})
		return
	}
	fm, ok := r.farms[i]
	if !ok {
		r.send(p, map[string]any{"t": "msg", "s": "Nothing to harvest here."})
		return
	}
	cropDef, okDef := r.defs.Crops[fm.Crop]
	if !okDef {
		return
	}
	gt := r.growTicks(cropDef)
	if r.cropStage(fm) < 2 {
		pct := 0
		if gt > 0 {
			pct = int(math.Floor(100 * float64(r.tickN-fm.PlantedTick) / float64(gt)))
		}
		r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("Not ready yet (%d%%).", pct)})
		return
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 2.5 {
		return
	}
	// Deterministic order so the harvest message is stable; the JS version
	// relies on object insertion order, which for a one-key yield is the same.
	keys := make([]string, 0, len(cropDef.Yield))
	for k := range cropDef.Yield {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, res := range keys {
		p.Inv[res] += cropDef.Yield[res]
		parts = append(parts, fmt.Sprintf("%d %s", cropDef.Yield[res], res))
	}
	delete(r.farms, i)
	r.broadcast(map[string]any{"t": "crop", "i": i, "crop": nil, "stage": 0})
	r.sendInv(p)
	r.send(p, map[string]any{"t": "msg", "s": fmt.Sprintf("Harvested %s! +%s", fm.Crop, strings.Join(parts, ", "))})
}

// --- furniture and torches ------------------------------------------------

func (r *Room) handleFurn(p *Player, m map[string]any) {
	kind := getString(m, "kind")
	i, okI := tileIndex(m, "i")
	if !okI {
		return
	}
	rec, hasRec := r.defs.Recipes[kind]
	// allowed: the explicit furniture trio OR decor whose zone admits indoors
	isFurni := kind == "chest" || kind == "bed" || kind == "torch" ||
		(hasRec && rec.Decor && (rec.Zone == "in" || rec.Zone == "both"))
	if !isFurni || p.Inv[kind] <= 0 {
		return
	}
	if _, taken := r.furn[i]; taken {
		return
	}
	if hasRec && rec.Zone == "out" {
		return // extra safety: zone:out decor never inside
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	switch p.Z {
	case 2:
		// SHELTER interior: Chebyshev <= lvl + 2
		inRoom := false
		for si, s := range r.structures {
			if s.Kind != "shelter" {
				continue
			}
			if maxAbs(float64(si%world.SIZE)-x, float64(si/world.SIZE)-y) <= float64(s.lvlOr1()+2) {
				inRoom = true
				break
			}
		}
		if !inRoom || math.Hypot(x-p.X, y-p.Y) > 5 {
			return
		}
	case 1:
		// furniture in mines: the tile must be dug; torches use their own flow
		if !r.digs[i] || kind == "torch" {
			return
		}
		if math.Hypot(x-p.X, y-p.Y) > 5 {
			return
		}
	default:
		return // z == 0: furn not allowed
	}
	p.Inv[kind]--
	r.furn[i] = &Furniture{Kind: kind, Owner: p.S.ID, Z: p.Z}
	if kind == "chest" {
		if _, ok := r.chestInv[i]; !ok {
			r.chestInv[i] = map[string]int{}
		}
	}
	r.broadcast(map[string]any{"t": "furn", "i": i, "kind": kind, "z": p.Z})
	r.sendInv(p)
	if kind == "bed" {
		r.send(p, map[string]any{"t": "msg", "s": "\U0001F6CF You will now respawn at your bed."})
	}
}

func (r *Room) handleTorch(p *Player) {
	if p.Z != 1 || p.Inv["torch"] < 1 {
		return
	}
	i := ti(p.X, p.Y)
	if !r.digs[i] || r.torches[i] {
		return
	}
	p.Inv["torch"]--
	r.torches[i] = true
	r.broadcast(map[string]any{"t": "torch", "i": i})
	r.sendInv(p)
}

// --- equip / wear ---------------------------------------------------------

func (r *Room) handleEq(p *Player, m map[string]any) {
	v, present := m["k"]
	if present && v == nil {
		p.Equip = ""
		r.broadcast(map[string]any{"t": "eq", "id": p.S.ID, "k": nil})
		return
	}
	// Anything that is not an owned tool is refused, which covers the JS
	// `undefined` case too: tools.has(undefined) is false.
	k, isStr := v.(string)
	if !isStr || !p.Tools[k] {
		return
	}
	p.Equip = k
	r.broadcast(map[string]any{"t": "eq", "id": p.S.ID, "k": k})
}

func (r *Room) handleWear(p *Player, m map[string]any) {
	v, present := m["k"]
	if present && v == nil {
		// `k: null` runs the toggle with k === null: worn becomes null either way
		p.Worn = ""
		r.sendInv(p)
		r.send(p, map[string]any{"t": "msg", "s": "You remove your cloak."})
		return
	}
	k, isStr := v.(string)
	if !isStr || (k != "heatcloak" && k != "furcloak") || !p.Gear[k] {
		return
	}
	if p.Worn == k {
		p.Worn = ""
	} else {
		p.Worn = k
	}
	r.sendInv(p)
	if p.Worn != "" {
		r.send(p, map[string]any{"t": "msg", "s": "You wrap yourself in the " + r.defs.Names[p.Worn] + "."})
	} else {
		r.send(p, map[string]any{"t": "msg", "s": "You remove your cloak."})
	}
}

// --- water and use --------------------------------------------------------

func (r *Room) handleWater(p *Player) {
	now := r.now()
	if now-p.LastGather < 250 {
		return
	}
	p.LastGather = now
	near := false
	for dy := -1; dy <= 1 && !near; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if r.tileAtXY(p.X+float64(dx), p.Y+float64(dy)) == world.TWater {
				near = true
				break
			}
		}
	}
	if !near {
		return
	}
	if p.Inv["water"] >= 10 {
		r.send(p, map[string]any{"t": "msg", "s": "You cannot carry more water."})
		return
	}
	p.Inv["water"]++
	r.sendInv(p)
}

func (r *Room) handleUse(p *Player, m map[string]any) {
	now := r.now()
	k := getString(m, "k")
	if k == "medicine" {
		if now-p.LastUseAt < 750 {
			return
		}
		if p.Inv["medicine"] < 1 {
			r.send(p, map[string]any{"t": "useResult", "ok": false, "k": "medicine", "reason": "none-owned"})
			return
		}
		if p.HP <= 0 {
			r.send(p, map[string]any{"t": "useResult", "ok": false, "k": "medicine", "reason": "dead"})
			return
		}
		if p.HP >= r.defs.MaxHP {
			r.send(p, map[string]any{"t": "useResult", "ok": false, "k": "medicine", "reason": "full-health"})
			return
		}
		p.LastUseAt = now
		p.Inv["medicine"]--
		healed := r.healPlayer(p, r.defs.MedicineHeal, "medicine")
		r.sendInv(p)
		r.send(p, map[string]any{
			"t": "useResult", "ok": true, "k": "medicine",
			"healed": healed, "hp": p.HP, "maxHp": r.defs.MaxHP,
		})
		return
	}
	switch {
	case k == "water" && p.Inv["water"] > 0:
		p.Inv["water"]--
		p.Thirst = math.Min(10, p.Thirst+4)
	case k == "cookedmeat" && p.Inv["cookedmeat"] > 0:
		p.Inv["cookedmeat"]--
		p.Hunger = math.Min(10, p.Hunger+5)
	case k == "bread" && p.Inv["bread"] > 0:
		p.Inv["bread"]--
		p.Hunger = math.Min(10, p.Hunger+4)
	case k == "glowcap" && p.Inv["glowcap"] > 0:
		p.Inv["glowcap"]--
		p.Hunger = math.Min(10, p.Hunger+2)
		r.healPlayer(p, 1, "glowcap")
	default:
		return
	}
	r.sendInv(p)
	r.send(p, map[string]any{"t": "stat", "hunger": statInt(p.Hunger), "thirst": statInt(p.Thirst)})
}

// --- chests ---------------------------------------------------------------

// chestResources mirrors the legacy whitelist: only raw resources may be stored.
var chestResources = map[string]bool{
	"wood": true, "stone": true, "fiber": true, "crystal": true,
	"essence": true, "iron": true, "diamond": true, "starmetal": true,
}

// chestAt resolves a chest the player may reach right now: it must be furniture
// of kind chest, on the player's own layer, within 2.5 tiles.
func (r *Room) chestAt(p *Player, m map[string]any) (int, map[string]int, bool) {
	i, okI := tileIndex(m, "i")
	if !okI {
		return 0, nil, false
	}
	f, ok := r.furn[i]
	if !ok || f.Kind != "chest" {
		return 0, nil, false
	}
	if f.Z != p.Z { // a chest is only reachable from the layer it was placed on
		return 0, nil, false
	}
	x, y := float64(i%world.SIZE), float64(i/world.SIZE)
	if math.Hypot(x-p.X, y-p.Y) > 2.5 {
		return 0, nil, false
	}
	slot, ok := r.chestInv[i]
	if !ok {
		slot = map[string]int{}
		r.chestInv[i] = slot
	}
	return i, slot, true
}

func (r *Room) handleChestOpen(p *Player, m map[string]any) {
	i, slot, ok := r.chestAt(p, m)
	if !ok {
		return
	}
	r.send(p, map[string]any{"t": "chest", "i": i, "slots": slot})
}

func (r *Room) handleChestMove(p *Player, m map[string]any) {
	n := getInt32(m, "n")
	if n == 0 {
		return
	}
	i, slot, ok := r.chestAt(p, m)
	if !ok {
		return
	}
	res := getString(m, "res")
	if !chestResources[res] {
		return
	}
	// Deposit and withdraw are each clamped to what the SOURCE actually holds,
	// so the two counters can never be made to disagree: nothing is added on one
	// side without the same amount being removed from the other, and the clamp
	// happens before either side is touched.
	if n > 0 {
		actual := n
		if p.Inv[res] < actual {
			actual = p.Inv[res]
		}
		if actual <= 0 {
			return
		}
		p.Inv[res] -= actual
		slot[res] += actual
	} else {
		actual := -n
		if slot[res] < actual {
			actual = slot[res]
		}
		if actual <= 0 {
			return
		}
		slot[res] -= actual
		if slot[res] <= 0 {
			delete(slot, res)
		}
		p.Inv[res] += actual
	}
	r.broadcast(map[string]any{"t": "chest", "i": i, "slots": slot})
	r.sendInv(p)
}

// --- attack (structures) --------------------------------------------------

// handleAtk is the legacy `atk`: it scans creatures and then animals for the
// nearest target within 2.4 tiles, and only falls through to structure
// demolition when it finds none.
//
// The two scans walk creOrder and aniOrder rather than the maps. The comparison
// is strict (`d < bd`), so when two targets are exactly equidistant the one the
// scan reaches first wins — under Go map iteration that would be a coin flip
// every swing.
func (r *Room) handleAtk(p *Player, m map[string]any) {
	now := r.now()
	seq := validSeq(m)
	if now-p.LastAtk < 400 {
		r.reject(p, seq, "rate_limit")
		return
	}
	// nothing to strike underground or indoors — this is what stops a player
	// swinging in the mine from demolishing the structures above them
	if p.Z != 0 {
		r.reject(p, seq, "wrong_z")
		return
	}
	p.LastAtk = now
	dmg := 1
	switch p.Equip {
	case "isword":
		dmg = 5
	case "sword":
		dmg = 3
	case "axe":
		dmg = 2
	}
	// The swing clip is derived from the authoritative p.Equip, never from a
	// client-claimed weapon. A valid attack broadcasts `act` even on a miss;
	// `chit` is simply omitted when nothing is hit.
	atkClip := "punch"
	switch p.Equip {
	case "axe":
		atkClip = "chop"
	case "pick", "spick":
		atkClip = "mine"
	case "sword", "isword":
		atkClip = "slash"
	}
	// target search: creatures first, then animals, nearest wins within 2.4
	var bestC *Creature
	var bestA *Animal
	bid := ""
	bd := 2.4
	for _, c := range r.creOrder {
		if d := math.Hypot(c.X-p.X, c.Y-p.Y); d < bd {
			bd, bestC, bestA, bid = d, c, nil, c.ID
		}
	}
	for _, a := range r.aniOrder {
		if d := math.Hypot(a.X-p.X, a.Y-p.Y); d < bd {
			bd, bestC, bestA, bid = d, nil, a, a.ID
		}
	}
	// targetI carries the struck creature/animal id, or null on a miss.
	var targetI any
	if bid != "" {
		targetI = bid
	}
	r.broadcast(map[string]any{
		"t": "act", "id": p.S.ID, "seq": seq, "a": atkClip, "tool": nullable(p.Equip),
		"dx": clampDir(m, "dx"), "dy": clampDir(m, "dy"), "targetI": targetI,
	})

	if bestA != nil {
		r.hitAnimal(p, bestA, dmg, seq)
		return
	}
	if bestC != nil {
		r.hitCreature(p, bestC, dmg, seq, now)
		return
	}

	// no creature in range: strike a structure to demolish it (half the
	// materials are refunded)
	bsi, bsd := -1, 2.4
	for si := range r.structures {
		d := math.Hypot(float64(si%world.SIZE)-p.X, float64(si/world.SIZE)-p.Y)
		if d < bsd {
			bsd = d
			bsi = si
		}
	}
	if bsi < 0 {
		return
	}
	s := r.structures[bsi]
	s.HP -= dmg * 2 // demolition is quick work
	if s.HP > 0 {
		r.broadcast(map[string]any{"t": "sd", "i": bsi, "hp": s.HP})
		return
	}
	r.destroyStructure(bsi)
	mult := 1
	if s.Kind == "wall" {
		mult = s.lvlOr1()
	}
	var back []string
	if rec, ok := r.defs.Recipes[s.Kind]; ok {
		keys := make([]string, 0, len(rec.Cost))
		for k := range rec.Cost {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			n := (rec.Cost[k] / 2) * mult
			if n != 0 {
				p.Inv[k] += n
				back = append(back, fmt.Sprintf("%d %s", n, k))
			}
		}
	}
	r.broadcast(map[string]any{"t": "sd", "i": bsi, "hp": 0})
	r.sendInv(p)
	msg := "Demolished " + s.Kind
	if len(back) > 0 {
		msg += " — recovered " + strings.Join(back, ", ")
	}
	r.send(p, map[string]any{"t": "msg", "s": msg})
	if r.wave != nil && bsi == r.wave.engineI {
		r.wave = nil
		r.broadcast(map[string]any{"t": "wave", "secs": 0})
		r.broadcast(map[string]any{"t": "msg", "s": "You destroyed your own World Engine!"})
	}
}

// destroyStructure removes a structure and any crop growing on it. The legacy
// server leaves the farms entry behind when a farmplot is destroyed, which
// strands a crop on a tile that has no plot: plant refuses it (already growing)
// and the growth tick keeps broadcasting it forever. Clearing it here is a
// deliberate, documented difference from server/index.js.
func (r *Room) destroyStructure(i int) {
	delete(r.structures, i)
	delete(r.farms, i)
}

// canAfford / pay mirror the shared/defs.js helpers, which are algorithms and so
// stay in code rather than in shared/defs.json.
func canAfford(inv, cost map[string]int) bool {
	for k, v := range cost {
		if inv[k] < v {
			return false
		}
	}
	return true
}

func pay(inv, cost map[string]int) {
	for k, v := range cost {
		inv[k] -= v
	}
}

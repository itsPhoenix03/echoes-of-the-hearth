// Package room is the authoritative simulation.
//
// # Concurrency boundary (read this before touching anything in this package)
//
// There is exactly ONE goroutine that may touch game state: the one running
// Room.Run. Everything reachable from *Room — the world overlays, the player
// map, every *Player and its fields, the day/time counters, the chunk cache —
// is owned by that goroutine and is therefore protected by nothing at all. No
// mutex guards game state, and none should ever be added; if you find yourself
// wanting one, you are about to touch room state from the wrong goroutine.
//
// The loop is a single select over four sources:
//
//	inbox   — decoded client frames, pushed by per-connection reader goroutines
//	tick    — the 200 ms simulation ticker
//	join    — a newly authenticated session
//	leave   — a disconnected session
//	ctx     — shutdown
//
// Around it sit two goroutines per connection, and they touch no game state:
//
//   - the reader goroutine reads WebSocket frames, json-decodes them into a
//     map[string]any, and pushes an Inbound onto the shared inbox. It never
//     dereferences a *Player.
//   - the writer goroutine drains that session's own buffered Out channel and
//     writes the bytes to the socket. It never reads game state either; the
//     room hands it finished bytes.
//
// Backpressure: Session.trySend never blocks. If a player's Out buffer is full
// the room concludes the client is not draining and drops the connection on the
// spot (dropSlow). A stalled client therefore costs one dropped session, never
// a stalled world tick — which is the whole reason this is a single-goroutine
// room rather than a lock-per-player one.
package room

import (
	"context"
	"crypto/rand"
	"fmt"
	"log"
	"math"
	"math/big"
	"sort"
	"strconv"
	"time"

	"hearth/gameserver/defs"
	"hearth/gameserver/persist"
	"hearth/gameserver/world"
)

// Config is the room's boot-time configuration.
type Config struct {
	Seed      string
	AllowWarp bool
	Store     persist.Store
	SaveEvery time.Duration
	Logger    *log.Logger
	// Defs, when non-nil, is used instead of loading shared/defs.json.
	Defs *defs.Defs
	// Dev mirrors the legacy server's DEV env var: it shortens crop growth by
	// GROW_DIV (30x). It does NOT gate the warp teleport — that is AllowWarp.
	Dev bool
	// World, when non-nil, is used instead of generating one. Generation takes
	// a couple of seconds, so tests (and any future multi-room process sharing
	// one seed) can hand in a pre-generated, read-only world.
	World *world.World
}

// Room is one world instance. Construct with New, then call Run in its own
// goroutine.
type Room struct {
	cfg   Config
	world *world.World
	spawn [2]int

	medics     []world.Medic
	medicTiles map[int]bool

	defs        *defs.Defs
	growDivisor int

	// Mutable world overlays: everything players have changed about the world.
	// All of it is owned by the room goroutine (see the package comment).
	structures  map[int]*Structure
	furn        map[int]*Furniture
	digs        map[int]bool
	torches     map[int]bool
	nodeHP      map[int]int   // tile -> remaining hp, only while damaged
	removed     map[int]int64 // tile -> wall-clock ms at which the node returns
	mudTiles    map[int]bool
	sectorChops map[int]int // 16x16 sector key -> trees felled
	farms       map[int]*Farm
	chestInv    map[int]map[string]int
	brokenBergs map[int]bool
	wave        *waveState

	chunkCache map[int]*staticChunk

	players  map[string]*Player
	profiles map[string]*persist.Profile // keyed by ticket userId

	time  float64
	day   int
	mono  [4]bool
	won   bool
	tickN int64

	inbox chan Inbound
	join  chan *Session
	leave chan *Session

	// nowFn is swappable so the movement tests can drive the clock.
	nowFn func() int64
}

// New generates the world and prepares the room. It does not start the loop.
func New(cfg Config) (*Room, error) {
	if cfg.Seed == "" {
		cfg.Seed = "hearth-1"
	}
	if cfg.Store == nil {
		cfg.Store = persist.NopStore{}
	}
	if cfg.SaveEvery == 0 {
		cfg.SaveEvery = 30 * time.Second
	}
	if cfg.Logger == nil {
		cfg.Logger = log.Default()
	}
	w := cfg.World
	if w == nil {
		w = world.GenWorld(cfg.Seed)
	}
	d := cfg.Defs
	if d == nil {
		var derr error
		d, derr = defs.Load()
		if derr != nil {
			return nil, derr
		}
	}
	medics, err := world.FindMedicSpawns(w)
	if err != nil {
		return nil, fmt.Errorf("room: %w", err)
	}
	// The legacy server blocks both the medic's own tile and the hut tiles.
	mt := world.MedicBlockTiles(medics)
	for _, m := range medics {
		mt[m.Y*world.SIZE+m.X] = true
	}
	r := &Room{
		cfg:         cfg,
		world:       w,
		spawn:       world.FindSpawn(w),
		medics:      medics,
		medicTiles:  mt,
		defs:        d,
		growDivisor: growDiv(cfg.Dev),
		structures:  map[int]*Structure{},
		furn:        map[int]*Furniture{},
		digs:        map[int]bool{},
		torches:     map[int]bool{},
		nodeHP:      map[int]int{},
		removed:     map[int]int64{},
		mudTiles:    map[int]bool{},
		sectorChops: map[int]int{},
		farms:       map[int]*Farm{},
		chestInv:    map[int]map[string]int{},
		brokenBergs: map[int]bool{},
		chunkCache:  map[int]*staticChunk{},
		players:     map[string]*Player{},
		profiles:    map[string]*persist.Profile{},
		time:        0.3,
		day:         1,
		inbox:       make(chan Inbound, 1024),
		join:        make(chan *Session),
		leave:       make(chan *Session, 64),
		nowFn:       func() int64 { return time.Now().UnixMilli() },
	}
	if err := r.loadSave(); err != nil {
		cfg.Logger.Printf("[hearth] failed to load save: %v", err)
	}
	return r, nil
}

func (r *Room) now() int64 { return r.nowFn() }

// Spawn is the authoritative spawn tile.
func (r *Room) Spawn() [2]int { return r.spawn }

// Inbox is where connection readers push decoded frames.
func (r *Room) Inbox() chan<- Inbound { return r.inbox }

// Join hands an authenticated session to the room. It blocks only until the
// room goroutine picks it up, or until ctx is done.
func (r *Room) Join(ctx context.Context, s *Session) error {
	select {
	case r.join <- s:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Leave notifies the room a session is gone. Safe to call more than once.
func (r *Room) Leave(s *Session) {
	select {
	case r.leave <- s:
	default:
		// The leave channel is buffered; if it is somehow full the room will
		// still reap the session on its next send failure.
	}
}

// Run is the room goroutine. It returns after ctx is cancelled and the final
// save has been written.
func (r *Room) Run(ctx context.Context) {
	tick := time.NewTicker(TickMS * time.Millisecond)
	defer tick.Stop()
	saveT := time.NewTicker(r.cfg.SaveEvery)
	defer saveT.Stop()

	for {
		select {
		case <-ctx.Done():
			for _, p := range r.players {
				r.snapshotInto(p)
				p.S.Close()
			}
			if err := r.saveGame(); err != nil {
				r.cfg.Logger.Printf("[hearth] save failed: %v", err)
			}
			return

		case s := <-r.join:
			r.onJoin(s)

		case s := <-r.leave:
			r.onLeave(s)

		case in := <-r.inbox:
			r.onMessage(in)

		case <-tick.C:
			r.onTick()

		case <-saveT.C:
			if err := r.saveGame(); err != nil {
				r.cfg.Logger.Printf("[hearth] save failed: %v", err)
			}
		}
	}
}

// --- outbound -------------------------------------------------------------

// send queues one message for one player. A full queue means the client is not
// draining, so the connection is dropped rather than the tick blocked.
func (r *Room) send(p *Player, m any) {
	if !p.S.trySend(marshal(m)) {
		r.dropSlow(p)
	}
}

// broadcast marshals once and fans the same bytes out to everyone.
func (r *Room) broadcast(m any) {
	b := marshal(m)
	var slow []*Player
	for _, p := range r.players {
		if !p.S.trySend(b) {
			slow = append(slow, p)
		}
	}
	for _, p := range slow {
		r.dropSlow(p)
	}
}

// dropSlow removes a player whose outbound buffer overflowed. It is called from
// the room goroutine only, so it can mutate room state directly.
func (r *Room) dropSlow(p *Player) {
	if _, ok := r.players[p.S.ID]; !ok {
		return
	}
	r.cfg.Logger.Printf("[hearth] %s (%s) dropped: outbound buffer full", p.S.ID, p.Name)
	p.S.Close()
	r.removePlayer(p)
}

// --- lifecycle ------------------------------------------------------------

func (r *Room) onJoin(s *Session) {
	now := r.now()
	p := newPlayer(s, r.spawn, now, r.defs)
	if prof := r.profiles[s.UserID]; prof != nil {
		r.restore(p, prof)
	}
	r.players[s.ID] = p

	others := make([]map[string]any, 0, len(r.players))
	for id, q := range r.players {
		if id == s.ID {
			continue
		}
		others = append(others, map[string]any{
			"id": id, "x": q.X, "y": q.Y, "z": q.Z, "name": q.Name, "b": q.B, "eq": q.Equip,
		})
	}
	r.send(p, map[string]any{
		"t": "init", "id": s.ID, "name": p.Name,
		"seed": r.cfg.Seed, "worldVersion": world.WorldVersion, "size": world.SIZE,
		"chunk": 64,
		"x":     p.X, "y": p.Y, "z": p.Z,
		"hp": p.HP, "maxHp": r.defs.MaxHP, "hunger": p.Hunger, "thirst": p.Thirst,
		"inv": p.Inv, "tools": keysOf(p.Tools), "gear": keysOf(p.Gear), "wornGear": p.Worn,
		"players": others,
		"time":    r.time, "day": r.day, "mono": r.mono[:], "won": r.won,
	})
	r.pushChunks(p)
	r.broadcast(map[string]any{"t": "pj", "id": s.ID, "x": p.X, "y": p.Y, "name": p.Name})
	r.cfg.Logger.Printf("[hearth] %s (%s) joined (%d online)", s.ID, p.Name, len(r.players))
}

func (r *Room) onLeave(s *Session) {
	p, ok := r.players[s.ID]
	if !ok {
		return
	}
	r.removePlayer(p)
}

func (r *Room) removePlayer(p *Player) {
	r.snapshotInto(p)
	delete(r.players, p.S.ID)
	r.broadcast(map[string]any{"t": "pl", "id": p.S.ID})
	r.cfg.Logger.Printf("[hearth] %s (%s) left (%d online)", p.S.ID, p.Name, len(r.players))
}

func (r *Room) onMessage(in Inbound) {
	p, ok := r.players[in.S.ID]
	if !ok {
		return // frame arrived after the player was reaped
	}
	switch getString(in.Data, "t") {
	case "pos":
		r.handlePos(p, in.Data)
	case "warp":
		r.handleWarp(p, in.Data)
	case "ping":
		r.send(p, map[string]any{"t": "pong"})

	// --- Slice 2: resources, crafting, construction, farming, chests ---
	case "gather":
		r.handleGather(p, in.Data)
	case "craft":
		r.handleCraft(p, in.Data)
	case "build":
		r.handleBuild(p, in.Data)
	case "dig":
		r.handleDig(p, in.Data)
	case "plant":
		r.handlePlant(p, in.Data)
	case "harvest":
		r.handleHarvest(p, in.Data)
	case "furn":
		r.handleFurn(p, in.Data)
	case "torch":
		r.handleTorch(p)
	case "eq":
		r.handleEq(p, in.Data)
	case "wear":
		r.handleWear(p, in.Data)
	case "use":
		r.handleUse(p, in.Data)
	case "water":
		r.handleWater(p)
	case "chest_open":
		r.handleChestOpen(p, in.Data)
	case "chest_move":
		r.handleChestMove(p, in.Data)
	case "atk":
		r.handleAtk(p, in.Data)
	case "anim":
		// gather/dig/atk drive remote rigs through the validated `act`
		// broadcast; `anim` remains only for cosmetic actions, whitelisted.
		if getString(in.Data, "a") == "j" {
			r.broadcast(map[string]any{"t": "anim", "id": p.S.ID, "a": "j"})
		}

	default:
		// Unknown types are ignored, exactly as the legacy server ignores them.
		// Creature combat, the medic and monolith progression are Slice 3.
	}
}

func (r *Room) onTick() {
	r.tickN++
	prev := r.time
	r.time = math.Mod(r.time+(TickMS/1000.0)/DayLengthSec, 1)
	if r.time < prev {
		r.day++
		r.broadcast(map[string]any{"t": "msg", "s": fmt.Sprintf("Day %d dawns over The Hearth.", r.day)})
	}
	// The legacy server piggybacks the clock on the per-tick 'cre' message.
	// Slice 1 has no creatures, so the clock gets its own frame at the same
	// cadence; the payload is a few dozen bytes.
	if len(r.players) > 0 {
		r.broadcast(map[string]any{"t": "time", "time": r.time, "day": r.day})
	}
	r.onSimTick()
}

// --- persistence ----------------------------------------------------------

func (r *Room) snapshotInto(p *Player) {
	if p.S.UserID == "" {
		return
	}
	inv := make(map[string]int, len(p.Inv))
	for k, v := range p.Inv {
		inv[k] = v
	}
	r.profiles[p.S.UserID] = &persist.Profile{
		Name: p.Name, X: p.X, Y: p.Y, Z: p.Z,
		HP: p.HP, Hunger: p.Hunger, Thirst: p.Thirst,
		Inv: inv, Tools: keysOf(p.Tools), Gear: keysOf(p.Gear), Worn: p.Worn,
	}
}

func (r *Room) restore(p *Player, prof *persist.Profile) {
	for k, v := range prof.Inv {
		if _, known := p.Inv[k]; known {
			p.Inv[k] = v
		}
	}
	for _, t := range prof.Tools {
		p.Tools[t] = true
	}
	for _, g := range prof.Gear {
		p.Gear[g] = true
	}
	if prof.HP > 0 {
		p.HP = prof.HP
	}
	p.Hunger, p.Thirst = prof.Hunger, prof.Thirst
	// Never restore a player into water, and never onto a tile outside the
	// world: both would strand them.
	if prof.X >= 0 && prof.Y >= 0 && prof.X < world.SIZE && prof.Y < world.SIZE &&
		r.world.Tiles[ti(prof.X, prof.Y)] != world.TWater {
		p.X, p.Y = prof.X, prof.Y
		p.LastLandX, p.LastLandY = prof.X, prof.Y
		r.warped(p)
	}
	if prof.Worn != "" && p.Gear[prof.Worn] {
		p.Worn = prof.Worn
	}
	// The ticket owns the name; a saved name never overrides it.
}

func (r *Room) loadSave() error {
	snap, err := r.cfg.Store.Load()
	if err != nil || snap == nil {
		return err
	}
	if snap.Version != world.WorldVersion || snap.Seed != r.cfg.Seed {
		r.cfg.Logger.Printf("[hearth] save version/seed mismatch — starting fresh")
		return nil
	}
	r.day, r.time, r.won, r.mono = snap.Day, snap.Time, snap.Won, snap.Mono
	for k, v := range snap.Profiles {
		r.profiles[k] = v
	}
	now := r.now()
	for _, nr := range snap.Removed {
		if inWorld(nr.I) {
			r.removed[nr.I] = now + nr.Remaining
		}
	}
	for _, i := range snap.Mud {
		if inWorld(i) {
			r.mudTiles[i] = true
		}
	}
	for k, v := range snap.SectorChops {
		if n, err := strconv.Atoi(k); err == nil {
			r.sectorChops[n] = v
		}
	}
	for k, st := range snap.Structures {
		i, err := strconv.Atoi(k)
		if err != nil || !inWorld(i) || st == nil {
			continue
		}
		// unknown-kind guard: a save written by a build with extra content must
		// not resurrect a structure this build has no rules for
		_, known := r.defs.StructHP[st.Kind]
		if _, isRecipe := r.defs.Recipes[st.Kind]; !known && !isRecipe {
			continue
		}
		lvl := st.Lvl
		if lvl == 0 {
			lvl = 1
		}
		r.structures[i] = &Structure{Kind: st.Kind, HP: st.HP, Owner: st.Owner, Dir: st.Dir, Lvl: lvl}
	}
	for _, i := range snap.Digs {
		if inWorld(i) {
			r.digs[i] = true
		}
	}
	for _, i := range snap.Torches {
		if inWorld(i) {
			r.torches[i] = true
		}
	}
	for k, f := range snap.Furn {
		i, err := strconv.Atoi(k)
		if err != nil || !inWorld(i) || f == nil {
			continue
		}
		r.furn[i] = &Furniture{Kind: f.Kind, Owner: f.Owner, Z: f.Z}
	}
	for _, i := range snap.BrokenBergs {
		if inWorld(i) {
			r.brokenBergs[i] = true
		}
	}
	for k, fm := range snap.Farms {
		i, err := strconv.Atoi(k)
		if err != nil || !inWorld(i) || fm == nil {
			continue
		}
		if _, ok := r.defs.Crops[fm.Crop]; !ok {
			continue
		}
		// Elapsed, not absolute: the tick counter restarts at zero.
		r.farms[i] = &Farm{Crop: fm.Crop, PlantedTick: -fm.Elapsed, Owner: fm.Owner, lastStage: -1}
	}
	for k, slots := range snap.ChestInv {
		i, err := strconv.Atoi(k)
		if err != nil || !inWorld(i) {
			continue
		}
		cp := make(map[string]int, len(slots))
		for res, n := range slots {
			if chestResources[res] && n > 0 {
				cp[res] = n
			}
		}
		r.chestInv[i] = cp
	}
	r.cfg.Logger.Printf("[hearth] save loaded: day %d, %d structures, %d digs, %d farms, %d profiles",
		r.day, len(r.structures), len(r.digs), len(r.farms), len(r.profiles))
	return nil
}

// inWorld guards every persisted tile index. A corrupt or hand-edited save must
// not be able to make the room index a tile array out of bounds.
func inWorld(i int) bool { return i >= 0 && i < world.SIZE*world.SIZE }

func (r *Room) saveGame() error {
	for _, p := range r.players {
		r.snapshotInto(p)
	}
	now := r.now()
	snap := &persist.Snapshot{
		Version: world.WorldVersion, Seed: r.cfg.Seed,
		Day: r.day, Time: r.time, Won: r.won, Mono: r.mono, Profiles: r.profiles,
		SectorChops: map[string]int{},
		Structures:  map[string]*persist.Struct{},
		Furn:        map[string]*persist.Furn{},
		Farms:       map[string]*persist.Farm{},
		ChestInv:    map[string]map[string]int{},
	}
	for i, at := range r.removed {
		snap.Removed = append(snap.Removed, persist.NodeRespawn{I: i, Remaining: maxInt64(0, at-now)})
	}
	for i := range r.mudTiles {
		snap.Mud = append(snap.Mud, i)
	}
	for k, v := range r.sectorChops {
		snap.SectorChops[strconv.Itoa(k)] = v
	}
	for i, s := range r.structures {
		snap.Structures[strconv.Itoa(i)] = &persist.Struct{Kind: s.Kind, HP: s.HP, Owner: s.Owner, Dir: s.Dir, Lvl: s.lvlOr1()}
	}
	for i := range r.digs {
		snap.Digs = append(snap.Digs, i)
	}
	for i := range r.torches {
		snap.Torches = append(snap.Torches, i)
	}
	for i, f := range r.furn {
		snap.Furn[strconv.Itoa(i)] = &persist.Furn{Kind: f.Kind, Owner: f.Owner, Z: f.Z}
	}
	for i := range r.brokenBergs {
		snap.BrokenBergs = append(snap.BrokenBergs, i)
	}
	for i, fm := range r.farms {
		snap.Farms[strconv.Itoa(i)] = &persist.Farm{Crop: fm.Crop, Elapsed: r.tickN - fm.PlantedTick, Owner: fm.Owner}
	}
	for i, slots := range r.chestInv {
		if len(slots) == 0 {
			continue
		}
		cp := make(map[string]int, len(slots))
		for res, n := range slots {
			cp[res] = n
		}
		snap.ChestInv[strconv.Itoa(i)] = cp
	}
	sort.Ints(snap.Mud)
	sort.Ints(snap.Digs)
	sort.Ints(snap.Torches)
	sort.Ints(snap.BrokenBergs)
	sort.Slice(snap.Removed, func(a, b int) bool { return snap.Removed[a].I < snap.Removed[b].I })
	return r.cfg.Store.Save(snap)
}

func maxInt64(a, b int64) int64 {
	if a > b {
		return a
	}
	return b
}

// --- ids ------------------------------------------------------------------

const idAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"

// NewSessionID mints a 6-character base36 id, matching the shape the legacy
// server produced with Math.random().toString(36).slice(2, 8).
func NewSessionID() string {
	b := make([]byte, 6)
	for i := range b {
		n, err := rand.Int(rand.Reader, big.NewInt(int64(len(idAlphabet))))
		if err != nil {
			panic("room: crypto/rand failed: " + err.Error())
		}
		b[i] = idAlphabet[n.Int64()]
	}
	return string(b)
}

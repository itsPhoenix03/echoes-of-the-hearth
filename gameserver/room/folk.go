package room

import (
	"math"
	"math/rand"

	"hearth/gameserver/world"
)

// Island folk: the villagers, hunter, child and elder who live at the island
// camps (world.FindFolkCamps). They cannot be hurt, traded with or built on;
// they make the islands feel lived in and react to the same dangers players do.
//
// Each folk member runs a small day schedule around its camp — wander the yard,
// work (gather, build, craft), sit at the fire, idle — and:
//
//   - stops and turns to a player who comes within talking range (the client
//     shows what they say);
//   - runs for the hut the moment a creature comes near, ducks inside, and
//     comes back out once the coast has been clear for a few seconds;
//   - turns in for the night; the camp's watcher (hunter, elder) instead keeps
//     the fire, and only takes cover when something comes for it.
//
// Hunting creatures with nothing better to do chase folk off (creature_ai.go),
// so a camp under pressure is a visible sign of creatures about.
//
// On the wire a folk member is [id, x, y, kind, act] in the `cre` frame's `f`
// list; act is idle / walk / run / talk / sit / collect / build / craft / hide.

type folkState uint8

const (
	fsIdle folkState = iota
	fsWalk
	fsWork
	fsSit
	fsFlee
	fsHome
	fsHidden
)

const (
	folkWalkSp  = 0.11 // tiles / tick
	folkChildSp = 0.17
	folkRunSp   = 0.3
	folkThreatR = 7.0  // a creature this close sends folk running
	folkClearR  = 10.0 // and must be this far away before they come out
	folkClearTk = 15   // ticks of all-clear before coming back out
	folkTalkR   = 2.4  // a player this close gets their attention
	folkYardR   = 7.0  // how far from the fire the day's round strays
)

// Folk is one camp resident.
type Folk struct {
	ID    string
	Kind  string
	Camp  int // index into r.camps
	X, Y  float64
	Act   string
	state folkState
	next  folkState // what to do on arriving at (tx, ty)
	work  string    // the work act for the next fsWork
	tx    float64
	ty    float64
	timer int
	calm  int
	stuck int
	// watcher keeps the fire at night; child runs about at play
	watcher bool
	child   bool
}

// setupCamps places the camps once the save is loaded (so no camp lands on a
// player's structure), reserves their tiles and seats the folk at their fires.
func (r *Room) setupCamps() {
	reserved := map[int]bool{r.spawn[1]*world.SIZE + r.spawn[0]: true}
	for i := range r.medicTiles {
		reserved[i] = true
	}
	for i := range r.structures {
		reserved[i] = true
	}
	r.camps = world.FindFolkCamps(r.world, reserved)
	r.folk = nil
	for ci, c := range r.camps {
		for _, t := range world.CampBlockTiles(c) {
			r.medicTiles[t] = true
		}
		for k, kind := range c.Folk {
			ang := float64(k) * 2 * math.Pi / float64(len(c.Folk))
			f := &Folk{
				ID: c.ID + "-" + itoa(k), Kind: kind, Camp: ci, Act: "idle",
				watcher: kind == "ashmark_hunter" || kind == "elder_yvenne",
				child:   kind == "woods_child",
			}
			f.X, f.Y = float64(c.FireX)+0.5+math.Cos(ang)*1.6, float64(c.FireY)+0.5+math.Sin(ang)*1.6
			if !r.folkWalkable(f.X, f.Y) {
				f.X, f.Y = r.campDoor(ci)
			}
			f.timer = 5 + k*7
			r.folk = append(r.folk, f)
		}
	}
}

// campDoor is the spot just in front of the hut where folk duck inside.
func (r *Room) campDoor(ci int) (float64, float64) {
	c := &r.camps[ci]
	return float64(c.HutX) + 1.35, float64(c.HutY) + 1.35
}

func (r *Room) campsWire() []map[string]any {
	out := make([]map[string]any, 0, len(r.camps))
	for _, c := range r.camps {
		out = append(out, map[string]any{
			"id": c.ID, "islandId": c.IslandID, "hutSprite": c.HutSprite,
			"hutX": c.HutX, "hutY": c.HutY, "fireX": c.FireX, "fireY": c.FireY,
		})
	}
	return out
}

func (r *Room) folkWire() [][]any {
	out := make([][]any, 0, len(r.folk))
	for _, f := range r.folk {
		out = append(out, []any{f.ID, toFixed(f.X, 2), toFixed(f.Y, 2), f.Kind, f.Act})
	}
	return out
}

// nearestFolk is the closest folk member out in the open within rad, for idle
// hunters looking for something to chase.
func (r *Room) nearestFolk(x, y, rad float64) *Folk {
	var best *Folk
	for _, f := range r.folk {
		if f.state == fsHidden {
			continue
		}
		if d := math.Hypot(f.X-x, f.Y-y); d < rad {
			rad, best = d, f
		}
	}
	return best
}

// folkWalkable: open land a folk member can stand on.
func (r *Room) folkWalkable(x, y float64) bool {
	if x < 0 || y < 0 || x >= world.SIZE || y >= world.SIZE {
		return false
	}
	i := ti(x, y)
	if !r.creFooting(i) || r.medicTiles[i] || world.LandmarkBlock[i] || r.wallBlocks(i) {
		return false
	}
	if s, ok := r.structures[i]; ok && !r.defs.DecorNonBlk[s.Kind] && s.Kind != "farmplot" {
		return false
	}
	return true
}

// folkStep moves f toward (tx, ty) at sp, turning up to 90° round obstacles.
// It reports whether f has arrived.
func (r *Room) folkStep(f *Folk, tx, ty, sp float64) bool {
	d := math.Hypot(tx-f.X, ty-f.Y)
	if d < 0.3 {
		f.stuck = 0
		return true
	}
	sp = math.Min(sp, d)
	base := math.Atan2(ty-f.Y, tx-f.X)
	for _, rot := range [5]float64{0, 0.8, -0.8, 1.57, -1.57} {
		nx, ny := f.X+math.Cos(base+rot)*sp, f.Y+math.Sin(base+rot)*sp
		if r.folkWalkable(nx, ny) {
			f.X, f.Y = nx, ny
			f.stuck = 0
			return false
		}
	}
	f.stuck++
	return false
}

// folkThreatened: some creature is within rad of f.
func (r *Room) folkThreatened(f *Folk, rad float64) bool {
	for _, c := range r.creOrder {
		if math.Hypot(c.X-f.X, c.Y-f.Y) < rad {
			return true
		}
	}
	return false
}

func (r *Room) folkTick() {
	if len(r.players) == 0 || len(r.folk) == 0 {
		return
	}
	night := r.isNight()
	for _, f := range r.folk {
		dx, dy := r.campDoor(f.Camp)

		if f.state == fsHidden {
			if r.folkThreatened(f, folkClearR) {
				f.calm = 0
				continue
			}
			f.calm++
			if f.calm >= folkClearTk && (!night || f.watcher) {
				f.X, f.Y = dx, dy
				f.state, f.Act, f.timer = fsIdle, "idle", 8
			}
			continue
		}

		// danger first: run for the hut and duck inside
		if r.folkThreatened(f, folkThreatR) || f.state == fsFlee {
			if f.state != fsFlee && !r.folkThreatened(f, folkThreatR) {
				f.state = fsIdle
			} else {
				f.state, f.Act = fsFlee, "run"
				if r.folkStep(f, dx, dy, folkRunSp) || f.stuck > 6 {
					f.state, f.Act, f.calm, f.stuck = fsHidden, "hide", 0, 0
				}
				continue
			}
		}

		// nightfall: everyone but the watcher turns in
		if night && !f.watcher {
			f.state, f.Act = fsHome, "walk"
			if r.folkStep(f, dx, dy, folkWalkSp) || f.stuck > 10 {
				f.state, f.Act, f.calm, f.stuck = fsHidden, "hide", 0, 0
			}
			continue
		}
		if f.state == fsHome {
			f.state = fsIdle
		}

		// a player close by: stop and talk (a sitter stays seated)
		if r.folkNearPlayer(f) {
			if f.state != fsSit {
				f.Act = "talk"
			}
			continue
		}

		switch f.state {
		case fsWalk:
			sp := folkWalkSp
			if f.child {
				sp = folkChildSp
			}
			f.Act = "walk"
			if f.child && f.next == fsIdle {
				f.Act = "run" // at play
			}
			f.timer--
			if r.folkStep(f, f.tx, f.ty, sp) {
				f.begin(f.next)
			} else if f.stuck > 8 || f.timer <= 0 {
				// boxed in, or circling an obstacle: settle for here
				f.stuck = 0
				f.begin(f.next)
			}
		case fsWork, fsSit, fsIdle:
			if f.state == fsIdle {
				f.Act = "idle"
			}
			f.timer--
			if f.timer <= 0 {
				r.folkPlan(f, night)
			}
		}
	}
}

// begin switches f into a stationary activity with a fresh timer.
func (f *Folk) begin(s folkState) {
	f.state = s
	switch s {
	case fsWork:
		f.Act, f.timer = f.work, 40+rand.Intn(40)
	case fsSit:
		f.Act, f.timer = "sit", 60+rand.Intn(80)
	default:
		f.state, f.Act, f.timer = fsIdle, "idle", 15+rand.Intn(25)
	}
}

// folkPlan picks f's next errand: wander the yard, work, sit at the fire, or
// simply stand a while. A watcher on night duty only ever sits by the fire.
func (r *Room) folkPlan(f *Folk, night bool) {
	c := &r.camps[f.Camp]
	fx, fy := float64(c.FireX)+0.5, float64(c.FireY)+0.5
	roll := rand.Float64()
	next := fsIdle
	switch {
	case night:
		next = fsSit
	case f.child:
		if roll < 0.2 {
			next = fsSit
		} else if roll < 0.5 {
			f.begin(fsIdle)
			return
		}
	case roll < 0.35:
		// wander
	case roll < 0.65:
		next = fsWork
	case roll < 0.85:
		next = fsSit
	default:
		f.begin(fsIdle)
		return
	}
	if next == fsWork {
		f.work = folkWork(f.Kind)
	}
	// a destination: by the fire to sit, anywhere in the yard otherwise
	for try := 0; try < 8; try++ {
		var tx, ty float64
		if next == fsSit {
			a := rand.Float64() * 2 * math.Pi
			tx, ty = fx+math.Cos(a)*1.5, fy+math.Sin(a)*1.5
		} else {
			a, d := rand.Float64()*2*math.Pi, 1.5+rand.Float64()*(folkYardR-1.5)
			tx, ty = fx+math.Cos(a)*d, fy+math.Sin(a)*d
		}
		if r.folkWalkable(tx, ty) {
			f.tx, f.ty, f.next, f.state = tx, ty, next, fsWalk
			// time to get there with room for a detour, then give up
			f.timer = int(math.Hypot(tx-f.X, ty-f.Y)/folkWalkSp*1.5) + 10
			return
		}
	}
	f.begin(fsIdle)
}

// folkWork: the work each kind does, matching the animation sets they have.
func folkWork(kind string) string {
	switch kind {
	case "villager":
		if rand.Float64() < 0.5 {
			return "build"
		}
		return "collect"
	case "villager2", "elder_yvenne":
		if rand.Float64() < 0.5 {
			return "craft"
		}
		return "collect"
	}
	return "collect"
}

func (r *Room) folkNearPlayer(f *Folk) bool {
	for _, q := range r.playerOrder {
		if q.Z == 0 && math.Hypot(q.X-f.X, q.Y-f.Y) < folkTalkR {
			return true
		}
	}
	return false
}

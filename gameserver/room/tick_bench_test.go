package room

import (
	"fmt"
	"testing"

	"hearth/gameserver/world"
)

// Tick cost is the whole reason this server is in Go: the legacy Node sim tick
// walks every creature, every animal and every player once per 200 ms, single
// threaded, and creature AI is the heaviest thing in it. These benchmarks
// measure onSimTick with a realistic — and then a deliberately unrealistic —
// population, so a regression shows up as a number rather than as a stutter.
//
// The budget is 200 ms per tick (TickMS). Anything under ~2 ms leaves the loop
// effectively idle.

// benchRoom builds a room with a populated world: nPlayers players spread over
// an open patch, nCre creatures of assorted types, nAni animals and nStruct
// structures for the brute scan and the erosion pass to chew on.
func benchRoom(b *testing.B, nPlayers, nCre, nAni, nStruct int) *Room {
	b.Helper()
	if sharedWorld == nil {
		sharedWorld = world.GenWorld("hearth-1")
	}
	r, err := New(Config{Seed: "hearth-1", World: sharedWorld})
	if err != nil {
		b.Fatal(err)
	}
	now := int64(1_700_000_000_000)
	r.nowFn = func() int64 { return now }

	// Open grass, so creature steering actually moves rather than being turned
	// back by terrain on every step (the cheap path).
	var gx, gy float64
	for i := range r.world.Tiles {
		if r.world.Tiles[i] != world.TGrass {
			continue
		}
		x, y := i%world.SIZE, i/world.SIZE
		if x < 60 || y < 60 || x >= world.SIZE-60 || y >= world.SIZE-60 {
			continue
		}
		gx, gy = float64(x), float64(y)
		break
	}

	for n := 0; n < nPlayers; n++ {
		s := NewSession(fmt.Sprintf("bench%02d", n), fmt.Sprintf("u%02d", n), "Bench", "t")
		// A benchmark must never block on a full outbound queue, and it must
		// never let dropSlow reap its own players mid-measurement, so each
		// session gets a drain goroutine. It touches no room state.
		go func() {
			for range s.Out {
			}
		}()
		p := newPlayer(s, [2]int{int(gx) + n, int(gy)}, now, r.defs)
		p.chunkInit = true
		p.chunkCX, p.chunkCY = chunkOf(p.X, p.Y)
		r.players[s.ID] = p
		r.playerOrder = append(r.playerOrder, p)
	}

	// A spread of types so every AI branch is represented: chase, orbit,
	// drift, siege, telegraph.
	mix := []string{"crawler", "crawler", "crawler", "stalker", "husk_wolf",
		"brute", "wisp", "frost_wraith", "drowned", "bog_shambler", "blight_lancer"}
	for n := 0; n < nCre; n++ {
		typ := mix[n%len(mix)]
		ct := creTypes[typ]
		// ring the players at chase distance so the AI is on its hot path
		x := gx + float64(n%25) - 12
		y := gy + float64(n/25) - 6
		r.newCreature(x, y, ct.hpBase+ct.hpStr*3, typ, ti(x, y), true)
	}
	for n := 0; n < nAni; n++ {
		r.nextAni++
		x, y := gx+float64(n%10)-5, gy+float64(n/10)-3
		r.addAnimal(&Animal{ID: "a" + itoa(r.nextAni), X: x, Y: y, HP: 2,
			Type: animalOrder[n%len(animalOrder)], Home: world.TGrass})
	}
	for n := 0; n < nStruct; n++ {
		i := ti(gx+float64(n%40)-20, gy+float64(n/40)+8)
		r.structures[i] = &Structure{Kind: "wall", HP: 200, Lvl: 1}
	}
	// three monoliths lit: strength 4, the mid-to-late-game state
	r.mono = [4]bool{true, true, true, false}
	return r
}

// BenchmarkSimTickRealistic is the population the game actually reaches: four
// players, the night cap at strength 4 (18 creatures), the wildlife cap (20)
// and a built-up base.
func BenchmarkSimTickRealistic(b *testing.B) {
	r := benchRoom(b, 4, 18, 20, 60)
	r.time = 0.8 // night: the busiest state
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.tickN++
		r.onSimTick()
	}
}

// BenchmarkSimTickWave is the worst case the rules permit: the wave cap of 20
// creatures, all converging on one Engine, with a full base to chew through.
func BenchmarkSimTickWave(b *testing.B) {
	r := benchRoom(b, 4, 20, 20, 120)
	r.time = 0.8
	engine := ti(r.playerOrder[0].X+10, r.playerOrder[0].Y+10)
	r.structures[engine] = &Structure{Kind: "engine", HP: 100000, Lvl: 1}
	r.wave = &waveState{until: r.now() + 240000, engineI: engine}
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.tickN++
		r.onSimTick()
	}
}

// BenchmarkSimTickOverload is far past anything the spawn cap allows. It exists
// to show the headroom, and to make the cost curve visible if someone later
// raises the cap.
func BenchmarkSimTickOverload(b *testing.B) {
	r := benchRoom(b, 16, 200, 200, 400)
	r.time = 0.8
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.tickN++
		r.onSimTick()
	}
}

// BenchmarkCreatureAIOnly isolates the creature pass from broadcasting, so a
// regression can be attributed to the AI rather than to JSON encoding.
func BenchmarkCreatureAIOnly(b *testing.B) {
	r := benchRoom(b, 4, 18, 0, 60)
	r.time = 0.8
	now := r.now()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		r.tickN++
		r.creatureTick(4, now)
	}
}

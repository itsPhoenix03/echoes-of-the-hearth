package hosting

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"hearth/gameserver/persist"
	"hearth/gameserver/room"
	"hearth/gameserver/world"
)

// Worldgen is ~2s and memory-heavy, so the whole package shares one generated
// world. It is only ever read (no room writes world.Tiles), which is exactly the
// sharing room.Config.World exists for.
var (
	sharedOnce  sync.Once
	sharedWorld *world.World
)

func testWorld() *world.World {
	sharedOnce.Do(func() { sharedWorld = world.GenWorld("hearth-1") })
	return sharedWorld
}

func quietLogger(t *testing.T) *log.Logger {
	t.Helper()
	return log.New(testWriter{t}, "", 0)
}

type testWriter struct{ t *testing.T }

func (w testWriter) Write(b []byte) (int, error) {
	w.t.Log(strings.TrimRight(string(b), "\n"))
	return len(b), nil
}

// isolateEnv clears every variable LoadConfig reads, so a test never picks up
// the developer's shell or the repo's own control/worlds.json.
func isolateEnv(t *testing.T) {
	t.Helper()
	for _, k := range []string{
		"HEARTH_INSTANCE_ID", "HEARTH_WORLDS", "HEARTH_WORLD_ID", "HEARTH_WORLD_SEED",
		"HEARTH_SEED", "HEARTH_WORLD_NAME", "HEARTH_EAGER_WORLDS", "HEARTH_SAVE_DIR",
		"HEARTH_SAVE_PATH",
	} {
		t.Setenv(k, "")
	}
	// A path that cannot exist, so the file source is skipped deterministically.
	t.Setenv("HEARTH_WORLDS_FILE", filepath.Join(t.TempDir(), "no-such-worlds.json"))
}

// --- config ---------------------------------------------------------------

// The zero-config case is the one the client and gameserver/test-go.mjs depend
// on: one world called "default", seed hearth-1, instance "local".
func TestLoadConfigDefaultsToTheSingleLocalWorld(t *testing.T) {
	isolateEnv(t)
	cfg, err := LoadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.InstanceID != "local" || len(cfg.Worlds) != 1 {
		t.Fatalf("got instance=%q worlds=%+v, want one world on 'local'", cfg.InstanceID, cfg.Worlds)
	}
	w := cfg.Worlds[0]
	if w.WorldID != "default" || w.Seed != "hearth-1" || w.InstanceID != "local" {
		t.Fatalf("default world = %+v, want default/hearth-1/local", w)
	}
	if cfg.Eager {
		t.Fatal("rooms must be lazy unless HEARTH_EAGER_WORLDS is set")
	}
}

// HEARTH_SEED is what every existing script sets, so it must still choose the
// seed of the single default world.
func TestLoadConfigHonoursLegacySeedEnv(t *testing.T) {
	isolateEnv(t)
	t.Setenv("HEARTH_SEED", "seed-legacy")
	cfg, err := LoadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Worlds[0].Seed != "seed-legacy" {
		t.Fatalf("seed = %q, want seed-legacy", cfg.Worlds[0].Seed)
	}
}

// One registry describes the whole deployment; a process hosts only the slice
// bound to its own instanceId. Entries for other instances are not an error,
// they are simply someone else's worlds.
func TestLoadConfigHostsOnlyItsOwnInstance(t *testing.T) {
	isolateEnv(t)
	t.Setenv("HEARTH_INSTANCE_ID", "inst-2")
	t.Setenv("HEARTH_WORLDS", `[
		{"worldId":"default","seed":"hearth-1","instanceId":"local","ws":"ws://localhost:8082"},
		{"worldId":"frontier","seed":"seed-frontier","instanceId":"inst-2","ws":"ws://localhost:8083"},
		{"worldId":"reach","seed":"seed-reach","instanceId":"inst-2","ws":"ws://localhost:8083"}
	]`)
	cfg, err := LoadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Worlds) != 2 || cfg.Worlds[0].WorldID != "frontier" || cfg.Worlds[1].WorldID != "reach" {
		t.Fatalf("hosted worlds = %+v, want frontier and reach in config order", cfg.Worlds)
	}
	if _, ok := cfg.World("default"); ok {
		t.Fatal("a world allocated to another instance must not be hosted here")
	}
}

// The same JSON in a file, which is how control/worlds.json configures both
// processes at once.
func TestLoadConfigReadsAWorldsFile(t *testing.T) {
	isolateEnv(t)
	path := filepath.Join(t.TempDir(), "worlds.json")
	if err := os.WriteFile(path, []byte(`[{"worldId":"alpha","seed":"s-a","instanceId":"local","ws":"ws://x"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("HEARTH_WORLDS_FILE", path)
	cfg, err := LoadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Worlds) != 1 || cfg.Worlds[0].WorldID != "alpha" || cfg.Worlds[0].Seed != "s-a" {
		t.Fatalf("worlds = %+v, want alpha/s-a from the file", cfg.Worlds)
	}
	if !strings.Contains(cfg.Source, "worlds.json") {
		t.Fatalf("Source = %q, want it to name the file", cfg.Source)
	}
}

// A registry that names worlds but none of ours is a misconfigured process, not
// an idle one: failing at boot beats accepting nobody for an unexplained reason.
func TestLoadConfigFailsWhenNoWorldIsOurs(t *testing.T) {
	isolateEnv(t)
	t.Setenv("HEARTH_INSTANCE_ID", "ghost")
	t.Setenv("HEARTH_WORLDS", `[{"worldId":"default","seed":"hearth-1","instanceId":"local","ws":"ws://x"}]`)
	if _, err := LoadConfig(nil); err == nil {
		t.Fatal("expected a boot error when the registry hosts nothing on this instance")
	}
}

// A worldId names a save file, so a traversal attempt in config must be
// rejected rather than writing outside the save directory.
func TestLoadConfigRejectsUnsafeWorldIDs(t *testing.T) {
	isolateEnv(t)
	t.Setenv("HEARTH_WORLDS", `[
		{"worldId":"../../server/save","instanceId":"local","ws":"ws://x"},
		{"worldId":"ok","instanceId":"local","ws":"ws://x"}
	]`)
	cfg, err := LoadConfig(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(cfg.Worlds) != 1 || cfg.Worlds[0].WorldID != "ok" {
		t.Fatalf("worlds = %+v, want the traversing entry dropped", cfg.Worlds)
	}
}

func TestSavePathIsPerWorld(t *testing.T) {
	cfg := Config{
		SaveDir: "saves",
		Worlds:  []WorldSpec{{WorldID: "default"}, {WorldID: "frontier"}},
	}
	a, b := cfg.SavePath("default"), cfg.SavePath("frontier")
	if a == b {
		t.Fatalf("two worlds share the save file %q", a)
	}
	if a != filepath.Join("saves", "world.default.save.json") {
		t.Fatalf("SavePath(default) = %q", a)
	}
	// The legacy single-world override still works, and is ignored (by
	// LoadConfig) once more than one world is hosted.
	one := Config{Worlds: []WorldSpec{{WorldID: "default"}}, SavePathOverride: "world.save.json"}
	if got := one.SavePath("default"); got != "world.save.json" {
		t.Fatalf("HEARTH_SAVE_PATH override = %q", got)
	}
	many := Config{Worlds: cfg.Worlds, SavePathOverride: "world.save.json"}
	if got := many.SavePath("default"); got == "world.save.json" {
		t.Fatal("a single-file override must never apply to a multi-world process")
	}
}

// --- routing --------------------------------------------------------------

// newTestManager builds a manager whose rooms skip worldgen but are otherwise
// real rooms, each with its own state and its own store.
func newTestManager(t *testing.T, cfg Config) (*Manager, context.Context) {
	t.Helper()
	m := NewManager(Options{Config: cfg, Logger: quietLogger(t), SaveEvery: time.Hour})
	m.build = func(spec WorldSpec) (*room.Room, error) {
		var store persist.Store = persist.NopStore{}
		if cfg.SaveDir != "" {
			store = persist.NewJSONStore(cfg.SavePath(spec.WorldID))
		}
		return room.New(room.Config{
			WorldID: spec.WorldID, Seed: spec.Seed, World: testWorld(),
			Store: store, SaveEvery: time.Hour, Logger: quietLogger(t),
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(func() { cancel(); m.Wait() })
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	return m, ctx
}

func twoWorlds() Config {
	return Config{
		InstanceID: "local",
		Worlds: []WorldSpec{
			{WorldID: "default", Seed: "hearth-1", InstanceID: "local", Name: "default"},
			{WorldID: "frontier", Seed: "hearth-1", InstanceID: "local", Name: "frontier"},
		},
	}
}

// The allocation boundary: a ticket is valid, correctly signed, and still
// refused, because it was issued for a world some other process hosts.
func TestResolveRejectsAnotherInstancesTicket(t *testing.T) {
	m, ctx := newTestManager(t, twoWorlds())

	if _, err := m.Resolve(ctx, "inst-2", "default"); err != ErrWrongInstance {
		t.Fatalf("err = %v, want ErrWrongInstance", err)
	}
	if got := ErrWrongInstance.AuthFailReason(); got != "wrong-instance" {
		t.Fatalf("authfail reason = %q", got)
	}
	if _, err := m.Resolve(ctx, "", "default"); err != ErrWrongInstance {
		t.Fatalf("an empty instanceId must not pass: %v", err)
	}
	if _, err := m.Resolve(ctx, "local", "nowhere"); err != ErrUnknownWorld {
		t.Fatalf("err = %v, want ErrUnknownWorld", err)
	}
	// A refused ticket must not have built anything.
	if n := len(m.Running()); n != 0 {
		t.Fatalf("%d rooms were built by refused tickets", n)
	}
}

// Lazy creation: nothing is built until someone joins, and then exactly one
// room exists for that world no matter how many players arrive at once. Run
// this with -race.
func TestResolveBuildsEachWorldExactlyOnce(t *testing.T) {
	cfg := twoWorlds()
	m := NewManager(Options{Config: cfg, Logger: quietLogger(t)})
	var builds int32
	m.build = func(spec WorldSpec) (*room.Room, error) {
		atomic.AddInt32(&builds, 1)
		time.Sleep(50 * time.Millisecond) // stand in for worldgen
		return room.New(room.Config{
			WorldID: spec.WorldID, Seed: spec.Seed, World: testWorld(),
			SaveEvery: time.Hour, Logger: quietLogger(t),
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer func() { cancel(); m.Wait() }()
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	if n := atomic.LoadInt32(&builds); n != 0 {
		t.Fatalf("%d worlds were built at boot, want lazy creation", n)
	}

	const racers = 8
	got := make([]*room.Room, racers)
	var wg sync.WaitGroup
	for i := 0; i < racers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			r, err := m.Resolve(ctx, "local", "default")
			if err != nil {
				t.Errorf("Resolve: %v", err)
				return
			}
			got[i] = r
		}(i)
	}
	wg.Wait()
	if n := atomic.LoadInt32(&builds); n != 1 {
		t.Fatalf("%d simultaneous first-joins built the world %d times", racers, n)
	}
	for i, r := range got {
		if r == nil || r != got[0] {
			t.Fatalf("racer %d got a different room: %p vs %p", i, r, got[0])
		}
	}
	// The other configured world is still untouched.
	if n := len(m.Running()); n != 1 {
		t.Fatalf("running rooms = %v, want only 'default'", m.Running())
	}
}

// Eager mode is the documented alternative: every world up before the listener
// accepts anything.
func TestEagerBuildsEveryWorldAtStart(t *testing.T) {
	cfg := twoWorlds()
	cfg.Eager = true
	m, _ := newTestManager(t, cfg)
	if n := len(m.Running()); n != 2 {
		t.Fatalf("running rooms = %v, want both worlds built at boot", m.Running())
	}
}

// --- isolation ------------------------------------------------------------

// The bug class that matters most: a frame broadcast in one world reaching a
// player in another. Two rooms, three players, and an event (a join) that
// broadcasts to everyone in its room — the player in the other world must see
// nothing of it.
func TestBroadcastsNeverCrossWorlds(t *testing.T) {
	m, ctx := newTestManager(t, twoWorlds())

	ra, err := m.Resolve(ctx, "local", "default")
	if err != nil {
		t.Fatal(err)
	}
	rb, err := m.Resolve(ctx, "local", "frontier")
	if err != nil {
		t.Fatal(err)
	}
	if ra == rb {
		t.Fatal("two worlds resolved to the same room")
	}
	if ra.WorldID() != "default" || rb.WorldID() != "frontier" {
		t.Fatalf("rooms are wired to %q and %q, want default and frontier", ra.WorldID(), rb.WorldID())
	}

	a1 := room.NewSession("a1", "u_a1", "A-One", "test")
	b1 := room.NewSession("b1", "u_b1", "B-One", "test")
	if err := ra.Join(ctx, a1); err != nil {
		t.Fatal(err)
	}
	if err := rb.Join(ctx, b1); err != nil {
		t.Fatal(err)
	}
	if f := waitFor(t, a1, "init"); f["id"] != "a1" {
		t.Fatalf("a1's init is for %v", f["id"])
	}
	if f := waitFor(t, b1, "init"); f["id"] != "b1" {
		t.Fatalf("b1's init is for %v", f["id"])
	}

	// a2 joins world "default". Its `pj` must reach a1 and nobody else.
	a2 := room.NewSession("a2", "u_a2", "A-Two", "test")
	if err := ra.Join(ctx, a2); err != nil {
		t.Fatal(err)
	}
	// (a1 has already seen the `pj` for its own join; wait for a2's.)
	waitForFrame(t, a1, func(m map[string]any) bool { return m["t"] == "pj" && m["id"] == "a2" })

	// a2 leaves: `pl` is the other room-wide broadcast.
	ra.Leave(a2)
	waitForFrame(t, a1, func(m map[string]any) bool { return m["t"] == "pl" && m["id"] == "a2" })

	// Everything b1 received in the meantime: not one frame may mention a
	// player from the other world, and b1's own room must still be alive.
	frames := drainFor(t, b1, 300*time.Millisecond)
	for _, f := range frames {
		if id, _ := f["id"].(string); id == "a1" || id == "a2" {
			t.Fatalf("a frame from world 'default' reached a player in 'frontier': %v", f)
		}
	}

	// And the registries really are separate: b1 joining does not appear in
	// a1's world either.
	b2 := room.NewSession("b2", "u_b2", "B-Two", "test")
	if err := rb.Join(ctx, b2); err != nil {
		t.Fatal(err)
	}
	waitForFrame(t, b1, func(m map[string]any) bool { return m["t"] == "pj" && m["id"] == "b2" })
	for _, f := range drainFor(t, a1, 300*time.Millisecond) {
		if id, _ := f["id"].(string); id == "b1" || id == "b2" {
			t.Fatalf("a frame from world 'frontier' reached a player in 'default': %v", f)
		}
	}
}

// Two rooms must never write the same file: a shared save would let one world
// overwrite the other's structures, chests and player profiles.
func TestEachWorldSavesToItsOwnFile(t *testing.T) {
	cfg := twoWorlds()
	cfg.SaveDir = t.TempDir()

	m := NewManager(Options{Config: cfg, Logger: quietLogger(t)})
	m.build = func(spec WorldSpec) (*room.Room, error) {
		return room.New(room.Config{
			WorldID: spec.WorldID, Seed: spec.Seed, World: testWorld(),
			Store:  persist.NewJSONStore(cfg.SavePath(spec.WorldID)),
			Logger: quietLogger(t),
		})
	}
	ctx, cancel := context.WithCancel(context.Background())
	if err := m.Start(ctx); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"default", "frontier"} {
		r, err := m.Resolve(ctx, "local", id)
		if err != nil {
			t.Fatal(err)
		}
		s := room.NewSession("s_"+id, "u_"+id, "P-"+id, "test")
		if err := r.Join(ctx, s); err != nil {
			t.Fatal(err)
		}
		waitFor(t, s, "init")
	}
	cancel()
	m.Wait() // each room writes its final save on the way out

	seen := map[string]string{}
	for _, id := range []string{"default", "frontier"} {
		path := cfg.SavePath(id)
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("world %q wrote no save: %v", id, err)
		}
		var snap struct {
			Profiles map[string]json.RawMessage `json:"profiles"`
		}
		if err := json.Unmarshal(b, &snap); err != nil {
			t.Fatal(err)
		}
		if _, ok := snap.Profiles["u_"+id]; !ok {
			t.Fatalf("%s holds profiles %v, not the player who was in that world", path, keys(snap.Profiles))
		}
		if len(snap.Profiles) != 1 {
			t.Fatalf("%s holds %d profiles, so the two worlds share state", path, len(snap.Profiles))
		}
		seen[id] = path
	}
	if seen["default"] == seen["frontier"] {
		t.Fatal("both worlds wrote the same file")
	}
	// The legacy server's save is never ours to touch.
	if _, err := os.Stat(filepath.Join(cfg.SaveDir, "save.json")); err == nil {
		t.Fatal("the Go server wrote a bare save.json")
	}
}

// --- helpers --------------------------------------------------------------

// waitFor reads a session's outbound queue until a frame of type t arrives.
func waitFor(t *testing.T, s *room.Session, typ string) map[string]any {
	t.Helper()
	return waitForFrame(t, s, func(m map[string]any) bool { return m["t"] == typ })
}

// waitForFrame reads a session's outbound queue until a frame matches. Frames
// before the match are discarded, which is what a real client's reader does
// with traffic it is not waiting on.
func waitForFrame(t *testing.T, s *room.Session, want func(map[string]any) bool) map[string]any {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case b := <-s.Out:
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			if want(m) {
				return m
			}
		case <-deadline:
			t.Fatalf("no matching frame for session %s within 5s", s.ID)
		}
	}
}

// drainFor collects everything queued for a session over a window.
func drainFor(t *testing.T, s *room.Session, d time.Duration) []map[string]any {
	t.Helper()
	var out []map[string]any
	deadline := time.After(d)
	for {
		select {
		case b := <-s.Out:
			var m map[string]any
			if err := json.Unmarshal(b, &m); err != nil {
				t.Fatal(err)
			}
			out = append(out, m)
		case <-deadline:
			return out
		}
	}
}

func keys(m map[string]json.RawMessage) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

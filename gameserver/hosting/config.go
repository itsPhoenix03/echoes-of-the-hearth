// Package hosting turns "which worlds does this process host" into config, and
// routes an authenticated ticket to the room that hosts its world.
//
// # Why this exists
//
// The control plane allocates: `POST /api/join` resolves a requested world to a
// registry entry and signs `worldId` + `instanceId` into the ticket
// (control/PROTOCOL.md §1, §3.1). A client cannot choose its own binding. This
// package is the other half — the hosting side of the same registry. It answers
// two questions and nothing else:
//
//   - is this ticket's `instanceId` one this process is? If not the connection
//     is refused; allocation is a boundary, not a hint.
//   - which `*room.Room` serves this ticket's `worldId`?
//
// # Concurrency
//
// The Manager has a mutex; rooms do not. That is not a contradiction with the
// contract at the top of room/room.go — the lock guards the *registry of rooms*
// (a map of worldId -> room, plus the once-only build of each), never any game
// state. Each room still owns all of its state on its own single Run goroutine,
// and no two rooms share anything mutable. A player in world A and a player in
// world B touch two entirely separate object graphs.
package hosting

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"hearth/gameserver/room"
)

// WorldSpec is one hosted world: the same record `control/store.js` keeps, minus
// the fields only the control plane cares about (`ws`, `name` is kept for logs).
type WorldSpec struct {
	WorldID    string `json:"worldId"`
	Seed       string `json:"seed"`
	InstanceID string `json:"instanceId"`
	Name       string `json:"name"`
	// MaxPlayers caps concurrent players in this world. Absent, zero or
	// negative means room.DefaultMaxPlayers (4, the PLAN.md co-op target). The
	// control plane ignores the field, which is deliberate: allocation is not
	// admission, and only the room that hosts the world knows who is actually
	// connected — so the cap is enforced there (room.Room.admit) and the
	// registry only configures it.
	MaxPlayers int `json:"maxPlayers"`
}

// Config is the hosting configuration of one game-server process.
type Config struct {
	// InstanceID is who this process is. A ticket bound to any other instance
	// is refused (see Manager.Resolve).
	InstanceID string
	// Worlds are the worlds this process hosts, in config order.
	Worlds []WorldSpec
	// Source names where the registry came from, for the boot log.
	Source string
	// Eager reports whether every world should be built at boot rather than on
	// its first join.
	Eager bool
	// SaveDir is the directory per-world save files live in. Empty means the
	// working directory.
	SaveDir string
	// SavePathOverride, when set, is the save file for the one hosted world. It
	// is the legacy HEARTH_SAVE_PATH escape hatch and is ignored (with a
	// warning from LoadConfig) when more than one world is hosted.
	SavePathOverride string
}

// defaultWorldsFile is the registry both processes read. The control plane's
// copy is control/worlds.json (control/store.js), and the game server reads the
// very same file so the two can never disagree about which instance hosts what.
var defaultWorldsFile = filepath.Join("control", "worlds.json")

// LoadConfig builds the hosting config from the environment.
//
// Registry sources, first one that yields at least one valid entry wins — the
// same order and the same shapes as control/store.js, deliberately, so one
// worlds.json (or one HEARTH_WORLDS value) can configure both processes:
//
//  1. HEARTH_WORLDS        — a JSON array, for containers with no writable fs
//  2. HEARTH_WORLDS_FILE   — a JSON array in a file; defaults to the repo's
//     control/worlds.json, found by walking up from the working directory
//  3. the single-world env vars HEARTH_WORLD_ID / HEARTH_WORLD_SEED (or the
//     historical HEARTH_SEED) / HEARTH_INSTANCE_ID, defaulting to
//     default / hearth-1 / local — i.e. the zero-config setup still works.
//
// Per-world player caps ride in the registry as `maxPlayers`; the single-world
// fallback reads HEARTH_WORLD_MAX_PLAYERS (or HEARTH_MAX_PLAYERS). Unset
// anywhere means 4.
//
// Entries belonging to another instanceId are skipped: a registry lists every
// world in the deployment, and each process hosts its own slice of it. A
// registry that names worlds but none for this instance is a configuration
// error, not an empty process, so it fails loudly.
func LoadConfig(logf func(string, ...any)) (Config, error) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	cfg := Config{
		InstanceID:       envOr("HEARTH_INSTANCE_ID", "local"),
		Eager:            os.Getenv("HEARTH_EAGER_WORLDS") != "",
		SaveDir:          os.Getenv("HEARTH_SAVE_DIR"),
		SavePathOverride: os.Getenv("HEARTH_SAVE_PATH"),
	}

	all, source, err := loadRegistry(cfg.InstanceID, logf)
	if err != nil {
		return Config{}, err
	}
	cfg.Source = source

	for _, w := range all {
		if w.InstanceID != cfg.InstanceID {
			continue
		}
		cfg.Worlds = append(cfg.Worlds, w)
	}
	if len(cfg.Worlds) == 0 {
		hosts := make([]string, 0, len(all))
		for _, w := range all {
			hosts = append(hosts, w.WorldID+"@"+w.InstanceID)
		}
		sort.Strings(hosts)
		return Config{}, fmt.Errorf("hosting: %s lists %v, none of them on instanceId=%q — set HEARTH_INSTANCE_ID to one of the instances in the registry",
			source, hosts, cfg.InstanceID)
	}
	if cfg.SavePathOverride != "" && len(cfg.Worlds) > 1 {
		logf("[hearth] ignoring HEARTH_SAVE_PATH: %d worlds are hosted, so each needs its own save file", len(cfg.Worlds))
		cfg.SavePathOverride = ""
	}
	return cfg, nil
}

func loadRegistry(instanceID string, logf func(string, ...any)) ([]WorldSpec, string, error) {
	if raw := os.Getenv("HEARTH_WORLDS"); raw != "" {
		list, err := parseWorldList([]byte(raw), "HEARTH_WORLDS", logf)
		if err != nil {
			return nil, "", err
		}
		if len(list) > 0 {
			return list, "HEARTH_WORLDS", nil
		}
	}
	if path, ok := resolveWorldsFile(); ok {
		b, err := os.ReadFile(path)
		if err == nil {
			list, err := parseWorldList(b, path, logf)
			if err != nil {
				return nil, "", err
			}
			if len(list) > 0 {
				return list, path, nil
			}
		}
	}
	// The historical single-world setup. Note HEARTH_SEED is still honoured:
	// it is what every existing script and the README already set.
	w, err := normalizeWorld(WorldSpec{
		WorldID:    envOr("HEARTH_WORLD_ID", "default"),
		Seed:       envOr("HEARTH_WORLD_SEED", envOr("HEARTH_SEED", "hearth-1")),
		InstanceID: instanceID,
		Name:       os.Getenv("HEARTH_WORLD_NAME"),
		MaxPlayers: envInt(envOr("HEARTH_WORLD_MAX_PLAYERS", os.Getenv("HEARTH_MAX_PLAYERS")), logf),
	})
	if err != nil {
		return nil, "", err
	}
	return []WorldSpec{w}, "the HEARTH_WORLD_* environment defaults", nil
}

// resolveWorldsFile honours HEARTH_WORLDS_FILE, otherwise walks up from the
// working directory (and then the executable) for control/worlds.json — the
// same discovery defs.Resolve uses for shared/defs.json, so `go run
// ./cmd/hearthd` from gameserver/ and a binary run from the repo root find the
// same file.
func resolveWorldsFile() (string, bool) {
	if p := os.Getenv("HEARTH_WORLDS_FILE"); p != "" {
		return p, true
	}
	var roots []string
	if wd, err := os.Getwd(); err == nil {
		roots = append(roots, wd)
	}
	if exe, err := os.Executable(); err == nil {
		roots = append(roots, filepath.Dir(exe))
	}
	for _, root := range roots {
		dir := root
		for i := 0; i < 8; i++ {
			cand := filepath.Join(dir, defaultWorldsFile)
			if _, err := os.Stat(cand); err == nil {
				return cand, true
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return "", false
}

// parseWorldList mirrors control/store.js: malformed or duplicate entries are
// logged and skipped rather than taking the service down, but a payload that is
// not a JSON array at all is an operator mistake worth failing on.
func parseWorldList(b []byte, source string, logf func(string, ...any)) ([]WorldSpec, error) {
	var raw []WorldSpec
	if err := json.Unmarshal(b, &raw); err != nil {
		return nil, fmt.Errorf("hosting: %s is not a JSON array of world objects: %w", source, err)
	}
	out := make([]WorldSpec, 0, len(raw))
	seen := map[string]bool{}
	for _, entry := range raw {
		w, err := normalizeWorld(entry)
		if err != nil {
			logf("[hearth] ignoring a world entry in %s: %v", source, err)
			continue
		}
		if seen[w.WorldID] {
			logf("[hearth] duplicate worldId %q in %s, keeping the first", w.WorldID, source)
			continue
		}
		seen[w.WorldID] = true
		out = append(out, w)
	}
	return out, nil
}

// normalizeWorld applies control/store.js's defaults, plus one rule the control
// plane does not need: a worldId is part of a save-file name here, so it must be
// a plain identifier and can never contain a path separator or traversal.
func normalizeWorld(w WorldSpec) (WorldSpec, error) {
	w.WorldID = strings.TrimSpace(w.WorldID)
	if w.WorldID == "" {
		return WorldSpec{}, fmt.Errorf("worldId is required")
	}
	if !safeID(w.WorldID) {
		return WorldSpec{}, fmt.Errorf("worldId %q must be 1-64 chars of [A-Za-z0-9._-] (it names a save file)", w.WorldID)
	}
	if w.Seed = strings.TrimSpace(w.Seed); w.Seed == "" {
		w.Seed = "hearth-1"
	}
	if w.InstanceID = strings.TrimSpace(w.InstanceID); w.InstanceID == "" {
		w.InstanceID = "local"
	}
	if w.Name = strings.TrimSpace(w.Name); w.Name == "" {
		w.Name = w.WorldID
	}
	if w.MaxPlayers <= 0 {
		w.MaxPlayers = room.DefaultMaxPlayers
	}
	return w, nil
}

// envInt parses an optional integer setting. A value that is not a number is a
// typo worth mentioning rather than a reason to refuse to boot; it falls back
// to the default (0, which normalizeWorld turns into DefaultMaxPlayers).
func envInt(raw string, logf func(string, ...any)) int {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		if logf != nil {
			logf("[hearth] ignoring maxPlayers %q: want a positive integer", raw)
		}
		return 0
	}
	return n
}

func safeID(s string) bool {
	if len(s) > 64 || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// World looks up one hosted world.
func (c Config) World(worldID string) (WorldSpec, bool) {
	for _, w := range c.Worlds {
		if w.WorldID == worldID {
			return w, true
		}
	}
	return WorldSpec{}, false
}

// SavePath is where a world's save file lives: `world.<worldId>.save.json` in
// SaveDir. Keying the file by worldId is the whole point — two worlds in one
// process must never be able to clobber each other's save. The legacy Node
// server's server/save.json is never touched by any of this.
func (c Config) SavePath(worldID string) string {
	if c.SavePathOverride != "" && len(c.Worlds) == 1 {
		return c.SavePathOverride
	}
	return filepath.Join(c.SaveDir, "world."+worldID+".save.json")
}

// Summary is the one-line boot log of what this process hosts.
func (c Config) Summary() string {
	parts := make([]string, 0, len(c.Worlds))
	for _, w := range c.Worlds {
		parts = append(parts, fmt.Sprintf("%s(seed=%s max=%d)", w.WorldID, w.Seed, w.MaxPlayers))
	}
	mode := "lazy"
	if c.Eager {
		mode = "eager"
	}
	return fmt.Sprintf("instance=%s worlds=[%s] build=%s from %s",
		c.InstanceID, strings.Join(parts, " "), mode, c.Source)
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

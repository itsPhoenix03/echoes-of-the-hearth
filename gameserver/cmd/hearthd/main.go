// Command hearthd is the Go authoritative game server. One process hosts one
// *instance*, which may serve several worlds; each world is a room with its own
// goroutine, its own state and its own save file, and a connection is routed to
// one of them by the signed ticket it presents.
//
// Environment:
//
//	HEARTH_GAME_PORT      listen port                     (default 8082)
//	HEARTH_INSTANCE_ID    which instance this process is  (default local)
//	HEARTH_WORLDS         JSON array of world records, as control/store.js reads
//	HEARTH_WORLDS_FILE    path to the same JSON           (default: control/worlds.json, found by walking up)
//	HEARTH_WORLD_ID       single-world fallback id        (default default)
//	HEARTH_WORLD_SEED     single-world fallback seed      (default $HEARTH_SEED, else hearth-1)
//	HEARTH_SEED           historical single-world seed    (default hearth-1)
//	HEARTH_EAGER_WORLDS   build every world at boot instead of on first join
//	HEARTH_TICKET_PUBKEY  base64 raw 32-byte Ed25519 key  (skips the fetch)
//	HEARTH_PUBKEY_URL     control-plane pubkey endpoint   (default http://localhost:8090/api/pubkey)
//	HEARTH_ALLOW_WARP     enables the unvalidated test teleport when set
//	HEARTH_SAVE_DIR       directory for per-world saves   (default: working directory)
//	HEARTH_SAVE_PATH      save file, single-world setups only (legacy override)
//	HEARTH_NO_PERSIST     set to disable persistence entirely
//	HEARTH_DEFS_PATH      shared/defs.json                (default: found by walking up)
//	DEV                   shortens crop growth 30x, as in the legacy server
//
// The `dev` / `devcmd` tester tooling is NOT an env var: it is gated solely on
// the signed `dev` claim the control plane mints per account (docs/10 §10.6).
package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"hearth/gameserver/auth"
	"hearth/gameserver/defs"
	"hearth/gameserver/hosting"
	"hearth/gameserver/net"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	logger := log.New(os.Stdout, "", log.LstdFlags)

	// The rules data is the same shared/defs.json the client and the legacy
	// server read. Fail loudly at boot rather than silently running with an
	// empty recipe table.
	d, err := defs.Load()
	if err != nil {
		logger.Fatalf("[hearth] cannot load shared/defs.json: %v", err)
	}
	logger.Printf("[hearth] rules data: %s (%d recipes, %d crops)", defs.Path(), len(d.Recipes), len(d.Crops))

	hostCfg, err := hosting.LoadConfig(logger.Printf)
	if err != nil {
		logger.Fatalf("[hearth] %v", err)
	}
	logger.Printf("[hearth] hosting %s", hostCfg.Summary())

	verifier, err := loadVerifier(logger)
	if err != nil {
		logger.Fatalf("[hearth] cannot obtain the ticket public key: %v", err)
	}

	mgr := hosting.NewManager(hosting.Options{
		Config:    hostCfg,
		Defs:      d,
		Logger:    logger,
		AllowWarp: os.Getenv("HEARTH_ALLOW_WARP") != "",
		Dev:       os.Getenv("DEV") != "",
		Persist:   os.Getenv("HEARTH_NO_PERSIST") == "",
	})

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// Eager mode builds every world here; lazy mode (the default) builds each
	// one on its first join. Either way the rooms run under ctx, so one signal
	// stops and saves all of them.
	if err := mgr.Start(ctx); err != nil {
		logger.Fatalf("[hearth] world init failed: %v", err)
	}

	srv := &net.Server{Rooms: mgr, Verifier: verifier, Logger: logger}
	httpSrv := &http.Server{
		Addr:              ":" + env("HEARTH_GAME_PORT", "8082"),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		logger.Printf("[hearth] go game server on ws://0.0.0.0%s warp=%v",
			httpSrv.Addr, os.Getenv("HEARTH_ALLOW_WARP") != "")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("[hearth] listen failed: %v", err)
		}
	}()

	<-ctx.Done()
	logger.Printf("[hearth] shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx)
	mgr.Wait() // every room writes its final save before this returns
	logger.Printf("[hearth] saved. bye")
}

// loadVerifier prefers an env-pinned key and otherwise fetches it once from the
// control plane. Either way, every ticket afterwards is verified offline.
func loadVerifier(logger *log.Logger) (*auth.Verifier, error) {
	if raw := os.Getenv("HEARTH_TICKET_PUBKEY"); raw != "" {
		logger.Printf("[hearth] ticket public key: from HEARTH_TICKET_PUBKEY")
		return auth.NewVerifierFromBase64(raw)
	}
	url := env("HEARTH_PUBKEY_URL", "http://localhost:8090/api/pubkey")
	b64, err := auth.FetchPublicKey(url, 5*time.Second)
	if err != nil {
		return nil, err
	}
	logger.Printf("[hearth] ticket public key: fetched from %s", url)
	return auth.NewVerifierFromBase64(b64)
}

// Command hearthd is the Go authoritative game server (Slice 1: connection,
// terrain streaming, movement).
//
// Environment:
//
//	HEARTH_GAME_PORT      listen port                     (default 8082)
//	HEARTH_SEED           world seed                      (default hearth-1)
//	HEARTH_TICKET_PUBKEY  base64 raw 32-byte Ed25519 key  (skips the fetch)
//	HEARTH_PUBKEY_URL     control-plane pubkey endpoint   (default http://localhost:8090/api/pubkey)
//	HEARTH_ALLOW_WARP     enables the unvalidated test teleport when set
//	HEARTH_SAVE_PATH      persistence file                (default gameserver/world.save.json)
//	HEARTH_NO_PERSIST     set to disable persistence entirely
//	HEARTH_DEFS_PATH      shared/defs.json                (default: found by walking up)
//	DEV                   shortens crop growth 30x, as in the legacy server
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
	"hearth/gameserver/net"
	"hearth/gameserver/persist"
	"hearth/gameserver/room"
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

	verifier, err := loadVerifier(logger)
	if err != nil {
		logger.Fatalf("[hearth] cannot obtain the ticket public key: %v", err)
	}

	var store persist.Store = persist.NopStore{}
	if os.Getenv("HEARTH_NO_PERSIST") == "" {
		store = persist.NewJSONStore(env("HEARTH_SAVE_PATH", "world.save.json"))
	}

	r, err := room.New(room.Config{
		Seed:      env("HEARTH_SEED", "hearth-1"),
		AllowWarp: os.Getenv("HEARTH_ALLOW_WARP") != "",
		Dev:       os.Getenv("DEV") != "",
		Defs:      d,
		Store:     store,
		Logger:    logger,
	})
	if err != nil {
		logger.Fatalf("[hearth] world init failed: %v", err)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	roomDone := make(chan struct{})
	go func() { defer close(roomDone); r.Run(ctx) }()

	srv := &net.Server{Room: r, Verifier: verifier, Logger: logger}
	httpSrv := &http.Server{
		Addr:              ":" + env("HEARTH_GAME_PORT", "8082"),
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		spawn := r.Spawn()
		logger.Printf("[hearth] go game server on ws://0.0.0.0%s seed=%s spawn=(%d,%d) warp=%v",
			httpSrv.Addr, env("HEARTH_SEED", "hearth-1"), spawn[0], spawn[1],
			os.Getenv("HEARTH_ALLOW_WARP") != "")
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("[hearth] listen failed: %v", err)
		}
	}()

	<-ctx.Done()
	logger.Printf("[hearth] shutting down")
	shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutCtx)
	<-roomDone
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

# `.agents/` — coordination guide for AI agents on this project

You are working on **Echoes of the Hearth**, a web-based 2D isometric co-op survival sandbox RPG.
This folder is the shared brain for every agent that touches the repo. Read it before doing anything.

---

## 1. Read order (do this first, every session)

| # | File | Why |
|---|------|-----|
| 1 | `.agents/PROJECT_STATE.md` | What is built, what is deliberately deferred, what is next. The single source of truth for status. |
| 2 | `.agents/session-context-dump/` — newest file | What the previous session actually did, decided, and learned. Read at least the most recent one. |
| 3 | `AGENT_GUIDE.html` (repo root) | Architecture, protocol reference, balance tables, known pitfalls. The deep technical reference. |
| 4 | `PLAN.md` (repo root) | Original game design blueprint. Aspirational — much of it is still unbuilt. |
| 5 | `docs/` | Eleven implementation guides. Check `PROJECT_STATE.md` first to see which are done. |

Do **not** start editing before step 1 and 2. Most wasted work on this project has come from an
agent re-deriving something an earlier session already settled.

---

## 2. Non-negotiable rules

### Verification gate
Nothing is "done" until these pass. **Run them yourself; do not trust a subagent's claim** —
three subagent reports in the 2026-09-20 session were wrong in ways only running the suite
revealed. The authoritative server is now **Go**, not `server/index.js`; see
`PROJECT_STATE.md` §2 for the full gate and the reasoning.

```bash
npx tsc --noEmit          # esbuild does NOT type-check. It has caught real crashes.
npx vite build
cd gameserver && go build ./... && go vet ./... && gofmt -l . && go test ./...
node tools/worldparity/compare.mjs    # MANDATORY after any worldgen edit
npm run test:control

# wire suites — need a FRESH server (they are stateful):
rm -f gameserver/world*.save.json
npm run stack:servers     # one terminal (sets HEARTH_ALLOW_WARP and pins the ticket keypair)
npm run test:go           # another — must end "ALL TESTS PASSED" with zero skips
node gameserver/test-multiworld.mjs
```

`npm run test:legacy` covers the pre-migration :8081 server, which is still maintained.

**Never bind :8081 or write `server/save.json`** without backing it up — it is the owner's real
save. To exercise the legacy path safely, copy `server/index.js` with `PORT`/`SAVE_PATH` swapped
and point a copy of `test.mjs` at the new port.

Use the **Bash** tool, not PowerShell. PowerShell mangles UTF-8 on writes and has thrown
OutOfMemoryException in this repo. Write files with the Write/Edit tools only — never shell piping.

### Precision over volume
The project owner pays per token and has said repeatedly: *"tokens should be utilized in progressing
the system and not making mistakes and refixing them."* Make targeted edits. Do not reformat, rename,
or "clean up" code you were not asked to change. No unsolicited docs or summary files.

### Honesty
Report what actually happened. If tests fail, say so with output. If you skipped part of the scope,
say which part and why. Never claim success on unverified work. If you work around a problem instead
of fixing it, flag it explicitly.

---

## 3. Multi-agent coordination

When several agents run in parallel, **file ownership must be disjoint**. Two agents editing the same
file will collide, hit "file modified since read" errors, and cause exactly the rework the owner is
paying to avoid.

Pattern that works here:

- Assign each agent an explicit list of files it owns, and name the files it must NOT touch.
- Where two pieces of work must talk to each other, connect them with a **DOM event or a documented
  export**, not a shared edit. Example from 2026-08-30: the menu redesign agent owned `index.html` +
  `src/menu.ts`; the quit-to-menu agent owned `src/main.ts`; they met at a `hearth:quit` window event
  so neither imported the other.
- Tell each agent to ignore `tsc` errors originating in the other agent's files, and have the
  orchestrator run the authoritative verification at the end.
- Do not let two agents run `node test.mjs` concurrently — they fight over port 8081 and
  `server/save.json`.

### Model selection
Match model to task complexity. Cheap mechanical work (asset authoring, manifest entries, mechanical
sweeps) does not need a frontier model. Reserve stronger models for protocol changes, lifecycle work,
and anything touching the authoritative server. Always give strong models tight scope so they do not
burn budget exploring.

---

## 4. Session context dumps

Before the owner runs `/clear`, the outgoing session **must** write a dump to
`.agents/session-context-dump/`.

**Filename:** `YYYY-MM-DD_HHMM__short-slug.md` — e.g. `2026-08-30_1302__medic-seq-menu-logo.md`

**Required sections:**

```markdown
# <Title> — YYYY-MM-DD HH:MM

## Session summary
One paragraph: what this session was for.

## What shipped
Each feature: what it does, which files, and how it was verified.

## Decisions made
Choices a future agent must not silently re-litigate, and the reasoning behind each.

## Bugs found and root causes
The actual cause, not the symptom. This is the highest-value section — it stops
the next agent rediscovering the same trap.

## What did NOT get done
Scope that was cut, deferred, or blocked, and why.

## Notes for the next session
Anything non-obvious: gotchas, in-flight work, things the owner asked for but hasn't got yet.
```

Also update `.agents/PROJECT_STATE.md` in the same pass so status never goes stale.

---

## 5. Hard-won pitfalls (this repo specifically)

These have each cost real debugging time. Full detail in `AGENT_GUIDE.html`.

- **esbuild does not type-check.** Only `npx tsc --noEmit` catches type errors. A missing declaration
  once froze the game at runtime.
- **Never rebuild DOM innerHTML every frame.** It destroys buttons between mousedown and mouseup and
  made the crafting menu unclickable. `src/ui.ts` uses signature-based rebuild + delegated listeners —
  follow that pattern.
- **Phaser property shadowing.** Never name a Scene field `time` or a Container child `body`.
- **Missing texture key renders as a green box.** Every sprite key referenced must exist in
  `ASSET_MANIFEST` (`src/assets.ts`) *and* on disk.
- **`clearTint()` wipes base tints permanently.** Store and restore the base colour instead.
- **Tile indices are shared across z-layers.** Any proximity check must also compare `z`, or a mine
  tunnel under a shelter lets players reach through the floor.
- **`interact()` polls every frame while E is held.** Any toggle needs a cooldown or it flip-flops.
- **Screen-space objects break under camera zoom.** Full-screen FX live in world space, re-anchored to
  `cameras.main.worldView` each frame via `layoutScreenFx()`.
- **Phaser `zoomTo` silently drops a request while another zoom effect is in flight.** Pass
  `force: true`.
- **Symmetric sprites don't visibly flip.** A horizontally symmetric SVG produces an identical image
  under `flipX`.
- **`initUI()` must be called once per page, not once per scene.** Its delegated listeners attach to
  DOM that survives a scene teardown; calling it twice doubles every action.

---

## 6. Architecture in one page

- **Stack:** Phaser 3.80 + TypeScript + Vite (client), Node + `ws` (authoritative server), plain-JS
  shared modules in `shared/`.
- **Deterministic worldgen.** The server sends only a `seed`. Client and server both run
  `genWorld(seed)` from `shared/world.js` and must independently derive identical results. Only
  *mutations* are synced. Anything derived from the seed (terrain, nodes, medics, huts) must use
  fixed-order iteration — never `Math.random` or Map/Set ordering.
- **Server-authoritative** for inventory, crafting, gathering, combat, building, digging. Movement is
  client-authoritative.
- **Tile index convention:** `i = y * SIZE + x`, `SIZE = 1280`. Decode `x = i % SIZE`,
  `y = (i / SIZE) | 0`. All protocol messages use tile indices.
- **Iso math:** `TW=64`, `TH=32`; `sx = (x-y)*32 + offX`, `sy = (x+y)*16`, `offX = (SIZE-1)*32`.
  Depth = screen y.
- **Three z-layers:** 0 surface, 1 underground mine, 2 shelter interior.
- **Terrain is chunk-streamed** into 1024×512 RenderTextures around the camera. A full-map texture
  would be ~500 MB.
- **Zero-asset pipeline.** All art is hand-written SVG in `assets/sprites/` plus runtime-generated
  textures. Audio is procedural Web Audio. No binary assets, no CDN, no webfonts.
- **Persistence:** `server/save.json`, autosaved every 30s and on SIGINT. Player profiles are keyed by
  a browser `localStorage` token (`hearth-tok`) — **never clear or regenerate it**, it keys saved
  inventory.

# Echoes of the Hearth

Web-based 2D isometric co-op survival RPG. See [PLAN.md](PLAN.md) for the full design.

> ## 🤖 AI agents — start here, before anything else
>
> 1. **[`.agents/README.md`](.agents/README.md)** — how agents coordinate on this project: read
>    order, file-ownership rules for parallel work, the mandatory verification gate, and the
>    hard-won pitfalls list.
> 2. **[`.agents/PROJECT_STATE.md`](.agents/PROJECT_STATE.md)** — what is built, what is
>    deliberately deferred, known gaps, and what to work on next. Status source of truth.
> 3. **[`.agents/session-context-dump/`](.agents/session-context-dump/)** — dated knowledge dumps
>    from previous sessions. Read the newest one; it records decisions and root causes you must not
>    re-derive.
> 4. **[AGENT_GUIDE.html](AGENT_GUIDE.html)** — deep technical reference: architecture, protocol,
>    balance tables, workflows.
>
> **Before the owner runs `/clear`, write a session dump** to `.agents/session-context-dump/` using
> the template in `.agents/README.md`, and update `.agents/PROJECT_STATE.md` in the same pass.
>
> **Nothing is done until `npx tsc --noEmit`, `npx vite build`, and `node test.mjs` all pass.**
> esbuild does not type-check — `tsc` is the only gate.

## Run

```bash
npm install
npm run server   # WebSocket game server on :8081
npm run dev      # client on http://localhost:5173
```

Open multiple tabs/browsers for local co-op. For LAN play, friends open
`http://<your-ip>:5173` — allow Node.js through Windows Firewall (ports 5173 + 8081)
the first time.

`node test.mjs` (with the server running) runs the multiplayer smoke test.

## Controls
- **WASD / arrows** — move (mud slows you 50%)
- **E** — gather (trees, bushes, stones, boulders, crystal) / use Monolith Core
- **SPACE** — attack
- **C** — crafting menu
- **Click a 🔨 item** in your inventory bar, then click a tile to build it (ESC cancels)

## World
- 192×192 map, 3 elevation levels — cliffs (2+ level jumps) are impassable, plan your routes.
- **Weather**: rain (Woods/Marsh), sandstorms (Dunes — take shelter beside a structure or take
  damage), blizzards (Spire — reach a campfire). Ambient snowfall on the Spire.
- **Wildlife** (7 species): deer & boar (Woods), lizard & crab (Dunes), fox & hare (Spire),
  toad (Marsh). Bigger animals drop more meat, small ones flee faster.
- **Monsters**: Crawlers (always), Stalkers (fast, night), Brutes (siege beasts that smash
  structures, appear after 2 Monoliths), and Blight Wisps — floating infectors that corrupt
  the land as they drift; corrupted tiles breed crawlers until the infection decays. Kill
  wisps for bonus essence.

## Progression
1. **Whispering Woods** — chop trees, place a Workbench, craft Axe/Pickaxe, place a
   Campfire (heals you; shields wooden buildings from nightly Blight Storm erosion).
   Over-harvest a sector and its soil turns to mud.
2. **Sinking Dunes** — the day heat damages you without a **Heat Cloak**. Mine boulders.
3. **Frozen Spire** — the cold bites without a **Fur Cloak**. Mine **Crystal** with a
   Stone Pickaxe.
4. Build the **Aether Forge** → forge **Monolith Cores** (crystal + Blight Essence from
   creatures) → awaken all **4 Monoliths** → build the **World Engine** at the Core Void
   center → survive the 4-minute final assault. Walls block creatures; creatures smash
   them down. Difficulty scales with every Monolith you awaken.

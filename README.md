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
- **SPACE** — jump (clears higher ledges)
- **F** — attack
- **R** — rotate a placeable before confirming
- **T** — light a torch (mines only; torches can also be built inside shelters; craft with
  2 wood + 1 fiber)
- **1–5** — equip a tool/weapon from the hotbar (Wooden Axe, Wooden Pickaxe, Stone Pickaxe,
  Stone Sword, Iron Sword)
- **C** — crafting menu
- **I** — inventory
- **H** — help
- **M** — mute/unmute sound
- **F9** — dev kit (server must be started with `npm run server:dev`)
- **F10** — toggle dev panel
- **Click a 🔨 item** in your inventory bar, then click a tile to build it (ESC cancels)

## World
- 1280×1280 map, 3 elevation levels — you can always drop down a cliff (a 2+ level drop deals
  fall damage), but climbing more than 1 level up is blocked unless you jump, which clears 2.
- **Weather**: rain (Woods/Marsh), sandstorms (Dunes — take shelter beside a structure or take
  damage), blizzards (Spire — reach a campfire). Ambient snowfall on the Spire.
- **Wildlife** (7 species): deer & boar (Woods), lizard & crab (Dunes), fox & hare (Spire),
  toad (Marsh). Bigger animals drop more meat, small ones flee faster.
- **Monsters**: Crawlers (always), Stalkers (fast, night), Brutes (siege beasts that smash
  structures, appear once 2+ Monoliths are awakened), and Blight Wisps — floating infectors
  that corrupt the land as they drift; corrupted tiles breed crawlers until the infection
  decays. Kill wisps for bonus essence. Also prowling the islands: Husk Wolves (night packs
  on the Woods), Bog Shamblers (heavy, structure-ignoring brutes near the Marsh that corrupt
  their tile on death), Frost Wraiths (night, Spire — charge in fast and land a chilling hit
  that slows you), Drowned (amphibious, rise from the shallows near players), and Blight
  Lancers (slow, tanky siege casters with ranged beams that damage structures, appear once
  the first Monolith is awakened).

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
